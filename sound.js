/* Phase 4.2 — BellSoundEngine (two-asset edition).
 *
 * Loads inhale.mp3 + exhale.mp3, then builds a per-state audio graph:
 *   BufferSource (inhale OR exhale, playbackRate-stretched to cycle pace)
 *     → BiquadFilter (lowpass, cfg.filter_hz)
 *     → split into dry + wet (ConvolverNode using a procedurally-generated
 *        decaying-noise IR scaled by cfg.reverb_amount)
 *     → stateGain (cfg.gain, with 600 ms fade-in / 800 ms fade-out)
 *     → master → AnalyserNode → destination
 *
 * For sympathetic_dominant (guide_slowing: true) the BPM linearly ramps
 * from 8 → 5 over the 60 s session: each cycle is rescheduled with a
 * progress-dependent cycle length.
 *
 * No external IR file, no Tone.js, no carrier/transition assets.
 */
import { ANS_TO_SOUND, REQUIRED_ASSETS } from './sound_mapping.js?v=6.5-pages';

const TOTAL_PLAY_SECONDS = 60;
const FADE_IN_SEC = 0.6;
const FADE_OUT_SEC = 0.8;
const SCHED_HORIZON_SEC = 2.0;

export class BellSoundEngine {
  constructor({ basePath = './sounds/' } = {}) {
    this.basePath = basePath;
    /** @type {AudioContext|null} */ this.ctx = null;
    /** @type {GainNode|null} */ this.master = null;
    /** @type {AnalyserNode|null} */ this.analyser = null;
    /** @type {Record<string, AudioBuffer>} */ this.buffers = {};
    this.missing = [];
    /** @type {{stateGain:GainNode, sources:AudioBufferSourceNode[], timers:number[], stopFlag:boolean, startedAt:number}|null} */
    this.active = null;
    /** @type {Float32Array|null} */ this._analyserBuf = null;
  }

  async init() {
    if (this.ctx) return { ok: this.missing.length === 0, missing: this.missing };
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio API not supported');
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    const missing = [];
    for (const path of REQUIRED_ASSETS) {
      try {
        const r = await fetch(this.basePath + path, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ab = await r.arrayBuffer();
        this.buffers[path] = await this.ctx.decodeAudioData(ab);
      } catch (_e) {
        missing.push(path);
      }
    }
    this.missing = missing;
    return { ok: missing.length === 0, missing };
  }

  /** Procedural reverb impulse response — decaying white noise, stereo. */
  _makeIR(seconds) {
    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(seconds * sr));
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      }
    }
    return buf;
  }

  /** Starts the 60 s session. Resolves to true once playback is scheduled,
   *  false when the breath recordings are missing (nothing plays). */
  async playForState(ansState, { onBreath, onMissing } = {}) {
    if (!this.ctx) await this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const cfg = ANS_TO_SOUND[ansState] || ANS_TO_SOUND.uncertain;
    const inhale = this.buffers['breath/inhale.mp3'];
    const exhale = this.buffers['breath/exhale.mp3'];
    if (!inhale || !exhale) {
      onMissing?.({ requested: REQUIRED_ASSETS, available: Object.keys(this.buffers) });
      return false;
    }
    this._stopActive(true);

    // Per-state chain.
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cfg.filter_hz;
    filter.Q.value = 0.7;

    const reverb = this.ctx.createConvolver();
    reverb.buffer = this._makeIR(cfg.reverb_amount * 2.0 + 0.5);

    const dry = this.ctx.createGain();
    dry.gain.value = 1 - cfg.reverb_amount * 0.5;
    const wet = this.ctx.createGain();
    wet.gain.value = cfg.reverb_amount * 0.5;

    const stateGain = this.ctx.createGain();
    stateGain.gain.setValueAtTime(0, this.ctx.currentTime);
    stateGain.gain.linearRampToValueAtTime(cfg.gain, this.ctx.currentTime + FADE_IN_SEC);

    filter.connect(dry).connect(stateGain);
    filter.connect(reverb).connect(wet).connect(stateGain);
    stateGain.connect(this.master);

    const startedAt = this.ctx.currentTime;
    // The scheduler below only touches this session, so a session that was
    // replaced or stopped can never schedule into the next one.
    const session = { stateGain, sources: [], timers: [], stopFlag: false, startedAt, filter };
    this.active = session;

    const startBpm = cfg.guide_slowing ? 8 : cfg.breath_rate_bpm;
    const endBpm   = cfg.guide_slowing ? 5 : cfg.breath_rate_bpm;
    const endT = startedAt + TOTAL_PLAY_SECONDS;
    let t = startedAt + 0.1;

    const scheduleCycle = (when) => {
      const elapsed = Math.max(0, when - startedAt);
      const progress = Math.min(1, elapsed / TOTAL_PLAY_SECONDS);
      const currentBpm = startBpm + (endBpm - startBpm) * progress;
      const cycleSec = 60 / currentBpm;
      const inhaleSec = cycleSec * cfg.breath_inhale_ratio;
      const exhaleSec = cycleSec - inhaleSec;

      const inSrc = this.ctx.createBufferSource();
      inSrc.buffer = inhale;
      inSrc.playbackRate.value = inSrc.buffer.duration / inhaleSec || 1;
      inSrc.connect(filter);
      inSrc.start(when);
      session.sources.push(inSrc);

      const exSrc = this.ctx.createBufferSource();
      exSrc.buffer = exhale;
      exSrc.playbackRate.value = exSrc.buffer.duration / exhaleSec || 1;
      exSrc.connect(filter);
      exSrc.start(when + inhaleSec);
      session.sources.push(exSrc);

      if (onBreath) {
        const dt1 = Math.max(0, (when - this.ctx.currentTime) * 1000);
        const dt2 = Math.max(0, (when + inhaleSec - this.ctx.currentTime) * 1000);
        const cue = (phase) => () => { if (!session.stopFlag) onBreath?.({ phase, cycleSec, inhaleSec }); };
        session.timers.push(setTimeout(cue('inhale'), dt1));
        session.timers.push(setTimeout(cue('exhale'), dt2));
      }
      return cycleSec;
    };

    // Rolling scheduler — pre-roll a couple of cycles, then top up as we go.
    const tick = async () => {
      while (!session.stopFlag && t < endT) {
        if (t - this.ctx.currentTime > SCHED_HORIZON_SEC) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const dur = scheduleCycle(t);
        t += dur;
      }
    };
    tick();
    return true;
  }

  stop({ fadeMs = FADE_OUT_SEC * 1000 } = {}) {
    if (!this.active) return;
    this.active.stopFlag = true;
    // Pending breath cues would otherwise keep switching the on-screen text.
    for (const id of this.active.timers || []) clearTimeout(id);
    const g = this.active.stateGain;
    try {
      g.gain.cancelScheduledValues(this.ctx.currentTime);
      g.gain.setValueAtTime(g.gain.value, this.ctx.currentTime);
      g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + fadeMs / 1000);
    } catch (_) {}
    const sources = this.active.sources;
    const a = this.active;
    setTimeout(() => {
      for (const s of sources) { try { s.stop(); } catch (_) {} }
      if (this.active === a) this.active = null;
    }, fadeMs + 80);
  }

  _stopActive(crossfade = false) {
    if (this.active) this.stop({ fadeMs: crossfade ? 300 : FADE_OUT_SEC * 1000 });
  }

  setMasterGain(v) {
    if (!this.master) return;
    const c = Math.max(0, Math.min(1, v));
    this.master.gain.setTargetAtTime(c, this.ctx.currentTime, 0.05);
  }

  getAnalyserData() {
    if (!this.analyser) return null;
    if (!this._analyserBuf || this._analyserBuf.length !== this.analyser.fftSize) {
      this._analyserBuf = new Float32Array(this.analyser.fftSize);
    }
    this.analyser.getFloatTimeDomainData(this._analyserBuf);
    return this._analyserBuf;
  }
}
