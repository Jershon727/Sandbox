/**
 * Synthesised sound effects.
 *
 * Everything is generated with the Web Audio API, so the game ships no audio
 * files and stays instant to load. The palette is deliberately small and warm:
 * a click for a deal, a rising blip for a good card, a nasty slide for a bust.
 */

let audio = null;
let master = null;
let enabled = true;

function ready() {
  if (!enabled) return null;
  if (!audio) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audio = new Ctx();
    master = audio.createGain();
    master.gain.value = 0.3;
    master.connect(audio.destination);
  }
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

export function setSoundEnabled(on) {
  enabled = !!on;
  if (master) master.gain.value = enabled ? 0.3 : 0;
}

/** Browsers only allow audio after a gesture — call this from the first tap. */
export function unlockSound() {
  ready();
}

function tone({ freq = 440, to, dur = 0.14, type = 'sine', gain = 0.5, delay = 0, curve = 'exp' }) {
  const c = ready();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to && to !== freq) {
    if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    else osc.frequency.linearRampToValueAtTime(Math.max(20, to), t0 + dur);
  }
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.3));
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.08, gain = 0.3, delay = 0, hp = 900, lp = 6000 }) {
  const c = ready();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const frames = Math.max(1, Math.floor(c.sampleRate * dur));
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const hpf = c.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = hp;
  const lpf = c.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = lp;
  const amp = c.createGain();
  amp.gain.value = gain;
  src.connect(hpf).connect(lpf).connect(amp).connect(master);
  src.start(t0);
}

export const sfx = {
  tap() {
    noise({ dur: 0.03, gain: 0.14, hp: 1800 });
  },
  deal() {
    noise({ dur: 0.07, gain: 0.3, hp: 1200, lp: 8000 });
    tone({ freq: 190, to: 130, dur: 0.06, type: 'triangle', gain: 0.16 });
  },
  gain(value = 6) {
    // Higher cards ring a little higher — you hear a good draw before you read it.
    const base = 330 + value * 26;
    tone({ freq: base, to: base * 1.5, dur: 0.11, type: 'triangle', gain: 0.3 });
  },
  modifier() {
    tone({ freq: 780, to: 1180, dur: 0.1, type: 'sine', gain: 0.24 });
    tone({ freq: 1180, to: 1560, dur: 0.12, type: 'sine', gain: 0.16, delay: 0.07 });
  },
  bust() {
    tone({ freq: 300, to: 62, dur: 0.5, type: 'sawtooth', gain: 0.34 });
    tone({ freq: 150, to: 40, dur: 0.55, type: 'square', gain: 0.14, delay: 0.02 });
    noise({ dur: 0.3, gain: 0.16, hp: 200, lp: 1800 });
  },
  save() {
    tone({ freq: 520, to: 660, dur: 0.12, type: 'sine', gain: 0.3 });
    tone({ freq: 780, to: 990, dur: 0.18, type: 'sine', gain: 0.26, delay: 0.09 });
  },
  freeze() {
    tone({ freq: 1750, to: 900, dur: 0.42, type: 'sine', gain: 0.22 });
    tone({ freq: 2400, to: 1300, dur: 0.36, type: 'sine', gain: 0.12, delay: 0.04 });
    noise({ dur: 0.34, gain: 0.1, hp: 4000 });
  },
  flip3() {
    for (let i = 0; i < 3; i++) {
      tone({ freq: 420 + i * 150, to: 560 + i * 150, dur: 0.09, type: 'square', gain: 0.16, delay: i * 0.075 });
    }
  },
  stay() {
    tone({ freq: 260, to: 170, dur: 0.15, type: 'triangle', gain: 0.26 });
  },
  flip7() {
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((f, i) => {
      tone({ freq: f, dur: 0.42, type: 'triangle', gain: 0.3, delay: i * 0.085 });
    });
  },
  win() {
    const notes = [392, 523, 659, 784, 1047];
    notes.forEach((f, i) => {
      tone({ freq: f, dur: 0.5, type: 'triangle', gain: 0.3, delay: i * 0.11 });
      tone({ freq: f / 2, dur: 0.5, type: 'sine', gain: 0.14, delay: i * 0.11 });
    });
  },
  lose() {
    [392, 349, 294, 233].forEach((f, i) => {
      tone({ freq: f, dur: 0.34, type: 'triangle', gain: 0.24, delay: i * 0.13 });
    });
  },
  count() {
    tone({ freq: 900, to: 1100, dur: 0.05, type: 'sine', gain: 0.14 });
  },
  error() {
    tone({ freq: 220, to: 180, dur: 0.16, type: 'square', gain: 0.2 });
  },
};
