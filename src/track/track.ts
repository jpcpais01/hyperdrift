import { Vector3 } from 'three';

/**
 * The track is built with a "turtle": a list of segments that change heading
 * (yaw), pitch and bank along the way. Integrating them gives a dense list of
 * samples (one per metre) with a full orthonormal frame, which is used both to
 * build the mesh and to answer physics queries in track space (no raycasts).
 *
 * Conventions: forward = F, up = U, right = R = F x U. Positive yaw turns left.
 */

export interface SegmentDef {
  len: number;
  /** total yaw change over the segment, degrees (positive = left) */
  yaw?: number;
  /** pitch at the end of the segment, degrees (eased from the current value) */
  pitch?: number;
  /** extra pitch rotation added linearly (used by loops), degrees */
  pitchSpin?: number;
  /** bank at the end of the segment, degrees (positive tilts the surface towards the right) */
  bank?: number;
  /** lateral drift over the segment, metres (keeps loops from overlapping) */
  shift?: number;
  gap?: boolean;
  tunnel?: boolean;
  boost?: boolean;
  pickups?: boolean;
  loop?: boolean;
}

export interface TrackSample {
  s: number;
  pos: Vector3;
  fwd: Vector3;
  up: Vector3;
  right: Vector3;
  gap: boolean;
  tunnel: boolean;
  loop: boolean;
}

export interface BoostPad {
  s: number;
  lateral: number;
}

export interface Pickup {
  s: number;
  lateral: number;
}

export interface TrackQuery {
  index: number;
  t: number;
  /** distance along the track, metres */
  s: number;
  pos: Vector3;
  fwd: Vector3;
  up: Vector3;
  right: Vector3;
  lateral: number;
  height: number;
  gap: boolean;
  tunnel: boolean;
}

const DEG = Math.PI / 180;
const smooth = (t: number) => t * t * (3 - 2 * t);

export const TRACK_WIDTH = 18;
export const HALF_WIDTH = TRACK_WIDTH / 2;

export class Track {
  readonly samples: TrackSample[] = [];
  readonly length: number;
  readonly boostPads: BoostPad[] = [];
  readonly pickups: Pickup[] = [];
  /** world-space closure error that was spread over the lap (for tests) */
  readonly closureError: number;
  readonly closureVector: Vector3;

  constructor(defs: SegmentDef[], start = new Vector3(0, 120, 0)) {
    const ds = 1;
    let yaw = 0;
    let pitch = 0;
    let bank = 0;
    const pos = start.clone();
    let s = 0;
    const raw: { pos: Vector3; yaw: number; pitch: number; bank: number; def: SegmentDef; shiftRight: Vector3 }[] = [];

    for (const def of defs) {
      const steps = Math.max(1, Math.round(def.len / ds));
      const yaw0 = yaw;
      const pitch0 = pitch;
      const bank0 = bank;
      const yawEnd = yaw0 + (def.yaw ?? 0) * DEG;
      const pitchEnd = def.pitch !== undefined ? def.pitch * DEG : pitch0;
      const bankEnd = def.bank !== undefined ? def.bank * DEG : bank0;
      const spin = (def.pitchSpin ?? 0) * DEG;
      for (let i = 0; i < steps; i++) {
        const u = (i + 0.5) / steps;
        yaw = yaw0 + (yawEnd - yaw0) * u;
        const p = pitch0 + (pitchEnd - pitch0) * smooth(u) + spin * u;
        bank = bank0 + (bankEnd - bank0) * smooth(u);
        const f = dirFrom(yaw, p);
        const r = new Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
        raw.push({ pos: pos.clone(), yaw, pitch: p, bank, def, shiftRight: r });
        pos.addScaledVector(f, ds);
        if (def.shift) pos.addScaledVector(r, def.shift / steps);
        s += ds;
      }
      yaw = yawEnd;
      pitch = pitchEnd; // spin is a full turn, so it does not change the end pitch
      // a full corkscrew ends at 360 degrees, which is the same as flat
      bank = Math.atan2(Math.sin(bankEnd), Math.cos(bankEnd));
    }

    // Spread the closure error over the whole lap so the end meets the start.
    const err = start.clone().sub(pos);
    this.closureError = err.length();
    this.closureVector = err.clone();
    const n = raw.length;
    for (let i = 0; i < n; i++) {
      raw[i].pos.addScaledVector(err, i / n);
    }
    this.length = n * ds;

    for (let i = 0; i < n; i++) {
      const r = raw[i];
      const next = raw[(i + 1) % n].pos;
      const prev = raw[(i - 1 + n) % n].pos;
      const fwd = next.clone().sub(prev).normalize();
      // Build the frame from yaw/pitch/bank, then re-orthogonalise with the actual tangent.
      const right0 = new Vector3(-Math.cos(r.yaw), 0, Math.sin(r.yaw));
      const up0 = new Vector3().crossVectors(right0, dirFrom(r.yaw, r.pitch));
      const up = up0.clone().multiplyScalar(Math.cos(r.bank)).addScaledVector(right0, Math.sin(r.bank));
      const right = new Vector3().crossVectors(fwd, up).normalize();
      up.crossVectors(right, fwd).normalize();
      this.samples.push({
        s: i * ds,
        pos: r.pos,
        fwd,
        up,
        right,
        gap: !!r.def.gap,
        tunnel: !!r.def.tunnel,
        loop: !!r.def.loop,
      });
    }

    // Boost pads and pickups along flagged segments.
    let acc = 0;
    for (const def of defs) {
      if (def.boost) {
        const count = Math.max(1, Math.floor(def.len / 45));
        for (let k = 0; k < count; k++) {
          const lat = [-4.5, 4.5, 0][k % 3];
          this.boostPads.push({ s: acc + ((k + 0.5) / count) * def.len, lateral: lat });
        }
      }
      if (def.pickups) {
        const rows = Math.max(1, Math.floor(def.len / 60));
        for (let k = 0; k < rows; k++) {
          for (const lat of [-5, 0, 5]) {
            this.pickups.push({ s: acc + ((k + 0.5) / rows) * def.len, lateral: lat + (k % 2 ? 2 : -2) });
          }
        }
      }
      acc += def.len;
    }
  }

  sample(i: number): TrackSample {
    const n = this.samples.length;
    return this.samples[((i % n) + n) % n];
  }

  wrapS(s: number): number {
    return ((s % this.length) + this.length) % this.length;
  }

  indexAt(s: number): number {
    return Math.floor(this.wrapS(s)) % this.samples.length;
  }

  /** Frame at distance s (interpolated). */
  frameAt(s: number, out: TrackQuery = makeQuery()): TrackQuery {
    const w = this.wrapS(s);
    const i = Math.floor(w);
    const t = w - i;
    return this.fill(out, i, t, 0, 0);
  }

  /** World position at distance s, lateral offset and height above the surface. */
  pointAt(s: number, lateral: number, height: number, out = new Vector3()): Vector3 {
    const q = this.frameAt(s, scratchQuery);
    return out.copy(q.pos).addScaledVector(q.right, lateral).addScaledVector(q.up, height);
  }

  /**
   * Project a world position onto the track, starting the search at `hint`.
   * The search is local, so loops and crossings never get confused.
   */
  query(p: Vector3, hint: number, out: TrackQuery = makeQuery()): TrackQuery {
    const n = this.samples.length;
    let i = ((hint % n) + n) % n;
    let t = 0;
    let dir = 0;
    for (let iter = 0; iter < 64; iter++) {
      const a = this.samples[i];
      const b = this.samples[(i + 1) % n];
      const seg = tmpA.copy(b.pos).sub(a.pos);
      const len2 = seg.lengthSq();
      t = tmpB.copy(p).sub(a.pos).dot(seg) / len2;
      if (t > 1) {
        // reversing direction means the point sits on the outside of a bend between two segments
        if (dir < 0) {
          t = 1;
          break;
        }
        dir = 1;
        i = (i + 1) % n;
      } else if (t < 0) {
        if (dir > 0) {
          t = 0;
          break;
        }
        dir = -1;
        i = (i - 1 + n) % n;
      } else break;
    }
    t = Math.min(1, Math.max(0, t));
    this.fill(out, i, t, 0, 0);
    const d = tmpA.copy(p).sub(out.pos);
    out.lateral = d.dot(out.right);
    out.height = d.dot(out.up);
    return out;
  }

  private fill(out: TrackQuery, i: number, t: number, lateral: number, height: number): TrackQuery {
    const n = this.samples.length;
    const a = this.samples[i];
    const b = this.samples[(i + 1) % n];
    out.index = i;
    out.t = t;
    out.s = a.s + t;
    out.pos.copy(a.pos).lerp(b.pos, t);
    out.fwd.copy(a.fwd).lerp(b.fwd, t).normalize();
    out.up.copy(a.up).lerp(b.up, t).normalize();
    out.right.crossVectors(out.fwd, out.up).normalize();
    out.lateral = lateral;
    out.height = height;
    out.gap = t < 0.5 ? a.gap : b.gap;
    out.tunnel = a.tunnel;
    return out;
  }
}

export function makeQuery(): TrackQuery {
  return {
    index: 0,
    t: 0,
    s: 0,
    pos: new Vector3(),
    fwd: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    right: new Vector3(-1, 0, 0),
    lateral: 0,
    height: 0,
    gap: false,
    tunnel: false,
  };
}

function dirFrom(yaw: number, pitch: number): Vector3 {
  return new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const scratchQuery = makeQuery();
