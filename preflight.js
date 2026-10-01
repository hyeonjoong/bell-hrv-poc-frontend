/* Phase 6 — Pre-capture environmental quality gate.
 *
 * Watches the first 3 s of camera samples. Aggregates 5 checks:
 *   fps        ≥ 28      (HRV requires ≥30 fps; 28 allows minor jitter headroom)
 *   faceB      70–210    (typical AE under 100–500 lux task lighting)
 *   faceStd    ≤ 38      (uneven facial lighting)
 *   bg − faceB ≤ 60      (backlight — #1 office failure mode)
 *   jitter     ≤ 40 px/s (motion artifact)
 *
 * The observer is fed from onFaceResults during the preflight phase. The
 * canvas+ctx are passed in so we don't allocate per call; we draw a tiny
 * patch and read pixels.
 *
 * Frame rate (v6.5): minFps applies to the camera frame rate, counted from
 * the distinct camera frames main.js reports through noteCameraFrame (with
 * requestVideoFrameCallback presentedFrames when available). FaceMesh may
 * analyse fewer frames than the camera delivers; LiveRPPG resamples to
 * 30 Hz, and the rPPG tests show the HR stays within 2 bpm from 15 analysed
 * frames per second, so the analysis rate only has to reach minProcessedFps.
 * Without camera frame notes the analysis rate is used for both. Below
 * minHrFps (MIN_SOURCE_FPS in rppg_live.js) no HR is computed at all, and the
 * hint says so.
 *
 * Window: the 3 s window starts at the first analysed frame, and camera frame
 * notes from before it are ignored. A gap of more than maxGapMs between two
 * analysed frames (a slow first FaceMesh call while the model loads, a busy
 * main thread, a face lost for a while) starts the window again, at most
 * maxRestarts times per run, so the frame-rate check measures the device and
 * not a one-off stall. main.js also restarts it at the first FaceMesh result.
 */
export const PREFLIGHT_THRESHOLDS = {
  minFps: 28,
  minProcessedFps: 15,
  minHrFps: 7,
  faceBrightMin: 70,
  faceBrightMax: 210,
  faceSpatialStdMax: 38,
  bgFaceDeltaMax: 60,
  centroidJitterMax: 40,
};

export class Preflight {
  constructor(durationMs = 3000, { maxGapMs = 1000, maxRestarts = 3 } = {}) {
    this.durationMs = durationMs;
    this.maxGapMs = maxGapMs;
    this.maxRestarts = maxRestarts;
    this.startMs = null;
    this.frames = [];
    this.done = false;
    this.result = null;
    this.cameraFrames = [];
    this.restarts = 0;
    // Scratch canvases are created on first use (fixed sizes, never resized).
    this._faceCtx = null;
    this._bgCtx = null;
  }

  start() {
    this.startMs = null;
    this.frames = [];
    this.cameraFrames = [];
    this.restarts = 0;
    this.done = false;
    this.result = null;
  }

  /** One call per distinct camera frame (analysed or not). */
  noteCameraFrame(tMs, presentedFrames) {
    if (this.done || !Number.isFinite(tMs)) return;
    this.cameraFrames.push({ t: tMs, n: Number.isFinite(presentedFrames) ? presentedFrames : null });
  }

  _scratchCtx(size) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c.getContext('2d', { willReadFrequently: true });
  }

  /** Called from onFaceResults with the multi-ROI boxes. */
  observe(boxes, w, h, video, tMs) {
    if (this.done) return;
    const all = Object.values(boxes);
    if (!all.length) return;

    const fx0 = Math.min(...all.map((b) => b.x0));
    const fy0 = Math.min(...all.map((b) => b.y0));
    const fx1 = Math.max(...all.map((b) => b.x0 + b.rw));
    const fy1 = Math.max(...all.map((b) => b.y0 + b.rh));
    const fw = fx1 - fx0, fh = fy1 - fy0;
    if (fw < 20 || fh < 20) return;

    // Downsample face to 32×32 for luma stats — fast and stable.
    const FS = 32;
    if (!this._faceCtx) this._faceCtx = this._scratchCtx(FS);
    const ctx = this._faceCtx;
    ctx.drawImage(video, fx0, fy0, fw, fh, 0, 0, FS, FS);
    const fd = ctx.getImageData(0, 0, FS, FS).data;
    let fs1 = 0, fs2 = 0, fn = 0;
    for (let i = 0; i < fd.length; i += 4) {
      const Y = 0.299 * fd[i] + 0.587 * fd[i + 1] + 0.114 * fd[i + 2];
      fs1 += Y; fs2 += Y * Y; fn++;
    }
    const faceMean = fs1 / fn;
    const faceStd = Math.sqrt(Math.max(0, fs2 / fn - faceMean * faceMean));

    // Sample 4 corner patches outside the face bbox for backlight detection.
    const BP = 40;
    const corners = [
      [0, 0], [w - BP, 0],
      [0, h - BP], [w - BP, h - BP],
    ];
    if (!this._bgCtx) this._bgCtx = this._scratchCtx(BP);
    const bctx = this._bgCtx;
    let bgSum = 0, bgN = 0;
    for (const [bx, by] of corners) {
      bctx.drawImage(video, bx, by, BP, BP, 0, 0, BP, BP);
      const bd = bctx.getImageData(0, 0, BP, BP).data;
      for (let i = 0; i < bd.length; i += 4) {
        const Y = 0.299 * bd[i] + 0.587 * bd[i + 1] + 0.114 * bd[i + 2];
        bgSum += Y; bgN++;
      }
    }
    const bgMean = bgSum / bgN;

    const cx = fx0 + fw / 2;
    const cy = fy0 + fh / 2;
    this._record({ t: tMs, faceMean, faceStd, bgMean, cx, cy });
  }

  /** Adds one analysed frame's measurements (observe() without the pixel
   *  work; also used by the Node tests). Handles the window start, the
   *  restart after a gap and the end of the check. */
  _record(frame) {
    if (this.done || !Number.isFinite(frame.t)) return;
    const prev = this.frames[this.frames.length - 1];
    if (prev && frame.t - prev.t > this.maxGapMs && this.restarts < this.maxRestarts) {
      this.restarts++;
      this.frames = [];
      this.startMs = null;
    }
    if (this.startMs == null) {
      this.startMs = frame.t;
      this.cameraFrames = this.cameraFrames.filter((c) => c.t >= frame.t);
    }
    this.frames.push(frame);
    if (frame.t - this.startMs >= this.durationMs && this.frames.length >= 30) {
      this.done = true;
      this.result = this._evaluate();
    }
  }

  _evaluate() {
    const f = this.frames;
    const T = Math.max(0.001, (f[f.length - 1].t - f[0].t) / 1000);
    const processedFps = (f.length - 1) / T;
    const cameraFps = this._cameraFps() ?? processedFps;
    const fps = cameraFps;
    const avg = (sel) => f.reduce((s, x) => s + sel(x), 0) / f.length;
    const faceB = avg((x) => x.faceMean);
    const faceStd = avg((x) => x.faceStd);
    const bgB = avg((x) => x.bgMean);

    let jitter = 0;
    for (let i = 1; i < f.length; i++) {
      const dx = f[i].cx - f[i - 1].cx;
      const dy = f[i].cy - f[i - 1].cy;
      jitter += Math.sqrt(dx * dx + dy * dy);
    }
    jitter /= T;

    const t = PREFLIGHT_THRESHOLDS;
    const checks = [
      {
        key: 'fps',
        pass: cameraFps >= t.minFps && processedFps >= t.minProcessedFps,
        label: '프레임 속도',
        value: processedFps < cameraFps - 2
          ? `${cameraFps.toFixed(1)} fps (분석 ${processedFps.toFixed(0)})`
          : `${cameraFps.toFixed(1)} fps`,
        hint: processedFps < t.minHrFps
          ? '분석 속도가 너무 느려 이대로는 심박수를 계산할 수 없습니다. 다른 앱과 브라우저 탭을 닫고 다시 시도해주세요.'
          : cameraFps >= t.minFps
            ? '기기의 분석 속도가 느립니다. 다른 앱과 브라우저 탭을 닫고 다시 시도해주세요.'
            : '다른 앱을 닫고 다시 시도해주세요.',
      },
      {
        key: 'brightness',
        pass: faceB >= t.faceBrightMin && faceB <= t.faceBrightMax,
        label: '얼굴 밝기',
        value: `${faceB.toFixed(0)} / 255`,
        hint: faceB < t.faceBrightMin
          ? '얼굴이 어둡습니다. 정면 조명을 더 밝게 해주세요.'
          : '얼굴이 너무 밝습니다. 조명을 줄이거나 거리를 늘려주세요.',
      },
      {
        key: 'uniformity',
        pass: faceStd <= t.faceSpatialStdMax,
        label: '조명 균일도',
        value: `σ ${faceStd.toFixed(0)}`,
        hint: '조명이 한쪽으로 치우쳐 있습니다. 정면에서 비추는 광원을 권장합니다.',
      },
      {
        key: 'backlight',
        pass: (bgB - faceB) <= t.bgFaceDeltaMax,
        label: '역광 여부',
        value: `Δ ${(bgB - faceB).toFixed(0)}`,
        hint: '역광 환경입니다. 창이나 강한 조명을 등지지 마세요.',
      },
      {
        key: 'stability',
        pass: jitter <= t.centroidJitterMax,
        label: '머리 안정성',
        value: `${jitter.toFixed(0)} px/s`,
        hint: '머리를 좀 더 고정해주세요.',
      },
    ];
    const allPass = checks.every((c) => c.pass);
    return { allPass, checks, fps, cameraFps, processedFps, faceB, faceStd, bgB, jitter };
  }

  /** Camera frames per second over the noted frames, or null if too few. */
  _cameraFps() {
    const c = this.cameraFrames;
    if (c.length < 2) return null;
    const first = c[0], last = c[c.length - 1];
    const sec = (last.t - first.t) / 1000;
    if (!(sec > 0)) return null;
    // presentedFrames counts frames the browser presented, including ones whose
    // callback was skipped while the main thread was busy.
    if (first.n != null && last.n != null && last.n > first.n) return (last.n - first.n) / sec;
    return (c.length - 1) / sec;
  }
}
