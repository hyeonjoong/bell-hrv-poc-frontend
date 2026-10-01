// Tests for dsp.js against a scipy reference (test/fixtures/dsp_reference.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as dsp from '../dsp.js';
import { mulberry32, gaussFrom } from './synth.mjs';

const REF = JSON.parse(readFileSync(new URL('./fixtures/dsp_reference.json', import.meta.url), 'utf8'));

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
function maxAbs(a) {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}

test('BPF30 coefficients equal scipy.signal.butter(4, [0.7/15, 4/15], band)', () => {
  assert.equal(dsp.BPF30_B.length, REF.b.length);
  assert.equal(dsp.BPF30_A.length, REF.a.length);
  assert.ok(maxAbsDiff(dsp.BPF30_B, REF.b) < 1e-12);
  assert.ok(maxAbsDiff(dsp.BPF30_A, REF.a) < 1e-12);
});

test('computeBPFCoeffs(30) returns the BPF30 coefficients', () => {
  const { b, a } = dsp.computeBPFCoeffs(30);
  assert.deepEqual(Array.from(b), dsp.BPF30_B);
  assert.deepEqual(Array.from(a), dsp.BPF30_A);
});

test('applyIIR matches scipy lfilter', () => {
  const y = dsp.applyIIR(REF.x, REF.b, REF.a);
  assert.equal(y.length, REF.lfilter.length);
  const err = maxAbsDiff(y, REF.lfilter) / maxAbs(REF.lfilter);
  assert.ok(err < 1e-5, `relative error ${err}`);
});

test('filtfilt matches the scipy forward-reverse composition', () => {
  const y = dsp.filtfilt(REF.x, REF.b, REF.a);
  assert.equal(y.length, REF.forward_reverse.length);
  const err = maxAbsDiff(y, REF.forward_reverse) / maxAbs(REF.forward_reverse);
  assert.ok(err < 1e-5, `relative error ${err}`);
});

function tone(bpm, sec, fs = 30, amp = 1) {
  const n = Math.floor(sec * fs);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * (bpm / 60) * i) / fs + 0.4);
  return x;
}

test('fftPeakBpm finds pure tones from 45 to 180 bpm within 1 bpm (8 s and 45 s)', () => {
  for (const sec of [8, 45]) {
    for (let bpm = 45; bpm <= 180; bpm += 5) {
      const { hrBpm } = dsp.fftPeakBpm(tone(bpm, sec), 30);
      assert.ok(Math.abs(hrBpm - bpm) <= 1, `${sec} s, ${bpm} bpm read as ${hrBpm}`);
    }
  }
});

test('fftPeakBpm snrDb is a harmonic SNR: high for a pulse, negative for noise', () => {
  assert.equal(typeof dsp.HARMONIC_HALF_WIDTH_HZ, 'number');
  const clean = dsp.fftPeakBpm(tone(72, 45), 30);
  assert.ok(clean.snrDb > 10, `clean tone snr ${clean.snrDb}`);
  const gauss = gaussFrom(mulberry32(7));
  let positive = 0;
  for (let trial = 0; trial < 30; trial++) {
    const x = new Float64Array(1350);
    for (let i = 0; i < x.length; i++) x[i] = gauss();
    const y = dsp.filtfilt(x, dsp.BPF30_B, dsp.BPF30_A);
    if (dsp.fftPeakBpm(y, 30).snrDb > 0) positive++;
  }
  assert.equal(positive, 0, 'band-limited white noise should never reach 0 dB');
});

test('fftPeakBpm counts the second harmonic as signal', () => {
  const fs = 30, n = 45 * fs;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = (2 * Math.PI * 1.2 * i) / fs;
    x[i] = Math.sin(p);
    y[i] = Math.sin(p) + 0.6 * Math.sin(2 * p);
  }
  const a = dsp.fftPeakBpm(x, fs), b = dsp.fftPeakBpm(y, fs);
  assert.ok(Math.abs(b.hrBpm - 72) <= 1);
  // Adding a harmonic moves power from "noise" into "signal": SNR must not drop.
  assert.ok(b.snrDb >= a.snrDb - 0.5, `${b.snrDb} vs ${a.snrDb}`);
});

test('fftPeakBpm returns no HR and NO_SNR_DB for unusable input', () => {
  assert.equal(typeof dsp.NO_SNR_DB, 'number');
  const short = dsp.fftPeakBpm(new Float64Array(8), 30);
  assert.equal(short.hrBpm, null);
  assert.equal(short.snrDb, dsp.NO_SNR_DB);
  const flat = dsp.fftPeakBpm(new Float64Array(300), 30);
  assert.equal(flat.hrBpm, null);
  assert.equal(flat.snrDb, dsp.NO_SNR_DB);
});
