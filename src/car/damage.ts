import { Vector3 } from 'three';

/**
 * Car damage: what a car has been through, as plain data. Pure logic (no
 * rendering), shared by every mode and synced online by whoever owns the car.
 *
 * Car space, like everything on the car: +z forward, +y up, origin on the
 * ground between the axles.
 *
 *  - dents: up to MAX_DENTS deformations, each a centre, a push direction
 *    (into the car), a radius and a depth. The vertex shader bends every part
 *    of the car through them, so any body and part combination crumples.
 *  - parts: the front and rear bumpers, hood, skirts, spoiler and exhaust go
 *    on → loose (hanging, flapping) → gone (flying off as debris).
 *  - wheels: bent suspension (camber, toe), and one can tear off in a wreck.
 *  - health: 1 = fresh, 0 = totaled.
 */

export const MAX_DENTS = 12;

/** Part ids, carried per vertex in the `part` attribute. */
export const PART = {
  body: 0,
  front: 1,
  rear: 2,
  hood: 3,
  skirts: 4,
  spoiler: 5,
  exhaust: 6,
  /** flying debris: always drawn as is */
  debris: 7,
  /** dark inner skins behind the bumpers and under the hood, shown once the panel moves */
  underFront: 8,
  underRear: 9,
  underHood: 10,
} as const;
export const PART_COUNT = 11;

/** Parts that can come loose and fly off, in pack order. */
export const LOOSE_PARTS = [PART.front, PART.rear, PART.hood, PART.skirts, PART.spoiler, PART.exhaust] as const;

export const enum PartState {
  On = 0,
  Loose = 1,
  Gone = 2,
}

/** 'full': dents, parts, handling and wrecks; 'visual': the looks only; 'off': none. */
export type DamageMode = 'full' | 'visual' | 'off';
export const DAMAGE_MODES: DamageMode[] = ['full', 'visual', 'off'];

/** Zones that take the hits: front, rear, the +x side, the -x side, roof. */
export const ZONE_FRONT = 0;
export const ZONE_REAR = 1;
export const ZONE_POS_X = 2;
export const ZONE_NEG_X = 3;
export const ZONE_TOP = 4;

export interface Dent {
  /** centre, on (or just under) the skin */
  c: Vector3;
  /** unit push direction, into the car */
  dir: Vector3;
  r: number;
  /** settled depth, metres */
  depth: number;
  /** drawn depth: springs to `depth` with a little overshoot, like metal giving */
  shown: number;
  vel: number;
  /** scratched paint, 0..1 */
  scuff: number;
  /** pattern seed for the folds */
  seed: number;
}

export interface WheelDamage {
  /** extra camber, radians (+ = top in) */
  camber: number;
  /** extra toe, radians */
  toe: number;
  gone: boolean;
}

/** The size facts damage needs (from the built car). */
export interface DamageShape {
  front: number;
  back: number;
  halfWidth: number;
  height: number;
  /** wheel centres in car space, in the order the visual draws them */
  wheels: [number, number, number][];
  /** car mass, kg: heavier cars shrug more off */
  mass: number;
}

export interface ImpactResult {
  /** how bad it was, 0..1 (sound, shake, sparks) */
  severity: number;
  dented: boolean;
  loosened: number[];
  detached: number[];
  glass: boolean;
  lights: boolean;
  wheels: number[];
  totaled: boolean;
}

/** Below this impact speed (m/s) a hit only scuffs the paint. */
const DENT_SPEED = 3.2;
const SCUFF_SPEED = 1.2;
const MAX_DEPTH = 0.44;

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}

/** Small deterministic PRNG, so a replayed or synced car looks the same. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TMP = new Vector3();

export class CarDamage {
  readonly dents: Dent[] = [];
  readonly parts: PartState[] = LOOSE_PARTS.map(() => PartState.On);
  /** which side a loose part tore off on (+1 / -1): the hanging corner */
  readonly partSide: number[] = LOOSE_PARTS.map(() => 1);
  readonly wheels: WheelDamage[] = [0, 1, 2, 3].map(() => ({ camber: 0, toe: 0, gone: false }));
  /** accumulated damage per zone (front, rear, +x, -x, top), 0..~1.5 */
  readonly zone = new Float32Array(5);
  health = 1;
  /** bumps on every change (online sync) */
  rev = 0;
  /** seconds since the car was totaled (-1 while it drives) */
  wreckTime = -1;
  /** headlights smashed, per side (+x, -x) */
  readonly lightsOut = [false, false];
  /** windscreen cracked, 0..1 */
  glass = 0;
  private rnd: () => number;

  constructor(
    public shape: DamageShape,
    public mode: DamageMode = 'full',
    seed = 1,
  ) {
    this.rnd = mulberry(seed * 2654435761);
  }

  get totaled() {
    return this.wreckTime >= 0;
  }

  /** Any visible damage at all (for skipping work on fresh cars). */
  get damaged() {
    return this.dents.length > 0 || this.health < 1;
  }

  /** Index of a loose-able part in `parts`. */
  static slot(part: number) {
    return (LOOSE_PARTS as readonly number[]).indexOf(part);
  }

  partState(part: number): PartState {
    const i = CarDamage.slot(part);
    return i < 0 ? PartState.On : this.parts[i];
  }

  // ------------------------------------------------------------ handling

  /** Engine power left (front hits get the radiator and the engine). */
  get power() {
    if (this.mode !== 'full') return 1;
    if (this.totaled) return 0;
    const f = clamp(this.zone[ZONE_FRONT], 0, 1.2);
    return clamp(1 - 0.24 * f - 0.22 * (1 - this.health) ** 2, 0.45, 1);
  }

  /** Top speed left: torn-off panels and a bent body cost drag. */
  get topSpeed() {
    if (this.mode !== 'full') return 1;
    let k = 1 - 0.08 * (1 - this.health);
    if (this.parts[CarDamage.slot(PART.front)] === PartState.Loose) k -= 0.02;
    if (this.parts[CarDamage.slot(PART.hood)] === PartState.Loose) k -= 0.02;
    return clamp(k, 0.82, 1);
  }

  /** Lateral grip left: bent wheels and a lost wing. */
  get grip() {
    if (this.mode !== 'full') return 1;
    let bend = 0;
    for (const w of this.wheels) bend += Math.abs(w.camber) + Math.abs(w.toe) * 0.5;
    let k = 1 - Math.min(0.12, bend * 0.35);
    if (this.parts[CarDamage.slot(PART.spoiler)] === PartState.Gone) k -= 0.025;
    return k;
  }

  /** Steering pull from bent front wheels (added to the steering input, -1..1 scale). */
  get pull() {
    if (this.mode !== 'full') return 0;
    return clamp((this.wheels[0].toe + this.wheels[1].toe) * 1.6, -0.16, 0.16);
  }

  /** The engine coughs: chance per second of a misfire. */
  get misfire() {
    if (this.mode !== 'full' || this.totaled) return 0;
    return this.health < 0.35 ? (0.35 - this.health) * 6 : 0;
  }

  // ------------------------------------------------------------ hits

  /**
   * A hit at `point` (car space, on the skin), pushing along `dir` (car space,
   * into the car) at `speed` m/s of impact; `scrape` is the sliding speed along
   * the surface (scratches). Returns what happened, for effects.
   */
  hit(point: Vector3, dir: Vector3, speed: number, scrape = 0): ImpactResult {
    const res: ImpactResult = { severity: 0, dented: false, loosened: [], detached: [], glass: false, lights: false, wheels: [], totaled: false };
    if (this.mode === 'off' || this.totaled) return res;
    if (speed < SCUFF_SPEED && scrape < 4) return res;
    const S = this.shape;
    const armour = Math.sqrt(clamp(S.mass / 1300, 0.7, 1.5));
    const e = Math.max(0, speed - DENT_SPEED) / armour;
    const severity = clamp(e / 26, 0, 1);
    res.severity = severity;

    // which zone took it
    const zn = this.zoneOf(point, dir);
    const share = clamp((e / 30) ** 1.5 * 0.9, 0, 1.4);
    this.zone[zn] += share;
    // the hit spreads a little to the corner it was on
    if (zn === ZONE_FRONT || zn === ZONE_REAR) this.zone[point.x > 0 ? ZONE_POS_X : ZONE_NEG_X] += share * 0.25 * Math.min(1, Math.abs(point.x) / S.halfWidth);
    else if (Math.abs(point.z) > 0.5) this.zone[point.z > 0 ? ZONE_FRONT : ZONE_REAR] += share * 0.2;

    // health: small knocks are almost free, a big one takes half the car
    const loss = (Math.max(0, e - 1.5) / 30) ** 1.6 * 0.58;
    const floor = this.mode === 'visual' ? 0.06 : 0;
    this.health = Math.max(floor, this.health - loss);

    // the dent itself
    const scuff = clamp(scrape / 22 + speed / 18, 0, 1);
    if (e > 0 || scrape > 4) {
      const depth = e > 0 ? Math.min(MAX_DEPTH, 0.035 + 0.0125 * e + 0.00012 * e * e) : 0;
      const r = e > 0 ? clamp(0.3 + 0.026 * e, 0.3, 1.08) : clamp(0.26 + scrape * 0.012, 0.26, 0.6);
      this.addDent(point, dir, r, depth, scuff);
      res.dented = depth > 0;
    }

    // glass and lamps near the hit
    if (e > 6) {
      const glassReach = zn === ZONE_TOP || zn === ZONE_FRONT ? 1 : 0.5;
      const g = this.glass;
      this.glass = Math.min(1, this.glass + clamp((e - 6) / 22, 0, 1) * glassReach);
      res.glass = this.glass > g + 0.08;
    }
    if (zn === ZONE_FRONT && e > 7) {
      const side = point.x >= 0 ? 0 : 1;
      if (!this.lightsOut[side] && Math.abs(point.x) > S.halfWidth * 0.2) {
        this.lightsOut[side] = true;
        res.lights = true;
      }
      if (e > 18 && !this.lightsOut[1 - side]) {
        this.lightsOut[1 - side] = true;
        res.lights = true;
      }
    }

    // wheels near the hit get bent
    S.wheels.forEach((w, i) => {
      const d = Math.hypot(point.x - w[0], point.z - w[2]);
      if (d > 1.0 || e < 6) return;
      const k = clamp((e - 6) / 30, 0, 1) * (1 - d / 1.0);
      const wd = this.wheels[i];
      const side = w[0] > 0 ? 1 : -1;
      // pushed in at the bottom (camber) and turned (toe) by the blow
      wd.camber = clamp(wd.camber + k * 0.09 * (0.6 + this.rnd() * 0.8), -0.22, 0.22);
      wd.toe = clamp(wd.toe + k * 0.07 * (this.rnd() - 0.35) * Math.sign(dir.z * side || 1), -0.16, 0.16);
      if (k > 0.05) res.wheels.push(i);
    });

    // panels: loose, then gone
    this.updateParts(e, point, res);

    if (this.mode === 'full' && this.health <= 0) {
      this.health = 0;
      this.wreck(res);
    }
    this.rev++;
    return res;
  }

  /** Grinding along a wall or another car: scratches only, no dents. */
  scrape(point: Vector3, dir: Vector3, speed: number) {
    if (this.mode === 'off' || this.totaled || speed < 4) return;
    this.addDent(point, dir, clamp(0.3 + speed * 0.008, 0.3, 0.55), 0, clamp(speed / 30, 0.15, 0.8));
    this.rev++;
  }

  /** Totaled: everything loose goes, a wheel tears off, the glass gives. */
  private wreck(res: ImpactResult) {
    this.wreckTime = 0;
    res.totaled = true;
    this.glass = 1;
    this.lightsOut[0] = this.lightsOut[1] = true;
    LOOSE_PARTS.forEach((p, i) => {
      if (this.parts[i] === PartState.Gone) return;
      // a couple of parts hang on, mangled; the rest come off
      if (this.parts[i] === PartState.On && (p === PART.skirts || p === PART.exhaust) && this.rnd() < 0.5) {
        this.parts[i] = PartState.Loose;
        res.loosened.push(p);
        return;
      }
      this.parts[i] = PartState.Gone;
      res.detached.push(p);
    });
    // the most bent wheel goes
    let worst = 0;
    let bend = -1;
    this.wheels.forEach((w, i) => {
      const b = Math.abs(w.camber) + Math.abs(w.toe);
      if (b > bend) {
        bend = b;
        worst = i;
      }
    });
    this.wheels[worst].gone = true;
    res.wheels.push(worst);
    for (const w of this.wheels) w.camber = clamp(w.camber + 0.05 + this.rnd() * 0.06, -0.25, 0.25);
  }

  private updateParts(e: number, p: Vector3, res: ImpactResult) {
    const z = this.zone;
    const side = p.x >= 0 ? 1 : -1;
    const sideDmg = Math.max(z[ZONE_POS_X], z[ZONE_NEG_X]);
    const rules: [number, number, number, number][] = [
      // part, zone damage, loose at, gone at
      [PART.front, z[ZONE_FRONT], 0.3, 0.78],
      [PART.rear, z[ZONE_REAR], 0.32, 0.8],
      [PART.hood, z[ZONE_FRONT] * 0.9 + z[ZONE_TOP] * 0.5, 0.42, 1.05],
      [PART.skirts, sideDmg, 0.42, 0.95],
      [PART.spoiler, z[ZONE_REAR] * 0.8 + z[ZONE_TOP] * 0.7, 0.38, 0.85],
      [PART.exhaust, z[ZONE_REAR], 0.55, 1.2],
    ];
    for (const [part, dmg, looseAt, goneAt] of rules) {
      const i = CarDamage.slot(part);
      const st = this.parts[i];
      if (st === PartState.Gone) continue;
      // a hard blow on an already loose part rips it off sooner
      const rip = st === PartState.Loose && e > 14 ? 0.2 : 0;
      if (dmg + rip >= goneAt) {
        this.parts[i] = PartState.Gone;
        res.detached.push(part);
      } else if (st === PartState.On && dmg >= looseAt) {
        this.parts[i] = PartState.Loose;
        this.partSide[i] = part === PART.front || part === PART.rear ? side : this.rnd() < 0.5 ? 1 : -1;
        res.loosened.push(part);
      }
    }
  }

  private zoneOf(p: Vector3, dir: Vector3): number {
    const S = this.shape;
    if (dir.y < -0.6 && p.y > S.height * 0.6) return ZONE_TOP;
    const fz = p.z / (p.z > 0 ? S.front : S.back);
    const fx = Math.abs(p.x) / S.halfWidth;
    if (Math.abs(fz) > 0.62 && Math.abs(dir.z) > Math.abs(dir.x) * 0.6) return fz > 0 ? ZONE_FRONT : ZONE_REAR;
    if (fx > 0.6 || Math.abs(dir.x) > Math.abs(dir.z)) return p.x > 0 ? ZONE_POS_X : ZONE_NEG_X;
    return fz > 0 ? ZONE_FRONT : ZONE_REAR;
  }

  private addDent(point: Vector3, dir: Vector3, r: number, depth: number, scuff: number) {
    // a blow next to an old dent deepens and widens it instead of taking a new slot
    let best: Dent | null = null;
    let bestD = Infinity;
    for (const d of this.dents) {
      const dist = d.c.distanceTo(point);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    const near = best && bestD < Math.max(best.r, r) * 0.55;
    if (best && (near || this.dents.length >= MAX_DENTS)) {
      const w = depth > 0 ? clamp(depth / (best.depth + depth + 1e-4), 0.2, 0.8) : 0.15;
      if (near || depth > 0) {
        best.c.lerp(point, near ? w * 0.5 : w * 0.25);
        best.dir.lerp(TMP.copy(dir).normalize(), w).normalize();
      }
      best.depth = Math.min(MAX_DEPTH, Math.sqrt(best.depth * best.depth + depth * depth) + depth * 0.15);
      best.r = clamp(Math.max(best.r, r) + (near ? 0.04 : 0.1), 0.25, 1.15);
      best.scuff = Math.min(1, best.scuff + scuff * 0.7);
      if (depth > 0) best.vel -= depth * 14;
      return;
    }
    this.dents.push({
      c: point.clone(),
      dir: dir.clone().normalize(),
      r,
      depth,
      shown: 0,
      vel: depth * 10,
      scuff,
      seed: Math.floor(this.rnd() * 1000) / 100,
    });
  }

  /** Animate the dents settling (call every frame). */
  update(dt: number) {
    const h = Math.min(dt, 1 / 30);
    for (const d of this.dents) {
      // stiff, underdamped: the panel punches in past its final shape and springs back a touch
      d.vel += ((d.depth - d.shown) * 1400 - d.vel * 32) * h;
      d.shown += d.vel * h;
      if (d.shown < 0) {
        d.shown = 0;
        d.vel = Math.max(0, d.vel);
      }
    }
    if (this.wreckTime >= 0) this.wreckTime += dt;
  }

  /** Good as new. */
  repair() {
    this.dents.length = 0;
    this.parts.fill(PartState.On);
    for (const w of this.wheels) {
      w.camber = 0;
      w.toe = 0;
      w.gone = false;
    }
    this.zone.fill(0);
    this.health = 1;
    this.wreckTime = -1;
    this.lightsOut[0] = this.lightsOut[1] = false;
    this.glass = 0;
    this.rev++;
  }

  // ------------------------------------------------------------ wire format

  /**
   * A compact copy for the network: 7 + 3 per dent integers. Positions are
   * quantised to ~5 mm, directions to an octahedral 7+7 bits.
   */
  pack(): number[] {
    const out = [Math.round(this.health * 1000), this.rev, 0, 0, 0, 0, this.dents.length];
    let bits = 0;
    this.parts.forEach((s, i) => (bits |= s << (i * 2)));
    this.partSide.forEach((s, i) => (bits |= (s > 0 ? 1 : 0) << (12 + i)));
    this.wheels.forEach((w, i) => (bits |= (w.gone ? 1 : 0) << (18 + i)));
    bits |= (this.lightsOut[0] ? 1 : 0) << 22;
    bits |= (this.lightsOut[1] ? 1 : 0) << 23;
    bits |= Math.round(this.glass * 15) << 24;
    if (this.wreckTime >= 0) bits |= 1 << 28;
    out[2] = bits >>> 0;
    // zones: 5 × 6 bits
    let zb = 0;
    for (let i = 0; i < 5; i++) zb += Math.round(clamp(this.zone[i] / 1.5, 0, 1) * 63) * 64 ** i;
    out[3] = zb;
    // wheels: camber and toe, 8 bits each signed
    let wb = 0;
    this.wheels.forEach((w, i) => {
      wb += (q8(w.camber / 0.25) + q8(w.toe / 0.16) * 256) * 65536 ** (i % 2);
      if (i === 1) {
        out[4] = wb;
        wb = 0;
      }
    });
    out[5] = wb;
    for (const d of this.dents) {
      const a = qPos(d.c.x) + qPos(d.c.y) * 1024 + qPos(d.c.z) * 1048576;
      const [ox, oy] = octEncode(d.dir);
      const b = ox + oy * 128 + Math.round((d.depth / MAX_DEPTH) * 127) * 16384 + Math.round(((d.r - 0.2) / 1.0) * 63) * 2097152 + Math.round(d.scuff * 15) * 134217728;
      out.push(a, b, Math.round(d.seed * 100));
    }
    return out;
  }

  /**
   * Take on a copy sent by the car's owner. Returns the parts that just came
   * off (to throw them as debris here too) and whether the car was just wrecked.
   */
  unpack(a: number[], at = 0): { detached: number[]; wheels: number[]; totaled: boolean; repaired: boolean } | null {
    const res = { detached: [] as number[], wheels: [] as number[], totaled: false, repaired: false };
    const n = a[at + 6];
    if (!Number.isInteger(n) || n < 0 || n > MAX_DENTS || a.length < at + 7 + n * 3) return null;
    for (let i = at; i < at + 7 + n * 3; i++) if (typeof a[i] !== 'number' || !isFinite(a[i]) || a[i] < 0) return null;
    const rev = a[at + 1];
    if (rev === this.rev) return res;
    this.rev = rev;
    const wasHealth = this.health;
    const wasWreck = this.totaled;
    this.health = clamp(a[at] / 1000, 0, 1);
    const bits = a[at + 2] >>> 0;
    this.parts.forEach((old, i) => {
      const s = ((bits >>> (i * 2)) & 3) as PartState;
      if (s === PartState.Gone && old !== PartState.Gone) res.detached.push(LOOSE_PARTS[i]);
      this.parts[i] = s > 2 ? PartState.Gone : s;
      this.partSide[i] = (bits >>> (12 + i)) & 1 ? 1 : -1;
    });
    this.wheels.forEach((w, i) => {
      const gone = ((bits >>> (18 + i)) & 1) === 1;
      if (gone && !w.gone) res.wheels.push(i);
      w.gone = gone;
    });
    this.lightsOut[0] = ((bits >>> 22) & 1) === 1;
    this.lightsOut[1] = ((bits >>> 23) & 1) === 1;
    this.glass = ((bits >>> 24) & 15) / 15;
    const wreck = ((bits >>> 28) & 1) === 1;
    if (wreck && !wasWreck) {
      this.wreckTime = 0;
      res.totaled = true;
    } else if (!wreck) this.wreckTime = -1;
    let zb = a[at + 3];
    for (let i = 0; i < 5; i++) {
      this.zone[i] = ((zb % 64) / 63) * 1.5;
      zb = Math.floor(zb / 64);
    }
    for (let k = 0; k < 2; k++) {
      let wb = a[at + 4 + k];
      for (let j = 0; j < 2; j++) {
        const w = this.wheels[k * 2 + j];
        const lo = wb % 65536;
        wb = Math.floor(wb / 65536);
        w.camber = d8(lo % 256) * 0.25;
        w.toe = d8(Math.floor(lo / 256)) * 0.16;
      }
    }
    const old = this.dents.splice(0);
    for (let i = 0; i < n; i++) {
      const A = a[at + 7 + i * 3];
      const B = a[at + 8 + i * 3];
      const prev = old[i];
      const c = new Vector3(dPos(A % 1024), dPos(Math.floor(A / 1024) % 1024), dPos(Math.floor(A / 1048576) % 1024));
      const dir = octDecode(B % 128, Math.floor(B / 128) % 128);
      const depth = ((Math.floor(B / 16384) % 128) / 127) * MAX_DEPTH;
      const r = (Math.floor(B / 2097152) % 64) / 63 + 0.2;
      const scuff = (Math.floor(B / 134217728) % 16) / 15;
      const fresh = !prev || prev.c.distanceTo(c) > 0.3;
      this.dents.push({ c, dir, r, depth, shown: fresh ? 0 : prev.shown, vel: fresh ? depth * 10 : prev.vel, scuff, seed: a[at + 9 + i * 3] / 100 });
    }
    res.repaired = this.health > wasHealth + 0.5 && n === 0;
    return res;
  }
}

/** 10-bit position over ±2.6 m (5 mm steps). */
const qPos = (v: number) => Math.round(clamp((v + 2.6) / 5.2, 0, 1) * 1023);
const dPos = (q: number) => (q / 1023) * 5.2 - 2.6;
const q8 = (v: number) => Math.round(clamp(v, -1, 1) * 127) + 128;
const d8 = (q: number) => (q - 128) / 127;

function octEncode(v: Vector3): [number, number] {
  const l = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) || 1;
  let x = v.x / l;
  let y = v.y / l;
  if (v.z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  return [Math.round((x * 0.5 + 0.5) * 127), Math.round((y * 0.5 + 0.5) * 127)];
}

function octDecode(qx: number, qy: number): Vector3 {
  const x = (qx / 127) * 2 - 1;
  const y = (qy / 127) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const v = new Vector3(x, y, z);
  if (z < 0) {
    v.x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    v.y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
  }
  return v.normalize();
}
