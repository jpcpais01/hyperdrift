import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loft, profileCurve, refine, sectionAt, type Section } from './loft';
import { joint, SKELETON } from './skeleton';
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

/** Finds a surface by casting a ray against a set of geometries. */
export class Surface {
  private meshes: Mesh[];
  private ray = new Raycaster();
  private cache = new Map<string, { point: Vector3; normal: Vector3 } | null>();
  private static mat = new MeshBasicMaterial({ side: DoubleSide });
  constructor(geos: BufferGeometry[]) {
    // split big meshes into slabs along z so a ray only tests the triangles near it
    this.meshes = geos.flatMap((g) => slabs(g)).map((g) => {
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new Mesh(g, Surface.mat);
      m.updateMatrixWorld();
      return m;
    });
  }
  cast(origin: Vector3, dir: Vector3): { point: Vector3; normal: Vector3 } | null {
    const key = `${origin.x.toFixed(4)},${origin.y.toFixed(4)},${origin.z.toFixed(4)},${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached && { point: cached.point.clone(), normal: cached.normal.clone() };
    this.ray.set(origin, dir.clone().normalize());
    const hits = this.ray.intersectObjects(this.meshes, false);
    let out: { point: Vector3; normal: Vector3 } | null = null;
    if (hits.length && hits[0].face) {
      const n = hits[0].face.normal.clone();
      if (n.dot(dir) > 0) n.negate();
      out = { point: hits[0].point.clone(), normal: n };
    }
    this.cache.set(key, out);
    return out && { point: out.point.clone(), normal: out.normal.clone() };
  }
  /** height of the top surface at (x, z) */
  topY(x: number, z: number, fallback: number): number {
    const h = this.cast(new Vector3(x, 3, z), new Vector3(0, -1, 0));
    return h ? h.point.y : fallback;
  }
  /** z of the front (+1) or rear (-1) face at (x, y) */
  faceZ(x: number, y: number, side: 1 | -1, fallback: number): { z: number; normal: Vector3 } {
    const h = this.cast(new Vector3(x, y, side * 4), new Vector3(0, 0, -side));
    return h ? { z: h.point.z, normal: h.normal } : { z: fallback, normal: new Vector3(0, 0, side) };
  }
  /** x of the right-hand side at (y, z) */
  sideX(y: number, z: number, fallback: number): number {
    const h = this.cast(new Vector3(3, y, z), new Vector3(-1, 0, 0));
    return h ? h.point.x : fallback;
  }
}

/** Splits an indexed geometry into position-only chunks by triangle z (for faster ray casts). */
function slabs(g: BufferGeometry, n = 14): BufferGeometry[] {
  const idx = g.getIndex();
  const pos = g.getAttribute('position');
  if (!idx || idx.count < 3000) return [g];
  g.computeBoundingBox();
  const z0 = g.boundingBox!.min.z;
  const z1 = g.boundingBox!.max.z;
  const lists: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    const b = idx.getX(i + 1);
    const c = idx.getX(i + 2);
    const zc = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const k = Math.min(n - 1, Math.max(0, Math.floor(((zc - z0) / (z1 - z0 + 1e-6)) * n)));
    for (const v of [a, b, c]) lists[k].push(pos.getX(v), pos.getY(v), pos.getZ(v));
  }
  return lists
    .filter((l) => l.length)
    .map((l) => {
      const out = new BufferGeometry();
      out.setAttribute('position', new BufferAttribute(new Float32Array(l), 3));
      return out;
    });
}

/**
 * Places a detail on the front (+1) or rear (-1) face of the shell at (x, y),
 * turned to follow the local surface, sunk `inset` metres into it.
 * The geometry is modelled facing +z (out of the face) around its origin.
 */
function onFace(s: Surface, side: 1 | -1, x: number, y: number, inset: number, g: BufferGeometry, extra: [number, number, number] = [0, 0, 0], fallbackZ = 2.0 * side): BufferGeometry {
  const hit = s.faceZ(x, y, side, fallbackZ);
  const n = hit.normal;
  const nz = Math.max(0.25, n.z * side);
  const yaw = Math.atan2(n.x, nz) * side;
  const pitch = -Math.atan2(n.y, nz) * side;
  if (side < 0) g.rotateY(Math.PI);
  place(g, [x, y, hit.z - side * inset], [pitch + extra[0], yaw + extra[1], extra[2]]);
  return g;
}

// ---------------------------------------------------------------- section catalogue

export interface BodyInfo {
  hull: Section[];
  /** where the hood overlay may start (behind it is the windscreen) */
  hoodStart: number;
}

export function bodySections(id: string): BodyInfo {
  switch (id) {
    case 'fastback':
      return {
        hoodStart: 0.62,
        hull: [
          joint(-1.45),
          { z: -1.05, yb: 0.25, wb: 0.64, ys: 0.71, ws: 1.0, yt: 0.86, wt: 0.84, crisp: 0.65 },
          { z: -0.4, yb: 0.25, wb: 0.63, ys: 0.69, ws: 0.95, yt: 0.83, wt: 0.83, crisp: 0.65 },
          { z: 0.45, yb: 0.25, wb: 0.63, ys: 0.69, ws: 0.94, yt: 0.83, wt: 0.83, crisp: 0.65 },
          { z: 1.05, yb: 0.25, wb: 0.63, ys: 0.7, ws: 0.98, yt: 0.85, wt: 0.82, crisp: 0.65 },
          joint(1.45),
        ],
      };
    case 'wedge':
      return {
        hoodStart: 1.04,
        hull: [
          joint(-1.45),
          { z: -0.95, yb: 0.25, wb: 0.65, ys: 0.68, ws: 1.02, yt: 0.86, wt: 0.88, crisp: 0.85 },
          { z: -0.2, yb: 0.25, wb: 0.64, ys: 0.66, ws: 0.96, yt: 0.82, wt: 0.84, crisp: 0.85 },
          { z: 0.6, yb: 0.25, wb: 0.64, ys: 0.67, ws: 0.98, yt: 0.82, wt: 0.84, crisp: 0.85 },
          { z: 1.1, yb: 0.25, wb: 0.63, ys: 0.7, ws: 1.0, yt: 0.83, wt: 0.84, crisp: 0.7 },
          joint(1.45),
        ],
      };
    default:
      return {
        hoodStart: 0.72,
        hull: [
          joint(-1.45),
          { z: -1.0, yb: 0.25, wb: 0.64, ys: 0.71, ws: 0.99, yt: 0.87, wt: 0.84, crisp: 0.72 },
          { z: -0.4, yb: 0.25, wb: 0.63, ys: 0.69, ws: 0.95, yt: 0.84, wt: 0.83, crisp: 0.72 },
          { z: 0.4, yb: 0.25, wb: 0.63, ys: 0.69, ws: 0.95, yt: 0.84, wt: 0.83, crisp: 0.72 },
          { z: 1.0, yb: 0.25, wb: 0.63, ys: 0.7, ws: 0.97, yt: 0.85, wt: 0.82, crisp: 0.72 },
          joint(1.45),
        ],
      };
  }
}

/** Nose sections, from the front joint forwards. */
export function frontSections(id: string): Section[] {
  if (id === 'muscle') {
    return [
      joint(1.45),
      { z: 1.75, yb: 0.26, wb: 0.62, ys: 0.68, ws: 0.97, yt: 0.85, wt: 0.82, crisp: 0.85 },
      { z: 2.0, yb: 0.27, wb: 0.6, ys: 0.64, ws: 0.96, yt: 0.8, wt: 0.78, crisp: 0.95 },
      { z: 2.1, yb: 0.28, wb: 0.56, ys: 0.6, ws: 0.92, yt: 0.74, wt: 0.72, crisp: 0.95 },
    ];
  }
  if (id === 'aggressive') {
    return [
      joint(1.45),
      { z: 1.72, yb: 0.25, wb: 0.62, ys: 0.65, ws: 0.96, yt: 0.8, wt: 0.78, crisp: 0.75 },
      { z: 1.98, yb: 0.23, wb: 0.6, ys: 0.52, ws: 0.93, yt: 0.66, wt: 0.68, crisp: 0.85 },
      { z: 2.12, yb: 0.22, wb: 0.56, ys: 0.4, ws: 0.86, yt: 0.5, wt: 0.58, crisp: 0.9 },
      { z: 2.2, yb: 0.22, wb: 0.42, ys: 0.32, ws: 0.7, yt: 0.38, wt: 0.42, crisp: 0.9 },
    ];
  }
  return [
    joint(1.45),
    { z: 1.75, yb: 0.25, wb: 0.62, ys: 0.66, ws: 0.95, yt: 0.8, wt: 0.78, crisp: 0.6 },
    { z: 2.0, yb: 0.24, wb: 0.58, ys: 0.56, ws: 0.9, yt: 0.68, wt: 0.64, crisp: 0.4 },
    { z: 2.13, yb: 0.25, wb: 0.5, ys: 0.46, ws: 0.8, yt: 0.56, wt: 0.5, crisp: 0.35 },
    { z: 2.19, yb: 0.28, wb: 0.32, ys: 0.4, ws: 0.6, yt: 0.48, wt: 0.3, crisp: 0.3 },
  ];
}

/** Tail sections, from the very back up to the rear joint. */
export function rearSections(id: string): Section[] {
  if (id === 'kamm') {
    return [
      { z: -2.1, yb: 0.3, wb: 0.56, ys: 0.64, ws: 0.92, yt: 0.86, wt: 0.74, crisp: 0.95 },
      { z: -1.82, yb: 0.27, wb: 0.6, ys: 0.68, ws: 0.96, yt: 0.86, wt: 0.83, crisp: 0.75 },
      joint(-1.45),
    ];
  }
  if (id === 'diffuser') {
    return [
      { z: -2.14, yb: 0.32, wb: 0.5, ys: 0.58, ws: 0.84, yt: 0.74, wt: 0.66, crisp: 0.85 },
      { z: -1.95, yb: 0.29, wb: 0.58, ys: 0.66, ws: 0.95, yt: 0.82, wt: 0.78, crisp: 0.75 },
      joint(-1.45),
    ];
  }
  return [
    { z: -2.16, yb: 0.32, wb: 0.36, ys: 0.5, ws: 0.62, yt: 0.66, wt: 0.42, crisp: 0.35 },
    { z: -2.08, yb: 0.29, wb: 0.52, ys: 0.58, ws: 0.84, yt: 0.76, wt: 0.62, crisp: 0.4 },
    { z: -1.82, yb: 0.27, wb: 0.6, ys: 0.66, ws: 0.95, yt: 0.83, wt: 0.8, crisp: 0.6 },
    joint(-1.45),
  ];
}

// ---------------------------------------------------------------- the shell

/** Wheel arch radius: tyre radius plus suspension travel plus a gap. */
export const ARCH_RADIUS = 0.43;
/** x of the wheel-well wall (inside the tyre's inner face even at full lock). */
const WELL_X = 0.5;
const AXLES = [SKELETON.frontAxleZ, SKELETON.rearAxleZ];
/** vertices this close inside the arch are snapped onto its edge */
const EDGE_BAND = 0.05;

/** Fender flare added to the shell's half width at (y, z) for a given half width. */
function flare(ax: number, y: number, z: number): number {
  let out = 0;
  for (const az of AXLES) {
    const u = (z - az) / 0.8;
    if (Math.abs(u) >= 1) continue;
    const k = (1 - u * u) ** 2;
    const wy = smooth(0.2, 0.48, y) * (1 - smooth(0.76, 0.9, y));
    out += 0.075 * k * wy * smooth(0.45, 0.8, ax);
  }
  return out;
}

/** Shallow sculpted scallop along the doors, to break up the flat flanks. */
function scallop(ax: number, y: number, z: number): number {
  const along = smooth(-0.9, -0.45, z) * (1 - smooth(0.55, 0.92, z));
  return 0.02 * along * Math.exp(-(((y - 0.46) / 0.065) ** 2)) * smooth(0.6, 0.85, ax);
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
function outerHalfWidth(fine: Section[], y: number, z: number): number {
  const curve = profileCurve(sectionAt(fine, z));
  let prev = curve.getPoint(0);
  for (let i = 1; i <= 48; i++) {
    const p = curve.getPoint(i / 48);
    if (p.y >= y) {
      const t = Math.min(1, Math.max(0, (y - prev.y) / Math.max(1e-5, p.y - prev.y)));
      const ax = prev.x + (p.x - prev.x) * t;
      return ax + flare(ax, y, z) - scallop(ax, y, z);
    }
    prev = p;
  }
  return prev.x;
}

/** Flares the fenders, sculpts the doors and pushes the wheel wells in. Returns per-vertex paint zones (the shader darkens the wells itself). */
function sculpt(g: BufferGeometry): Float32Array {
  const pos = g.getAttribute('position') as BufferAttribute;
  const zone = new Float32Array(pos.count).fill(ZONE.auto);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const sx = x < 0 ? -1 : 1;
    let ax = Math.abs(x);
    ax += flare(ax, y, z) - scallop(ax, y, z);
    const { r, az } = archPolar(y, z);
    if (ax > WELL_X && r < ARCH_RADIUS) {
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

export interface ShellInfo {
  geo: PartGeo;
  /** outer skin, without the cabin */
  surface: Surface;
  hoodStart: number;
  /** z where the hood's top surface ends at the nose */
  hoodEnd: number;
  /** smooth sections of the whole shell */
  fine: Section[];
}

/**
 * One continuous body shell for body + front + rear: the three parts share the
 * standard joint sections, so lofting them together gives a seamless surface.
 * Fender flares and wheel wells are then sculpted into it at the skeleton's axles.
 */
export function shellPart(bodyId: string, frontId: string, rearId: string): ShellInfo {
  const body = bodySections(bodyId);
  const keys = [...rearSections(rearId), ...body.hull.slice(1, -1), ...frontSections(frontId)];
  const fine = refine(keys, (len) => len / 0.032);
  const g = loft(fine, { capStart: true, capEnd: true, ring: 40 });
  g.setAttribute('zone', new BufferAttribute(sculpt(g), 1));
  g.computeVertexNormals();
  const geo = emptyPart();
  geo.paint.push(g);

  // arch lips: a rolled edge that follows the fender around each opening
  for (const az of AXLES) {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 28; i++) {
      const a = -0.18 + (i / 28) * (Math.PI + 0.36);
      const y = SKELETON.wheelY + Math.sin(a) * (ARCH_RADIUS + 0.008);
      const z = az + Math.cos(a) * (ARCH_RADIUS + 0.008);
      if (y < sectionAt(fine, z).yb + 0.015) continue;
      pts.push(new Vector3(outerHalfWidth(fine, y, z) - 0.01, y, z));
    }
    const lip = new TubeGeometry(new CatmullRomCurve3(pts), 40, 0.016, 6, false);
    geo.paint.push(...both(zoned(lip, ZONE.auto)));
  }

  // underfloor: a dark flat pan so nothing glows through the gaps underneath
  geo.trim.push(place(new BoxGeometry(1.0, 0.02, 3.6), [0, 0.24, -0.02]));

  // ray casts for placing details use a lighter copy of the same shell
  const coarse = loft(refine(keys, (len) => len / 0.06), { capStart: true, capEnd: true, ring: 24 });
  sculpt(coarse);
  const surface = new Surface([coarse]);
  // hood ends where the nose starts to fall away
  const base = surface.topY(0, SKELETON.frontJointZ, 0.84);
  let hoodEnd = 2.0;
  for (let z = SKELETON.frontJointZ; z < 2.4; z += 0.02) {
    if (surface.topY(0, z, 0) < base - 0.07) {
      hoodEnd = z - 0.03;
      break;
    }
  }
  return { geo, surface, hoodStart: body.hoodStart, hoodEnd, fine };
}

// ---------------------------------------------------------------- cabin

interface CabinKey {
  z: number;
  roof: number;
  belt: number;
  beltW: number;
  roofW: number;
}

function cabinKeys(id: string): CabinKey[] {
  switch (id) {
    case 'fastback':
      return [
        { z: 0.6, roof: 0.84, belt: 0.84, beltW: 0.76, roofW: 0.62 },
        { z: 0.25, roof: 1.08, belt: 0.88, beltW: 0.76, roofW: 0.58 },
        { z: -0.05, roof: 1.2, belt: 0.9, beltW: 0.76, roofW: 0.55 },
        { z: -0.45, roof: 1.18, belt: 0.9, beltW: 0.76, roofW: 0.55 },
        { z: -0.95, roof: 1.02, belt: 0.88, beltW: 0.76, roofW: 0.58 },
        { z: -1.42, roof: 0.85, belt: 0.84, beltW: 0.72, roofW: 0.64 },
      ];
    case 'wedge':
      return [
        { z: 1.02, roof: 0.83, belt: 0.83, beltW: 0.8, roofW: 0.66 },
        { z: 0.62, roof: 1.02, belt: 0.86, beltW: 0.8, roofW: 0.6 },
        { z: 0.3, roof: 1.12, belt: 0.88, beltW: 0.79, roofW: 0.56 },
        { z: -0.4, roof: 1.12, belt: 0.88, beltW: 0.78, roofW: 0.56 },
        { z: -0.8, roof: 0.98, belt: 0.87, beltW: 0.77, roofW: 0.6 },
        { z: -1.05, roof: 0.85, belt: 0.85, beltW: 0.74, roofW: 0.64 },
      ];
    default:
      return [
        { z: 0.7, roof: 0.85, belt: 0.85, beltW: 0.76, roofW: 0.62 },
        { z: 0.32, roof: 1.08, belt: 0.89, beltW: 0.77, roofW: 0.58 },
        { z: 0.02, roof: 1.24, belt: 0.91, beltW: 0.77, roofW: 0.55 },
        { z: -0.55, roof: 1.25, belt: 0.91, beltW: 0.76, roofW: 0.55 },
        { z: -0.95, roof: 1.08, belt: 0.89, beltW: 0.75, roofW: 0.58 },
        { z: -1.18, roof: 0.86, belt: 0.86, beltW: 0.72, roofW: 0.62 },
      ];
  }
}

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
  const keys = cabinKeys(id);
  const secs: Section[] = keys
    .slice()
    .reverse()
    .map((k) => ({
      z: k.z,
      yb: 0.78,
      wb: k.beltW - 0.04,
      ys: k.belt,
      ws: k.beltW,
      yt: Math.max(k.roof, k.belt + 0.01),
      wt: k.roofW,
      crisp: 0.55,
    }));
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
  const zB = zWs + (zSideBack - zWs) * 0.48;

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
  // black belt trim and drip rail frame the side glass
  geo.trim.push(...both(cabinPatch(fine, 0.47, 0.51, zBack + 0.02, zFront - 0.02, 0.008, 2)));
  geo.chrome.push(...both(cabinPatch(fine, 0.735, 0.752, zSideBack, zWs + 0.02, 0.009, 1)));

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

  // side mirrors: painted housing, dark arm, reflective glass facing back
  const mk = keys[1];
  const mz = zWs + (zFront - zWs) * 0.45;
  const my = mk.belt + 0.07;
  const mx = keys[0].beltW + 0.15;
  const housing = rbox(0.17, 0.085, 0.1, 0.04, 3);
  housing.scale(1, 1, 1);
  place(housing, [mx, my, mz], [0, 0.12, 0]);
  geo.paint.push(...both(zoned(housing, ZONE.roof)));
  const glassM = rbox(0.14, 0.065, 0.01, 0.004);
  place(glassM, [mx - 0.005, my, mz - 0.052], [0, 0.12, 0]);
  geo.chrome.push(...both(glassM));
  const arm = rbox(0.13, 0.03, 0.05, 0.012);
  place(arm, [mx - 0.1, my - 0.035, mz + 0.01], [0, 0.12, -0.25]);
  geo.trim.push(...both(arm));

  // cowl and wipers at the base of the windscreen
  const cowlY = shell.surface.topY(0, zFront + 0.02, keys[0].belt);
  geo.trim.push(place(rbox(keys[0].beltW * 1.9, 0.02, 0.08, 0.008), [0, cowlY + 0.004, zFront + 0.03]));
  for (const x of [0.32, -0.12]) {
    geo.trim.push(place(rbox(0.5, 0.012, 0.016, 0.005), [x, cowlY + 0.03, zFront - 0.02], [0.5, 0.18, 0]));
  }

  // door handles sit in the doors, just ahead of the shut line
  const hz = -0.45;
  const hy = 0.72;
  const hx = shell.surface.sideX(hy, hz, 0.95);
  geo.chrome.push(...both(place(rbox(0.025, 0.028, 0.14, 0.012), [hx + 0.006, hy, hz])));

  // third brake light at the top of the rear glass
  const tbZ = zRg - 0.06;
  geo.tail.push(place(rbox(0.26, 0.018, 0.025, 0.008), [0, roofAt(tbZ) - 0.005, tbZ], [0.6, 0, 0]));
  return geo;
}

// ---------------------------------------------------------------- front details

function splitter(s: Surface, y: number, halfW: number, protrude: number, depth: number, thick: number): BufferGeometry {
  const front: [number, number][] = [];
  let lastZ = 2.0;
  for (let i = 0; i <= 14; i++) {
    const x = -halfW + (2 * halfW * i) / 14;
    const h = s.cast(new Vector3(x, y + 0.05, 4), new Vector3(0, 0, -1));
    if (h) lastZ = h.point.z;
    front.push([x, lastZ + protrude - 0.06 * (Math.abs(x) / halfW) ** 4]);
  }
  const back = Math.min(...front.map((p) => p[1])) - depth;
  const outline: [number, number][] = [...front, [halfW * 0.92, back], [-halfW * 0.92, back]];
  return plateXZ(outline, thick, y, 0.006);
}

/** Grille: a dark surround filled with a diagonal mesh of thin bars. */
function meshGrille(w: number, h: number, bucket: BufferGeometry[]): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  out.push(rbox(w, h, 0.05, Math.min(h, w) * 0.3));
  const n = Math.round(w / 0.05);
  for (let i = 0; i <= n; i++) {
    for (const s of [1, -1]) {
      const bar = new BoxGeometry(0.008, h * 1.25, 0.012);
      bar.rotateZ(s * 0.75);
      bar.translate(-w / 2 + (w * i) / n, 0, 0.03);
      // clip the bar to the opening by squashing what sticks out
      const p = bar.getAttribute('position');
      for (let k = 0; k < p.count; k++) {
        p.setX(k, Math.max(-w / 2 + 0.01, Math.min(w / 2 - 0.01, p.getX(k))));
        p.setY(k, Math.max(-h / 2 + 0.01, Math.min(h / 2 - 0.01, p.getY(k))));
      }
      bar.computeVertexNormals();
      bucket.push(bar);
    }
  }
  return out;
}

export function frontPart(id: string, s: Surface): PartGeo {
  const g = emptyPart();
  if (id === 'muscle') {
    // tall chrome-framed grille with vertical bars and a badge
    const gy = 0.52;
    const frame = rbox(0.86, 0.24, 0.05, 0.03);
    g.chrome.push(onFace(s, 1, 0, gy, 0.02, frame));
    g.trim.push(onFace(s, 1, 0, gy, 0.0, rbox(0.8, 0.19, 0.05, 0.02)));
    for (let i = -6; i <= 6; i++) g.chrome.push(onFace(s, 1, i * 0.058, gy, -0.005, rbox(0.01, 0.17, 0.02, 0.004)));
    g.chrome.push(onFace(s, 1, 0, gy, -0.03, cyl(0.035, 0.012, 20).rotateX(Math.PI / 2)));
    // chrome bumper bar with over-riders
    const fz = s.faceZ(0, 0.33, 1, 2.1).z;
    const bar = new CylinderGeometry(0.035, 0.035, 1.56, 14);
    place(bar, [0, 0.33, fz + 0.05], [0, 0, Math.PI / 2]);
    g.chrome.push(bar);
    for (const x of [0.3, -0.3]) g.chrome.push(place(rbox(0.06, 0.13, 0.08, 0.025), [x, 0.33, fz + 0.06]));
    // lower valance intake and round fog lamps
    g.trim.push(onFace(s, 1, 0, 0.24, 0.01, rbox(1.1, 0.07, 0.06, 0.02)));
    for (const x of [0.62, -0.62]) {
      g.chrome.push(onFace(s, 1, x, 0.42, -0.01, new TorusGeometry(0.045, 0.01, 6, 18)));
      g.glass.push(onFace(s, 1, x, 0.42, 0.0, new CircleGeometry(0.045, 18)));
      g.light.push(onFace(s, 1, x, 0.42, 0.006, new CircleGeometry(0.018, 10)));
    }
  } else if (id === 'aggressive') {
    // carbon splitter following the nose, with end plates
    g.carbon.push(splitter(s, 0.2, 0.78, 0.07, 0.3, 0.02));
    for (const x of [0.79, -0.79]) {
      const z = s.faceZ(x * 0.9, 0.24, 1, 2.0).z;
      g.carbon.push(plateZY([[z + 0.06, 0.18], [z - 0.2, 0.18], [z - 0.2, 0.3], [z - 0.02, 0.27]], 0.015, x));
    }
    // big centre intake with mesh and side intakes with canards
    const ci: BufferGeometry[] = [];
    for (const m of meshGrille(0.62, 0.11, ci)) g.trim.push(onFace(s, 1, 0, 0.29, 0.025, m));
    for (const b of ci) g.carbon.push(onFace(s, 1, 0, 0.29, 0.025, b));
    for (const x of [0.52, -0.52]) {
      const side = x > 0 ? 1 : -1;
      g.trim.push(onFace(s, 1, x, 0.3, 0.03, rbox(0.3, 0.12, 0.06, 0.03), [0, 0, side * -0.18]));
      const z = s.faceZ(x * 1.55, 0.36, 1, 2.0).z;
      g.carbon.push(place(rbox(0.2, 0.012, 0.15, 0.005), [x * 1.55, 0.37, z - 0.08], [0, 0, side * 0.22]));
    }
    // vertical air curtains in the corners
    for (const x of [0.74, -0.74]) g.trim.push(onFace(s, 1, x, 0.33, 0.03, rbox(0.04, 0.14, 0.05, 0.015)));
  } else {
    // classic: oval grille with a chrome bar, fog lamps and a slim lip
    const grille: BufferGeometry[] = [];
    for (const m of meshGrille(0.6, 0.12, grille)) g.trim.push(onFace(s, 1, 0, 0.38, 0.02, m));
    for (const b of grille) g.trim.push(onFace(s, 1, 0, 0.38, 0.02, b));
    g.chrome.push(onFace(s, 1, 0, 0.38, -0.005, new TorusGeometry(0.3, 0.008, 4, 40).scale(1, 0.26, 1)));
    g.chrome.push(onFace(s, 1, 0, 0.395, -0.012, rbox(0.62, 0.014, 0.02, 0.005)));
    g.chrome.push(onFace(s, 1, 0, 0.395, -0.024, cyl(0.03, 0.01, 16).rotateX(Math.PI / 2)));
    for (const x of [0.58, -0.58]) {
      g.trim.push(onFace(s, 1, x, 0.31, 0.02, rbox(0.2, 0.07, 0.05, 0.03)));
      g.glass.push(onFace(s, 1, x, 0.31, -0.008, new CircleGeometry(0.028, 14)));
      g.light.push(onFace(s, 1, x, 0.31, -0.01, new CircleGeometry(0.012, 8)));
    }
    g.trim.push(splitter(s, 0.24, 0.66, 0.025, 0.12, 0.02));
  }
  return g;
}

// ---------------------------------------------------------------- rear details

export function rearPart(id: string, s: Surface): PartGeo {
  const g = emptyPart();
  if (id === 'kamm') {
    // duck-tail lip
    const lipZ = s.faceZ(0, 0.82, -1, -2.1).z;
    g.paint.push(zoned(plateZY([[lipZ + 0.2, 0.86], [lipZ - 0.06, 0.92], [lipZ - 0.07, 0.9], [lipZ + 0.02, 0.84]], 1.42, 0, 0.01), ZONE.rear));
    // four round tail lamps: lit ring, dark centre, chrome bezel
    for (const x of [0.66, 0.42]) {
      for (const sx of [x, -x]) {
        g.chrome.push(onFace(s, -1, sx, 0.66, 0.0, new TorusGeometry(0.085, 0.014, 6, 22)));
        g.tail.push(onFace(s, -1, sx, 0.66, -0.004, new TorusGeometry(0.055, 0.02, 6, 22)));
        g.trim.push(onFace(s, -1, sx, 0.66, 0.0, new CircleGeometry(0.075, 20)));
        g.tail.push(onFace(s, -1, sx, 0.66, -0.008, new CircleGeometry(0.018, 10)));
      }
    }
    // full-width bumper with a lower diffuser hint and reverse lamps
    g.trim.push(onFace(s, -1, 0, 0.3, 0.02, rbox(1.5, 0.14, 0.08, 0.03)));
    for (let i = -3; i <= 3; i++) g.trim.push(onFace(s, -1, i * 0.12, 0.25, -0.03, rbox(0.012, 0.08, 0.12, 0.004)));
    for (const x of [0.3, -0.3]) g.light.push(onFace(s, -1, x, 0.47, -0.002, rbox(0.12, 0.03, 0.02, 0.008)));
    g.chrome.push(onFace(s, -1, 0, 0.55, -0.002, rbox(0.24, 0.02, 0.012, 0.006)));
  } else if (id === 'diffuser') {
    // slim light bar with a dark frame across the tail
    g.trim.push(onFace(s, -1, 0, 0.64, 0.0, rbox(1.44, 0.075, 0.04, 0.02)));
    g.tail.push(onFace(s, -1, 0, 0.645, -0.008, rbox(1.38, 0.028, 0.03, 0.01)));
    for (const x of [0.6, -0.6]) g.tail.push(onFace(s, -1, x, 0.62, -0.01, rbox(0.18, 0.02, 0.02, 0.008)));
    // rain light
    g.tail.push(onFace(s, -1, 0, 0.36, -0.03, rbox(0.12, 0.05, 0.03, 0.01)));
    // diffuser: carbon floor rising to the tail with tall strakes
    const tailZ = s.faceZ(0, 0.4, -1, -2.14).z;
    const floor = new BoxGeometry(1.2, 0.02, 0.62);
    place(floor, [0, 0.235, tailZ + 0.22], [-0.22, 0, 0]);
    g.carbon.push(floor);
    for (let i = -3; i <= 3; i++) {
      g.carbon.push(plateZY([[tailZ + 0.42, 0.24], [tailZ - 0.06, 0.2], [tailZ - 0.06, 0.38], [tailZ + 0.3, 0.3]], 0.012, i * 0.2));
    }
    g.trim.push(onFace(s, -1, 0, 0.47, 0.01, rbox(1.2, 0.1, 0.05, 0.03)));
  } else {
    // tapered: wrap-around light bar following the tail, chrome strip above
    for (let i = -6; i <= 6; i++) {
      const x = i * 0.1;
      g.tail.push(onFace(s, -1, x, 0.66, -0.004, rbox(0.094, 0.04, 0.03, 0.01)));
    }
    g.trim.push(onFace(s, -1, 0, 0.66, 0.0, rbox(1.3, 0.055, 0.03, 0.02)));
    g.chrome.push(onFace(s, -1, 0, 0.705, -0.004, rbox(1.0, 0.012, 0.02, 0.005)));
    // bumper, plate recess, reverse lamps and a small diffuser
    g.trim.push(onFace(s, -1, 0, 0.34, 0.03, rbox(1.2, 0.12, 0.08, 0.04)));
    g.trim.push(onFace(s, -1, 0, 0.5, 0.025, rbox(0.42, 0.11, 0.05, 0.015)));
    for (const x of [0.36, -0.36]) g.light.push(onFace(s, -1, x, 0.48, -0.004, rbox(0.1, 0.025, 0.02, 0.008)));
    for (let i = -2; i <= 2; i++) g.carbon.push(onFace(s, -1, i * 0.14, 0.27, -0.02, rbox(0.012, 0.07, 0.1, 0.004)));
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
    for (const x of [0.33, -0.33]) {
      const zc = z0 + len * 0.55;
      const vlen = Math.min(0.46, len * 0.75);
      const y = topAt(x, zc);
      const rot: [number, number, number] = [slope(x, zc - 0.15, zc + 0.15), 0, 0];
      g.carbon.push(place(rbox(0.36, 0.028, vlen, 0.012), [x, y + 0.004, zc], rot));
      g.trim.push(place(rbox(0.3, 0.02, vlen - 0.06, 0.008), [x, y + 0.012, zc], rot));
      const n = 7;
      for (let k = 0; k < n; k++) {
        const zz = zc - vlen / 2 + 0.05 + (k * (vlen - 0.1)) / (n - 1);
        g.carbon.push(place(rbox(0.29, 0.008, 0.045, 0.003), [x, topAt(x, zz) + 0.024, zz], [rot[0] - 0.5, 0, 0]));
      }
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
    // power bulge with two sharp creases
    const secs: Section[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const z = z0 + len * t;
      const y = topAt(0, z);
      const k = Math.sin(t * Math.PI) ** 0.5;
      secs.push({ z, yb: y - 0.03, wb: 0.32 * k + 0.02, ys: y + 0.005, ws: 0.36 * k + 0.02, yt: y + 0.012 + 0.022 * k, wt: 0.22 * k + 0.01, crisp: 0.95 });
    }
    g.paint.push(zoned(loft(secs, { capStart: true, capEnd: true }), ZONE.hood));
    // washer jets
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

export function headlightPart(id: string, front: Surface): PartGeo {
  const g = emptyPart();
  const { x, y } = SKELETON.headlight;
  const hit = front.faceZ(x, y, 1, 2.0);
  const n = hit.normal.clone();
  // orient each unit roughly with the surface (yaw + pitch), mirrored for the left side
  const yaw = Math.atan2(n.x, Math.max(0.2, n.z));
  const pitch = -Math.atan2(n.y, Math.max(0.2, n.z));
  const add = (geo: BufferGeometry, bucket: BufferGeometry[], off: [number, number, number], extraRot: [number, number, number] = [0, 0, 0]) => {
    const p = new Vector3(x, y, hit.z).add(new Vector3(...off));
    place(geo, p, [pitch + extraRot[0], yaw + extraRot[1], extraRot[2]]);
    bucket.push(...both(geo));
  };
  if (id === 'round') {
    add(rbox(0.4, 0.17, 0.1, 0.06), g.trim, [0, 0, -0.035]);
    add(rbox(0.36, 0.13, 0.02, 0.05), g.chrome, [0, 0, 0.008]);
    for (const dx of [-0.09, 0.09]) {
      // reflector cup, projector lens and a chrome ring
      const cup = new LatheGeometry([new Vector2(0.02, -0.02), new Vector2(0.045, 0.0), new Vector2(0.062, 0.025)], 18);
      add(cup.rotateX(Math.PI / 2), g.chrome, [dx, 0, 0.0]);
      const lens = new SphereGeometry(0.04, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      add(lens.rotateX(Math.PI / 2), g.light, [dx, 0, 0.006]);
      add(new TorusGeometry(0.064, 0.009, 6, 22), g.chrome, [dx, 0, 0.028]);
    }
    // amber-free DRL ring under the lamps
    add(rbox(0.3, 0.01, 0.01, 0.004), g.light, [0, -0.065, 0.03]);
  } else if (id === 'slit') {
    add(rbox(0.44, 0.1, 0.1, 0.03), g.trim, [0, 0.01, -0.035], [0, 0, 0.14]);
    add(rbox(0.38, 0.05, 0.02, 0.012), g.chrome, [0.0, 0.008, 0.008], [0, 0, 0.14]);
    add(rbox(0.36, 0.02, 0.03, 0.008), g.light, [0, 0.022, 0.018], [0, 0, 0.14]);
    add(rbox(0.12, 0.016, 0.03, 0.006), g.light, [0.13, -0.022, 0.018], [0, 0, -0.5]);
    for (const dx of [-0.11, -0.03, 0.05]) add(cyl(0.012, 0.02, 10).rotateX(Math.PI / 2), g.light, [dx, -0.008 + dx * 0.14, 0.02]);
  } else {
    add(rbox(0.48, 0.085, 0.1, 0.035), g.trim, [0, 0, -0.035]);
    add(rbox(0.44, 0.05, 0.02, 0.02), g.chrome, [0, -0.004, 0.006]);
    add(rbox(0.43, 0.018, 0.03, 0.008), g.light, [0, 0.022, 0.016]);
    for (let k = 0; k < 4; k++) add(cyl(0.013, 0.02, 10).rotateX(Math.PI / 2), g.light, [-0.15 + k * 0.05, -0.012, 0.02]);
  }
  return g;
}

// ---------------------------------------------------------------- exhaust

export interface ExhaustInfo {
  geo: PartGeo;
  /** tip positions (car space) where boost flames come out */
  tips: Vector3[];
}

export function exhaustPart(id: string, rear: Surface): ExhaustInfo {
  const g = emptyPart();
  const y = SKELETON.exhaustY;
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

export function tireGeometry(): BufferGeometry {
  const R = SKELETON.wheelRadius;
  const W = SKELETON.wheelWidth;
  const rim = 0.245;
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
  const R = 0.245;
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
        const sp = new BoxGeometry(0.016, 0.19, 0.013);
        sp.translate(0, 0.135, 0);
        sp.rotateX(a + s * 0.2);
        sp.translate(face - 0.005 + (s > 0 ? 0.004 : 0), 0, 0);
        main.push(sp);
      }
    }
    const ring = new TorusGeometry(0.16, 0.008, 4, 36).rotateY(Math.PI / 2);
    ring.translate(face, 0, 0);
    main.push(ring);
  } else if (id === 'turbine') {
    const disc = cyl(R - 0.012, 0.02, 32).rotateZ(Math.PI / 2);
    disc.translate(face - 0.03, 0, 0);
    accent.push(disc);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const b = new BoxGeometry(0.035, 0.16, 0.035);
      const p = b.getAttribute('position');
      for (let k = 0; k < p.count; k++) p.setZ(k, p.getZ(k) * (0.5 + (p.getY(k) + 0.08) * 6));
      b.computeVertexNormals();
      b.rotateY(0.65);
      b.translate(0, 0.145, 0);
      b.rotateX(a);
      b.translate(face - 0.005, 0, 0);
      main.push(b);
    }
  } else {
    // five split spokes, tapered and dished
    for (let i = 0; i < 5; i++) {
      for (const s of [-1, 1]) {
        const a = (i / 5) * Math.PI * 2 + s * 0.13;
        const sp = new BoxGeometry(0.04, 0.17, 0.028);
        const pos = sp.getAttribute('position');
        for (let k = 0; k < pos.count; k++) {
          const t = (pos.getY(k) + 0.085) / 0.17;
          pos.setZ(k, pos.getZ(k) * (1.25 - 0.45 * t) + s * t * 0.012);
          pos.setX(k, pos.getX(k) - t * 0.035);
        }
        sp.computeVertexNormals();
        sp.translate(0, 0.15, 0);
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
