/* Phase 6 — Multi-stream live rPPG.
 *
 * Maintains three sample streams (forehead, l_cheek, r_cheek), runs POS +
 * Butterworth + DFT per stream, then SNR-weighted-averages the per-ROI BVPs
 * into a single trace. Per-ROI quality (0..1) is exposed so the overlay can
 * color each bracket independently.
 */
import { computeBPFCoeffs, filtfilt, fftPeakBpm } from './dsp.js?v=6.0';

const ROI_KEYS = ['forehead', 'l_cheek', 'r_cheek'];

export class LiveRPPG {
  constructor() {
    this.samples = { forehead: [], l_cheek: [], r_cheek: [] };
    this.lastHR = null;
    this.lastSNR = 0;
    this.lastCombinedBvp = [];
    this.perROIQuality = { forehead: 0, l_cheek: 0, r_cheek: 0 };
    this.bpfCoeffs = null;
  }

  push(roiKey, r, g, b, tMs) {
    const buf = this.samples[roiKey];
    if (!buf) return;
    buf.push({ r, g, b, t: tMs });
    // Bound memory: keep at most 600 samples (~20s @ 30fps).
    if (buf.length > 600) buf.splice(0, buf.length - 600);
  }

  getPerROIQuality() { return { ...this.perROIQuality }; }

  reset() {
    this.samples = { forehead: [], l_cheek: [], r_cheek: [] };
    this.lastHR = null;
    this.lastSNR = 0;
    this.lastCombinedBvp = [];
    this.perROIQuality = { forehead: 0, l_cheek: 0, r_cheek: 0 };
  }

  /** Compute combined BVP over last ~windowSec of samples. */
  estimate(windowSec = 8) {
    // Pick the most populated stream as the fs reference.
    let ref = null;
    for (const k of ROI_KEYS) {
      const s = this.samples[k];
      if (!s.length) continue;
      if (!ref || s.length > ref.length) ref = s;
    }
    if (!ref || ref.length < 60) {
      return { hr: null, snrDb: 0, bvp: [], perROI: this.perROIQuality };
    }
    const tailN = Math.min(ref.length, 60);
    const tail = ref.slice(-tailN);
    const dt = (tail[tail.length - 1].t - tail[0].t) / (tail.length - 1);
    if (dt <= 0) return { hr: null, snrDb: 0, bvp: [], perROI: this.perROIQuality };
    const fs = 1000 / dt;
    if (!this.bpfCoeffs) this.bpfCoeffs = computeBPFCoeffs(fs);

    const L = Math.floor(windowSec * fs);
    const perROIBvp = {};
    const perROISnr = {};

    for (const k of ROI_KEYS) {
      const stream = this.samples[k];
      if (stream.length < L * 0.6) continue;
      const win = stream.slice(-Math.min(stream.length, L));
      const bvp = posBVP(win, fs);
      const filt = filtfilt(bvp, this.bpfCoeffs.b, this.bpfCoeffs.a);
      const { hrBpm, snrDb } = fftPeakBpm(filt, fs);
      perROIBvp[k] = filt;
      perROISnr[k] = { hr: hrBpm, snrDb };
    }

    const validKeys = Object.keys(perROIBvp);
    // Always update per-ROI quality, even when a ROI was excluded from
    // combination (so the overlay decays its quality bar).
    for (const k of ROI_KEYS) {
      if (perROISnr[k]) {
        this.perROIQuality[k] = Math.max(0, Math.min(1, perROISnr[k].snrDb / 12));
      } else {
        this.perROIQuality[k] *= 0.5;
      }
    }
    if (!validKeys.length) {
      return { hr: null, snrDb: 0, bvp: [], perROI: this.getPerROIQuality() };
    }

    // SNR-weighted combination (positive SNR only; else equal weights).
    const minLen = Math.min(...validKeys.map((k) => perROIBvp[k].length));
    const weights = {};
    let wsum = 0;
    for (const k of validKeys) {
      const w = Math.max(0, perROISnr[k].snrDb);
      weights[k] = w;
      wsum += w;
    }
    if (wsum < 1e-6) {
      for (const k of validKeys) weights[k] = 1;
      wsum = validKeys.length;
    }
    for (const k of validKeys) weights[k] /= wsum;

    const combined = new Float32Array(minLen);
    for (const k of validKeys) {
      const arr = perROIBvp[k];
      const off = arr.length - minLen;
      for (let i = 0; i < minLen; i++) combined[i] += weights[k] * arr[off + i];
    }
    const { hrBpm: hrC, snrDb: snrC } = fftPeakBpm(combined, fs);

    this.lastHR = hrC;
    this.lastSNR = snrC;
    this.lastCombinedBvp = Array.from(combined);
    return {
      hr: hrC,
      snrDb: snrC,
      bvp: this.lastCombinedBvp,
      perROI: this.getPerROIQuality(),
      weights,
    };
  }
}

/** POS (Wang/de Haan) on an array of {r,g,b,t}. */
function posBVP(win, fs) {
  const N = win.length;
  const L = Math.floor(1.6 * fs);
  if (N < L) return new Float32Array(N);
  const bvp = new Float32Array(N);
  for (let n = L; n <= N; n++) {
    let mR = 0, mG = 0, mB = 0;
    for (let i = n - L; i < n; i++) {
      const s = win[i]; mR += s.r; mG += s.g; mB += s.b;
    }
    mR /= L; mG /= L; mB /= L;
    if (mR < 1e-6 || mG < 1e-6 || mB < 1e-6) continue;
    const X = new Float32Array(L);
    const Y = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const s = win[n - L + i];
      const r = s.r / mR - 1, g = s.g / mG - 1, b = s.b / mB - 1;
      X[i] = g - b;
      Y[i] = -2 * r + g + b;
    }
    let mx = 0, my = 0;
    for (let i = 0; i < L; i++) { mx += X[i]; my += Y[i]; }
    mx /= L; my /= L;
    let vx = 0, vy = 0;
    for (let i = 0; i < L; i++) {
      vx += (X[i] - mx) ** 2;
      vy += (Y[i] - my) ** 2;
    }
    const sx = Math.sqrt(vx / L), sy = Math.sqrt(vy / L);
    const alpha = sy > 1e-9 ? sx / sy : 0;
    const m0 = n - L;
    for (let i = 0; i < L; i++) bvp[m0 + i] += X[i] + alpha * Y[i];
  }
  let m = 0;
  for (let i = 0; i < N; i++) m += bvp[i];
  m /= N;
  for (let i = 0; i < N; i++) bvp[i] -= m;
  return bvp;
}
