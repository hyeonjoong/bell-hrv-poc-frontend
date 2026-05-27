/* Phase 6 — shared DSP helpers (IIR bandpass + DFT peak finder).
 *
 * The Butterworth coefficients are precomputed for fs = 30 Hz, 0.7–4 Hz,
 * 4th order. Webcams that report fps in [27, 33] use these as-is (small
 * passband shift, acceptable for the live preview). Outside that range
 * computeBPFCoeffs falls back to the fs=30 coeffs with a console.warn.
 * Authoritative HR/HRV still comes from the backend on finalize, where
 * scipy.signal.butter is recomputed for the actual fs.
 */

// 4th-order Butterworth bandpass for fs=30 Hz, 0.7–4 Hz.
// Generated via `scipy.signal.butter(4, [0.7/15, 4.0/15], 'band')`.
export const BPF30_B = [
  0.006661336726302998, 0.0, -0.026645346905211992, 0.0,
  0.03996802035781799, 0.0, -0.026645346905211992, 0.0,
  0.006661336726302998,
];
export const BPF30_A = [
  1.0, -5.815563557922971, 15.100882625228708, -22.960341138638743,
  22.41803520936236, -14.406117182336562, 5.947540319779541,
  -1.4415918493121103, 0.15725756202529512,
];

let _warnedFs = false;
export function computeBPFCoeffs(fs /* , lo=0.7, hi=4.0, order=4 */) {
  if (Math.abs(fs - 30) > 3 && !_warnedFs) {
    console.warn(`[dsp] webcam fs=${fs.toFixed(1)}Hz deviates from 30Hz — passband shifted; backend remains authoritative.`);
    _warnedFs = true;
  }
  return { b: BPF30_B, a: BPF30_A };
}

/** Causal IIR — direct form II transposed. */
export function applyIIR(x, b, a) {
  const N = x.length;
  const order = Math.max(b.length, a.length) - 1;
  const z = new Float32Array(order);
  const y = new Float32Array(N);
  const a0 = a[0] || 1;
  for (let n = 0; n < N; n++) {
    const xn = x[n];
    const yn = (b[0] * xn + z[0]) / a0;
    y[n] = yn;
    for (let i = 1; i < order; i++) {
      const bi = b[i] || 0, ai = a[i] || 0;
      z[i - 1] = bi * xn - ai * yn + z[i];
    }
    const bL = b[order] || 0, aL = a[order] || 0;
    z[order - 1] = bL * xn - aL * yn;
  }
  return y;
}

/** Zero-phase: forward+reverse causal IIR (cheap filtfilt). */
export function filtfilt(x, b, a) {
  const fwd = applyIIR(x, b, a);
  const rev = new Float32Array(fwd.length);
  for (let i = 0; i < fwd.length; i++) rev[i] = fwd[fwd.length - 1 - i];
  const fwd2 = applyIIR(rev, b, a);
  const out = new Float32Array(fwd2.length);
  for (let i = 0; i < fwd2.length; i++) out[i] = fwd2[fwd2.length - 1 - i];
  return out;
}

/** Zero-padded DFT with Hann window → peak in [loHz, hiHz]. */
export function fftPeakBpm(x, fs, loHz = 0.7, hiHz = 3.5) {
  const N = x.length;
  if (N < 16) return { hrBpm: null, snrDb: 0 };
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = x[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  let Nz = 1;
  while (Nz < N * 4) Nz <<= 1;
  Nz = Math.max(256, Math.min(2048, Nz));
  const df = fs / Nz;
  const kLo = Math.max(1, Math.floor(loHz / df));
  const kHi = Math.min(Math.floor(Nz / 2), Math.ceil(hiHz / df));
  if (kHi <= kLo) return { hrBpm: null, snrDb: 0 };
  const power = new Float32Array(kHi - kLo + 1);
  for (let k = kLo; k <= kHi; k++) {
    let re = 0, im = 0;
    const c = (-2 * Math.PI * k) / Nz;
    for (let n = 0; n < N; n++) {
      const wn = w[n];
      re += wn * Math.cos(c * n);
      im += wn * Math.sin(c * n);
    }
    power[k - kLo] = re * re + im * im;
  }
  let bestK = 0, bestP = 0;
  for (let i = 0; i < power.length; i++) {
    if (power[i] > bestP) { bestP = power[i]; bestK = i; }
  }
  const sorted = Array.from(power).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1e-9;
  const snrDb = bestP > 0 ? 10 * Math.log10(bestP / median) : 0;
  const peakHz = (kLo + bestK) * df;
  return { hrBpm: peakHz * 60, snrDb };
}
