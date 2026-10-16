/**
 * Cockpit geometry. Everything is generated from the cabin frame of the chosen
 * body (where its glass and roof are), so any interior part fits any car: the
 * cabin base defines the mounting points (wheel column, instrument binnacle,
 * console, mirror mount) and each part is built around its own mount.
 *
 * Car space, like the exterior: +z forward, +y up, +x is the car's LEFT side.
 * The driver sits on the left.
 */
import {
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { cabinFrame, type CabinFrame } from './geometry';
import type { CarBuild } from './parts';

export type IBucket =
  | 'dark'
  | 'soft'
  | 'leather'
  | 'perf'
  | 'fabric'
  | 'headliner'
  | 'grille'
  | 'carbon'
  | 'metal'
  | 'chrome'
  | 'accent'
  | 'stitch'
  | 'wood'
  | 'glow'
  | 'red';
export type IBuckets = Record<IBucket, BufferGeometry[]>;
export const emptyI = (): IBuckets => ({
  dark: [],
  soft: [],
  leather: [],
  perf: [],
  fabric: [],
  headliner: [],
  grille: [],
  carbon: [],
  metal: [],
  chrome: [],
  accent: [],
  stitch: [],
  wood: [],
  glow: [],
  red: [],
});

// ---------------------------------------------------------------- helpers

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();
const UP = new Vector3(0, 1, 0);

type V3 = [number, number, number];

export function put(g: BufferGeometry, pos: V3 | Vector3, rot?: V3, scale?: V3): BufferGeometry {
  _e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, 'YXZ');
  _q.setFromEuler(_e);
  if (Array.isArray(pos)) _p.set(pos[0], pos[1], pos[2]);
  else _p.copy(pos);
  _s.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
  g.applyMatrix4(_m.compose(_p, _q, _s));
  return g;
}

export function rb(w: number, h: number, d: number, r = 0.01, seg = 2): BufferGeometry {
  const rr = Math.max(0.0005, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  return new RoundedBoxGeometry(w, h, d, seg, rr);
}

/** A cylinder (optionally tapered) from a to b. */
export function rod(a: Vector3 | V3, b: Vector3 | V3, r: number, seg = 10, r2 = r): BufferGeometry {
  const A = Array.isArray(a) ? new Vector3(...a) : a.clone();
  const B = Array.isArray(b) ? new Vector3(...b) : b.clone();
  const d = B.clone().sub(A);
  const len = d.length();
  const g = new CylinderGeometry(r2, r, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  _q.setFromUnitVectors(UP, d.normalize());
  g.applyMatrix4(_m.compose(A, _q, _s.set(1, 1, 1)));
  return g;
}

/** Rotation whose +z is n and whose +y stays as close to car-up as possible (no upside-down flips). */
export function faceBasis(n: Vector3, pos: Vector3): Matrix4 {
  const z = n.clone().normalize();
  const x = new Vector3().crossVectors(UP, z);
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  x.normalize();
  const y = new Vector3().crossVectors(z, x);
  return new Matrix4().makeBasis(x, y, z).setPosition(pos);
}

/** A box stretched between two points (its local Y runs a→b), rolled so its depth faces `face`. */
function beam(a: Vector3, b: Vector3, w: number, d: number, face: Vector3, r = 0.008): BufferGeometry {
  const y = b.clone().sub(a);
  const len = y.length();
  y.normalize();
  const z = face.clone().addScaledVector(y, -face.dot(y)).normalize();
  const x = new Vector3().crossVectors(y, z);
  const g = rb(w, len, d, r);
  _m.makeBasis(x, y, z).setPosition(a.clone().add(b).multiplyScalar(0.5));
  return g.applyMatrix4(_m);
}

export function ball(r: number, pos: V3 | Vector3, ws = 16, hs = 12): BufferGeometry {
  return put(new SphereGeometry(r, ws, hs), pos);
}

/** A rounded polygon: each point can carry its own corner radius. */
function roundedShape(pts: [number, number, number?][]): Shape {
  const s = new Shape();
  const n = pts.length;
  const P = pts.map((p) => new Vector2(p[0], p[1]));
  for (let i = 0; i < n; i++) {
    const p = P[i];
    const r = pts[i][2] ?? 0;
    const prev = P[(i + n - 1) % n];
    const next = P[(i + 1) % n];
    if (r <= 0) {
      if (i === 0) s.moveTo(p.x, p.y);
      else s.lineTo(p.x, p.y);
      continue;
    }
    const a = prev.clone().sub(p);
    const b = next.clone().sub(p);
    const ra = Math.min(r, a.length() * 0.45);
    const rbb = Math.min(r, b.length() * 0.45);
    const p0 = p.clone().addScaledVector(a.normalize(), ra);
    const p1 = p.clone().addScaledVector(b.normalize(), rbb);
    if (i === 0) s.moveTo(p0.x, p0.y);
    else s.lineTo(p0.x, p0.y);
    s.quadraticCurveTo(p.x, p.y, p1.x, p1.y);
  }
  s.closePath();
  return s;
}

/**
 * Extrudes a (z, y) profile across the car from x0 to x1, with rounded ends.
 * The profile is given in car z and y, any winding.
 */
export function extrudeZY(pts: [number, number, number?][], x0: number, x1: number, bevel = 0.012): BufferGeometry {
  // ExtrudeGeometry wants counter-clockwise outlines
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = area > 0 ? pts : pts.slice().reverse();
  const depth = Math.max(0.001, x1 - x0 - 2 * bevel);
  const g = new ExtrudeGeometry(roundedShape(ccw), {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.6,
    bevelOffset: -bevel * 0.6,
    bevelSegments: 3,
    curveSegments: 6,
  });
  // (x, y, z) -> (-z, y, x): a proper rotation, so the winding stays outward
  _m.set(0, 0, -1, x1 - bevel, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(_m);
  return g;
}

/** Same, but the (x, y) profile is extruded along z (for things seen from the front). */
function extrudeXY(pts: [number, number, number?][], z0: number, z1: number, bevel = 0.006): BufferGeometry {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = area > 0 ? pts : pts.slice().reverse();
  const g = new ExtrudeGeometry(roundedShape(ccw), {
    depth: Math.max(0.001, z1 - z0 - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.6,
    bevelOffset: -bevel * 0.6,
    bevelSegments: 2,
    curveSegments: 8,
  });
  g.translate(0, 0, z0 + bevel);
  return g;
}

function lathe(pts: [number, number][], seg = 20): BufferGeometry {
  return new LatheGeometry(
    pts.map(([r, y]) => new Vector2(r, y)),
    seg,
  );
}

function ring(R: number, r: number, seg = 32, tube = 8, arc = Math.PI * 2): BufferGeometry {
  return new TorusGeometry(R, r, tube, seg, arc);
}

const mirrorXGeo = (g: BufferGeometry) => {
  const c = g.clone();
  c.applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
  // flip winding back to front-facing
  const idx = c.getIndex();
  if (idx) {
    const a = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    idx.needsUpdate = true;
  } else {
    const pos = c.getAttribute('position');
    const nrm = c.getAttribute('normal');
    const uv = c.getAttribute('uv');
    for (let i = 0; i < pos.count; i += 3) {
      for (const at of [pos, nrm, uv]) {
        if (!at) continue;
        for (let k = 0; k < at.itemSize; k++) {
          const t = at.getComponent(i + 1, k);
          at.setComponent(i + 1, k, at.getComponent(i + 2, k));
          at.setComponent(i + 2, k, t);
        }
      }
    }
  }
  return c;
};
export { mirrorXGeo };

const both = (g: BufferGeometry) => [g, mirrorXGeo(g)];

// ---------------------------------------------------------------- layout

/** The cabin base: where everything mounts. Derived from the body's glasshouse. */
export interface CockpitLayout {
  frame: CabinFrame;
  /** driver's eye, car space */
  eye: Vector3;
  driverX: number;
  floorY: number;
  dashTop: number;
  /** dash face nearest the driver, at the top edge */
  zFace: number;
  /** height of the windscreen base */
  cowlY: number;
  /** height of the eye-to-windscreen-base sight line at a given z: the cabin stays below it */
  sightAt: (z: number) => number;
  /** steering wheel centre and the column's tilt back from vertical */
  wheel: Vector3;
  wheelTilt: number;
  /** instrument cluster centre */
  cluster: Vector3;
  consoleY: number;
  shifter: Vector3;
  handbrake: Vector3;
  mirror: Vector3;
  seatZ: number;
  /** shoulders for the arm rig */
  shoulderL: Vector3;
  shoulderR: Vector3;
}

export function cockpitLayout(bodyId: string): CockpitLayout {
  const f = cabinFrame(bodyId);
  const driverX = Math.min(0.37, f.halfW * 0.48);
  const ez = f.zRoofFront - 0.39;
  // sit as tall as the headroom allows: the road over the bonnet is what matters
  const ey = Math.min(f.roofAt(ez) - 0.18, Math.max(f.beltY + 0.1, f.roofY - 0.21));
  const eye = new Vector3(driverX, ey, ez);
  // the line from the eye over the base of the windscreen: nothing in the cabin may poke above it
  const cowlY = Math.min(f.beltY, f.roofAt(f.zCowl));
  const sightAt = (z: number) => ey - ((ey - cowlY) * (z - ez)) / (f.zCowl - ez);
  const zFace = ez + 0.6;
  const dashTop = Math.min(f.beltY - 0.025, sightAt(zFace) - 0.03);
  // the wheel's rim stays just under that line; the gauges are seen through its upper opening
  const wheelTilt = 0.36;
  const wz = ez + 0.4;
  const wheelY = sightAt(wz) - 0.03 - RIM_MAX * Math.cos(wheelTilt);
  const wheel = new Vector3(driverX, wheelY, wz);
  const clusterZ = zFace - 0.03;
  const through = wheelY + 0.125;
  const clusterY = ey + ((through - ey) * (clusterZ - ez)) / (wz - ez);
  const consoleY = 0.6;
  return {
    frame: f,
    eye,
    driverX,
    floorY: 0.3,
    dashTop,
    zFace,
    cowlY,
    sightAt,
    wheel,
    wheelTilt,
    cluster: new Vector3(driverX, clusterY, clusterZ),
    consoleY,
    shifter: new Vector3(0.03, consoleY, ez + 0.46),
    handbrake: new Vector3(0.11, consoleY, ez + 0.22),
    // hung from the header, just under the headliner
    mirror: new Vector3(0, f.roofAt(f.zRoofFront - 0.03) - 0.118, f.zRoofFront - 0.03),
    seatZ: ez - 0.02,
    shoulderL: new Vector3(driverX + 0.2, ey - 0.25, ez - 0.07),
    shoulderR: new Vector3(driverX - 0.2, ey - 0.25, ez - 0.07),
  };
}

/** The largest steering-wheel rim radius (classic). */
const RIM_MAX = 0.19;

// ---------------------------------------------------------------- cabin base

function seat(b: IBuckets, x: number, L: CockpitLayout, style: string) {
  const z = L.seatZ;
  const fy = L.floorY;
  const race = style === 'race';
  const shell = race ? b.carbon : b.leather;
  const insert = race ? b.fabric : b.perf;
  // cushion
  b.dark.push(put(rb(0.46, 0.1, 0.5, 0.04, 3), [x, fy + 0.07, z + 0.12]));
  insert.push(put(rb(0.26, 0.05, 0.42, 0.02, 2), [x, fy + 0.135, z + 0.13], [-0.05, 0, 0]));
  for (const s of [-1, 1]) shell.push(put(rb(0.09, 0.12, 0.46, 0.04, 3), [x + s * 0.18, fy + 0.15, z + 0.12], [-0.05, 0, s * 0.18]));
  // backrest from the hip up to the shoulders, so the headrest always sits behind the driver's head
  const head = new Vector3(x, L.eye.y + 0.01, L.eye.z - 0.2);
  const hip = new Vector3(x, fy + 0.13, z - 0.1);
  const top = new Vector3(x, head.y - 0.13, head.z + 0.02);
  const back = new Vector3(0, 0, -1);
  shell.push(beam(hip.clone().add(new Vector3(0, 0, -0.04)), top.clone().add(new Vector3(0, 0, -0.04)), 0.5, 0.1, back, 0.05));
  insert.push(beam(hip.clone().add(new Vector3(0, 0.04, 0.02)), top.clone().add(new Vector3(0, -0.04, 0.02)), 0.28, 0.05, back, 0.02));
  // contrast stitching down both sides of the insert and across the cushion
  for (const s of [-1, 1]) {
    const o = new Vector3(s * 0.142, 0, 0.046);
    b.stitch.push(beam(hip.clone().add(o).add(new Vector3(0, 0.06, 0)), top.clone().add(o).add(new Vector3(0, -0.06, 0)), 0.003, 0.003, back, 0.001));
    b.stitch.push(put(rb(0.003, 0.003, 0.4, 0.001), [x + s * 0.132, fy + 0.162, z + 0.13], [-0.05, 0, 0]));
  }
  for (const s of [-1, 1]) {
    const o = new Vector3(s * 0.2, 0, 0.02);
    shell.push(beam(hip.clone().add(o).add(new Vector3(0, 0.08, 0)), top.clone().add(o).add(new Vector3(0, -0.1, 0)), 0.1, 0.15, new Vector3(-s * 0.35, 0, -1), 0.045));
  }
  // headrest: separate on the GT, integrated with harness slots on the buckets
  if (style === 'gt') {
    b.leather.push(put(rb(0.26, 0.15, 0.1, 0.045, 3), head));
    for (const s of [-1, 1]) b.chrome.push(rod([x + s * 0.07, top.y - 0.02, top.z - 0.03], [x + s * 0.07, head.y - 0.06, head.z - 0.01], 0.006, 6));
  } else {
    shell.push(beam(top.clone().add(new Vector3(0, -0.06, -0.04)), head.clone().add(new Vector3(0, 0.08, -0.02)), 0.3, 0.1, back, 0.05));
    for (const s of [-1, 1]) b.dark.push(put(rb(0.06, 0.04, 0.12, 0.01), [x + s * 0.08, top.y - 0.02, top.z]));
    if (race) {
      // harness belts down the seat, in the car's colour
      for (const s of [-1, 1]) b.accent.push(beam(top.clone().add(new Vector3(s * 0.08, -0.02, 0.06)), hip.clone().add(new Vector3(s * 0.05, 0.2, 0.08)), 0.05, 0.012, back, 0.004));
      b.chrome.push(put(rb(0.07, 0.07, 0.015, 0.008), [x, fy + 0.3, z + 0.02], [-0.6, 0, 0]));
    }
  }
}

function dashProfile(L: CockpitLayout, style: string): [number, number, number?][] {
  const f = L.frame;
  const t = L.dashTop;
  const zf = L.zFace;
  const zc = f.zCowl + 0.03;
  const fy = L.floorY;
  if (style === 'race') {
    // flat carbon slab with a straight face
    return [
      [zc, t - 0.03, 0],
      [zf + 0.02, t + 0.005, 0.015],
      [zf - 0.01, t - 0.12, 0.02],
      [zf + 0.1, t - 0.16, 0.02],
      [zf + 0.16, fy + 0.15, 0],
      [zc, fy + 0.15, 0],
    ];
  }
  if (style === 'future') {
    // thin wing that floats over a recessed lower dash
    return [
      [zc, t - 0.03, 0],
      [zf + 0.2, t + 0.01, 0.08],
      [zf - 0.05, t - 0.02, 0.03],
      [zf - 0.02, t - 0.07, 0.03],
      [zf + 0.2, t - 0.1, 0.05],
      [zf + 0.24, fy + 0.15, 0],
      [zc, fy + 0.15, 0],
    ];
  }
  // GT: soft, rounded leather dash with a knee roll
  return [
    [zc, t - 0.025, 0],
    [zf + 0.18, t + 0.015, 0.1],
    [zf - 0.01, t - 0.01, 0.05],
    [zf, t - 0.12, 0.06],
    [zf + 0.06, t - 0.24, 0.06],
    [zf + 0.04, t - 0.34, 0.05],
    [zf + 0.16, fy + 0.12, 0],
    [zc, fy + 0.12, 0],
  ];
}

export function cabinBase(build: CarBuild, L: CockpitLayout): IBuckets {
  const b = emptyI();
  const f = L.frame;
  const style = build.cockpit;
  const race = style === 'race';
  const future = style === 'future';
  const wIn = f.halfW - 0.02;
  const fy = L.floorY;
  const t = L.dashTop;
  const zf = L.zFace;
  const ez = L.eye.z;
  const dashMat = race ? b.carbon : future ? b.leather : b.soft;

  // --- dashboard: one extruded profile across the cabin, a darker top so it doesn't glare in the screen
  dashMat.push(extrudeZY(dashProfile(L, style), -wIn + 0.01, wIn - 0.01, 0.03));
  if (!race) {
    b.dark.push(extrudeZY([[f.zCowl + 0.03, t - 0.02, 0], [zf + 0.15, t + 0.02, 0.06], [zf + 0.04, t + 0.012, 0.02], [zf + 0.08, t - 0.01, 0], [f.zCowl + 0.03, t - 0.05, 0]], -wIn + 0.03, wIn - 0.03, 0.02));
  }
  if (!race) {
    // piping along the dash's leading edge
    b.stitch.push(put(rb(2 * wIn - 0.08, 0.003, 0.003, 0.001), [0, t + 0.006, zf + 0.03]));
  }
  if (style === 'gt') {
    // brushed trim strip across the passenger side, with a stitched leather roll above it
    b.metal.push(extrudeZY([[zf + 0.02, t - 0.1, 0.006], [zf + 0.012, t - 0.135, 0.006], [zf + 0.06, t - 0.14, 0], [zf + 0.07, t - 0.1, 0]], -wIn + 0.05, 0.16, 0.008));
    b.accent.push(extrudeZY([[zf + 0.004, t - 0.04, 0.002], [zf - 0.004, t - 0.044, 0.002], [zf + 0.02, t - 0.05, 0], [zf + 0.02, t - 0.04, 0]], -wIn + 0.06, wIn - 0.06, 0.003));
    // round vents at both ends and either side of the centre
    for (const x of [-wIn + 0.13, -0.2, 0.2]) {
      b.chrome.push(put(ring(0.042, 0.007, 28, 8), [x, t - 0.075, zf + 0.012]));
      b.dark.push(put(new CylinderGeometry(0.04, 0.04, 0.03, 24), [x, t - 0.075, zf + 0.03], [Math.PI / 2, 0, 0]));
      for (let i = -2; i <= 2; i++) b.metal.push(put(rb(0.074, 0.006, 0.012, 0.002), [x, t - 0.075 + i * 0.014, zf + 0.012]));
    }
  } else if (future) {
    // a light line runs under the floating wing and round the doors
    b.glow.push(extrudeZY([[zf - 0.03, t - 0.068, 0], [zf - 0.032, t - 0.075, 0], [zf + 0.02, t - 0.078, 0], [zf + 0.02, t - 0.07, 0]], -wIn + 0.04, wIn - 0.04, 0.002));
    // slot vent along the wing
    b.dark.push(put(rb(0.62, 0.016, 0.03, 0.006), [-0.25, t - 0.035, zf - 0.035]));
  } else {
    // race: exposed fixing bolts and two round vents
    for (let i = 0; i < 8; i++) b.chrome.push(put(new CylinderGeometry(0.006, 0.006, 0.006, 8), [-wIn + 0.08 + i * ((2 * wIn - 0.16) / 7), t + 0.004, zf + 0.04]));
    for (const x of [-wIn + 0.12, -0.18]) {
      b.dark.push(put(ring(0.032, 0.008, 20, 8), [x, t - 0.06, zf - 0.005]));
      b.metal.push(put(new CylinderGeometry(0.03, 0.03, 0.02, 20), [x, t - 0.06, zf + 0.01], [Math.PI / 2, 0, 0]));
    }
  }
  // instrument binnacle hood (the dash part holds the display; see dashPart)
  const cl = L.cluster;
  const hoodW = 0.38;
  // a shallow brow: it shades the dials without hiding their tops from the driver
  const hood = extrudeXY(
    [
      [-hoodW / 2, 0, 0],
      [-hoodW / 2 + 0.025, 0.03, 0.028],
      [hoodW / 2 - 0.025, 0.03, 0.028],
      [hoodW / 2, 0, 0],
      [hoodW / 2 - 0.02, 0, 0],
      [hoodW / 2 - 0.038, 0.017, 0.017],
      [-hoodW / 2 + 0.038, 0.017, 0.017],
      [-hoodW / 2 + 0.02, 0, 0],
    ],
    -0.03,
    0.14,
    0.008,
  );
  // dipping away from the driver, into the dash
  hood.rotateX(0.15);
  // the digital dash floats its own screen above the dash instead
  if (build.dash !== 'digital') {
    const hoodMat = race ? b.carbon : style === 'gt' ? b.leather : b.dark;
    hoodMat.push(put(hood, [cl.x, cl.y + 0.079, cl.z]));
    // the pod's body behind the dials, down into the dash
    (race ? b.carbon : b.dark).push(put(rb(hoodW - 0.01, 0.15, 0.2, 0.02, 2), [cl.x, cl.y - 0.005, cl.z + 0.15]));
    if (!race) b.stitch.push(put(rb(hoodW - 0.06, 0.003, 0.003, 0.001), [cl.x, cl.y + 0.106, cl.z - 0.02], [0.15, 0, 0]));
  }

  // --- steering column shroud
  const w = L.wheel;
  // the column runs forward and down from the hub, under the line of sight to the gauges
  const colDir = new Vector3(0, -Math.sin(L.wheelTilt), Math.cos(L.wheelTilt));
  const colEnd = w.clone().addScaledVector(colDir, 0.3);
  b.dark.push(beam(w.clone().addScaledVector(colDir, 0.07), colEnd, 0.09, 0.1, new Vector3(0, 1, 0), 0.035));

  // --- centre stack and tunnel
  const cw = 0.14;
  const tunnel: [number, number, number?][] = [
    [zf + 0.14, fy, 0],
    [zf + 0.12, t - 0.12, 0.04],
    [zf - 0.04, L.consoleY + 0.09, 0.08],
    [ez + 0.2, L.consoleY, 0.05],
    [ez - 0.45, L.consoleY, 0.03],
    [ez - 0.45, fy, 0],
  ];
  (race ? b.carbon : b.dark).push(extrudeZY(tunnel, -cw, cw, 0.02));
  if (!race) {
    // leather armrest between the seats and padded tunnel sides, brushed trim along the top edges
    b.leather.push(put(rb(0.2, 0.06, 0.34, 0.025, 3), [0, L.consoleY + 0.035, ez - 0.25]));
    b.stitch.push(put(rb(0.204, 0.003, 0.3, 0.0015), [0, L.consoleY + 0.05, ez - 0.25]));
    for (const s of [-1, 1]) {
      b.leather.push(put(rb(0.012, 0.18, 0.6, 0.006), [s * (cw + 0.004), fy + 0.18, ez - 0.05]));
      b.metal.push(put(rb(0.008, 0.008, 0.62, 0.003), [s * (cw - 0.004), L.consoleY + 0.004, ez + 0.02]));
    }
    // starter button and drive-mode dial beside the lever
    b.chrome.push(put(ring(0.018, 0.003, 24, 6), [-0.075, L.consoleY + 0.006, ez + 0.4], [Math.PI / 2, 0, 0]));
    b.red.push(put(new CylinderGeometry(0.015, 0.016, 0.01, 24), [-0.075, L.consoleY + 0.008, ez + 0.4]));
    b.chrome.push(put(new CylinderGeometry(0.022, 0.024, 0.022, 28), [-0.075, L.consoleY + 0.012, ez + 0.3]));
    b.dark.push(put(new CylinderGeometry(0.016, 0.016, 0.004, 24), [-0.075, L.consoleY + 0.0235, ez + 0.3]));
    b.glow.push(put(rb(0.003, 0.002, 0.012, 0.001), [-0.075, L.consoleY + 0.026, ez + 0.31]));
    // two cup holders with brushed rings
    for (const z of [ez + 0.02, ez + 0.11]) {
      b.dark.push(put(new CylinderGeometry(0.036, 0.034, 0.012, 24), [-0.02, L.consoleY + 0.002, z]));
      b.metal.push(put(ring(0.037, 0.003, 28, 6), [-0.02, L.consoleY + 0.008, z], [Math.PI / 2, 0, 0]));
    }
  } else {
    // bare aluminium floor plate under the shifter, and a fire-system pull
    b.metal.push(put(rb(0.22, 0.008, 0.3, 0.004), [0, L.consoleY + 0.004, ez + 0.36]));
    b.red.push(put(new CylinderGeometry(0.014, 0.014, 0.02, 16), [-0.08, L.consoleY + 0.02, ez + 0.12]));
    b.chrome.push(put(ring(0.017, 0.0035, 18, 6), [-0.08, L.consoleY + 0.01, ez + 0.12], [Math.PI / 2, 0, 0]));
    b.dark.push(put(rb(0.18, 0.02, 0.12, 0.008), [0, L.consoleY + 0.004, ez + 0.05]));
  }

  // --- floor
  (race ? b.accent : b.fabric).push(put(rb(2 * wIn, 0.02, f.zCowl - ez + 0.9, 0.005), [0, fy - 0.01, (f.zCowl + ez - 0.9) / 2]));
  if (!race) {
    for (const x of [L.driverX, -L.driverX]) b.dark.push(put(rb(0.4, 0.012, 0.5, 0.01), [x, fy + 0.005, ez + 0.6], [0.05, 0, 0]));
  }
  b.dark.push(put(rb(2 * wIn, 0.4, 0.04, 0.01), [0, fy + 0.2, Math.min(f.zCowl, zf + 0.45)], [0.6, 0, 0]));

  // --- doors, mirrored: a layered card with a stitched cap, an inset panel, armrest with
  // pull and window switches, chrome release, speaker and map pocket
  const dz0 = f.zB - 0.05;
  const dz1 = Math.max(zf + 0.05, f.zCowl - 0.12);
  const dlen = dz1 - dz0;
  const dzc = (dz0 + dz1) / 2;
  const dx = wIn - 0.01;
  const door = emptyI();
  const by = f.beltY;
  (race ? door.carbon : door.soft).push(put(rb(0.04, by - fy, dlen, 0.015), [dx, (by + fy) / 2, dzc]));
  if (!race) {
    // soft cap along the window line, stitched along its inner edge
    door.leather.push(put(rb(0.07, 0.036, dlen + 0.02, 0.016, 3), [dx - 0.014, by - 0.006, dzc]));
    door.stitch.push(put(rb(0.003, 0.003, dlen - 0.02, 0.001), [dx - 0.049, by - 0.006, dzc]));
    // inset panel: perforated leather framed by piping
    const iz0 = dz0 + 0.07;
    const iz1 = Math.min(dz1 - 0.1, ez + 0.5);
    const ih = 0.13;
    const iy = by - 0.04 - ih / 2;
    door.perf.push(put(rb(0.012, ih, iz1 - iz0, 0.006, 2), [dx - 0.024, iy, (iz0 + iz1) / 2]));
    for (const yy of [iy + ih / 2 + 0.004, iy - ih / 2 - 0.004]) door.accent.push(put(rb(0.008, 0.005, iz1 - iz0 + 0.01, 0.0025), [dx - 0.026, yy, (iz0 + iz1) / 2]));
    if (future) door.glow.push(put(rb(0.005, 0.005, dlen * 0.86, 0.002), [dx - 0.044, by - 0.03, dzc]));
    else door.metal.push(put(rb(0.006, 0.01, dlen * 0.8, 0.003), [dx - 0.046, by - 0.03, dzc]));
    // armrest, sweeping up at the front into the door pull
    const ay = L.consoleY + 0.04;
    door.leather.push(put(rb(0.075, 0.045, 0.42, 0.02, 3), [dx - 0.05, ay, ez + 0.02]));
    door.stitch.push(put(rb(0.003, 0.003, 0.38, 0.001), [dx - 0.087, ay + 0.012, ez + 0.02]));
    door.dark.push(beam(new Vector3(dx - 0.055, ay + 0.01, ez + 0.2), new Vector3(dx - 0.04, by - 0.07, ez + 0.36), 0.045, 0.03, new Vector3(-1, 0, 0), 0.012));
    // window switch pack on the armrest
    door.dark.push(put(rb(0.05, 0.012, 0.08, 0.005), [dx - 0.052, ay + 0.026, ez + 0.13], [0.08, 0, 0]));
    for (const zz of [0.11, 0.15]) door.chrome.push(put(rb(0.016, 0.008, 0.022, 0.003), [dx - 0.052, ay + 0.034, ez + zz], [0.08, 0, 0]));
    // chrome release in a dark recess
    door.dark.push(put(rb(0.012, 0.04, 0.13, 0.008), [dx - 0.022, by - 0.105, ez + 0.44]));
    door.chrome.push(put(rb(0.016, 0.014, 0.09, 0.007), [dx - 0.03, by - 0.1, ez + 0.43], [0, 0, 0.12]));
    // speaker: a perforated grille in a brushed ring
    door.dark.push(put(new CylinderGeometry(0.072, 0.075, 0.016, 32), [dx - 0.02, fy + 0.14, ez + 0.48], [0, 0, Math.PI / 2]));
    door.grille.push(put(new CylinderGeometry(0.064, 0.064, 0.008, 32), [dx - 0.029, fy + 0.14, ez + 0.48], [0, 0, Math.PI / 2]));
    door.metal.push(put(ring(0.068, 0.005, 32, 6), [dx - 0.03, fy + 0.14, ez + 0.48], [0, Math.PI / 2, 0]));
    // map pocket
    door.dark.push(put(rb(0.03, 0.11, 0.3, 0.012), [dx - 0.03, fy + 0.11, ez + 0.1]));
    door.soft.push(put(rb(0.012, 0.02, 0.3, 0.006), [dx - 0.046, fy + 0.165, ez + 0.1]));
  } else {
    door.dark.push(put(rb(0.06, 0.03, dlen + 0.02, 0.014, 3), [dx - 0.012, by - 0.005, dzc]));
    // door pull strap and a bare release cable
    door.accent.push(put(rb(0.012, 0.025, 0.18, 0.004), [dx - 0.03, 0.66, ez + 0.32], [0.3, 0, 0]));
    door.metal.push(rod([dx - 0.025, 0.75, ez + 0.4], [dx - 0.025, 0.72, ez + 0.6], 0.004, 6));
    // riveted aluminium kick plate
    door.metal.push(put(rb(0.006, 0.16, 0.5, 0.003), [dx - 0.022, fy + 0.13, ez + 0.3]));
    for (let i = 0; i < 6; i++) door.chrome.push(put(new CylinderGeometry(0.004, 0.004, 0.004, 8), [dx - 0.026, fy + 0.2, ez + 0.08 + i * 0.088], [0, 0, Math.PI / 2]));
  }
  for (const k of Object.keys(door) as IBucket[]) for (const g of door[k]) b[k].push(...both(g));
  if (race) {
    // window net on the driver's side: webbing straps in a frame
    const nx = f.halfW - 0.07;
    const ny0 = by + 0.02;
    const ny1 = Math.min(f.roofAt(ez) - 0.1, by + 0.2);
    const nz0 = ez - 0.28;
    const nz1 = ez + 0.12;
    b.metal.push(rod([nx, ny1, nz0], [nx, ny1, nz1], 0.006, 8));
    for (let i = 0; i <= 6; i++) {
      const zz = nz0 + ((nz1 - nz0) * i) / 6;
      b.dark.push(put(rb(0.004, ny1 - ny0, 0.012, 0.002), [nx, (ny0 + ny1) / 2, zz]));
    }
    for (let i = 0; i <= 3; i++) {
      const yy = ny0 + ((ny1 - ny0) * i) / 3;
      b.dark.push(put(rb(0.004, 0.012, nz1 - nz0, 0.002), [nx + 0.003, yy, (nz0 + nz1) / 2]));
    }
    b.accent.push(put(rb(0.006, 0.02, 0.05, 0.003), [nx - 0.004, ny1 - 0.02, nz1 - 0.03]));
  }

  // --- glasshouse trim: A-pillars with tweeters, B and C-pillars, padded visors, grab handle
  const roofF = f.roofAt(f.zRoofFront);
  const aTrim = race ? b.dark : b.headliner;
  for (const s of [-1, 1]) {
    const a0 = new Vector3(s * (f.halfW - 0.05), f.beltY - 0.01, f.zCowl - 0.04);
    const a1 = new Vector3(s * (f.roofW - 0.03), roofF - 0.05, f.zRoofFront + 0.01);
    aTrim.push(beam(a0, a1, 0.085, 0.035, new Vector3(-s, 0, -0.4), 0.014));
    if (!race) {
      // a tweeter at the foot of the pillar, facing the cabin
      const tw = a0.clone().lerp(a1, 0.14).add(new Vector3(-s * 0.03, 0, -0.01));
      const tn = new Vector3(-s, 0.2, -0.5).normalize();
      b.dark.push(put(new CylinderGeometry(0.024, 0.026, 0.012, 20).rotateX(Math.PI / 2).applyMatrix4(faceBasis(tn, tw)), [0, 0, 0]));
      b.grille.push(put(new CylinderGeometry(0.019, 0.019, 0.004, 20).rotateX(Math.PI / 2).applyMatrix4(faceBasis(tn, tw.clone().addScaledVector(tn, 0.006))), [0, 0, 0]));
      b.metal.push(ring(0.021, 0.0025, 20, 6).applyMatrix4(faceBasis(tn, tw.clone().addScaledVector(tn, 0.007))));
    }
    const bp0 = new Vector3(s * (f.halfW - 0.04), f.beltY - 0.01, f.zB);
    const bp1 = new Vector3(s * (f.roofW - 0.03), f.roofAt(f.zB) - 0.05, f.zB);
    aTrim.push(beam(bp0, bp1, 0.1, 0.04, new Vector3(-s, 0, 0), 0.014));
    // seat-belt guide on the B-pillar
    if (!race) b.dark.push(put(rb(0.02, 0.06, 0.05, 0.008), [s * (f.roofW - 0.06), f.roofAt(f.zB) - 0.13, f.zB + 0.03]));
    // C-pillar
    const c0 = new Vector3(s * (f.halfW - 0.05), f.beltY - 0.01, f.zRoofRear - 0.32);
    const c1 = new Vector3(s * (f.roofW - 0.03), f.roofAt(f.zRoofRear) - 0.05, f.zRoofRear + 0.02);
    aTrim.push(beam(c0, c1, 0.2, 0.04, new Vector3(-s, 0, 0), 0.02));
    // padded sun visor folded up against the headliner, stitched round the edge
    if (!race) {
      const vz = f.zRoofFront - 0.12;
      const vy = f.roofAt(vz) - 0.052;
      b.headliner.push(put(rb(0.34, 0.02, 0.16, 0.01, 3), [s * 0.31, vy, vz]));
      b.stitch.push(put(rb(0.32, 0.003, 0.003, 0.001), [s * 0.31, vy - 0.01, vz + 0.068]));
      b.dark.push(put(rb(0.02, 0.01, 0.03, 0.004), [s * 0.12, vy + 0.006, vz + 0.04]));
      b.chrome.push(put(new CylinderGeometry(0.005, 0.005, 0.03, 6), [s * 0.47, f.roofAt(vz + 0.06) - 0.06, vz + 0.06], [0, 0, Math.PI / 2]));
    }
  }
  if (!race) {
    // grab handle over the passenger door
    const gz = f.zB + 0.3;
    const gx = -(f.roofW - 0.05);
    const gy = f.roofAt(gz) - 0.07;
    const pts = [new Vector3(gx + 0.002, gy + 0.03, gz - 0.11), new Vector3(gx + 0.03, gy - 0.02, gz - 0.07), new Vector3(gx + 0.035, gy - 0.025, gz + 0.07), new Vector3(gx + 0.002, gy + 0.03, gz + 0.11)];
    b.dark.push(new TubeGeometry(new CatmullRomCurve3(pts), 24, 0.008, 8));
  }
  b.headliner.push(put(rb(2 * f.roofW + 0.04, 0.05, 0.08, 0.02), [0, roofF - 0.045, f.zRoofFront - 0.02]));
  // headliner: a gently domed sheet between the glass
  const hl = new PlaneGeometry(2 * f.roofW, f.zRoofFront - f.zRoofRear + 0.1, 12, 12);
  hl.rotateX(Math.PI / 2);
  const hp = hl.getAttribute('position');
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i);
    const z = Math.min(f.zRoofFront - 0.01, hp.getZ(i) + (f.zRoofFront + f.zRoofRear) / 2);
    hp.setZ(i, z);
    hp.setY(i, f.roofAt(z) - 0.035 - 0.05 * (x / f.roofW) ** 2);
  }
  hl.computeVertexNormals();
  b.headliner.push(hl);
  if (!race) {
    // two shallow seams running front to back
    for (const x of [-0.24, 0.24]) {
      const sz0 = f.zRoofRear + 0.05;
      const sz1 = f.zRoofFront - 0.05;
      const sm = (sz0 + sz1) / 2;
      b.dark.push(put(rb(0.004, 0.004, sz1 - sz0, 0.0015), [x, f.roofAt(sm) - 0.035 - 0.05 * (x / f.roofW) ** 2 - 0.001, sm]));
    }
    // overhead console behind the mirror: map lights and switches
    const oz = f.zRoofFront - 0.13;
    const oy = f.roofAt(oz) - 0.05;
    b.dark.push(put(rb(0.2, 0.03, 0.13, 0.012, 3), [0, oy, oz], [-0.06, 0, 0]));
    for (const x of [-0.055, 0.055]) b.glow.push(put(rb(0.045, 0.004, 0.028, 0.002), [x, oy - 0.016, oz - 0.01], [-0.06, 0, 0]));
    for (const x of [-0.016, 0.016]) b.chrome.push(put(rb(0.018, 0.006, 0.014, 0.002), [x, oy - 0.016, oz + 0.035], [-0.06, 0, 0]));
  }
  // dome light
  b.glow.push(put(rb(0.1, 0.006, 0.05, 0.003), [0, f.roofAt(f.zB + 0.15) - 0.042, f.zB + 0.15]));

  // --- rear bulkhead and parcel shelf (seen in the mirror)
  const zr = L.seatZ - 0.62;
  b.dark.push(put(rb(2 * wIn, f.beltY - fy, 0.04, 0.01), [0, (f.beltY + fy) / 2, zr]));
  b.fabric.push(put(rb(2 * wIn, 0.02, f.zRoofRear - f.zBack, 0.01), [0, f.beltY, (f.zRoofRear + f.zBack) / 2 - 0.1]));

  // --- seats
  seat(b, L.driverX, L, style);
  seat(b, -L.driverX, L, style);

  // --- roll cage for the stripped racer, painted in the car's colour
  if (race) {
    const r = 0.018;
    const cz = L.seatZ - 0.45;
    const topY = (z: number) => f.roofAt(z) - 0.075;
    const xs = (y: number) => (y > f.beltY ? f.roofW - 0.05 : f.halfW - 0.07);
    for (const s of [-1, 1]) {
      const aBot = new Vector3(s * (f.halfW - 0.08), fy + 0.02, zf + 0.2);
      const aMid = new Vector3(s * (f.halfW - 0.05), f.beltY - 0.05, f.zCowl - 0.1);
      const aTop = new Vector3(s * xs(2), f.roofAt(f.zRoofFront - 0.02) - 0.055, f.zRoofFront - 0.02);
      const hTop = new Vector3(s * xs(2), topY(cz), cz);
      const hBot = new Vector3(s * (f.halfW - 0.08), fy + 0.02, cz);
      b.accent.push(rod(aBot, aMid, r), rod(aMid, aTop, r), rod(aTop, hTop, r), rod(hBot, hTop, r));
      b.accent.push(ball(r * 1.05, aMid, 10, 8), ball(r * 1.05, aTop, 10, 8), ball(r * 1.05, hTop, 10, 8));
      // door bars: an X
      const d0 = new Vector3(s * (f.halfW - 0.1), fy + 0.12, cz + 0.02);
      const d1 = new Vector3(s * (f.halfW - 0.1), f.beltY - 0.1, zf + 0.12);
      const d2 = new Vector3(s * (f.halfW - 0.1), f.beltY - 0.12, cz + 0.02);
      const d3 = new Vector3(s * (f.halfW - 0.1), fy + 0.12, zf + 0.12);
      b.accent.push(rod(d0, d1, r * 0.85), rod(d2, d3, r * 0.85));
      // foam padding on the bar by the driver's head
      if (s > 0) b.dark.push(rod(aMid.clone().lerp(aTop, 0.25), aMid.clone().lerp(aTop, 0.75), r * 1.9, 10));
    }
    const tl = new Vector3(f.roofW - 0.05, topY(cz), cz);
    const tr = new Vector3(-(f.roofW - 0.05), topY(cz), cz);
    b.accent.push(rod(tl, tr, r), rod(new Vector3(f.halfW - 0.08, fy + 0.02, cz), tr, r * 0.9));
    const zh = f.zRoofFront - 0.02;
    b.accent.push(rod(new Vector3(f.roofW - 0.05, f.roofAt(zh) - 0.055, zh), new Vector3(-(f.roofW - 0.05), f.roofAt(zh) - 0.055, zh), r * 0.85));
    // harness bar and the extinguisher in the passenger footwell
    b.accent.push(rod(new Vector3(f.halfW - 0.08, 0.72, cz), new Vector3(-(f.halfW - 0.08), 0.72, cz), r * 0.9));
    b.red.push(rod([-L.driverX - 0.1, fy + 0.1, ez + 0.55], [-L.driverX + 0.15, fy + 0.1, ez + 0.55], 0.045, 16));
    b.chrome.push(rod([-L.driverX + 0.15, fy + 0.1, ez + 0.55], [-L.driverX + 0.2, fy + 0.1, ez + 0.55], 0.02, 10));
  }
  return b;
}

// ---------------------------------------------------------------- dash (instrument) parts

export interface ScreenSpec {
  geo: BufferGeometry;
}

export interface DashGeo {
  buckets: IBuckets;
  /** quads that show regions of the dash canvas */
  screens: BufferGeometry[];
  /** shift-light LED positions (car space) */
  leds: Vector3[];
}

/** A flat quad facing `n`, centred on c, showing canvas region [u0,v0]-[u1,v1]. */
function screenQuad(c: Vector3, w: number, h: number, n: Vector3, uv: [number, number, number, number], tilt = 0): BufferGeometry {
  const g = new PlaneGeometry(w, h);
  const a = g.getAttribute('uv');
  for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + a.getX(i) * (uv[2] - uv[0]), uv[1] + a.getY(i) * (uv[3] - uv[1]));
  g.rotateX(tilt);
  return g.applyMatrix4(faceBasis(n, c));
}

/** Canvas layout: 1024x512. Cluster (0..512, top half), centre (512..1024, top half), wheel display (0..256, bottom). */
export const UV_CLUSTER: [number, number, number, number] = [0, 0.5, 0.5, 1];
export const UV_CENTER: [number, number, number, number] = [0.5, 0.5, 1, 1];
export const UV_WHEEL: [number, number, number, number] = [0, 0.25, 0.25, 0.5];
/** the analogue clock: a square in the middle of the centre region */
export const UV_CLOCK: [number, number, number, number] = [0.625, 0.5, 0.875, 1];

export function dashPart(build: CarBuild, L: CockpitLayout): DashGeo {
  const b = emptyI();
  const screens: BufferGeometry[] = [];
  const leds: Vector3[] = [];
  const cl = L.cluster;
  const toEye = L.eye.clone().sub(cl).normalize();
  const t = L.dashTop;
  const zf = L.zFace;
  const st = consoleRamp(L);
  if (build.dash === 'analog') {
    // two round dials in deep chrome bezels, one screen quad behind them
    screens.push(screenQuad(cl.clone().addScaledVector(toEye, 0.005), 0.3, 0.15, toEye, UV_CLUSTER));
    for (const sx of [-0.075, 0.075]) {
      const c = cl.clone().add(new Vector3(-sx, 0, 0)).addScaledVector(toEye, 0.012);
      const bezel = lathe([[0.071, -0.012], [0.073, 0], [0.069, 0.008], [0.064, 0.006]], 32);
      bezel.rotateX(Math.PI / 2);
      bezel.applyMatrix4(faceBasis(toEye, c));
      b.chrome.push(bezel);
    }
    // a stopwatch-style clock pod on top of the dash, three chrome climate knobs on the console ramp
    const cc = new Vector3(0, t + 0.035, zf + 0.1);
    const n = L.eye.clone().sub(cc).normalize();
    const pod = new CylinderGeometry(0.058, 0.058, 0.04, 32);
    pod.rotateX(Math.PI / 2);
    b.dark.push(pod.applyMatrix4(faceBasis(n, cc.clone().addScaledVector(n, -0.02))));
    screens.push(screenQuad(cc.clone().addScaledVector(n, 0.001), 0.1, 0.1, n, UV_CLOCK));
    const bez = ring(0.052, 0.005, 32, 6);
    b.chrome.push(bez.applyMatrix4(faceBasis(n, cc.clone().addScaledVector(n, 0.002))));
    for (const x of [-0.07, 0, 0.07]) {
      const knob = new CylinderGeometry(0.018, 0.02, 0.022, 20);
      knob.rotateX(Math.PI / 2);
      b.chrome.push(knob.applyMatrix4(faceBasis(st.n, st.at(0.3, x, 0.011))));
      const mark = rb(0.004, 0.014, 0.004, 0.001);
      b.dark.push(mark.applyMatrix4(faceBasis(st.n, st.at(0.3, x, 0.023).add(new Vector3(0, 0.006, -0.002)))));
    }
  } else if (build.dash === 'digital') {
    // a wide floating glass panel: driver display + centre screen in one slab
    const w = 0.62;
    // standing proud of the dash face, seen through the top of the wheel like the dials
    const cz = zf + 0.03;
    const e = L.eye;
    const cy = e.y + ((cl.y - e.y) * (cz - e.z)) / (cl.z - e.z);
    const c = new Vector3(L.driverX - 0.16, Math.min(cy + 0.01, L.sightAt(cz) - 0.07), cz);
    const n = L.eye.clone().sub(new Vector3(L.driverX, c.y, c.z)).normalize();
    n.x *= 0.3;
    n.normalize();
    b.dark.push(screenFrame(c, w + 0.02, 0.14, n));
    screens.push(screenQuad(c.clone().addScaledVector(n, 0.009).add(new Vector3(0.155, 0, 0)), 0.29, 0.122, n, UV_CLUSTER));
    screens.push(screenQuad(c.clone().addScaledVector(n, 0.009).add(new Vector3(-0.155, 0, 0)), 0.28, 0.122, n, UV_CENTER));
    // slim brushed mounts holding it off the dash face
    for (const dx of [-0.2, 0.2]) b.metal.push(put(rb(0.04, 0.05, 0.07, 0.008), [c.x + dx, c.y - 0.02, c.z + 0.045], [0.2, 0, 0]));
    // haptic climate bar below the vents
    b.glow.push(put(rb(0.2, 0.004, 0.004, 0.001), [0, t - 0.2, zf + 0.04]));
  } else {
    // race: carbon pod with a display and a shift-light bar on top, switch panel in the middle
    const c = cl.clone();
    screens.push(screenQuad(c.clone().addScaledVector(toEye, 0.0085), 0.2, 0.1, toEye, UV_CLUSTER));
    b.carbon.push(screenFrame(c, 0.25, 0.13, toEye));
    for (let i = 0; i < 12; i++) {
      leds.push(c.clone().add(new Vector3(0.1 - (i * 0.2) / 11, 0.075, 0)).addScaledVector(toEye, 0.012));
    }
    b.dark.push(put(rb(0.23, 0.02, 0.025, 0.006), c.clone().add(new Vector3(0, 0.075, 0)).addScaledVector(toEye, 0.0), [-0.4, 0, 0]));
    // switch panel on the console ramp: six toggles with labels, and a red start button
    const plate = rb(0.26, 0.13, 0.012, 0.006);
    b.carbon.push(plate.applyMatrix4(faceBasis(st.n, st.at(0.4, 0, 0.004))));
    for (let i = 0; i < 6; i++) {
      const x = -0.08 + (i % 3) * 0.08;
      const v = Math.floor(i / 3) * 0.055 - 0.02;
      const base = new CylinderGeometry(0.011, 0.011, 0.008, 12);
      base.rotateX(Math.PI / 2);
      b.dark.push(base.applyMatrix4(faceBasis(st.n, st.at(0.4 - v * 3, x, 0.012))));
      b.chrome.push(rod(st.at(0.4 - v * 3, x, 0.012), st.at(0.4 - v * 3 - 0.04, x, 0.036), 0.0035, 8, 0.003));
      const label = rb(0.03, 0.006, 0.002, 0.001);
      b.accent.push(label.applyMatrix4(faceBasis(st.n, st.at(0.4 - v * 3 + 0.12, x, 0.011))));
    }
    const start = new CylinderGeometry(0.016, 0.016, 0.014, 16);
    start.rotateX(Math.PI / 2);
    b.red.push(start.applyMatrix4(faceBasis(st.n, st.at(0.8, 0, 0.008))));
    const guard = ring(0.021, 0.0035, 18, 6);
    b.chrome.push(guard.applyMatrix4(faceBasis(st.n, st.at(0.8, 0, 0.006))));
  }
  return { buckets: b, screens, leds };
}

/** The sloping console between the dash and the tunnel (matches the tunnel profile in cabinBase). */
function consoleRamp(L: CockpitLayout) {
  const a = new Vector3(0, L.dashTop - 0.12, L.zFace + 0.12);
  const b = new Vector3(0, L.consoleY + 0.09, L.zFace - 0.04);
  const d = b.clone().sub(a).normalize();
  const n = new Vector3(0, -d.z, d.y);
  if (n.y < 0) n.negate();
  return {
    n,
    /** point at fraction k from the dash end, x across, lifted off the surface by `off` */
    at: (k: number, x: number, off: number) => a.clone().lerp(b, k).addScaledVector(n, off).setX(x),
  };
}

function screenFrame(c: Vector3, w: number, h: number, n: Vector3): BufferGeometry {
  return rb(w, h, 0.014, 0.008, 2).applyMatrix4(faceBasis(n, c));
}

// ---------------------------------------------------------------- steering wheel

export interface WheelGeo {
  /** wheel-local: origin at the hub, +z towards the driver, rim in the xy plane */
  buckets: IBuckets;
  screen: BufferGeometry | null;
  /** grip radius (where the hands hold, at 9 and 3) */
  grip: number;
  rim: number;
}

export function wheelPart(id: string): WheelGeo {
  const b = emptyI();
  let screen: BufferGeometry | null = null;
  if (id === 'yoke') {
    // flat-topped racing yoke: a closed tube around a carbon plate
    const pts = [
      [0.15, 0.06],
      [0.17, 0.0],
      [0.155, -0.075],
      [0.11, -0.1],
      [-0.11, -0.1],
      [-0.155, -0.075],
      [-0.17, 0.0],
      [-0.15, 0.06],
      [-0.12, 0.085],
      [-0.115, 0.04],
      [0.115, 0.04],
      [0.12, 0.085],
    ].map(([x, y]) => new Vector3(x, y, 0));
    const curve = new CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    b.leather.push(new TubeGeometry(curve, 120, 0.019, 10, true));
    b.carbon.push(put(rb(0.26, 0.13, 0.03, 0.02, 3), [0, -0.025, -0.012]));
    screen = put(new PlaneGeometry(0.1, 0.05), [0, -0.01, 0.0045]);
    remapUv(screen, UV_WHEEL);
    // shift lights on the top edge and a ring of coloured buttons
    const btn: [number, number, IBucket][] = [
      [-0.085, 0.0, 'red'],
      [-0.085, -0.04, 'accent'],
      [0.085, 0.0, 'accent'],
      [0.085, -0.04, 'chrome'],
      [-0.04, -0.065, 'dark'],
      [0.04, -0.065, 'dark'],
    ];
    for (const [x, y, k] of btn) b[k].push(put(new CylinderGeometry(0.01, 0.011, 0.012, 14), [x, y, 0.006], [Math.PI / 2, 0, 0]));
    for (const s of [-1, 1]) b.metal.push(put(new CylinderGeometry(0.011, 0.011, 0.016, 12), [s * 0.05, 0.025, 0.004], [Math.PI / 2, 0, 0]));
    // big carbon paddles behind
    for (const s of [-1, 1]) b.carbon.push(put(rb(0.09, 0.055, 0.008, 0.012), [s * 0.12, 0.0, -0.045], [0, s * 0.25, 0]));
    return { buckets: b, screen, grip: 0.158, rim: 0.17 };
  }
  if (id === 'classic') {
    // wooden rim on a dished three-spoke boss with drilled aluminium spokes
    const R = 0.19;
    const dish = 0.05;
    b.wood.push(ring(R, 0.0135, 64, 10));
    for (const a of [0, Math.PI, -Math.PI / 2]) {
      const dir = new Vector3(Math.cos(a), Math.sin(a), 0);
      const p0 = dir.clone().multiplyScalar(0.04).add(new Vector3(0, 0, -dish));
      const p1 = dir.clone().multiplyScalar(R - 0.008);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      const len = p0.distanceTo(p1);
      const spoke = rb(len, 0.032, 0.004, 0.002);
      const tilt = Math.atan2(dish, R - 0.05);
      spoke.rotateY(tilt);
      spoke.rotateZ(a);
      b.metal.push(spoke.translate(mid.x, mid.y, mid.z));
      // lightening holes, darker discs on the spoke
      for (const k of [0.3, 0.55, 0.78]) {
        const h = p0.clone().lerp(p1, k);
        b.dark.push(put(new CylinderGeometry(0.008, 0.008, 0.006, 12), h, [Math.PI / 2, 0, 0]));
      }
    }
    b.metal.push(put(new CylinderGeometry(0.045, 0.05, 0.03, 28), [0, 0, -dish - 0.005], [Math.PI / 2, 0, 0]));
    b.metal.push(put(new CylinderGeometry(0.035, 0.038, 0.012, 28), [0, 0, -dish + 0.014], [Math.PI / 2, 0, 0]));
    b.accent.push(put(new CylinderGeometry(0.02, 0.02, 0.004, 24), [0, 0, -dish + 0.021], [Math.PI / 2, 0, 0]));
    return { buckets: b, screen, grip: R, rim: R };
  }
  // sport: leather rim with thumb grips, three spokes, centre marker
  const R = 0.178;
  b.leather.push(ring(R, 0.0165, 72, 12));
  for (const s of [-1, 1]) b.leather.push(put(ring(R, 0.019, 10, 10, 0.32), [0, 0, 0], [0, 0, s > 0 ? -0.2 : Math.PI - 0.12]));
  b.accent.push(put(ring(R, 0.0172, 6, 10, 0.1), [0, 0, 0], [0, 0, Math.PI / 2 - 0.05]));
  for (const a of [0, Math.PI]) {
    const spoke = rb(R - 0.05, 0.045, 0.016, 0.008, 2);
    spoke.translate((R - 0.05) / 2 + 0.035, -0.012, -0.012);
    spoke.rotateZ(a);
    b.dark.push(spoke);
    const inlay = rb(R - 0.08, 0.008, 0.004, 0.002);
    inlay.translate((R - 0.08) / 2 + 0.05, -0.0, -0.003);
    inlay.rotateZ(a);
    b.metal.push(inlay);
  }
  const low = rb(0.05, R - 0.04, 0.016, 0.008, 2);
  low.translate(0, -(R - 0.04) / 2 - 0.02, -0.012);
  b.dark.push(low);
  b.dark.push(put(rb(0.1, 0.075, 0.035, 0.03, 4), [0, -0.008, -0.018]));
  b.metal.push(put(new CylinderGeometry(0.018, 0.018, 0.004, 24), [0, -0.005, 0.0015], [Math.PI / 2, 0, 0]));
  b.accent.push(put(new CylinderGeometry(0.012, 0.012, 0.003, 6), [0, -0.005, 0.0045], [Math.PI / 2, 0, 0]));
  // aluminium paddles
  for (const s of [-1, 1]) b.metal.push(put(rb(0.07, 0.045, 0.006, 0.01), [s * 0.1, 0.01, -0.05], [0, s * 0.2, 0]));
  return { buckets: b, screen, grip: R, rim: R };
}

function remapUv(g: BufferGeometry, uv: [number, number, number, number]) {
  const a = g.getAttribute('uv');
  for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + a.getX(i) * (uv[2] - uv[0]), uv[1] + a.getY(i) * (uv[3] - uv[1]));
}

// ---------------------------------------------------------------- gear lever and handbrake

export interface LeverGeo {
  /** fixed part (gate, boot), lever-local */
  base: IBuckets;
  /** moving part, pivoting at the local origin */
  lever: IBuckets;
  /** where the hand grips, lever-local, and the grip's axis */
  grip: Vector3;
  gripAxis: Vector3;
}

export function shifterPart(id: string): LeverGeo {
  const base = emptyI();
  const lever = emptyI();
  if (id === 'sequential') {
    base.metal.push(put(rb(0.12, 0.03, 0.2, 0.01), [0, 0.012, 0]));
    base.dark.push(put(rb(0.03, 0.01, 0.14, 0.004), [0, 0.029, 0]));
    for (const [x, z] of [[-0.045, -0.08], [0.045, -0.08], [-0.045, 0.08], [0.045, 0.08]]) base.chrome.push(put(new CylinderGeometry(0.006, 0.006, 0.006, 8), [x, 0.03, z]));
    lever.metal.push(rod([0, 0, 0], [0, 0.2, -0.04], 0.009, 10, 0.007));
    lever.carbon.push(put(new CylinderGeometry(0.018, 0.016, 0.07, 16), [0, 0.215, -0.043], [0.2, 0, 0]));
    lever.accent.push(put(new CylinderGeometry(0.0185, 0.0185, 0.008, 16), [0, 0.25, -0.05], [0.2, 0, 0]));
    lever.red.push(put(new CylinderGeometry(0.008, 0.008, 0.012, 10), [0, 0.257, -0.052], [0.2, 0, 0]));
    return { base, lever, grip: new Vector3(0, 0.205, -0.042), gripAxis: new Vector3(0, 1, -0.2).normalize() };
  }
  if (id === 'gated') {
    // open chrome gate: a plate with slots for six gears and reverse
    base.chrome.push(put(rb(0.13, 0.012, 0.15, 0.006), [0, 0.006, 0]));
    for (const x of [-0.035, 0, 0.035]) base.dark.push(put(rb(0.012, 0.004, 0.09, 0.002), [x, 0.0125, 0]));
    base.dark.push(put(rb(0.082, 0.004, 0.012, 0.002), [0, 0.0125, 0]));
    lever.chrome.push(rod([0, 0, 0], [0, 0.16, 0], 0.0065, 10));
    lever.chrome.push(ball(0.024, [0, 0.175, 0], 20, 14));
    lever.dark.push(put(ring(0.024, 0.003, 24, 6), [0, 0.175, 0], [Math.PI / 2, 0, 0]));
    return { base, lever, grip: new Vector3(0, 0.15, 0), gripAxis: new Vector3(0, 1, 0) };
  }
  // manual H: leather boot, chrome collar, ball knob with the pattern on top
  base.leather.push(lathe([[0.06, 0], [0.058, 0.01], [0.045, 0.03], [0.03, 0.05], [0.016, 0.07], [0.012, 0.075]], 24));
  base.accent.push(put(ring(0.059, 0.003, 24, 6), [0, 0.006, 0], [Math.PI / 2, 0, 0]));
  base.chrome.push(put(rb(0.14, 0.008, 0.14, 0.02), [0, 0.0, 0]));
  lever.chrome.push(rod([0, 0.05, 0], [0, 0.135, 0], 0.008, 10));
  lever.chrome.push(put(new CylinderGeometry(0.014, 0.012, 0.012, 16), [0, 0.135, 0]));
  lever.leather.push(ball(0.028, [0, 0.165, 0], 22, 16));
  lever.accent.push(put(new CylinderGeometry(0.016, 0.016, 0.004, 20), [0, 0.191, 0]));
  return { base, lever, grip: new Vector3(0, 0.14, 0), gripAxis: new Vector3(0, 1, 0) };
}

export function handbrakePart(id: string): LeverGeo {
  const base = emptyI();
  const lever = emptyI();
  if (id === 'hydro') {
    // tall vertical drift handbrake on a machined bracket
    base.metal.push(put(rb(0.05, 0.06, 0.12, 0.008), [0, 0.03, 0]));
    base.red.push(put(new CylinderGeometry(0.014, 0.014, 0.07, 14), [0, 0.06, -0.06], [Math.PI / 2, 0, 0]));
    lever.metal.push(rod([0, 0, 0], [0, 0.24, 0.02], 0.009, 10));
    lever.dark.push(put(new CylinderGeometry(0.017, 0.017, 0.11, 16), [0, 0.215, 0.018]));
    lever.accent.push(put(new CylinderGeometry(0.018, 0.018, 0.012, 16), [0, 0.27, 0.02]));
    return { base, lever, grip: new Vector3(0, 0.21, 0.018), gripAxis: new Vector3(0, 1, 0.08).normalize() };
  }
  if (id === 'button') {
    base.dark.push(put(rb(0.06, 0.012, 0.08, 0.008), [0, 0.006, 0]));
    lever.chrome.push(put(rb(0.03, 0.01, 0.04, 0.005), [0, 0.015, 0]));
    lever.red.push(put(rb(0.012, 0.003, 0.004, 0.001), [0, 0.021, 0.012]));
    return { base, lever, grip: new Vector3(0, 0.05, 0), gripAxis: new Vector3(0, 1, 0) };
  }
  // classic lever pointing forward from a rear pivot, with a chrome release button
  base.dark.push(put(rb(0.05, 0.02, 0.1, 0.008), [0, 0.0, 0]));
  lever.dark.push(put(rb(0.03, 0.025, 0.3, 0.012), [0, 0.02, 0.15], [-0.1, 0, 0]));
  lever.leather.push(put(rb(0.034, 0.03, 0.14, 0.014, 3), [0, 0.034, 0.24], [-0.1, 0, 0]));
  lever.accent.push(put(rb(0.035, 0.003, 0.13, 0.001), [0, 0.05, 0.24], [-0.1, 0, 0]));
  lever.chrome.push(put(new CylinderGeometry(0.008, 0.008, 0.02, 10), [0, 0.05, 0.315], [Math.PI / 2 - 0.1, 0, 0]));
  return { base, lever, grip: new Vector3(0, 0.035, 0.24), gripAxis: new Vector3(0, -0.1, 1).normalize() };
}

// ---------------------------------------------------------------- mirror

export interface MirrorGeo {
  /** mirror-local: origin at the glass centre, glass facing +z */
  buckets: IBuckets;
  glass: BufferGeometry;
  w: number;
  h: number;
}

export function mirrorPart(id: string): MirrorGeo {
  const b = emptyI();
  let w = 0.21;
  let h = 0.058;
  if (id === 'wide') {
    w = 0.3;
    h = 0.062;
  } else if (id === 'race') {
    w = 0.19;
    h = 0.062;
  }
  const housing = id === 'race' ? b.carbon : b.dark;
  if (id === 'race') housing.push(put(rb(w + 0.018, h + 0.018, 0.02, 0.004, 2), [0, 0, -0.01]));
  else housing.push(put(rb(w + 0.02, h + 0.02, 0.035, h * 0.45, 4), [0, 0, -0.016]));
  if (id === 'wide') b.chrome.push(put(rb(w + 0.006, 0.003, 0.004, 0.001), [0, -h / 2 - 0.006, 0.002]));
  // stem up to the headliner
  b.dark.push(rod([0, h / 2, -0.03], [0, h / 2 + 0.04, -0.045], 0.007, 8));
  b.dark.push(put(rb(0.05, 0.014, 0.05, 0.007), [0, h / 2 + 0.046, -0.045]));
  const glass = new PlaneGeometry(w, h);
  // flip u: a mirror shows the scene back to front
  const uv = glass.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
  glass.translate(0, 0, 0.0025);
  return { buckets: b, glass, w, h };
}

// ---------------------------------------------------------------- hands and arms

/**
 * A gloved right hand gripping a tube that runs along local +y through the
 * origin. +x is where the knuckles point, +z towards the wrist/driver.
 * Mirror it in x for the left hand.
 */
export function gloveGeometry(): { glove: BufferGeometry[]; trim: BufferGeometry[] } {
  const glove: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const tube = 0.019;
  const fingers = [
    { y: 0.031, r: 0.0098, len: 1 },
    { y: 0.011, r: 0.0104, len: 1 },
    { y: -0.009, r: 0.0102, len: 1 },
    { y: -0.028, r: 0.0092, len: 0.92 },
  ];
  for (const f of fingers) {
    const R = tube + f.r * 0.95;
    const arc = 4.3 * f.len;
    const g = new TorusGeometry(R, f.r, 8, 20, arc);
    // torus lies in xy around z; lay it round the y axis
    g.rotateX(Math.PI / 2);
    // start at the back (towards +z/+x, the knuckle) and wrap over the front
    g.rotateY(Math.PI * 0.25 + arc - Math.PI);
    g.translate(0, f.y, 0);
    glove.push(g);
    // fingertip and knuckle
    const tipA = Math.PI * 0.25 + arc - Math.PI - arc;
    const kA = Math.PI * 0.25 + arc - Math.PI;
    const ang = (a: number) => new Vector3(Math.cos(-a) * R, f.y, Math.sin(-a) * R);
    glove.push(ball(f.r, ang(tipA), 10, 8));
    glove.push(ball(f.r * 1.12, ang(kA), 10, 8));
  }
  // back of the hand, from the knuckles back to the wrist
  const palm = rb(0.03, 0.082, 0.085, 0.014, 3);
  palm.rotateY(-0.7);
  palm.translate(0.034, 0.002, 0.04);
  glove.push(palm);
  // palm pad wrapping the inside
  glove.push(put(rb(0.022, 0.075, 0.05, 0.01, 2), [-0.004, 0.0, 0.035], [0, 0.4, 0]));
  // thumb, hooked over the top of the rim
  glove.push(rod([0.005, 0.046, 0.04], [-0.012, 0.05, 0.005], 0.0115, 10, 0.0105));
  glove.push(rod([-0.012, 0.05, 0.005], [-0.022, 0.044, -0.014], 0.0105, 10, 0.0095));
  glove.push(ball(0.0098, [-0.022, 0.044, -0.014], 10, 8));
  // gauntlet cuff, with the accent stripe
  const cuff = new CylinderGeometry(0.034, 0.03, 0.06, 16, 1);
  cuff.rotateX(Math.PI / 2);
  cuff.rotateY(-0.7);
  cuff.translate(0.065, -0.004, 0.085);
  glove.push(cuff);
  const stripe = new CylinderGeometry(0.0345, 0.0345, 0.012, 16, 1);
  stripe.rotateX(Math.PI / 2);
  stripe.rotateY(-0.7);
  stripe.translate(0.072, -0.004, 0.094);
  trim.push(stripe);
  // knuckle guard
  trim.push(put(rb(0.012, 0.07, 0.03, 0.005), [0.046, 0.003, 0.012], [0, -0.35, 0]));
  return { glove, trim };
}

/** Where the forearm meets the glove, in glove space. */
export const WRIST = new Vector3(0.07, -0.004, 0.1);

/** A sleeve segment along +y from 0 to len. */
export function sleeve(len: number, r0: number, r1: number): BufferGeometry {
  const g = new CylinderGeometry(r1, r0, len, 14, 3);
  g.translate(0, len / 2, 0);
  // a little bulge mid-way so it reads as fabric over an arm, not a pipe
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / len;
    const k = 1 + Math.sin(t * Math.PI) * 0.12;
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

export function cockpitBucketsFor(build: CarBuild) {
  const L = cockpitLayout(build.body);
  return { L, base: cabinBase(build, L), dash: dashPart(build, L) };
}
