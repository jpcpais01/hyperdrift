import { BufferAttribute, BufferGeometry, Color, NormalBlending, Object3D, Points, Quaternion, ShaderMaterial, Vector3, type Scene } from 'three';
import type { Particles } from '../world/particles';

/**
 * The world side of crashes: parts tumbling down the road, and the smoke and
 * fire of a dying engine. One draw call for all the smoke, debris are plain
 * meshes (a handful at a time, gone after a few seconds).
 */

/**
 * The ground under a point: its height above the surface (along `up`), or
 * null over the void (debris then just falls). `hint` carries a track index.
 */
export type DebrisGround = (p: Vector3, hint: { i: number }, up: Vector3) => number | null;

const SMOKE_MAX = 420;

/** Soft alpha-blended puffs: grey steam to thick black smoke (the additive sparks can't do dark). */
export class Smoke {
  readonly points: Points;
  private pos = new Float32Array(SMOKE_MAX * 3);
  private vel = new Float32Array(SMOKE_MAX * 3);
  private col = new Float32Array(SMOKE_MAX * 4);
  private size = new Float32Array(SMOKE_MAX);
  private seed = new Float32Array(SMOKE_MAX);
  private life = new Float32Array(SMOKE_MAX);
  private maxLife = new Float32Array(SMOKE_MAX);
  private grow = new Float32Array(SMOKE_MAX);
  private a0 = new Float32Array(SMOKE_MAX);
  private lift = new Float32Array(SMOKE_MAX);
  private next = 0;
  private live = 0;
  private geo = new BufferGeometry();

  constructor() {
    const g = this.geo;
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('color', new BufferAttribute(this.col, 4));
    g.setAttribute('size', new BufferAttribute(this.size, 1));
    g.setAttribute('seed', new BufferAttribute(this.seed, 1));
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float seed;
        attribute vec4 color;
        varying vec4 vColor;
        varying float vSeed;
        void main() {
          vColor = color;
          vSeed = seed;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = color.a > 0.0 ? size * 300.0 / max(1.0, -mv.z) : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        varying float vSeed;
        float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5); }
        float n(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          // billows: the edge breaks up, a darker underside
          float b = n(d * 5.0 + vSeed * 13.0) * 0.6 + n(d * 11.0 - vSeed * 7.0) * 0.4;
          float a = smoothstep(0.5, 0.12, r + (b - 0.5) * 0.22);
          float shade = 0.78 + 0.32 * (0.5 - d.y) + (b - 0.5) * 0.25;
          gl_FragColor = vec4(vColor.rgb * shade, vColor.a * a);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  /** `lift`: buoyancy, m/s² upwards (hot smoke rises, steam less so). */
  emit(p: Vector3, v: Vector3, color: Color, alpha: number, size: number, life: number, grow: number, lift = 1.5) {
    const i = this.next;
    this.next = (this.next + 1) % SMOKE_MAX;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b, alpha], i * 4);
    this.size[i] = size;
    this.seed[i] = Math.random();
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grow[i] = grow;
    this.a0[i] = alpha;
    this.lift[i] = lift;
    this.live = SMOKE_MAX;
  }

  update(dt: number) {
    if (!this.live) return;
    let alive = 0;
    const k = Math.exp(-1.6 * dt);
    for (let i = 0; i < SMOKE_MAX; i++) {
      if (this.life[i] <= 0) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + this.lift[i] * dt;
      this.vel[i * 3 + 2] *= k;
      for (let a = 0; a < 3; a++) this.pos[i * 3 + a] += this.vel[i * 3 + a] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      // fade in quickly, out slowly
      this.col[i * 4 + 3] = this.a0[i] * Math.min(1, (1 - t) * 8) * t;
    }
    this.live = alive;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.seed.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.col.fill(0);
    this.live = SMOKE_MAX;
  }

  dispose() {
    this.geo.dispose();
    (this.points.material as ShaderMaterial).dispose();
  }
}

interface Debris {
  obj: Object3D;
  pos: Vector3;
  vel: Vector3;
  quat: Quaternion;
  spin: Vector3;
  half: Vector3;
  age: number;
  life: number;
  hint: { i: number };
  bounce: number;
  rest: number;
  dispose: () => void;
}

const MAX_DEBRIS = 16;
const GRAVITY = 24;
const UP = new Vector3();
const C = new Vector3();
const R = new Vector3();
const VC = new Vector3();
const T = new Vector3();
const Q = new Quaternion();
const CORNERS = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new Vector3(x, y, z))));
export const SPARK = new Color(1.6, 0.9, 0.3);
export const SPARK_HOT = new Color(2.2, 1.4, 0.6);
export const FIRE = new Color(2.6, 0.9, 0.18);
export const FIRE_CORE = new Color(3.2, 2.0, 0.7);
export const GLASS = new Color(1.2, 1.4, 1.6);

/** Parts flying off cars: tumbling boxes that bounce, slide, settle and then sink away. */
export class DebrisField {
  private list: Debris[] = [];

  constructor(
    private scene: Scene,
    private ground: DebrisGround,
    private sparks: Particles,
  ) {}

  /**
   * Throw `obj` (its children already offset so the origin is the centre of
   * mass) from `pos` with `vel` (world) and tumbling `spin` (rad/s, world).
   */
  add(obj: Object3D, pos: Vector3, quat: Quaternion, vel: Vector3, spin: Vector3, half: Vector3, hint: number, dispose: () => void, bounce = 0.32) {
    while (this.list.length >= MAX_DEBRIS) this.remove(0);
    obj.position.copy(pos);
    obj.quaternion.copy(quat);
    this.scene.add(obj);
    this.list.push({ obj, pos: pos.clone(), vel: vel.clone(), quat: quat.clone(), spin: spin.clone(), half: half.clone().max(T.set(0.05, 0.05, 0.05)), age: 0, life: 9 + Math.random() * 3, hint: { i: hint }, bounce, rest: 0, dispose });
  }

  private remove(i: number) {
    const d = this.list[i];
    this.scene.remove(d.obj);
    d.dispose();
    this.list.splice(i, 1);
  }

  update(dt: number) {
    const h = Math.min(dt, 1 / 30);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.age += dt;
      if (d.age > d.life + 0.8) {
        this.remove(i);
        continue;
      }
      if (d.rest < 1.5) this.step(d, h);
      d.obj.position.copy(d.pos);
      d.obj.quaternion.copy(d.quat);
      // past its time: sinks into the ground
      const fade = Math.max(0, d.age - d.life) / 0.8;
      d.obj.scale.setScalar(1 - fade * fade);
    }
  }

  private step(d: Debris, h: number) {
    d.vel.y -= GRAVITY * h;
    d.vel.multiplyScalar(Math.exp(-0.12 * h));
    d.pos.addScaledVector(d.vel, h);
    const w = d.spin.length();
    if (w > 1e-4) {
      Q.setFromAxisAngle(T.copy(d.spin).divideScalar(w), w * h);
      d.quat.premultiply(Q).normalize();
    }
    const height = this.ground(d.pos, d.hint, UP);
    if (height === null || height > d.half.length() + 0.05) {
      d.rest = 0;
      if (d.pos.y < -2000) d.age = d.life;
      return;
    }
    // the box's corners against the ground plane under it
    const I = (d.half.lengthSq() * 2) / 3;
    let contacts = 0;
    let deepest = 0;
    for (const k of CORNERS) {
      C.set(k.x * d.half.x, k.y * d.half.y, k.z * d.half.z).applyQuaternion(d.quat);
      const depth = -(height + C.dot(UP));
      if (depth <= 0) continue;
      contacts++;
      deepest = Math.max(deepest, depth);
      R.copy(C);
      VC.copy(d.spin).cross(R).add(d.vel);
      const vn = VC.dot(UP);
      if (vn >= 0) continue;
      const rxn = T.copy(R).cross(UP);
      const j = (-(1 + d.bounce) * vn) / (1 + rxn.lengthSq() / I) / 2;
      d.vel.addScaledVector(UP, j);
      d.spin.addScaledVector(rxn, j / I);
      // friction at the corner
      const vt = VC.addScaledVector(UP, -vn);
      const vtl = vt.length();
      if (vtl > 1e-3) {
        const f = Math.min(vtl, j * 0.9);
        d.vel.addScaledVector(vt, -f / vtl / 2);
        d.spin.addScaledVector(T.copy(R).cross(vt), (-f / (I * vtl)) * 0.5);
        // metal on the road
        if (vtl > 7 && Math.random() < 0.35) {
          C.add(d.pos);
          this.sparks.emit(C, T.copy(d.vel).multiplyScalar(0.6).addScaledVector(UP, 1 + Math.random() * 2), SPARK, 0.9, 0.08, 0.22, 0, 2);
        }
      }
    }
    if (contacts) {
      d.pos.addScaledVector(UP, deepest);
      d.spin.multiplyScalar(Math.exp(-2.5 * h));
      if (d.vel.lengthSq() < 0.25 && d.spin.lengthSq() < 0.25) d.rest += h;
      else d.rest = 0;
    }
  }

  clear() {
    while (this.list.length) this.remove(0);
  }
}
