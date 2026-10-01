/* Phase 5 — Real rPPG trace (single-channel BVP from LiveRPPG).
 *
 * No more synthetic ECG. The waveform shown here is the actual filtered
 * BVP produced by POS + 4th-order Butterworth on the live ROI samples.
 * Color flips from preview-blue to live-mint once SNR clears threshold.
 */
export class HRVTrace {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, { bpmDisplayEl = null } = {}) {
    this.cvs = canvas;
    this.ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    this.W = canvas.clientWidth || 900;
    this.H = canvas.clientHeight || 160;
    canvas.width = Math.round(this.W * dpr);
    canvas.height = Math.round(this.H * dpr);
    this.ctx.scale(dpr, dpr);

    this.bvp = [];          // last live-pipeline output (filtered BVP, ~8 s)
    this.bpm = null;        // displayed BPM target
    this.displayedBpm = null;
    this.mode = 'preview';  // 'preview' | 'live'
    this.running = false;
    this.bpmDisplayEl = bpmDisplayEl;
  }

  setBVP(arr) { if (arr && arr.length) this.bvp = arr; }
  setBPM(bpm) { if (Number.isFinite(bpm)) this.bpm = bpm; }
  /** Forget the shown BPM (signal no longer passes the quality gate). */
  clearBPM() {
    this.bpm = null;
    this.displayedBpm = null;
    if (this.bpmDisplayEl) this.bpmDisplayEl.textContent = '--';
  }
  setMode(m) { if (m === 'preview' || m === 'live') this.mode = m; }
  setBPMDisplayEl(el) { this.bpmDisplayEl = el; }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      // Smooth the displayed BPM toward target.
      if (this.bpm != null) {
        this.displayedBpm = this.displayedBpm == null
          ? this.bpm
          : this.displayedBpm + (this.bpm - this.displayedBpm) * 0.18;
        if (this.bpmDisplayEl) {
          this.bpmDisplayEl.textContent = Math.round(this.displayedBpm).toString();
        }
      }
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }

  draw() {
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.fillStyle = '#03061A';
    ctx.fillRect(0, 0, W, H);

    // Vertical grid every 45 px (~1.5 s @ 30 fps).
    ctx.strokeStyle = 'rgba(36, 49, 105, 0.35)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 45) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    // Center line
    const mid = H / 2;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

    if (!this.bvp || this.bvp.length < 8) {
      ctx.fillStyle = 'rgba(138, 153, 192, 0.55)';
      ctx.font = '12px "Pretendard Variable", Pretendard, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('신호 수집 중…', W / 2, mid + 4);
      return;
    }
    // Normalize amplitude
    let mn = Infinity, mx = -Infinity;
    for (const v of this.bvp) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const span = Math.max(mx - mn, 1e-6);
    const amp = (H - 32) / 2;
    const color = this.mode === 'live' ? '#3FB89A' : '#6B8AE8';
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < this.bvp.length; i++) {
      const x = (i / (this.bvp.length - 1)) * W;
      const v = (this.bvp[i] - mn) / span;
      const y = mid - (v - 0.5) * 2 * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
