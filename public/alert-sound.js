// ── Alert sound ──────────────────────────────────────────────
// Plays notification sounds for attention alerts.
// Supports audio file playback and a fallback synth beep.

export const SOUND_OPTIONS = [
  { id: 'coins', label: 'Coins', file: '/audio/Coins_jingle_(4).wav.ogg' },
  { id: 'tears', label: 'Tears of Guthix', file: '/audio/Tears_of_Guthix_(minigame)_blue_tears.ogg' },
  { id: 'beep', label: 'Beep (synth)', file: null },
];

function playSynthBeep() {
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 880;
  gain.gain.value = 0.15;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const now = ctx.currentTime;
  osc.start(now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  osc.stop(now + 0.2);
}

export function playAlertSound(soundId) {
  try {
    const option = SOUND_OPTIONS.find(o => o.id === soundId) || SOUND_OPTIONS[0];
    if (option.file) {
      const audio = new Audio(option.file);
      audio.volume = 0.3;
      audio.play().catch(() => {});
    } else {
      playSynthBeep();
    }
  } catch {
    // Silently fail — sound is non-critical
  }
}
