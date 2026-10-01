// Static checks on the served files (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, ROOT), 'utf8');
const ROOT_JS = readdirSync(ROOT).filter((f) => f.endsWith('.js'));
const INDEX = read('index.html');
const MAIN = read('main.js');

const FACE_MESH_VERSION = '0.4.1633559619';
const FACE_MESH_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@${FACE_MESH_VERSION}/`;

test('B10: every ?v= cache-bust string is the same', () => {
  const values = new Set();
  for (const name of [...ROOT_JS, 'index.html']) {
    for (const m of read(name).matchAll(/\?v=([^'"\s)]+)/g)) values.add(m[1]);
  }
  assert.equal(values.size, 1, `found ${[...values].join(', ')}`);
});

test('B10: every relative module import carries the cache-bust string', () => {
  for (const name of ROOT_JS) {
    const src = read(name);
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.\/[^'"]+)['"]/gm)) {
      assert.match(m[1], /\?v=/, `${name} imports ${m[1]} without ?v=`);
    }
  }
});

test('B4: MediaPipe face_mesh is pinned with SRI; camera_utils is gone', () => {
  assert.doesNotMatch(INDEX, /camera_utils/);
  const tags = [...INDEX.matchAll(/<script\b[^>]*\bsrc="(https:[^"]+)"[^>]*>/g)];
  assert.equal(tags.length, 1, 'expected exactly one third-party script');
  const [tag, src] = tags[0];
  assert.equal(src, `${FACE_MESH_BASE}face_mesh.js`);
  assert.match(tag, /\bintegrity="sha384-[A-Za-z0-9+/=]{64}"/);
  assert.match(tag, /\bcrossorigin="anonymous"/);
  assert.ok(MAIN.includes(FACE_MESH_VERSION), 'main.js locateFile must use the pinned version');
  assert.doesNotMatch(MAIN, /@mediapipe\/face_mesh\/\$\{/, 'unpinned locateFile path');
});

function cspOf(html) {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, 'CSP meta tag missing');
  const directives = {};
  for (const part of m[1].split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) directives[name] = vals;
  }
  return directives;
}

test('B4: CSP allows only self, the pinned MediaPipe path and the font', () => {
  const csp = cspOf(INDEX);
  assert.deepEqual(csp['default-src'], ["'self'"]);
  assert.ok(csp['script-src'].includes(FACE_MESH_BASE));
  assert.ok(!csp['script-src'].includes("'unsafe-inline'"));
  assert.ok(csp['connect-src'].includes(FACE_MESH_BASE));
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'none'"]);
  for (const list of Object.values(csp)) {
    for (const v of list) {
      if (/^https?:/.test(v)) {
        assert.ok(
          v === FACE_MESH_BASE ||
          v === 'http://127.0.0.1:8765' ||
          v.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/'),
          `unexpected origin in CSP: ${v}`);
      }
    }
  }
});

test('B4: every inline script is allowed by its sha256 hash', () => {
  const csp = cspOf(INDEX);
  const inline = [...INDEX.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(inline.length >= 1);
  for (const m of inline) {
    const hash = createHash('sha256').update(m[1], 'utf8').digest('base64');
    assert.ok(csp['script-src'].includes(`'sha256-${hash}'`), `missing 'sha256-${hash}'`);
  }
});

test('B6: the hidden attribute always hides', () => {
  const css = read('style.css');
  assert.match(css, /^\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/m);
});

test('B6: the sound screen has a stop button and a volume control', () => {
  const sound = INDEX.slice(INDEX.indexOf('id="screen-sound"'));
  assert.match(sound, /<button[^>]*id="btn-sound-stop"/);
  assert.match(sound, /<input[^>]*type="range"[^>]*id="sound-volume"|<input[^>]*id="sound-volume"[^>]*type="range"/);
  assert.match(MAIN, /setMasterGain\(/);
});

test('B8: no message points at files or paths that are not in this repo', () => {
  for (const name of [...ROOT_JS, 'index.html', 'README.md']) {
    const src = read(name);
    for (const bad of ['/frontend/', 'BELL-HRV-PoC.command', 'setup_sounds.sh']) {
      assert.ok(!src.includes(bad), `${name} mentions ${bad}`);
    }
  }
});

test('B8: camera errors are told apart by name', () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError']) {
    assert.ok(MAIN.includes(name), `main.js does not handle ${name}`);
  }
  assert.match(MAIN, /isSecureContext/);
});

// main.js needs a DOM, a camera and MediaPipe, so these only check that the
// fixes are wired; the behaviour itself is tested in rppg.test.mjs.
function fnBody(src, name) {
  const start = src.search(new RegExp(`function ${name}\\s*\\(`));
  assert.ok(start >= 0, `${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test('B1: FaceMesh is driven once per camera frame and samples carry the frame time', () => {
  const loop = fnBody(MAIN, 'startCameraLoop');
  assert.match(loop, /requestVideoFrameCallback/);
  assert.match(loop, /currentTime/);
  assert.match(loop, /new FrameClock\(/);
  const results = fnBody(MAIN, 'onFaceResults');
  assert.match(results, /const t = state\.frameT;/);
});

test('C2: live HR and result screen use the calibrated SQI', () => {
  const live = fnBody(MAIN, 'runLiveEstimate');
  assert.match(live, /liveGate\.update\(/);
  assert.doesNotMatch(live, /snrDb\s*>\s*3/);
  assert.doesNotMatch(MAIN, /snrDb \|\| 0\) \/ 12/);
  assert.match(fnBody(MAIN, 'renderResult'), /qualityGate\(/);
});

test('C8: a demo run stops when the run id changes', () => {
  const demo = fnBody(MAIN, 'runDemoCapture');
  assert.match(demo, /state\.runId !== runId/);
  for (const name of ['onStartClicked', 'abortCapture', 'endCaptureWithError']) {
    assert.match(fnBody(MAIN, name), /state\.runId\+\+/, `${name} must bump runId`);
  }
});

test('B5: preflight ends with a message when no face or no model', () => {
  const fail = fnBody(MAIN, 'preflightFailure');
  for (const k of ['camera', 'model', 'face']) assert.match(fail, new RegExp(`'${k}'`));
  assert.match(fnBody(MAIN, 'pollPreflight'), /preflightFailure\(/);
  assert.match(MAIN, /addEventListener\('ended'/);
});
