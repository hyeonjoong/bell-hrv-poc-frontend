// Calibration of the SQI mapping in rppg_live.js (SQI_CALIBRATION).
//
//   node test/calibrate_sqi.mjs            # 300 trials per set (about 5 min)
//   node test/calibrate_sqi.mjs --trials 100
//
// Not part of `npm test`; the tests in rppg.test.mjs check the shipped table
// on fresh seeds. Re-run this after changing the generator, the SNR
// definition in dsp.js or the estimator, and paste the printed table into
// rppg_live.js.
//
// Rule, per window length W and separately for the narrow-band SNR (snrDb)
// and the wide-band SNR (snrWideDb):
//   noise sets  no pulse; white noise and AR(1) low-pass noise (rho 0.8, 0.95,
//               0.99) at camera rates 15, 20 and 30 fps.
//   floorDb     median SNR over all noise sets, rounded down to 0.5 dB.
//               Typical noise maps to SQI 0.
//   passDb      highest 99th percentile among the noise sets plus MARGIN_DB,
//               rounded up to 0.5 dB. This is where SQI reaches SQI_PASS.
//   goodDb      floorDb + (passDb - floorDb) / SQI_PASS, rounded up to 0.5 dB.
// The app uses the larger of the two SQIs, so the script reports how often
// noise reaches SQI_PASS on either band (the union), and how often each pulse
// set passes. Targets: noise at most 2 %; a clean pulse at least 95 %, also
// when its rate swings by up to 8 bpm at 0.1 to 0.25 Hz on the 45 s window.
//
// Limits: synthetic data only. Real non-pulse input (a printed photo,
// flicker, head motion) and real heart rate variability can have other
// spectra. Re-tune with recordings that were checked against a pulse
// oximeter when they exist.
import { LiveRPPG, SQI_PASS, sqiFromSnr, SQI_CALIBRATION } from '../rppg_live.js';
import { synthCapture, feed } from './synth.mjs';

const args = process.argv.slice(2);
const TRIALS = Number(args[args.indexOf('--trials') + 1]) || 300;
const WINDOWS = [6, 8, 12, 20, 30, 45];
const APP_WINDOWS = [8, 45];   // live window and final window in main.js
const MARGIN_DB = 1.0;
const SEED_BASE = 900000; // disjoint from the seeds used in rppg.test.mjs

const NOISE_SETS = [];
for (const fps of [30, 20, 15]) {
  for (const arRho of [0, 0.8, 0.95, 0.99]) NOISE_SETS.push({ fps, arRho });
}
// Steady 72 bpm pulse; HR must be within 3 bpm.
const PULSE_SETS = [
  { name: 'clean (noise SD 0.5)', noiseStd: 0.5, arRho: 0 },
  { name: 'moderate (noise SD 1.5)', noiseStd: 1.5, arRho: 0 },
  { name: 'weak (noise SD 3)', noiseStd: 3, arRho: 0 },
  { name: 'clean + drift (AR 0.95, SD 0.5)', noiseStd: 0.5, arRho: 0.95 },
];
// Pulse whose rate swings sinusoidally around 72 bpm (breathing-like), clean
// (noise SD 0.5) unless stated; HR must be within 5 bpm of 72. Reported for
// the windows the app uses only.
const SWING_SETS = [];
for (const bpm of [4, 6, 8]) {
  for (const hz of [0.1, 0.15, 0.25]) {
    SWING_SETS.push({ name: `+-${bpm} bpm at ${hz} Hz`, hrModBpm: bpm, hrModHz: hz, noiseStd: 0.5 });
  }
}
SWING_SETS.push({ name: '+-6 bpm at 0.1 Hz, noise SD 1', hrModBpm: 6, hrModHz: 0.1, noiseStd: 1 });

function snrRun(opts, sec) {
  const live = new LiveRPPG();
  feed(live, synthCapture({ ...opts, durationSec: sec + 1 }));
  return live.estimate(sec);
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const down = (v) => Math.floor(v * 2) / 2;
const up = (v) => Math.ceil(v * 2) / 2;
const pct = (k, n) => `${((100 * k) / n).toFixed(1)} %`;
const BANDS = [
  { key: 'snrDb', floor: 'floorDb', good: 'goodDb', label: 'narrow' },
  { key: 'snrWideDb', floor: 'wideFloorDb', good: 'wideGoodDb', label: 'wide' },
];

const rows = [];
const noiseByWindow = {};
for (const sec of WINDOWS) {
  const runs = [];   // per noise set: list of { snrDb, snrWideDb }
  for (const set of NOISE_SETS) {
    const vals = [];
    for (let s = 0; s < TRIALS; s++) {
      const est = snrRun({ seed: SEED_BASE + s * 7 + set.fps * 1000 + Math.round(set.arRho * 100),
        cameraFps: set.fps, arRho: set.arRho, pulseAmp: 0, noiseStd: 1 }, sec);
      vals.push(est.hr == null
        ? { snrDb: -Infinity, snrWideDb: -Infinity }
        : { snrDb: est.snrDb, snrWideDb: est.snrWideDb });
    }
    runs.push({ set, vals });
  }
  const row = { sec };
  for (const band of BANDS) {
    const all = [];
    let maxP99 = -Infinity;
    for (const { vals } of runs) {
      const v = vals.map((x) => x[band.key]).sort((a, b) => a - b);
      maxP99 = Math.max(maxP99, quantile(v, 0.99));
      all.push(...v);
    }
    all.sort((a, b) => a - b);
    const floorDb = down(quantile(all, 0.5));
    const passDb = up(maxP99 + MARGIN_DB);
    row[band.floor] = floorDb;
    row[band.good] = up(floorDb + (passDb - floorDb) / SQI_PASS);
    console.log(`W=${sec}s ${band.label}: noise median ${quantile(all, 0.5).toFixed(2)} dB, ` +
      `max p99 ${maxP99.toFixed(2)} dB -> floor ${floorDb}, pass ${passDb}, good ${row[band.good]}`);
  }
  rows.push(row);
  noiseByWindow[sec] = runs;
}

console.log('\nexport const SQI_CALIBRATION = [');
for (const r of rows) {
  console.log(`  { sec: ${r.sec}, floorDb: ${r.floorDb}, goodDb: ${r.goodDb}, ` +
    `wideFloorDb: ${r.wideFloorDb}, wideGoodDb: ${r.wideGoodDb} },`);
}
console.log('];');

// Check with the rounded table (the one printed above, not necessarily the
// one currently in rppg_live.js): SQI = larger of the two mappings.
const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
function sqiWith(table, est, sec) {
  const row = table.find((r) => r.sec === sec);
  const n = clamp01((est.snrDb - row.floorDb) / (row.goodDb - row.floorDb));
  const w = clamp01((est.snrWideDb - row.wideFloorDb) / (row.wideGoodDb - row.wideFloorDb));
  return Math.max(n, w);
}
console.log('\nNoise reaching SQI_PASS on either band with the printed table:');
for (const sec of WINDOWS) {
  const parts = noiseByWindow[sec].map(({ set, vals }) => {
    const k = vals.filter((v) => sqiWith(rows, v, sec) >= SQI_PASS).length;
    return `${set.fps}fps/rho${set.arRho} ${pct(k, vals.length)}`;
  });
  console.log(`  W=${sec}s: ${parts.join(', ')}`);
}

function passRate(opts, sec, tolBpm) {
  let k = 0;
  for (let s = 0; s < TRIALS; s++) {
    const est = snrRun({ seed: SEED_BASE + 500000 + s, cameraFps: 30, hrBpm: 72, pulseAmp: 1, ...opts }, sec);
    if (est.hr != null && Math.abs(est.hr - 72) <= tolBpm && sqiWith(rows, est, sec) >= SQI_PASS) k++;
  }
  return pct(k, TRIALS);
}
console.log('\nSteady pulse (72 bpm, 30 fps) reaching SQI_PASS with HR within 3 bpm:');
for (const ps of PULSE_SETS) {
  const parts = WINDOWS.map((sec) => `W=${sec}s ${passRate({ noiseStd: ps.noiseStd, arRho: ps.arRho }, sec, 3)}`);
  console.log(`  ${ps.name}: ${parts.join(', ')}`);
}
console.log('\nPulse with a swinging rate (mean 72 bpm, 30 fps) reaching SQI_PASS with HR within 5 bpm:');
for (const ss of SWING_SETS) {
  const opts = { noiseStd: ss.noiseStd, hrModBpm: ss.hrModBpm, hrModHz: ss.hrModHz };
  const parts = APP_WINDOWS.map((sec) => `W=${sec}s ${passRate(opts, sec, 5)}`);
  console.log(`  ${ss.name}: ${parts.join(', ')}`);
}

const same = rows.every((r, i) => {
  const c = SQI_CALIBRATION[i];
  return c && c.sec === r.sec && c.floorDb === r.floorDb && c.goodDb === r.goodDb &&
    c.wideFloorDb === r.wideFloorDb && c.wideGoodDb === r.wideGoodDb;
});
console.log(`\nrppg_live.js SQI_CALIBRATION ${same ? 'matches' : 'differs from'} the printed table.`);
// sqiFromSnr is imported so a broken export fails here too.
if (typeof sqiFromSnr !== 'function') process.exit(1);
