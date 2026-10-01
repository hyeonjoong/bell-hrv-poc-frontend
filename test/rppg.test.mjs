// Tests for rppg_live.js: final estimate (C1), loop rate and camera rate
// independence (B1), quality gate (C2), buffer handling and frame timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../rppg_live.js';
import { synthCapture, feed, ROI_KEYS } from './synth.mjs';

const SQI_PASS = typeof R.SQI_PASS === 'number' ? R.SQI_PASS : 0.6;
const CLEAN = { pulseAmp: 1, noiseStd: 0.5 };
const NOISE = { pulseAmp: 0, noiseStd: 1 };

// The quality the app shows for an estimate. Falls back to the mappings the
// app used before the harmonic SNR (snr/12 on the result screen, snr > 3 dB
// for the live ring) so these tests also describe the old behaviour.
function sqiOf(est) {
  if (typeof est.sqi === 'number') return est.sqi;
  return Math.max(0, Math.min(1, (est.snrDb || 0) / 12));
}
function liveShown(est) {
  if (est.hr == null) return false;
  if (typeof est.sqi === 'number') return est.sqi >= SQI_PASS;
  return est.snrDb > 3;
}
function run(opts, windowSec) {
  const live = new R.LiveRPPG();
  feed(live, synthCapture(opts));
  return live.estimate(windowSec);
}

// ---------------------------------------------------------------- C1
for (const fps of [15, 20, 25, 30, 60]) {
  test(`C1: 45 s capture at ${fps} fps gives the final HR and a passing SQI`, () => {
    const est = run({ seed: 100 + fps, durationSec: 45, cameraFps: fps, hrBpm: 72, ...CLEAN }, 45);
    assert.notEqual(est.hr, null, 'final HR missing');
    assert.ok(Math.abs(est.hr - 72) <= 2, `hr ${est.hr}`);
    assert.ok(sqiOf(est) >= 0.6, `sqi ${sqiOf(est)}`);
  });
}

test('C1: the history is bounded by time, not by sample count', () => {
  const live = new R.LiveRPPG();
  feed(live, synthCapture({ seed: 3, durationSec: 120, cameraFps: 30, ...CLEAN }));
  const keepMs = live.keepMs ?? 50000;
  assert.equal(keepMs, 50000);
  for (const k of ROI_KEYS) {
    const s = live.samples[k];
    const newest = s[s.length - 1].t;
    assert.ok(s[0].t >= newest - keepMs, `${k}: oldest sample is older than keepMs`);
    assert.ok(newest - s[0].t >= 45000, `${k}: less than 45 s kept`);
  }
});

test('C1: keepMs is a constructor option', () => {
  const live = new R.LiveRPPG({ keepMs: 10000 });
  feed(live, synthCapture({ seed: 4, durationSec: 30, cameraFps: 30, ...CLEAN }));
  const s = live.samples.forehead;
  assert.ok(s[s.length - 1].t - s[0].t <= 10000);
});

test('C1: estimate uses the history it has when the window is longer', () => {
  const est = run({ seed: 5, durationSec: 20, cameraFps: 30, hrBpm: 66, ...CLEAN }, 45);
  assert.ok(Math.abs(est.hr - 66) <= 2, `hr ${est.hr}`);
  assert.ok(est.windowSec > 19 && est.windowSec <= 20, `windowSec ${est.windowSec}`);
});

test('C1: a ROI needs at least MIN_WINDOW_SEC of history', () => {
  assert.equal(R.MIN_WINDOW_SEC, 6);
  const short = run({ seed: 6, durationSec: 5, cameraFps: 30, ...CLEAN }, 8);
  assert.equal(short.hr, null);
  assert.equal(sqiOf(short), 0);
  const ok = run({ seed: 6, durationSec: 7, cameraFps: 30, ...CLEAN }, 8);
  assert.ok(Math.abs(ok.hr - 72) <= 3, `hr ${ok.hr}`);
});

// ---------------------------------------------------------------- B1
const B1_RATES = [55, 62, 72, 85, 100];
const B1_CASES = [
  { name: 'camera 30 fps, loop 30 Hz', cameraFps: 30, loopHz: 30, stamp: 'loop' },
  { name: 'camera 30 fps, loop 45 Hz, loop stamps', cameraFps: 30, loopHz: 45, stamp: 'loop' },
  { name: 'camera 30 fps, loop 60 Hz, loop stamps', cameraFps: 30, loopHz: 60, stamp: 'loop' },
  { name: 'camera 30 fps, loop 120 Hz, loop stamps', cameraFps: 30, loopHz: 120, stamp: 'loop' },
  { name: 'camera 30 fps, loop 45 Hz, camera stamps', cameraFps: 30, loopHz: 45, stamp: 'camera' },
  { name: 'camera 30 fps, loop 60 Hz, camera stamps', cameraFps: 30, loopHz: 60, stamp: 'camera' },
  { name: 'camera 30 fps, loop 120 Hz, camera stamps', cameraFps: 30, loopHz: 120, stamp: 'camera' },
  { name: 'genuine 60 fps camera', cameraFps: 60, loopHz: null, stamp: 'camera' },
  { name: 'camera 24 fps, loop 60 Hz, camera stamps', cameraFps: 24, loopHz: 60, stamp: 'camera' },
];
for (const c of B1_CASES) {
  test(`B1: live 8 s HR is right for ${c.name}`, () => {
    for (const hr of B1_RATES) {
      const est = run({ seed: 200 + hr, durationSec: 12, hrBpm: hr, ...CLEAN, ...c }, 8);
      assert.ok(est.hr != null && Math.abs(est.hr - hr) <= 2, `${hr} bpm read as ${est.hr}`);
    }
  });
}

test('B1: push ignores samples whose timestamp does not advance', () => {
  const live = new R.LiveRPPG();
  live.push('forehead', 1, 2, 3, 1000);
  live.push('forehead', 1, 2, 3, 1000);
  live.push('forehead', 1, 2, 3, 990);
  live.push('forehead', 1, 2, 3, 1033);
  live.push('forehead', 1, 2, 3, NaN);
  assert.deepEqual(live.samples.forehead.map((s) => s.t), [1000, 1033]);
});

test('B1: FrameClock follows camera media time steps', () => {
  const c = new R.FrameClock();
  const t0 = c.next(0, 5000);
  assert.equal(t0, 5000);
  // Media time steps of 33.3 ms, wall clock jittering on a 60 Hz display.
  assert.equal(c.next(33.3, 5050), 5033.3);
  assert.ok(Math.abs(c.next(66.6, 5067) - 5066.6) < 1e-9);
});

test('B1: FrameClock falls back to wall time for missing or frozen media time', () => {
  const c = new R.FrameClock();
  c.next(NaN, 1000);
  assert.equal(c.next(NaN, 1040), 1040);
  assert.equal(c.next(NaN, 1070), 1070);
  const d = new R.FrameClock();
  d.next(500, 1000);
  assert.equal(d.next(500, 1033), 1033); // frozen media time: wall step
  assert.equal(d.next(533, 1066), 1066); // media step again
});

test('B1: FrameClock ignores an implausible media time jump', () => {
  const c = new R.FrameClock();
  c.next(0, 1000);
  c.next(33, 1033);
  assert.equal(c.next(5000, 1066), 1066);
  assert.equal(c.next(-200, 1100), 1100);
});

test('B1: FrameClock stops trusting a media clock that runs at the wrong rate', () => {
  const c = new R.FrameClock();
  let t = 0;
  for (let i = 0; i <= 120; i++) t = c.next(i * 66.6, 1000 + i * 33.3); // media runs 2x
  const before = t;
  const after = c.next(121 * 66.6, 1000 + 121 * 33.3);
  assert.ok(Math.abs(after - before - 33.3) < 1e-6, `step ${after - before}`);
});

test('B1: FrameClock output is strictly increasing for new frames', () => {
  const c = new R.FrameClock();
  let prev = -Infinity;
  const media = [0, 33, 33, NaN, 100, 99, 5000, 166];
  media.forEach((m, i) => {
    const t = c.next(m, 1000 + i * 33);
    assert.ok(t > prev, `frame ${i}: ${t} <= ${prev}`);
    prev = t;
  });
});

// ---------------------------------------------------------------- C2
function countPass(n, optsFor, windowSec, pred) {
  let k = 0;
  for (let s = 0; s < n; s++) if (pred(run(optsFor(s), windowSec))) k++;
  return k;
}

const NOISE_SETS = [
  { name: '8 s at 30 fps, white', sec: 8, fps: 30, arRho: 0 },
  { name: '45 s at 30 fps, white', sec: 45, fps: 30, arRho: 0 },
  { name: '45 s at 20 fps, white', sec: 45, fps: 20, arRho: 0 },
  { name: '8 s at 30 fps, AR(1) 0.95', sec: 8, fps: 30, arRho: 0.95 },
  { name: '45 s at 30 fps, AR(1) 0.95', sec: 45, fps: 30, arRho: 0.95 },
];
for (const set of NOISE_SETS) {
  test(`C2: noise only (${set.name}) passes the quality gate in at most 1 of 50`, () => {
    const opts = (s) => ({ seed: 5000 + s, durationSec: set.sec, cameraFps: set.fps, arRho: set.arRho, ...NOISE });
    const k = countPass(50, opts, set.sec, (e) => sqiOf(e) >= 0.6);
    assert.ok(k <= 1, `${k} of 50 noise captures reached SQI 0.6`);
    if (set.sec === 8) {
      const shown = countPass(50, opts, 8, liveShown);
      assert.ok(shown <= 1, `${shown} of 50 noise windows showed a live HR`);
    }
  });
}

for (const sec of [8, 45]) {
  test(`C2: a clean 72 bpm pulse (${sec} s) passes the quality gate in at least 48 of 50`, () => {
    const opts = (s) => ({ seed: 7000 + s, durationSec: sec, cameraFps: 30, hrBpm: 72, ...CLEAN });
    const k = countPass(50, opts, sec, (e) => sqiOf(e) >= 0.6 && Math.abs(e.hr - 72) <= 2);
    assert.ok(k >= 48, `only ${k} of 50 clean captures passed`);
  });
}

test('C2: per-ROI quality uses the same scale', () => {
  const clean = run({ seed: 11, durationSec: 45, cameraFps: 30, ...CLEAN }, 45);
  for (const k of ROI_KEYS) assert.ok(clean.perROI[k] >= 0.6, `${k} ${clean.perROI[k]}`);
  const noise = run({ seed: 12, durationSec: 45, cameraFps: 30, ...NOISE }, 45);
  for (const k of ROI_KEYS) {
    assert.ok(noise.perROI[k] >= 0 && noise.perROI[k] < 0.6, `${k} ${noise.perROI[k]}`);
  }
});

test('C2: sqiFromSnr is bounded, monotonic and calibrated per window', () => {
  assert.equal(typeof R.sqiFromSnr, 'function');
  for (const row of R.SQI_CALIBRATION) {
    assert.equal(R.sqiFromSnr(row.floorDb, row.sec), 0);
    assert.equal(R.sqiFromSnr(row.goodDb, row.sec), 1);
    assert.ok(row.goodDb > row.floorDb);
  }
  for (const sec of [6, 8, 10, 20, 45, 60]) {
    let prev = -1;
    for (let snr = -30; snr <= 20; snr += 0.5) {
      const q = R.sqiFromSnr(snr, sec);
      assert.ok(q >= 0 && q <= 1);
      assert.ok(q >= prev);
      prev = q;
    }
  }
  assert.equal(R.sqiFromSnr(NaN, 8), 0);
});

test('C2: result gate hides an in-browser HR below SQI_PASS', () => {
  assert.equal(R.SQI_PASS, 0.6);
  const lowLocal = R.qualityGate(0.3, 'in-browser');
  assert.equal(lowLocal.pass, false);
  assert.equal(lowLocal.showHr, false);
  assert.equal(lowLocal.showChip, true);
  const ok = R.qualityGate(0.6, 'in-browser');
  assert.equal(ok.pass, true);
  assert.equal(ok.showHr, true);
  assert.equal(ok.showChip, false);
  const none = R.qualityGate(0, 'placeholder');
  assert.equal(none.showChip, false);
  const backendLow = R.qualityGate(0.5, 'backend');
  assert.equal(backendLow.showHr, true);
  assert.equal(backendLow.showChip, true);
});

// ------------------------------------------------- C2: live display gate
// main.js runs estimate(8) every 500 ms during the 45 s capture and passes
// each result through LiveHrGate. Replay that on synthetic captures.
function liveStream(opts) {
  const frames = synthCapture({ durationSec: 45, cameraFps: 30, ...opts });
  const live = new R.LiveRPPG();
  const gate = new R.LiveHrGate();
  const shown = [];
  let next = frames[0].t + 500;
  for (const f of frames) {
    for (const k of Object.keys(f.v)) live.push(k, ...f.v[k], f.t);
    if (f.t >= next) {
      next += 500;
      shown.push(gate.update(live.estimate(8), true));
    }
  }
  return shown;
}

test('C2: live gate never shows an HR for noise-only captures (20 x 45 s)', () => {
  let shownCount = 0, total = 0;
  for (let s = 0; s < 20; s++) {
    for (const g of liveStream({ seed: 9100 + s, arRho: s % 2 ? 0.95 : 0, ...NOISE })) {
      total++;
      if (g.hr != null) shownCount++;
    }
  }
  assert.ok(shownCount / total <= 0.02, `${shownCount} of ${total} live updates showed an HR`);
});

test('C2: live gate shows a clean pulse within 2 bpm once 8 s are in', () => {
  for (let s = 0; s < 5; s++) {
    const g = liveStream({ seed: 9200 + s, hrBpm: 66, ...CLEAN });
    const after = g.slice(18); // estimates from about 9.5 s on
    const shown = after.filter((x) => x.hr != null);
    assert.ok(shown.length >= 0.9 * after.length, `shown ${shown.length} of ${after.length}`);
    for (const x of shown) assert.ok(Math.abs(x.hr - 66) <= 2, `hr ${x.hr}`);
    assert.ok(shown.every((x) => x.live === true));
  }
});

test('C2: live gate clears the HR after repeated failing estimates and when the face is gone', () => {
  const gate = new R.LiveHrGate({ clearAfter: 3 });
  const good = { hr: 70, sqi: 0.9 };
  const bad = { hr: 140, sqi: 0.2 };
  const fair = { hr: 70, sqi: (R.SQI_LIVE_HOLD + R.SQI_PASS) / 2 };
  assert.equal(gate.update(fair, true).hr, null, 'below SQI_PASS nothing is shown');
  assert.equal(gate.update(good, true).hr, 70);
  for (let i = 0; i < 5; i++) assert.equal(gate.update(fair, true).hr, 70, 'shown HR is held above SQI_LIVE_HOLD');
  assert.equal(gate.update(bad, true).hr, 70);
  assert.equal(gate.update(bad, true).hr, 70);
  const cleared = gate.update(bad, true);
  assert.equal(cleared.hr, null);
  assert.equal(cleared.live, false);
  assert.equal(gate.update(good, true).hr, 70);
  assert.equal(gate.update(good, false).hr, 70);   // one frame without a face counts as a failure
  gate.update(good, false);
  assert.equal(gate.update(good, false).hr, null);
  assert.equal(gate.update({ hr: null, sqi: 0 }, true).hr, null);
});
