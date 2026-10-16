/**
 * The engine synthesiser, run on the audio thread as an AudioWorklet.
 *
 * Model: a crank phasor drives one combustion pulse per cylinder firing
 * (with per-firing randomness, misfires and an ignition cut), each bank
 * feeds its own exhaust pipe (a damped waveguide), then a body resonance,
 * a throttle-dependent muffler, a soft clipper and some intake roar.
 * It is plain JS in a string so it can be loaded from a Blob URL without
 * any bundler support, and evaluated in tests.
 */
export const ENGINE_WORKLET = /* js */ `
const PI = Math.PI;

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
  lowpass(f, q, sr) {
    const w = 2 * PI * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  highpass(f, q, sr) {
    const w = 2 * PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  bandpass(f, q, sr) {
    const w = 2 * PI * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  peak(f, q, db, sr) {
    const A = Math.pow(10, db / 40), w = 2 * PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Exhaust pipe: a delay line with an inverting, damped reflection at the open end. */
class Pipe {
  constructor(len) { this.buf = new Float32Array(len); this.n = len; this.i = 0; this.lp = 0; }
  run(x, delay, fb, damp) {
    let r = this.i - delay;
    if (r < 0) r += this.n;
    const r0 = Math.floor(r), fr = r - r0;
    const a = this.buf[r0], b = this.buf[(r0 + 1) % this.n];
    this.lp += damp * (a + (b - a) * fr - this.lp);
    const y = x + fb * this.lp;
    this.buf[this.i] = y;
    this.i = (this.i + 1) % this.n;
    return y;
  }
}

class HyperdriftEngine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'nitro', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'limiter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const p = options.processorOptions;
    this.p = p;
    this.sr = sampleRate;
    this.nf = p.fires.length;
    this.fires = Float32Array.from(p.fires);
    this.banks = Uint8Array.from(p.banks);
    this.amp = new Float32Array(this.nf).fill(0.5);
    // fixed cylinder-to-cylinder imbalance: gives the cycle-rate growl real engines have
    this.cyl = new Float32Array(this.nf);
    for (let i = 0; i < this.nf; i++) this.cyl[i] = 1 + Math.sin(i * 12.9898 + p.fires.length * 3.1) * p.imbalance;
    this.prevX = new Float32Array(this.nf).fill(0.999);
    this.phase = 0;
    this.rpm = p.idleRpm;
    this.thr = 0;
    this.nit = 0;
    this.gs = 0;
    this.limT = 0;
    this.limCut = 0;
    this.popEnv = 0;
    this.popQ = 0;
    this.seed = 12345 + Math.floor(Math.random() * 1000);
    const maxDelay = Math.ceil(this.sr / 40) + 4;
    this.pipes = [new Pipe(maxDelay), new Pipe(maxDelay)];
    this.body = new Biquad();
    this.body.peak(p.bodyHz, 1.1, p.bodyGain, this.sr);
    this.muffler = new Biquad();
    this.muffler2 = new Biquad();
    this.dc = new Biquad();
    this.dc.highpass(28, 0.7, this.sr);
    this.intakeBp = new Biquad();
    this.port.onmessage = (e) => {
      if (e.data && e.data.pop) this.popQ = Math.max(this.popQ, e.data.pop);
    };
  }

  rnd() {
    // xorshift, cheap and allocation-free
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s;
    return ((s >>> 0) / 4294967296);
  }

  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const p = this.p;
    const sr = this.sr;
    const targetGain = params.gain[0];
    if (targetGain < 1e-4 && this.gs < 1e-4) {
      out.fill(0);
      this.gs = 0;
      return true;
    }
    const tRpm = params.rpm[0] * params.pitch[0];
    const tThr = params.throttle[0];
    const tNit = params.nitro[0];
    const cut = params.cut[0] > 0.5;
    const limiter = params.limiter[0] > 0.5;

    // per-block filter updates
    const rpmFrac = Math.min(1.2, this.rpm / p.redline);
    const cutoff = p.muffler * (0.45 + 0.55 * this.thr) * (0.75 + rpmFrac * 1.3) * (1 + this.nit * 0.5);
    this.muffler.lowpass(cutoff, 0.85, sr);
    this.muffler2.lowpass(cutoff * 1.6, 0.6, sr);
    this.intakeBp.bandpass(700 + rpmFrac * 2200, 1.4, sr);

    const pw = p.pulseWidth;
    const nf = this.nf;
    const pipeDelay0 = sr / (2 * p.pipeHz[0]);
    const pipeDelay1 = sr / (2 * p.pipeHz[1]);
    const fb = p.pipeFeedback;
    const drive = p.drive * (1 + this.nit * 0.7);
    const norm = 1 / Math.tanh(drive * 0.6);
    const sharp = Math.min(1, this.thr * 0.8 + this.nit * 0.4);

    for (let s = 0; s < n; s++) {
      this.rpm += (tRpm * (1 - this.limCut * 0.04) - this.rpm) * 0.0012;
      this.thr += (tThr - this.thr) * 0.004;
      this.nit += (tNit - this.nit) * 0.002;
      this.gs += (targetGain - this.gs) * 0.002;

      // rev limiter: hard fuel cut bouncing at ~12 Hz
      if (limiter) {
        this.limT += 1 / sr;
        if (this.limT > 0.042) { this.limT = 0; this.limCut = this.limCut ? 0 : 1; }
      } else { this.limCut = 0; this.limT = 0; }
      const ignition = !(cut || this.limCut);

      this.phase += this.rpm / 120 / sr;
      if (this.phase >= 1) this.phase -= 1;

      let exA = 0, exB = 0, pulseSum = 0;
      for (let i = 0; i < nf; i++) {
        let x = this.phase - this.fires[i];
        if (x < 0) x += 1;
        if (x < this.prevX[i]) {
          // a new firing for this cylinder
          const load = 0.3 + 0.7 * this.thr;
          let a = ignition ? load * (1 + this.nit * 0.35) : 0.07;
          const idleish = Math.max(0, 1 - rpmFrac * 2.5) * (1 - this.thr * 0.7);
          a *= 1 + (this.rnd() * 2 - 1) * p.rough * (0.45 + idleish);
          if (ignition && this.rnd() < p.misfire * idleish) a *= 0.15;
          this.amp[i] = a * this.cyl[i];
        }
        this.prevX[i] = x;
        const u = x * nf / pw;
        if (u < 2) {
          // alpha-function pulse, sharpened under load for a harder, raspier edge
          const k = 4 * u;
          const v1 = k * Math.exp(1 - k);
          const v = this.amp[i] * (v1 + (v1 * v1 * v1 - v1) * sharp);
          const nz = (this.rnd() * 2 - 1) * p.noise * (0.4 + this.thr * 0.6 + this.nit);
          const e = v * (1 + nz);
          if (this.banks[i]) exB += e; else exA += e;
          pulseSum += v;
        }
      }

      // overrun pop / backfire: a sharp, noisy bang down the pipes
      if (this.popQ > 0) { this.popEnv = Math.max(this.popEnv, this.popQ); this.popQ = 0; }
      if (this.popEnv > 1e-3) {
        const bang = this.popEnv * (0.6 + (this.rnd() * 2 - 1) * 1.4) * 2.2;
        exA += bang;
        exB += bang * 0.8;
        this.popEnv *= 0.9965;
      }

      const a = this.pipes[0].run(exA, pipeDelay0, fb, 0.55);
      const b = this.pipes[1].run(exB, pipeDelay1, fb, 0.5);
      let y = (a + b) * 0.5;
      y = this.body.run(y);
      y = this.muffler2.run(this.muffler.run(y));
      y = this.dc.run(y);
      y = Math.tanh(y * drive * 0.6) * norm * 0.5;

      // intake roar: band-limited noise breathing with the pulses
      const inn = this.intakeBp.run((this.rnd() * 2 - 1)) * p.intake * this.thr * (0.2 + rpmFrac) * (0.5 + pulseSum * 0.5);
      out[s] = (y + inn * 0.6) * p.level * this.gs;
    }
    return true;
  }
}

registerProcessor('hyperdrift-engine', HyperdriftEngine);
`;
