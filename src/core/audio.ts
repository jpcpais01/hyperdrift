import type { EngineProfile } from '../audio/engineProfile';
import { ENGINE_WORKLET } from '../audio/engineWorklet';

/**
 * All sound is synthesised with WebAudio (no assets to download).
 *
 * Engines run on the audio thread (see audio/engineWorklet.ts): a firing
 * pulse per cylinder through tuned exhaust pipes, so the engine part, turbo,
 * exhaust and weight all change the sound. On top of that each voice has
 * turbo layers (spool whistle, blow-off valve or compressor flutter), nitro
 * layers (solenoid hiss, roar, ignition blast) and overrun pops. The player
 * also gets tyre screech (tuned per tyre part), wind and one-shot effects.
 */

export interface VoiceParams {
  /** revs as a fraction of the redline */
  rpm: number;
  throttle: number;
  /** 0..1 nitro burn */
  nitro: number;
  limiter: boolean;
  /** ignition cut (gear shift) */
  cut: boolean;
  /** output gain (distance attenuation for rivals) */
  gain?: number;
  /** -1..1 stereo position */
  pan?: number;
  /** Doppler pitch factor */
  pitch?: number;
}

export interface EnvParams {
  speed: number; // m/s
  slip: number; // 0..1 tyre screech
  grounded: boolean;
}

type Ctx = AudioContext;

const TYRES = {
  street: { f: 1400, q: 6, vol: 1 },
  slick: { f: 2150, q: 9, vol: 0.7 },
  drift: { f: 950, q: 4, vol: 1.25 },
} as const;

/** One engine with its turbo and nitro layers. */
class EngineVoice {
  readonly out: GainNode;
  private panner: StereoPannerNode | null = null;
  private node: AudioWorkletNode | null = null;
  private legacy: { oscs: OscillatorNode[]; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private whistle: { osc: OscillatorNode; gain: GainNode; hiss: GainNode } | null = null;
  private nitroHiss: GainNode | null = null;
  private nitroRoar: GainNode | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private spool = 0;
  private lastThrottle = 0;
  private stopped = false;
  private lastNitro = 0;
  private base = 1;

  constructor(
    private sys: AudioSystem,
    readonly profile: EngineProfile,
    readonly full: boolean,
    spatial: boolean,
  ) {
    const ctx = sys.ctx!;
    this.out = ctx.createGain();
    this.base = full ? 0.62 : 1;
    this.out.gain.value = this.base;
    if (spatial && typeof ctx.createStereoPanner === 'function') {
      this.panner = ctx.createStereoPanner();
      this.out.connect(this.panner).connect(sys.bus);
    } else {
      this.out.connect(sys.bus);
    }
    void sys.worklet.then((ok) => {
      if (this.stopped) return;
      if (ok) this.attachWorklet();
      else this.attachLegacy();
    });
    if (full) this.buildLayers();
  }

  private attachWorklet() {
    const ctx = this.sys.ctx!;
    try {
      this.node = new AudioWorkletNode(ctx, 'hyperdrift-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: this.profile,
      });
      this.node.connect(this.out);
    } catch {
      this.attachLegacy();
    }
  }

  /** Fallback for browsers without AudioWorklet: a few oscillators through a filter. */
  private attachLegacy() {
    const ctx = this.sys.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = this.profile.muffler;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const oscs = (['sawtooth', 'square', 'sawtooth'] as OscillatorType[]).map((w, i) => {
      const o = ctx.createOscillator();
      o.type = w;
      const g = ctx.createGain();
      g.gain.value = [0.5, 0.25, 0.18][i];
      o.connect(g).connect(filter);
      o.start();
      return o;
    });
    filter.connect(gain).connect(this.out);
    this.legacy = { oscs, filter, gain };
  }

  private buildLayers() {
    const ctx = this.sys.ctx!;
    const p = this.profile;
    if (p.turbo !== 'none') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.out);
      osc.start();
      const hiss = this.sys.noiseLoop('bandpass', p.turbo === 'twin' ? 5200 : 3600, 2.5, this.out);
      this.sources.push(osc, hiss.src);
      this.whistle = { osc, gain, hiss: hiss.gain };
    }
    const hiss = this.sys.noiseLoop('highpass', 4200, 0.7, this.out);
    const roar = this.sys.noiseLoop('lowpass', 240, 0.8, this.out);
    this.sources.push(hiss.src, roar.src);
    this.nitroHiss = hiss.gain;
    this.nitroRoar = roar.gain;
  }

  update(v: VoiceParams, dt: number) {
    const ctx = this.sys.ctx!;
    const t = ctx.currentTime;
    const p = this.profile;
    const rpmHz = Math.max(p.idleRpm * 0.85, v.rpm * p.redline);
    const pitch = v.pitch ?? 1;
    const thr = v.cut ? 0 : v.throttle;
    if (this.node) {
      const P = this.node.parameters;
      P.get('rpm')!.setTargetAtTime(rpmHz, t, 0.012);
      P.get('throttle')!.setTargetAtTime(thr, t, 0.02);
      P.get('nitro')!.setTargetAtTime(v.nitro, t, 0.05);
      P.get('cut')!.setValueAtTime(v.cut ? 1 : 0, t);
      P.get('limiter')!.setValueAtTime(v.limiter ? 1 : 0, t);
      P.get('pitch')!.setTargetAtTime(pitch, t, 0.05);
      // the worklet sleeps when nobody can hear it; distance is applied on `out`
      P.get('gain')!.setTargetAtTime((v.gain ?? 1) > 1e-3 ? 1 : 0, t, 0.04);
    } else if (this.legacy) {
      const f = (rpmHz / 120) * p.fires.length * pitch;
      const ratios = [1, 0.5, 2.01];
      this.legacy.oscs.forEach((o, i) => o.frequency.setTargetAtTime(f * ratios[i], t, 0.02));
      this.legacy.filter.frequency.setTargetAtTime(p.muffler * (0.5 + thr * 0.7 + v.rpm * 0.6), t, 0.05);
      this.legacy.gain.gain.setTargetAtTime(0.16 + thr * 0.12 + v.nitro * 0.06, t, 0.05);
    }
    this.out.gain.setTargetAtTime(this.base * (v.gain ?? 1), t, 0.04);
    if (this.panner) this.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, v.pan ?? 0)), t, 0.05);

    if (this.whistle) {
      // turbo spool: lags the throttle, builds with revs, dumps on lift-off
      const twin = p.turbo === 'twin';
      const target = thr * Math.max(0, Math.min(1, (v.rpm - 0.28) / 0.55));
      const rate = target > this.spool ? (twin ? 2.8 : 1.3) : 3;
      this.spool += (target - this.spool) * (1 - Math.exp(-rate * dt));
      const s = this.spool;
      this.whistle.osc.frequency.setTargetAtTime((twin ? 2600 : 1700) + s * (twin ? 5200 : 4300) + v.rpm * 600, t, 0.05);
      this.whistle.gain.gain.setTargetAtTime(s * s * (0.3 + 0.7 * thr) * (twin ? 0.03 : 0.045), t, 0.05);
      this.whistle.hiss.gain.setTargetAtTime(s * thr * 0.05, t, 0.06);
      if (this.lastThrottle > 0.5 && v.throttle < 0.2 && s > 0.35) this.blowOff(s);
    }
    this.lastThrottle = v.throttle;

    if (this.nitroHiss && this.nitroRoar) {
      const k = p.nitro === 'burst' ? 1.3 : p.nitro === 'drift' ? 1.05 : 0.85;
      this.nitroHiss.gain.setTargetAtTime(v.nitro * 0.09 * k, t, 0.05);
      this.nitroRoar.gain.setTargetAtTime(v.nitro * 0.32 * k, t, 0.08);
      if (this.lastNitro > 0.6 && v.nitro < 0.4) this.sys.burst(0.35, 3000, 0.12, 'highpass', this.out);
      this.lastNitro = v.nitro;
    }
  }

  /** Lift-off with boost: a big turbo's valve "pssh", a twin's compressor flutter. */
  private blowOff(spool: number) {
    const ctx = this.sys.ctx!;
    const t = ctx.currentTime;
    if (this.profile.turbo === 'single') {
      this.sys.burst(0.55, 2400, 0.32 * spool, 'highpass', this.out, 0.5);
    } else {
      // flutter: noise chopped at ~20 Hz, dying away
      const src = ctx.createBufferSource();
      src.buffer = this.sys.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1300;
      f.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < 9; i++) {
        const a = 0.2 * spool * Math.pow(0.78, i);
        g.gain.setValueAtTime(a, t + i * 0.048);
        g.gain.setValueAtTime(a * 0.15, t + i * 0.048 + 0.026);
      }
      g.gain.setValueAtTime(0, t + 0.45);
      src.connect(f).connect(g).connect(this.out);
      src.start(t, Math.random());
      src.stop(t + 0.5);
    }
    this.spool *= 0.25;
  }

  /** Backfire: a bang through the pipes plus a crackle. */
  pop(strength: number) {
    this.node?.port.postMessage({ pop: Math.min(1, strength) });
    this.sys.burst(0.05 + strength * 0.05, 1600 + Math.random() * 1400, 0.22 * strength, 'bandpass', this.out, 3);
  }

  /** The nitro solenoid opens: a hard blast of gas and a deep thump. */
  nitroStart() {
    const k = this.profile.nitro === 'burst' ? 1.25 : this.profile.nitro === 'long' ? 0.85 : 1;
    this.sys.burst(0.7, 1800, 0.4 * k, 'highpass', this.out, 0.6);
    this.sys.burst(0.5, 160, 0.5 * k, 'lowpass', this.out, 4);
    this.sys.tone(55, 0.45, 'sine', 0.45 * k, 0.6, this.out);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const ctx = this.sys.ctx!;
    const t = ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.05);
    const nodes: AudioNode[] = [this.out];
    if (this.panner) nodes.push(this.panner);
    for (const s of this.sources) s.stop(t + 0.3);
    if (this.legacy) for (const o of this.legacy.oscs) o.stop(t + 0.3);
    const node = this.node;
    setTimeout(() => {
      node?.disconnect();
      for (const n of nodes) n.disconnect();
    }, 400);
  }
}

export class AudioSystem {
  ctx: Ctx | null = null;
  private master!: GainNode;
  /** everything goes through here (then the master and a compressor) */
  bus!: GainNode;
  noise!: AudioBuffer;
  /** resolves to true once the engine worklet is loaded */
  worklet: Promise<boolean> = Promise.resolve(false);
  private voices = new Map<string, EngineVoice>();
  private loops: Record<'screech' | 'wind', { gain: GainNode; filter: BiquadFilterNode; src: AudioBufferSourceNode }> | null = null;
  private tyre: { f: number; q: number; vol: number } = TYRES.street;
  muted = false;

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.bus = this.ctx.createGain();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.bus.connect(this.master).connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const ctx = this.ctx;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const url = URL.createObjectURL(new Blob([ENGINE_WORKLET], { type: 'application/javascript' }));
      this.worklet = ctx.audioWorklet.addModule(url).then(
        () => true,
        () => false,
      );
    }
    this.onUnlock?.();
  }

  /** Called once the context exists (lets a race that started silent pick its engines up). */
  onUnlock: (() => void) | null = null;

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  noiseLoop(type: BiquadFilterType, freq: number, q: number, dest: AudioNode = this.bus) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(dest);
    src.start(0, Math.random() * 1.5);
    return { gain, filter, src };
  }

  // ------------------------------------------------------------ engines

  /** Starts (or replaces) an engine voice. `full` adds turbo/nitro layers, `spatial` a panner. */
  startVoice(id: string, profile: EngineProfile, opts: { full?: boolean; spatial?: boolean } = {}) {
    if (!this.ctx) return;
    this.stopVoice(id);
    this.voices.set(id, new EngineVoice(this, profile, opts.full ?? true, opts.spatial ?? false));
  }

  hasVoice(id: string) {
    return this.voices.has(id);
  }

  updateVoice(id: string, p: VoiceParams, dt: number) {
    if (!this.ctx) return;
    this.voices.get(id)?.update(p, dt);
  }

  pop(id: string, strength: number) {
    if (!this.ctx) return;
    this.voices.get(id)?.pop(strength);
  }

  nitroStart(id: string) {
    if (!this.ctx) return;
    this.voices.get(id)?.nitroStart();
  }

  stopVoice(id: string) {
    const v = this.voices.get(id);
    if (v) {
      v.stop();
      this.voices.delete(id);
    }
  }

  /** The player's engine plus tyre screech and wind tuned to the build. */
  startEngine(profile: EngineProfile) {
    if (!this.ctx) return;
    this.startVoice('player', profile, { full: true });
    this.tyre = TYRES[profile.tires];
    this.stopLoops();
    this.loops = {
      screech: this.noiseLoop('bandpass', this.tyre.f, this.tyre.q),
      wind: this.noiseLoop('lowpass', 600, 0.5),
    };
  }

  updateEnv(p: EnvParams) {
    if (!this.ctx || !this.loops) return;
    const t = this.ctx.currentTime;
    const l = this.loops;
    l.screech.gain.gain.setTargetAtTime(p.grounded ? p.slip * 0.2 * this.tyre.vol : 0, t, 0.04);
    l.screech.filter.frequency.setTargetAtTime(this.tyre.f * (0.92 + p.slip * 0.15), t, 0.08);
    l.wind.gain.gain.setTargetAtTime(Math.min(0.35, (p.speed / 90) ** 2 * 0.35), t, 0.1);
    l.wind.filter.frequency.setTargetAtTime(300 + p.speed * 12, t, 0.1);
  }

  private stopLoops() {
    if (!this.loops || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const l of Object.values(this.loops)) {
      l.gain.gain.setTargetAtTime(0, t, 0.05);
      l.src.stop(t + 0.3);
    }
    this.loops = null;
  }

  /** Stops every engine voice and loop. */
  stopEngine() {
    for (const id of [...this.voices.keys()]) this.stopVoice(id);
    this.stopLoops();
  }

  // ------------------------------------------------------------ one-shots

  tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.25, slide = 0, dest: AudioNode = this.bus) {
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
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Filtered noise burst; `sweep` multiplies the filter frequency over the burst. */
  burst(dur: number, freq: number, vol: number, type: BiquadFilterType = 'bandpass', dest: AudioNode = this.bus, sweep = 3) {
    if (!this.ctx || vol <= 0) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + dur);
  }

  boost() {
    this.burst(0.7, 300, 0.4);
    this.tone(90, 0.5, 'sawtooth', 0.1, 2.5);
  }
  pickup() {
    this.tone(880, 0.12, 'triangle', 0.18);
    setTimeout(() => this.tone(1320, 0.18, 'triangle', 0.16), 70);
    setTimeout(() => this.burst(0.25, 5000, 0.08, 'highpass'), 40);
  }
  /** Heavier cars land with a deeper, harder thump. */
  land(strength: number, mass = 1300) {
    const k = mass / 1300;
    this.tone(70 / Math.sqrt(k), 0.25, 'sine', 0.35 * strength * Math.min(1.3, k), 0.5);
    this.burst(0.15, 200, 0.2 * strength, 'lowpass');
  }
  wall(strength: number) {
    this.burst(0.25, 900, 0.3 * strength);
  }
  /** car-to-car hit: a body thump plus a metallic crunch, scaled by strength */
  bump(strength: number) {
    const k = Math.min(1, strength);
    this.tone(55 + 30 * k, 0.18, 'sine', 0.4 * k, 0.45);
    this.burst(0.12 + 0.12 * k, 160, 0.35 * k, 'lowpass');
    this.burst(0.08 + 0.1 * k, 1600 + 900 * Math.random(), 0.22 * k);
  }
  /** A struck panel ringing: a few inharmonic partials, like sheet steel. */
  private clank(vol: number, base: number, dest: AudioNode = this.bus, delay = 0) {
    if (!this.ctx || vol <= 0.002) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    g.connect(dest);
    for (const [k, a] of [[1, 1], [2.31, 0.6], [3.87, 0.42], [5.43, 0.25]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(base * k * (0.97 + Math.random() * 0.06), t);
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 0.4);
    }
  }
  /**
   * A real crash, 0..1: the thud of the bodies, crumpling metal (a falling
   * crunch of noise) and panels ringing; big ones add a deep boom.
   */
  crash(strength: number) {
    if (!this.ctx) return;
    const k = Math.min(1, Math.max(0, strength));
    this.tone(48 + 25 * k, 0.32 + 0.3 * k, 'sine', 0.55 * k + 0.1, 0.35);
    this.burst(0.18 + 0.35 * k, 220, 0.45 * k + 0.08, 'lowpass', this.bus, 0.4);
    this.burst(0.12 + 0.3 * k, 2200 + 800 * Math.random(), 0.28 * k + 0.05, 'bandpass', this.bus, 0.25);
    const n = 1 + Math.round(k * 3);
    for (let i = 0; i < n; i++) this.clank((0.06 + 0.1 * k) / (1 + i * 0.5), 260 + Math.random() * 520, this.bus, i * (0.03 + Math.random() * 0.05));
  }
  /** Glass giving way: a hiss and a shower of little tinkles. */
  glass(strength: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const k = Math.min(1, Math.max(0.2, strength));
    this.burst(0.25 + 0.2 * k, 5200, 0.16 * k, 'highpass', this.bus, 1.2);
    const n = 5 + Math.round(k * 9);
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + 0.02 + Math.random() * (0.2 + 0.25 * k);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(3200 + Math.random() * 4200, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.035 * k, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.06 + Math.random() * 0.08);
      o.connect(g).connect(this.bus);
      o.start(t);
      o.stop(t + 0.2);
    }
  }
  /** A panel coming off and bouncing down the road. */
  clatter(strength = 0.6) {
    if (!this.ctx) return;
    const k = Math.min(1, strength);
    let d = 0;
    for (let i = 0; i < 4; i++) {
      d += 0.05 + Math.random() * 0.12;
      this.clank((0.07 * k) / (1 + i * 0.6), 380 + Math.random() * 700, this.bus, d);
    }
    this.burst(0.2, 900, 0.12 * k, 'bandpass', this.bus, 0.6);
  }
  /** Totaled: a deep whump of fuel going up, then crackling. */
  explode(strength = 1) {
    if (!this.ctx) return;
    const k = Math.min(1, strength);
    this.tone(62, 1.1, 'sine', 0.7 * k, 0.3);
    this.tone(34, 1.4, 'triangle', 0.45 * k, 0.6);
    this.burst(1.3, 380, 0.6 * k, 'lowpass', this.bus, 0.18);
    this.burst(0.6, 1600, 0.22 * k, 'bandpass', this.bus, 0.3);
    for (let i = 0; i < 6; i++) setTimeout(() => this.burst(0.05, 2500 + Math.random() * 2500, 0.08 * k), 180 + i * (90 + Math.random() * 140));
  }
  /** bodywork grinding along another car */
  scrape(strength: number) {
    this.burst(0.09, 2400 + 1200 * Math.random(), 0.1 * Math.min(1, strength));
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
  /** soft tick as the menu focus moves */
  nav() {
    this.tone(2600, 0.028, 'sine', 0.035);
  }
  /** title screen → home: a rising chime */
  start() {
    this.tone(660, 0.18, 'sine', 0.09, 1.5);
    this.tone(990, 0.32, 'sine', 0.06, 1.33);
    this.burst(0.45, 900, 0.08);
  }
  whoosh() {
    this.burst(0.5, 400, 0.18);
  }
}

export const audio = new AudioSystem();
