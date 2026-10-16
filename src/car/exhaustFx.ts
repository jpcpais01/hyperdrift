import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Data3DTexture,
  FrontSide,
  LinearFilter,
  Matrix4,
  Mesh,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  Vector4,
  type Camera,
} from 'three';

/**
 * Volumetric exhaust jets, one draw call per car for every tip.
 *
 * Each tip gets a small box hugging its jet. The fragment shader marches a
 * ray through that box and integrates a turbulent emissive gas: a density
 * field shaped like a real jet (tight at the nozzle, swelling, then torn
 * apart at the tail), advected through a tiling 3D noise texture so the gas
 * visibly streams out, with a white-hot core, standing shock diamonds and
 * mild self-absorption so it has depth from every angle. The burn is never
 * steady: each pipe surges on a random envelope (big flaring bursts, low
 * sputters where the gas breaks into separate chunks), ignition overshoots,
 * and cutting the nitro blows a detached cloud off before the pipes crackle.
 * Colour runs from
 * white-cyan through electric blue to violet for nitro, blue to orange for a
 * plain boost, and an orange fireball for overrun pops. Cost is a fixed 16
 * steps over the few pixels the jets cover, with two texture taps per step.
 */

const STEPS = 16;
const NOISE_SIZE = 32;

/** Tiling 3D value-noise fbm, built once (32 KB). */
let noiseTex: Data3DTexture | null = null;
function noiseTexture(): Data3DTexture {
  if (noiseTex) return noiseTex;
  const N = NOISE_SIZE;
  const octave = (period: number, seed: number) => {
    const g = new Float32Array(period * period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) {
      s = (s * 16807) % 2147483647;
      g[i] = s / 2147483647;
    }
    const at = (x: number, y: number, z: number) => g[((z % period) * period + (y % period)) * period + (x % period)];
    const sm = (t: number) => t * t * (3 - 2 * t);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    const out = new Float32Array(N * N * N);
    for (let z = 0; z < N; z++)
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * period;
          const fy = (y / N) * period;
          const fz = (z / N) * period;
          const x0 = Math.floor(fx);
          const y0 = Math.floor(fy);
          const z0 = Math.floor(fz);
          const u = sm(fx - x0);
          const v = sm(fy - y0);
          const w = sm(fz - z0);
          const c00 = l(at(x0, y0, z0), at(x0 + 1, y0, z0), u);
          const c10 = l(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), u);
          const c01 = l(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), u);
          const c11 = l(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), u);
          out[(z * N + y) * N + x] = l(l(c00, c10, v), l(c01, c11, v), w);
        }
    return out;
  };
  const a = octave(4, 7);
  const b = octave(8, 13);
  const c = octave(16, 29);
  const data = new Uint8Array(N * N * N);
  for (let i = 0; i < data.length; i++) data[i] = Math.round((a[i] * 0.55 + b[i] * 0.3 + c[i] * 0.15) * 255);
  const t = new Data3DTexture(data, N, N, N);
  t.format = RedFormat;
  t.type = UnsignedByteType;
  t.minFilter = t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  noiseTex = t;
  return t;
}

const VERT = /* glsl */ `
  attribute vec3 aOrigin;
  attribute vec3 aCorner; // x, y in -1..1, z in 0..1 (along the jet)
  attribute vec3 aInfo; // nozzle radius, seed, tip index
  uniform float uLen;
  uniform vec4 uSurge; // per-tip surge (1 = steady)
  uniform float uDetach;
  uniform float uWidth;
  uniform float uIgnite;
  uniform float uPop;
  uniform vec3 uCamLocal;
  varying vec3 vPos;
  varying vec3 vCam;
  varying vec3 vBox; // half width, length, nozzle radius
  varying float vSeed;
  varying float vFloor;
  varying float vSurge;
  varying float vLen;

  void main() {
    float s = dot(uSurge, vec4(equal(vec4(aInfo.z), vec4(0.0, 1.0, 2.0, 3.0))));
    vSurge = s;
    // a surge stretches the jet a lot and fattens it a little
    vLen = uLen * (0.4 + 0.6 * s) * (1.0 + uDetach * 0.7);
    float r0 = aInfo.x * uWidth * (0.78 + 0.22 * s);
    float H = r0 * (4.0 + uIgnite * 2.6 + uPop * 1.8) + 0.05;
    float L = vLen * 1.08 + 0.1;
    // jet space: x/y across, +z out of the nozzle (the car's -z)
    vec3 pj = vec3(aCorner.xy * H, aCorner.z * L - 0.04);
    vPos = pj;
    vec3 c = uCamLocal - aOrigin;
    vCam = vec3(c.x, c.y, -c.z);
    vBox = vec3(H, L, r0);
    vSeed = aInfo.y;
    vFloor = aOrigin.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aOrigin + vec3(pj.x, pj.y, -pj.z), 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp sampler3D;
  uniform sampler3D uNoise;
  uniform float uTime;
  uniform float uLen;
  uniform float uIntensity;
  uniform float uNitro;
  uniform float uPop;
  uniform float uIgnite;
  uniform float uDetach;
  varying vec3 vPos;
  varying vec3 vCam;
  varying vec3 vBox;
  varying float vSeed;
  varying float vFloor; // nozzle height above the road
  varying float vSurge;
  varying float vLen;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  // heat 0..~1.5 to emitted light (HDR, so bloom picks the hot parts up)
  vec3 palette(float heat) {
    vec3 nCold = vec3(0.75, 0.12, 1.9);
    vec3 nMid = vec3(0.12, 0.48, 2.5);
    vec3 nHot = vec3(1.5, 2.1, 3.0);
    vec3 bCold = vec3(2.3, 0.55, 0.08);
    vec3 bMid = vec3(0.3, 0.5, 2.0);
    vec3 bHot = vec3(1.9, 2.0, 2.6);
    float m = smoothstep(0.04, 0.38, heat);
    float h = smoothstep(0.55, 1.15, heat);
    vec3 n = mix(mix(nCold, nMid, m), nHot, h);
    vec3 b = mix(mix(bCold, bMid, m), bHot, h);
    vec3 c = mix(b, n, uNitro);
    return mix(c, vec3(3.0, 1.15, 0.22) * (0.5 + heat), uPop * (1.0 - 0.6 * uNitro));
  }

  void main() {
    vec3 ro = vCam;
    vec3 rd = normalize(vPos - vCam);
    // ray / box slabs (guarded against division by zero)
    vec3 srd = vec3(rd.x >= 0.0 ? 1.0 : -1.0, rd.y >= 0.0 ? 1.0 : -1.0, rd.z >= 0.0 ? 1.0 : -1.0);
    vec3 inv = srd / max(abs(rd), vec3(1e-5));
    vec3 bmin = vec3(-vBox.x, -vBox.x, -0.04);
    vec3 bmax = vec3(vBox.x, vBox.x, vBox.y);
    vec3 t1 = (bmin - ro) * inv;
    vec3 t2 = (bmax - ro) * inv;
    vec3 tmin = min(t1, t2);
    vec3 tmax = max(t1, t2);
    float tn = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
    float tf = min(min(tmax.x, tmax.y), tmax.z);
    if (tf <= tn) discard;

    float ds = (tf - tn) / float(${STEPS});
    float jitter = hash(gl_FragCoord.xy + vSeed * 17.0);
    float r0 = vBox.z;
    float L = max(vLen, 0.05);
    float sg = vSurge;
    // emission per metre, normalised to the nozzle size; bursts burn hotter, sputters dimmer
    float k = 0.32 / r0 * (0.4 + 0.6 * sg);
    // more pressure pushes the shock diamonds further apart
    float spacing = (0.26 + 0.07 * L) * (0.8 + 0.2 * sg);
    // a low surge chokes the flow: the jet breaks up into separate puffs
    float choke = clamp((0.95 - sg) * 1.6, 0.0, 1.0);
    vec3 acc = vec3(0.0);
    float T = 1.0;
    for (int i = 0; i < ${STEPS}; i++) {
      vec3 p = ro + rd * (tn + (float(i) + jitter) * ds);
      float z = p.z;
      float tz = z / L;
      if (tz > 1.08 || z < -0.02) continue;
      float tzc = max(tz, 0.0);
      // the jet whips about more and more towards its tail and lifts a little with the heat
      float wob = tzc * tzc * L;
      vec2 c = vec2(sin(uTime * 47.0 + z * 6.0 + vSeed * 7.0) * 0.05, sin(uTime * 39.0 - z * 8.0 + vSeed * 3.0) * 0.035 + 0.04) * wob;
      vec2 q = p.xy - c;
      float r = r0 * (1.0 + 2.3 * tzc) * (1.0 - 0.6 * smoothstep(0.55, 1.0, tzc));
      r *= 1.0 + uIgnite * 2.2 * (1.0 - tzc) + uPop * 1.4;
      // pressure waves travelling down the plume make it bulge and pinch
      r *= 1.0 + 0.2 * tzc * sin(z * 5.0 - uTime * 31.0 + vSeed * 9.0);
      float d = length(q) / r;
      if (d > 1.7) continue;
      // gas streaming out of the nozzle: noise advected along +z
      vec3 nq = vec3(q / (r0 * 5.0), z * 0.9 - uTime * 4.2) + vSeed;
      float n1 = texture(uNoise, nq * 0.5).r;
      float n2 = texture(uNoise, vec3(nq.xy * 2.3, nq.z * 2.1 - uTime * 3.1) + 0.37).r;
      float n = n1 * 0.62 + n2 * 0.38;
      float edge = d + (n - 0.5) * (0.4 + 1.1 * tzc);
      float dens = 1.0 - smoothstep(0.25, 1.0, edge);
      dens *= 1.0 - smoothstep(0.62, 1.05, tzc + (n - 0.5) * 0.45);
      dens *= smoothstep(-0.02, 0.04, z);
      // gas chunks shooting out: mild in the tail always, the whole jet when it sputters
      float band = 0.5 + 0.5 * sin(z * 9.0 - uTime * 44.0 + vSeed * 11.0 + n * 4.0);
      float brk = max(choke * smoothstep(0.0, 0.2, tzc), 0.45 * smoothstep(0.35, 0.9, tzc));
      dens *= mix(1.0, smoothstep(0.3, 0.75, band), brk);
      // nitro cut: the last cloud flies off and leaves the nozzle dark behind it
      float cutZ = uDetach * L * 0.95;
      dens *= 1.0 - (1.0 - smoothstep(cutZ - 0.05, cutZ + 0.25, z)) * step(0.001, uDetach);
      // soft contact with the road: the gas thins out as it nears the deck instead of being cut by it
      dens *= smoothstep(0.0, 0.16, p.y + vFloor);
      if (dens <= 0.001) continue;
      float core = exp(-d * d * 6.0) * (1.0 - smoothstep(0.0, 0.8, tzc));
      // standing shock diamonds: bright knots at fixed spacing in the core
      float wave = max(0.5 + 0.5 * cos(6.2831 * z / spacing - 1.2), 0.0);
      float dia = pow(wave, 10.0) * exp(-d * d * 7.0) * (1.0 - smoothstep(0.05, 0.7, tzc)) * uNitro;
      float ign = uIgnite * exp(-(d * d + tzc * tzc * 30.0) * 1.5);
      float heat = clamp((core * 1.05 + dia * 1.3) * (0.75 + 0.25 * sg) + (1.0 - tzc) * 0.22 + ign, 0.0, 1.5);
      vec3 e = palette(heat) * dens * (0.45 + 1.15 * n) + vec3(1.6, 1.9, 2.4) * (dia * 2.4 + ign * 2.0) * dens;
      acc += T * e * (k * ds);
      T *= exp(-dens * ds * 5.0);
    }
    vec3 col = acc * uIntensity;
    col = min(max(col, vec3(0.0)), vec3(60.0));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform float uGlow;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    // soft pool that reaches exactly zero well inside the quad, so it never shows an edge
    vec2 d = (vUv - 0.5) * vec2(2.0, 2.0);
    float r2 = dot(d, d);
    float g = (exp(-r2 * 3.5) - exp(-3.5)) / (1.0 - exp(-3.5));
    g *= 1.0 - smoothstep(0.55, 1.0, sqrt(r2));
    gl_FragColor = vec4(uColor * max(g, 0.0) * uGlow, 1.0);
  }
`;

// unit box: 8 corners, x/y in -1..1, z in 0..1
const BOX = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
// outward-facing triangles (counter-clockwise seen from outside), in jet space
const BOX_TRIS = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

function jetGeometry(tips: Vector3[]): BufferGeometry {
  const origin: number[] = [];
  const corner: number[] = [];
  const info: number[] = [];
  const index: number[] = [];
  const single = tips.length <= 2 && tips.every((t) => Math.abs(t.x) < 0.2);
  const r = tips.length >= 4 ? 0.045 : single ? 0.07 : 0.055;
  tips.forEach((tip, k) => {
    const base = k * 8;
    for (let i = 0; i < 8; i++) {
      origin.push(tip.x, tip.y, tip.z);
      corner.push(BOX[i * 3], BOX[i * 3 + 1], BOX[i * 3 + 2]);
      info.push(r, k * 0.37 + 0.11, k % 4);
    }
    // jet space flips z, which mirrors the box: swap the winding back
    for (let i = 0; i < BOX_TRIS.length; i += 3) index.push(base + BOX_TRIS[i], base + BOX_TRIS[i + 2], base + BOX_TRIS[i + 1]);
  });
  const g = new BufferGeometry();
  // three needs a position attribute; the shader builds the real positions
  g.setAttribute('position', new BufferAttribute(new Float32Array(origin), 3));
  g.setAttribute('aOrigin', new BufferAttribute(new Float32Array(origin), 3));
  g.setAttribute('aCorner', new BufferAttribute(new Float32Array(corner), 3));
  g.setAttribute('aInfo', new BufferAttribute(new Float32Array(info), 3));
  g.setIndex(index);
  return g;
}

const NITRO_GLOW = new Color(0.15, 0.4, 1.6);
const BOOST_GLOW = new Color(1.6, 0.6, 0.25);
const _inv = new Matrix4();

export class ExhaustFx {
  readonly flames: Mesh;
  readonly glow: Mesh;
  /** how hard the nitro is surging right now (1 = steady); the camera and screen ride it */
  surge = 1;
  /** jumps up when a big burst kicks in; whoever reads it decays it */
  kick = 0;
  private mat: ShaderMaterial;
  private glowMat: ShaderMaterial;
  private popEnv = 0;
  private igniteEnv = 0;
  // the shared surge (the whole bottle pulsing) and each pipe's own wobble on top
  private master = 1;
  private masterTarget = 1;
  private masterTimer = 0;
  private tipVal = [1, 1, 1, 1];
  private tipTarget = [1, 1, 1, 1];
  private tipTimer = [0, 0, 0, 0];
  private detach = 0;
  private crackles: { t: number; s: number }[] = [];
  private fired: number[] = [];
  private glowZ = 0;

  constructor(readonly tips: Vector3[]) {
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: FrontSide,
      blending: AdditiveBlending,
      uniforms: {
        uNoise: { value: noiseTexture() },
        uTime: { value: 0 },
        uLen: { value: 1 },
        uWidth: { value: 1 },
        uIntensity: { value: 0 },
        uNitro: { value: 0 },
        uPop: { value: 0 },
        uIgnite: { value: 0 },
        uDetach: { value: 0 },
        uSurge: { value: new Vector4(1, 1, 1, 1) },
        uCamLocal: { value: new Vector3() },
      },
    });
    this.flames = new Mesh(jetGeometry(tips), this.mat);
    this.flames.frustumCulled = false;
    this.flames.visible = false;
    this.flames.renderOrder = 2;
    // the march runs in the car's space: hand it the camera there, per render
    const camLocal = this.mat.uniforms.uCamLocal.value as Vector3;
    this.flames.onBeforeRender = (_r, _s, camera: Camera) => {
      camLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv.copy(this.flames.matrixWorld).invert());
    };

    // the jet's light pooled on the deck behind the car
    const gg = new PlaneGeometry(3.0, 4.4);
    gg.rotateX(-Math.PI / 2);
    this.glowMat = new ShaderMaterial({
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uGlow: { value: 0 }, uColor: { value: new Color() } },
    });
    this.glow = new Mesh(gg, this.glowMat);
    this.glowZ = tips.length ? Math.min(...tips.map((t) => t.z)) : -2.2;
    this.glow.position.set(0, 0.04, this.glowZ - 1.4);
    this.glow.visible = false;
    this.glow.renderOrder = 1;
  }

  /** A backfire through the pipes (0..1). */
  pop(strength: number) {
    this.popEnv = Math.max(this.popEnv, strength);
  }

  /** The nitro has just been lit: it flares way past its steady size first. */
  ignite() {
    this.igniteEnv = 1;
    this.master = Math.max(this.master, 1.3);
    this.masterTarget = 2.2;
    this.masterTimer = 0.28;
    this.kick = 1;
  }

  /** The nitro has been shut off: the last cloud blows away, then the hot pipes crackle. */
  cutoff() {
    this.detach = 0.001;
    this.popEnv = Math.max(this.popEnv, 0.5);
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.crackles.push({ t: 0.36 + Math.random() * 0.6, s: 0.4 + Math.random() * 0.55 });
  }

  /** Backfires the jets fired on their own since the last call (for sound and sparks). */
  takePops(): number[] {
    if (!this.fired.length) return this.fired;
    const out = this.fired;
    this.fired = [];
    return out;
  }

  private stepSurge(dt: number, live: boolean) {
    if (!live) {
      this.master += (1 - this.master) * (1 - Math.exp(-6 * dt));
      for (let i = 0; i < 4; i++) this.tipVal[i] = this.master;
      return;
    }
    this.masterTimer -= dt;
    if (this.masterTimer <= 0) {
      const r = Math.random();
      if (r < 0.14) {
        // sputter: the flow chokes for a moment
        this.masterTarget = 0.12 + Math.random() * 0.2;
        this.masterTimer = 0.05 + Math.random() * 0.1;
      } else if (r < 0.34) {
        // a big burst
        this.masterTarget = 1.5 + Math.random() * 0.6;
        this.masterTimer = 0.12 + Math.random() * 0.22;
        this.kick = Math.max(this.kick, this.masterTarget - 1);
      } else {
        this.masterTarget = 0.55 + Math.random() * 0.8;
        this.masterTimer = 0.07 + Math.random() * 0.25;
      }
    }
    // bursts slam in, then sag back
    const rate = this.masterTarget > this.master ? 24 : 10;
    this.master += (this.masterTarget - this.master) * (1 - Math.exp(-rate * dt));
    for (let i = 0; i < 4; i++) {
      this.tipTimer[i] -= dt;
      if (this.tipTimer[i] <= 0) {
        this.tipTarget[i] = 0.72 + Math.random() * 0.56;
        this.tipTimer[i] = 0.04 + Math.random() * 0.12;
      }
      const t = this.master * this.tipTarget[i];
      this.tipVal[i] += (t - this.tipVal[i]) * (1 - Math.exp(-28 * dt));
    }
  }

  /** boost and nitro are the smoothed 0..1 intensities. */
  update(dt: number, time: number, boost: number, nitro: number) {
    this.popEnv *= Math.exp(-dt * 16);
    this.igniteEnv *= Math.exp(-dt * 6);
    for (let i = this.crackles.length - 1; i >= 0; i--) {
      const c = this.crackles[i];
      c.t -= dt;
      if (c.t <= 0) {
        this.pop(c.s);
        this.fired.push(c.s);
        this.crackles.splice(i, 1);
      }
    }
    if (this.detach > 0) {
      this.detach += dt / 0.32;
      if (this.detach >= 1) this.detach = 0;
    }
    this.stepSurge(dt, nitro > 0.05 || boost > 0.05);
    // how much the random surging shows: all of it under nitro, a touch on a plain boost
    const wild = Math.min(1, nitro * 1.2 + boost * 0.35);
    const sv = this.mat.uniforms.uSurge.value as Vector4;
    const s = (i: number) => 1 + (this.tipVal[i] - 1) * wild;
    sv.set(s(0), s(1), s(2), s(3));
    this.surge = 1 + (this.master - 1) * wild;
    const pop = this.popEnv;
    const u = this.mat.uniforms;
    const intensity = Math.min(1.2, Math.max(boost, nitro * 1.15, pop * 0.9));
    const flicker = 0.84 + 0.16 * Math.sin(time * 61) * Math.sin(time * 23 + 1);
    // wrap the clock so texture coordinates keep their precision in long sessions
    u.uTime.value = time % 200;
    u.uIntensity.value = intensity * flicker;
    u.uNitro.value = Math.min(1, nitro * 1.2);
    u.uPop.value = Math.min(1, pop * 1.2);
    u.uIgnite.value = this.igniteEnv * nitro;
    u.uDetach.value = this.detach;
    u.uLen.value = (0.25 + boost * 1.0 + nitro * 1.55 + pop * 0.55 + this.igniteEnv * nitro * 1.1) * (0.94 + 0.06 * Math.sin(time * 37));
    u.uWidth.value = 1 + nitro * 0.25;
    this.flames.visible = intensity > 0.01;
    // the light on the road breathes with the surges and flashes on ignition
    const glow = Math.max(nitro * (0.45 + 0.55 * this.surge), boost * 0.6, pop * 0.4);
    this.glowMat.uniforms.uGlow.value = glow * 0.85 * flicker * (1 + this.igniteEnv * 1.6);
    this.glowMat.uniforms.uColor.value.copy(BOOST_GLOW).lerp(NITRO_GLOW, Math.min(1, nitro * 1.5 + 0.2 * (1 - pop)));
    const stretch = 1 + nitro * (0.1 + 0.3 * (Math.min(2, this.surge) - 1) + this.igniteEnv * 0.3);
    this.glow.scale.set(1, 1, stretch);
    this.glow.position.z = this.glowZ - 1.4 * stretch;
    this.glow.visible = glow > 0.01;
  }

  dispose() {
    this.flames.geometry.dispose();
    this.glow.geometry.dispose();
    this.mat.dispose();
    this.glowMat.dispose();
  }
}
