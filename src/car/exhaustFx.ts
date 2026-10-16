import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';

/**
 * Exhaust flames: one draw call per car for every tip.
 *
 * Each tip gets a ribbon along the jet that turns around its axis to face
 * the camera (reads well from the side) plus a stack of camera-facing discs
 * (reads well from behind, where the chase camera sits). The fragment shader
 * draws the jet procedurally: a white-hot core, standing shock diamonds,
 * turbulent noise that erodes a ragged tail, and colour that runs from
 * electric blue to violet for nitro, blue to orange for a plain boost, and
 * a short orange fireball for overrun pops. Values go above 1 so the bloom
 * pass makes them glow.
 */

const RIBBON_ROWS = 14;
const DISCS = 6;

const VERT = /* glsl */ `
  attribute vec3 aOrigin;
  attribute vec3 aInfo; // kind (0 ribbon, 1 disc), t along the jet, seed
  attribute vec2 aCorner;
  attribute float aRadius;
  uniform float uTime;
  uniform float uLen;
  uniform float uWidth;
  uniform float uIgnite;
  uniform float uPop;
  varying vec2 vUv;
  varying float vT;
  varying float vKind;
  varying float vSeed;
  varying float vSide;

  void main() {
    float kind = aInfo.x;
    float t = aInfo.y;
    float seed = aInfo.z;
    vec3 origin = (modelMatrix * vec4(aOrigin, 1.0)).xyz;
    vec3 axis = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, -1.0));
    vec3 upW = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
    vec3 sideW = normalize(cross(upW, axis));
    float len = uLen * (0.9 + 0.1 * sin(uTime * 37.0 + seed * 11.0));
    // turbulence bends the jet more and more towards the tail
    float w1 = sin(uTime * 53.0 + t * 9.0 + seed * 7.0);
    float w2 = sin(uTime * 41.0 - t * 13.0 + seed * 3.0);
    vec3 center = origin + axis * (t * len)
      + sideW * (w1 * t * t * 0.045 * len)
      + upW * (w2 * t * t * 0.035 * len + t * t * 0.04 * len);
    // radius: tight at the nozzle, swelling, then a point
    float r = aRadius * uWidth * (1.0 + 2.4 * t) * (1.0 - 0.65 * smoothstep(0.55, 1.0, t));
    r *= 1.0 + uIgnite * 2.2 * (1.0 - t) + uPop * 1.4;
    vec3 toCam = normalize(cameraPosition - center);
    vec3 pos;
    if (kind < 0.5) {
      vec3 across = cross(axis, toCam);
      float l = length(across);
      across = l > 1e-4 ? across / l : sideW;
      pos = center + across * aCorner.x * r * 1.6;
      // fade the ribbon when it is seen end-on, the discs take over there
      vSide = smoothstep(0.08, 0.45, l);
      vUv = vec2(aCorner.x, t);
    } else {
      vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      float size = r * (1.3 + t * 0.8);
      pos = center + (camR * aCorner.x + camU * aCorner.y) * size;
      vSide = 1.0 - 0.8 * smoothstep(0.2, 0.9, length(cross(axis, toCam)));
      vUv = aCorner;
    }
    vT = t;
    vKind = kind;
    vSeed = seed;
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uNitro;
  uniform float uPop;
  uniform float uIgnite;
  varying vec2 vUv;
  varying float vT;
  varying float vKind;
  varying float vSeed;
  varying float vSide;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) { return noise(p) * 0.6 + noise(p * 2.3 + 7.1) * 0.3 + noise(p * 5.1 + 3.7) * 0.1; }

  vec3 palette(float t) {
    // plain boost: blue flame at the nozzle turning orange
    vec3 boost = mix(vec3(0.3, 0.55, 2.2), vec3(2.4, 0.7, 0.12), smoothstep(0.1, 0.6, t));
    // nitro: white-hot, electric blue, then violet and magenta at the tail
    vec3 nitro = mix(vec3(0.12, 0.42, 2.6), vec3(1.1, 0.12, 2.2), smoothstep(0.2, 0.8, t));
    vec3 c = mix(boost, nitro, uNitro);
    // overrun pop: a short orange fireball
    return mix(c, vec3(3.2, 1.3, 0.3), uPop * (1.0 - uNitro * 0.5));
  }

  void main() {
    float t = vT;
    float a;
    vec3 col;
    if (vKind < 0.5) {
      float s = vUv.x;
      float n = fbm(vec2(s * 2.2 + vSeed * 5.0, t * 6.0 - uTime * 11.0));
      float body = pow(max(0.0, 1.0 - abs(s)), 1.7);
      float coreW = 0.22 * (1.0 - 0.6 * t);
      float core = exp(-(s * s) / (coreW * coreW)) * (1.0 - smoothstep(0.0, 0.7, t));
      // standing shock diamonds in the core of a nitro jet
      float dia = pow(0.5 + 0.5 * cos((t * 4.2 - 0.12) * 6.2831), 10.0);
      dia *= exp(-(s * s) / 0.09) * (1.0 - smoothstep(0.05, 0.7, t)) * uNitro;
      float erode = 1.0 - smoothstep(0.42, 1.0, t + (n - 0.5) * 0.55);
      float lick = 0.65 + 0.7 * n;
      a = (body * 0.5 * lick + core * 0.85 + dia * 1.6) * erode * smoothstep(0.0, 0.04, t);
      col = mix(palette(t), vec3(1.9, 2.2, 3.0), clamp(core * 0.55 + dia * 0.8, 0.0, 1.0));
    } else {
      float r = length(vUv);
      float g = exp(-r * r * 5.0) * max(0.0, 1.0 - r);
      a = g * (0.28 - t * 0.2) * (1.0 + uIgnite * 4.0);
      col = mix(palette(t * 0.9), vec3(1.9, 2.2, 3.0), (1.0 - t) * 0.3 + uIgnite * 0.5);
    }
    a *= uIntensity * vSide;
    gl_FragColor = vec4(col * a, 1.0);
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform float uGlow;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 d = (vUv - vec2(0.5, 0.62)) * vec2(1.6, 1.0);
    float g = exp(-dot(d, d) * 9.0);
    gl_FragColor = vec4(uColor * g * uGlow, 1.0);
  }
`;

function flameGeometry(tips: Vector3[]): BufferGeometry {
  const origin: number[] = [];
  const info: number[] = [];
  const corner: number[] = [];
  const radius: number[] = [];
  const index: number[] = [];
  const single = tips.length <= 2 && tips.every((t) => Math.abs(t.x) < 0.2);
  const r = tips.length >= 4 ? 0.045 : single ? 0.07 : 0.055;
  let v = 0;
  tips.forEach((tip, k) => {
    const seed = k * 0.37 + 0.11;
    const push = (kind: number, t: number, cx: number, cy: number) => {
      origin.push(tip.x, tip.y, tip.z);
      info.push(kind, t, seed);
      corner.push(cx, cy);
      radius.push(r);
    };
    // ribbon
    for (let i = 0; i <= RIBBON_ROWS; i++) {
      const t = i / RIBBON_ROWS;
      push(0, t, -1, 0);
      push(0, t, 1, 0);
      if (i < RIBBON_ROWS) {
        const a = v + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    v += (RIBBON_ROWS + 1) * 2;
    // discs
    for (let d = 0; d < DISCS; d++) {
      const t = (d / (DISCS - 1)) * 0.6;
      push(1, t, -1, -1);
      push(1, t, 1, -1);
      push(1, t, 1, 1);
      push(1, t, -1, 1);
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
  });
  const g = new BufferGeometry();
  // three needs a position attribute; the shader builds the real positions
  g.setAttribute('position', new BufferAttribute(new Float32Array(origin), 3));
  g.setAttribute('aOrigin', new BufferAttribute(new Float32Array(origin), 3));
  g.setAttribute('aInfo', new BufferAttribute(new Float32Array(info), 3));
  g.setAttribute('aCorner', new BufferAttribute(new Float32Array(corner), 2));
  g.setAttribute('aRadius', new BufferAttribute(new Float32Array(radius), 1));
  g.setIndex(index);
  return g;
}

const NITRO_GLOW = new Color(0.15, 0.4, 1.6);
const BOOST_GLOW = new Color(1.6, 0.6, 0.25);

export class ExhaustFx {
  readonly flames: Mesh;
  readonly glow: Mesh;
  private mat: ShaderMaterial;
  private glowMat: ShaderMaterial;
  private popEnv = 0;
  private igniteEnv = 0;

  constructor(readonly tips: Vector3[]) {
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uLen: { value: 1 },
        uWidth: { value: 1 },
        uIntensity: { value: 0 },
        uNitro: { value: 0 },
        uPop: { value: 0 },
        uIgnite: { value: 0 },
      },
    });
    this.flames = new Mesh(flameGeometry(tips), this.mat);
    this.flames.frustumCulled = false;
    this.flames.visible = false;
    this.flames.renderOrder = 2;

    // the jet's light pooled on the deck behind the car
    const gg = new PlaneGeometry(2.6, 3.6);
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
    const z = tips.length ? Math.min(...tips.map((t) => t.z)) : -2.2;
    this.glow.position.set(0, 0.04, z - 1.2);
    this.glow.visible = false;
    this.glow.renderOrder = 1;
  }

  /** A backfire through the pipes (0..1). */
  pop(strength: number) {
    this.popEnv = Math.max(this.popEnv, strength);
  }

  /** The nitro has just been lit. */
  ignite() {
    this.igniteEnv = 1;
  }

  /** boost and nitro are the smoothed 0..1 intensities. */
  update(dt: number, time: number, boost: number, nitro: number) {
    this.popEnv *= Math.exp(-dt * 16);
    this.igniteEnv *= Math.exp(-dt * 7);
    const pop = this.popEnv;
    const u = this.mat.uniforms;
    const intensity = Math.min(1.2, Math.max(boost, nitro * 1.15, pop * 0.9));
    const flicker = 0.85 + 0.15 * Math.sin(time * 61) * Math.sin(time * 23 + 1);
    u.uTime.value = time;
    u.uIntensity.value = intensity * flicker;
    u.uNitro.value = Math.min(1, nitro * 1.2);
    u.uPop.value = Math.min(1, pop * 1.2);
    u.uIgnite.value = this.igniteEnv * nitro;
    u.uLen.value = 0.25 + boost * 1.0 + nitro * 1.55 + pop * 0.55 + this.igniteEnv * nitro * 0.8;
    u.uWidth.value = 1 + nitro * 0.25;
    this.flames.visible = intensity > 0.01;
    const glow = Math.max(nitro, boost * 0.6, pop * 0.4);
    this.glowMat.uniforms.uGlow.value = glow * flicker * (1 + this.igniteEnv);
    this.glowMat.uniforms.uColor.value.copy(BOOST_GLOW).lerp(NITRO_GLOW, Math.min(1, nitro * 1.5 + 0.2 * (1 - pop)));
    this.glow.visible = glow > 0.01;
  }

  dispose() {
    this.flames.geometry.dispose();
    this.glow.geometry.dispose();
    this.mat.dispose();
    this.glowMat.dispose();
  }
}
