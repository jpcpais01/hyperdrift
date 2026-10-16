/**
 * All sound is synthesised with WebAudio (no assets to download):
 * engine (oscillators + waveshaper + filter, pitch from RPM), turbo whistle,
 * boost roar, tyre screech, wind, and one-shot effects.
 */
type Voice = 'v6' | 'rotary' | 'v12';

const VOICES: Record<Voice, { base: number; range: number; waves: OscillatorType[]; mix: number[]; cutoff: number }> = {
  v6: { base: 48, range: 3.2, waves: ['sawtooth', 'square', 'sawtooth'], mix: [0.5, 0.25, 0.18], cutoff: 1300 },
  rotary: { base: 70, range: 3.8, waves: ['square', 'sawtooth', 'square'], mix: [0.38, 0.35, 0.22], cutoff: 2200 },
  v12: { base: 40, range: 3.0, waves: ['sawtooth', 'sawtooth', 'triangle'], mix: [0.45, 0.35, 0.3], cutoff: 1700 },
};

export interface EngineParams {
  rpm: number;
  throttle: number;
  speed: number; // m/s
  boost: number; // 0..1
  slip: number; // 0..1 tyre screech
  whistle: number;
  grounded: boolean;
}

export class AudioSystem {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private engine: { oscs: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode; voice: Voice } | null = null;
  private whistle: { osc: OscillatorNode; gain: GainNode } | null = null;
  private loops: Record<'boost' | 'screech' | 'wind', { gain: GainNode; filter: BiquadFilterNode }> | null = null;
  muted = false;

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  private noiseLoop(type: BiquadFilterType, freq: number, q: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    return { gain, filter };
  }

  startEngine(voice: Voice) {
    if (!this.ctx) return;
    this.stopEngine();
    const ctx = this.ctx;
    const v = VOICES[voice];
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = v.cutoff;
    filter.Q.value = 2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const mixer = ctx.createGain();
    mixer.gain.value = 0.6;
    const oscs = v.waves.map((w, i) => {
      const o = ctx.createOscillator();
      o.type = w;
      const g = ctx.createGain();
      g.gain.value = v.mix[i];
      o.connect(g).connect(mixer);
      o.start();
      return o;
    });
    mixer.connect(shaper).connect(filter).connect(gain).connect(this.master);
    this.engine = { oscs, gain, filter, voice };

    const wo = ctx.createOscillator();
    wo.type = 'sine';
    const wg = ctx.createGain();
    wg.gain.value = 0;
    wo.connect(wg).connect(this.master);
    wo.start();
    this.whistle = { osc: wo, gain: wg };

    this.loops = {
      boost: this.noiseLoop('bandpass', 500, 0.8),
      screech: this.noiseLoop('bandpass', 1400, 6),
      wind: this.noiseLoop('lowpass', 600, 0.5),
    };
  }

  stopEngine() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.engine) {
      this.engine.gain.gain.setTargetAtTime(0, t, 0.05);
      for (const o of this.engine.oscs) o.stop(t + 0.3);
      this.engine = null;
    }
    if (this.whistle) {
      this.whistle.osc.stop(t + 0.1);
      this.whistle = null;
    }
    if (this.loops) {
      for (const l of Object.values(this.loops)) l.gain.gain.setTargetAtTime(0, t, 0.05);
      this.loops = null;
    }
  }

  updateEngine(p: EngineParams) {
    if (!this.ctx || !this.engine) return;
    const t = this.ctx.currentTime;
    const v = VOICES[this.engine.voice];
    const f = v.base * (1 + p.rpm * v.range);
    const ratios = [1, 0.5, 2.01];
    this.engine.oscs.forEach((o, i) => o.frequency.setTargetAtTime(f * ratios[i], t, 0.02));
    this.engine.filter.frequency.setTargetAtTime(v.cutoff * (0.5 + p.throttle * 0.7 + p.rpm * 0.6), t, 0.05);
    this.engine.gain.gain.setTargetAtTime(0.16 + p.throttle * 0.12 + p.boost * 0.06, t, 0.05);
    if (this.whistle) {
      this.whistle.osc.frequency.setTargetAtTime(1800 + p.rpm * 2600, t, 0.05);
      this.whistle.gain.gain.setTargetAtTime(p.whistle * p.throttle * p.rpm * 0.025, t, 0.08);
    }
    if (this.loops) {
      this.loops.boost.gain.gain.setTargetAtTime(p.boost * 0.35, t, 0.05);
      this.loops.boost.filter.frequency.setTargetAtTime(300 + p.boost * 900, t, 0.1);
      this.loops.screech.gain.gain.setTargetAtTime(p.grounded ? p.slip * 0.22 : 0, t, 0.04);
      this.loops.wind.gain.gain.setTargetAtTime(Math.min(0.35, (p.speed / 90) ** 2 * 0.35), t, 0.1);
      this.loops.wind.filter.frequency.setTargetAtTime(300 + p.speed * 12, t, 0.1);
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.25, slide = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, freq: number, vol: number, type: BiquadFilterType = 'bandpass') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(freq * 3, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur);
  }

  boost() {
    this.burst(0.7, 300, 0.5);
    this.tone(90, 0.5, 'sawtooth', 0.12, 2.5);
  }
  pickup() {
    this.tone(880, 0.12, 'triangle', 0.18);
    setTimeout(() => this.tone(1320, 0.18, 'triangle', 0.16), 70);
  }
  land(strength: number) {
    this.tone(70, 0.25, 'sine', 0.35 * strength, 0.5);
    this.burst(0.15, 200, 0.2 * strength, 'lowpass');
  }
  wall(strength: number) {
    this.burst(0.25, 900, 0.3 * strength);
  }
  beep(high = false) {
    this.tone(high ? 1046 : 523, high ? 0.5 : 0.22, 'square', 0.12);
  }
  lap() {
    this.tone(660, 0.12, 'triangle', 0.15);
    setTimeout(() => this.tone(990, 0.25, 'triangle', 0.15), 100);
  }
  click() {
    this.tone(1400, 0.05, 'triangle', 0.08);
  }
  whoosh() {
    this.burst(0.5, 400, 0.18);
  }
}

export const audio = new AudioSystem();
