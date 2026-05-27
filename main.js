/* Phase 4 (hotfix 4.1) — SleepThera R&D Preview orchestration (ES module).
 *
 * Imports BellSoundEngine (Web Audio bed + breath loop), ANS_TO_SOUND map,
 * and HRVTrace (dual-trace canvas). Removes all Tone.js dependence.
 *
 * Hotfix notes:
 *  - All DOM setup is deferred to DOMContentLoaded so a stale cached HTML
 *    (with this script in a non-deferred position) still works.
 *  - AudioContext / BellSoundEngine init is deferred to the first user
 *    gesture inside onStartClicked() — avoids Chrome's "AudioContext was
 *    not allowed to start" warning and keeps the click flow clean.
 *  - els lookups are tolerant of missing ids: a one-time warning is logged
 *    but execution continues so the button handler still attaches.
 */
import { BellSoundEngine } from './sound.js?v=6.4-pages';
import { ANS_TO_SOUND, ANS_KOREAN, REQUIRED_ASSETS } from './sound_mapping.js?v=6.4-pages';
import { HRVTrace } from './hrv_trace.js?v=6.4-pages';
import { LiveRPPG } from './rppg_live.js?v=6.4-pages';
import { Preflight } from './preflight.js?v=6.4-pages';

// iOS Safari hotfix — surface any silent failure as an on-screen red bar so
// we don't lose context to a backgrounded console. Wired before anything else
// so even errors during module init are visible on the phone.
//
// Verbose stage-by-stage trace is gated behind ?debug=1 in the URL. Real
// errors (thrown exceptions, promise rejections) ALWAYS surface so we never
// lose a regression silently again.
const DEBUG_TRACE = /[?&]debug=1\b/.test(location.search);
function traceLog(msg) { if (DEBUG_TRACE) showInlineError('[trace] ' + msg); }

function _safeStr(x) {
  if (x == null) return String(x);
  if (typeof x === 'string') return x;
  if (x.stack) return `${x.message || x.name || ''}\n${x.stack}`;
  if (x.message) return x.message;
  try { return JSON.stringify(x); } catch { return String(x); }
}
window.addEventListener('error', (e) => {
  try {
    const where = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '(cross-origin or unknown)';
    const detail = e.error ? _safeStr(e.error) : e.message;
    showInlineError(`[ERR] ${e.message || 'unknown'} @ ${where}\n${detail}`);
  } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { showInlineError(`[PROMISE] ${_safeStr(e.reason)}`); } catch {}
});
window.addEventListener('pagehide', (e) => {
  console.warn('[pagehide] persisted=', e.persisted);
});

// When hosted on GitHub Pages (or any non-local origin) there is no backend
// to call — skip the fetch entirely and let the in-browser estimate carry the
// result. Saves a 5s timeout per measurement on the public deploy.
const _isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
const API_BASE = _isLocal ? 'http://127.0.0.1:8765' : null;
const CAPTURE_SECONDS = 45;
const PREFLIGHT_MS = 3000;
const FACE_LOST_HINT_MS = 1000;
const FACE_LOST_ABORT_MS = 3000;
const FACE_LOST_RETICLE_LOST_MS = 200;
const SQI_RING_CIRC = 2 * Math.PI * 52;
const SQI_LIVE_THRESHOLD = 0.55;

// Phase 6 — multi-ROI landmark indices (MediaPipe Face Mesh 468-point).
const ROI_FOREHEAD = [10, 67, 297, 332];
const ROI_LCHEEK   = [116, 117, 118, 119, 50, 205];
const ROI_RCHEEK   = [345, 346, 347, 348, 280, 425];
const ROI_DEFS = [
  { key: 'forehead', idx: ROI_FOREHEAD, label_ko: '이마' },
  { key: 'l_cheek',  idx: ROI_LCHEEK,   label_ko: '좌측 볼' },
  { key: 'r_cheek',  idx: ROI_RCHEEK,   label_ko: '우측 볼' },
];
const ROI_LABELS = { forehead: '이마', l_cheek: '좌측 볼', r_cheek: '우측 볼' };

const DEMO_CYCLE = [
  'balanced', 'vagal_dominant', 'sympathetic_dominant', 'low_arousal', 'uncertain',
];

// ─── Element lookup table (id-by-id, null-tolerant) ────────────
// Populated by initDom() once DOMContentLoaded has fired. Until then it is
// just an empty object — guards in the call sites use `els.X?.method?.()`.
const ELS_BINDINGS = {
  bellLogo: 'bell-logo',
  demoPill: 'demo-pill',
  assetBanner: 'asset-banner',
  introScreen: 'screen-intro',
  captureScreen: 'screen-capture',
  resultScreen: 'screen-result',
  soundScreen: 'screen-sound',
  btnStart: 'btn-start',
  btnCancel: 'btn-cancel',
  btnRetry: 'btn-retry',
  btnSound: 'btn-sound',
  btnFinish: 'btn-finish',
  introErr: 'intro-err',
  video: 'video',
  faceOverlay: 'face-overlay',
  roiCanvas: 'roi-canvas',
  faceHint: 'face-hint',
  ringFg: 'ring-fg',
  hrRing: 'hr-ring',
  sqiPct: 'sqi-pct',
  countdown: 'countdown',
  captureSidebar: 'capture-sidebar',
  tracePanel: 'trace-panel',
  preflightPanel: 'preflight-panel',
  preflightChecks: 'preflight-checks',
  preflightRetryRow: 'preflight-retry-row',
  btnPreflightRetry: 'btn-preflight-retry',
  btnPreflightSkip: 'btn-preflight-skip',
  hrvCanvas: 'hrv-canvas',
  traceModeBadge: 'trace-mode',
  bpmValue: 'bpm-value',
  gaugePoint: 'gauge-point',
  ansBadge: 'ans-badge',
  ansLabel: 'ans-label',
  ansInterpretation: 'ans-interpretation',
  mHr: 'm-hr',
  mRmssd: 'm-rmssd',
  mSdnn: 'm-sdnn',
  mSd1: 'm-sd1',
  mSd2: 'm-sd2',
  mSqi: 'm-sqi',
  rationale: 'rationale',
  rHr: 'r-hr',
  rRmssd: 'r-rmssd',
  rSpark: 'r-spark',
  rAnsBadge: 'r-ans-badge',
  rAnsLabel: 'r-ans-label',
  rRationale: 'r-rationale',
  rProfile: 'r-profile',
  rTempo: 'r-tempo',
  rCarrier: 'r-carrier',
  rBinaural: 'r-binaural',
  fallback: 'fallback',
  breathingOrb: 'breathing-orb',
  breathingText: 'breathing-text',
  audioVis: 'audio-vis',
  soundStateLabel: 'sound-state-label',
  soundProfileName: 'sound-profile-name',
  soundTimer: 'sound-timer',
  feedbackRow: 'feedback-row',
  toast: 'toast',
  roiBreakdown: 'roi-breakdown',
  roiBreakdownBody: 'roi-breakdown-body',
};
const els = {};

const state = {
  demoMode: false,
  phase: 'idle',                                      // 'idle' | 'preflight' | 'capturing'
  stream: null,
  faceMesh: null,
  faceMeshActive: false,
  samples: [],                                        // legacy single-ROI buffer
  samplesByROI: { forehead: [], l_cheek: [], r_cheek: [] },
  lastBoxes: null,
  captureStartMs: 0,
  lastFaceMs: 0,
  rafCapture: null,
  cancelled: false,
  liveHrEMA: null,
  lastFaceBox: null,
  lastSqi: 0,
  bvpForSpark: null,
  /** @type {HRVTrace|null} */ trace: null,
  /** @type {LiveRPPG|null} */ liveRppg: null,
  /** @type {Preflight|null} */ preflight: null,
  liveTimer: null,
  /** @type {BellSoundEngine|null} */ engine: null,
  engineInitOnce: false,
  soundRaf: null,
  soundTimerStart: 0,
};

// ───────────────────────── helpers ─────────────────────────
function show(screen) {
  for (const s of [els.introScreen, els.captureScreen, els.resultScreen, els.soundScreen]) {
    s.hidden = s !== screen;
  }
}

function toast(msg, duration = 2000) {
  els.toast.textContent = msg;
  els.toast.classList.add('visible');
  setTimeout(() => els.toast.classList.remove('visible'), duration);
}

function showError(msg) { els.introErr.textContent = msg; els.introErr.hidden = false; }
function clearError() { els.introErr.hidden = true; els.introErr.textContent = ''; }

function getCSS(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function ansColor(stateName) {
  return getCSS(`--ans-${stateName}`) || '#3D5FE0';
}
function fmt(v, d = 1) {
  return v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function showInlineError(msg) {
  let div = document.getElementById('inline-err');
  if (!div) {
    div = document.createElement('div');
    div.id = 'inline-err';
    div.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#a32;color:#fff;' +
      'padding:10px 36px 10px 10px;font-size:11px;z-index:99999;max-height:50vh;overflow:auto;' +
      'font-family:monospace;line-height:1.4;white-space:pre-wrap;word-break:break-word;' +
      'cursor:pointer';
    div.title = '탭하면 닫힘';
    // Tap anywhere on the bar to dismiss it.
    div.addEventListener('click', () => { div.remove(); });
    document.body.appendChild(div);
  }
  // Append rather than overwrite so multiple errors all stay visible.
  const stamp = new Date().toISOString().slice(11, 19);
  div.textContent = `[${stamp}] ${msg}\n` + (div.textContent || '');
}

function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(id));
}

function makePlaceholderResult() {
  return {
    hr_bpm: null, rmssd_ms: null, sdnn_ms: null, sd1_ms: null, sd2_ms: null,
    sqi: 0, snr_db: 0,
    ans_state: 'uncertain',
    roi_breakdown: null,
    source: 'placeholder',
  };
}

// ───────────────────────── engine init (lazy, on first user gesture) ─────────────────────────
async function ensureEngineReady() {
  if (state.engineInitOnce) return;
  state.engineInitOnce = true;
  try {
    if (!state.engine) state.engine = new BellSoundEngine();
    const { ok, missing } = await state.engine.init();
    if (els.assetBanner) {
      if (!ok) {
        els.assetBanner.hidden = false;
        const list = missing.slice(0, 3).join(', ') +
                     (missing.length > 3 ? ` 외 ${missing.length - 3}개` : '');
        els.assetBanner.textContent =
          `사운드 자산 누락: ${list} — setup_sounds.sh 실행 여부를 확인해주세요. 가용한 톤으로 자동 대체합니다.`;
      } else if (location.protocol !== 'file:') {
        els.assetBanner.hidden = true;
      }
    }
  } catch (e) {
    console.warn('[SleepThera] engine init failed:', e);
    if (els.assetBanner) {
      els.assetBanner.hidden = false;
      els.assetBanner.textContent = `오디오 엔진 초기화 실패: ${e.message}`;
    }
  }
}

// ───────────────────────── demo mode ─────────────────────────
function toggleDemoMode() {
  state.demoMode = !state.demoMode;
  if (els.demoPill) els.demoPill.hidden = !state.demoMode;
  if (els.btnStart) els.btnStart.textContent = state.demoMode ? '데모 측정 시작' : '측정 시작';
  toast(state.demoMode ? '데모 모드 활성화' : '데모 모드 해제');
}

function bindTripleClick() {
  if (!els.bellLogo) return;
  let clicks = []; const WINDOW_MS = 800;
  els.bellLogo.style.cursor = 'pointer';
  els.bellLogo.addEventListener('click', () => {
    const now = performance.now();
    clicks = clicks.filter((t) => now - t < WINDOW_MS);
    clicks.push(now);
    if (clicks.length >= 3) { clicks = []; toggleDemoMode(); }
  });
}

function nextDemoState() {
  const key = 'st_demo_run';
  let n = parseInt(localStorage.getItem(key) || '0', 10);
  const target = DEMO_CYCLE[n % DEMO_CYCLE.length];
  localStorage.setItem(key, String((n + 1) % DEMO_CYCLE.length));
  return target;
}

function buildDemoRgb(targetState) {
  const fs = 30, duration = CAPTURE_SECONDS, n = Math.round(fs * duration);
  // Deterministic per-state PRNG.
  let seed = 0xBE11; for (const ch of targetState) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  function rand() {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function gauss() {
    const u = Math.max(rand(), 1e-9), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const baseDC = [180, 140, 130];   // realistic skin DC (R>G>B)

  // Uncertain: pure noise — backend SQI tanks → ans=uncertain.
  if (targetState === 'uncertain') {
    const rgb = new Array(n);
    for (let i = 0; i < n; i++) {
      rgb[i] = [baseDC[0] + gauss() * 3.5,
                baseDC[1] + gauss() * 3.5,
                baseDC[2] + gauss() * 3.5];
    }
    return { rgb, fs };
  }

  // Tuned for the Phase-5 absolute-threshold ANS rules:
  //   sympathetic_dominant : HR > 85, RMSSD < 25
  //   vagal_dominant       : HR < 65, RMSSD > 50
  //   balanced             : middle
  //   low_arousal          : HR < 55
  const params = {
    balanced:             { mean_ibi: 857,  sd_ibi: 38 },   // ~70 bpm
    vagal_dominant:       { mean_ibi: 1050, sd_ibi: 75 },   // ~57 bpm, high SD
    sympathetic_dominant: { mean_ibi: 632,  sd_ibi: 12 },   // ~95 bpm, low SD
    low_arousal:          { mean_ibi: 1200, sd_ibi: 20 },   // ~50 bpm
  }[targetState] || { mean_ibi: 857, sd_ibi: 38 };

  // Phase-modulated sinusoid is much friendlier to POS+Welch than gaussian
  // pulse trains — we synthesize a smooth pulse at the target HR with IBI
  // variability injected via slow phase drift.
  const pulses = [];
  let t = 250;
  while (t < duration * 1000) {
    pulses.push(t);
    t += Math.max(300, Math.min(2000, params.mean_ibi + gauss() * params.sd_ibi));
  }
  const sigmaSec = 0.08;
  const rgb = new Array(n);
  const ampG = 1.2;                 // green: strongest pulse
  const ampR = 0.4, ampB = 0.3;
  for (let i = 0; i < n; i++) {
    const tSec = i / fs;
    let pulse = 0;
    for (const p of pulses) {
      const dt = tSec - p / 1000;
      if (Math.abs(dt) < 4 * sigmaSec) {
        pulse += Math.exp(-0.5 * (dt / sigmaSec) ** 2);
      }
    }
    // Add slow respiratory drift (small) + noise.
    const drift = 0.3 * Math.sin(2 * Math.PI * 0.15 * tSec);
    rgb[i] = [
      baseDC[0] + ampR * pulse + drift + gauss() * 0.4,
      baseDC[1] + ampG * pulse + drift + gauss() * 0.4,
      baseDC[2] + ampB * pulse + drift + gauss() * 0.4,
    ];
  }
  return { rgb, fs };
}

// ───────────────────────── capture flow ─────────────────────────
async function onStartClicked() {
  console.info('[SleepThera] onStartClicked fired (demoMode=' + state.demoMode + ')');
  traceLog('start clicked');
  clearError();
  if (els.btnStart) els.btnStart.disabled = true;
  try {
    // Audio engine is best-effort — failure here must NOT block measurement.
    // Swallow its rejection so it can't surface as an unhandledrejection
    // (which would then look like a generic "Script error." on iOS Safari).
    try {
      ensureEngineReady().catch((e) =>
        showInlineError('[engine async] ' + _safeStr(e)));
    } catch (e) {
      showInlineError('[engine sync] ' + _safeStr(e));
    }
    if (state.demoMode) { runDemoCapture(); return; }

    traceLog('openCamera...');
    const ok = await openCamera();
    traceLog('openCamera returned ' + ok);
    if (!ok) { els.btnStart && (els.btnStart.disabled = false); return; }

    traceLog('ensureFaceMesh...');
    if (!ensureFaceMesh()) {
      stopStream();
      els.btnStart && (els.btnStart.disabled = false);
      return;
    }
    traceLog('faceMesh OK');

    // Reset for a fresh run.
    state.samples = [];
    state.samplesByROI = { forehead: [], l_cheek: [], r_cheek: [] };
    state.lastBoxes = null;
    state.cancelled = false;
    state.liveHrEMA = null;
    state.lastSqi = 0;
    state.lastFaceMs = performance.now();
    state.bvpForSpark = null;
    show(els.captureScreen);
    setRingProgress(0);
    els.hrRing && (els.hrRing.textContent = '—');
    els.sqiPct && (els.sqiPct.textContent = '—');
    els.countdown && (els.countdown.textContent = CAPTURE_SECONDS.toFixed(0));
    enterPreflightPhase();
    startCameraLoop();
    pollPreflight();
    traceLog('capture loop running');
  } catch (e) {
    console.error('[SleepThera] onStartClicked threw:', e);
    showInlineError('[onStart caught] ' + _safeStr(e));
    if (els.btnStart) els.btnStart.disabled = false;
  }
}

// ─── Phase 6 helpers (capture flow plumbing) ────────────────────
async function openCamera() {
  if (!navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function') {
    showError('이 브라우저에서는 카메라 접근이 차단되어 있습니다. ' +
              'http://localhost:8000/frontend/ 에서 열어주세요.');
    return false;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 },
               frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    console.error('[openCamera] getUserMedia rejected:', e);
    showError('카메라 접근이 거부되었어요: ' + (e?.message || e));
    return false;
  }
  if (!els.video) { showError('비디오 엘리먼트가 없습니다.'); return false; }
  els.video.srcObject = state.stream;
  // Don't await play() — some browsers never fire 'canplay' until the element
  // is visible. Fire and forget; capture loop is tolerant of readyState<2.
  els.video.play().catch((e) => console.warn('[openCamera] play() failed:', e));
  return true;
}

function ensureFaceMesh() {
  if (typeof FaceMesh === 'undefined') {
    showError('얼굴 인식 모듈(MediaPipe FaceMesh)을 불러올 수 없습니다. 네트워크를 확인해주세요.');
    return false;
  }
  if (state.faceMesh) return true;
  state.faceMesh = new FaceMesh({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
  });
  state.faceMesh.setOptions({
    maxNumFaces: 1, refineLandmarks: false,
    minDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  state.faceMesh.onResults(onFaceResults);
  return true;
}

function showCaptureChrome(visible) {
  if (els.captureSidebar) els.captureSidebar.hidden = !visible;
  if (els.tracePanel)     els.tracePanel.hidden     = !visible;
}
function showPreflightPanel(visible) {
  if (els.preflightPanel) els.preflightPanel.hidden = !visible;
}

function renderPreflightChecksPlaceholder() {
  if (!els.preflightChecks) return;
  const labels = ['프레임 속도', '얼굴 밝기', '조명 균일도', '역광 여부', '머리 안정성'];
  els.preflightChecks.innerHTML = labels.map((l) =>
    `<li data-state="pending"><span class="check-icon"></span>` +
    `<span class="check-label">${l}</span>` +
    `<span class="check-value">측정 중…</span></li>`).join('');
}

function renderPreflightResult(r) {
  if (!els.preflightChecks) return;
  els.preflightChecks.innerHTML = r.checks.map((c) => `
    <li data-state="${c.pass ? 'pass' : 'fail'}">
      <span class="check-icon"></span>
      <span class="check-label">${c.label}</span>
      <span class="check-value">${c.value}</span>
      ${!c.pass ? `<span class="check-hint">${c.hint}</span>` : ''}
    </li>`).join('');
}

function enterPreflightPhase() {
  state.phase = 'preflight';
  state.preflight = new Preflight(PREFLIGHT_MS);
  state.preflight.start();
  if (els.preflightRetryRow) els.preflightRetryRow.hidden = true;
  renderPreflightChecksPlaceholder();
  showPreflightPanel(true);
  showCaptureChrome(false);
}

function pollPreflight() {
  if (state.cancelled || state.phase !== 'preflight') return;
  if (state.preflight && state.preflight.done) {
    const r = state.preflight.result;
    renderPreflightResult(r);
    if (r.allPass) {
      setTimeout(() => transitionToCapture(), 600);
    } else if (els.preflightRetryRow) {
      els.preflightRetryRow.hidden = false;
    }
    return;
  }
  requestAnimationFrame(pollPreflight);
}

function transitionToCapture() {
  if (state.cancelled) return;
  showPreflightPanel(false);
  showCaptureChrome(true);
  enterCaptureScreen();
}

function startCameraLoop() {
  if (state.rafCapture) return;
  const tick = async () => {
    if (state.cancelled || state.phase === 'idle') {
      state.rafCapture = null;
      return;
    }
    if (state.faceMesh && els.video && els.video.readyState >= 2) {
      try { await state.faceMesh.send({ image: els.video }); } catch (_) {}
    }
    if (state.phase === 'capturing') updateCaptureCountdown();
    if (state.lastFaceBox &&
        performance.now() - state.lastFaceMs > FACE_LOST_RETICLE_LOST_MS) {
      drawROIOverlay(state.lastBoxes || {}, null, /*lost=*/true);
    }
    state.rafCapture = requestAnimationFrame(tick);
  };
  state.rafCapture = requestAnimationFrame(tick);
}

function updateCaptureCountdown() {
  const now = performance.now();
  const elapsed = now - state.captureStartMs;
  const remaining = CAPTURE_SECONDS - elapsed / 1000;
  if (els.countdown) els.countdown.textContent = Math.max(0, remaining).toFixed(1);
  const sinceFace = now - state.lastFaceMs;
  if (sinceFace > FACE_LOST_HINT_MS) {
    els.faceHint && els.faceHint.classList.add('visible');
    if (sinceFace > FACE_LOST_ABORT_MS) {
      // Automatic abort during capture: stay on result screen (placeholder),
      // never bounce to intro silently.
      endCaptureWithError('얼굴이 화면 안에서 너무 오래 사라져 측정을 종료했습니다.');
      return;
    }
  } else {
    els.faceHint && els.faceHint.classList.remove('visible');
  }
  if (remaining <= 0) finalizeCapture();
}

function enterCaptureScreen() {
  // Reset sample buffers so the 45 s window doesn't include preflight frames.
  state.samples = [];
  state.samplesByROI = { forehead: [], l_cheek: [], r_cheek: [] };
  state.captureStartMs = performance.now();
  state.cancelled = false;
  state.liveHrEMA = null;
  state.lastSqi = 0;
  els.faceHint && els.faceHint.classList.remove('visible');
  setRingProgress(0);
  els.hrRing && (els.hrRing.textContent = '—');
  els.sqiPct && (els.sqiPct.textContent = '—');
  els.countdown && (els.countdown.textContent = CAPTURE_SECONDS.toFixed(0));
  state.phase = 'capturing';

  state.liveRppg = new LiveRPPG();
  if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
  state.liveTimer = setInterval(runLiveEstimate, 500);

  if (state.trace) state.trace.stop();
  state.trace = new HRVTrace(els.hrvCanvas, { bpmDisplayEl: els.bpmValue });
  state.trace.setMode('preview');
  if (els.traceModeBadge) {
    els.traceModeBadge.dataset.mode = 'preview';
    els.traceModeBadge.textContent = 'preview';
  }
  state.trace.start();
}

function runLiveEstimate() {
  if (state.cancelled || !state.liveRppg) return;
  const { hr, snrDb, bvp } = state.liveRppg.estimate(8);
  if (state.trace && bvp && bvp.length) state.trace.setBVP(bvp);
  if (hr != null && snrDb > 3) {
    state.liveHrEMA = state.liveHrEMA == null ? hr : 0.7 * state.liveHrEMA + 0.3 * hr;
    if (state.trace) state.trace.setBPM(state.liveHrEMA);
    els.hrRing.textContent = state.liveHrEMA.toFixed(0);
    if (state.lastSqi >= SQI_LIVE_THRESHOLD) {
      if (state.trace) state.trace.setMode('live');
      if (els.traceModeBadge.dataset.mode !== 'live') {
        els.traceModeBadge.dataset.mode = 'live';
        els.traceModeBadge.textContent = 'live';
      }
    }
  } else if (state.liveHrEMA == null) {
    els.hrRing.textContent = '—';
  }
}

function extractROIMean(lm, idxs, w, h, ctx) {
  const xs = idxs.map((i) => lm[i].x * w);
  const ys = idxs.map((i) => lm[i].y * h);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h, Math.ceil(Math.max(...ys)));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 6 || rh < 6) return null;
  els.roiCanvas.width = rw; els.roiCanvas.height = rh;
  ctx.drawImage(els.video, x0, y0, rw, rh, 0, 0, rw, rh);
  const data = ctx.getImageData(0, 0, rw, rh).data;
  let sr = 0, sg = 0, sb = 0, np = 0;
  for (let i = 0; i < data.length; i += 4) {
    sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; np++;
  }
  if (!np) return null;
  return { r: sr / np, g: sg / np, b: sb / np, box: { x0, y0, rw, rh } };
}

function computeFaceBBox(boxes, w, h) {
  const all = Object.values(boxes);
  if (!all.length) return null;
  const x0 = Math.min(...all.map((b) => b.x0));
  const y0 = Math.min(...all.map((b) => b.y0));
  const x1 = Math.max(...all.map((b) => b.x0 + b.rw));
  const y1 = Math.max(...all.map((b) => b.y0 + b.rh));
  return { x0, y0, rw: x1 - x0, rh: y1 - y0, w, h };
}

function onFaceResults(results) {
  const lm = results.multiFaceLandmarks && results.multiFaceLandmarks[0];
  if (!lm) return;
  state.lastFaceMs = performance.now();
  const w = els.video.videoWidth || 640;
  const h = els.video.videoHeight || 480;
  const ctx = els.roiCanvas.getContext('2d', { willReadFrequently: true });

  const samples = {};
  const boxes = {};
  for (const def of ROI_DEFS) {
    const out = extractROIMean(lm, def.idx, w, h, ctx);
    if (!out) continue;
    samples[def.key] = out;
    boxes[def.key] = out.box;
  }
  if (!Object.keys(samples).length) return;

  const t = state.lastFaceMs;
  for (const def of ROI_DEFS) {
    const s = samples[def.key];
    if (!s) continue;
    state.samplesByROI[def.key].push([s.r, s.g, s.b, t]);
    if (state.liveRppg) state.liveRppg.push(def.key, s.r, s.g, s.b, t);
  }
  state.lastBoxes = boxes;
  state.lastFaceBox = computeFaceBBox(boxes, w, h);

  // Phase 6 preflight tap-off (only during the 3 s warm-up).
  if (state.phase === 'preflight' && state.preflight && !state.preflight.done) {
    state.preflight.observe(boxes, w, h, els.video, t);
  }

  const quality = state.liveRppg ? state.liveRppg.getPerROIQuality() : null;
  drawROIOverlay(boxes, quality, /*lost=*/false);
  if (state.phase === 'capturing') updateSqiRingLive();
}

function drawROIOverlay(boxes, quality, lost) {
  const ov = els.faceOverlay;
  if (!ov) return;
  const w = els.video?.videoWidth || 640;
  const h = els.video?.videoHeight || 480;
  if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const pulse = 0.6 + 0.2 * Math.sin(performance.now() / 400);
  const css = (name, fallback) => getCSS(name) || fallback;

  for (const def of ROI_DEFS) {
    const b = boxes[def.key];
    if (!b) continue;
    const q = quality ? (quality[def.key] || 0) : 0.5;
    let color;
    if (lost) color = css('--st-warning', '#E89D40');
    else if (quality == null) color = css('--st-primary-soft', '#6B8AE8');
    else if (q > 0.6) color = css('--st-success', '#3FB89A');
    else if (q > 0.3) color = css('--st-primary-soft', '#6B8AE8');
    else              color = css('--st-warning', '#E89D40');

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.globalAlpha = lost ? 0.7 : pulse;

    const len = Math.min(b.rw, b.rh) * 0.28;
    const corners = [
      [b.x0,         b.y0,         +1, +1],
      [b.x0 + b.rw,  b.y0,         -1, +1],
      [b.x0,         b.y0 + b.rh,  +1, -1],
      [b.x0 + b.rw,  b.y0 + b.rh,  -1, -1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + dy * len);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dx * len, cy);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    const fontPx = Math.max(10, Math.round(b.rh * 0.16));
    ctx.font = `${fontPx}px "Pretendard Variable", sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(ROI_LABELS[def.key] || def.key, b.x0 + 4, Math.max(fontPx + 2, b.y0 - 6));

    if (quality) {
      const barW = Math.min(40, b.rw * 0.45);
      const barX = b.x0 + b.rw - barW - 2;
      const barY = Math.max(2, b.y0 - 10);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fillRect(barX, barY, barW, 3);
      ctx.fillStyle = color;
      ctx.fillRect(barX, barY, barW * q, 3);
    }
  }
}

function updateLiveHr() {
  if (state.samples.length < 60) return;
  const last = state.samples.slice(-Math.min(state.samples.length, 240));
  const ts = last.map((x) => x[3] / 1000);
  const gs = last.map((x) => x[1]);
  const mean = gs.reduce((a, c) => a + c, 0) / gs.length;
  const centred = gs.map((v) => v - mean);
  let zc = 0;
  for (let i = 1; i < centred.length; i++) {
    if ((centred[i - 1] >= 0) !== (centred[i] >= 0)) zc++;
  }
  const span = ts[ts.length - 1] - ts[0];
  if (span <= 0) return;
  const bpm = (zc / (2 * span)) * 60;
  if (bpm < 40 || bpm > 200) return;
  state.liveHrEMA = state.liveHrEMA == null ? bpm : 0.7 * state.liveHrEMA + 0.3 * bpm;
  els.hrRing.textContent = state.liveHrEMA.toFixed(0);
  if (state.trace) {
    state.trace.setBPM(state.liveHrEMA);
    // Live mode once we have a stable estimate + SQI is reasonable.
    if (state.lastSqi >= SQI_LIVE_THRESHOLD) {
      state.trace.setMode('live');
      if (els.traceModeBadge.dataset.mode !== 'live') {
        els.traceModeBadge.dataset.mode = 'live';
        els.traceModeBadge.textContent = 'live';
      }
    }
  }
}

function updateSqiRingLive() {
  // Live SQI proxy: blend face-presence with rPPG live SNR (when available).
  const ago = performance.now() - state.lastFaceMs;
  const faceQ = Math.max(0, 1 - ago / 1500);
  const elapsed = (performance.now() - state.captureStartMs) / 1000;
  const ramp = Math.min(1, elapsed / 8);
  let snrQ = 0;
  if (state.liveRppg && state.liveRppg.lastSNR) {
    snrQ = Math.max(0, Math.min(1, state.liveRppg.lastSNR / 10));
  }
  const sqi = Math.min(0.95, 0.4 * faceQ + 0.3 * ramp + 0.3 * snrQ);
  state.lastSqi = 0.7 * state.lastSqi + 0.3 * sqi;
  setRingProgress(state.lastSqi);
}

function setRingProgress(ratio01) {
  const r = Math.max(0, Math.min(1, ratio01));
  const off = SQI_RING_CIRC * (1 - r);
  els.ringFg.setAttribute('stroke-dashoffset', off.toFixed(2));
  let color;
  if (r < 0.4) color = getCSS('--st-danger');
  else if (r < 0.6) color = getCSS('--st-warning');
  else color = getCSS('--st-success');
  els.ringFg.style.stroke = color;
  els.sqiPct.textContent = `${Math.round(r * 100)}%`;
}

function stopStream() {
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
}

function cleanupCaptureResources() {
  try {
    if (state.rafCapture) cancelAnimationFrame(state.rafCapture);
    state.rafCapture = null;
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
    if (state.trace && state.trace.stop) state.trace.stop();
    stopStream();
    if (els.video) els.video.srcObject = null;
  } catch (e) { console.error('[cleanup] err', e); }
}

// User-initiated cancel only: explicit return to intro is fine here.
function abortCapture(msg) {
  state.cancelled = true;
  state.phase = 'idle';
  cleanupCaptureResources();
  showPreflightPanel(false);
  showCaptureChrome(false);
  toast(msg || '측정을 중단했어요.');
  show(els.introScreen);
  if (els.btnStart) els.btnStart.disabled = false;
}

// Automatic failure during capture (face lost, etc.): show result placeholder
// with an inline error. Never bounces back to intro on its own — per the iOS
// hotfix policy, only explicit user buttons may return to the intro screen.
function endCaptureWithError(msg) {
  state.cancelled = true;
  state.phase = 'idle';
  cleanupCaptureResources();
  showPreflightPanel(false);
  showCaptureChrome(false);
  show(els.resultScreen);
  try { renderResult(makePlaceholderResult()); }
  catch (e) { console.error('[endCapture] render err', e); }
  showInlineError(msg);
  if (els.btnStart) els.btnStart.disabled = false;
}

// iOS Safari hotfix rewrite: ALWAYS show the result screen first so the user
// gets immediate "끝났구나" feedback, then compute. Any failure stage keeps
// the user on the result screen with an inline error — never bounces to intro.
async function finalizeCapture() {
  if (state.phase !== 'capturing') return;
  state.phase = 'idle';
  state.cancelled = true;

  // 1. Release camera/timers/raf first — relieve iOS Safari memory pressure
  //    before we do any heavier computation.
  cleanupCaptureResources();

  // 2. Show result screen immediately. Whatever happens next, we stay here.
  show(els.resultScreen);

  // 3. Compute. In-browser estimate is the source of truth; backend, if
  //    reachable, only enriches it. Either step can fail without unwinding.
  let result = null;
  try {
    if (state.liveRppg) {
      const live = state.liveRppg.estimate(CAPTURE_SECONDS);
      if (state.liveRppg.lastCombinedBvp && state.liveRppg.lastCombinedBvp.length) {
        state.bvpForSpark = state.liveRppg.lastCombinedBvp;
      }
      result = {
        hr_bpm: live.hr,
        sqi: clamp((live.snrDb || 0) / 12, 0, 1),
        snr_db: live.snrDb,
        rmssd_ms: null, sdnn_ms: null, sd1_ms: null, sd2_ms: null,
        ans_state: 'uncertain',
        roi_breakdown: null,
        source: 'in-browser',
      };
    }

    const payload = buildMultiROIPayload();
    if (payload && API_BASE) {
      try {
        const resp = await fetchWithTimeout(
          `${API_BASE}/api/process`,
          { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload) },
          5000,
        );
        if (resp.ok) {
          const backendResult = await resp.json();
          result = { ...(result || {}), ...backendResult, source: 'backend' };
        } else {
          console.warn('[finalize] backend HTTP', resp.status);
        }
      } catch (e) {
        // Network error or 5s timeout — fall through with in-browser values.
        console.warn('[finalize] backend unreachable, using in-browser values', e);
      }
    }
  } catch (e) {
    console.error('[finalize] compute err', e);
    showInlineError('계산 중 오류: ' + (e.message || e));
  }

  // 4. Render — placeholder if nothing usable. renderResult is also wrapped
  //    in its own try so an exception inside the render path can't unwind.
  try {
    renderResult(result || makePlaceholderResult());
  } catch (e) {
    console.error('[finalize] render err', e);
    showInlineError('결과 표시 중 오류: ' + (e.message || e));
  }

  // 5. Memory release — drop the large RGB sample buffers now that we're
  //    done with them. iOS Safari kills tabs that hold too much.
  state.samples = [];
  state.samplesByROI = { forehead: [], l_cheek: [], r_cheek: [] };
  if (state.liveRppg && state.liveRppg.samples) {
    state.liveRppg.samples = { forehead: [], l_cheek: [], r_cheek: [] };
  }

  if (els.btnStart) els.btnStart.disabled = false;
}

function buildMultiROIPayload() {
  const counts = {};
  let maxN = 0, anyKey = null;
  for (const k of Object.keys(state.samplesByROI)) {
    counts[k] = state.samplesByROI[k].length;
    if (counts[k] > maxN) { maxN = counts[k]; anyKey = k; }
  }
  if (maxN < 30 || !anyKey) return null;
  const ref = state.samplesByROI[anyKey];
  const t0 = ref[0][3], tEnd = ref[ref.length - 1][3];
  const fps = (ref.length - 1) / ((tEnd - t0) / 1000);
  const rgb_per_roi = {};
  for (const k of Object.keys(state.samplesByROI)) {
    if (counts[k] >= 30) {
      rgb_per_roi[k] = state.samplesByROI[k].map((s) => [s[0], s[1], s[2]]);
    }
  }
  return { rgb_per_roi, fps };
}

// Demo mode still uses postProcess (it never has live rPPG data to fall back
// on). On failure, paint a placeholder rather than bouncing to intro.
async function postProcess(payload) {
  if (!API_BASE) {
    // Hosted build with no backend — demo can't actually compute, just show
    // a placeholder so the UI still leads somewhere.
    show(els.resultScreen);
    try { renderResult(makePlaceholderResult()); } catch {}
    showInlineError('데모 모드는 백엔드가 필요합니다 (현재 정적 배포 — 일반 측정만 가능).');
    if (els.btnStart) els.btnStart.disabled = false;
    return;
  }
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/api/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 5000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    show(els.resultScreen);
    try { renderResult(result); }
    catch (e) { showInlineError('결과 표시 중 오류: ' + (e.message || e)); }
  } catch (e) {
    show(els.resultScreen);
    try { renderResult(makePlaceholderResult()); } catch {}
    showInlineError(`서버 오류: ${e.message || e}`);
  } finally {
    if (els.btnStart) els.btnStart.disabled = false;
  }
}

function renderResult(r) {
  // Belt-and-braces: the result screen must come up even if a downstream
  // setter throws on a missing element or unexpected field shape.
  try {
    show(els.resultScreen);
    // Demo mode: paint over weak SQI so executives never see the warning chip.
    if (state.demoMode) r = { ...r, sqi: Math.max(r.sqi || 0, 0.85) };

    if (els.mHr)    els.mHr.textContent    = fmt(r.hr_bpm, 1);
    if (els.mRmssd) els.mRmssd.textContent = fmt(r.rmssd_ms, 1);
    if (els.mSdnn)  els.mSdnn.textContent  = fmt(r.sdnn_ms, 1);
    if (els.mSd1)   els.mSd1.textContent   = fmt(r.sd1_ms, 1);
    if (els.mSd2)   els.mSd2.textContent   = fmt(r.sd2_ms, 1);
    if (els.mSqi)   els.mSqi.textContent   = fmt(r.sqi, 2);

    // Phase 5 — low-quality warning chip in the 0.35–0.55 window.
    const qChip = document.getElementById('quality-chip');
    if (qChip) {
      const sqi = r.sqi || 0;
      if (sqi >= 0.35 && sqi < 0.55) {
        qChip.hidden = false;
        qChip.textContent = `신호 품질 낮음 (SQI ${(sqi * 100).toFixed(0)}%) — 결과는 참고용`;
      } else {
        qChip.hidden = true;
      }
    }

    const kor = ANS_KOREAN[r.ans_state] || ANS_KOREAN.uncertain;
    const color = ansColor(r.ans_state || 'uncertain');
    if (els.ansLabel) els.ansLabel.textContent = kor.title;
    if (els.ansBadge) els.ansBadge.style.color = color;
    if (els.ansInterpretation) els.ansInterpretation.textContent = kor.interp;

    const hrZ = r.hr_z != null ? r.hr_z : 0;
    const rmssdZ = r.rmssd_z != null ? r.rmssd_z : 0;
    const xNorm = clamp(rmssdZ * 0.4, -1, 1);
    const yNorm = clamp(hrZ * 0.4, -1, 1);
    const targetX = 140 + xNorm * 110;
    const targetY = 140 - yNorm * 110;
    if (els.gaugePoint) animateGaugePoint(targetX, targetY, color);

    // Rationale: show always in demo mode, otherwise only if SQI is decent.
    const showRationale = state.demoMode || (r.sqi || 0) >= 0.6;
    if (showRationale && els.rationale) {
      els.rationale.hidden = false;
      if (els.rHr)    els.rHr.textContent    = fmt(r.hr_bpm, 0);
      if (els.rRmssd) els.rRmssd.textContent = fmt(r.rmssd_ms, 0);
      if (els.rAnsLabel) els.rAnsLabel.textContent = kor.title;
      if (els.rAnsBadge) els.rAnsBadge.style.color = color;
      if (els.rRationale) els.rRationale.textContent = kor.rationale;
      const cfg = ANS_TO_SOUND[r.ans_state] || ANS_TO_SOUND.uncertain;
      if (els.rProfile)  els.rProfile.textContent  = cfg.label_ko;
      if (els.rTempo)    els.rTempo.textContent    = cfg.breath_rate_bpm;
      if (els.rCarrier)  els.rCarrier.textContent  = Math.round(cfg.filter_hz);
      if (els.rBinaural) els.rBinaural.textContent = Math.round(cfg.reverb_amount * 100);
      if (els.rSpark)    drawSparkline(state.bvpForSpark || dummyBvp());
    }

    renderROIBreakdown(r.roi_breakdown);

    // SQI fallback gate. Demo mode never blocks playback.
    if (els.fallback && els.btnSound) {
      if (state.demoMode) {
        els.fallback.hidden = true;
        els.btnSound.disabled = false;
      } else {
        const okSqi = (r.sqi || 0) >= 0.6;
        els.fallback.hidden = okSqi;
        els.btnSound.disabled = !okSqi;
      }
    }

    window.__bellResult = r;
  } catch (e) {
    console.error('[render] err', e);
    showInlineError('렌더 오류: ' + (e.message || e));
    // Keep the result screen up — never bounce to intro.
  }
}

function renderROIBreakdown(rb) {
  if (!els.roiBreakdown || !els.roiBreakdownBody) return;
  if (!rb || !Object.keys(rb).length) {
    els.roiBreakdown.hidden = true;
    els.roiBreakdownBody.innerHTML = '';
    return;
  }
  els.roiBreakdown.hidden = false;
  els.roiBreakdownBody.innerHTML = Object.entries(rb).map(([k, v]) => `
    <div class="roi-cell">
      <span class="roi-label">${ROI_LABELS[k] || k}</span>
      <span class="roi-snr">${(v.snr_db ?? 0).toFixed(1)} dB</span>
      <div class="roi-weight-bar"><div style="width:${((v.weight ?? 0) * 100).toFixed(0)}%"></div></div>
    </div>`).join('');
}

function dummyBvp() {
  const n = 200;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * i / 25) + (Math.random() - 0.5) * 0.2;
  return out;
}

function animateGaugePoint(tx, ty, color) {
  const pt = els.gaugePoint;
  pt.setAttribute('fill', color);
  pt.setAttribute('opacity', '0');
  pt.setAttribute('cx', '140'); pt.setAttribute('cy', '140');
  const t0 = performance.now(); const dur = 1200;
  function step(now) {
    const k = Math.min(1, (now - t0) / dur);
    const ease = 1 - Math.pow(1 - k, 3);
    const cx = 140 + (tx - 140) * ease;
    const cy = 140 + (ty - 140) * ease;
    pt.setAttribute('cx', cx.toFixed(2));
    pt.setAttribute('cy', cy.toFixed(2));
    pt.setAttribute('opacity', String(0.2 + 0.8 * ease));
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function drawSparkline(buf) {
  const c = els.rSpark;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  let mn = Infinity, mx = -Infinity;
  for (const v of buf) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = Math.max(mx - mn, 0.01);
  ctx.strokeStyle = getCSS('--st-primary-soft');
  ctx.lineWidth = 1.2; ctx.beginPath();
  for (let i = 0; i < buf.length; i++) {
    const x = (i / (buf.length - 1)) * w;
    const v = (buf[i] - mn) / span;
    const y = h - v * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ───────────────────────── demo capture ─────────────────────────
function runDemoCapture() {
  const target = nextDemoState();
  // Demo bypasses preflight: show capture screen with chrome visible directly.
  show(els.captureScreen);
  showPreflightPanel(false);
  showCaptureChrome(true);
  enterCaptureScreen();
  state.lastFaceMs = performance.now();
  const { rgb, fs } = buildDemoRgb(target);
  state.samples = rgb.map((c, i) => [c[0], c[1], c[2],
                                      state.captureStartMs + (i / fs) * 1000]);
  const totalMs = CAPTURE_SECONDS * 1000;
  const t0 = state.captureStartMs;
  const fakeHr = ({
    balanced: 70, vagal_dominant: 60, sympathetic_dominant: 90,
    low_arousal: 55, uncertain: 72,
  })[target] || 70;
  // 'uncertain' demo stays in preview mode (signal genuinely poor).
  const willGoLive = target !== 'uncertain';
  function tick() {
    const elapsed = performance.now() - t0;
    const remaining = CAPTURE_SECONDS - elapsed / 1000;
    els.countdown.textContent = Math.max(0, remaining).toFixed(1);
    // SQI ramp
    const ramp = Math.min(1, elapsed / 10000);
    state.lastSqi = ramp * (target === 'uncertain' ? 0.35 : 0.85);
    setRingProgress(state.lastSqi);
    const wobble = Math.sin(elapsed / 700) * 2;
    const shown = (fakeHr + wobble).toFixed(0);
    els.hrRing.textContent = shown;
    if (state.trace) {
      state.trace.setBPM(fakeHr + wobble);
      if (willGoLive && state.lastSqi >= SQI_LIVE_THRESHOLD &&
          els.traceModeBadge.dataset.mode !== 'live') {
        state.trace.setMode('live');
        els.traceModeBadge.dataset.mode = 'live';
        els.traceModeBadge.textContent = 'live';
      }
    }
    if (elapsed >= totalMs) {
      if (state.trace) state.trace.stop();
      postProcess({ rgb: rgb.map((c) => [c[0], c[1], c[2]]), fps: fs });
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ───────────────────────── sound playback ─────────────────────────
async function onSoundClicked() {
  const r = window.__bellResult; if (!r) return;
  show(els.soundScreen);
  els.btnSound.disabled = true;
  const ansState = r.ans_state || 'uncertain';
  const kor = ANS_KOREAN[ansState] || ANS_KOREAN.uncertain;
  const cfg = ANS_TO_SOUND[ansState] || ANS_TO_SOUND.uncertain;
  els.soundStateLabel.textContent = kor.title;
  els.soundProfileName.textContent = cfg.rationale;
  els.feedbackRow.hidden = true;
  els.btnFinish.hidden = true;
  els.breathingText.textContent = '시작합니다';
  state.soundTimerStart = performance.now();

  try {
    await state.engine.playForState(ansState, {
      bpmHint: 6,
      onMissing: ({ requested, used }) => {
        toast(used ? `사운드 대체: ${requested} → ${used}` : `사운드 누락: ${requested}`);
      },
      onBreath: ({ phase }) => {
        const inhale = phase === 'inhale';
        els.breathingOrb.classList.toggle('peak', inhale);
        els.breathingText.textContent = inhale ? '들이쉬세요' : '내쉬세요';
      },
    });
  } catch (e) {
    console.error(e);
    toast(`사운드 오류: ${e.message}`);
    els.btnSound.disabled = false;
    return;
  }

  // Drive audio-vis + 60s countdown via rAF.
  startSoundFrameLoop();
}

const PLAY_DURATION_S = 60;
function startSoundFrameLoop() {
  cancelAnimationFrame(state.soundRaf);
  function frame() {
    const elapsed = (performance.now() - state.soundTimerStart) / 1000;
    const remaining = Math.max(0, PLAY_DURATION_S - elapsed);
    const mm = Math.floor(remaining / 60).toString().padStart(2, '0');
    const ss = Math.floor(remaining % 60).toString().padStart(2, '0');
    els.soundTimer.textContent = `${mm}:${ss}`;
    const data = state.engine.getAnalyserData();
    if (data) drawAudioVis(data);
    if (remaining <= 0) {
      finishSoundPlayback();
      return;
    }
    state.soundRaf = requestAnimationFrame(frame);
  }
  state.soundRaf = requestAnimationFrame(frame);
}

function finishSoundPlayback() {
  cancelAnimationFrame(state.soundRaf);
  state.engine.stop({ fadeMs: 1200 });
  els.breathingOrb.classList.remove('peak');
  els.breathingText.textContent = '마쳤어요';
  els.feedbackRow.hidden = false;
  els.btnFinish.hidden = false;
}

function drawAudioVis(data) {
  const c = els.audioVis;
  if (!c.width) {
    c.width = c.clientWidth * (window.devicePixelRatio || 1);
    c.height = c.clientHeight * (window.devicePixelRatio || 1);
  }
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getCSS('--st-primary'); ctx.globalAlpha = 0.3;
  ctx.beginPath(); ctx.moveTo(0, h / 2);
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * w;
    const y = h / 2 + data[i] * (h / 2);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h / 2); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
}

// ───────────────────────── DOM init + event wiring ─────────────────────────
function initDom() {
  // Resolve every binding; warn-on-miss but don't throw.
  const missing = [];
  for (const [k, id] of Object.entries(ELS_BINDINGS)) {
    els[k] = document.getElementById(id);
    if (!els[k]) missing.push(`${k}#${id}`);
  }
  if (missing.length) {
    console.warn('[SleepThera] DOM lookup misses:', missing);
  }

  // Demo-mode triple-click on logo.
  bindTripleClick();

  // Fallback questionnaire selection.
  els.fallback?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-state]');
    if (!btn) return;
    const stateName = btn.dataset.state;
    const kor = ANS_KOREAN[stateName] || ANS_KOREAN.uncertain;
    window.__bellResult = { ...(window.__bellResult || {}), ans_state: stateName };
    if (els.ansLabel) els.ansLabel.textContent = kor.title;
    if (els.ansBadge) els.ansBadge.style.color = ansColor(stateName);
    if (els.fallback) els.fallback.hidden = true;
    if (els.btnSound) els.btnSound.disabled = false;
  });

  els.btnStart?.addEventListener('click', onStartClicked);
  els.btnCancel?.addEventListener('click', () => abortCapture('측정을 중단했어요.'));
  els.btnPreflightRetry?.addEventListener('click', () => {
    if (els.preflightRetryRow) els.preflightRetryRow.hidden = true;
    enterPreflightPhase();
    pollPreflight();
  });
  els.btnPreflightSkip?.addEventListener('click', () => {
    if (els.preflightRetryRow) els.preflightRetryRow.hidden = true;
    transitionToCapture();
  });
  els.btnRetry?.addEventListener('click', () => {
    show(els.introScreen);
    if (els.btnStart) els.btnStart.disabled = false;
  });
  els.btnSound?.addEventListener('click', onSoundClicked);
  els.btnFinish?.addEventListener('click', () => {
    show(els.introScreen);
    if (els.btnStart) els.btnStart.disabled = false;
  });
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.fb');
    if (!btn) return;
    document.querySelectorAll('.fb').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    toast('감사합니다');
    console.log('[feedback]', { state: window.__bellResult?.ans_state, fb: btn.dataset.fb });
  });

  console.info('[SleepThera] main.js v6.4-pages wired (' + Object.keys(ELS_BINDINGS).length +
               ' bindings, ' + missing.length + ' missing)');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDom, { once: true });
} else {
  // Module scripts are deferred so this path is the common case.
  initDom();
}
