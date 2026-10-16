import { AdditiveBlending, BoxGeometry, Color, Mesh, PlaneGeometry, ShaderMaterial, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { paintById, underglowColorById, type CarBuild } from './parts';
import { SKELETON } from './skeleton';

/**
 * Underglow: LED tubes tucked under the sills and bumpers, and the light they
 * throw on the road. Both share one pattern function so the pool on the deck
 * always matches the tubes: a steady neon, a heartbeat pulse, comets chasing
 * round the car, a flowing rainbow, or a reactive mode that runs faster and
 * brighter with speed and flares white-hot on nitro.
 *
 * Two draw calls per car. The pool is a soft rounded-rectangle falloff that
 * reaches exactly zero well inside its quad, so it never shows an edge.
 */

export const UNDERGLOW_STYLES = ['none', 'neon', 'pulse', 'chase', 'rainbow', 'reactive'] as const;

const PATTERN = /* glsl */ `
  uniform float uStyle;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uNitro;
  uniform float uDrift;
  uniform vec3 uColor;
  uniform vec2 uHalf;

  vec3 hue(float h) {
    return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  }

  // position round the car, 0..1, starting at the tail and running anticlockwise seen from above
  float around(vec2 xz) {
    return atan(xz.x / uHalf.x, xz.y / uHalf.y) * 0.15915494 + 0.5;
  }

  vec3 led(float p) {
    float t = uTime;
    if (uStyle < 1.5) {
      // neon: steady, with a faint shimmer running along the tube
      return uColor * (0.9 + 0.1 * sin(t * 2.6 + p * 25.13));
    }
    if (uStyle < 2.5) {
      // pulse: a double heartbeat, never fully dark
      float b = fract(t * 0.85);
      float beat = exp(-b * 9.0) + 0.65 * exp(-max(b - 0.2, 0.0) * 10.0) * step(0.2, b);
      return uColor * (0.14 + 1.25 * beat);
    }
    if (uStyle < 3.5) {
      // chase: two comets circling the car, white-hot heads and long fading tails
      float h = fract(t * 0.42);
      float d1 = fract(h - p);
      float d2 = fract(h + 0.5 - p);
      // a short soft lead in front of each head, so the comets have no hard front edge
      float c = exp(-d1 * 7.0) + exp(-d2 * 7.0) + exp(-(1.0 - d1) * 45.0) + exp(-(1.0 - d2) * 45.0);
      float head = exp(-d1 * 70.0) + exp(-d2 * 70.0);
      return uColor * (0.1 + 1.35 * c) + vec3(head * 0.9);
    }
    if (uStyle < 4.5) {
      // rainbow: the whole spectrum flowing round the car
      vec3 c = hue(fract(p * 2.0 - t * 0.22));
      return mix(vec3(dot(c, vec3(0.333))), c, 1.15) * 1.15;
    }
    // reactive: dim when parked, brighter and faster with speed, ripples on drifts, white-hot on nitro
    float s = uSpeed;
    float flow = 0.5 + 0.5 * sin((p * 5.0 - t * (0.6 + 5.0 * s)) * 6.2831);
    vec3 c = uColor * (0.28 + 0.95 * s) * (1.0 - 0.45 * s + 0.9 * s * flow);
    c *= 1.0 + uDrift * (0.6 + 0.6 * sin(t * 38.0 + p * 40.0));
    vec3 hot = mix(uColor, vec3(1.0), 0.55) * (1.7 + 0.3 * sin(t * 55.0));
    return mix(c, hot, uNitro);
  }
`;

const STRIP_VERT = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STRIP_FRAG = /* glsl */ `
  ${PATTERN}
  uniform float uPower;
  uniform float uMid;
  varying vec3 vLocal;
  void main() {
    vec3 c = led(around(vLocal.xz - vec2(0.0, uMid))) * uPower;
    // the tube itself is over-driven so it blooms; the core goes towards white
    c = c * 2.4 + vec3(dot(c, vec3(0.3))) * 0.6;
    gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
  }
`;

const POOL_VERT = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vXZ = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const POOL_FRAG = /* glsl */ `
  ${PATTERN}
  uniform float uPower;
  uniform vec2 uQuad;
  uniform vec2 uBox;
  varying vec2 vXZ;

  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  void main() {
    float sd = sdRoundBox(vXZ, uBox, 0.45);
    float o = max(sd, 0.0);
    // wide soft spill plus a brighter band right under the tubes
    float g = exp(-o * o * 2.6) * 0.75 + exp(-sd * sd * 30.0) * 0.55;
    // fade to exactly zero well inside the quad: no hard edge, ever
    vec2 e = abs(vXZ) / uQuad;
    g *= 1.0 - smoothstep(0.55, 0.97, max(e.x, e.y));
    vec3 c = led(around(vXZ)) * g * uPower;
    gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
  }
`;

/** Tubes: one along each sill between the arches, one behind the nose, one under the tail. */
function stripGeometry(front: number, back: number): BufferGeometry {
  const y = 0.19;
  const t = 0.035;
  const x = SKELETON.skirtX - 0.08;
  const zf = Math.min(front - 0.45, SKELETON.frontAxleZ + 0.5);
  const zb = Math.max(-back + 0.45, SKELETON.rearAxleZ - 0.5);
  const parts: BufferGeometry[] = [];
  const add = (w: number, l: number, px: number, pz: number) => {
    const g = new BoxGeometry(w, t, l);
    g.translate(px, y, pz);
    parts.push(g);
  };
  const sideLen = SKELETON.skirtZ[1] - SKELETON.skirtZ[0] + 0.1;
  add(t, sideLen, x, 0);
  add(t, sideLen, -x, 0);
  add(1.2, t, 0, zf);
  add(1.2, t, 0, zb);
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return merged;
}

export interface UnderglowDrive {
  /** 0..1 of top speed */
  speed: number;
  nitro: number;
  drifting: boolean;
  grounded: boolean;
}

export class Underglow {
  /** add to the car body (pitches and rolls with it) */
  readonly strips: Mesh;
  /** add to the car root (stays on the road) */
  readonly pool: Mesh;
  private stripMat: ShaderMaterial;
  private poolMat: ShaderMaterial;
  private lift = 1;
  private drift = 0;
  private speed = 0;
  /** brightness multiplier, e.g. to show it off in the garage */
  boost = 1;

  constructor(build: CarBuild, hitbox: { front: number; back: number; halfWidth: number }) {
    const style = Math.max(1, UNDERGLOW_STYLES.indexOf(build.underglow as (typeof UNDERGLOW_STYLES)[number]));
    const opt = underglowColorById(build.underglowColor);
    const color = new Color(opt.id === 'paint' ? paintById(build.paint).color : opt.color);
    // LEDs are pure light: push the paint colour to full saturation and brightness
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    if (opt.id === 'paint') color.setHSL(hsl.h, Math.max(0.75, hsl.s), 0.55);
    const halfLen = (hitbox.front + hitbox.back) / 2;
    const midZ = (hitbox.front - hitbox.back) / 2;
    const half = { x: hitbox.halfWidth, z: halfLen };
    const shared = () => ({
      uStyle: { value: style },
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uNitro: { value: 0 },
      uDrift: { value: 0 },
      uColor: { value: color },
      uHalf: { value: [half.x, half.z] },
      uPower: { value: 1 },
    });

    this.stripMat = new ShaderMaterial({ vertexShader: STRIP_VERT, fragmentShader: STRIP_FRAG, uniforms: { ...shared(), uMid: { value: midZ } } });
    this.strips = new Mesh(stripGeometry(hitbox.front, hitbox.back), this.stripMat);

    const qx = half.x + 1.7;
    const qz = half.z + 1.7;
    const pg = new PlaneGeometry(qx * 2, qz * 2, 1, 1);
    pg.rotateX(-Math.PI / 2);
    this.poolMat = new ShaderMaterial({
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        ...shared(),
        uQuad: { value: [qx, qz] },
        uBox: { value: [half.x * 0.8, half.z * 0.72] },
      },
    });
    // the pattern runs round the middle of the car, which sits a little off the axle midpoint
    this.pool = new Mesh(pg, this.poolMat);
    this.pool.position.set(0, 0.035, midZ);
    this.pool.renderOrder = 1;
  }

  update(dt: number, time: number, d: UnderglowDrive) {
    // the pool is light on the road: it fades as the car leaves the ground, and comes back on landing
    const k = 1 - Math.exp(-(d.grounded ? 10 : 6) * dt);
    this.lift += ((d.grounded ? 1 : 0) - this.lift) * k;
    this.drift += ((d.drifting ? 1 : 0) - this.drift) * (1 - Math.exp(-6 * dt));
    this.speed += (Math.min(1, Math.max(0, d.speed)) - this.speed) * (1 - Math.exp(-4 * dt));
    const t = time % 600;
    for (const m of [this.stripMat, this.poolMat]) {
      const u = m.uniforms;
      u.uTime.value = t;
      u.uSpeed.value = this.speed;
      u.uNitro.value = Math.min(1, d.nitro);
      u.uDrift.value = this.drift;
    }
    this.stripMat.uniforms.uPower.value = this.boost;
    this.poolMat.uniforms.uPower.value = this.boost * this.lift * 1.25;
    this.pool.visible = this.lift > 0.01;
  }

  dispose() {
    this.strips.geometry.dispose();
    this.pool.geometry.dispose();
    this.stripMat.dispose();
    this.poolMat.dispose();
  }
}
