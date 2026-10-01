/* Phase 6 — Multi-stream live rPPG.
 *
 * Maintains three sample streams (forehead, l_cheek, r_cheek), runs POS +
 * Butterworth + DFT per stream, then SNR-weighted-averages the per-ROI BVPs
 * into a single trace. Per-ROI quality (0..1) is exposed so the overlay can
 * color each bracket independently.
 *
 * Timing (v6.5): each ROI keeps a history bounded by time (keepMs, default
 * 50 s), not by sample count, so a 45 s estimate works at any frame rate.
 * push() drops samples whose timestamp does not advance. estimate() resamples
 * every ROI by linear interpolation onto a uniform 30 Hz grid that ends at the
 * newest sample, then runs POS, the fs = 30 Hz bandpass and the DFT at 30 Hz.
 * The result no longer depends on the camera rate or on how often the
 * FaceMesh loop runs.
 *
 * Quality (v6.5): snrDb and snrWideDb are the narrow- and wide-band harmonic
 * SNRs from dsp.js. sqiFromSnr maps each onto 0..1 with its own per-window
 * calibration (SQI_CALIBRATION, produced by test/calibrate_sqi.mjs) and takes
 * the larger value, so a weak steady pulse and a pulse whose rate swings
 * during the window can both pass. SQI_PASS is the gate for showing an HR.
 */
import { computeBPFCoeffs, filtfilt, fftPeakBpm, NO_SNR_DB } from './dsp.js?v=6.5-pages';

const ROI_KEYS = ['forehead', 'l_cheek', 'r_cheek'];

export const GRID_FS = 30;             // Hz, analysis grid
export const DEFAULT_KEEP_MS = 50000;  // history kept per ROI
export const MIN_WINDOW_SEC = 6;       // shortest window a ROI is analysed on
// A ROI with fewer real samples per second in the window is skipped: the HR
// search band reaches 3.5 Hz (210 bpm), which needs at least 7 samples per
// second. Above that the 30 Hz resampling handles slow devices (tested at 8 fps).
export const MIN_SOURCE_FPS = 7;
// A ROI whose newest sample is this much older than the newest sample of any
// ROI (it left the frame while the others did not) is left out; its held last
// value would otherwise fill the end of the shared grid.
export const MAX_STALE_MS = 500;
export const SQI_PASS = 0.6;           // HR shown / result accepted at or above this
export const SQI_LIVE_HOLD = 0.45;     // a live HR already shown stays while SQI is at least this

/* Narrow band: SQI = clamp((snrDb - floorDb) / (goodDb - floorDb), 0, 1).
 * Wide band: the same with snrWideDb, wideFloorDb and wideGoodDb. The SQI is
 * the larger of the two. Values are interpolated in log(window length)
 * between the rows below and held constant outside them. Rows come from
 * `node test/calibrate_sqi.mjs`; see that file for the rule and the noise and
 * pulse sets used. */
export const SQI_CALIBRATION = [
  { sec: 6, floorDb: -4, goodDb: 7, wideFloorDb: 0, wideGoodDb: 11 },
  { sec: 8, floorDb: -3.5, goodDb: 8.5, wideFloorDb: 0, wideGoodDb: 13.5 },
  { sec: 12, floorDb: -4, goodDb: 9.5, wideFloorDb: -0.5, wideGoodDb: 13 },
  { sec: 20, floorDb: -4.5, goodDb: 9, wideFloorDb: -1, wideGoodDb: 12 },
  { sec: 30, floorDb: -5, goodDb: 7.5, wideFloorDb: -1, wideGoodDb: 10.5 },
  { sec: 45, floorDb: -5.5, goodDb: 5.5, wideFloorDb: -1.5, wideGoodDb: 9.5 },
];

function calibrationAt(sec) {
  const rows = SQI_CALIBRATION;
  if (!(sec > rows[0].sec)) return rows[0];
  if (sec >= rows[rows.length - 1].sec) return rows[rows.length - 1];
  let i = 1;
  while (rows[i].sec < sec) i++;
  const lo = rows[i - 1], hi = rows[i];
  const u = Math.log(sec / lo.sec) / Math.log(hi.sec / lo.sec);
  const out = { sec };
  for (const key of ['floorDb', 'goodDb', 'wideFloorDb', 'wideGoodDb']) {
    out[key] = lo[key] + u * (hi[key] - lo[key]);
  }
  return out;
}

function mapDb(db, floorDb, goodDb) {
  if (!Number.isFinite(db) || db <= NO_SNR_DB) return 0;
  return Math.max(0, Math.min(1, (db - floorDb) / (goodDb - floorDb)));
}

/** Map the harmonic SNRs (dB) of a window of `windowSec` onto 0..1: the
 *  larger of the narrow-band and (when given) the wide-band mapping. */
export function sqiFromSnr(snrDb, windowSec, snrWideDb = NaN) {
  const c = calibrationAt(windowSec);
  return Math.max(mapDb(snrDb, c.floorDb, c.goodDb), mapDb(snrWideDb, c.wideFloorDb, c.wideGoodDb));
}

/** What the result screen may show for a given SQI and result source.
 *  An in-browser HR below SQI_PASS is not shown; backend results keep their
 *  own HR and get the low-quality chip instead. */
export function qualityGate(sqi, source) {
  const s = Number.isFinite(sqi) ? sqi : 0;
  const pass = s >= SQI_PASS;
  return {
    pass,
    showHr: pass || source !== 'in-browser',
    showChip: !pass && s > 0,
  };
}

/** Live HR shown on the capture screen.
 *  update(est, faceOk) takes one estimate() result (main.js calls it every
 *  500 ms) and whether a face is in view. An HR is shown once an estimate
 *  reaches SQI_PASS and then kept while estimates stay at or above hold
 *  (hysteresis, so a moderate signal does not flicker on and off). The shown
 *  value is smoothed with an exponential moving average and cleared after
 *  clearAfter failing updates in a row (SQI below hold, no HR or no face).
 *  Returns { hr, live }: hr is null while nothing may be shown. */
export class LiveHrGate {
  constructor({ pass = SQI_PASS, hold = SQI_LIVE_HOLD, clearAfter = 3, alpha = 0.3 } = {}) {
    this.pass = pass;
    this.hold = Math.min(hold, pass);
    this.clearAfter = clearAfter;
    this.alpha = alpha;
    this.reset();
  }

  reset() {
    this.hr = null;
    this.fails = 0;
  }

  update(est, faceOk = true) {
    const need = this.hr == null ? this.pass : this.hold;
    const ok = faceOk && est != null && Number.isFinite(est.hr) &&
      Number.isFinite(est.sqi) && est.sqi >= need;
    if (ok) {
      this.fails = 0;
      this.hr = this.hr == null ? est.hr : (1 - this.alpha) * this.hr + this.alpha * est.hr;
    } else if (this.hr != null) {
      this.fails++;
      if (this.fails >= this.clearAfter) this.reset();
    }
    return { hr: this.hr, live: this.hr != null };
  }
}

/** Frame timestamps for one capture run.
 *  next(mediaMs, nowMs) is called once per new camera frame with the frame's
 *  media time (requestVideoFrameCallback metadata.mediaTime or
 *  video.currentTime, in ms; NaN if unknown) and the wall clock. It returns a
 *  timestamp that advances by the media time step when that step is
 *  plausible, and by the wall clock step otherwise (missing, frozen, negative
 *  or implausibly large media steps). If the media clock runs more than
 *  maxRateError away from the wall clock over checkAfterMs, it is not used
 *  again for this run. */
export class FrameClock {
  constructor({ maxStepMs = 1000, maxRateError = 0.2, checkAfterMs = 2000 } = {}) {
    this.maxStepMs = maxStepMs;
    this.maxRateError = maxRateError;
    this.checkAfterMs = checkAfterMs;
    this.reset();
  }

  reset() {
    this.lastT = null;
    this.lastMedia = NaN;
    this.lastNow = NaN;
    this.useMedia = true;
    this.mediaSum = 0;
    this.wallSum = 0;
  }

  next(mediaMs, nowMs) {
    if (this.lastT === null) {
      this.lastT = Number.isFinite(nowMs) ? nowMs : 0;
      this.lastMedia = mediaMs;
      this.lastNow = nowMs;
      return this.lastT;
    }
    const dMedia = mediaMs - this.lastMedia;
    const dWall = nowMs - this.lastNow;
    let step = 0;
    if (this.useMedia && Number.isFinite(dMedia) && dMedia > 0 && dMedia < this.maxStepMs) {
      step = dMedia;
      if (Number.isFinite(dWall) && dWall > 0) {
        this.mediaSum += dMedia;
        this.wallSum += dWall;
        if (this.wallSum >= this.checkAfterMs &&
            Math.abs(this.mediaSum / this.wallSum - 1) > this.maxRateError) {
          this.useMedia = false;
        }
      }
    } else if (Number.isFinite(dWall) && dWall > 0) {
      step = dWall;
    }
    if (Number.isFinite(mediaMs)) this.lastMedia = mediaMs;
    if (Number.isFinite(nowMs)) this.lastNow = nowMs;
    this.lastT += step;
    return this.lastT;
  }
}

export class LiveRPPG {
  constructor({ keepMs = DEFAULT_KEEP_MS } = {}) {
    this.keepMs = keepMs;
    this.samples = { forehead: [], l_cheek: [], r_cheek: [] };
    this.lastHR = null;
    this.lastSNR = 0;
    this.lastCombinedBvp = [];
    this.perROIQuality = { forehead: 0, l_cheek: 0, r_cheek: 0 };
    this.bpfCoeffs = null;
  }

  push(roiKey, r, g, b, tMs) {
    const buf = this.samples[roiKey];
    if (!buf || !Number.isFinite(tMs)) return;
    // Same frame seen twice (loop faster than the camera) or clock went back.
    if (buf.length && tMs <= buf[buf.length - 1].t) return;
    buf.push({ r, g, b, t: tMs });
    // Bound memory by time: drop samples older than keepMs before the newest.
    const cutoff = tMs - this.keepMs;
    let drop = 0;
    while (drop < buf.length && buf[drop].t < cutoff) drop++;
    if (drop) buf.splice(0, drop);
  }

  getPerROIQuality() { return { ...this.perROIQuality }; }

  reset() {
    this.samples = { forehead: [], l_cheek: [], r_cheek: [] };
    this.lastHR = null;
    this.lastSNR = 0;
    this.lastCombinedBvp = [];
    this.perROIQuality = { forehead: 0, l_cheek: 0, r_cheek: 0 };
  }

  /** Combined BVP, HR, harmonic SNR and SQI over the last windowSec seconds
   *  (or over the history available, when shorter but at least
   *  MIN_WINDOW_SEC). */
  estimate(windowSec = 8) {
    const fs = GRID_FS;
    if (!this.bpfCoeffs) this.bpfCoeffs = computeBPFCoeffs(fs);

    // One grid for all ROIs, ending at the newest sample of any ROI.
    let tEnd = -Infinity;
    for (const k of ROI_KEYS) {
      const s = this.samples[k];
      if (s.length) tEnd = Math.max(tEnd, s[s.length - 1].t);
    }

    const perROIBvp = {};
    const perROISnr = {};
    for (const k of ROI_KEYS) {
      const s = this.samples[k];
      if (s.length < 2) continue;
      const last = s[s.length - 1].t;
      if (tEnd - last > MAX_STALE_MS) continue;
      const sec = Math.min(windowSec, (last - s[0].t) / 1000);
      if (!(sec >= MIN_WINDOW_SEC)) continue;
      const tStart = tEnd - sec * 1000;
      if (countSince(s, tStart) < sec * MIN_SOURCE_FPS) continue;
      const L = Math.floor(sec * fs);
      const win = resampleUniform(s, tEnd, L, 1000 / fs);
      const bvp = posBVP(win, fs);
      const filt = filtfilt(bvp, this.bpfCoeffs.b, this.bpfCoeffs.a);
      const { hrBpm, snrDb, snrWideDb } = fftPeakBpm(filt, fs);
      perROIBvp[k] = filt;
      perROISnr[k] = { hr: hrBpm, snrDb, snrWideDb, sec: L / fs };
    }

    const validKeys = Object.keys(perROIBvp);
    // Always update per-ROI quality, even when a ROI was excluded from
    // combination (so the overlay decays its quality bar).
    for (const k of ROI_KEYS) {
      const p = perROISnr[k];
      if (p) {
        this.perROIQuality[k] = p.hr == null ? 0 : sqiFromSnr(p.snrDb, p.sec, p.snrWideDb);
      } else {
        this.perROIQuality[k] *= 0.5;
      }
    }
    if (!validKeys.length) {
      return {
        hr: null, snrDb: NO_SNR_DB, snrWideDb: NO_SNR_DB, sqi: 0, bvp: [],
        perROI: this.getPerROIQuality(), windowSec: 0,
      };
    }

    // Linear-SNR weighted combination. All grids end at tEnd with the same
    // step, so aligning the tails aligns them in time.
    const minLen = Math.min(...validKeys.map((k) => perROIBvp[k].length));
    const weights = {};
    let wsum = 0;
    for (const k of validKeys) {
      const w = perROISnr[k].hr == null ? 0 : Math.pow(10, perROISnr[k].snrDb / 10);
      weights[k] = w;
      wsum += w;
    }
    if (!(wsum > 0)) {
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
    const { hrBpm: hrC, snrDb: snrC, snrWideDb: snrW } = fftPeakBpm(combined, fs);
    const usedSec = minLen / fs;
    const sqi = hrC == null ? 0 : sqiFromSnr(snrC, usedSec, snrW);

    this.lastHR = hrC;
    this.lastSNR = snrC;
    this.lastCombinedBvp = Array.from(combined);
    return {
      hr: hrC,
      snrDb: snrC,
      snrWideDb: snrW,
      sqi,
      bvp: this.lastCombinedBvp,
      perROI: this.getPerROIQuality(),
      weights,
      windowSec: usedSec,
    };
  }
}

/** Number of samples with t >= tStart (samples are in time order). */
function countSince(s, tStart) {
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t < tStart) lo = mid + 1; else hi = mid;
  }
  return s.length - lo;
}

/** Linear interpolation of {r,g,b,t} samples onto L grid points spaced dtMs
 *  apart and ending at tEnd. Points past the newest sample hold its value. */
function resampleUniform(s, tEnd, L, dtMs) {
  const r = new Float64Array(L), g = new Float64Array(L), b = new Float64Array(L);
  const t0 = tEnd - (L - 1) * dtMs;
  let j = Math.max(0, s.length - countSince(s, t0) - 1);
  const n = s.length;
  for (let i = 0; i < L; i++) {
    const t = t0 + i * dtMs;
    while (j < n - 2 && s[j + 1].t <= t) j++;
    const a = s[j], c = s[j + 1];
    let u = (t - a.t) / (c.t - a.t);
    if (u < 0) u = 0; else if (u > 1) u = 1;
    r[i] = a.r + u * (c.r - a.r);
    g[i] = a.g + u * (c.g - a.g);
    b[i] = a.b + u * (c.b - a.b);
  }
  return { r, g, b, length: L };
}

/** POS (Wang/de Haan) on uniformly sampled r, g, b arrays. */
function posBVP(win, fs) {
  const N = win.length;
  const L = Math.floor(1.6 * fs);
  if (N < L) return new Float32Array(N);
  const R = win.r, G = win.g, B = win.b;
  const bvp = new Float32Array(N);
  const X = new Float64Array(L);
  const Y = new Float64Array(L);
  for (let n = L; n <= N; n++) {
    let mR = 0, mG = 0, mB = 0;
    for (let i = n - L; i < n; i++) { mR += R[i]; mG += G[i]; mB += B[i]; }
    mR /= L; mG /= L; mB /= L;
    if (mR < 1e-6 || mG < 1e-6 || mB < 1e-6) continue;
    for (let i = 0; i < L; i++) {
      const m = n - L + i;
      const r = R[m] / mR - 1, g = G[m] / mG - 1, b = B[m] / mB - 1;
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
