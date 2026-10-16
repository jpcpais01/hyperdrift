/**
 * The driver's arms and gloved hands.
 *
 * The hands are built from anatomically proportioned finger bones (three
 * phalanges each, tapered, with knuckle pads), a shaped palm, a thumb and a
 * gauntlet cuff. Every hand pose (wrapped round the wheel rim, relaxed and
 * open, cupping a gear knob) is generated with the same topology and stored
 * as morph targets, so the fingers can open and close smoothly as the hand
 * lets go of the wheel or reaches for a lever.
 *
 * The arms are one continuous skinned sleeve per side, from shoulder to
 * wrist, bent at the elbow by a two-bone IK: no ball joints, no seams. The
 * race suit carries a stripe down the outside of each arm and soft folds at
 * the elbow.
 *
 * Hand space (right hand): the gripped tube runs along +y through the origin,
 * +z points back towards the driver, +x away from the wheel centre (the back
 * of the hand faces +x). The left hand is the mirror image.
 */
import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const UPPER = 0.3;
export const FORE = 0.285;

/** Morph target order on the hand geometry (the base pose is the wheel grip). */
export const MORPH_OPEN = 0;
export const MORPH_KNOB = 1;

// ---------------------------------------------------------------- building blocks

const Y = new Vector3(0, 1, 0);

/** A tapered capsule along +y from 0 to len (rounded ends reach past both). */
function capsule(r0: number, r1: number, len: number, radial = 10, cap = 4): BufferGeometry {
  const pts: Vector2[] = [];
  for (let i = 0; i <= cap; i++) {
    const a = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-5, Math.cos(a) * r0), Math.sin(a) * r0));
  }
  for (let i = 0; i <= cap; i++) {
    const a = (i / cap) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(1e-5, Math.cos(a) * r1), len + Math.sin(a) * r1));
  }
  return new LatheGeometry(pts, radial);
}

/** Basis whose +y runs a→b, rolled so +x stays near `ref`. */
function along(a: Vector3, b: Vector3, ref: Vector3 = Y): Matrix4 {
  const y = b.clone().sub(a).normalize();
  let x = ref.clone().addScaledVector(y, -ref.dot(y));
  if (x.lengthSq() < 1e-8) x = new Vector3(1, 0, 0).addScaledVector(y, -y.x);
  x.normalize();
  const z = new Vector3().crossVectors(x, y);
  return new Matrix4().makeBasis(x, y, z).setPosition(a);
}

/** A bone segment from a to b. */
function segment(a: Vector3, b: Vector3, r0: number, r1: number, ref?: Vector3, radial = 10): BufferGeometry {
  return capsule(r0, r1, a.distanceTo(b), radial).applyMatrix4(along(a, b, ref));
}

/** A rounded box-ish blob: a sphere pushed towards a superellipsoid. */
function blob(rx: number, ry: number, rz: number, m: Matrix4, square = 0.62, ws = 18, hs = 12): BufferGeometry {
  const g = new SphereGeometry(1, ws, hs);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const f = (v: number) => Math.sign(v) * Math.abs(v) ** square;
    p.setXYZ(i, f(p.getX(i)) * rx, f(p.getY(i)) * ry, f(p.getZ(i)) * rz);
  }
  g.computeVertexNormals();
  return g.applyMatrix4(m);
}

/** An elliptical tube along +y with a radius profile; rings[i] = [y, rx, rz]. */
function loft(rings: [number, number, number][], radial = 16, close = true): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const cols = radial + 1;
  for (const [y, rx, rz] of rings) {
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      pos.push(Math.cos(a) * rx, y, Math.sin(a) * rz);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  if (close) {
    // cap both ends with a fan
    for (const [ring, flip] of [
      [0, true],
      [rings.length - 1, false],
    ] as const) {
      const c = pos.length / 3;
      pos.push(0, rings[ring][0], 0);
      for (let j = 0; j < radial; j++) {
        const a = ring * cols + j;
        if (flip) idx.push(c, a, a + 1);
        else idx.push(c, a + 1, a);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function merge(list: BufferGeometry[]): BufferGeometry {
  const clean = list.map((g) => {
    const c = g.index ? g : g.toNonIndexed();
    for (const k of Object.keys(c.attributes)) if (k !== 'position' && k !== 'normal') c.deleteAttribute(k);
    if (!c.index) {
      const n = c.getAttribute('position').count;
      const ix = new Uint32Array(n);
      for (let i = 0; i < n; i++) ix[i] = i;
      c.setIndex(new BufferAttribute(ix, 1));
    }
    return c;
  });
  return mergeGeometries(clean, false)!;
}

// ---------------------------------------------------------------- hand poses

interface Finger {
  /** across the hand (index at the top) */
  y: number;
  lens: [number, number, number];
  r: [number, number, number];
  /** knuckle angle offset round the tube: the hand is slightly angled */
  dPhi: number;
}

// gloved proportions: a little thicker than bare fingers
const FINGERS: Finger[] = [
  { y: 0.0265, lens: [0.04, 0.025, 0.02], r: [0.0099, 0.0094, 0.0089], dPhi: 0.02 },
  { y: 0.0085, lens: [0.044, 0.028, 0.021], r: [0.0102, 0.0097, 0.0092], dPhi: 0.04 },
  { y: -0.0095, lens: [0.041, 0.027, 0.02], r: [0.0099, 0.0094, 0.0089], dPhi: 0.02 },
  { y: -0.0265, lens: [0.033, 0.021, 0.018], r: [0.009, 0.0085, 0.0081], dPhi: -0.06 },
];
const THUMB = { lens: [0.042, 0.03, 0.025], r: [0.0125, 0.0105, 0.0095] };
const PALM_LEN = 0.092;

/** `roll`: the whole hand turned round the tube, back of the hand towards the driver. */
type Pose = ({ kind: 'wrap'; rt: number; phi0: number } | { kind: 'open' }) & { roll: number };

interface HandParts {
  glove: BufferGeometry[];
  trim: BufferGeometry[];
  palm: BufferGeometry[];
  wrist: Vector3;
}

const onCircle = (R: number, phi: number, y: number) => new Vector3(Math.cos(phi) * R, y, Math.sin(phi) * R);

/** The palm's placement for a wrap pose: knuckle line centre, direction back to the wrist. */
function palmFrame(rt: number, phi0: number) {
  const R = rt + 0.0098;
  const k = onCircle(R, phi0, 0);
  // the back of the hand runs back towards the driver, angled a touch outwards
  const back = new Vector3(0.16, 0, 1).normalize();
  const wrist = k.clone().addScaledVector(back, PALM_LEN).add(new Vector3(0.004, -0.003, 0));
  return { k, back, wrist };
}

function buildHand(pose: Pose): HandParts {
  const glove: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const palm: BufferGeometry[] = [];
  // the palm stays put while the fingers open: the open pose borrows the wheel grip's palm
  const rt = pose.kind === 'wrap' ? pose.rt : 0.019;
  const phi0 = pose.kind === 'wrap' ? pose.phi0 : -0.45;
  const { k, back, wrist } = palmFrame(rt, phi0);
  // back-of-hand normal: away from the tube
  const outN = new Vector3().crossVectors(back, Y).negate().normalize();
  if (outN.x < 0) outN.negate();

  // --- fingers
  for (const f of FINGERS) {
    let joints: Vector3[];
    if (pose.kind === 'wrap') {
      const R = rt + f.r[0];
      let phi = pose.phi0 + f.dPhi;
      joints = [onCircle(R, phi, f.y)];
      for (let i = 0; i < 3; i++) {
        const Ri = rt + f.r[i];
        phi -= 2 * Math.asin(Math.min(0.99, f.lens[i] / (2 * Ri)));
        joints.push(onCircle(i < 2 ? rt + f.r[i + 1] : Ri, phi, f.y));
      }
    } else {
      // relaxed: a gentle curl towards the palm, the little finger curling most
      const R = rt + f.r[0];
      const p0 = onCircle(R, phi0 + f.dPhi, f.y);
      const fwd = back.clone().negate();
      const curlN = outN.clone().negate();
      const extra = f.y < -0.02 ? 0.25 : f.y < 0 ? 0.12 : 0;
      const flex = [0.32 + extra, 0.42 + extra, 0.22];
      joints = [p0];
      let a = 0;
      let p = p0;
      for (let i = 0; i < 3; i++) {
        a += flex[i];
        const d = fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(curlN, Math.sin(a));
        // fingers fan out a little when the hand opens
        d.y += f.y * 0.9;
        d.normalize();
        p = p.clone().addScaledVector(d, f.lens[i]);
        joints.push(p);
      }
    }
    for (let i = 0; i < 3; i++) {
      glove.push(segment(joints[i], joints[i + 1], f.r[i], i < 2 ? f.r[i + 1] : f.r[i] * 0.92));
    }
    // padded knuckle armour on the back of the first phalanx
    const a = joints[0];
    const b = joints[1];
    const mid = a.clone().lerp(b, 0.45);
    const radial = mid.clone().setY(0);
    const n = pose.kind === 'wrap' ? radial.normalize() : outN.clone();
    const m = along(a, b);
    const pad = blob(f.r[0] * 0.78, f.lens[0] * 0.28, f.r[0] * 0.38, new Matrix4(), 0.5, 10, 8);
    pad.applyMatrix4(new Matrix4().extractRotation(m)).translate(mid.x + n.x * f.r[0] * 0.92, mid.y, mid.z + n.z * f.r[0] * 0.92);
    trim.push(pad);
  }

  // --- palm: knuckles to wrist, wide and flat, slightly cupped
  const pm = new Matrix4().makeBasis(outN, Y, back).setPosition(k.clone().addScaledVector(back, PALM_LEN * 0.48).addScaledVector(outN, 0.002));
  glove.push(blob(0.0135, 0.041, PALM_LEN * 0.53, pm, 0.66));
  // the heel of the hand, thicker towards the wrist
  const heel = new Matrix4().makeBasis(outN, Y, back).setPosition(k.clone().addScaledVector(back, PALM_LEN * 0.78).addScaledVector(outN, -0.004));
  palm.push(blob(0.016, 0.036, 0.03, heel, 0.6, 14, 10));
  // knuckle ridge across the top of the hand
  const ridge = new Matrix4().makeBasis(outN, Y, back).setPosition(k.clone().addScaledVector(back, 0.012).addScaledVector(outN, 0.003));
  glove.push(blob(0.012, 0.046, 0.014, ridge, 0.6, 14, 10));
  // back-of-hand panel in the trim colour
  const panel = new Matrix4().makeBasis(outN, Y, back).setPosition(k.clone().addScaledVector(back, PALM_LEN * 0.5).addScaledVector(outN, 0.0105));
  trim.push(blob(0.0045, 0.03, 0.03, panel, 0.45, 12, 8));

  // --- thumb: from the base of the palm, round the back of the tube
  const tb = k.clone().addScaledVector(back, PALM_LEN * 0.7).addScaledVector(outN, -0.012).setY(0.03);
  let tj: Vector3[];
  if (pose.kind === 'wrap') {
    // laid along the inside of the rim, pointing up it: the racing driver's hold
    const R = rt + 0.0105;
    tj = [tb, onCircle(R + 0.004, 1.5, 0.046), onCircle(R, 2.05, 0.064), onCircle(R, 2.75, 0.07)];
  } else {
    const d0 = new Vector3().addScaledVector(back, -0.55).addScaledVector(outN, -0.45).add(new Vector3(0, 0.7, 0)).normalize();
    const d1 = new Vector3().addScaledVector(back, -0.75).addScaledVector(outN, -0.45).add(new Vector3(0, 0.35, 0)).normalize();
    const p1 = tb.clone().addScaledVector(d0, THUMB.lens[0]);
    const p2 = p1.clone().addScaledVector(d1, THUMB.lens[1]);
    const p3 = p2.clone().addScaledVector(d1.clone().addScaledVector(outN, -0.3).normalize(), THUMB.lens[2]);
    tj = [tb, p1, p2, p3];
  }
  for (let i = 0; i < 3; i++) glove.push(segment(tj[i], tj[i + 1], THUMB.r[i], i < 2 ? THUMB.r[i + 1] : THUMB.r[i] * 0.9));
  // the thumb's fleshy root fills the gap to the palm
  const tr = new Matrix4().makeBasis(outN, Y, back).setPosition(tb.clone().lerp(tj[1], 0.35).addScaledVector(outN, 0.004));
  palm.push(blob(0.013, 0.02, 0.022, tr, 0.7, 12, 8));

  // --- gauntlet cuff, flaring back over the sleeve, with a strap; open towards the elbow
  const cuffM = along(wrist.clone().addScaledVector(back, -0.012), wrist.clone().addScaledVector(back, 0.05), new Vector3(1, 0, 0));
  const cuff = loft(
    [
      [0, 0.019, 0.027],
      [0.012, 0.0255, 0.0295],
      [0.028, 0.0322, 0.031],
      [0.042, 0.0348, 0.0318],
      [0.047, 0.0345, 0.0312],
      [0.051, 0.031, 0.0285],
      [0.053, 0.027, 0.025],
    ],
    18,
    false,
  ).applyMatrix4(cuffM);
  glove.push(cuff);
  // a cap on the narrow end only (the palm side)
  glove.push(blob(0.018, 0.004, 0.026, cuffM.clone().multiply(new Matrix4().makeTranslation(0, 0.002, 0)), 0.8, 12, 6));
  trim.push(
    loft(
      [
        [0.02, 0.0308, 0.0308],
        [0.023, 0.0326, 0.0322],
        [0.036, 0.0352, 0.0329],
        [0.039, 0.034, 0.0318],
      ],
      18,
      false,
    ).applyMatrix4(cuffM),
  );
  // the strap's tab
  trim.push(blob(0.005, 0.011, 0.008, cuffM.clone().multiply(new Matrix4().makeTranslation(0.034, 0.03, 0)), 0.5, 10, 8));
  // turn the hand round the tube: x towards z
  const r = new Matrix4().makeRotationY(-pose.roll);
  for (const g of [...glove, ...trim, ...palm]) g.applyMatrix4(r);
  wrist.applyMatrix4(r);
  return { glove, trim, palm, wrist };
}

const POSES: Pose[] = [
  { kind: 'wrap', rt: 0.019, phi0: -0.45, roll: 0 },
  { kind: 'open', roll: 0 },
  { kind: 'wrap', rt: 0.029, phi0: -0.3, roll: 0 },
];

/**
 * Orients a hand holding a tube at `pos` along `axis` so its wrist points
 * towards `toward` (the elbow): the hand turns round the tube to meet the arm.
 */
export function handFrame(pos: Vector3, axis: Vector3, toward: Vector3, wrist: Vector3, mirror: boolean, out: Matrix4): Matrix4 {
  const y = _hy.copy(axis).normalize();
  const z = _hz.copy(toward).sub(pos);
  z.addScaledVector(y, -z.dot(y));
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = _hx.crossVectors(y, z);
  const theta = Math.atan2(mirror ? -wrist.x : wrist.x, wrist.z);
  out.makeBasis(x, y, z);
  out.multiply(_hr.makeRotationY(-theta));
  return out.setPosition(pos);
}
const _hx = new Vector3();
const _hy = new Vector3();
const _hz = new Vector3();
const _hr = new Matrix4();

export interface HandGeometry {
  glove: BufferGeometry;
  trim: BufferGeometry;
  palm: BufferGeometry;
  /** wrist position in hand space for each pose (base, open, knob) */
  wrists: Vector3[];
}

let handCache: HandGeometry | null = null;

/** The right hand, with its poses as morph targets. Shared: clone before changing. */
export function handGeometry(): HandGeometry {
  if (handCache) return handCache;
  const parts = POSES.map(buildHand);
  const morphed = (key: 'glove' | 'trim' | 'palm') => {
    const geos = parts.map((p) => merge(p[key]));
    const base = geos[0];
    base.morphAttributes.position = geos.slice(1).map((g) => g.getAttribute('position'));
    base.morphAttributes.normal = geos.slice(1).map((g) => g.getAttribute('normal'));
    return base;
  };
  handCache = { glove: morphed('glove'), trim: morphed('trim'), palm: morphed('palm'), wrists: parts.map((p) => p.wrist) };
  return handCache;
}

/** Mirror a morphing geometry in x (for the left hand). */
export function mirrorMorphX(g: BufferGeometry): BufferGeometry {
  const c = g.clone();
  const flip = (a: BufferAttribute) => {
    for (let i = 0; i < a.count; i++) a.setX(i, -a.getX(i));
  };
  flip(c.getAttribute('position') as BufferAttribute);
  flip(c.getAttribute('normal') as BufferAttribute);
  for (const k of ['position', 'normal'] as const) {
    c.morphAttributes[k] = (c.morphAttributes[k] ?? []).map((a) => {
      const b = (a as BufferAttribute).clone();
      flip(b);
      return b;
    });
  }
  const idx = c.getIndex()!;
  const arr = idx.array as Uint32Array | Uint16Array;
  const out = arr.slice();
  for (let i = 0; i < out.length; i += 3) {
    out[i + 1] = arr[i + 2];
    out[i + 2] = arr[i + 1];
  }
  c.setIndex(new BufferAttribute(out, 1));
  return c;
}

// ---------------------------------------------------------------- arms

/** Sleeve radius (side, front/back) along the arm, shoulder (0) to wrist (UPPER+FORE). */
function armProfile(y: number): [number, number] {
  const keys: [number, number, number][] = [
    [-0.06, 0.06, 0.062],
    [0.02, 0.058, 0.06],
    [0.12, 0.05, 0.053],
    [0.22, 0.045, 0.047],
    [UPPER, 0.043, 0.044],
    [UPPER + 0.07, 0.046, 0.042],
    [UPPER + 0.17, 0.039, 0.035],
    [UPPER + FORE - 0.05, 0.0305, 0.0285],
    [UPPER + FORE + 0.04, 0.026, 0.024],
  ];
  let i = 0;
  while (i < keys.length - 2 && y > keys[i + 1][0]) i++;
  const [y0, a0, b0] = keys[i];
  const [y1, a1, b1] = keys[i + 1];
  let t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0)));
  t = t * t * (3 - 2 * t);
  return [a0 + (a1 - a0) * t, b0 + (b1 - b0) * t];
}

const elbowWeight = (y: number) => {
  const t = Math.max(0, Math.min(1, (y - (UPPER - 0.055)) / 0.11));
  return t * t * (3 - 2 * t);
};

function skin(g: BufferGeometry) {
  const p = g.getAttribute('position');
  const si = new Uint16Array(p.count * 4);
  const sw = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    const w = elbowWeight(p.getY(i));
    si[i * 4] = 0;
    si[i * 4 + 1] = 1;
    sw[i * 4] = 1 - w;
    sw[i * 4 + 1] = w;
  }
  g.setAttribute('skinIndex', new BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new BufferAttribute(sw, 4));
  return g;
}

/**
 * The arm in its bind pose: straight up +y from the shoulder. Local +z is the
 * outside of the arm (the side the elbow points to); the stripe runs there.
 */
export function armGeometry(): { suit: BufferGeometry; stripe: BufferGeometry } {
  const radial = 20;
  const rings: number[] = [];
  for (let y = -0.06; y <= UPPER + FORE + 0.012 + 1e-6; y += 0.012) rings.push(y);
  const pos: number[] = [];
  const idx: number[] = [];
  for (const y of rings) {
    const [rx, rz] = armProfile(y);
    // soft folds on the inside of the elbow, and a gathered cuff at the wrist
    const fold = Math.exp(-(((y - UPPER) / 0.05) ** 2));
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const inner = Math.max(0, -Math.sin(a));
      const k = 1 + fold * inner * 0.07 * Math.sin(y * 260) + 0.012 * Math.sin(a * 3 + y * 40);
      pos.push(Math.cos(a) * rx * k, y, Math.sin(a) * rz * k);
    }
  }
  const cols = radial + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const suit = new BufferGeometry();
  suit.setAttribute('position', new Float32BufferAttribute(pos, 3));
  suit.setIndex(idx);
  suit.computeVertexNormals();

  // the suit stripe: a band down the outside of the arm
  const sp: number[] = [];
  const si: number[] = [];
  const band = 6;
  const half = 0.32;
  const stripeRings = rings.filter((y) => y > -0.02 && y < UPPER + FORE - 0.03);
  for (const y of stripeRings) {
    const [rx, rz] = armProfile(y);
    for (let j = 0; j <= band; j++) {
      const a = Math.PI / 2 - half + (j / band) * 2 * half;
      sp.push(Math.cos(a) * rx * 1.018, y, Math.sin(a) * rz * 1.018);
    }
  }
  for (let i = 0; i < stripeRings.length - 1; i++) {
    for (let j = 0; j < band; j++) {
      const a = i * (band + 1) + j;
      const b = a + band + 1;
      si.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const stripe = new BufferGeometry();
  stripe.setAttribute('position', new Float32BufferAttribute(sp, 3));
  stripe.setIndex(si);
  stripe.computeVertexNormals();
  return { suit: skin(suit), stripe: skin(stripe) };
}

// ---------------------------------------------------------------- arm IK

const _y1 = new Vector3();
const _y2 = new Vector3();
const _x = new Vector3();
const _z = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
const _m = new Matrix4();
const _q1 = new Quaternion();
const _q2 = new Quaternion();

/**
 * Two-bone IK: bends the arm from `shoulder` so the wrist lands on `wrist`,
 * with the elbow pushed towards `pole`. Poses the shoulder and elbow bones.
 */
export function solveArm(upper: Bone, lower: Bone, shoulder: Vector3, wrist: Vector3, pole: Vector3, elbowOut?: Vector3) {
  const dir = _d.copy(wrist).sub(shoulder);
  const d = Math.min(UPPER + FORE - 0.003, Math.max(0.08, dir.length()));
  dir.normalize();
  const cosA = (UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const perp = _p.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  const elbow = _z.copy(shoulder).addScaledVector(dir, UPPER * cosA).addScaledVector(perp, UPPER * sinA);
  elbowOut?.copy(elbow);
  _y1.copy(elbow).sub(shoulder).normalize();
  const wristOnArm = _x.copy(shoulder).addScaledVector(dir, d);
  _y2.copy(wristOnArm).sub(elbow).normalize();
  // the hinge axis is the normal of the plane the arm bends in; +z faces the pole
  const zP = _p.copy(pole).addScaledVector(_y1, -pole.dot(_y1)).normalize();
  _x.crossVectors(_y1, zP).normalize();
  _m.makeBasis(_x, _y1, zP);
  _q1.setFromRotationMatrix(_m);
  const z2 = _z.crossVectors(_x, _y2).normalize();
  _m.makeBasis(_x, _y2, z2);
  _q2.setFromRotationMatrix(_m);
  upper.position.copy(shoulder);
  upper.quaternion.copy(_q1);
  lower.position.set(0, UPPER, 0);
  lower.quaternion.copy(_q1.invert()).multiply(_q2);
}
