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
 */
export const PREFLIGHT_THRESHOLDS = {
  minFps: 28,
  faceBrightMin: 70,
  faceBrightMax: 210,
  faceSpatialStdMax: 38,
  bgFaceDeltaMax: 60,
  centroidJitterMax: 40,
};

export class Preflight {
  constructor(durationMs = 3000) {
    this.durationMs = durationMs;
    this.startMs = null;
    this.frames = [];
    this.done = false;
    this.result = null;
    this._scratch = document.createElement('canvas');
  }

  start() {
    this.startMs = null;
    this.frames = [];
    this.done = false;
    this.result = null;
  }

  /** Called from onFaceResults with the multi-ROI boxes. */
  observe(boxes, w, h, video, tMs) {
    if (this.done) return;
    if (this.startMs == null) this.startMs = tMs;
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
    this._scratch.width = FS;
    this._scratch.height = FS;
    const ctx = this._scratch.getContext('2d', { willReadFrequently: true });
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
    this._scratch.width = BP;
    this._scratch.height = BP;
    let bgSum = 0, bgN = 0;
    for (const [bx, by] of corners) {
      ctx.drawImage(video, bx, by, BP, BP, 0, 0, BP, BP);
      const bd = ctx.getImageData(0, 0, BP, BP).data;
      for (let i = 0; i < bd.length; i += 4) {
        const Y = 0.299 * bd[i] + 0.587 * bd[i + 1] + 0.114 * bd[i + 2];
        bgSum += Y; bgN++;
      }
    }
    const bgMean = bgSum / bgN;

    const cx = fx0 + fw / 2;
    const cy = fy0 + fh / 2;
    this.frames.push({ t: tMs, faceMean, faceStd, bgMean, cx, cy });

    if (tMs - this.startMs >= this.durationMs && this.frames.length >= 30) {
      this.done = true;
      this.result = this._evaluate();
    }
  }

  _evaluate() {
    const f = this.frames;
    const T = Math.max(0.001, (f[f.length - 1].t - f[0].t) / 1000);
    const fps = (f.length - 1) / T;
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
        pass: fps >= t.minFps,
        label: '프레임 속도',
        value: `${fps.toFixed(1)} fps`,
        hint: '다른 앱을 닫고 다시 시도해주세요.',
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
    return { allPass, checks, fps, faceB, faceStd, bgB, jitter };
  }
}
