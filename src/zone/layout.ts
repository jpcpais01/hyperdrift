import { Vector3 } from 'three';
import type { TrackQuery } from '../track/track';

/**
 * "Jardim Celeste": the free-roam drift zone. A floating island shaped like a shallow
 * bowl: a polished drift plaza in the middle, a rolling meadow with groves, kickers and
 * light gates, and a banked asphalt ring that runs all the way round the rim. The ground
 * is one analytic height function, so physics and meshes always agree, and the whole
 * layout is generated from fixed seeds (every player sees exactly the same island).
 */

/** World height of the plaza. */
export const ZONE_Y = 110;
/** Radius of the polished drift plaza (flat). */
export const PLAZA_R = 96;
/** Where the banked rim ring starts and ends. */
export const BANK_IN = 212;
export const BANK_OUT = 250;
/** Height of the rim above the plaza. */
export const BANK_H = 12;
/** The force field that keeps cars on the island. */
export const WALL_R = 248.5;
/** Outer edge of the stone ledge, where the cliff begins. */
export const LEDGE_R = 258;
/** Giant chrome ring standing over the middle of the plaza (x-y plane, drive through along z). */
export const RING_R = 26;
export const RING_TUBE = 1.3;
export const RING_CY = 14;
export const RING_FOOT_X = Math.sqrt(RING_R * RING_R - RING_CY * RING_CY);

export interface Kicker {
  /** lip position */
  x: number;
  z: number;
  /** unit direction of travel up the ramp */
  dx: number;
  dz: number;
  len: number;
  height: number;
  back: number;
  width: number;
}

export interface Hill {
  x: number;
  z: number;
  a: number;
  s: number;
}

export type ObstacleKind = 'tree' | 'lantern' | 'lamp' | 'rock' | 'ring' | 'gate';

export interface Obstacle {
  x: number;
  z: number;
  r: number;
  kind: ObstacleKind;
}

export interface Tree {
  x: number;
  z: number;
  scale: number;
  rot: number;
  variant: number;
}

export interface Rock {
  x: number;
  z: number;
  scale: number;
  rot: number;
}

export interface Gate {
  x: number;
  z: number;
  /** unit direction across the gate (from one pillar to the other) */
  ax: number;
  az: number;
  half: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** The meadow loop the touring car follows: a wavy circle through the groves. */
export function tourPoint(theta: number, out = new Vector3()): Vector3 {
  const r = 158 + 22 * Math.sin(3 * theta + 0.5);
  return out.set(Math.cos(theta) * r, 0, Math.sin(theta) * r);
}

/** Samples a closed curve every ~`step` metres. */
export function samplePath(fn: (t: number, out: Vector3) => Vector3, step = 2): Vector3[] {
  const raw: Vector3[] = [];
  const N = 2000;
  for (let i = 0; i < N; i++) raw.push(fn((i / N) * Math.PI * 2, new Vector3()));
  let len = 0;
  for (let i = 0; i < N; i++) len += raw[i].distanceTo(raw[(i + 1) % N]);
  const count = Math.round(len / step);
  const out: Vector3[] = [];
  let acc = 0;
  let k = 0;
  for (let i = 0; i < N && k < count; i++) {
    const a = raw[i];
    const b = raw[(i + 1) % N];
    const d = a.distanceTo(b);
    while (acc + d >= (k * len) / count && k < count) {
      const t = ((k * len) / count - acc) / d;
      out.push(a.clone().lerp(b, t));
      k++;
    }
    acc += d;
  }
  return out;
}

export const circlePath = (r: number, cw = false, cx = 0, cz = 0) => (t: number, out: Vector3) =>
  out.set(cx + Math.cos(cw ? -t : t) * r, 0, cz + Math.sin(cw ? -t : t) * r);

/**
 * Gymkhana stadium painted on the plaza (two hairpins joined by straights, running along z):
 * the resident drifters slide through every hairpin in tandem.
 */
export const STADIUM = { x: 56, z: 0, half: 26, r: 19 };

/** The stadium loop as a closed curve (parameter t in 0..2π, clockwise seen from above). */
export function stadiumPoint(t: number, out = new Vector3()): Vector3 {
  const { x, z, half, r } = STADIUM;
  const straight = 2 * half;
  const arc = Math.PI * r;
  const per = 2 * straight + 2 * arc;
  let d = ((t / (Math.PI * 2)) * per) % per;
  if (d < straight) return out.set(x + r, 0, z - half + d);
  d -= straight;
  if (d < arc) {
    const a = d / r;
    return out.set(x + Math.cos(a) * r, 0, z + half + Math.sin(a) * r);
  }
  d -= arc;
  if (d < straight) return out.set(x - r, 0, z + half - d);
  d -= straight;
  const a = Math.PI + d / r;
  return out.set(x + Math.cos(a) * r, 0, z - half + Math.sin(a) * r);
}

export class ZoneLayout {
  readonly kickers: Kicker[] = [];
  readonly hills: Hill[] = [];
  readonly obstacles: Obstacle[] = [];
  readonly trees: Tree[] = [];
  readonly rocks: Rock[] = [];
  readonly gates: Gate[] = [];
  readonly lanterns: Vector3[] = [];
  readonly lamps: Vector3[] = [];
  readonly tour: Vector3[];
  /** spatial hash of solid obstacles, 16 m cells */
  private cells = new Map<number, Obstacle[]>();

  constructor() {
    this.tour = samplePath(tourPoint, 2);
    const tangent = (theta: number) => {
      const a = tourPoint(theta - 0.002);
      const b = tourPoint(theta + 0.002);
      return b.sub(a).normalize();
    };

    // kickers sit on the tour line where it runs straight (so a jump lands back on it),
    // lip on the line, ramp rising in the direction of travel
    for (const th of [1.12, 3.21, 5.31]) {
      const p = tourPoint(th);
      const d = tangent(th);
      this.kickers.push({ x: p.x, z: p.z, dx: d.x, dz: d.z, len: 17, height: 2.7, back: 8, width: 10 });
    }
    // light gates on the tour line, between the kickers
    for (const th of [1.92, 4.01, 6.1]) {
      const p = tourPoint(th);
      const d = tangent(th);
      this.gates.push({ x: p.x, z: p.z, ax: -d.z, az: d.x, half: 11 });
    }

    // rolling hills in the meadow, kept off the kicker run-ups
    const r = rng(9001);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + r() * 0.5;
      const rad = 125 + r() * 70;
      this.hills.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, a: 2.2 + r() * 3.2, s: 18 + r() * 14 });
    }

    // the chrome ring's feet
    for (const sx of [-1, 1]) {
      this.addSolid({ x: sx * (RING_FOOT_X - 1.1), z: 0, r: 1.45, kind: 'ring' });
      this.addSolid({ x: sx * (RING_FOOT_X + 1.1), z: 0, r: 1.45, kind: 'ring' });
    }
    for (const g of this.gates) {
      for (const s of [-1, 1]) this.addSolid({ x: g.x + g.ax * g.half * s, z: g.z + g.az * g.half * s, r: 1.1, kind: 'gate' });
    }
    // stone lanterns around the plaza, lamp posts along the foot of the banked ring
    for (let i = 0; i < 12; i++) {
      const a = ((i + 0.5) / 12) * Math.PI * 2;
      const p = new Vector3(Math.cos(a) * 101, 0, Math.sin(a) * 101);
      this.lanterns.push(p);
      this.addSolid({ x: p.x, z: p.z, r: 0.75, kind: 'lantern' });
    }
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const p = new Vector3(Math.cos(a) * 207, 0, Math.sin(a) * 207);
      this.lamps.push(p);
      this.addSolid({ x: p.x, z: p.z, r: 0.4, kind: 'lamp' });
    }

    // groves: clusters of trees and boulders, clear of the tour line, kickers and gates
    const clearOf = (x: number, z: number, pad: number) => {
      const rr = Math.hypot(x, z);
      if (rr < PLAZA_R + 14 || rr > BANK_IN - 9) return false;
      for (const p of this.tour) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (13 + pad) ** 2) return false;
      for (const k of this.kickers) {
        // the run-up and the landing zone
        for (let t = -k.len - 4; t < 70; t += 4) {
          if ((k.x + k.dx * t - x) ** 2 + (k.z + k.dz * t - z) ** 2 < (12 + pad) ** 2) return false;
        }
      }
      for (const o of this.obstacles) if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.r + pad + 4.5) ** 2) return false;
      for (const l of [...this.lanterns, ...this.lamps]) if ((l.x - x) ** 2 + (l.z - z) ** 2 < (pad + 6) ** 2) return false;
      return true;
    };
    const tr = rng(4242);
    const groves: { x: number; z: number }[] = [];
    let guard = 0;
    while (groves.length < 11 && guard++ < 2000) {
      const a = tr() * Math.PI * 2;
      const rad = 112 + tr() * 92;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (!clearOf(x, z, 4)) continue;
      if (groves.some((g) => (g.x - x) ** 2 + (g.z - z) ** 2 < 46 * 46)) continue;
      groves.push({ x, z });
    }
    groves.forEach((g, gi) => {
      const count = 7 + Math.floor(tr() * 7);
      // each grove has a dominant species, with a few of the others mixed in
      const main = gi % 3;
      let placed = 0;
      for (let k = 0; k < 80 && placed < count; k++) {
        const a = tr() * Math.PI * 2;
        const d = Math.sqrt(tr()) * 24;
        const x = g.x + Math.cos(a) * d;
        const z = g.z + Math.sin(a) * d;
        if (!clearOf(x, z, 0)) continue;
        const variant = tr() < 0.75 ? main : Math.floor(tr() * 3);
        const scale = 0.8 + tr() * 0.55;
        this.trees.push({ x, z, scale, rot: tr() * Math.PI * 2, variant });
        this.addSolid({ x, z, r: 0.55 * scale + 0.25, kind: 'tree' });
        placed++;
      }
      for (let k = 0; k < 2; k++) {
        const a = tr() * Math.PI * 2;
        const d = 8 + tr() * 18;
        const x = g.x + Math.cos(a) * d;
        const z = g.z + Math.sin(a) * d;
        if (!clearOf(x, z, 1)) continue;
        const scale = 1.2 + tr() * 1.6;
        this.rocks.push({ x, z, scale, rot: tr() * Math.PI * 2 });
        this.addSolid({ x, z, r: scale * 0.95, kind: 'rock' });
      }
    });
    // a ring of blossom trees on the ledge outside the force field (scenery only)
    const n = 120;
    for (let i = 0; i < n; i++) {
      const a = ((i + tr() * 0.6) / n) * Math.PI * 2;
      const rad = 253.5 + tr() * 3;
      this.trees.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, scale: 0.75 + tr() * 0.5, rot: tr() * 6.28, variant: tr() < 0.7 ? 0 : 2 });
    }
  }

  private addSolid(o: Obstacle) {
    this.obstacles.push(o);
    // padded by the largest car radius, so a lookup in the car's own cell finds everything it can touch
    const m = o.r + 2;
    const x0 = Math.floor((o.x - m) / 16);
    const x1 = Math.floor((o.x + m) / 16);
    const z0 = Math.floor((o.z - m) / 16);
    const z1 = Math.floor((o.z + m) / 16);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = cellKey(x, z);
        let c = this.cells.get(key);
        if (!c) this.cells.set(key, (c = []));
        c.push(o);
      }
    }
  }

  /** Ground height without kickers (what the grass mesh follows). */
  baseHeight(x: number, z: number): number {
    const r = Math.hypot(x, z);
    let h = 0;
    if (r > BANK_IN) {
      const t = Math.min(1, (r - BANK_IN) / (BANK_OUT - BANK_IN));
      h = BANK_H * t * t;
    }
    const w = smooth(PLAZA_R + 2, PLAZA_R + 22, r) * (1 - smooth(BANK_IN - 26, BANK_IN - 3, r));
    if (w > 0) {
      let m = 0.45 * Math.sin(x * 0.043 + 1.3) * Math.sin(z * 0.051 - 0.4) + 0.3 * Math.sin(x * 0.11 - z * 0.07);
      for (const hl of this.hills) {
        const d2 = (x - hl.x) ** 2 + (z - hl.z) ** 2;
        if (d2 < 9 * hl.s * hl.s) m += hl.a * Math.exp(-d2 / (2 * hl.s * hl.s));
      }
      h += m * w;
    }
    return ZONE_Y + h;
  }

  /** Kicker ramp height above the base ground at (x, z). */
  kickerHeight(x: number, z: number): number {
    let best = 0;
    for (const k of this.kickers) {
      const rx = x - k.x;
      const rz = z - k.z;
      const u = rx * k.dx + rz * k.dz; // 0 at the lip, negative on the run-up
      if (u < -k.len || u > k.back) continue;
      const v = Math.abs(rx * -k.dz + rz * k.dx);
      const side = 1 - smooth(k.width / 2 - 0.5, k.width / 2 + 2.5, v);
      if (side <= 0) continue;
      const prof = u <= 0 ? Math.pow((u + k.len) / k.len, 1.8) : 1 - smooth(0, k.back, u);
      best = Math.max(best, k.height * prof * side);
    }
    return best;
  }

  heightAt(x: number, z: number): number {
    return this.baseHeight(x, z) + this.kickerHeight(x, z);
  }

  normalAt(x: number, z: number, out = new Vector3()): Vector3 {
    const e = 0.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Ground frame under p, in the same shape as a track query (so the car physics can use it). */
  query(p: Vector3, fwdHint: Vector3, out: TrackQuery): TrackQuery {
    const h = this.heightAt(p.x, p.z);
    this.normalAt(p.x, p.z, out.up);
    out.pos.set(p.x, h, p.z);
    out.height = (p.y - h) * out.up.y;
    out.fwd.copy(fwdHint).addScaledVector(out.up, -fwdHint.dot(out.up));
    if (out.fwd.lengthSq() < 1e-6) out.fwd.set(0, 0, 1);
    out.fwd.normalize();
    out.right.crossVectors(out.fwd, out.up).normalize();
    out.lateral = 0;
    out.index = 0;
    out.t = 0;
    out.s = 0;
    out.gap = Math.hypot(p.x, p.z) > LEDGE_R;
    out.tunnel = false;
    return out;
  }

  /**
   * Pushes a car (as a circle of `radius`) out of the force field and every solid obstacle.
   * Returns the push distance (0 = no contact); `normal` gets the direction it was pushed.
   */
  collide(pos: Vector3, radius: number, normal: Vector3): number {
    let total = 0;
    const r = Math.hypot(pos.x, pos.z);
    if (r + radius > WALL_R) {
      const d = r + radius - WALL_R;
      normal.set(-pos.x / r, 0, -pos.z / r);
      pos.x += normal.x * d;
      pos.z += normal.z * d;
      total = d;
    }
    const cell = this.cells.get(cellKey(Math.floor(pos.x / 16), Math.floor(pos.z / 16)));
    if (cell) {
      for (const o of cell) {
        const dx = pos.x - o.x;
        const dz = pos.z - o.z;
        const min = o.r + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const push = min - d;
        if (push > total) normal.set(dx / d, 0, dz / d);
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
        total = Math.max(total, push);
      }
    }
    return total;
  }

  /** A spawn spot on the plaza (index picks one of a row), facing the chrome ring. */
  spawn(i: number, pos: Vector3, fwd: Vector3) {
    const x = ((i % 4) - 1.5) * 7;
    const z = -74 - Math.floor(i / 4) * 9;
    pos.set(x, this.heightAt(x, z) + 0.05, z);
    fwd.set(0, 0, 1);
  }
}

function cellKey(x: number, z: number) {
  return (x + 1000) * 4096 + (z + 1000);
}
