export interface SoundOption {
  id: string;
  label: string;
  file: string | null;
}

export const SOUND_OPTIONS: SoundOption[] = [
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

const NYAN_NOTES = [
  659.25, 830.61, 987.77, 1108.73, 987.77, 830.61, 739.99, 659.25,
  739.99, 830.61, 987.77, 1108.73, 987.77, 830.61,
];

export function playNyanJingle() {
  try {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    if (ctx.state === 'suspended') return;

    const master = ctx.createGain();
    master.gain.value = 0.05;
    master.connect(ctx.destination);

    const noteLen = 0.125;
    const now = ctx.currentTime;

    for (let i = 0; i < NYAN_NOTES.length; i++) {
      const start = now + i * noteLen;
      const osc = ctx.createOscillator();
      const noteGain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = NYAN_NOTES[i];
      noteGain.gain.setValueAtTime(0.001, start);
      noteGain.gain.exponentialRampToValueAtTime(1, start + 0.01);
      noteGain.gain.exponentialRampToValueAtTime(0.001, start + noteLen * 0.9);
      osc.connect(noteGain);
      noteGain.connect(master);
      osc.start(start);
      osc.stop(start + noteLen);
    }

    const end = now + NYAN_NOTES.length * noteLen;
    master.gain.setValueAtTime(0.05, end - 0.05);
    master.gain.exponentialRampToValueAtTime(0.001, end);

    setTimeout(() => ctx.close().catch(() => {}), (end - now + 0.1) * 1000);
  } catch {
  }
}

export function playAlertSound(soundId: string) {
  try {
    const option = SOUND_OPTIONS.find(o => o.id === soundId) || SOUND_OPTIONS[0];
    if (option.file) {
      const audio = new Audio(option.file);
      audio.volume = 0.3;
      audio.play().catch(() => {});
      return;
    }
    playSynthBeep();
  } catch {
  }
}
