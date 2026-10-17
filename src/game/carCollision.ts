import { Vector3 } from 'three';
import type { CarPhysics } from './carPhysics';

export interface CarContact {
  a: CarPhysics;
  b: CarPhysics;
  /** world-space contact point */
  point: Vector3;
  /** unit normal, from a to b */
  normal: Vector3;
  /** normal impulse per unit "arcade mass" (≈ m/s of velocity change), for effects */
  impulse: number;
  /** relative sliding speed along the contact, for scrape sparks */
  scrape: number;
  /** each car's own velocity change (m/s): the lighter car takes more of the hit */
  dvA: number;
  dvB: number;
}

/** How bouncy a hit is. Arcade: a solid "bonk", not billiards. */
const RESTITUTION = 0.38;
/** Minimum separation speed after any real hit, so contact always reads. */
const MIN_BOUNCE = 1.6;
/** Coulomb friction between bodywork: side-swipes drag and twist. */
const FRICTION = 0.32;
/** Scales how much an off-centre hit turns the car (1 = rigid body). */
const SPIN_GAIN = 0.35;
const MAX_SPIN = 2.4;
/** Penetration allowed before we push (avoids jitter while cars lean on each other). */
const SLOP = 0.01;
/** Max positional correction per step, so an overlapping respawn eases apart. */
const MAX_PUSH = 0.35;

interface Box {
  c: Vector3;
  f: Vector3;
  r: Vector3;
  len: number;
  w: number;
}

const boxA: Box = { c: new Vector3(), f: new Vector3(), r: new Vector3(), len: 0, w: 0 };
const boxB: Box = { c: new Vector3(), f: new Vector3(), r: new Vector3(), len: 0, w: 0 };
const N = new Vector3();
const D = new Vector3();
const AX = new Vector3();
const BEST = new Vector3();
const P = new Vector3();
const RA = new Vector3();
const RB = new Vector3();
const VA = new Vector3();
const VB = new Vector3();
const T = new Vector3();
const TANG = new Vector3();
const J = new Vector3();
const AXES = [boxA.f, boxA.r, boxB.f, boxB.r];

/** Oriented box of a car, flattened onto the shared contact plane (normal N). */
function makeBox(out: Box, p: CarPhysics) {
  const h = p.hitbox;
  out.f.copy(p.fwd).addScaledVector(N, -p.fwd.dot(N)).normalize();
  out.r.crossVectors(out.f, N).normalize();
  out.len = (h.front + h.back) * 0.5;
  out.w = h.halfWidth;
  out.c.copy(p.pos).addScaledVector(out.f, (h.front - h.back) * 0.5);
  out.c.addScaledVector(N, -out.c.dot(N));
}

function radius(b: Box, axis: Vector3) {
  return b.len * Math.abs(b.f.dot(axis)) + b.w * Math.abs(b.r.dot(axis));
}

/** 2D cross product in the contact plane: (r × v) · N. */
function cross(r: Vector3, v: Vector3) {
  return T.crossVectors(r, v).dot(N);
}

/**
 * Car-to-car collisions as oriented boxes sized from each car's real parts
 * (separating axis test), resolved with a rigid-body impulse: mass ratio,
 * restitution, friction and spin from off-centre hits. Returns the contacts
 * of this step so the race can add sparks, sound and camera shake.
 */
export function collideCars(cars: CarPhysics[], out: CarContact[]): CarContact[] {
  out.length = 0;
  const n = cars.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = collidePair(cars[i], cars[j]);
      if (c) out.push(c);
    }
  }
  return out;
}

function collidePair(a: CarPhysics, b: CarPhysics): CarContact | null {
  const ha = a.hitbox;
  const hb = b.hitbox;
  D.copy(b.pos).sub(a.pos);
  const reach = Math.max(ha.front, ha.back) + Math.max(hb.front, hb.back) + ha.halfWidth + hb.halfWidth;
  if (D.lengthSq() > reach * reach) return null;

  // shared plane: halfway between both decks (they differ on loops & banks)
  N.copy(a.up).add(b.up);
  if (N.lengthSq() < 0.5) return null; // one is upside down relative to the other
  N.normalize();
  // stacked vertically (a car flying over another): only touch if the boxes overlap in height too
  const vert = D.dot(N);
  if (vert > ha.height * 0.92 || -vert > hb.height * 0.92) return null;

  makeBox(boxA, a);
  makeBox(boxB, b);
  D.copy(boxB.c).sub(boxA.c);

  let minOverlap = Infinity;
  let bestIdx = -1;
  for (let k = 0; k < 4; k++) {
    AX.copy(AXES[k]);
    const dist = D.dot(AX);
    const overlap = radius(boxA, AX) + radius(boxB, AX) - Math.abs(dist);
    if (overlap <= 0) return null;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      bestIdx = k;
      BEST.copy(AX).multiplyScalar(dist < 0 ? -1 : 1);
    }
  }
  const normal = BEST; // from a to b

  // contact point: the deepest corner of the "incident" box
  if (bestIdx < 2) {
    P.copy(boxB.c)
      .addScaledVector(boxB.f, -boxB.len * Math.sign(boxB.f.dot(normal) || 1))
      .addScaledVector(boxB.r, -boxB.w * Math.sign(boxB.r.dot(normal) || 1));
  } else {
    P.copy(boxA.c)
      .addScaledVector(boxA.f, boxA.len * Math.sign(boxA.f.dot(normal) || 1))
      .addScaledVector(boxA.r, boxA.w * Math.sign(boxA.r.dot(normal) || 1));
  }
  // pull it to the middle of the overlap so neither car gets a free lever arm
  P.addScaledVector(normal, bestIdx < 2 ? minOverlap * 0.5 : -minOverlap * 0.5);

  const ma = a.stats.mass;
  const mb = b.stats.mass;
  const ia = (ma * (boxA.len * boxA.len + boxA.w * boxA.w)) / 3;
  const ib = (mb * (boxB.len * boxB.len + boxB.w * boxB.w)) / 3;
  const inva = 1 / ma;
  const invb = 1 / mb;

  // positional correction, split by mass
  const push = Math.min(MAX_PUSH, Math.max(0, minOverlap - SLOP));
  if (push > 0) {
    const sum = inva + invb;
    a.pos.addScaledVector(normal, (-push * inva) / sum);
    b.pos.addScaledVector(normal, (push * invb) / sum);
  }

  // lever arms from each car's centre of mass (its origin, between the axles)
  RA.copy(P).sub(a.pos);
  RA.addScaledVector(N, -RA.dot(N));
  RB.copy(P).sub(b.pos);
  RB.addScaledVector(N, -RB.dot(N));
  const wa = a.yawRate + a.spin;
  const wb = b.yawRate + b.spin;
  // v_point = v + ω × r, with ω along N
  VA.copy(a.vel).add(T.crossVectors(N, RA).multiplyScalar(wa));
  VB.copy(b.vel).add(T.crossVectors(N, RB).multiplyScalar(wb));
  const rel = VB.sub(VA); // relative velocity of b w.r.t. a at the contact
  rel.addScaledVector(N, -rel.dot(N));
  const vn = rel.dot(normal);
  if (vn >= 0) return null; // already separating

  const raN = cross(RA, normal);
  const rbN = cross(RB, normal);
  const kn = inva + invb + (raN * raN) / ia + (rbN * rbN) / ib;
  const target = Math.max(-vn * RESTITUTION, Math.min(MIN_BOUNCE, -vn));
  const jn = (-vn + target) / kn;

  // friction along the contact
  const tangent = TANG.copy(rel).addScaledVector(normal, -vn);
  const vt = tangent.length();
  let jt = 0;
  const tdir = AX;
  if (vt > 1e-3) {
    tdir.copy(tangent).multiplyScalar(1 / vt);
    const raT = cross(RA, tdir);
    const rbT = cross(RB, tdir);
    const kt = inva + invb + (raT * raT) / ia + (rbT * rbT) / ib;
    jt = Math.min(vt / kt, FRICTION * jn);
  } else tdir.set(0, 0, 0);

  // total impulse on b (a gets the opposite)
  J.copy(normal).multiplyScalar(jn).addScaledVector(tdir, -jt);
  a.vel.addScaledVector(J, -inva);
  b.vel.addScaledVector(J, invb);
  const da = clamp((-cross(RA, J) / ia) * SPIN_GAIN, -MAX_SPIN, MAX_SPIN);
  const db = clamp((cross(RB, J) / ib) * SPIN_GAIN, -MAX_SPIN, MAX_SPIN);
  a.spin = clamp(a.spin + da, -MAX_SPIN, MAX_SPIN);
  b.spin = clamp(b.spin + db, -MAX_SPIN, MAX_SPIN);

  // chassis rock, felt by both drivers
  const dv = jn * (inva + invb) * 0.5;
  const strength = Math.min(1, dv / 14);
  a.jolt(normal.dot(a.right), normal.dot(a.fwd), strength * (mb / (ma + mb)) * 2);
  b.jolt(-normal.dot(b.right), -normal.dot(b.fwd), strength * (ma / (ma + mb)) * 2);

  return { a, b, point: P.clone(), normal: normal.clone(), impulse: dv, scrape: vt, dvA: Math.hypot(jn, jt) * inva, dvB: Math.hypot(jn, jt) * invb };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
