// Seeded synthetic capture generator for the rPPG tests.
//
// Produces what main.js pushes into LiveRPPG: per frame, the mean R, G, B of
// three face ROIs and a timestamp in ms. Everything is synthetic and
// deterministic (seeded PRNG); no DOM, no network, no recorded data.
//
// Model
// - Camera frames arrive at cameraFps. Each ROI value is a skin-like DC level
//   plus a pulse waveform (fundamental plus harmonics) plus per-channel noise.
// - Noise is white Gaussian (arRho = 0) or AR(1) low-pass noise (arRho > 0,
//   same variance), independent per ROI and per channel.
// - Optional FaceMesh loop at loopHz (for example a 60 Hz display): each loop
//   tick re-reads the latest camera frame, so frames are duplicated. With
//   stamp = 'loop' every tick gets the tick time (the old main.js behaviour);
//   with stamp = 'camera' it gets the camera frame time.

export const ROI_KEYS = ['forehead', 'l_cheek', 'r_cheek'];

// Skin-like DC level and relative pulse amplitude per channel. The ratios are
// the ones buildDemoRgb in main.js uses (green strongest); they are a test
// fixture, not a physiological reference value.
const DC = [180, 140, 130];
const PULSE_RGB = [0.4, 1.2, 0.3];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussFrom(rand) {
  let spare = null;
  return function gauss() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

/**
 * @returns {{t:number, v:Record<string, number[]>}[]} one entry per pushed
 *          frame: timestamp (ms) and [r, g, b] per ROI.
 */
export function synthCapture({
  seed = 1,
  durationSec = 45,
  cameraFps = 30,
  loopHz = null,
  stamp = 'camera',
  hrBpm = 72,
  hrModBpm = 0,          // sinusoidal HR modulation amplitude (bpm)
  hrModHz = 0.25,        // modulation rate (Hz), breathing-like
  harmonics = [1, 0.5, 0.2],
  pulseAmp = 1,          // 0 = noise only
  noiseStd = 0.3,        // per-channel noise SD, same units as the DC level
  arRho = 0,             // 0 = white, 0 < rho < 1 = AR(1) low-pass noise
  t0Ms = 1000,
  rois = ROI_KEYS,
} = {}) {
  const rand = mulberry32(seed);
  const gauss = gaussFrom(rand);
  const nCam = Math.floor(durationSec * cameraFps);
  const dt = 1 / cameraFps;
  const phases = harmonics.map(() => rand() * 2 * Math.PI);
  const arScale = Math.sqrt(1 - arRho * arRho);
  const arState = {};
  for (const k of rois) arState[k] = [gauss() * noiseStd, gauss() * noiseStd, gauss() * noiseStd];

  // Camera frames.
  const cam = new Array(nCam);
  let phase = 0;
  for (let i = 0; i < nCam; i++) {
    const tSec = i * dt;
    const f0 = (hrBpm + hrModBpm * Math.sin(2 * Math.PI * hrModHz * tSec)) / 60;
    let pulse = 0;
    for (let h = 0; h < harmonics.length; h++) {
      pulse += harmonics[h] * Math.sin((h + 1) * phase + phases[h]);
    }
    phase += 2 * Math.PI * f0 * dt;
    const v = {};
    for (const k of rois) {
      const s = arState[k];
      const out = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        let n;
        if (arRho > 0) {
          s[c] = arRho * s[c] + arScale * gauss() * noiseStd;
          n = s[c];
        } else {
          n = gauss() * noiseStd;
        }
        out[c] = DC[c] + pulseAmp * PULSE_RGB[c] * pulse + n;
      }
      v[k] = out;
    }
    cam[i] = { t: t0Ms + (i * 1000) / cameraFps, v };
  }
  if (!loopHz) return cam;

  // FaceMesh loop re-reading the latest camera frame.
  const out = [];
  const nLoop = Math.floor(durationSec * loopHz);
  for (let j = 0; j < nLoop; j++) {
    const tl = (j * 1000) / loopHz;
    const idx = Math.min(nCam - 1, Math.floor((tl * cameraFps) / 1000 + 1e-9));
    const frame = cam[idx];
    out.push({ t: stamp === 'loop' ? t0Ms + tl : frame.t, v: frame.v });
  }
  return out;
}

/** Push synthetic frames into a LiveRPPG instance (same calls as main.js). */
export function feed(live, frames) {
  for (const f of frames) {
    for (const k of Object.keys(f.v)) {
      const [r, g, b] = f.v[k];
      live.push(k, r, g, b, f.t);
    }
  }
  return live;
}

/** Last `sec` seconds of a capture (frames are in time order). */
export function lastSeconds(frames, sec) {
  const tEnd = frames[frames.length - 1].t;
  return frames.filter((f) => f.t > tEnd - sec * 1000 - 1e-6);
}
