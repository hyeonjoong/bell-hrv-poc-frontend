/* Phase 4.2 — Two-asset sonic identity.
 *
 * Drove all 5 ANS states from just two BELL recordings (inhale.mp3 +
 * exhale.mp3). Differentiation comes from breath pace, gain, lowpass
 * cutoff, and procedural reverb amount — no per-state carrier files.
 *
 * Benefits: single recognizable sonic identity, no missing-asset banner,
 * tighter demo. The "carrier_hz / binaural_hz" rationale chips become
 * "filter cutoff / reverb %" in this revision.
 */
export const ANS_TO_SOUND = {
  balanced: {
    label_ko: '균형 유지',
    breath_rate_bpm: 6,           // 10 s cycle — RSA sweet spot
    breath_inhale_ratio: 0.45,
    gain: 0.85,
    filter_hz: 1800,
    reverb_amount: 0.25,
    rationale: '안정 상태 — 분당 6회 호흡으로 자율신경 균형 유지',
  },
  vagal_dominant: {
    label_ko: '이완 심화',
    breath_rate_bpm: 5,           // slower → deeper parasympathetic
    breath_inhale_ratio: 0.40,
    gain: 0.80,
    filter_hz: 1200,              // warmer / lower
    reverb_amount: 0.45,          // more space
    rationale: '부교감 우세 — 깊은 호흡으로 이완 상태 유지',
  },
  sympathetic_dominant: {
    label_ko: '진정 유도',
    breath_rate_bpm: 6,           // starts matched (8) and guide-slows to 5
    breath_inhale_ratio: 0.42,
    gain: 0.90,
    filter_hz: 1500,
    reverb_amount: 0.35,
    guide_slowing: true,          // engine ramps 8→5 bpm over playback
    rationale: '교감 우세 — 점진적 호흡 둔화로 진정 유도',
  },
  low_arousal: {
    label_ko: '부드러운 환기',
    breath_rate_bpm: 7,           // slightly faster → gentle activation
    breath_inhale_ratio: 0.50,
    gain: 0.70,                   // softer
    filter_hz: 2400,              // brighter
    reverb_amount: 0.20,
    rationale: '저각성 — 부드럽게 환기',
  },
  uncertain: {
    label_ko: '재측정 권장',
    breath_rate_bpm: 6,
    breath_inhale_ratio: 0.45,
    gain: 0.60,                   // quiet — signal user to retry
    filter_hz: 1800,
    reverb_amount: 0.30,
    rationale: '측정 신호가 약합니다 — 재측정을 권장합니다',
  },
};

export const REQUIRED_ASSETS = [
  'breath/inhale.mp3',
  'breath/exhale.mp3',
];

/* Korean copy for ANS state badges + interpretations (re-export from here so
 * main.js has a single import target). */
export const ANS_KOREAN = {
  sympathetic_dominant: {
    title: '교감 우세',
    interp: '긴장도가 다소 높은 상태입니다. 점진적으로 호흡을 늦춰드릴게요.',
    rationale: 'RMSSD가 평균보다 낮고 HR이 높아 교감신경이 활성화된 상태입니다.',
  },
  vagal_dominant: {
    title: '이완 우세',
    interp: '부교감신경이 잘 작동 중입니다. 더 깊은 호흡으로 유지해보세요.',
    rationale: 'RMSSD가 평균보다 높고 HR이 낮아 부교감신경이 우세한 상태입니다.',
  },
  balanced: {
    title: '균형 상태',
    interp: '자율신경 균형이 안정적입니다. 분당 6회 호흡으로 유지하세요.',
    rationale: 'HR과 RMSSD 모두 평균 범위 안에 있어 균형 잡힌 상태입니다.',
  },
  low_arousal: {
    title: '저각성 상태',
    interp: '에너지가 낮아 보입니다. 살짝 빠른 호흡으로 환기해드릴게요.',
    rationale: 'HR과 RMSSD가 모두 낮아 전반적인 각성도가 떨어진 상태입니다.',
  },
  uncertain: {
    title: '추정 어려움',
    interp: '신호 품질이 낮아 기본 사운드를 제공합니다. 조명과 자세를 확인 후 재측정해주세요.',
    rationale: '조명·움직임 등의 영향으로 신호 품질이 기준에 미치지 못했습니다.',
  },
};

/* Backwards-compat: rationale-card chips used to consume backend sound_profile.
 * Now we read directly from ANS_TO_SOUND. Kept exported so main.js need not
 * change its import list. */
export function getDisplayProfile(ansState /* , backendProfile (ignored) */) {
  const cfg = ANS_TO_SOUND[ansState] || ANS_TO_SOUND.uncertain;
  return {
    label_ko: cfg.label_ko,
    breath_rate_bpm: cfg.breath_rate_bpm,
    filter_hz: cfg.filter_hz,
    reverb_amount: cfg.reverb_amount,
  };
}
