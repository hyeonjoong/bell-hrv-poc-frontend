/* Shared DSP helpers: 30 Hz bandpass, filtfilt and the DFT peak finder.
 *
 * Sampling rate: LiveRPPG (rppg_live.js) resamples every ROI stream onto a
 * uniform 30 Hz grid before filtering, so the fixed fs = 30 Hz coefficients
 * below are the right ones whatever the camera or FaceMesh loop rate is.
 * computeBPFCoeffs is kept for callers that still pass an fs; it has no
 * coefficients for any other rate and warns once if asked for one.
 *
 * fftPeakBpm(x, fs) returns
 *   hrBpm  frequency of the largest spectral peak in [loHz, hiHz], in bpm.
 *   snrDb  harmonic-band SNR: power within HARMONIC_HALF_WIDTH_HZ of the peak
 *          and of its second harmonic (when that is below fs/2 minus
 *          NYQUIST_MARGIN_HZ), over the remaining power between loHz and
 *          min(2 * hiHz, fs/2 - NYQUIST_MARGIN_HZ). A clean pulse gives a
 *          positive value, broadband noise a negative one. It replaced a peak
 *          over median ratio that was several dB even for pure noise.
 *          NO_SNR_DB when the input is too short or flat to analyse.
 *   snrWideDb  the same ratio with a wider signal band: WIDE_HALF_WIDTH_HZ
 *          around the peak and twice that around the second harmonic. When
 *          the heart rate swings during the window (for example with slow
 *          breathing), a long window resolves the swing into sidebands
 *          around f0 and 2 f0 (twice as far out at 2 f0). The narrow band
 *          then counts them as noise; the wide band keeps them. A weak but
 *          steady pulse scores better on the narrow band, so rppg_live.js
 *          calibrates both and uses the better one.
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
  if (Math.abs(fs - 30) > 0.5 && !_warnedFs) {
    console.warn(`[dsp] only fs=30 Hz bandpass coefficients exist (asked for ${Number(fs).toFixed(1)} Hz); resample to 30 Hz first.`);
    _warnedFs = true;
  }
  return { b: BPF30_B, a: BPF30_A };
}

/** Causal IIR, direct form II transposed. The state is kept in float64:
 *  the 0.7 Hz poles sit close to the unit circle, and with float32 state
 *  the output was 0.14 % (lfilter) and 0.25 % (filtfilt) off scipy on the
 *  reference signal in test/fixtures. */
export function applyIIR(x, b, a) {
  const N = x.length;
  const order = Math.max(b.length, a.length) - 1;
  const z = new Float64Array(order);
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

export const HARMONIC_HALF_WIDTH_HZ = 0.1;
export const WIDE_HALF_WIDTH_HZ = 0.15;
export const NYQUIST_MARGIN_HZ = 0.5;
export const NO_SNR_DB = -99;

/** Zero-padded DFT with Hann window: peak in [loHz, hiHz] and harmonic SNR
 *  (narrow and wide signal band, see the header). */
export function fftPeakBpm(x, fs, loHz = 0.7, hiHz = 3.5) {
  const N = x.length;
  const none = { hrBpm: null, snrDb: NO_SNR_DB, snrWideDb: NO_SNR_DB };
  if (N < 16 || !(fs > 0)) return none;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = x[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  let Nz = 1;
  while (Nz < N * 4) Nz <<= 1;
  Nz = Math.max(256, Math.min(2048, Nz));
  const df = fs / Nz;
  const kNyq = Math.floor(Nz / 2);
  const kLo = Math.max(1, Math.floor(loHz / df));
  const kHi = Math.min(kNyq, Math.ceil(hiHz / df));
  if (kHi <= kLo) return none;
  // The SNR reference band reaches up to the second harmonic of hiHz.
  const usableHz = fs / 2 - NYQUIST_MARGIN_HZ;
  const kTop = Math.max(kHi, Math.min(kNyq, Math.floor(Math.min(2 * hiHz, usableHz) / df)));

  // DFT bins kLo..kTop; the twiddle factor is advanced by rotation instead of
  // calling cos/sin for every sample.
  const power = new Float64Array(kTop - kLo + 1);
  for (let k = kLo; k <= kTop; k++) {
    const theta = (-2 * Math.PI * k) / Nz;
    const cs = Math.cos(theta), sn = Math.sin(theta);
    let c = 1, s = 0, re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const wn = w[n];
      re += wn * c;
      im += wn * s;
      const c2 = c * cs - s * sn;
      s = c * sn + s * cs;
      c = c2;
    }
    power[k - kLo] = re * re + im * im;
  }

  let bestK = -1, bestP = 0;
  for (let k = kLo; k <= kHi; k++) {
    const p = power[k - kLo];
    if (p > bestP) { bestP = p; bestK = k; }
  }
  if (bestK < 0) return none;
  const f0 = bestK * df;
  const bandSnrDb = (hw0, hw2) => {
    const withHarmonic = 2 * f0 + hw2 <= usableHz;
    let sig = 0, rest = 0;
    for (let k = kLo; k <= kTop; k++) {
      const f = k * df;
      const inBand = Math.abs(f - f0) <= hw0 ||
        (withHarmonic && Math.abs(f - 2 * f0) <= hw2);
      if (inBand) sig += power[k - kLo]; else rest += power[k - kLo];
    }
    return rest > 0 ? 10 * Math.log10(sig / rest) : -NO_SNR_DB;
  };
  return {
    hrBpm: f0 * 60,
    snrDb: bandSnrDb(HARMONIC_HALF_WIDTH_HZ, HARMONIC_HALF_WIDTH_HZ),
    snrWideDb: bandSnrDb(WIDE_HALF_WIDTH_HZ, 2 * WIDE_HALF_WIDTH_HZ),
  };
}
