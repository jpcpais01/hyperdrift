import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bodySections, frontSections, rearSections, type BodyInfo, type BodySculpt } from './bodies';
import { above, conform, conformBand, conformStrip, ellipse, face, flank, planar, roundRect, soften, wrap, type Projector } from './conform';
import { loft, profileCurve, refine, sectionAt, type Section } from './loft';
import { TRAVEL, type Axle, type Skeleton } from './skeleton';
import { Surface } from './surface';
import { ZONE } from './zones';

/** Geometry for one part, grouped by the material it uses. */
export interface PartGeo {
  paint: BufferGeometry[];
  trim: BufferGeometry[];
  carbon: BufferGeometry[];
  chrome: BufferGeometry[];
  glass: BufferGeometry[];
  light: BufferGeometry[];
  tail: BufferGeometry[];
  /** dark polished reflector bowls inside lamp housings */
  housing: BufferGeometry[];
  /** clear glossy lamp covers (drawn last, see-through) */
  lens: BufferGeometry[];
  /** red tinted tail-lamp covers (glossy, dark red when off) */
  tailLens: BufferGeometry[];
  /** grained black plastic: bumper inserts, mesh backs, mud flaps */
  plastic: BufferGeometry[];
}

export const emptyPart = (): PartGeo => ({ paint: [], trim: [], carbon: [], chrome: [], glass: [], light: [], tail: [], housing: [], lens: [], tailLens: [], plastic: [] });

// ---------------------------------------------------------------- helpers

const tmpM = new Matrix4();
const tmpQ = new Quaternion();

export function place(g: BufferGeometry, pos: Vector3 | [number, number, number], rot?: [number, number, number], scale?: [number, number, number]): BufferGeometry {
  const p = Array.isArray(pos) ? new Vector3(...pos) : pos;
  tmpQ.setFromEuler(new Euler(...(rot ?? [0, 0, 0])));
  tmpM.compose(p, tmpQ, new Vector3(...(scale ?? [1, 1, 1])));
  g.applyMatrix4(tmpM);
  return g;
}

/**
 * Rounded box template per segment count: corner sign + corner normal per
 * vertex. Any size and radius is then a cheap remap, instead of rebuilding and
 * welding a RoundedBoxGeometry for each of the hundreds of small details.
 */
const rboxTemplates = new Map<number, { sign: Float32Array; nrm: Float32Array; index: number[] }>();
function rboxTemplate(seg: number) {
  let t = rboxTemplates.get(seg);
  if (t) return t;
  const src = new RoundedBoxGeometry(2, 2, 2, seg, 0.5);
  src.deleteAttribute('uv');
  const g = mergeVertices(src, 1e-5);
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const sign = new Float32Array(pos.count * 3);
  const n = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    for (let k = 0; k < 3; k++) {
      const nv = nrm.getComponent(i, k);
      n[i * 3 + k] = nv;
      sign[i * 3 + k] = Math.sign(pos.getComponent(i, k) - nv * 0.5) || 1;
    }
  }
  t = { sign, nrm: n, index: Array.from(g.getIndex()!.array) };
  rboxTemplates.set(seg, t);
  return t;
}

function rbox(w: number, h: number, d: number, r = 0.02, seg = 1): BufferGeometry {
  const rr = Math.max(0.001, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  const t = rboxTemplate(seg);
  const half = [w / 2 - rr, h / 2 - rr, d / 2 - rr];
  const pos = new Float32Array(t.sign.length);
  for (let i = 0; i < pos.length; i++) pos[i] = t.sign[i] * half[i % 3] + t.nrm[i] * rr;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(t.nrm.slice(), 3));
  g.setIndex(t.index);
  return g;
}

function cyl(r: number, len: number, seg = 16, open = false, r2 = r): BufferGeometry {
  return new CylinderGeometry(r, r2, len, seg, 1, open);
}

/** Tags a painted geometry with its paint zone (see zones.ts). */
export function zoned(g: BufferGeometry, zone: number): BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('zone', new BufferAttribute(new Float32Array(n).fill(zone), 1));
  return g;
}

function mirrorX(g: BufferGeometry): BufferGeometry {
  const m = g.clone();
  m.applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
  // flip winding so normals stay outward
  let idx = m.getIndex();
  if (!idx) {
    const n = m.getAttribute('position').count;
    const a = new Uint32Array(n);
    for (let i = 0; i < n; i++) a[i] = i;
    idx = new BufferAttribute(a, 1);
    m.setIndex(idx);
  }
  const a = idx.array as Uint16Array | Uint32Array;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1];
    a[i + 1] = a[i + 2];
    a[i + 2] = t;
  }
  idx.needsUpdate = true;
  m.computeVertexNormals();
  return m;
}

const both = (g: BufferGeometry) => [g, mirrorX(g)];

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Thin plate from a 2D outline drawn in the car's (z, y) plane, `thick` wide in x, centred on x. */
function plateZY(pts: [number, number][], thick: number, x: number, bevel = 0.004): BufferGeometry {
  const s = new Shape();
  // shape X = -z so that, after turning the extrusion to run along +x, z comes out right
  pts.forEach(([z, y], i) => (i ? s.lineTo(-z, y) : s.moveTo(-z, y)));
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: thick, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  g.translate(0, 0, -thick / 2);
  g.rotateY(Math.PI / 2);
  g.translate(x, 0, 0);
  return g;
}

/** Thin plate from a 2D outline drawn in the car's (x, z) plane (seen from above), `thick` tall, top at y. */
function plateXZ(pts: [number, number][], thick: number, y: number, bevel = 0.005): BufferGeometry {
  const s = new Shape();
  pts.forEach(([x, z], i) => (i ? s.lineTo(x, z) : s.moveTo(x, z)));
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: thick, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** Cross-section outline drawn in the car's (x, y) plane, extruded along z from z0 to z1 with rounded ends. */
function railXY(pts: [number, number][], z0: number, z1: number, bevel = 0.02): BufferGeometry {
  const s = new Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  const depth = Math.max(0.01, z1 - z0 - bevel * 2);
  const g = new ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.6, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, z0 + bevel);
  return g;
}


/**
 * A side sill extruded along z between the arches, whose ends run on into the
 * wheel openings and are pressed down onto each arch's curve (with room for
 * the tyre at full bump and lock), so the skirt hugs the arches of whatever
 * body it's on instead of stopping square in front of them.
 */
function sillRail(pts: [number, number][], K: Skeleton, za: number, zb: number, extend = 0.14, n = 28): BufferGeometry {
  const z0 = za - extend;
  const z1 = zb + extend;
  // rear arch behind the sill (+1: the sill lies ahead of it), front arch ahead of it (-1)
  const arches = [
    { z: K.rear.z, y: K.rear.r, R: K.rear.arch + 0.012, side: 1 },
    { z: K.front.z, y: K.front.r, R: K.front.arch + 0.03, side: -1 },
  ];
  // a point inside a wheel opening slides along the car onto the arch's curve: the sill's end is cut to the arch
  const at = (x: number, y: number, z: number): [number, number, number] => {
    let zz = z;
    for (const c of arches) {
      const dy = y - c.y;
      if (Math.abs(dy) >= c.R) continue;
      const half = Math.sqrt(c.R * c.R - dy * dy);
      if (c.side > 0 ? zz < c.z + half : zz > c.z - half) zz = c.z + c.side * half;
    }
    return [x, y, zz];
  };
  const m = pts.length;
  const pos: number[] = [];
  const idx: number[] = [];
  // each profile edge gets its own pair of columns: crisp across the profile, smooth along the car
  for (let e = 0; e < m; e++) {
    const p0 = pts[e];
    const p1 = pts[(e + 1) % m];
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const z = z0 + ((z1 - z0) * i) / n;
      pos.push(...at(p0[0], p0[1], z), ...at(p1[0], p1[1], z));
    }
    for (let i = 0; i < n; i++) {
      const a0 = base + i * 2;
      // the profile runs anticlockwise (seen from the front), so this winding faces outwards
      idx.push(a0, a0 + 3, a0 + 2, a0, a0 + 1, a0 + 3);
    }
  }
  // end caps
  for (const [i, flip] of [[0, true], [n, false]] as const) {
    const z = z0 + ((z1 - z0) * i) / n;
    const c = pos.length / 3;
    for (const [x, y] of pts) {
      pos.push(...at(x, y, z));
    }
    for (let k = 1; k < m - 1; k++) idx.push(...(flip ? [c, c + k + 1, c + k] : [c, c + k, c + k + 1]));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- the shell

/** Nearest axle to (y, z) in the side view, by distance relative to its arch. */
function archPolar(K: Skeleton, y: number, z: number): { r: number; a: Axle } {
  const rf = Math.hypot(y - K.front.r, z - K.front.z);
  const rr = Math.hypot(y - K.rear.r, z - K.rear.z);
  return rf / K.front.arch < rr / K.rear.arch ? { r: rf, a: K.front } : { r: rr, a: K.rear };
}

/** vertices this close inside the arch are snapped onto its edge */
const EDGE_BAND = 0.05;

/** Fender flare added to the shell's half width at (y, z): wide haunches over the wheels, a waist between them. */
function flare(K: Skeleton, sc: BodySculpt, ax: number, y: number, z: number): number {
  let out = 0;
  for (const a of [K.front, K.rear]) {
    const front = a === K.front;
    // the rear haunch swells forward into the doors, the front wing trails back into them
    const reach = front ? (z < a.z ? 0.95 : 0.72) : z > a.z ? 1.15 : 0.55;
    const u = (z - a.z) / reach;
    if (Math.abs(u) >= 1) continue;
    const k = (1 - u * u) ** 2;
    const top = a.r + a.arch;
    const wy = smooth(0.2 + K.lift, 0.46 + K.lift, y) * (1 - smooth(top + 0.055, top + 0.225, y));
    out += (front ? sc.flareF : sc.flareR) * k * wy * smooth(0.45, 0.8, ax);
  }
  return out;
}

/** Sculpted scallop along the doors (rising towards the tail) and, on some bodies, a deep intake scoop. */
function scallop(K: Skeleton, sc: BodySculpt, ax: number, y: number, z: number): number {
  const along = smooth(K.rear.z + 0.3, K.rear.z + 0.8, z) * (1 - smooth(K.front.z - 0.77, K.front.z - 0.37, z));
  const yl = sc.crease ? sc.crease.yF + (sc.crease.yR - sc.crease.yF) * smooth(1.0, -1.0, z) - 0.17 : 0.46 + K.lift;
  let d = (0.016 + (sc.crease?.amount ?? 0)) * along * Math.exp(-(((y - yl) / 0.06) ** 2));
  const it = sc.intake;
  if (it) {
    const zc = (it.z0 + it.z1) / 2;
    const yc = (it.y0 + it.y1) / 2;
    const u = (z - zc) / ((it.z1 - it.z0) / 2);
    // teardrop: deepest at the back, where it feeds the engine
    const v = (y - yc - 0.06 * u) / ((it.y1 - it.y0) / 2) / (0.75 + 0.25 * (1 - u));
    const r = Math.hypot(u, v);
    d += it.depth * (1 - smooth(0.3, 1.0, r)) ** 1.5 * (0.45 + 0.55 * smooth(1, -0.6, u));
  }
  return d * smooth(0.6, 0.85, ax);
}

/** Half width of the finished shell surface at (y, z), computed from the sections. */
function outerHalfWidth(fine: Section[], K: Skeleton, sc: BodySculpt, y: number, z: number): number {
  const curve = profileCurve(sectionAt(fine, z));
  let prev = curve.getPoint(0);
  for (let i = 1; i <= 48; i++) {
    const p = curve.getPoint(i / 48);
    if (p.y >= y) {
      const t = Math.min(1, Math.max(0, (y - prev.y) / Math.max(1e-5, p.y - prev.y)));
      const ax = prev.x + (p.x - prev.x) * t;
      return ax + flare(K, sc, ax, y, z) - scallop(K, sc, ax, y, z);
    }
    prev = p;
  }
  return prev.x;
}

/** Height of a section's skin at half width x (on the top or upper flank). */
export function skinY(sec: Section, x: number): number {
  const curve = profileCurve(sec);
  let prev = curve.getPoint(1);
  for (let i = 47; i >= 24; i--) {
    const p = curve.getPoint(i / 48);
    if (p.x >= x) {
      const t = Math.min(1, Math.max(0, (x - prev.x) / Math.max(1e-5, p.x - prev.x)));
      return prev.y + (p.y - prev.y) * t;
    }
    prev = p;
  }
  return prev.y;
}

/** Flares the fenders, sculpts the doors and pushes the wheel wells in. Returns per-vertex paint zones (the shader darkens the wells itself). */
function sculpt(g: BufferGeometry, K: Skeleton, sc: BodySculpt, cut = true): Float32Array {
  const pos = g.getAttribute('position') as BufferAttribute;
  const zone = new Float32Array(pos.count).fill(ZONE.auto);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const sx = x < 0 ? -1 : 1;
    let ax = Math.abs(x);
    ax += flare(K, sc, ax, y, z) - scallop(K, sc, ax, y, z);
    const { r, a } = archPolar(K, y, z);
    if (cut && ax > K.wellX && r < a.arch) {
      if (r > a.arch - EDGE_BAND && y > a.r - 0.2) {
        // the vertices nearest the cut are pulled onto the arch circle, so the opening is a clean round edge
        const k = a.arch / Math.max(1e-4, r);
        pos.setY(i, a.r + (y - a.r) * k);
        pos.setZ(i, a.z + (z - a.z) * k);
      } else {
        ax = K.wellX;
      }
    }
    pos.setX(i, sx * ax);
  }
  pos.needsUpdate = true;
  return zone;
}

/** Where the nose or tail face is, for placing lamps, grilles and bumpers on any shape. */
export interface EndInfo {
  /** z of the very tip */
  tip: number;
  /** bottom and top of the face, near the tip */
  bottom: number;
  top: number;
  /** shoulder height and half width near the tip */
  ys: number;
  ws: number;
}

export interface ShellInfo {
  geo: PartGeo;
  /** outer skin, without the cabin */
  surface: Surface;
  body: BodyInfo;
  /** the body's skeleton: axles, wheels, joints, ride height */
  K: Skeleton;
  hoodStart: number;
  /** z where the hood's top surface ends at the nose */
  hoodEnd: number;
  /** smooth sections of the whole shell */
  fine: Section[];
  nose: EndInfo;
  tail: EndInfo;
  /** paint shader layout: door shut lines, the fuel filler and the bumper splits */
  doors: { front: number; rear: number };
  bumpers: { front: number; rear: number };
  /** height span of the door shut lines and the fuel filler's height */
  doorY: [number, number, number];
}

function endInfo(fine: Section[], side: 1 | -1): EndInfo {
  const tipSec = side > 0 ? fine[fine.length - 1] : fine[0];
  const near = sectionAt(fine, tipSec.z - side * 0.14);
  return { tip: tipSec.z, bottom: Math.max(tipSec.yb, near.yb), top: near.yt, ys: near.ys, ws: near.ws };
}

/**
 * One continuous body shell for body + front + rear: the nose and tail are
 * built from the body's own joint sections, so lofting them together gives a
 * seamless surface. Fender flares, scallops and wheel wells are then sculpted
 * into it at the body's own axles.
 */
export function shellPart(bodyId: string, frontId: string, rearId: string, dome = false): ShellInfo {
  const body = bodySections(bodyId);
  const K = body.skeleton;
  const nose = frontSections(frontId, body.frontJoint, K);
  const keys = [...rearSections(rearId, body.rearJoint, K), ...body.hull, ...nose];
  const fine = refine(keys, (len) => len / 0.032);
  const sc = body.sculpt;
  const g = loft(fine, { capStart: true, capEnd: true, ring: 46 });
  if (dome) powerDome(g, body.cabin[0].z + 0.1, nose.at(-1)!.z - 0.4);
  const uncut = g.clone();
  g.setAttribute('zone', new BufferAttribute(sculpt(g, K, sc), 1));
  g.computeVertexNormals();
  // the arch cut folds triangles around the opening; take the skin's normals
  // from an uncut copy so the paint around every arch shades smoothly
  sculpt(uncut, K, sc, false);
  uncut.computeVertexNormals();
  {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const un = uncut.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getX(i)) > K.wellX + 1e-4) n.setXYZ(i, un.getX(i), un.getY(i), un.getZ(i));
    }
    n.needsUpdate = true;
    uncut.dispose();
  }
  const geo = emptyPart();
  geo.paint.push(g);

  // arch lips: a rolled edge that follows the fender around each opening, and
  // a dark liner from the lip back to the well wall that hides the cut
  for (const ax of [K.front, K.rear]) {
    const pts: Vector3[] = [];
    const liner: number[] = [];
    const lIdx: number[] = [];
    const M = 40;
    for (let i = 0; i <= M; i++) {
      const a = -0.2 + (i / M) * (Math.PI + 0.4);
      const y = ax.r + Math.sin(a) * (ax.arch + 0.008);
      const z = ax.z + Math.cos(a) * (ax.arch + 0.008);
      if (y < sectionAt(fine, z).yb + 0.015) continue;
      const ox = outerHalfWidth(fine, K, sc, y, z);
      pts.push(new Vector3(ox - 0.014, y, z));
      const ly = ax.r + Math.sin(a) * (ax.arch - 0.004);
      const lz = ax.z + Math.cos(a) * (ax.arch - 0.004);
      liner.push(ox - 0.012, ly, lz, K.wellX, ly, lz);
    }
    const lip = new TubeGeometry(new CatmullRomCurve3(pts), 48, 0.02, 6, false);
    geo.paint.push(...both(zoned(lip, ZONE.auto)));
    const n = liner.length / 6;
    for (let i = 0; i < n - 1; i++) {
      const k = i * 2;
      // facing the axle (into the opening)
      lIdx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(liner), 3));
    lg.setIndex(lIdx);
    lg.computeVertexNormals();
    const nrm = lg.getAttribute('normal');
    // make sure it faces the wheel: the normal at the top of the arch must point down
    const mid = Math.floor(n / 2) * 2;
    if (nrm.getY(mid) > 0) {
      for (let i = 0; i < lIdx.length; i += 3) [lIdx[i + 1], lIdx[i + 2]] = [lIdx[i + 2], lIdx[i + 1]];
      lg.setIndex(lIdx);
      lg.computeVertexNormals();
    }
    geo.trim.push(...both(lg));
  }

  // underfloor: a dark flat pan so nothing glows through the gaps underneath
  const tipF = fine[fine.length - 1].z;
  const tipR = fine[0].z;
  geo.trim.push(place(new BoxGeometry(Math.min(1.0, K.wellX * 2), 0.02, tipF - tipR - 0.8), [0, 0.24 + K.lift, (tipF + tipR) / 2]));

  // detail placement casts rays at the same skin
  const surface = new Surface([g]);
  const cabin = body.cabin;
  const hoodStart = cabin[0].z + 0.02;
  // hood ends where the nose starts to fall away
  const base = surface.topY(0, K.frontJointZ, 0.84);
  let hoodEnd = tipF - 0.15;
  for (let z = K.frontJointZ; z < tipF; z += 0.02) {
    if (surface.topY(0, z, 0) < base - 0.07) {
      hoodEnd = z - 0.03;
      break;
    }
  }
  const zB = bPillarZ(body);
  const doors = { front: Math.min(cabin[0].z + 0.14, K.front.z - K.front.arch - 0.06), rear: zB - 0.16 };
  const fuelZ = doors.rear - 0.32;
  const beltAtB = skinY(sectionAt(fine, zB), cabin[2].beltW) + 0.03;
  const shell: ShellInfo = {
    geo,
    surface,
    body,
    K,
    hoodStart,
    hoodEnd,
    fine,
    nose: endInfo(fine, 1),
    tail: endInfo(fine, -1),
    doors,
    bumpers: { front: K.frontJointZ + 0.33 * K.noseScale, rear: K.rearJointZ - 0.33 * K.tailScale },
    doorY: [0.3 + K.lift, beltAtB + 0.05, sectionAt(fine, fuelZ).ys + 0.075],
  };
  bodyFeatures(shell);
  return shell;
}

/** Raises a long, softly blended power dome along the hood's centre line, as part of the skin itself. */
function powerDome(g: BufferGeometry, z0: number, z1: number) {
  const pos = g.getAttribute('position') as BufferAttribute;
  const uv = g.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z <= z0 || z >= z1) continue;
    // only the top of each section (the ring runs bottom centre -> top centre -> bottom centre)
    const top = 1 - smooth(0.08, 0.12, Math.abs(uv.getX(i) - 0.5));
    if (top <= 0) continue;
    const u = (z - z0) / (z1 - z0);
    // swells quickly from the windscreen, tapers long towards the nose
    const along = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.7 * smooth(0, 0.18, u);
    const x = pos.getX(i);
    const across = Math.exp(-((x / 0.23) ** 4));
    pos.setY(i, pos.getY(i) + 0.034 * along * across * top);
  }
  pos.needsUpdate = true;
}

/** z of the B-pillar: a little behind the middle of the side glass. */
function bPillarZ(body: BodyInfo): number {
  const k = body.cabin;
  const roofMax = Math.max(...k.map((c) => c.roof));
  const firstHigh = k.find((c) => c.roof > roofMax - 0.06)!.z;
  const lastHigh = [...k].reverse().find((c) => c.roof > roofMax - 0.06)!.z;
  return firstHigh + (lastHigh - firstHigh) * 0.62;
}

/** Trim that belongs to a body: fender gills, flank intakes, engine-cover louvres, cladding, pod vents. */
function bodyFeatures(shell: ShellInfo) {
  const { surface: s, body, geo, K } = shell;
  const f = body.features;
  if (f.gills) {
    // three raked gills behind the front wheel, dark with a bright edge
    const z0 = K.front.z - K.front.arch - 0.09;
    const y0 = 0.47 + K.lift;
    for (let i = 0; i < 3; i++) {
      const zc = z0 - i * 0.07;
      const slot: [number, number][] = [
        [zc + 0.012, y0],
        [zc + 0.045, y0 + 0.15],
        [zc + 0.02, y0 + 0.155],
        [zc - 0.014, y0 + 0.005],
      ];
      geo.trim.push(...both(conform(s, soften(slot, 0.3), flank(), { off: 0.002, step: 0.02, rings: 2 })));
      geo.chrome.push(...both(conformStrip(s, [[zc + 0.044, y0 + 0.155], [zc + 0.012, y0]], 0.006, flank(), { off: 0.003 })));
    }
  }
  if (f.intake && body.sculpt.intake) {
    const it = body.sculpt.intake;
    // the grille sits deep in the back of the scoop
    const zc = it.z0 + (it.z1 - it.z0) * 0.3;
    const yc = (it.y0 + it.y1) / 2 - 0.02;
    const k = Math.min(1, (it.z1 - it.z0) / 0.7);
    const kh = Math.min(1, (it.y1 - it.y0) / 0.3);
    const mouth = soften(
      [
        [zc + 0.14 * k, yc + 0.06 * kh],
        [zc - 0.1 * k, yc + 0.09 * kh],
        [zc - 0.12 * k, yc - 0.06 * kh],
        [zc + 0.09 * k, yc - 0.075 * kh],
      ],
      0.3,
    );
    geo.trim.push(...both(conform(s, mouth, flank(), { off: 0.006, step: 0.02, rings: 5 })));
    const n = Math.max(3, Math.round(5 * kh));
    for (let j = 0; j < n; j++) {
      const yy = yc - 0.05 * kh + (j * 0.112 * kh) / Math.max(1, n - 1);
      geo.carbon.push(...both(conformStrip(s, [[zc + 0.09 * k, yy - 0.008], [zc - 0.09 * k, yy + 0.016]], 0.01, flank(), { off: 0.006, wall: 0.006 })));
    }
  }
  if (f.louvres) {
    // engine cover louvres between the rear glass and the tail
    const zA = body.cabin[body.cabin.length - 1].z - 0.06;
    const zEnd = K.rearJointZ - 0.02;
    const base = roundRect(0, (zA + zEnd) / 2, 0.78, zA - zEnd, 0.04);
    geo.trim.push(conform(s, base, above(), { off: 0.003, step: 0.05, rings: 3 }));
    const n = Math.max(3, Math.floor((zA - zEnd - 0.04) / 0.055));
    for (let k = 0; k < n; k++) {
      const z = zEnd + 0.04 + ((zA - zEnd - 0.08) * k) / Math.max(1, n - 1);
      geo.paint.push(zoned(conformStrip(s, [[-0.36, z], [0.36, z]], 0.024, above(), { off: 0.012, wall: 0.01 }), ZONE.rear));
    }
  }
  if (f.podVents) {
    // extractor louvres on top of each front wheel pod, letting the arch breathe
    const A = above();
    const x = K.front.x - 0.06;
    const vent = roundRect(x, K.front.z - 0.04, 0.24, 0.46, 0.05);
    geo.trim.push(...both(conform(s, vent, A, { off: 0.004, rings: 3, step: 0.04 })));
    geo.carbon.push(...both(conformBand(s, vent, A, { shrink: 0.88, off: 0.011, offInner: 0.008, wall: 0.012, step: 0.04 })));
    for (let k = 0; k < 7; k++) {
      const z = K.front.z - 0.24 + k * 0.067;
      geo.paint.push(...both(zoned(conformStrip(s, [[x - 0.095, z], [x + 0.095, z - 0.012]], 0.022, A, { off: 0.012, wall: 0.01 }), ZONE.front)));
    }
  }
  if (f.cladding) {
    // tough black cladding: a broad band around each arch and a rubbing strip along the sills
    for (const a of [K.front, K.rear]) {
      const path: [number, number][] = [];
      const R = a.arch + 0.045;
      for (let i = 0; i <= 28; i++) {
        const t = -0.12 + (i / 28) * (Math.PI + 0.24);
        const z = a.z + Math.cos(t) * R;
        const y = a.r + Math.sin(t) * R;
        if (y < sectionAt(shell.fine, z).yb + 0.04) continue;
        path.push([z, y]);
      }
      if (path.length > 2) geo.trim.push(...both(conformStrip(s, path, 0.085, flank(), { off: 0.012, wall: 0.016, step: 0.03 })));
    }
    const z0 = K.rear.z + K.rear.arch + 0.05;
    const z1 = K.front.z - K.front.arch - 0.05;
    const ys = sectionAt(shell.fine, (z0 + z1) / 2).yb + 0.1;
    geo.trim.push(...both(conformStrip(s, [[z0, ys], [z1, ys]], 0.11, flank(), { off: 0.01, wall: 0.014, step: 0.05 })));
  }
}

// ---------------------------------------------------------------- cabin

/**
 * A panel that lies exactly on the cabin's surface (offset outwards by `off`),
 * covering the profile parameter range [t0, t1] (0.5 = belt line, 0.75 = roof
 * edge, 1 = roof centre) between z0 and z1. Right-hand half only.
 */
function cabinPatch(fine: Section[], t0: number, t1: number, z0: number, z1: number, off: number, nt = 6, dz = 0.04): BufferGeometry {
  const nz = Math.max(2, Math.ceil(Math.abs(z1 - z0) / dz));
  const P = (t: number, z: number) => {
    const p = profileCurve(sectionAt(fine, z)).getPoint(Math.min(1, Math.max(0, t)));
    return new Vector3(Math.max(0, p.x), p.y, z);
  };
  const pos: number[] = [];
  for (let i = 0; i <= nz; i++) {
    const z = z0 + ((z1 - z0) * i) / nz;
    for (let j = 0; j <= nt; j++) {
      const t = t0 + ((t1 - t0) * j) / nt;
      const p = P(t, z);
      const du = P(t + 0.01, z).sub(P(t - 0.01, z));
      const dzv = P(t, z + 0.01).sub(P(t, z - 0.01));
      const n = new Vector3().crossVectors(du, dzv).normalize();
      if (n.lengthSq() < 0.5) n.set(0, 1, 0);
      p.addScaledVector(n, off);
      if (t >= 0.999) p.x = 0;
      pos.push(p.x, p.y, p.z);
    }
  }
  const idx: number[] = [];
  const w = nt + 1;
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < nt; j++) {
      const a = i * w + j;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure the panel faces outwards whichever way z ran
  const nrm = g.getAttribute('normal');
  const mid = Math.floor(nrm.count / 2);
  const out = new Vector3(pos[mid * 3], pos[mid * 3 + 1] - 0.85, 0);
  if (new Vector3(nrm.getX(mid), nrm.getY(mid), nrm.getZ(mid)).dot(out) < 0) {
    const a = g.getIndex()!.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) [a[i + 1], a[i + 2]] = [a[i + 2], a[i + 1]];
    g.computeVertexNormals();
  }
  return g;
}

export function cabinPart(id: string, shell: ShellInfo): PartGeo {
  const geo = emptyPart();
  const keys = shell.body.cabin;
  // the glasshouse grows out of the body: its belt sits just above the skin
  // under it and its base is buried in the body, whatever the body's shape
  const secs: Section[] = keys
    .slice()
    .reverse()
    .map((k) => {
      const under = sectionAt(shell.fine, k.z);
      const belt = skinY(under, k.beltW) + 0.03;
      return {
        z: k.z,
        yb: Math.min(under.yc ?? under.yt, belt) - 0.06,
        wb: k.beltW - 0.05,
        ys: belt,
        ws: k.beltW,
        yt: Math.max(k.roof, belt + 0.01),
        wt: k.roofW,
        crisp: shell.body.cabinCrisp,
      };
    });
  void id;
  const fine = refine(secs, 8);
  geo.glass.push(loft(fine, { capStart: true, capEnd: true, ring: 32 }));

  const zFront = keys[0].z;
  const zBack = keys[keys.length - 1].z;
  const roofMax = Math.max(...keys.map((k) => k.roof));
  const roofAt = (z: number) => sectionAt(fine, z).yt;
  let zWs = zFront;
  for (let z = zFront; z > zBack; z -= 0.01) {
    if (roofAt(z) > roofMax - 0.05) {
      zWs = z;
      break;
    }
  }
  let zRg = zBack;
  for (let z = zBack; z < zFront; z += 0.01) {
    if (roofAt(z) > roofMax - 0.05) {
      zRg = z;
      break;
    }
  }
  const zSideBack = zRg - (zRg - zBack) * 0.35;
  const zB = bPillarZ(shell.body);

  const roofPanels = [
    cabinPatch(fine, 0.72, 1.0, zRg - 0.04, zWs + 0.04, 0.006, 8),
    // A-pillar
    cabinPatch(fine, 0.6, 0.76, zWs + 0.02, zFront - 0.015, 0.006, 4),
    // C-pillar (sail panel)
    cabinPatch(fine, 0.49, 0.76, zBack + 0.01, zSideBack, 0.006, 6),
    // B-pillar
    cabinPatch(fine, 0.49, 0.74, zB - 0.035, zB + 0.035, 0.006, 4, 0.035),
  ];
  for (const p of roofPanels) geo.paint.push(...both(zoned(p, ZONE.roof)));
  // gloss black frame around the side glass, a chrome window line along the belt and drip rail
  geo.trim.push(...both(cabinPatch(fine, 0.47, 0.515, zBack + 0.02, zFront - 0.02, 0.008, 2)));
  geo.chrome.push(...both(cabinPatch(fine, 0.512, 0.522, zSideBack + 0.02, zFront - 0.06, 0.0095, 1)));
  geo.chrome.push(...both(cabinPatch(fine, 0.735, 0.752, zSideBack, zWs + 0.02, 0.009, 1)));
  geo.trim.push(...both(cabinPatch(fine, 0.6, 0.74, zFront - 0.05, zFront - 0.015, 0.0075, 3)));

  // shark-fin antenna
  const finZ = zRg + 0.14;
  const finY = roofAt(finZ) + 0.005;
  geo.paint.push(
    zoned(
      plateZY(
        [
          [finZ + 0.12, finY],
          [finZ - 0.04, finY + 0.055],
          [finZ - 0.07, finY + 0.05],
          [finZ - 0.08, finY],
        ],
        0.03,
        0,
        0.008,
      ),
      ZONE.roof,
    ),
  );

  // side mirrors: a sculpted painted pod on a slim arm, reflective glass facing back
  const mz = zWs + (zFront - zWs) * 0.5;
  const under = sectionAt(fine, mz);
  const my = under.ys + 0.065;
  const mx = under.ws + 0.13;
  const pod: Section[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const r = Math.sin(Math.PI * (0.08 + 0.84 * t)) ** 0.6;
    const zz = mz - 0.055 + 0.13 * t;
    pod.push({ z: zz, yb: my - 0.04 * r, wb: 0.06 * r, ys: my - 0.005, ws: 0.085 * r + 0.004, yt: my + 0.038 * r, wt: 0.06 * r, crisp: 0.45 });
  }
  const housing = loft(pod, { capStart: true, capEnd: true, ring: 12 });
  housing.translate(mx, 0, 0);
  geo.paint.push(...both(zoned(housing, ZONE.roof)));
  const glassM = rbox(0.15, 0.06, 0.008, 0.02, 2);
  place(glassM, [mx, my - 0.002, mz - 0.054]);
  geo.chrome.push(...both(glassM));
  const arm = rbox(0.12, 0.022, 0.05, 0.01, 2);
  place(arm, [mx - 0.09, my - 0.03, mz + 0.02], [0, 0.1, -0.3]);
  geo.trim.push(...both(arm));

  // cowl and wipers at the base of the windscreen
  const cowlY = shell.surface.topY(0, zFront + 0.02, keys[0].roof);
  const Kc = shell.K.front;
  // over a cab-forward body the cowl sits between the front wheels: keep it inside them
  const cowlW = Math.min(keys[0].beltW * 1.9, 2 * (Kc.x - Kc.width / 2 - 0.1));
  geo.trim.push(place(rbox(cowlW, 0.02, 0.08, 0.008), [0, cowlY + 0.004, zFront + 0.03]));
  for (const x of [0.32, -0.12]) {
    geo.trim.push(place(rbox(0.5, 0.012, 0.016, 0.005), [x, cowlY + 0.03, zFront - 0.02], [0.5, 0.18, 0]));
  }

  // flush door handles just ahead of the rear shut line
  const hz = shell.doors.rear + 0.16;
  const hy = sectionAt(shell.fine, hz).ys - 0.035;
  geo.chrome.push(...both(conformStrip(shell.surface, [[hz - 0.07, hy], [hz + 0.07, hy]], 0.024, flank(), { off: 0.004, wall: 0.004 })));
  geo.trim.push(...both(conformStrip(shell.surface, [[hz - 0.05, hy - 0.016], [hz + 0.05, hy - 0.016]], 0.01, flank(), { off: 0.002 })));

  // third brake light at the top of the rear glass
  const tbZ = zRg - 0.06;
  geo.tail.push(place(rbox(0.26, 0.018, 0.025, 0.008), [0, roofAt(tbZ) - 0.005, tbZ], [0.6, 0, 0]));

  const f = shell.body.features;
  if (f.rails) {
    // roof rails on slim feet
    const za = zRg + 0.06;
    const zb = zWs - 0.08;
    const rw = Math.min(...keys.slice(1, 5).map((k) => k.roofW)) - 0.07;
    const pts: Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const z = za + ((zb - za) * i) / 12;
      pts.push(new Vector3(rw, roofAt(z) + 0.045, z));
    }
    geo.chrome.push(...both(new TubeGeometry(new CatmullRomCurve3(pts), 24, 0.013, 8, false)));
    for (const z of [za + 0.02, (za + zb) / 2, zb - 0.02]) {
      geo.trim.push(...both(place(rbox(0.03, 0.06, 0.07, 0.01), [rw, roofAt(z) + 0.02, z])));
    }
  }
  if (f.rearWiper) {
    // a single wiper parked across the rear glass
    const zp = zBack + 0.03;
    const yp = sectionAt(fine, zp).ys + 0.06;
    const zt = zBack + (zRg - zBack) * 0.55;
    const tip = new Vector3(0.36, (sectionAt(fine, zt).ys + roofAt(zt)) / 2, zt);
    const pivot = new Vector3(0.02, yp, zp);
    const toTip = tip.clone().sub(pivot);
    const arm = rbox(0.016, 0.012, toTip.length(), 0.004);
    arm.lookAt(toTip);
    arm.translate((pivot.x + tip.x) / 2, (pivot.y + tip.y) / 2 + 0.012, (pivot.z + tip.z) / 2 - 0.012);
    geo.trim.push(arm);
    geo.trim.push(place(cyl(0.022, 0.03, 12), [pivot.x, pivot.y + 0.01, pivot.z - 0.01], [Math.PI / 2 - 0.5, 0, 0]));
  }
  if (f.fin) {
    // stability fin: rises out of the canopy and runs to the tail, painted like the roof
    const z0 = zRg + 0.15;
    const z1 = shell.tail.tip + 0.12;
    const bottom: [number, number][] = [];
    const top: [number, number][] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const z = z0 + (z1 - z0) * t;
      const skin = z > zBack + 0.02 ? roofAt(z) : shell.surface.topY(0, z, 0.8);
      bottom.push([z, skin - 0.02]);
      // the top edge leaves the roof and stays almost level, so the fin grows taller as the deck falls away
      const roofLine = roofAt(z0) + 0.015;
      top.push([z, Math.max(skin + 0.03, roofLine - 0.02 - 0.1 * t)]);
    }
    // a swept trailing edge
    top[top.length - 1][0] -= 0.1;
    geo.paint.push(zoned(plateZY([...bottom, ...top.reverse()], 0.018, 0, 0.007), ZONE.auto));
  }
  return geo;
}

// ---------------------------------------------------------------- front details

/** A flat blade under the nose following its outline in plan; minZ keeps it out of the front wheels. */
function splitter(s: Surface, y: number, halfW: number, protrude: number, depth: number, thick: number, minZ: number): BufferGeometry {
  const front: [number, number][] = [];
  let lastZ = minZ;
  for (let i = 0; i <= 18; i++) {
    const x = -halfW + (2 * halfW * i) / 18;
    const h = s.cast(new Vector3(x, y + 0.05, 4), new Vector3(0, 0, -1));
    if (h) lastZ = Math.max(minZ, h.point.z);
    front.push([x, lastZ + protrude - 0.06 * (Math.abs(x) / halfW) ** 4]);
  }
  const back = Math.max(minZ - 0.1, Math.min(...front.map((p) => p[1])) - depth);
  const outline: [number, number][] = [...front, [halfW * 0.92, back], [-halfW * 0.92, back]];
  return plateXZ(outline, thick, y, 0.006);
}

/** Horizontal bars filling an ellipse-ish opening: strips across at evenly spaced heights. */
function bars(s: Surface, proj: Projector, cx: number, cy: number, halfW: (dy: number) => number, h: number, n: number, width: number, bucket: BufferGeometry[], off = 0.006) {
  for (let i = 0; i < n; i++) {
    const dy = -h / 2 + (h * (i + 0.5)) / n;
    const w = halfW(dy);
    if (w < 0.03) continue;
    bucket.push(conformStrip(s, [[cx - w, cy + dy], [cx + w, cy + dy]], width, proj, { off, wall: off * 0.8 }));
  }
}

/** A diagonal (honeycomb-like) mesh across a convex opening, clipped to it. */
function meshFill(s: Surface, proj: Projector, outline: [number, number][], pitch: number, width: number, bucket: BufferGeometry[], off = 0.005) {
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const inside = (x: number, y: number) => {
    // point in polygon (even-odd)
    let c = false;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const [xi, yi] = outline[i];
      const [xj, yj] = outline[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (const sgn of [1, -1]) {
    for (let k = x0 - (y1 - y0); k <= x1 + (y1 - y0); k += pitch) {
      // line x = k + sgn * (y - y0): keep the part inside the outline, slightly inset
      const pts: [number, number][] = [];
      for (let t = 0; t <= 24; t++) {
        const y = y0 + ((y1 - y0) * t) / 24;
        const x = k + sgn * (y - y0);
        if (inside(x, y)) pts.push([x, y]);
      }
      if (pts.length < 3) continue;
      const a = pts[1];
      const b = pts[pts.length - 2];
      bucket.push(conformStrip(s, [a, b], width, proj, { off, step: 0.03 }));
    }
  }
}

/** The outline pulled towards its centroid by k (1 = unchanged). */
function shrinkOutline(pts: [number, number][], k: number): [number, number][] {
  let ca = 0;
  let cb = 0;
  for (const [a, b] of pts) {
    ca += a;
    cb += b;
  }
  ca /= pts.length;
  cb /= pts.length;
  return pts.map(([a, b]) => [ca + (a - ca) * k, cb + (b - cb) * k]);
}

/** Adds every bucket of `src` to `dst`, mirrored across the car as well when `mirror` is set. */
function mergePart(dst: PartGeo, src: PartGeo, mirror = false) {
  for (const k of Object.keys(dst) as (keyof PartGeo)[]) for (const geo of src[k]) dst[k].push(...(mirror ? both(geo) : [geo]));
}

/**
 * A lamp unit sunk into the skin: a polished reflector bed (or, for tail
 * lamps, a deep red lens bed), a thin satin lip round it and a domed clear
 * cover over everything, so the lit elements placed between them (at offsets
 * 0.008-0.013) sit inside a real-looking lamp, not on a sticker.
 */
function lampUnit(s: Surface, P: Projector, outline: [number, number][], kind: 'head' | 'tail', opts: { bezel?: boolean; cover?: boolean; step?: number } = {}): PartGeo {
  const u = emptyPart();
  const step = opts.step ?? 0.02;
  (kind === 'tail' ? u.tailLens : u.housing).push(conform(s, outline, P, { off: 0.004, wall: 0.012, rings: 3, step }));
  if (opts.bezel !== false) u.trim.push(conformBand(s, outline, P, { inner: shrinkOutline(outline, 0.94), off: 0.007, offInner: 0.006, wall: 0.011, step }));
  if (opts.cover !== false) u.lens.push(conform(s, shrinkOutline(outline, 0.965), P, { off: 0.014, dome: 0.006, rings: 4, step }));
  return u;
}

export function frontPart(id: string, shell: ShellInfo): PartGeo {
  const g = emptyPart();
  const s = shell.surface;
  const N = shell.nose;
  const K = shell.K;
  // the catalogue was drawn on the base car: heights follow the body's floor, widths its track
  const L = K.lift;
  const W = K.front.x / 0.85;
  const h = N.top - N.bottom;
  const fy = (k: number) => N.bottom + h * k;
  const F = face(1);
  // z of the nose face at (x, y); a ray that slips under the nose would find the wheel well, so keep clear of the arch
  const clearZ = K.front.z + K.front.arch + 0.3;
  const faceAt = (x: number, y: number) => Math.max(s.faceZ(x, y, 1, N.tip).z, clearZ);
  if (id === 'muscle') {
    // full-width recessed grille in a chrome surround, vertical bars, a badge and a chrome bumper bar
    const gy = fy(0.36);
    const gw = Math.min(0.68, N.ws * 0.74);
    const gh = Math.min(0.15, h * 0.3);
    const outline = roundRect(0, gy, gw * 2, gh, 0.035);
    g.plastic.push(conform(s, outline, F, { off: 0.003, rings: 3, step: 0.04 }));
    g.chrome.push(conformBand(s, roundRect(0, gy, gw * 2 + 0.05, gh + 0.045, 0.05), F, { inner: roundRect(0, gy, gw * 2, gh, 0.035), off: 0.012, offInner: 0.006, wall: 0.012 }));
    for (let i = -7; i <= 7; i++) {
      if (i === 0) continue;
      g.chrome.push(conformStrip(s, [[i * gw * 0.13, gy - gh * 0.4], [i * gw * 0.13, gy + gh * 0.4]], 0.012, F, { off: 0.008, wall: 0.006 }));
    }
    g.chrome.push(conformStrip(s, [[-gw, gy], [gw, gy]], 0.014, F, { off: 0.011, wall: 0.008 }));
    g.chrome.push(conform(s, ellipse(0, gy, 0.05, 0.036, 20), F, { off: 0.016, wall: 0.012, rings: 2 }));
    g.paint.push(zoned(conform(s, ellipse(0, gy, 0.036, 0.024, 16), F, { off: 0.019, rings: 2 }), ZONE.front));
    // chrome bumper bar with over-riders, just under the grille
    const by = fy(0.1);
    const fz = s.faceZ(0, by, 1, N.tip).z;
    const barW = N.ws * 1.62;
    const bar = new CylinderGeometry(0.032, 0.032, barW, 16);
    place(bar, [0, by, fz + 0.045], [0, 0, Math.PI / 2]);
    g.chrome.push(bar);
    for (const sx of [barW / 2, -barW / 2]) g.chrome.push(place(new SphereGeometry(0.032, 12, 8), [sx, by, fz + 0.045]));
    for (const x of [0.3, -0.3]) g.chrome.push(place(rbox(0.06, 0.12, 0.08, 0.025, 2), [x, by + 0.01, fz + 0.06]));
    // lower valance intake
    g.plastic.push(conform(s, roundRect(0, fy(0.0) + 0.03, 0.9 * W, 0.05, 0.022), F, { off: 0.003, step: 0.05, wall: 0.006 }));
  } else if (id === 'aggressive') {
    // carbon splitter following the nose, with end plates
    g.carbon.push(splitter(s, 0.2 + L, 0.8 * W, 0.075, 0.3, 0.02, clearZ));
    for (const x of [0.81 * W, -0.81 * W]) {
      const z = faceAt(x * 0.9, 0.24 + L);
      g.carbon.push(plateZY([[z + 0.06, 0.18 + L], [z - 0.24, 0.18 + L], [z - 0.24, 0.31 + L], [z - 0.02, 0.27 + L]], 0.015, x));
    }
    // a big trapezoid centre intake with a diagonal mesh
    const iy = fy(0.3);
    const ih = Math.min(0.15, h * 0.42);
    const mouth: [number, number][] = soften(
      [
        [0.38, iy - ih / 2],
        [0.27, iy + ih / 2],
        [-0.27, iy + ih / 2],
        [-0.38, iy - ih / 2],
      ],
      0.2,
    );
    g.plastic.push(conform(s, mouth, F, { off: 0.005, rings: 4, step: 0.03 }));
    meshFill(s, F, mouth, 0.05, 0.007, g.trim, 0.01);
    g.carbon.push(conformBand(s, mouth, F, { shrink: 1.08, off: 0.008, offInner: 0.008, wall: 0.008 }));
    // side intakes: angular blades sweeping up into the corners, with a carbon vane
    const sm = new Vector3(0.63 * W, iy, N.tip);
    const SP = planar(sm, new Vector3(-0.45, 0, -1));
    const sideMouth: [number, number][] = soften(
      [
        [-0.16, -ih / 2],
        [0.13, -ih / 2 + 0.01],
        [0.14, ih * 0.65],
        [-0.05, ih * 0.15],
      ],
      0.18,
    );
    g.plastic.push(...both(conform(s, sideMouth, SP, { off: 0.005, rings: 3 })));
    g.carbon.push(...both(conformStrip(s, [[-0.08, -ih / 2 + 0.01], [0.1, ih * 0.4]], 0.012, SP, { off: 0.01, wall: 0.008 })));
    // canards on the corners
    for (const x of [0.79 * W, -0.79 * W]) {
      const side = x > 0 ? 1 : -1;
      const z = faceAt(x * 0.97, fy(0.45));
      // a swept dive plane: thin, with a raked trailing edge, rolled up at its tip
      const canard = plateXZ([[0, 0.05], [0.17, 0.0], [0.19, -0.05], [0.02, -0.11]], 0.008, 0, 0.003);
      if (side < 0) canard.scale(-1, 1, 1);
      place(canard, [x * 0.96, fy(0.45), z - 0.02], [0, side * 0.3, side * 0.22]);
      g.carbon.push(canard);
    }
  } else if (id === 'shark') {
    // a wide, thin "smile" intake under the leading ridge, gill slats in the swept corners and a pointed carbon blade
    const my = fy(0.22);
    const mw = Math.min(0.56, N.ws * 0.9);
    const smile: [number, number][] = [];
    for (let i = 0; i <= 12; i++) {
      const u = -1 + (2 * i) / 12;
      smile.push([u * mw, my + 0.045 * u * u]);
    }
    g.plastic.push(conformStrip(s, smile, 0.075, F, { off: 0.004, step: 0.03, wall: 0.006 }));
    for (let i = 1; i < 12; i++) {
      const u = -1 + (2 * i) / 12;
      g.carbon.push(conformStrip(s, [[u * mw, my + 0.045 * u * u - 0.028], [u * mw, my + 0.045 * u * u + 0.028]], 0.008, F, { off: 0.008, wall: 0.006 }));
    }
    g.chrome.push(conformStrip(s, smile.map(([x, y]) => [x, y + 0.046] as [number, number]), 0.008, F, { off: 0.008, wall: 0.005, step: 0.03 }));
    // gill slats where the nose sweeps back
    const gc = new Vector3(Math.min(0.66 * W, N.ws * 0.95), fy(0.42), N.tip - 0.15);
    const GP = planar(gc, new Vector3(-0.7, 0, -0.75));
    for (let k = 0; k < 3; k++) {
      const a0 = -0.08 + k * 0.055;
      g.plastic.push(...both(conform(s, soften([[a0 - 0.012, -0.07], [a0 + 0.012, -0.075], [a0 + 0.04, 0.07], [a0 + 0.016, 0.075]], 0.3), GP, { off: 0.003, rings: 2, step: 0.02 })));
    }
    // pointed splitter: follows the nose in plan and runs out to a point at the centre
    const sy = 0.2 + L;
    const front: [number, number][] = [];
    let lastZ = N.tip;
    const hw = 0.7 * W;
    for (let i = 0; i <= 20; i++) {
      const x = -hw + (2 * hw * i) / 20;
      const hit = s.cast(new Vector3(x, sy + 0.05, 4), new Vector3(0, 0, -1));
      if (hit) lastZ = Math.max(clearZ, hit.point.z);
      front.push([x, lastZ + 0.03 + 0.05 * (1 - Math.abs(x) / hw) ** 2]);
    }
    const back = Math.max(clearZ - 0.1, Math.min(...front.map((p) => p[1])) - 0.2);
    g.carbon.push(plateXZ([...front, [hw * 0.9, back], [-hw * 0.9, back]], 0.018, sy, 0.006));
    g.carbon.push(conformStrip(s, [[-0.06, fy(0.5)], [0, fy(0.62)], [0.06, fy(0.5)]], 0.012, F, { off: 0.008, wall: 0.006 }));
  } else if (id === 'rally') {
    // a tough front: black bumper, aluminium skid plate, tow hooks and a pod of four spot lamps
    const gy = fy(0.6);
    const gw = Math.min(0.5, N.ws * 0.56);
    const gh = Math.min(0.17, h * 0.3);
    const grille = roundRect(0, gy, gw * 2, gh, 0.03);
    g.plastic.push(conform(s, grille, F, { off: 0.003, rings: 3, step: 0.04 }));
    meshFill(s, F, roundRect(0, gy, gw * 2 - 0.04, gh - 0.04, 0.02), 0.045, 0.008, g.trim, 0.008);
    g.trim.push(conformBand(s, roundRect(0, gy, gw * 2 + 0.05, gh + 0.05, 0.045), F, { inner: grille, off: 0.012, offInner: 0.007, wall: 0.012 }));
    // bumper
    const by = fy(0.28);
    const bw = Math.min(N.ws * 0.88, s.sideX(by, N.tip - 0.05, N.ws) - 0.08);
    g.plastic.push(conformStrip(s, [[-bw, by], [bw, by]], Math.min(0.14, h * 0.26), F, { off: 0.016, wall: 0.018, step: 0.05 }));
    g.trim.push(conform(s, roundRect(0, by, 0.32, 0.07, 0.015), F, { off: 0.02, rings: 2 }));
    // skid plate: a brushed plate wrapping under the nose
    const py = fy(0.06);
    const fz = s.faceZ(0, py, 1, N.tip).z;
    g.chrome.push(conform(s, roundRect(0, py, Math.min(1.0, N.ws * 1.3), Math.min(0.09, h * 0.16), 0.02), F, { off: 0.012, wall: 0.012, rings: 2, step: 0.05 }));
    g.chrome.push(place(rbox(Math.min(0.96, N.ws * 1.25), 0.016, 0.42, 0.006), [0, N.bottom - 0.015, fz - 0.17], [-0.12, 0, 0]));
    for (const x of [0.36, -0.36]) {
      const z = s.faceZ(x, by - 0.02, 1, N.tip).z;
      const hook = new TorusGeometry(0.03, 0.009, 6, 14);
      place(hook, [x, by - 0.06, z + 0.03], [Math.PI / 2, 0, 0]);
      g.chrome.push(hook);
    }
    // lamp pod: a tube frame carrying four spot lamps across the grille
    const ly = fy(0.52);
    const lz = s.faceZ(0, ly, 1, N.tip).z + 0.09;
    const span = Math.min(0.62, N.ws * 0.7);
    const bar = new CylinderGeometry(0.014, 0.014, span * 2 + 0.08, 10);
    place(bar, [0, ly - 0.07, lz - 0.02], [0, 0, Math.PI / 2]);
    g.trim.push(bar);
    for (const x of [span * 0.92, -span * 0.92]) g.trim.push(place(rbox(0.03, 0.03, 0.12, 0.008), [x, ly - 0.07, lz - 0.07]));
    for (const x of [-span * 0.75, -span * 0.25, span * 0.25, span * 0.75]) {
      const can = cyl(0.068, 0.07, 18, false, 0.055);
      place(can, [x, ly, lz], [Math.PI / 2, 0, 0]);
      g.trim.push(can);
      const ring = new TorusGeometry(0.066, 0.008, 6, 20);
      place(ring, [x, ly, lz + 0.036]);
      g.chrome.push(ring);
      // a polished reflector bowl, the bulb, and a domed glass over them
      const bowl = new SphereGeometry(0.06, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2.6);
      place(bowl, [x, ly, lz + 0.075], [-Math.PI / 2, 0, 0]);
      g.housing.push(bowl);
      g.light.push(place(new SphereGeometry(0.017, 12, 8), [x, ly, lz + 0.03]));
      const glassDome = new SphereGeometry(0.11, 20, 4, 0, Math.PI * 2, 0, 0.58);
      place(glassDome, [x, ly, lz + 0.034 - 0.11 * Math.cos(0.58)], [Math.PI / 2, 0, 0]);
      g.lens.push(glassDome);
      g.trim.push(place(rbox(0.02, 0.06, 0.03, 0.006), [x, ly - 0.06, lz - 0.01]));
    }
  } else {
    // classic: an oval mouth in a chrome bezel with fine bars, a badge, fog lamps and a slim lip
    const my = fy(0.32);
    const rw = Math.min(0.32, N.ws * 0.38);
    const rh = Math.min(0.085, h * 0.22);
    g.plastic.push(conform(s, ellipse(0, my, rw, rh, 32), F, { off: 0.003, rings: 3 }));
    g.chrome.push(conformBand(s, ellipse(0, my, rw + 0.022, rh + 0.02, 32), F, { inner: ellipse(0, my, rw, rh, 32), off: 0.011, offInner: 0.007, wall: 0.01 }));
    bars(s, F, 0, my, (dy) => rw * Math.sqrt(Math.max(0, 1 - (dy / rh) ** 2)) - 0.012, rh * 2, 5, 0.008, g.chrome);
    g.chrome.push(conformStrip(s, [[-rw * 0.25, my], [rw * 0.25, my]], 0.01, F, { off: 0.012, wall: 0.008 }));
    g.chrome.push(conform(s, ellipse(0, my + rh + 0.06, 0.035, 0.024, 18), F, { off: 0.009, wall: 0.008, rings: 2 }));
    for (const x of [0.6 * W, -0.6 * W]) {
      if (x * x > (N.ws * 0.85) ** 2) continue;
      g.plastic.push(conform(s, roundRect(x, fy(0.2), 0.17, 0.06, 0.03), F, { off: 0.003, rings: 2, wall: 0.006 }));
      mergePart(g, lampUnit(s, F, ellipse(x, fy(0.2), 0.034, 0.034, 18), 'head', { bezel: false }));
      g.chrome.push(conformBand(s, ellipse(x, fy(0.2), 0.04, 0.04, 18), F, { inner: ellipse(x, fy(0.2), 0.034, 0.034, 18), off: 0.01, offInner: 0.008, wall: 0.008 }));
      g.light.push(conform(s, ellipse(x, fy(0.2), 0.016, 0.016, 12), F, { off: 0.009, rings: 1 }));
    }
    g.trim.push(splitter(s, 0.24 + L, 0.68 * W, 0.025, 0.12, 0.02, clearZ));
  }
  return g;
}

// ---------------------------------------------------------------- rear details

export function rearPart(id: string, shell: ShellInfo): PartGeo {
  const g = emptyPart();
  const s = shell.surface;
  const T = shell.tail;
  const h = T.top - T.bottom;
  const ty = (k: number) => T.bottom + h * k;
  const B = face(-1);
  const K = shell.K;
  const L = K.lift;
  const W = K.rear.x / 0.85;
  if (id === 'boxy') {
    // vertical lamps up the corners, a recessed tailgate panel and a square black bumper
    const xL = T.ws * 0.84;
    for (const sx of [1, -1]) {
      const x = sx * xL;
      const lamp = roundRect(x, ty(0.68), 0.13, h * 0.5, 0.025);
      mergePart(g, lampUnit(s, B, lamp, 'tail', { step: 0.03 }));
      // an L-shaped light guide and a reverse lamp in its own reflector, all under the lens
      g.tail.push(conformStrip(s, [[x + sx * 0.035, ty(0.48)], [x + sx * 0.035, ty(0.9)]], 0.02, B, { off: 0.01, wall: 0.005 }));
      g.tail.push(conformStrip(s, [[x + sx * 0.035, ty(0.9)], [x - sx * 0.04, ty(0.9)]], 0.018, B, { off: 0.01, wall: 0.005 }));
      g.housing.push(conform(s, roundRect(x - sx * 0.02, ty(0.56), 0.062, 0.072, 0.012), B, { off: 0.007, rings: 1 }));
      g.light.push(conform(s, roundRect(x - sx * 0.02, ty(0.56), 0.036, 0.046, 0.008), B, { off: 0.0105, rings: 1 }));
      g.chrome.push(conformBand(s, roundRect(x, ty(0.68), 0.15, h * 0.5 + 0.02, 0.032), B, { inner: lamp, off: 0.008, offInner: 0.008, wall: 0.01, step: 0.03 }));
    }
    // tailgate: a piano-black glass panel in a satin frame, a chrome handle bar and the plate
    const gate = roundRect(0, ty(0.62), xL * 2 - 0.26, h * 0.34, 0.03);
    g.glass.push(conform(s, gate, B, { off: 0.004, rings: 3, step: 0.05, wall: 0.008 }));
    g.trim.push(conformBand(s, roundRect(0, ty(0.62), xL * 2 - 0.23, h * 0.34 + 0.03, 0.045), B, { inner: gate, off: 0.005, offInner: 0.005, wall: 0.008, step: 0.05 }));
    g.chrome.push(conformStrip(s, [[-0.2, ty(0.8)], [0.2, ty(0.8)]], 0.022, B, { off: 0.01, wall: 0.008 }));
    g.chrome.push(conform(s, roundRect(0, ty(0.6), 0.32, 0.1, 0.01), B, { off: 0.006, rings: 1 }));
    // bumper with a step plate and reflectors
    const bw = Math.min(T.ws * 0.92, s.sideX(ty(0.18), T.tip + 0.05, T.ws) - 0.06);
    g.plastic.push(conformStrip(s, [[-bw, ty(0.18)], [bw, ty(0.18)]], Math.min(0.14, h * 0.3), B, { off: 0.016, wall: 0.02, step: 0.05 }));
    g.chrome.push(conform(s, roundRect(0, ty(0.2), 0.5, 0.04, 0.01), B, { off: 0.022, rings: 1 }));
    for (const x of [bw - 0.12, 0.12 - bw]) g.tail.push(conform(s, roundRect(x, ty(0.18), 0.12, 0.022, 0.008), B, { off: 0.021, rings: 1 }));
  } else if (id === 'jet') {
    // two big round lamps, each a set of glowing rings around a dark turbine core, joined by a body-colour blade
    const ly = ty(0.6);
    const lx = Math.min(0.52 * W, T.ws * 0.62);
    const r = Math.min(0.15, h * 0.3);
    for (const x of [lx, -lx]) {
      mergePart(g, lampUnit(s, B, ellipse(x, ly, r + 0.02, r + 0.02, 30), 'tail', { bezel: false }));
      g.chrome.push(conformBand(s, ellipse(x, ly, r + 0.03, r + 0.03, 30), B, { shrink: (r + 0.012) / (r + 0.03), off: 0.014, offInner: 0.01, wall: 0.012 }));
      for (const k of [0.92, 0.66, 0.4]) g.tail.push(conformBand(s, ellipse(x, ly, r * k, r * k, 28), B, { shrink: 1 - 0.075 / k, off: 0.009 }));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.housing.push(conformStrip(s, [[x + Math.cos(a) * r * 0.12, ly + Math.sin(a) * r * 0.12], [x + Math.cos(a + 0.5) * r * 0.36, ly + Math.sin(a + 0.5) * r * 0.36]], 0.012, B, { off: 0.01, wall: 0.004 }));
      }
      g.chrome.push(conform(s, ellipse(x, ly, r * 0.1, r * 0.1, 14), B, { off: 0.012, rings: 1, dome: 0.004 }));
    }
    g.paint.push(zoned(conformStrip(s, [[-lx + r + 0.04, ly], [lx - r - 0.04, ly]], 0.05, B, { off: 0.012, wall: 0.012, step: 0.04 }), ZONE.rear));
    // a high mesh panel under the lamps with a centre fog lamp, and a body-colour lower blade
    const panel = roundRect(0, ty(0.26), Math.min(1.3, T.ws * 1.5), h * 0.26, 0.05);
    g.plastic.push(conform(s, panel, B, { off: 0.004, rings: 3, step: 0.04, wall: 0.008 }));
    meshFill(s, B, roundRect(0, ty(0.26), Math.min(1.26, T.ws * 1.46), h * 0.22, 0.04), 0.042, 0.006, g.trim, 0.009);
    g.tail.push(conform(s, roundRect(0, ty(0.26), 0.12, 0.04, 0.012), B, { off: 0.012, rings: 2, wall: 0.008 }));
    g.carbon.push(conformStrip(s, [[-T.ws * 0.82, ty(0.07)], [T.ws * 0.82, ty(0.07)]], 0.022, B, { off: 0.014, wall: 0.014, step: 0.05 }));
  } else if (id === 'kamm') {
    // duck-tail lip along the cut
    const lipZ = s.faceZ(0, T.top - 0.03, -1, T.tip).z;
    const ly = T.top - 0.01;
    g.paint.push(zoned(plateZY([[lipZ + 0.22, ly - 0.005], [lipZ - 0.07, ly + 0.06], [lipZ - 0.08, ly + 0.04], [lipZ + 0.02, ly - 0.03]], T.ws * 1.5, 0, 0.012), ZONE.rear));
    // a gloss black tail panel carrying four round lamps: lit ring, dark centre, chrome bezel
    const ly2 = ty(0.62);
    const pw = Math.min(1.6, T.ws * 1.75);
    const panel = roundRect(0, ly2, pw, 0.2, 0.06);
    g.glass.push(conform(s, panel, B, { off: 0.003, rings: 3, step: 0.05, wall: 0.006 }));
    g.chrome.push(conformBand(s, roundRect(0, ly2, pw + 0.024, 0.224, 0.07), B, { inner: panel, off: 0.005, offInner: 0.005, wall: 0.008, step: 0.05 }));
    const kx = Math.min(0.64, pw / 2 - 0.12);
    for (const x of [kx, kx - 0.24]) {
      for (const sx of [x, -x]) {
        mergePart(g, lampUnit(s, B, ellipse(sx, ly2, 0.072, 0.072, 26), 'tail', { bezel: false }));
        g.chrome.push(conformBand(s, ellipse(sx, ly2, 0.085, 0.085, 26), B, { inner: ellipse(sx, ly2, 0.072, 0.072, 26), off: 0.012, offInner: 0.008, wall: 0.012 }));
        g.tail.push(conformBand(s, ellipse(sx, ly2, 0.062, 0.062, 26), B, { shrink: 0.78, off: 0.0095 }));
        g.housing.push(conform(s, ellipse(sx, ly2, 0.034, 0.034, 18), B, { off: 0.008, rings: 2, dome: 0.004 }));
        g.tail.push(conform(s, ellipse(sx, ly2, 0.012, 0.012, 10), B, { off: 0.0125, rings: 1 }));
      }
    }
    // full-width bumper with vertical strakes, reverse lamps and a plate recess
    g.chrome.push(conformStrip(s, [[-T.ws * 0.86, ty(0.24)], [T.ws * 0.86, ty(0.24)]], 0.03, B, { off: 0.016, wall: 0.016, step: 0.05 }));
    g.plastic.push(conform(s, roundRect(0, ty(0.04) + 0.02, Math.min(1.3, T.ws * 1.4), 0.07, 0.03), B, { off: 0.004, step: 0.05, wall: 0.006 }));
    for (let i = -3; i <= 3; i++) g.carbon.push(conformStrip(s, [[i * 0.12, ty(0.0) + 0.0], [i * 0.12, ty(0.1)]], 0.012, B, { off: 0.012, wall: 0.01 }));
    for (const x of [0.25, -0.25]) {
      mergePart(g, lampUnit(s, B, roundRect(x, ty(0.36), 0.13, 0.04, 0.014), 'head'));
      g.light.push(conform(s, roundRect(x, ty(0.36), 0.1, 0.016, 0.008), B, { off: 0.009, rings: 1 }));
    }
    g.plastic.push(conform(s, roundRect(0, ty(0.36), 0.3, 0.09, 0.012), B, { off: 0.004, rings: 2, wall: 0.006 }));
    g.chrome.push(conformStrip(s, [[-0.12, ty(0.85)], [0.12, ty(0.85)]], 0.016, B, { off: 0.006, wall: 0.004 }));
  } else if (id === 'diffuser') {
    // a slim light blade across a dark tail panel, ending in C-shaped lamp signatures
    const ly = ty(0.7);
    const span = Math.min(0.7, T.ws * 0.82);
    // a full-width smoked lamp under one clear cover
    mergePart(g, lampUnit(s, B, roundRect(0, ly, span * 2 + 0.1, 0.11, 0.04), 'tail', { step: 0.05 }));
    g.tail.push(conformStrip(s, [[-span, ly], [span, ly]], 0.016, B, { off: 0.0095, wall: 0.005 }));
    g.housing.push(conformStrip(s, [[-span + 0.06, ly - 0.03], [span - 0.06, ly - 0.03]], 0.02, B, { off: 0.007, wall: 0.003 }));
    for (const sx of [1, -1]) {
      const c: [number, number][] = [
        [sx * (span - 0.02), ly + 0.04],
        [sx * (span + 0.03), ly + 0.035],
        [sx * (span + 0.045), ly],
        [sx * (span + 0.03), ly - 0.035],
        [sx * (span - 0.02), ly - 0.04],
      ];
      g.tail.push(conformStrip(s, c, 0.016, B, { off: 0.009, wall: 0.006 }));
    }
    // the lower tail is open: a dark mesh panel the full width, with the rain light in it
    const panel = roundRect(0, ty(0.33), span * 2 + 0.06, h * 0.36, 0.05);
    g.plastic.push(conform(s, panel, B, { off: 0.004, rings: 4, step: 0.04, wall: 0.008 }));
    meshFill(s, B, roundRect(0, ty(0.33), span * 2 + 0.02, h * 0.32, 0.04), 0.045, 0.006, g.trim, 0.009);
    g.tail.push(conform(s, roundRect(0, ty(0.33), 0.14, 0.05, 0.012), B, { off: 0.012, rings: 2, wall: 0.008 }));
    // diffuser: carbon floor rising to the tail with tall strakes
    const tailZ = s.faceZ(0, ty(0.2), -1, T.tip).z;
    const floor = new BoxGeometry(Math.min(1.18 * W, K.wellX * 2 + 0.18), 0.02, 0.62);
    place(floor, [0, 0.235 + L, tailZ + 0.22], [-0.22, 0, 0]);
    g.carbon.push(floor);
    // the outer strakes stop short of the rear tyres on short-tailed bodies
    const zMax = K.rear.z - K.rear.r - TRAVEL.up - 0.04;
    for (let i = -3; i <= 3; i++) {
      const zf = Math.abs(i) === 3 ? Math.min(tailZ + 0.42, zMax) : tailZ + 0.42;
      const zm = Math.min(tailZ + 0.3, zf - 0.05);
      g.carbon.push(plateZY([[zf, 0.245 + L], [tailZ - 0.035, 0.205 + L], [tailZ - 0.03, 0.33 + L], [tailZ + 0.12, 0.33 + L], [zm, 0.29 + L]], 0.012, i * 0.2 * W));
    }
    g.carbon.push(conformStrip(s, [[-T.ws * 0.8, ty(0.12)], [T.ws * 0.8, ty(0.12)]], 0.02, B, { off: 0.014, wall: 0.014, step: 0.05 }));
  } else {
    // tapered: a wrap-around light bar following the tail, over a black fascia, chrome strip above
    const ly = ty(0.66);
    const W = wrap(-1, T.tip + 0.95);
    const span = 1.0;
    g.tailLens.push(conformStrip(s, [[-span, ly], [span, ly]], 0.07, W, { off: 0.004, step: 0.04, wall: 0.01 }));
    g.lens.push(conformStrip(s, [[-span + 0.005, ly], [span - 0.005, ly]], 0.066, W, { off: 0.014, step: 0.04 }));
    g.tail.push(conformStrip(s, [[-span + 0.03, ly + 0.008], [span - 0.03, ly + 0.008]], 0.022, W, { off: 0.0095, wall: 0.005, step: 0.03 }));
    for (const sx of [1, -1]) {
      g.tail.push(conformStrip(s, [[sx * (span - 0.03), ly - 0.02], [sx * (span - 0.2), ly - 0.02]], 0.012, W, { off: 0.009, wall: 0.005 }));
    }
    g.chrome.push(conformStrip(s, [[-span * 0.8, ly + 0.055], [span * 0.8, ly + 0.055]], 0.01, W, { off: 0.006, wall: 0.004, step: 0.04 }));
    // bumper, plate recess, reverse lamps and a small diffuser
    g.carbon.push(conformStrip(s, [[-T.ws * 0.7, ty(0.06)], [T.ws * 0.7, ty(0.06)]], 0.03, B, { off: 0.01, wall: 0.012, step: 0.05 }));
    g.plastic.push(conform(s, roundRect(0, ty(0.42), 0.4, 0.1, 0.015), B, { off: 0.004, rings: 2, wall: 0.006 }));
    for (const x of [0.33, -0.33]) {
      mergePart(g, lampUnit(s, B, roundRect(x, ty(0.42), 0.12, 0.04, 0.014), 'head'));
      g.light.push(conform(s, roundRect(x, ty(0.42), 0.09, 0.016, 0.008), B, { off: 0.009, rings: 1 }));
    }
    for (let i = -2; i <= 2; i++) g.carbon.push(conformStrip(s, [[i * 0.14, ty(0.12)], [i * 0.14, ty(0.27)]], 0.012, B, { off: 0.014, wall: 0.008 }));
  }
  return g;
}

// ---------------------------------------------------------------- hood

export function hoodPart(id: string, shell: ShellInfo): PartGeo {
  const g = emptyPart();
  const { surface, hoodStart, hoodEnd } = shell;
  const z0 = hoodStart + 0.08;
  const z1 = Math.min(hoodEnd - 0.05, shell.K.frontJointZ + 0.3);
  const len = z1 - z0;
  if (len < 0.15) return g;
  const topAt = (x: number, z: number) => surface.topY(x, z, 0.84);
  const slope = (x: number, za: number, zb: number) => Math.atan2(topAt(x, za) - topAt(x, zb), zb - za);
  if (id === 'scoop') {
    const secs: Section[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const z = z0 + len * (0.12 + 0.62 * t);
      const y = topAt(0, z);
      const k = Math.sin(t * Math.PI) ** 0.5;
      const height = 0.015 + 0.09 * (1 - t) ** 0.7 * Math.min(1, t * 4 + 0.15);
      secs.push({ z, yb: y - 0.03, wb: 0.2 + 0.05 * k, ys: y + height * 0.45, ws: 0.22 + 0.06 * k, yt: y + height, wt: 0.16 + 0.04 * k, crisp: 0.75 });
    }
    // the scoop opens to the front: loft it backwards and only cap the tail
    g.paint.push(zoned(loft(secs.slice().reverse(), { capStart: false, capEnd: true }), ZONE.hood));
    const mouth = secs[0];
    const mouthH = mouth.yt - mouth.yb;
    const open = rbox(0.38, Math.max(0.03, mouthH * 0.55), 0.03, 0.012);
    place(open, [0, mouth.yb + mouthH * 0.62, mouth.z + 0.005], [slope(0, mouth.z, mouth.z + 0.1), 0, 0]);
    g.trim.push(open);
    for (let k = -3; k <= 3; k++) g.chrome.push(place(rbox(0.008, mouthH * 0.45, 0.02, 0.003), [k * 0.05, mouth.yb + mouthH * 0.62, mouth.z + 0.02]));
    // a pair of small louvred vents moulded into the wings behind it
    const A = above();
    const zc = z0 + len * 0.6;
    const vent = roundRect(0.42, zc, 0.15, 0.2, 0.03);
    g.plastic.push(...both(conform(surface, vent, A, { off: 0.003, rings: 3, step: 0.03 })));
    g.trim.push(...both(conformBand(surface, roundRect(0.42, zc, 0.17, 0.22, 0.04), A, { inner: vent, off: 0.005, offInner: 0.004, wall: 0.008, step: 0.03 })));
    for (let k = 0; k < 4; k++) {
      const zz = zc - 0.07 + k * 0.047;
      g.paint.push(...both(zoned(conformStrip(surface, [[0.36, zz], [0.48, zz]], 0.016, A, { off: 0.01, wall: 0.009 }), ZONE.hood)));
    }
  } else if (id === 'vented') {
    // two carbon-framed extractor vents riding on the wings either side of the valley
    const zc = z0 + len * 0.55;
    const vlen = Math.min(0.46, len * 0.75);
    const A = above();
    const vent: [number, number][] = soften(
      [
        [0.18, zc + vlen / 2],
        [0.48, zc + vlen / 2 - 0.05],
        [0.47, zc - vlen / 2],
        [0.2, zc - vlen / 2 + 0.03],
      ],
      0.18,
    );
    g.carbon.push(...both(conformBand(surface, vent, A, { shrink: 0.86, off: 0.012, offInner: 0.008, wall: 0.014, step: 0.04 })));
    g.plastic.push(...both(conform(surface, vent, A, { off: 0.004, rings: 3, step: 0.04 })));
    const n = 7;
    for (let k = 0; k < n; k++) {
      const zz = zc - vlen / 2 + 0.06 + (k * (vlen - 0.12)) / (n - 1);
      g.carbon.push(...both(conformStrip(surface, [[0.22, zz], [0.45, zz - 0.01]], 0.022, A, { off: 0.011, wall: 0.008 })));
    }
    // centre power crease
    const secs: Section[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const z = z0 + len * t;
      const k = Math.sin(t * Math.PI) ** 0.5;
      const y = topAt(0, z);
      secs.push({ z, yb: y - 0.02, wb: 0.08 * k + 0.01, ys: y + 0.002, ws: 0.1 * k + 0.01, yt: y + 0.01 + 0.008 * k, wt: 0.03 * k + 0.005, crisp: 0.9 });
    }
    g.paint.push(zoned(loft(secs, { capStart: true, capEnd: true }), ZONE.hood));
  } else if (id === 'louvred') {
    // rows of louvres stamped across the hood, in four panels either side of the centre
    const A = above();
    const zc = z0 + len * 0.5;
    const vlen = Math.min(0.6, len * 0.8);
    for (const xc of [0.17, 0.42]) {
      const panel = roundRect(xc, zc, 0.2, vlen, 0.03);
      g.plastic.push(...both(conform(surface, panel, A, { off: 0.003, rings: 3, step: 0.04 })));
      g.trim.push(...both(conformBand(surface, roundRect(xc, zc, 0.215, vlen + 0.015, 0.037), A, { inner: panel, off: 0.0045, offInner: 0.004, wall: 0.006, step: 0.04 })));
      const n = Math.max(4, Math.floor(vlen / 0.05));
      for (let k = 0; k < n; k++) {
        const zz = zc - vlen / 2 + 0.035 + (k * (vlen - 0.07)) / (n - 1);
        g.paint.push(...both(zoned(conformStrip(surface, [[xc - 0.085, zz], [xc + 0.085, zz]], 0.02, A, { off: 0.012, wall: 0.011 }), ZONE.hood)));
      }
    }
  } else if (id === 'bulge') {
    // twin power bulges, each ending in a small open nostril facing the windscreen
    for (const x of [0.26, -0.26]) {
      const secs: Section[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const z = z0 + len * (0.04 + 0.8 * t);
        const y = topAt(x, z);
        // tall at the back, melting into the hood towards the nose
        const k = Math.min(1, t * 6) * (1 - t) ** 0.6;
        const height = 0.006 + 0.055 * k;
        const w = 0.06 + 0.05 * k;
        secs.push({ z, yb: y - 0.03, wb: w * 0.9, ys: y + height * 0.4, ws: w, yt: y + height, wt: w * 0.62, crisp: 0.6 });
      }
      const bulge = loft(secs, { capStart: true, capEnd: true, ring: 14 });
      bulge.translate(x, 0, 0);
      g.paint.push(zoned(bulge, ZONE.hood));
      const tail = secs[1];
      const nost = rbox(0.11, Math.max(0.02, (tail.yt - tail.yb) * 0.5), 0.02, 0.008);
      place(nost, [x, tail.yb + (tail.yt - tail.yb) * 0.66, tail.z - 0.005], [slope(x, tail.z, tail.z + 0.1), 0, 0]);
      g.trim.push(nost);
    }
  } else {
    // smooth: the power dome is sculpted into the shell itself (see shellPart); just the washer jets here
    for (const x of [0.12, -0.12]) g.trim.push(place(rbox(0.03, 0.015, 0.03, 0.006), [x, topAt(x, z0 - 0.03) + 0.006, z0 - 0.03]));
  }
  return g;
}

// ---------------------------------------------------------------- skirts

export function skirtPart(id: string, shell: ShellInfo): PartGeo {
  const g = emptyPart();
  const s = shell.surface;
  const K = shell.K;
  const L = K.lift;
  const [za, zb] = K.skirtZ;
  if (id === 'none') return g;
  // drawn at the base car's heights, lifted with the body's floor
  const up = (pts: [number, number][]): [number, number][] => pts.map(([x, y]) => [x, y + L]);
  const sideAt = (y: number) => Math.max(s.sideX(y + L, za + 0.15, 0.72), s.sideX(y + L, (za + zb) / 2, 0.72), s.sideX(y + L, zb - 0.15, 0.72));
  const x0 = Math.min(0.56, K.wellX + 0.06);
  if (id === 'blade') {
    const x1 = sideAt(0.32) + 0.02;
    g.paint.push(...both(zoned(sillRail(up([[x0, 0.21], [x1, 0.22], [x1 + 0.01, 0.3], [x1 - 0.04, 0.36], [x0, 0.38]]), K, za, zb), ZONE.skirts)));
    // carbon blade sticking out, with a small upturned tip at the rear
    g.carbon.push(...both(railXY(up([[x0 + 0.1, 0.19], [x1 + 0.1, 0.19], [x1 + 0.11, 0.205], [x0 + 0.1, 0.212]]), za + 0.02, zb - 0.02, 0.008)));
    g.carbon.push(...both(plateZY(up([[za + 0.22, 0.2], [za + 0.04, 0.2], [za + 0.04, 0.3], [za + 0.09, 0.3]]), 0.012, x1 + 0.08)));
  } else if (id === 'wide') {
    const x1 = sideAt(0.33) + 0.08;
    g.paint.push(...both(zoned(sillRail(up([[x0, 0.19], [x1 - 0.03, 0.2], [x1, 0.26], [x1 - 0.02, 0.36], [x1 - 0.1, 0.42], [x0, 0.43]]), K, za, zb, 0.18), ZONE.skirts)));
    // intake ahead of the rear wheel
    // a recessed intake ahead of the rear wheel: dark grained opening with angled body-colour vanes
    g.plastic.push(...both(place(rbox(0.04, 0.13, 0.24, 0.02), [x1 - 0.03, 0.31 + L, za + 0.18])));
    for (let k = 0; k < 4; k++) g.paint.push(...both(zoned(place(rbox(0.036, 0.13, 0.012, 0.005), [x1 - 0.025, 0.31 + L, za + 0.09 + k * 0.06], [0, -0.45, 0]), ZONE.skirts)));
    g.trim.push(...both(railXY(up([[x0, 0.18], [x1 - 0.02, 0.18], [x1 - 0.02, 0.2], [x0, 0.2]]), za + 0.02, zb - 0.02, 0.008)));
  } else {
    const x1 = sideAt(0.3) + 0.01;
    g.paint.push(...both(zoned(sillRail(up([[x0, 0.22], [x1, 0.23], [x1 + 0.005, 0.32], [x0, 0.35]]), K, za, zb, 0.1), ZONE.skirts)));
    g.trim.push(...both(railXY(up([[x0, 0.205], [x1 - 0.01, 0.205], [x1 - 0.01, 0.225], [x0, 0.225]]), za + 0.02, zb - 0.02, 0.006)));
    if (id === 'flaps') {
      // rally mud flaps hanging behind every wheel, with a painted strip across the top
      for (const a of [K.front, K.rear]) {
        const z = a.z - a.r - TRAVEL.up - 0.05;
        const xa = a.x - a.width / 2 - 0.01;
        const xb = a.x + a.width / 2 + 0.01;
        const top = Math.min(a.r + 0.06, sectionAt(shell.fine, z).yb + 0.12);
        const flap = new BoxGeometry(xb - xa, top - 0.07, 0.012);
        place(flap, [(xa + xb) / 2, (top + 0.07) / 2, z], [-0.06, 0, 0]);
        g.trim.push(...both(flap));
        g.paint.push(...both(zoned(place(rbox(xb - xa + 0.004, 0.035, 0.016, 0.004), [(xa + xb) / 2, top - 0.05, z - 0.004], [-0.06, 0, 0]), ZONE.skirts)));
      }
    }
  }
  return g;
}

// ---------------------------------------------------------------- spoiler

function airfoil(chord: number, thick: number, width: number): BufferGeometry {
  // cambered NACA-style section: blunt rounded nose, fine trailing edge
  const t = thick / chord;
  const m = 0.06;
  const p = 0.4;
  const yt = (x: number) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4) * 0.9;
  const yc = (x: number) => (x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x));
  const n = 22;
  const xs = Array.from({ length: n + 1 }, (_, i) => (1 - Math.cos((i / n) * Math.PI)) / 2);
  const s = new Shape();
  s.moveTo(0, 0);
  for (let i = 1; i <= n; i++) s.lineTo(xs[i] * chord, (yc(xs[i]) + yt(xs[i])) * chord + 0.0015 * (xs[i] === 1 ? 1 : 0));
  for (let i = n; i >= 1; i--) s.lineTo(xs[i] * chord, (yc(xs[i]) - yt(xs[i])) * chord - 0.0015 * (xs[i] === 1 ? 1 : 0));
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: width, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.0025, bevelSegments: 3, curveSegments: 4 });
  // shape is in XY (x = chord) extruded along z: rotate so chord runs along -z and span along x
  g.translate(-chord / 2, 0, -width / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

export function spoilerPart(id: string, shell: ShellInfo): PartGeo {
  const g = emptyPart();
  const surface = shell.surface;
  const K = shell.K;
  if (id === 'none') return g;
  if (id === 'roof') return roofSpoiler(shell);
  const z = K.spoilerZ;
  // wings are drawn for the base car's track and stretched to this body's
  const W = K.rear.x / 0.85;
  const deckC = surface.topY(0, z, 0.8);
  const deckS = surface.topY(0.55 * W, z, deckC);
  const deck = Math.min(deckC, deckS);
  const stretch = () => {
    for (const list of Object.values(g)) for (const geo of list) geo.scale(W, 1, 1);
  };
  if (id === 'gt') {
    const h = deck + 0.42;
    // two-element wing: main plane plus an upper flap and a gurney strip
    g.carbon.push(place(airfoil(0.38, 0.055, 1.8), [0, h, z - 0.03], [-0.1, 0, 0]));
    g.carbon.push(place(airfoil(0.16, 0.03, 1.8), [0, h + 0.07, z - 0.24], [-0.45, 0, 0]));
    g.trim.push(place(rbox(1.8, 0.03, 0.008, 0.003), [0, h + 0.12, z - 0.31]));
    // shaped end plates
    for (const x of [0.92, -0.92]) {
      g.carbon.push(
        plateZY(
          [
            [z + 0.18, h - 0.04],
            [z - 0.3, h - 0.06],
            [z - 0.34, h + 0.12],
            [z - 0.2, h + 0.15],
            [z + 0.14, h + 0.06],
          ],
          0.014,
          x,
        ),
      );
    }
    // swan-neck uprights hooking over the wing, with base plates
    for (const x of [0.42, -0.42]) {
      const base = surface.topY(x * W, z + 0.08, deck) - 0.015;
      g.trim.push(
        plateZY(
          [
            [z + 0.14, base],
            [z + 0.02, base],
            [z - 0.02, h + 0.03],
            [z + 0.02, h + 0.1],
            [z + 0.1, h + 0.1],
            [z + 0.08, h + 0.04],
            [z + 0.03, h + 0.02],
            [z + 0.08, base + 0.12],
          ],
          0.022,
          x,
        ),
      );
      g.trim.push(place(rbox(0.07, 0.015, 0.16, 0.005), [x, base + 0.005, z + 0.08]));
    }
  } else if (id === 'mid') {
    const h = deck + 0.2;
    g.paint.push(zoned(place(airfoil(0.3, 0.045, 1.5), [0, h, z - 0.04], [-0.08, 0, 0]), ZONE.spoiler));
    g.trim.push(place(rbox(1.5, 0.018, 0.006, 0.002), [0, h + 0.02, z - 0.19]));
    for (const x of [0.76, -0.76]) {
      g.paint.push(zoned(plateZY([[z + 0.12, h - 0.03], [z - 0.2, h - 0.04], [z - 0.2, h + 0.06], [z + 0.08, h + 0.05]], 0.012, x), ZONE.spoiler));
    }
    for (const x of [0.45, -0.45]) {
      const base = surface.topY(x * W, z, deck) - 0.02;
      g.trim.push(plateZY([[z + 0.1, base], [z - 0.06, base], [z - 0.02, h + 0.005], [z + 0.06, h + 0.005]], 0.026, x));
    }
  } else {
    // ducktail lip, shaped like a short airfoil sitting on the deck
    const zz = z - 0.1;
    const y = Math.min(surface.topY(0, zz, deck), surface.topY(0.6 * W, zz, deck));
    g.paint.push(zoned(place(airfoil(0.2, 0.05, 1.32), [0, y + 0.012, zz], [-0.28, 0, 0]), ZONE.spoiler));
  }
  stretch();
  return g;
}

/** A visor wing off the back edge of the roof, with side fences running down the pillars. */
function roofSpoiler(shell: ShellInfo): PartGeo {
  const g = emptyPart();
  const f = cabinFrameOf(shell.body);
  const z = f.zRoofRear + 0.05;
  const y = f.roofAt(z) + 0.004;
  const span = f.roofW * 2 + 0.06;
  // a flat, slightly drooping blade that overhangs the rear glass
  g.paint.push(zoned(place(airfoil(0.3, 0.035, span), [0, y + 0.01, z - 0.12], [0.1, 0, 0]), ZONE.spoiler));
  g.trim.push(place(rbox(span - 0.04, 0.012, 0.006, 0.002), [0, y + 0.004, z - 0.27]));
  for (const sx of [1, -1]) {
    const x = sx * (span / 2 - 0.005);
    g.paint.push(zoned(plateZY([[z + 0.04, y + 0.01], [z - 0.28, y - 0.03], [z - 0.3, y + 0.035], [z - 0.06, y + 0.04]], 0.012, x), ZONE.spoiler));
  }
  return g;
}

// ---------------------------------------------------------------- headlights

export function headlightPart(id: string, shell: ShellInfo): PartGeo {
  const g = emptyPart();
  const s = shell.surface;
  const N = shell.nose;
  // the lamps ride high in the corners of whatever nose is fitted
  const lx = Math.min(0.62, N.ws * 0.6);
  const ly = N.bottom + (N.top - N.bottom) * 0.66;
  const hit = s.faceZ(lx, ly, 1, N.tip);
  const n = hit.normal.clone();
  // project along a blend of the local normal and straight back, so the outline lands undistorted
  const dir = n.clone().negate().multiplyScalar(0.55).add(new Vector3(0, 0, -0.45)).normalize();
  const P = planar(new Vector3(lx, ly, hit.z), dir, new Vector3(1, 0, 0), new Vector3(0, 1, 0));
  const R = (pts: [number, number][], bucket: BufferGeometry[], opts: Parameters<typeof conform>[3]) => bucket.push(...both(conform(s, pts, P, opts)));
  const S = (path: [number, number][], w: number, bucket: BufferGeometry[], opts: Parameters<typeof conformStrip>[4]) => bucket.push(...both(conformStrip(s, path, w, P, opts)));
  const U = (outline: [number, number][]) => mergePart(g, lampUnit(s, P, outline, 'head'), true);
  if (id === 'round') {
    // an almond-shaped housing with two projectors in chrome cups, and a light brow over them
    const house = soften(
      [
        [-0.2, -0.05],
        [0.12, -0.065],
        [0.215, 0.0],
        [0.18, 0.062],
        [-0.17, 0.05],
      ],
      0.35,
    );
    U(house);
    g.chrome.push(...both(conformBand(s, house, P, { shrink: 1.07, off: 0.01, offInner: 0.008, wall: 0.01, step: 0.02 })));
    for (const dx of [-0.085, 0.085]) {
      R(ellipse(dx, -0.002, 0.05, 0.046, 22), g.chrome, { off: 0.007, rings: 2 });
      R(ellipse(dx, -0.002, 0.03, 0.028, 18), g.light, { off: 0.011, wall: 0.004, rings: 2 });
      g.chrome.push(...both(conformBand(s, ellipse(dx, -0.002, 0.052, 0.048, 22), P, { shrink: 0.88, off: 0.013, offInner: 0.01 })));
    }
    S([[-0.17, 0.038], [0.0, 0.048], [0.17, 0.045]], 0.01, g.light, { off: 0.011, wall: 0.005 });
  } else if (id === 'slit') {
    // an angular slit with a hooked daytime-light signature
    const house: [number, number][] = [
      [-0.22, 0.0],
      [-0.18, 0.04],
      [0.18, 0.075],
      [0.235, 0.05],
      [0.2, -0.0],
      [0.02, -0.03],
      [-0.12, -0.032],
    ];
    U(soften(house, 0.15));
    S([[-0.17, 0.028], [0.17, 0.062], [0.215, 0.045]], 0.012, g.light, { off: 0.011, wall: 0.005 });
    S([[0.19, 0.03], [0.1, -0.005], [-0.02, -0.012]], 0.009, g.light, { off: 0.011, wall: 0.005 });
    for (const dx of [-0.11, -0.04, 0.03]) R(ellipse(dx, 0.008 + dx * 0.1, 0.018, 0.016, 14), g.light, { off: 0.009, rings: 1 });
    R(roundRect(0.0, 0.012, 0.26, 0.022, 0.01, 0.12), g.chrome, { off: 0.007, rings: 1 });
    // projector lens behind the hook
    R(ellipse(0.13, 0.03, 0.03, 0.026, 18), g.chrome, { off: 0.007, rings: 2 });
    R(ellipse(0.13, 0.03, 0.019, 0.017, 16), g.glass, { off: 0.01, rings: 2, dome: 0.004 });
  } else if (id === 'matrix') {
    // a squared-off housing holding two rows of matrix LED cubes, wrapped by an L-shaped light guide
    const house = roundRect(0, 0, 0.42, 0.11, 0.022, 0.08);
    U(house);
    g.chrome.push(...both(conformBand(s, roundRect(0, 0, 0.37, 0.075, 0.014, 0.08), P, { shrink: 0.9, off: 0.009, offInner: 0.008, step: 0.02 })));
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 4; k++) {
        const a = -0.105 + k * 0.07 + (r ? 0.004 : 0);
        R(roundRect(a, r ? -0.016 : 0.018, 0.046, 0.032, 0.006), g.trim, { off: 0.0075, wall: 0.003, rings: 1 });
        R(roundRect(a, r ? -0.016 : 0.018, 0.034, 0.022, 0.005), g.light, { off: 0.0105, wall: 0.003, rings: 1, dome: 0.002 });
      }
    }
    S([[-0.19, 0.052], [0.2, 0.06], [0.215, 0.0], [0.205, -0.045]], 0.012, g.light, { off: 0.012, wall: 0.005 });
  } else if (id === 'popup') {
    // pop-up lamps: two flush lids on top of the nose with dark shut lines, and a slim indicator strip in the face
    const A = above();
    const zc = N.tip - 0.3 * shell.K.noseScale;
    const lid = roundRect(lx, zc, 0.3, 0.19, 0.03);
    g.trim.push(...both(conformBand(s, roundRect(lx, zc, 0.316, 0.206, 0.034), A, { inner: lid, off: 0.003, offInner: 0.003 })));
    g.paint.push(...both(zoned(conform(s, lid, A, { off: 0.0045, rings: 3, step: 0.03 }), ZONE.front)));
    g.trim.push(...both(conformStrip(s, [[lx - 0.12, zc + 0.08], [lx + 0.12, zc + 0.08]], 0.006, A, { off: 0.006 })));
    U(roundRect(0, -0.01, 0.3, 0.032, 0.014, 0.1));
    S([[-0.13, -0.008], [0.13, -0.004]], 0.01, g.light, { off: 0.0095, wall: 0.004 });
  } else {
    // LED bar: a slim swept blade with a lit top edge and four LED elements under it
    const house = roundRect(0, 0, 0.46, 0.075, 0.034, 0.12);
    U(house);
    S([[-0.2, 0.019], [0.21, 0.023]], 0.012, g.light, { off: 0.011, wall: 0.005 });
    R(roundRect(0.0, -0.012, 0.38, 0.026, 0.012, 0.12), g.chrome, { off: 0.007, rings: 1 });
    for (let k = 0; k < 4; k++) R(ellipse(-0.13 + k * 0.075, -0.012, 0.014, 0.011, 12), g.light, { off: 0.011, rings: 1 });
  }
  return g;
}

// ---------------------------------------------------------------- exhaust

export interface ExhaustInfo {
  geo: PartGeo;
  /** tip positions (car space) where boost flames come out */
  tips: Vector3[];
}

/** A trapezoid tailpipe: a polished open frame `len` deep along z, its face at z = 0, with a dark inside. */
function trapTip(w: number, h: number, len: number): { outer: BufferGeometry; inner: BufferGeometry } {
  const outline = (k: number, inset: number) => {
    const sh = new Shape();
    const tw = (w * k) / 2 - inset;
    const bw = (w * k) / 2 - inset - h * 0.18;
    const hh = (h * k) / 2 - inset;
    sh.moveTo(-bw, -hh);
    sh.lineTo(bw, -hh);
    sh.lineTo(tw, hh);
    sh.lineTo(-tw, hh);
    sh.closePath();
    return sh;
  };
  const ring = outline(1, 0);
  ring.holes.push(outline(1, 0.012));
  const outer = new ExtrudeGeometry(ring, { depth: len, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.004, bevelSegments: 1, curveSegments: 2 });
  outer.translate(0, 0, -len);
  const inner = new ExtrudeGeometry(outline(1, 0.012), { depth: 0.01, bevelEnabled: false });
  inner.translate(0, 0, -0.06);
  return { outer, inner };
}

export function exhaustPart(id: string, shell: ShellInfo): ExhaustInfo {
  const g = emptyPart();
  const rear = shell.surface;
  const K = shell.K;
  const fallbackZ = shell.tail.tip + 0.05;
  // pipes exit through the tail face, however high the tail's bottom edge sits
  const y = Math.max(K.exhaustY, shell.tail.bottom + 0.1);
  const tips: Vector3[] = [];
  if (id === 'trap') {
    // two wide trapezoid tips set into the bumper, either side of a dark diffuser recess
    for (const x of [0.42, -0.42]) {
      const z = rear.faceZ(x, y - 0.06, -1, fallbackZ).z;
      const { outer, inner } = trapTip(0.24, 0.085, 0.2);
      place(outer, [x, y - 0.06, z - 0.03], [0, Math.PI, 0]);
      place(inner, [x, y - 0.06, z - 0.03], [0, Math.PI, 0]);
      g.chrome.push(outer);
      g.trim.push(inner);
      tips.push(new Vector3(x - 0.05, y - 0.06, z - 0.05), new Vector3(x + 0.05, y - 0.06, z - 0.05));
    }
  } else {
    const spots: [number, number][] =
      id === 'quad'
        ? [[0.4, 0], [0.56, 0], [-0.4, 0], [-0.56, 0]]
        : id === 'center'
          ? [[-0.09, 0], [0.09, 0]]
          : id === 'hex'
            ? [[-0.09, 0.04], [0, 0.04], [0.09, 0.04], [-0.09, -0.04], [0, -0.04], [0.09, -0.04]]
            : [[0.5, 0], [-0.5, 0]];
    const r = id === 'center' ? 0.075 : id === 'quad' ? 0.042 : id === 'hex' ? 0.036 : 0.055;
    for (const [x, dy] of spots) {
      const py = y - 0.06 + dy;
      const z = rear.faceZ(x, py + 0.03, -1, fallbackZ).z;
      const len = 0.24;
      const cz = z + len / 2 - 0.08;
      // double-walled tip: polished outer, darker inner pipe, sooty core
      const pipe = cyl(r, len, 22, true, r * 0.92);
      place(pipe, [x, py, cz], [Math.PI / 2, 0, 0]);
      g.chrome.push(pipe);
      const innerPipe = cyl(r * 0.72, len, 18, true);
      place(innerPipe, [x, py, cz + 0.01], [Math.PI / 2, 0, 0]);
      g.carbon.push(innerPipe);
      const core = new CircleGeometry(r * 0.72, 16);
      place(core, [x, py, z - 0.03], [0, Math.PI, 0]);
      g.trim.push(core);
      const lip = new TorusGeometry(r, 0.011, 6, 22);
      place(lip, [x, py, z - 0.08]);
      g.chrome.push(lip);
      const lip2 = new TorusGeometry(r * 0.73, 0.006, 4, 18);
      place(lip2, [x, py, z - 0.075]);
      g.chrome.push(lip2);
      tips.push(new Vector3(x, py, z - 0.08));
    }
  }
  // every group of tips exits through its own cut-out moulded into whatever bumper is fitted:
  // a dark recess with a satin lip, so the pipes sit in the tail instead of in front of it
  const B = face(-1);
  const groups = new Map<number, Vector3[]>();
  for (const t of tips) {
    const key = Math.abs(t.x) < 0.2 ? 0 : Math.sign(t.x);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const pad = id === 'trap' ? 0.04 : id === 'center' ? 0.1 : id === 'hex' ? 0.07 : id === 'quad' ? 0.075 : 0.088;
  const padY = id === 'trap' ? 0.062 : pad;
  for (const list of groups.values()) {
    const xs = list.map((t) => t.x);
    const ys = list.map((t) => t.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    // a low tip pokes out under the bumper: the cut-out then stops at the tail's lower edge, a notch
    const yTop = Math.max(...ys) + padY;
    const yBot = Math.max(Math.min(...ys) - padY, shell.tail.bottom + 0.014);
    const cy = (yTop + yBot) / 2;
    const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
    const hh = yTop - yBot;
    const hole = roundRect(cx, cy, w, hh, Math.min(hh, w) * 0.42);
    g.plastic.push(conform(rear, hole, B, { off: 0.02, rings: 2, wall: 0.026, step: 0.03 }));
    g.trim.push(conformBand(rear, roundRect(cx, cy, w + 0.03, hh + 0.03, Math.min(hh, w) * 0.42 + 0.015), B, { inner: hole, off: 0.022, offInner: 0.021, wall: 0.026, step: 0.03 }));
  }
  // silencer box tucked under the tail
  const zs = rear.faceZ(0, y, -1, fallbackZ).z;
  const xMax = Math.max(...tips.map((t) => Math.abs(t.x)));
  // tucked up under the tail, so a high tail doesn't show it hanging below
  g.trim.push(place(rbox(Math.min(1.1, xMax * 2 + 0.2), 0.1, 0.26, 0.04), [0, Math.max(0.27 + K.lift, shell.tail.bottom - 0.06), zs + 0.22]));
  return { geo: g, tips };
}

/** Flame cone, pointing backwards (-z) from the origin. */
export function flameGeometry(): BufferGeometry {
  const c = new ConeGeometry(0.06, 0.6, 10, 1, true);
  c.translate(0, -0.3, 0);
  c.rotateX(Math.PI / 2);
  c.rotateX(Math.PI);
  return c;
}

// ---------------------------------------------------------------- wheels

/** Rim radius and width the rim designs are drawn at; each car scales them to its own wheels. */
export const RIM_R = 0.262;
export const RIM_W = 0.28;

/** Tyre of radius R on a rim of radius `rim`, W wide. Deep grooves for the tall rally tyres. */
/**
 * The tyre: a lathe of a moulded profile (bead, bulging sidewall with a rim
 * protector, rounded shoulders, a flat crown). Its UVs run around the tyre (u)
 * and across the profile (v): 0-0.36 is the outer sidewall (+x, rim to
 * shoulder), 0.36-0.64 the tread and 0.64-1 the inner sidewall, which is how
 * the tyre material lays out its tread blocks and sidewall lettering.
 */
export function tireGeometry(R = 0.34, rim = RIM_R, W = RIM_W): BufferGeometry {
  const hw = W / 2 - 0.01;
  const wall = R - rim;
  // profile in (radius, axial); axial -hw ends up on the outer (+x) face after the rotation below
  const pts: Vector2[] = [];
  const vs: number[] = [];
  const add = (r: number, ax: number, v: number) => {
    pts.push(new Vector2(r, ax));
    vs.push(v);
  };
  const sidewall = (sgn: number, v0: number, v1: number, outer: boolean) => {
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = outer ? i / n : 1 - i / n;
      const r = rim + 0.012 + (wall - 0.05) * t;
      // the sidewall bulges out past the rim flange, most at about 40 % of its height
      const bulge = Math.sin(Math.min(1, t * 1.25) * Math.PI) * 0.016 + (t < 0.12 ? 0.006 : 0);
      add(r, sgn * (hw + bulge), v0 + (v1 - v0) * (outer ? i / n : 1 - i / n));
    }
  };
  const shoulder = (sgn: number, v0: number, v1: number, outer: boolean) => {
    const n = 5;
    for (let i = 1; i <= n; i++) {
      const k = outer ? i / n : 1 - (i - 1) / n;
      const a = (k * Math.PI) / 2;
      add(R - 0.038 + Math.sin(a) * 0.038, sgn * (hw - 0.034 + Math.cos(a) * 0.034), v0 + (v1 - v0) * k);
    }
  };
  // outer bead, outer sidewall, shoulder
  add(rim - 0.004, -(hw - 0.014), 0);
  sidewall(-1, 0.0, 0.31, true);
  shoulder(-1, 0.31, 0.36, true);
  // crown: flat, a whisker of crown radius
  const crown = 8;
  for (let i = 1; i < crown; i++) {
    const t = i / crown;
    const ax = -hw + 0.034 + (2 * hw - 0.068) * t;
    add(R - 0.002 * (2 * t - 1) ** 2, ax, 0.36 + 0.28 * t);
  }
  shoulder(1, 0.64, 0.69, false);
  sidewall(1, 0.69, 1.0, false);
  add(rim - 0.004, hw - 0.014, 1);
  const seg = 64;
  const g = new LatheGeometry(pts, seg);
  const uv = g.getAttribute('uv');
  for (let i = 0; i <= seg; i++) for (let j = 0; j < pts.length; j++) uv.setY(i * pts.length + j, vs[j]);
  g.rotateZ(Math.PI / 2); // axis along x
  return g;
}

interface SpokeSpec {
  /** radius at the hub end and at the lip end */
  r0: number;
  r1: number;
  /** angle round the wheel at the hub end */
  a: number;
  /** extra angle gained by the lip end (curved, directional spokes) */
  sweep?: number;
  /** width across the spoke at hub and lip */
  w0: number;
  w1: number;
  /** depth along the axle at hub and lip */
  d0: number;
  d1: number;
  /** x of the spoke's face at hub and lip (the face dishes back towards the lip, or out on a concave wheel) */
  x0: number;
  x1: number;
  /** extra dish at mid-span */
  bow?: number;
  /** how much of the face is chamfered off (0 = square, 0.45 = a ridge) */
  chamfer?: number;
  /** rotate the cross-section round the spoke's length (turbine blades) */
  twist?: number;
}

/**
 * One wheel spoke: a chamfered cross-section lofted from hub to lip, tapering,
 * dishing and optionally sweeping round, with smooth normals along its length
 * so it catches light like a machined part instead of a box.
 */
function spoke(o: SpokeSpec): BufferGeometry {
  const ch = o.chamfer ?? 0.28;
  // cross-section in (x = along the axle, outward positive; y = across), unit size
  const sec: [number, number][] = [
    [-1, -0.5],
    [-1, 0.5],
    [-ch * 0.6, 0.5],
    [0, 0.5 - ch],
    [0, -0.5 + ch],
    [-ch * 0.6, -0.5],
  ];
  const n = 10;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = o.r0 + (o.r1 - o.r0) * t;
    const ang = o.a + (o.sweep ?? 0) * t * t;
    const w = o.w0 + (o.w1 - o.w0) * t;
    const d = o.d0 + (o.d1 - o.d0) * t;
    const xf = o.x0 + (o.x1 - o.x0) * t - (o.bow ?? 0) * Math.sin(t * Math.PI);
    const tw = (o.twist ?? 0) * (0.3 + 0.7 * t);
    // radial and tangential directions at this station (wheel plane is YZ)
    const ry = Math.cos(ang);
    const rz = Math.sin(ang);
    const ty = -rz;
    const tz = ry;
    for (const [sx, sy] of sec) {
      const lx = sx * d;
      const ly = sy * w;
      const ax = lx * Math.cos(tw) - ly * Math.sin(tw);
      const ay = lx * Math.sin(tw) + ly * Math.cos(tw);
      pos.push(xf + ax, r * ry + ty * ay, r * rz + tz * ay);
    }
  }
  const m = sec.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const a0 = i * m + j;
      const a1 = i * m + ((j + 1) % m);
      const b0 = a0 + m;
      const b1 = a1 + m;
      idx.push(a0, b0, b1, a0, b1, a1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure the faces point out of the spoke
  // (vertex 3 is on the outer face at the hub end, which looks out along +x)
  const nrm = g.getAttribute('normal');
  if (nrm.getX(3) < 0) {
    idx.reverse();
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/**
 * Rim geometry; the outer face points to +x (the left wheels are turned round,
 * not mirrored). `main` takes the rim colour, `accent` is dark satin, `polish`
 * is chrome: the machined lip and the lug nuts.
 */
export function rimGeometry(id: string): { main: BufferGeometry[]; accent: BufferGeometry[]; polish: BufferGeometry[] } {
  const main: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const polish: BufferGeometry[] = [];
  const R = RIM_R;
  const face = 0.1;
  // stepped barrel, painted inside, ending in the flange
  const barrel = new LatheGeometry(
    [
      new Vector2(R - 0.01, -0.12),
      new Vector2(R - 0.02, -0.06),
      new Vector2(R - 0.035, 0.0),
      new Vector2(R - 0.02, 0.06),
      new Vector2(R - 0.012, face - 0.005),
      new Vector2(R - 0.004, face + 0.002),
    ],
    48,
  );
  barrel.rotateZ(-Math.PI / 2);
  main.push(barrel);
  // the machined outer lip: a polished rolled edge
  const lip = new LatheGeometry(
    [new Vector2(R - 0.004, face + 0.002), new Vector2(R + 0.006, face + 0.006), new Vector2(R + 0.007, face + 0.013), new Vector2(R + 0.001, face + 0.018), new Vector2(R - 0.012, face + 0.015)],
    48,
  );
  lip.rotateZ(-Math.PI / 2);
  polish.push(lip);
  // dark inner face so the spokes stand out against depth
  const inner = new CircleGeometry(R - 0.02, 32);
  inner.rotateY(Math.PI / 2);
  inner.translate(face - 0.06, 0, 0);
  accent.push(inner);
  // hub with five chrome lug nuts and a centre cap (sunk deep on the dish rim)
  const sink = id === 'dish' ? -0.05 : 0;
  const hubFace = face - 0.005 + sink;
  const hub = new LatheGeometry([new Vector2(0.001, 0.03), new Vector2(0.062, 0.028), new Vector2(0.074, 0.012), new Vector2(0.08, -0.03)], 32);
  hub.rotateZ(-Math.PI / 2);
  hub.translate(hubFace, 0, 0);
  main.push(hub);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 10;
    const nut = new LatheGeometry([new Vector2(0.001, 0.016), new Vector2(0.007, 0.015), new Vector2(0.0105, 0.008), new Vector2(0.0105, -0.012)], 6);
    nut.rotateZ(-Math.PI / 2);
    nut.translate(hubFace + 0.03, Math.cos(a) * 0.046, Math.sin(a) * 0.046);
    polish.push(nut);
    const seat = cyl(0.014, 0.006, 12).rotateZ(Math.PI / 2);
    seat.translate(hubFace + 0.027, Math.cos(a) * 0.046, Math.sin(a) * 0.046);
    accent.push(seat);
  }
  // centre cap: a domed badge in a chrome ring
  const cap = new LatheGeometry([new Vector2(0.001, 0.008), new Vector2(0.016, 0.006), new Vector2(0.024, 0.0), new Vector2(0.025, -0.008)], 20);
  cap.rotateZ(-Math.PI / 2);
  cap.translate(hubFace + 0.036, 0, 0);
  accent.push(cap);
  const capRing = new TorusGeometry(0.026, 0.0035, 6, 24).rotateY(Math.PI / 2);
  capRing.translate(hubFace + 0.034, 0, 0);
  polish.push(capRing);
  const S = (o: SpokeSpec) => main.push(spoke(o));
  const r1 = R - 0.006;
  if (id === 'dish') {
    // deep dish: a wide polished step-lip falling to eight slim spokes set far back
    const dishLip = new LatheGeometry(
      [new Vector2(R - 0.012, face + 0.015), new Vector2(R - 0.02, face + 0.008), new Vector2(R - 0.05, face - 0.04), new Vector2(R - 0.058, face - 0.054)],
      48,
    );
    dishLip.rotateZ(-Math.PI / 2);
    polish.push(dishLip);
    for (let i = 0; i < 8; i++) S({ r0: 0.06, r1: R - 0.05, a: (i / 8) * Math.PI * 2, w0: 0.024, w1: 0.016, d0: 0.026, d1: 0.02, x0: hubFace + 0.022, x1: face - 0.05, chamfer: 0.35 });
  } else if (id === 'rally') {
    // six broad flat spokes into a flat outer ring: a tough gravel wheel
    const ring = new LatheGeometry([new Vector2(R - 0.012, face + 0.006), new Vector2(R - 0.05, face + 0.004), new Vector2(R - 0.054, face - 0.02)], 48);
    ring.rotateZ(-Math.PI / 2);
    main.push(ring);
    for (let i = 0; i < 6; i++) S({ r0: 0.06, r1: R - 0.045, a: (i / 6) * Math.PI * 2, w0: 0.075, w1: 0.042, d0: 0.03, d1: 0.026, x0: face + 0.012, x1: face + 0.004, chamfer: 0.12 });
  } else if (id === 'blade') {
    // ten curved directional blades sweeping from the hub to the lip
    for (let i = 0; i < 10; i++) S({ r0: 0.062, r1, a: (i / 10) * Math.PI * 2, sweep: 0.62, w0: 0.03, w1: 0.016, d0: 0.03, d1: 0.022, x0: face + 0.02, x1: face - 0.018, bow: 0.01, chamfer: 0.4 });
  } else if (id === 'mesh') {
    // twelve pairs of thin crossing spokes over an inner ring, BBS style
    for (let i = 0; i < 12; i++) {
      for (const sg of [1, -1]) {
        S({ r0: 0.07, r1, a: (i / 12) * Math.PI * 2 - sg * 0.22, sweep: sg * 0.44, w0: 0.013, w1: 0.011, d0: 0.016, d1: 0.014, x0: face + 0.006 + (sg > 0 ? 0.004 : 0), x1: face - 0.002 + (sg > 0 ? 0.004 : 0), chamfer: 0.35 });
      }
    }
    const ring = new TorusGeometry(0.172, 0.007, 6, 48).rotateY(Math.PI / 2);
    ring.translate(face + 0.006, 0, 0);
    polish.push(ring);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const bolt = cyl(0.004, 0.006, 6).rotateZ(Math.PI / 2);
      bolt.translate(face + 0.012, Math.cos(a) * (R - 0.012), Math.sin(a) * (R - 0.012));
      polish.push(bolt);
    }
  } else if (id === 'turbine') {
    // a closed aero disc with fourteen twisted turbine vanes standing off it
    const disc = new LatheGeometry([new Vector2(0.075, face - 0.01), new Vector2(0.15, face - 0.026), new Vector2(R - 0.012, face - 0.02)], 48);
    disc.rotateZ(-Math.PI / 2);
    accent.push(disc);
    for (let i = 0; i < 14; i++) S({ r0: 0.07, r1, a: (i / 14) * Math.PI * 2, sweep: 0.3, w0: 0.012, w1: 0.03, d0: 0.03, d1: 0.026, x0: face + 0.008, x1: face, twist: 0.65, chamfer: 0.2 });
  } else {
    // five split spokes, tapered and dished, with a ridge down each
    for (let i = 0; i < 5; i++) {
      for (const sg of [-1, 1]) {
        S({ r0: 0.064, r1, a: (i / 5) * Math.PI * 2 + sg * 0.1, sweep: sg * 0.08, w0: 0.032, w1: 0.022, d0: 0.034, d1: 0.024, x0: face + 0.022, x1: face - 0.016, bow: 0.006, chamfer: 0.42 });
      }
    }
  }
  return { main, accent, polish };
}

export function brakeGeometry(): { disc: BufferGeometry; holes: BufferGeometry; caliper: BufferGeometry } {
  const disc = cyl(0.19, 0.03, 30).rotateZ(Math.PI / 2);
  disc.translate(0.02, 0, 0);
  // cross-drilled holes and a dark hat in the middle
  const holeList: BufferGeometry[] = [];
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + ring * 0.17;
      const r = 0.12 + ring * 0.04;
      const h = new CircleGeometry(0.008, 6).rotateY(Math.PI / 2);
      h.translate(0.0365, Math.cos(a) * r, Math.sin(a) * r);
      holeList.push(h);
    }
  }
  const hat = cyl(0.09, 0.04, 20).rotateZ(Math.PI / 2);
  hat.translate(0.03, 0, 0);
  holeList.push(hat);
  // caliper: a curved block hugging the disc
  const shape = new Shape();
  const r0 = 0.12;
  const r1 = 0.2;
  const a0 = 0.35;
  const a1 = 1.25;
  shape.absarc(0, 0, r1, a0, a1, false);
  shape.absarc(0, 0, r0, a1, a0, true);
  shape.closePath();
  const caliper = new ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 8 });
  // shape is in the XY plane: turn so it lies in the wheel's YZ plane, outer face towards +x
  caliper.rotateY(Math.PI / 2);
  caliper.translate(0.005, 0, 0);
  return { disc, holes: mergeList(holeList), caliper };
}

function mergeList(list: BufferGeometry[]): BufferGeometry {
  // tiny local merge (positions + normals) to keep the brake hardware one geometry
  let count = 0;
  for (const g of list) count += g.index ? g.index.count : g.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  let o = 0;
  for (const g of list) {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.getAttribute('normal')) ng.computeVertexNormals();
    pos.set(ng.getAttribute('position').array as Float32Array, o * 3);
    nrm.set(ng.getAttribute('normal').array as Float32Array, o * 3);
    o += ng.getAttribute('position').count;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nrm, 3));
  return out;
}

// ---------------------------------------------------------------- cabin frame (for the interior)

/** Where the cabin's glass and roof are, so the interior can be fitted inside any body. Car space. */
export interface CabinFrame {
  /** windscreen base (cowl) */
  zCowl: number;
  /** windscreen top, where the solid roof starts */
  zRoofFront: number;
  /** rear glass top, where the solid roof ends */
  zRoofRear: number;
  /** the back of the glasshouse */
  zBack: number;
  /** B-pillar */
  zB: number;
  roofY: number;
  beltY: number;
  /** glass half width at the belt line and at the roof edge */
  halfW: number;
  roofW: number;
  roofAt(z: number): number;
  /** cabin floor height */
  floorY: number;
}

export function cabinFrame(bodyId: string): CabinFrame {
  return cabinFrameOf(bodySections(bodyId));
}

function cabinFrameOf(body: BodyInfo): CabinFrame {
  const keys = body.cabin;
  // same glasshouse as cabinPart: the belt sits just above the body's skin (the cabin
  // only spans the body's own sections, so the nose and tail don't matter here)
  const hull = refine([body.rearJoint, ...body.hull, body.frontJoint], (len) => len / 0.032);
  const belts = keys.map((k) => skinY(sectionAt(hull, k.z), k.beltW) + 0.03);
  const secs: Section[] = keys
    .map((k, i) => ({ z: k.z, yb: belts[i] - 0.06, wb: k.beltW - 0.05, ys: belts[i], ws: k.beltW, yt: Math.max(k.roof, belts[i] + 0.01), wt: k.roofW, crisp: body.cabinCrisp }))
    .reverse();
  const fine = refine(secs, 8);
  const zFront = keys[0].z;
  const zBack = keys[keys.length - 1].z;
  const roofMax = Math.max(...keys.map((k) => k.roof));
  const roofAt = (z: number) => sectionAt(fine, Math.max(zBack, Math.min(zFront, z))).yt;
  let zWs = zFront;
  for (let z = zFront; z > zBack; z -= 0.01) {
    if (roofAt(z) > roofMax - 0.05) {
      zWs = z;
      break;
    }
  }
  let zRg = zBack;
  for (let z = zBack; z < zFront; z += 0.01) {
    if (roofAt(z) > roofMax - 0.05) {
      zRg = z;
      break;
    }
  }
  return {
    zCowl: zFront,
    zRoofFront: zWs,
    zRoofRear: zRg,
    zBack,
    zB: bPillarZ(body),
    roofY: roofMax,
    beltY: belts[1],
    halfW: Math.min(...keys.slice(0, 4).map((k) => k.beltW)),
    roofW: Math.min(...keys.slice(1, 4).map((k) => k.roofW)),
    roofAt,
    floorY: 0.3 + body.skeleton.lift,
  };
}
