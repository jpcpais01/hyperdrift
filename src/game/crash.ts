import { Color, Matrix4, Quaternion, Vector3, type Scene } from 'three';
import { CarDamage, PART, PartState, ZONE_FRONT, type DamageMode, type ImpactResult } from '../car/damage';
import type { CarVisual } from '../car/carBuilder';
import { audio } from '../core/audio';
import type { Particles } from '../world/particles';
import type { CarContact } from './carCollision';
import type { CarEvent, CarPhysics } from './carPhysics';
import { DebrisField, FIRE, FIRE_CORE, GLASS, SPARK, SPARK_HOT, Smoke, type DebrisGround } from './wreckFx';

/** A car as the crash system sees it (races and free roam both have these). */
export interface CrashCar {
  physics: CarPhysics;
  visual: CarVisual;
  isPlayer: boolean;
  /** driven by someone else's snapshots: its damage arrives over the wire */
  remote: boolean;
  voice: string | null;
  damage?: CarDamage;
}

/** What the mode does about crashes it cares about. */
export interface CrashHooks {
  /** the player's car took a hit (a word on the HUD when it is totaled) */
  playerHit?(r: ImpactResult, speed: number): void;
  /** a wreck has burned long enough: put the car back on the road (it is repaired right after) */
  recover(car: CrashCar): void;
}

/**
 * The body sits down on the corner whose wheel is gone, and a wreck slumps
 * (call after the car's pose is set for the frame).
 */
export function sagBody(car: CrashCar) {
  const d = car.damage;
  if (!d || !d.damaged) return;
  const b = car.visual.body;
  let roll = 0;
  let pitch = 0;
  let drop = 0;
  car.visual.wheelCentres.forEach(([x, , z], i) => {
    const w = d.wheels[i];
    // bent wheels lean the car a touch, a missing one drops the corner onto the hub
    const k = w.gone ? 1 : Math.min(0.35, Math.abs(w.camber) * 2);
    roll -= Math.sign(x) * k * 0.085;
    pitch += Math.sign(z) * k * 0.05;
    drop += k * 0.06;
  });
  b.rotation.z += roll;
  b.rotation.x += pitch;
  b.position.y -= drop;
}

/** Marks where a car snapshot's damage block starts. */
export const DMG_TAG = -7777;

/** Online: whether this packet carries the car's damage (on a change, a few times over, then twice a second). */
export function netDamageDue(c: { damage?: CarDamage; netDmgRev: number; netDmgRepeat: number }, count: number) {
  const d = c.damage!;
  if (d.rev !== c.netDmgRev) {
    c.netDmgRev = d.rev;
    c.netDmgRepeat = 6;
  }
  if (c.netDmgRepeat > 0) {
    c.netDmgRepeat--;
    return true;
  }
  return d.damaged && count % 10 === 0;
}

/** A wreck burns this long before the car comes back repaired. */
export const WRECK_TIME = 3.4;

const STEAM = new Color(0.86, 0.88, 0.9);
const GREY = new Color(0.34, 0.34, 0.35);
const BLACK = new Color(0.035, 0.032, 0.03);
const SMOKE_C = new Color();
const P = new Vector3();
const P2 = new Vector3();
const D = new Vector3();
const V = new Vector3();
const W = new Vector3();
const M = new Matrix4();
const Q = new Quaternion();
const S = new Vector3();

interface CarState {
  lastHit: number;
  lastSpeed: number;
  lastScrape: number;
  /** emitter accumulators (particles per second → whole particles) */
  acc: [number, number, number, number];
  misfire: number;
  rev: number;
  wasTotaled: boolean;
}

/**
 * Damage for every car in a race or the free-roam zone: turns contacts and
 * physics impacts into dents, loose and flying parts, smashed glass and
 * lamps, a smoking and burning engine and finally a wreck; then brings the
 * car back repaired. Owned cars are damaged here, remote ones take their
 * owner's copy (see apply).
 */
export class CrashSystem {
  /** the player's damage setting (from the settings screen), taken by every new race or zone */
  static mode: DamageMode = 'full';
  readonly smoke = new Smoke();
  readonly debris: DebrisField;
  private time = 0;
  private state = new Map<CrashCar, CarState>();
  private camera = new Vector3();

  constructor(
    private scene: Scene,
    private sparks: Particles,
    ground: DebrisGround,
    private hooks: CrashHooks,
    readonly mode: DamageMode = CrashSystem.mode,
  ) {
    this.debris = new DebrisField(scene, ground, sparks);
    scene.add(this.smoke.points);
  }

  /** Give a car its damage model (its visual must be built with `damage`). */
  add(car: CrashCar, seed: number) {
    const v = car.visual;
    if (!v.damage || this.mode === 'off') return;
    const h = v.hitbox;
    car.damage = new CarDamage({ front: h.front, back: h.back, halfWidth: h.halfWidth, height: h.height, wheels: v.wheelCentres, mass: car.physics.stats.mass }, this.mode, seed);
    this.state.set(car, { lastHit: -1, lastSpeed: 0, lastScrape: -1, acc: [0, 0, 0, 0], misfire: 0, rev: -1, wasTotaled: false });
  }

  remove(car: CrashCar) {
    this.state.delete(car);
  }

  // ------------------------------------------------------------ hits

  /** Car-to-car contacts of one physics step. */
  contacts(list: CarContact[], carOf: (p: CarPhysics) => CrashCar | undefined) {
    for (const ct of list) {
      const a = carOf(ct.a);
      const b = carOf(ct.b);
      // closing speed each car felt, from its own change in velocity
      if (a) this.hitWorld(a, ct.point, D.copy(ct.normal).negate(), ct.dvA * 1.45, ct.scrape);
      if (b) this.hitWorld(b, ct.point, D.copy(ct.normal), ct.dvB * 1.45, ct.scrape);
    }
  }

  /** A physics event of one car (only impacts matter here). */
  event(car: CrashCar, e: CarEvent) {
    if (e.type === 'impact') this.hitLocal(car, e.point, e.dir, e.speed, e.scrape);
    else if (e.type === 'respawn' && car.damage && !car.remote) this.repair(car);
  }

  /** `point` world, `dir` world (into the car). */
  private hitWorld(car: CrashCar, point: Vector3, dir: Vector3, speed: number, scrape: number) {
    if (!car.damage || car.remote) return;
    const p = car.physics;
    // into car space (x = up × fwd)
    P.copy(point).sub(p.pos);
    const lp = P2.set(-P.dot(p.right), P.dot(p.up), P.dot(p.fwd));
    const ld = V.set(-dir.dot(p.right), dir.dot(p.up), dir.dot(p.fwd));
    // contacts sit on the ground plane: lift them to bumper height
    lp.y = Math.min(Math.max(lp.y, 0.42), car.visual.hitbox.height * 0.55);
    ld.y *= 0.3;
    this.hitLocal(car, lp, ld.normalize(), speed, scrape);
  }

  private hitLocal(car: CrashCar, point: Vector3, dir: Vector3, speed: number, scrape: number) {
    const d = car.damage;
    const st = this.state.get(car);
    if (!d || !st || car.remote || d.totaled) return;
    const rig = car.visual.damage!;
    const now = this.time;
    if (speed < 3.2) {
      // rubbing along: paint only, now and then
      if (scrape > 5 && now - st.lastScrape > 0.1) {
        st.lastScrape = now;
        d.scrape(rig.resolve(point, dir, P), dir, scrape);
      }
      return;
    }
    // one crash, many contact steps: only a clearly harder blow counts again so soon
    if (now - st.lastHit < 0.2 && speed < st.lastSpeed * 1.4) return;
    st.lastHit = now;
    st.lastSpeed = speed;
    const at = rig.resolve(point, dir, P);
    const res = d.hit(at, dir, speed, scrape);
    this.react(car, res, at, speed);
  }

  /**
   * What a hit looks and sounds like, kept understated: a crunch only when
   * metal actually gives, a few sparks off the panel on hard hits, a little
   * glass when a window or lamp goes. `at` is car space.
   */
  private react(car: CrashCar, res: ImpactResult, at: Vector3 | null, speed: number) {
    const p = car.physics;
    const v = car.visual;
    const rig = v.damage!;
    v.body.updateWorldMatrix(true, false);
    rig.kick(0.3 + res.severity);
    const world = at ? W.copy(at).applyMatrix4(v.body.matrixWorld) : W.copy(p.pos).addScaledVector(p.up, 0.6);
    const near = Math.max(0, 1 - world.distanceTo(this.camera) / 60);
    const loud = car.isPlayer ? 1 : near * near;
    if (res.severity > 0.08 && loud > 0.05) audio.crunch(Math.min(1, res.severity * 1.2) * (0.4 + 0.6 * loud), res.glass);
    if (res.severity > 0.25) {
      for (let k = 0; k < 3 + res.severity * 5; k++) {
        D.set(Math.random() - 0.5, Math.random() * 0.6 + 0.1, Math.random() - 0.5).multiplyScalar(4 + res.severity * 4).addScaledVector(p.vel, 0.9);
        this.sparks.emit(world, D, SPARK, 0.8, 0.05, 0.15 + Math.random() * 0.15, 0, 1.2);
      }
    }
    if (res.glass || res.lights) {
      for (let k = 0; k < (res.glass ? 8 : 4); k++) {
        D.set(Math.random() - 0.5, Math.random() * 0.7 + 0.2, Math.random() - 0.5).multiplyScalar(3 + Math.random() * 3).addScaledVector(p.vel, 0.9);
        this.sparks.emit(world, D, GLASS, 0.6, 0.03, 0.3 + Math.random() * 0.3, 0, 1.2);
      }
    }
    for (const part of res.detached) this.throwPart(car, part, speed);
    for (const w of res.wheels) if (car.damage!.wheels[w].gone) this.throwWheel(car, w);
    if (car.isPlayer) this.hooks.playerHit?.(res, speed);
  }

  /** A part comes off: it leaves from exactly where it hung, with the car's speed and a kick. */
  private throwPart(car: CrashCar, part: number, speed: number) {
    const v = car.visual;
    const rig = v.damage!;
    const piece = rig.debris(part);
    if (!piece) return;
    const p = car.physics;
    M.multiplyMatrices(v.body.matrixWorld, piece.partMatrix);
    M.decompose(P2, Q, S);
    const pos = P.copy(piece.center).applyMatrix4(M);
    // off the car and away from it, the hood up and over the roof
    const out = D.copy(pos).sub(p.pos).normalize();
    const kick = 2 + Math.min(10, speed * 0.25);
    const vel = V.copy(p.vel).multiplyScalar(part === PART.hood ? 0.75 : 0.88).addScaledVector(out, kick).addScaledVector(p.up, 2 + Math.random() * 3 + (part === PART.hood ? 5 : 0));
    const spin = W.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(8 + speed * 0.15);
    if (part === PART.hood) spin.addScaledVector(p.right, 6);
    this.debris.add(piece.root, pos, Q, vel, spin, piece.half, p.trackIndex, piece.dispose, part === PART.exhaust ? 0.2 : 0.3);
  }

  private throwWheel(car: CrashCar, i: number) {
    const v = car.visual;
    const p = car.physics;
    const g = v.wheelDebris(i);
    v.root.updateWorldMatrix(true, false);
    const pos = P.copy(g.position).applyMatrix4(v.root.matrixWorld);
    const side = v.wheelCentres[i][0] > 0 ? -1 : 1;
    const vel = V.copy(p.vel).multiplyScalar(0.9).addScaledVector(p.right, side * (4 + Math.random() * 4)).addScaledVector(p.up, 3 + Math.random() * 3);
    const spin = W.copy(p.right).multiplyScalar(-p.forwardSpeed / 0.34).addScaledVector(p.fwd, (Math.random() - 0.5) * 6);
    const r = v.wheelCentres[i][1];
    this.debris.add(g, pos, Q.copy(v.root.quaternion), vel, spin, S.set(0.14, r * 0.92, r * 0.92), p.trackIndex, () => {}, 0.45);
  }

  /** Good as new (respawns, the pause menu's restart, a wreck coming back). */
  repair(car: CrashCar) {
    const d = car.damage;
    if (!d || !d.damaged) return;
    d.repair();
    const st = this.state.get(car);
    if (st) st.wasTotaled = false;
    car.physics.dmg.dead = false;
    // a shimmer of blue as it comes back
    const p = car.physics;
    for (let k = 0; k < 24; k++) {
      D.set(Math.random() - 0.5, Math.random(), Math.random() - 0.5).multiplyScalar(4).addScaledVector(p.vel, 0.9);
      this.sparks.emit(P.copy(p.pos).addScaledVector(p.up, 0.3 + Math.random()).addScaledVector(p.right, (Math.random() - 0.5) * 2), D, GLASS, 0.8, 0.12, 0.6, 0.3, 2);
    }
    car.visual.damage?.sync(d, 0, 0, this.time);
  }

  // ------------------------------------------------------------ online

  /** The damage to send with this car's snapshot (owned cars), or null when there is none to tell. */
  pack(car: CrashCar): number[] | null {
    return car.damage ? car.damage.pack() : null;
  }

  /** A remote car's damage, as its owner sent it. */
  apply(car: CrashCar, data: number[], at: number) {
    const d = car.damage;
    if (!d) return;
    const r = d.unpack(data, at);
    if (!r) return;
    const st = this.state.get(car);
    if (r.detached.length || r.wheels.length || r.totaled) {
      car.visual.body.updateWorldMatrix(true, false);
      for (const part of r.detached) this.throwPart(car, part, car.physics.speed);
      for (const w of r.wheels) this.throwWheel(car, w);
      const near = Math.max(0, 1 - car.physics.pos.distanceTo(this.camera) / 60);
      if (near > 0.2) audio.crunch((r.totaled ? 0.9 : 0.5) * near * near);
    }
    if (st) st.wasTotaled = d.totaled;
  }

  // ------------------------------------------------------------ every frame

  update(dt: number, cars: CrashCar[], camera: Vector3) {
    this.time += dt;
    this.camera.copy(camera);
    for (const car of cars) {
      const d = car.damage;
      const st = this.state.get(car);
      const rig = car.visual.damage;
      if (!d || !st || !rig) continue;
      d.update(dt);
      const p = car.physics;
      rig.sync(d, dt, p.forwardSpeed, this.time);
      // handling: what the damage leaves of the car (remote cars too: their replays use it)
      st.misfire -= dt;
      if (!car.remote && Math.random() < d.misfire * dt) {
        st.misfire = 0.22;
        car.visual.exhaust?.pop(0.95);
        if (car.voice) audio.pop(car.voice, 0.95);
        if (car.visual.exhaustTips.length) {
          const tip = car.visual.tipWorld(0, P);
          for (let k = 0; k < 3; k++) this.smoke.emit(tip, D.copy(p.vel).multiplyScalar(0.5).addScaledVector(p.fwd, -2), BLACK, 0.5, 0.35, 1.2, 1.4, 1);
        }
      }
      p.dmg.power = d.power * (st.misfire > 0 ? 0.25 : 1);
      p.dmg.top = d.topSpeed;
      p.dmg.grip = d.grip;
      p.dmg.pull = d.pull;
      p.dmg.dead = d.totaled;
      if (!car.remote && d.totaled && d.wreckTime > WRECK_TIME) {
        this.hooks.recover(car);
        this.repair(car);
        continue;
      }
      if (car.visual.root.visible) this.emit(car, d, dt, st);
    }
    this.debris.update(dt);
    this.smoke.update(dt);
  }

  /** Steam, smoke, fire and the sparks of parts dragging on the road. */
  private emit(car: CrashCar, d: CarDamage, dt: number, st: CarState) {
    if (!d.damaged) return;
    const p = car.physics;
    if (p.pos.distanceToSquared(this.camera) > 170 * 170) return;
    const v = car.visual;
    const h = v.hitbox;
    v.body.updateWorldMatrix(true, false);
    const hood = P.set(0, h.height * 0.6, h.front * 0.5).applyMatrix4(v.body.matrixWorld);
    const front = d.zone[ZONE_FRONT];
    // trailing: the smoke leaves at a share of the car's speed and is left behind
    const carry = V.copy(p.vel).multiplyScalar(0.3);
    const rate = (i: number, perSec: number) => {
      st.acc[i] += perSec * dt;
      const n = Math.floor(st.acc[i]);
      st.acc[i] -= n;
      return Math.min(n, 6);
    };
    // a split radiator: white steam
    if (front > 0.45 && d.health > 0.25) {
      for (let k = rate(0, 8 + 14 * Math.min(1, front - 0.45)); k > 0; k--) {
        D.set((Math.random() - 0.5) * 1.2, 1 + Math.random(), (Math.random() - 0.5) * 1.2).add(carry);
        this.smoke.emit(P2.copy(hood).addScaledVector(p.right, (Math.random() - 0.5) * 0.8), D, STEAM, 0.18, 0.35, 1.0 + Math.random() * 0.5, 1.6, 1.2);
      }
    }
    // a dying engine: grey, then black smoke
    if (d.health < 0.55) {
      const k0 = 1 - d.health / 0.55;
      SMOKE_C.copy(GREY).lerp(BLACK, Math.min(1, k0 * 1.4));
      for (let k = rate(1, 6 + 34 * k0 + (d.totaled ? 20 : 0)); k > 0; k--) {
        D.set((Math.random() - 0.5) * 1.4, 1.2 + Math.random() * 1.5, (Math.random() - 0.5) * 1.4).add(carry);
        this.smoke.emit(P2.copy(hood).addScaledVector(p.right, (Math.random() - 0.5) * 0.7), D, SMOKE_C, 0.3 + 0.35 * k0, 0.45 + 0.4 * k0, 1.6 + Math.random() * 1.2, 1.8 + k0 * 1.5, 2 + k0);
      }
    }
    // fire under the hood
    if (d.health < 0.14 || d.totaled) {
      const k1 = d.totaled ? 1 : 1 - d.health / 0.14;
      for (let k = rate(2, 18 + 40 * k1); k > 0; k--) {
        D.set((Math.random() - 0.5) * 1.5, 1.6 + Math.random() * 2.4, (Math.random() - 0.5) * 1.5).add(carry);
        const at = P2.copy(hood).addScaledVector(p.right, (Math.random() - 0.5) * 0.9).addScaledVector(p.fwd, (Math.random() - 0.5) * 0.6);
        this.sparks.emit(at, D, Math.random() < 0.35 ? FIRE_CORE : FIRE, 0.75 * (0.5 + k1 * 0.5), 0.22 + Math.random() * 0.3 * k1, 0.3 + Math.random() * 0.25, -0.2, 1.6);
      }
    }
    // loose panels and pipes scraping the road
    if (p.grounded && Math.abs(p.forwardSpeed) > 6) {
      for (const part of [PART.front, PART.rear, PART.exhaust]) {
        if (d.parts[CarDamage.slot(part)] !== PartState.Loose) continue;
        const pt = v.damage!.dragPoint(d, part, P2);
        if (!pt || pt.y > 0.12) continue;
        pt.applyMatrix4(v.body.matrixWorld);
        for (let k = rate(3, 40); k > 0; k--) {
          D.copy(p.vel).multiplyScalar(0.55).addScaledVector(p.fwd, -2 - Math.random() * 3).addScaledVector(p.up, 0.6 + Math.random() * 2).addScaledVector(p.right, (Math.random() - 0.5) * 3);
          this.sparks.emit(pt, D, Math.random() < 0.4 ? SPARK_HOT : SPARK, 1, 0.07, 0.25, 0, 1.4);
        }
      }
    }
  }

  clear() {
    this.debris.clear();
    this.smoke.clear();
  }

  dispose() {
    this.debris.clear();
    this.scene.remove(this.smoke.points);
    this.smoke.dispose();
    this.state.clear();
  }
}

