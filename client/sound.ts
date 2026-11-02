// Sound for the browser (Milestone 5). Every sound is synthesised here with the
// Web Audio API, so there are no audio files and no licences to track. Off by
// default; the speaker button in the status bar turns it on and remembers.

const KEY = 'gm_sound';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let ambientKey = '';
let ambientStop: (() => void) | null = null;

export function soundOn(): boolean {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

function setStored(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
}

function audio(): AudioContext | null {
  if (!soundOn()) return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function noiseBuffer(a: AudioContext, seconds: number): AudioBuffer {
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * seconds), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** A burst of filtered noise with a simple envelope. */
function noise(a: AudioContext, opts: { type: BiquadFilterType; freq: number; q?: number; dur: number; gain: number; attack?: number; at?: number }) {
  const t = a.currentTime + (opts.at ?? 0);
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(a, opts.dur + 0.1);
  const f = a.createBiquadFilter();
  f.type = opts.type;
  f.frequency.value = opts.freq;
  f.Q.value = opts.q ?? 1;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.01));
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t);
  src.stop(t + opts.dur + 0.05);
}

/** A struck bell: a few inharmonic partials, ringing out. */
function bell(a: AudioContext, base: number, dur: number, gain: number, at = 0) {
  const t = a.currentTime + at;
  for (const [ratio, amp] of [[1, 1], [2.76, 0.5], [5.4, 0.25], [8.93, 0.12]] as const) {
    const o = a.createOscillator();
    o.frequency.value = base * ratio;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * amp, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur / ratio ** 0.3);
    o.connect(g).connect(master!);
    o.start(t);
    o.stop(t + dur);
  }
}

function tone(a: AudioContext, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', at = 0, slideTo?: number) {
  const t = a.currentTime + at;
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const SOUNDS: Record<string, (a: AudioContext) => void> = {
  bell: (a) => { bell(a, 196, 5, 0.5); bell(a, 196, 5, 0.4, 2.4); bell(a, 196, 5, 0.3, 4.8); },
  deathbell: (a) => bell(a, 110, 6, 0.5),
  cart: (a) => { for (let i = 0; i < 6; i++) noise(a, { type: 'bandpass', freq: 300 + Math.random() * 200, q: 4, dur: 0.18, gain: 0.25, at: i * 0.45 }); tone(a, 1400, 0.4, 0.05, 'triangle', 0.2); },
  thunder: (a) => { noise(a, { type: 'lowpass', freq: 180, dur: 3.5, gain: 0.8, attack: 0.2 }); noise(a, { type: 'lowpass', freq: 600, dur: 0.6, gain: 0.4 }); },
  door: (a) => { tone(a, 90, 0.25, 0.4, 'sine', 0, 50); noise(a, { type: 'lowpass', freq: 400, dur: 0.15, gain: 0.2 }); },
  coin: (a) => { tone(a, 2400, 0.12, 0.15, 'triangle'); tone(a, 3100, 0.18, 0.12, 'triangle', 0.07); },
  hit: (a) => { noise(a, { type: 'highpass', freq: 2500, dur: 0.12, gain: 0.35 }); tone(a, 820, 0.25, 0.12, 'square', 0, 400); },
  fire: (a) => { for (let i = 0; i < 10; i++) noise(a, { type: 'highpass', freq: 1500, dur: 0.05, gain: 0.2, at: Math.random() * 1.5 }); noise(a, { type: 'lowpass', freq: 500, dur: 1.6, gain: 0.15, attack: 0.3 }); },
  gate: (a) => { tone(a, 70, 2.5, 0.3, 'sawtooth', 0, 55); noise(a, { type: 'bandpass', freq: 220, q: 8, dur: 2.2, gain: 0.15, attack: 0.4 }); },
  splash: (a) => noise(a, { type: 'bandpass', freq: 900, q: 0.7, dur: 0.6, gain: 0.4 }),
};

export function play(key: string): void {
  const a = audio();
  const fn = SOUNDS[key];
  if (a && fn) fn(a);
}

/** Looping beds of sound for where you are: rain, wind, tavern noise, fire. */
const AMBIENT: Record<string, (a: AudioContext, out: GainNode) => () => void> = {
  rain: (a, out) => loopNoise(a, out, 'highpass', 1200, 0.5, 0.14),
  storm: (a, out) => loopNoise(a, out, 'lowpass', 2500, 0.7, 0.22),
  wind: (a, out) => {
    const stop = loopNoise(a, out, 'bandpass', 400, 2, 0.12);
    return stop;
  },
  hubbub: (a, out) => loopNoise(a, out, 'bandpass', 600, 1.5, 0.08),
  fire: (a, out) => loopNoise(a, out, 'lowpass', 700, 1, 0.12),
};

function loopNoise(a: AudioContext, out: GainNode, type: BiquadFilterType, freq: number, q: number, gain: number): () => void {
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(a, 3);
  src.loop = true;
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = a.createGain();
  g.gain.value = gain;
  // A slow wobble so it breathes instead of hissing.
  const lfo = a.createOscillator();
  lfo.frequency.value = 0.15;
  const lg = a.createGain();
  lg.gain.value = gain * 0.4;
  lfo.connect(lg).connect(g.gain);
  src.connect(f).connect(g).connect(out);
  src.start();
  lfo.start();
  return () => { try { src.stop(); lfo.stop(); } catch { /* already stopped */ } };
}

export function ambient(key: string): void {
  if (key === ambientKey && (ambientStop || !soundOn())) return;
  ambientStop?.();
  ambientStop = null;
  ambientKey = key;
  const a = audio();
  if (!a || !key || !AMBIENT[key]) return;
  ambientStop = AMBIENT[key](a, master!);
}

/** The speaker button: off by default, remembered on this device. */
export function makeToggle(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'sound';
  btn.type = 'button';
  const draw = () => {
    btn.textContent = soundOn() ? '♪ on' : '♪ off';
    btn.title = soundOn() ? 'Sound on: tap to mute' : 'Sound off: tap for sound';
    btn.classList.toggle('on', soundOn());
  };
  btn.addEventListener('click', () => {
    setStored(!soundOn());
    draw();
    if (soundOn()) {
      const key = ambientKey;
      ambientKey = '';
      ambient(key);
      play('coin');
    } else {
      ambientStop?.();
      ambientStop = null;
    }
  });
  draw();
  return btn;
}
