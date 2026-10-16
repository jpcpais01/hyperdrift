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
import { SKELETON } from './skeleton';
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
}

export const emptyPart = (): PartGeo => ({ paint: [], trim: [], carbon: [], chrome: [], glass: [], light: [], tail: [] });

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

// ---------------------------------------------------------------- the shell

/** Wheel arch radius: tyre radius plus the drawn suspension travel plus a small gap. */
export const ARCH_RADIUS = 0.405;
/** x of the wheel-well wall (inside the tyre's inner face even at full lock). */
const WELL_X = 0.5;
const AXLES = [SKELETON.frontAxleZ, SKELETON.rearAxleZ];
/** vertices this close inside the arch are snapped onto its edge */
const EDGE_BAND = 0.05;

/** Fender flare added to the shell's half width at (y, z): wide haunches over the wheels, a waist between them. */
function flare(sc: BodySculpt, ax: number, y: number, z: number): number {
  let out = 0;
  for (const az of AXLES) {
    const front = az > 0;
    // the rear haunch swells forward into the doors, the front wing trails back into them
    const reach = front ? (z < az ? 0.95 : 0.72) : z > az ? 1.15 : 0.55;
    const u = (z - az) / reach;
    if (Math.abs(u) >= 1) continue;
    const k = (1 - u * u) ** 2;
    const wy = smooth(0.2, 0.46, y) * (1 - smooth(0.8, 0.97, y));
    out += (front ? sc.flareF : sc.flareR) * k * wy * smooth(0.45, 0.8, ax);
  }
  return out;
}

/** Sculpted scallop along the doors (rising towards the tail) and, on some bodies, a deep intake scoop. */
function scallop(sc: BodySculpt, ax: number, y: number, z: number): number {
  const along = smooth(-1.0, -0.5, z) * (1 - smooth(0.55, 0.95, z));
  const yl = sc.crease ? sc.crease.yF + (sc.crease.yR - sc.crease.yF) * smooth(1.0, -1.0, z) - 0.17 : 0.46;
  let d = (0.016 + (sc.crease?.amount ?? 0)) * along * Math.exp(-(((y - yl) / 0.06) ** 2));
  const it = sc.intake;
  if (it) {
    const zc = (it.z0 + it.z1) / 2;
    const yc = (it.y0 + it.y1) / 2;
    const u = (z - zc) / ((it.z1 - it.z0) / 2);
    // teardrop: deepest at the back, where it feeds the engine
    const v = (y - yc - 0.06 * u) / ((it.y1 - it.y0) / 2) / (0.75 + 0.25 * (1 - u));
    const r = Math.hypot(u, v);
    d += it.depth * (1 - smooth(0.55, 1.0, r)) * (0.45 + 0.55 * smooth(1, -0.6, u));
  }
  return d * smooth(0.6, 0.85, ax);
}

/** Nearest axle's distance and direction in the (y, z) plane. */
function archPolar(y: number, z: number): { r: number; az: number } {
  let best = { r: Infinity, az: 0 };
  for (const az of AXLES) {
    const r = Math.hypot(y - SKELETON.wheelY, z - az);
    if (r < best.r) best = { r, az };
  }
  return best;
}

/** Half width of the finished shell surface at (y, z), computed from the sections. */
function outerHalfWidth(fine: Section[], sc: BodySculpt, y: number, z: number): number {
  const curve = profileCurve(sectionAt(fine, z));
  let prev = curve.getPoint(0);
  for (let i = 1; i <= 48; i++) {
    const p = curve.getPoint(i / 48);
    if (p.y >= y) {
      const t = Math.min(1, Math.max(0, (y - prev.y) / Math.max(1e-5, p.y - prev.y)));
      const ax = prev.x + (p.x - prev.x) * t;
      return ax + flare(sc, ax, y, z) - scallop(sc, ax, y, z);
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
function sculpt(g: BufferGeometry, sc: BodySculpt, cut = true): Float32Array {
  const pos = g.getAttribute('position') as BufferAttribute;
  const zone = new Float32Array(pos.count).fill(ZONE.auto);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const sx = x < 0 ? -1 : 1;
    let ax = Math.abs(x);
    ax += flare(sc, ax, y, z) - scallop(sc, ax, y, z);
    const { r, az } = archPolar(y, z);
    if (cut && ax > WELL_X && r < ARCH_RADIUS) {
      if (r > ARCH_RADIUS - EDGE_BAND && y > SKELETON.wheelY - 0.2) {
        // the vertices nearest the cut are pulled onto the arch circle, so the opening is a clean round edge
        const k = ARCH_RADIUS / Math.max(1e-4, r);
        const ny = SKELETON.wheelY + (y - SKELETON.wheelY) * k;
        const nz = az + (z - az) * k;
        pos.setY(i, ny);
        pos.setZ(i, nz);
      } else {
        ax = WELL_X;
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
  hoodStart: number;
  /** z where the hood's top surface ends at the nose */
  hoodEnd: number;
  /** smooth sections of the whole shell */
  fine: Section[];
  nose: EndInfo;
  tail: EndInfo;
  /** paint shader layout: door shut lines and the fuel filler */
  doors: { front: number; rear: number };
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
 * into it at the skeleton's axles.
 */
export function shellPart(bodyId: string, frontId: string, rearId: string, dome = false): ShellInfo {
  const body = bodySections(bodyId);
  const keys = [...rearSections(rearId, body.rearJoint), ...body.hull, ...frontSections(frontId, body.frontJoint)];
  const fine = refine(keys, (len) => len / 0.032);
  const sc = body.sculpt;
  const g = loft(fine, { capStart: true, capEnd: true, ring: 46 });
  if (dome) powerDome(g, body.cabin[0].z + 0.1, frontSections(frontId, body.frontJoint).at(-1)!.z - 0.4);
  const uncut = g.clone();
  g.setAttribute('zone', new BufferAttribute(sculpt(g, sc), 1));
  g.computeVertexNormals();
  // the arch cut folds triangles around the opening; take the skin's normals
  // from an uncut copy so the paint around every arch shades smoothly
  sculpt(uncut, sc, false);
  uncut.computeVertexNormals();
  {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const un = uncut.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getX(i)) > WELL_X + 1e-4) n.setXYZ(i, un.getX(i), un.getY(i), un.getZ(i));
    }
    n.needsUpdate = true;
    uncut.dispose();
  }
  const geo = emptyPart();
  geo.paint.push(g);

  // arch lips: a rolled edge that follows the fender around each opening, and
  // a dark liner from the lip back to the well wall that hides the cut
  for (const az of AXLES) {
    const pts: Vector3[] = [];
    const liner: number[] = [];
    const lIdx: number[] = [];
    const M = 40;
    for (let i = 0; i <= M; i++) {
      const a = -0.2 + (i / M) * (Math.PI + 0.4);
      const y = SKELETON.wheelY + Math.sin(a) * (ARCH_RADIUS + 0.008);
      const z = az + Math.cos(a) * (ARCH_RADIUS + 0.008);
      if (y < sectionAt(fine, z).yb + 0.015) continue;
      const ox = outerHalfWidth(fine, sc, y, z);
      pts.push(new Vector3(ox - 0.014, y, z));
      const ly = SKELETON.wheelY + Math.sin(a) * (ARCH_RADIUS - 0.004);
      const lz = az + Math.cos(a) * (ARCH_RADIUS - 0.004);
      liner.push(ox - 0.012, ly, lz, WELL_X, ly, lz);
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
  geo.trim.push(place(new BoxGeometry(1.0, 0.02, 3.6), [0, 0.24, -0.02]));

  // detail placement casts rays at the same skin
  const surface = new Surface([g]);
  const cabin = body.cabin;
  const hoodStart = cabin[0].z + 0.02;
  // hood ends where the nose starts to fall away
  const base = surface.topY(0, SKELETON.frontJointZ, 0.84);
  let hoodEnd = 2.0;
  for (let z = SKELETON.frontJointZ; z < 2.4; z += 0.02) {
    if (surface.topY(0, z, 0) < base - 0.07) {
      hoodEnd = z - 0.03;
      break;
    }
  }
  const zB = bPillarZ(body);
  const shell: ShellInfo = {
    geo,
    surface,
    body,
    hoodStart,
    hoodEnd,
    fine,
    nose: endInfo(fine, 1),
    tail: endInfo(fine, -1),
    doors: { front: Math.min(cabin[0].z + 0.14, 1.0), rear: zB - 0.16 },
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

/** Trim that belongs to a body: front fender gills, flank intakes, engine-cover louvres. */
function bodyFeatures(shell: ShellInfo) {
  const { surface: s, body, geo } = shell;
  if (body.features.gills) {
    // three raked gills behind the front wheel, dark with a bright edge
    const z0 = SKELETON.frontAxleZ - ARCH_RADIUS - 0.09;
    for (let i = 0; i < 3; i++) {
      const zc = z0 - i * 0.07;
      const slot: [number, number][] = [
        [zc + 0.012, 0.47],
        [zc + 0.045, 0.62],
        [zc + 0.02, 0.625],
        [zc - 0.014, 0.475],
      ];
      geo.trim.push(...both(conform(s, soften(slot, 0.3), flank(), { off: 0.002, step: 0.02, rings: 2 })));
      geo.chrome.push(...both(conformStrip(s, [[zc + 0.044, 0.625], [zc + 0.012, 0.47]], 0.006, flank(), { off: 0.003 })));
    }
  }
  if (body.features.intake && body.sculpt.intake) {
    const it = body.sculpt.intake;
    // the grille sits deep in the back of the scoop
    const zc = it.z0 + (it.z1 - it.z0) * 0.3;
    const yc = (it.y0 + it.y1) / 2 - 0.02;
    const mouth = soften(
      [
        [zc + 0.14, yc + 0.06],
        [zc - 0.1, yc + 0.09],
        [zc - 0.12, yc - 0.06],
        [zc + 0.09, yc - 0.075],
      ],
      0.3,
    );
    geo.trim.push(...both(conform(s, mouth, flank(), { off: 0.006, step: 0.02, rings: 5 })));
    for (let k = 0; k < 5; k++) {
      const yy = yc - 0.05 + k * 0.028;
      geo.carbon.push(...both(conformStrip(s, [[zc + 0.09, yy - 0.008], [zc - 0.09, yy + 0.016]], 0.01, flank(), { off: 0.006, wall: 0.006 })));
    }
  }
  if (body.features.louvres) {
    // engine cover louvres between the rear glass and the tail
    const zA = body.cabin[body.cabin.length - 1].z - 0.06;
    const zEnd = SKELETON.rearJointZ - 0.02;
    const base = roundRect(0, (zA + zEnd) / 2, 0.78, zA - zEnd, 0.04);
    geo.trim.push(conform(s, base, above(), { off: 0.003, step: 0.05, rings: 3 }));
    const n = Math.max(3, Math.floor((zA - zEnd - 0.04) / 0.055));
    for (let k = 0; k < n; k++) {
      const z = zEnd + 0.04 + ((zA - zEnd - 0.08) * k) / Math.max(1, n - 1);
      geo.paint.push(zoned(conformStrip(s, [[-0.36, z], [0.36, z]], 0.024, above(), { off: 0.012, wall: 0.01 }), ZONE.rear));
    }
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
        crisp: 0.55,
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
  geo.trim.push(place(rbox(keys[0].beltW * 1.9, 0.02, 0.08, 0.008), [0, cowlY + 0.004, zFront + 0.03]));
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
  return geo;
}

// ---------------------------------------------------------------- front details

function splitter(s: Surface, y: number, halfW: number, protrude: number, depth: number, thick: number): BufferGeometry {
  const front: [number, number][] = [];
  let lastZ = 2.0;
  for (let i = 0; i <= 18; i++) {
    const x = -halfW + (2 * halfW * i) / 18;
    const h = s.cast(new Vector3(x, y + 0.05, 4), new Vector3(0, 0, -1));
    if (h) lastZ = h.point.z;
    front.push([x, lastZ + protrude - 0.06 * (Math.abs(x) / halfW) ** 4]);
  }
  const back = Math.min(...front.map((p) => p[1])) - depth;
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

export function frontPart(id: string, shell: ShellInfo): PartGeo {
  const g = emptyPart();
  const s = shell.surface;
  const N = shell.nose;
  const h = N.top - N.bottom;
  const fy = (k: number) => N.bottom + h * k;
  const F = face(1);
  if (id === 'muscle') {
    // full-width recessed grille in a chrome surround, vertical bars, a badge and a chrome bumper bar
    const gy = fy(0.36);
    const gw = Math.min(0.68, N.ws * 0.74);
    const gh = Math.min(0.15, h * 0.3);
    const outline = roundRect(0, gy, gw * 2, gh, 0.035);
    g.trim.push(conform(s, outline, F, { off: 0.003, rings: 3, step: 0.04 }));
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
    // lower valance intake and round fog lamps
    g.trim.push(conform(s, roundRect(0, fy(0.0) + 0.03, 0.9, 0.05, 0.022), F, { off: 0.003, step: 0.05 }));
  } else if (id === 'aggressive') {
    // carbon splitter following the nose, with end plates
    g.carbon.push(splitter(s, 0.2, 0.8, 0.075, 0.3, 0.02));
    for (const x of [0.81, -0.81]) {
      const z = s.faceZ(x * 0.9, 0.24, 1, 2.0).z;
      g.carbon.push(plateZY([[z + 0.06, 0.18], [z - 0.24, 0.18], [z - 0.24, 0.31], [z - 0.02, 0.27]], 0.015, x));
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
    g.trim.push(conform(s, mouth, F, { off: 0.005, rings: 4, step: 0.03 }));
    meshFill(s, F, mouth, 0.05, 0.007, g.carbon, 0.01);
    g.carbon.push(conformBand(s, mouth, F, { shrink: 1.08, off: 0.008, offInner: 0.008, wall: 0.008 }));
    // side intakes: angular blades sweeping up into the corners, with a carbon vane
    const sm = new Vector3(0.63, iy, 2);
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
    g.trim.push(...both(conform(s, sideMouth, SP, { off: 0.005, rings: 3 })));
    g.carbon.push(...both(conformStrip(s, [[-0.08, -ih / 2 + 0.01], [0.1, ih * 0.4]], 0.012, SP, { off: 0.01, wall: 0.008 })));
    // canards on the corners
    for (const x of [0.79, -0.79]) {
      const side = x > 0 ? 1 : -1;
      const z = s.faceZ(x * 0.97, fy(0.45), 1, 2.0).z;
      g.carbon.push(place(rbox(0.2, 0.012, 0.16, 0.005), [x * 1.02, fy(0.45), z - 0.07], [0, side * 0.35, side * 0.2]));
    }
  } else {
    // classic: an oval mouth in a chrome bezel with fine bars, a badge, fog lamps and a slim lip
    const my = fy(0.32);
    const rw = Math.min(0.32, N.ws * 0.38);
    const rh = Math.min(0.085, h * 0.22);
    g.trim.push(conform(s, ellipse(0, my, rw, rh, 32), F, { off: 0.003, rings: 3 }));
    g.chrome.push(conformBand(s, ellipse(0, my, rw + 0.022, rh + 0.02, 32), F, { inner: ellipse(0, my, rw, rh, 32), off: 0.011, offInner: 0.007, wall: 0.01 }));
    bars(s, F, 0, my, (dy) => rw * Math.sqrt(Math.max(0, 1 - (dy / rh) ** 2)) - 0.012, rh * 2, 5, 0.008, g.chrome);
    g.chrome.push(conformStrip(s, [[-rw * 0.25, my], [rw * 0.25, my]], 0.01, F, { off: 0.012, wall: 0.008 }));
    g.chrome.push(conform(s, ellipse(0, my + rh + 0.06, 0.035, 0.024, 18), F, { off: 0.009, wall: 0.008, rings: 2 }));
    for (const x of [0.6, -0.6]) {
      if (x * x > (N.ws * 0.85) ** 2) continue;
      g.trim.push(conform(s, roundRect(x, fy(0.2), 0.17, 0.06, 0.03), F, { off: 0.003, rings: 2 }));
      g.light.push(conform(s, ellipse(x, fy(0.2), 0.026, 0.026, 14), F, { off: 0.007, rings: 2 }));
    }
    g.trim.push(splitter(s, 0.24, 0.68, 0.025, 0.12, 0.02));
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
  if (id === 'kamm') {
    // duck-tail lip along the cut
    const lipZ = s.faceZ(0, T.top - 0.03, -1, T.tip).z;
    const ly = T.top - 0.01;
    g.paint.push(zoned(plateZY([[lipZ + 0.22, ly - 0.005], [lipZ - 0.07, ly + 0.06], [lipZ - 0.08, ly + 0.04], [lipZ + 0.02, ly - 0.03]], T.ws * 1.5, 0, 0.012), ZONE.rear));
    // a gloss black tail panel carrying four round lamps: lit ring, dark centre, chrome bezel
    const ly2 = ty(0.62);
    g.trim.push(conform(s, roundRect(0, ly2, Math.min(1.6, T.ws * 1.75), 0.2, 0.06), B, { off: 0.003, rings: 3, step: 0.05 }));
    for (const x of [0.64, 0.4]) {
      for (const sx of [x, -x]) {
        g.chrome.push(conformBand(s, ellipse(sx, ly2, 0.085, 0.085, 24), B, { shrink: 0.82, off: 0.012, offInner: 0.008, wall: 0.012 }));
        g.tail.push(conformBand(s, ellipse(sx, ly2, 0.068, 0.068, 24), B, { shrink: 0.55, off: 0.009 }));
        g.trim.push(conform(s, ellipse(sx, ly2, 0.038, 0.038, 16), B, { off: 0.006, rings: 2 }));
        g.tail.push(conform(s, ellipse(sx, ly2, 0.014, 0.014, 10), B, { off: 0.01, rings: 1 }));
      }
    }
    // full-width bumper with vertical strakes, reverse lamps and a plate recess
    g.chrome.push(conformStrip(s, [[-T.ws * 0.86, ty(0.24)], [T.ws * 0.86, ty(0.24)]], 0.03, B, { off: 0.016, wall: 0.016, step: 0.05 }));
    g.trim.push(conform(s, roundRect(0, ty(0.04) + 0.02, Math.min(1.3, T.ws * 1.4), 0.07, 0.03), B, { off: 0.004, step: 0.05 }));
    for (let i = -3; i <= 3; i++) g.carbon.push(conformStrip(s, [[i * 0.12, ty(0.0) + 0.0], [i * 0.12, ty(0.1)]], 0.012, B, { off: 0.012, wall: 0.01 }));
    for (const x of [0.25, -0.25]) g.light.push(conform(s, roundRect(x, ty(0.36), 0.12, 0.03, 0.012), B, { off: 0.006, rings: 2 }));
    g.trim.push(conform(s, roundRect(0, ty(0.36), 0.3, 0.09, 0.012), B, { off: 0.004, rings: 2 }));
    g.chrome.push(conformStrip(s, [[-0.12, ty(0.85)], [0.12, ty(0.85)]], 0.016, B, { off: 0.006, wall: 0.004 }));
  } else if (id === 'diffuser') {
    // a slim light blade across a dark tail panel, ending in C-shaped lamp signatures
    const ly = ty(0.7);
    const span = Math.min(0.7, T.ws * 0.82);
    g.trim.push(conform(s, roundRect(0, ly, span * 2 + 0.1, 0.11, 0.04), B, { off: 0.003, rings: 3, step: 0.05 }));
    g.tail.push(conformStrip(s, [[-span, ly], [span, ly]], 0.018, B, { off: 0.008, wall: 0.006 }));
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
    g.trim.push(conform(s, panel, B, { off: 0.004, rings: 4, step: 0.04 }));
    meshFill(s, B, roundRect(0, ty(0.33), span * 2 + 0.02, h * 0.32, 0.04), 0.045, 0.006, g.carbon, 0.009);
    g.tail.push(conform(s, roundRect(0, ty(0.33), 0.14, 0.05, 0.012), B, { off: 0.012, rings: 2, wall: 0.008 }));
    // diffuser: carbon floor rising to the tail with tall strakes
    const tailZ = s.faceZ(0, ty(0.2), -1, T.tip).z;
    const floor = new BoxGeometry(1.18, 0.02, 0.62);
    place(floor, [0, 0.235, tailZ + 0.22], [-0.22, 0, 0]);
    g.carbon.push(floor);
    for (let i = -3; i <= 3; i++) {
      g.carbon.push(plateZY([[tailZ + 0.42, 0.245], [tailZ - 0.035, 0.205], [tailZ - 0.03, 0.33], [tailZ + 0.12, 0.33], [tailZ + 0.3, 0.29]], 0.012, i * 0.2));
    }
    g.carbon.push(conformStrip(s, [[-T.ws * 0.8, ty(0.12)], [T.ws * 0.8, ty(0.12)]], 0.02, B, { off: 0.014, wall: 0.014, step: 0.05 }));
  } else {
    // tapered: a wrap-around light bar following the tail, over a black fascia, chrome strip above
    const ly = ty(0.66);
    const W = wrap(-1, -1.2);
    const span = 1.0;
    g.trim.push(conformStrip(s, [[-span, ly], [span, ly]], 0.07, W, { off: 0.004, step: 0.04 }));
    g.tail.push(conformStrip(s, [[-span + 0.03, ly + 0.008], [span - 0.03, ly + 0.008]], 0.026, W, { off: 0.009, wall: 0.006, step: 0.03 }));
    for (const sx of [1, -1]) {
      g.tail.push(conformStrip(s, [[sx * (span - 0.03), ly - 0.02], [sx * (span - 0.2), ly - 0.02]], 0.012, W, { off: 0.009, wall: 0.005 }));
    }
    g.chrome.push(conformStrip(s, [[-span * 0.8, ly + 0.055], [span * 0.8, ly + 0.055]], 0.01, W, { off: 0.006, wall: 0.004, step: 0.04 }));
    // bumper, plate recess, reverse lamps and a small diffuser
    g.carbon.push(conformStrip(s, [[-T.ws * 0.7, ty(0.06)], [T.ws * 0.7, ty(0.06)]], 0.03, B, { off: 0.01, wall: 0.012, step: 0.05 }));
    g.trim.push(conform(s, roundRect(0, ty(0.42), 0.4, 0.1, 0.015), B, { off: 0.004, rings: 2 }));
    for (const x of [0.33, -0.33]) g.light.push(conform(s, roundRect(x, ty(0.42), 0.1, 0.026, 0.01), B, { off: 0.006, rings: 2 }));
    for (let i = -2; i <= 2; i++) g.carbon.push(conformStrip(s, [[i * 0.14, ty(0.12)], [i * 0.14, ty(0.27)]], 0.012, B, { off: 0.014, wall: 0.008 }));
  }
  return g;
}

// ---------------------------------------------------------------- hood

export function hoodPart(id: string, surface: Surface, hoodStart: number, hoodEnd: number): PartGeo {
  const g = emptyPart();
  const z0 = hoodStart + 0.08;
  const z1 = Math.min(hoodEnd - 0.05, SKELETON.frontJointZ + 0.3);
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
    // a pair of small vents behind it
    for (const x of [0.42, -0.42]) {
      const zc = z0 + len * 0.6;
      g.trim.push(place(rbox(0.16, 0.02, 0.2, 0.008), [x, topAt(x, zc) + 0.003, zc], [slope(x, zc - 0.1, zc + 0.1), 0, 0]));
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
    g.trim.push(...both(conform(surface, vent, A, { off: 0.004, rings: 3, step: 0.04 })));
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
  } else {
    // smooth: the power dome is sculpted into the shell itself (see shellPart); just the washer jets here
    for (const x of [0.12, -0.12]) g.trim.push(place(rbox(0.03, 0.015, 0.03, 0.006), [x, topAt(x, z0 - 0.03) + 0.006, z0 - 0.03]));
  }
  return g;
}

// ---------------------------------------------------------------- skirts

export function skirtPart(id: string, s: Surface): PartGeo {
  const g = emptyPart();
  const [za, zb] = SKELETON.skirtZ;
  const sideAt = (y: number) => Math.max(s.sideX(y, za + 0.15, 0.72), s.sideX(y, 0, 0.72), s.sideX(y, zb - 0.15, 0.72));
  if (id === 'blade') {
    const x0 = 0.56;
    const x1 = sideAt(0.32) + 0.02;
    g.paint.push(...both(zoned(railXY([[x0, 0.21], [x1, 0.22], [x1 + 0.01, 0.3], [x1 - 0.04, 0.36], [x0, 0.38]], za, zb, 0.02), ZONE.skirts)));
    // carbon blade sticking out, with a small upturned tip at the rear
    g.carbon.push(...both(railXY([[x0 + 0.1, 0.19], [x1 + 0.1, 0.19], [x1 + 0.11, 0.205], [x0 + 0.1, 0.212]], za + 0.02, zb - 0.02, 0.008)));
    g.carbon.push(...both(plateZY([[za + 0.22, 0.2], [za + 0.04, 0.2], [za + 0.04, 0.3], [za + 0.09, 0.3]], 0.012, x1 + 0.08)));
  } else if (id === 'wide') {
    const x0 = 0.56;
    const x1 = sideAt(0.33) + 0.08;
    g.paint.push(...both(zoned(railXY([[x0, 0.19], [x1 - 0.03, 0.2], [x1, 0.26], [x1 - 0.02, 0.36], [x1 - 0.1, 0.42], [x0, 0.43]], za, zb, 0.04), ZONE.skirts)));
    // intake ahead of the rear wheel
    for (let k = 0; k < 4; k++) g.trim.push(...both(place(rbox(0.05, 0.13, 0.03, 0.012), [x1 - 0.01, 0.31, za + 0.1 + k * 0.055], [0, -0.3, 0])));
    g.trim.push(...both(place(rbox(0.04, 0.16, 0.24, 0.02), [x1 - 0.025, 0.31, za + 0.18])));
    g.trim.push(...both(railXY([[x0, 0.18], [x1 - 0.02, 0.18], [x1 - 0.02, 0.2], [x0, 0.2]], za + 0.02, zb - 0.02, 0.008)));
  } else {
    const x0 = 0.56;
    const x1 = sideAt(0.3) + 0.01;
    g.paint.push(...both(zoned(railXY([[x0, 0.22], [x1, 0.23], [x1 + 0.005, 0.32], [x0, 0.35]], za, zb, 0.025), ZONE.skirts)));
    g.trim.push(...both(railXY([[x0, 0.205], [x1 - 0.01, 0.205], [x1 - 0.01, 0.225], [x0, 0.225]], za + 0.02, zb - 0.02, 0.006)));
  }
  return g;
}

// ---------------------------------------------------------------- spoiler

function airfoil(chord: number, thick: number, width: number): BufferGeometry {
  const s = new Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(chord * 0.1, thick * 1.2, chord * 0.6, thick * 1.1, chord, thick * 0.15);
  s.lineTo(chord, -thick * 0.05);
  s.bezierCurveTo(chord * 0.6, thick * 0.1, chord * 0.2, -thick * 0.4, 0, 0);
  const g = new ExtrudeGeometry(s, { depth: width, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.003, bevelSegments: 1, curveSegments: 10 });
  // shape is in XY (x = chord) extruded along z: rotate so chord runs along -z and span along x
  g.translate(-chord / 2, 0, -width / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

export function spoilerPart(id: string, surface: Surface): PartGeo {
  const g = emptyPart();
  const z = SKELETON.spoilerZ;
  const deckC = surface.topY(0, z, 0.8);
  const deckS = surface.topY(0.55, z, deckC);
  const deck = Math.min(deckC, deckS);
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
      const base = surface.topY(x, z + 0.08, deck) - 0.015;
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
      const base = surface.topY(x, z, deck) - 0.02;
      g.trim.push(plateZY([[z + 0.1, base], [z - 0.06, base], [z - 0.02, h + 0.005], [z + 0.06, h + 0.005]], 0.026, x));
    }
  } else {
    // ducktail lip, shaped like a short airfoil sitting on the deck
    const zz = z - 0.1;
    const y = Math.min(surface.topY(0, zz, deck), surface.topY(0.6, zz, deck));
    g.paint.push(zoned(place(airfoil(0.2, 0.05, 1.32), [0, y + 0.012, zz], [-0.28, 0, 0]), ZONE.spoiler));
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
    R(house, g.trim, { off: 0.004, wall: 0.012, rings: 3, step: 0.02 });
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
    R(soften(house, 0.15), g.trim, { off: 0.004, wall: 0.012, rings: 3, step: 0.02 });
    S([[-0.17, 0.028], [0.17, 0.062], [0.215, 0.045]], 0.012, g.light, { off: 0.011, wall: 0.005 });
    S([[0.19, 0.03], [0.1, -0.005], [-0.02, -0.012]], 0.009, g.light, { off: 0.011, wall: 0.005 });
    for (const dx of [-0.11, -0.04, 0.03]) R(ellipse(dx, 0.008 + dx * 0.1, 0.018, 0.016, 14), g.light, { off: 0.009, rings: 1 });
    R(roundRect(0.0, 0.012, 0.26, 0.022, 0.01, 0.12), g.chrome, { off: 0.006, rings: 1 });
  } else {
    // LED bar: a slim swept blade with a lit top edge and four LED elements under it
    const house = roundRect(0, 0, 0.46, 0.075, 0.034, 0.12);
    R(house, g.trim, { off: 0.004, wall: 0.012, rings: 3, step: 0.02 });
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

export function exhaustPart(id: string, shell: ShellInfo): ExhaustInfo {
  const g = emptyPart();
  const rear = shell.surface;
  // pipes exit through the tail face, however high the tail's bottom edge sits
  const y = Math.max(SKELETON.exhaustY, shell.tail.bottom + 0.1);
  const xs = id === 'quad' ? [0.4, 0.56, -0.4, -0.56] : id === 'center' ? [-0.09, 0.09] : [0.5, -0.5];
  const r = id === 'center' ? 0.075 : id === 'quad' ? 0.042 : 0.055;
  const tips: Vector3[] = [];
  for (const x of xs) {
    const z = rear.faceZ(x, y - 0.03, -1, -2.1).z;
    const len = 0.24;
    const cz = z + len / 2 - 0.08;
    // double-walled tip: polished outer, darker inner pipe, sooty core
    const pipe = cyl(r, len, 22, true, r * 0.92);
    place(pipe, [x, y - 0.06, cz], [Math.PI / 2, 0, 0]);
    g.chrome.push(pipe);
    const innerPipe = cyl(r * 0.72, len, 18, true);
    place(innerPipe, [x, y - 0.06, cz + 0.01], [Math.PI / 2, 0, 0]);
    g.carbon.push(innerPipe);
    const core = new CircleGeometry(r * 0.72, 16);
    place(core, [x, y - 0.06, z - 0.03], [0, Math.PI, 0]);
    g.trim.push(core);
    const lip = new TorusGeometry(r, 0.011, 6, 22);
    place(lip, [x, y - 0.06, z - 0.08]);
    g.chrome.push(lip);
    const lip2 = new TorusGeometry(r * 0.73, 0.006, 4, 18);
    place(lip2, [x, y - 0.06, z - 0.075]);
    g.chrome.push(lip2);
    tips.push(new Vector3(x, y - 0.06, z - 0.08));
  }
  // silencer box tucked under the tail
  const zs = rear.faceZ(0, y, -1, -2.1).z;
  g.trim.push(place(rbox(Math.min(1.1, Math.max(...xs) * 2 + 0.2), 0.1, 0.26, 0.04), [0, 0.27, zs + 0.22]));
  if (id === 'center') {
    g.trim.push(place(rbox(0.46, 0.15, 0.06, 0.05), [0, y - 0.06, zs + 0.04]));
    g.chrome.push(place(rbox(0.48, 0.17, 0.02, 0.05), [0, y - 0.06, zs + 0.012]));
  }
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

/** Rim radius: big wheels on low-profile tyres. */
const RIM_R = 0.262;

export function tireGeometry(): BufferGeometry {
  const R = SKELETON.wheelRadius;
  const W = SKELETON.wheelWidth;
  const rim = RIM_R;
  const hw = W / 2 - 0.01;
  const pts: Vector2[] = [];
  const side = (sgn: number, t: number) => new Vector2(rim + 0.015 + (R - rim - 0.045) * t, sgn * (hw + Math.sin(t * Math.PI) * 0.012));
  // inner bead and sidewall
  pts.push(new Vector2(rim - 0.004, -hw + 0.012));
  for (let i = 0; i <= 6; i++) pts.push(side(-1, i / 6));
  // rounded shoulder, tread with four circumferential grooves, shoulder
  const shoulder = (sgn: number, k: number) => {
    const a = (k * Math.PI) / 2;
    return new Vector2(R - 0.03 + Math.sin(a) * 0.03, sgn * (hw - 0.03 + Math.cos(a) * 0.03));
  };
  for (let i = 1; i <= 4; i++) pts.push(shoulder(-1, i / 4));
  const grooves = [-0.07, -0.025, 0.025, 0.07];
  const treadSteps = 30;
  for (let i = 1; i < treadSteps; i++) {
    const zz = -hw + 0.03 + ((2 * hw - 0.06) * i) / treadSteps;
    const inGroove = grooves.some((gz) => Math.abs(zz - gz) < 0.006);
    pts.push(new Vector2(inGroove ? R - 0.009 : R, zz));
  }
  for (let i = 4; i >= 1; i--) pts.push(shoulder(1, i / 4));
  // outer sidewall with a rim-protector bead
  for (let i = 6; i >= 0; i--) pts.push(side(1, i / 6));
  pts.push(new Vector2(rim + 0.008, hw + 0.016));
  pts.push(new Vector2(rim - 0.004, hw - 0.012));
  const g = new LatheGeometry(pts, 40);
  g.rotateZ(Math.PI / 2); // axis along x
  return g;
}

/** Rim geometry; the outer face points to +x (mirror for the other side). */
export function rimGeometry(id: string): { main: BufferGeometry[]; accent: BufferGeometry[] } {
  const main: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const R = RIM_R;
  const face = 0.1;
  // stepped barrel with a polished outer lip
  const barrel = new LatheGeometry(
    [
      new Vector2(R - 0.01, -0.12),
      new Vector2(R - 0.02, -0.06),
      new Vector2(R - 0.035, 0.0),
      new Vector2(R - 0.02, 0.06),
      new Vector2(R - 0.012, face - 0.005),
      new Vector2(R + 0.006, face + 0.004),
      new Vector2(R + 0.004, face + 0.016),
      new Vector2(R - 0.012, face + 0.014),
    ],
    36,
  );
  barrel.rotateZ(-Math.PI / 2);
  main.push(barrel);
  // dark inner face so the spokes stand out against depth
  const inner = new CircleGeometry(R - 0.02, 32);
  inner.rotateY(Math.PI / 2);
  inner.translate(face - 0.06, 0, 0);
  accent.push(inner);
  // hub with five lug nuts and a centre cap
  const hub = cyl(0.065, 0.05, 20, false, 0.075).rotateZ(Math.PI / 2);
  hub.translate(face - 0.005, 0, 0);
  main.push(hub);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const nut = cyl(0.011, 0.024, 6).rotateZ(Math.PI / 2);
    nut.translate(face + 0.025, Math.cos(a) * 0.045, Math.sin(a) * 0.045);
    main.push(nut);
  }
  const cap = cyl(0.026, 0.012, 16).rotateZ(Math.PI / 2);
  cap.translate(face + 0.028, 0, 0);
  accent.push(cap);
  if (id === 'mesh') {
    for (let i = 0; i < 12; i++) {
      for (const s of [1, -1]) {
        const a = (i / 12) * Math.PI * 2;
        const sp = new BoxGeometry(0.016, 0.205, 0.013);
        sp.translate(0, 0.145, 0);
        sp.rotateX(a + s * 0.2);
        sp.translate(face - 0.005 + (s > 0 ? 0.004 : 0), 0, 0);
        main.push(sp);
      }
    }
    const ring = new TorusGeometry(0.172, 0.008, 4, 36).rotateY(Math.PI / 2);
    ring.translate(face, 0, 0);
    main.push(ring);
  } else if (id === 'turbine') {
    const disc = cyl(R - 0.012, 0.02, 32).rotateZ(Math.PI / 2);
    disc.translate(face - 0.03, 0, 0);
    accent.push(disc);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const b = new BoxGeometry(0.035, 0.172, 0.035);
      const p = b.getAttribute('position');
      for (let k = 0; k < p.count; k++) p.setZ(k, p.getZ(k) * (0.5 + (p.getY(k) + 0.086) * 5.6));
      b.computeVertexNormals();
      b.rotateY(0.65);
      b.translate(0, 0.156, 0);
      b.rotateX(a);
      b.translate(face - 0.005, 0, 0);
      main.push(b);
    }
  } else {
    // five split spokes, tapered and dished
    for (let i = 0; i < 5; i++) {
      for (const s of [-1, 1]) {
        const a = (i / 5) * Math.PI * 2 + s * 0.13;
        const sp = new BoxGeometry(0.04, 0.185, 0.028);
        const pos = sp.getAttribute('position');
        for (let k = 0; k < pos.count; k++) {
          const t = (pos.getY(k) + 0.0925) / 0.185;
          pos.setZ(k, pos.getZ(k) * (1.25 - 0.45 * t) + s * t * 0.012);
          pos.setX(k, pos.getX(k) - t * 0.035);
        }
        sp.computeVertexNormals();
        sp.translate(0, 0.162, 0);
        sp.rotateX(a);
        sp.translate(face - 0.005, 0, 0);
        main.push(sp);
      }
    }
  }
  return { main, accent };
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
}

export function cabinFrame(bodyId: string): CabinFrame {
  const body = bodySections(bodyId);
  const keys = body.cabin;
  // same glasshouse as cabinPart: the belt sits just above the body's skin (the cabin
  // only spans the body's own sections, so the nose and tail don't matter here)
  const hull = refine([body.rearJoint, ...body.hull, body.frontJoint], (len) => len / 0.032);
  const belts = keys.map((k) => skinY(sectionAt(hull, k.z), k.beltW) + 0.03);
  const secs: Section[] = keys
    .map((k, i) => ({ z: k.z, yb: belts[i] - 0.06, wb: k.beltW - 0.05, ys: belts[i], ws: k.beltW, yt: Math.max(k.roof, belts[i] + 0.01), wt: k.roofW, crisp: 0.55 }))
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
  };
}
