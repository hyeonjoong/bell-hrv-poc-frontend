// Tests for the frame-rate check in preflight.js (no canvas needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Preflight, PREFLIGHT_THRESHOLDS } from '../preflight.js';

// Feed evaluated frames directly; observe() needs a video element and canvas.
function evaluate({ cameraFps, processedFps, sec = 3 }) {
  const p = new Preflight(3000);
  p.start();
  const nCam = Math.floor(sec * cameraFps) + 1;
  for (let i = 0; i < nCam; i++) p.noteCameraFrame(1000 + (i * 1000) / cameraFps);
  const nProc = Math.floor(sec * processedFps) + 1;
  for (let i = 0; i < nProc; i++) {
    p.frames.push({ t: 1000 + (i * 1000) / processedFps, faceMean: 120, faceStd: 20, bgMean: 100, cx: 320, cy: 240 });
  }
  return p._evaluate();
}
const fpsCheck = (r) => r.checks.find((c) => c.key === 'fps');

test('preflight can be constructed without a DOM', () => {
  assert.doesNotThrow(() => new Preflight(3000));
});

test('frame-rate check uses the camera rate, not the analysis rate', () => {
  const ok = evaluate({ cameraFps: 30, processedFps: 22 });
  assert.equal(fpsCheck(ok).pass, true);
  assert.ok(Math.abs(ok.cameraFps - 30) < 0.5);
  assert.ok(Math.abs(ok.processedFps - 22) < 0.5);
  assert.equal(ok.allPass, true);
});

test('a slow camera fails the frame-rate check', () => {
  const r = evaluate({ cameraFps: 24, processedFps: 24 });
  assert.equal(fpsCheck(r).pass, false);
  assert.equal(r.allPass, false);
});

test('analysis below the minimum processed rate fails the frame-rate check', () => {
  assert.equal(PREFLIGHT_THRESHOLDS.minProcessedFps, 15);
  const r = evaluate({ cameraFps: 30, processedFps: 12 });
  assert.equal(fpsCheck(r).pass, false);
  assert.notEqual(fpsCheck(r).hint, evaluate({ cameraFps: 20, processedFps: 20 }).checks[0].hint);
});

test('without camera frame notes the analysis rate is used (old callers)', () => {
  const p = new Preflight(3000);
  p.start();
  for (let i = 0; i <= 90; i++) {
    p.frames.push({ t: 1000 + (i * 1000) / 30, faceMean: 120, faceStd: 20, bgMean: 100, cx: 320, cy: 240 });
  }
  const r = p._evaluate();
  assert.equal(fpsCheck(r).pass, true);
  assert.ok(Math.abs(r.fps - 30) < 0.5);
});

test('presentedFrames counts camera frames whose callback was skipped', () => {
  // requestVideoFrameCallback fires for every second frame while FaceMesh is
  // busy; metadata.presentedFrames still advances by one per camera frame.
  const p = new Preflight(3000);
  p.start();
  for (let i = 0; i <= 90; i += 2) p.noteCameraFrame(1000 + (i * 1000) / 30, 500 + i);
  for (let i = 0; i <= 45; i++) {
    p.frames.push({ t: 1000 + (i * 2000) / 30, faceMean: 120, faceStd: 20, bgMean: 100, cx: 320, cy: 240 });
  }
  const r = p._evaluate();
  assert.ok(Math.abs(r.cameraFps - 30) < 0.5, `camera ${r.cameraFps}`);
  assert.ok(Math.abs(r.processedFps - 15) < 0.5, `processed ${r.processedFps}`);
  assert.equal(fpsCheck(r).pass, true);
});
