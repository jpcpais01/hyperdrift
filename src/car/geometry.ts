import {
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Shape,
  TorusGeometry,
  Vector2,
  Vector3,
  Euler,
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { loft, refine, type Section } from './loft';
import { joint, SKELETON } from './skeleton';

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

function rbox(w: number, h: number, d: number, r = 0.02): BufferGeometry {
  const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  return new RoundedBoxGeometry(w, h, d, 2, Math.max(0.001, rr));
}

function mirrorX(g: BufferGeometry): BufferGeometry {
  const m = g.clone();
  m.applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
  // flip winding so normals stay outward
  const idx = m.getIndex();
  if (idx) {
    const a = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    idx.needsUpdate = true;
  }
  m.computeVertexNormals();
  return m;
}

const both = (g: BufferGeometry) => [g, mirrorX(g)];

/** Finds a surface by casting a ray against a set of geometries. */
export class Surface {
  private meshes: Mesh[];
  private ray = new Raycaster();
  private static mat = new MeshBasicMaterial({ side: DoubleSide });
  constructor(geos: BufferGeometry[]) {
    this.meshes = geos.map((g) => {
      const m = new Mesh(g, Surface.mat);
      m.updateMatrixWorld();
      return m;
    });
  }
  cast(origin: Vector3, dir: Vector3): { point: Vector3; normal: Vector3 } | null {
    this.ray.set(origin, dir.clone().normalize());
    const hits = this.ray.intersectObjects(this.meshes, false);
    if (!hits.length || !hits[0].face) return null;
    const n = hits[0].face.normal.clone();
    if (n.dot(dir) > 0) n.negate();
    return { point: hits[0].point.clone(), normal: n };
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
}

// ---------------------------------------------------------------- body (hull + cabin)

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
          { z: -1.05, yb: 0.25, wb: 0.64, ys: 0.71, ws: 1.02, yt: 0.86, wt: 0.84, crisp: 0.65 },
          { z: -0.4, yb: 0.25, wb: 0.63, ys: 0.69, ws: 0.96, yt: 0.83, wt: 0.83, crisp: 0.65 },
          { z: 0.45, yb: 0.25, wb: 0.63, ys: 0.69, ws: 0.95, yt: 0.83, wt: 0.83, crisp: 0.65 },
          { z: 1.05, yb: 0.25, wb: 0.63, ys: 0.7, ws: 1.0, yt: 0.85, wt: 0.82, crisp: 0.65 },
          joint(1.45),
        ],
      };
    case 'wedge':
      return {
        hoodStart: 1.04,
        hull: [
          joint(-1.45),
          { z: -0.95, yb: 0.25, wb: 0.65, ys: 0.68, ws: 1.04, yt: 0.86, wt: 0.88, crisp: 0.85 },
          { z: -0.2, yb: 0.25, wb: 0.64, ys: 0.66, ws: 0.98, yt: 0.82, wt: 0.84, crisp: 0.85 },
          { z: 0.6, yb: 0.25, wb: 0.64, ys: 0.67, ws: 1.0, yt: 0.82, wt: 0.84, crisp: 0.85 },
          { z: 1.1, yb: 0.25, wb: 0.63, ys: 0.7, ws: 1.02, yt: 0.83, wt: 0.84, crisp: 0.7 },
          joint(1.45),
        ],
      };
    default:
      return {
        hoodStart: 0.72,
        hull: [
          joint(-1.45),
          { z: -1.0, yb: 0.25, wb: 0.64, ys: 0.71, ws: 1.01, yt: 0.87, wt: 0.84, crisp: 0.72 },
          { z: -0.4, yb: 0.25, wb: 0.63, ys: 0.69, ws: 0.96, yt: 0.84, wt: 0.83, crisp: 0.72 },
          { z: 0.4, yb: 0.25, wb: 0.63, ys: 0.69, ws: 0.96, yt: 0.84, wt: 0.83, crisp: 0.72 },
          { z: 1.0, yb: 0.25, wb: 0.63, ys: 0.7, ws: 0.99, yt: 0.85, wt: 0.82, crisp: 0.72 },
          joint(1.45),
        ],
      };
  }
}

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

export function bodyPart(id: string): { geo: PartGeo; info: BodyInfo } {
  const info = bodySections(id);
  const geo = emptyPart();
  geo.paint.push(loft(refine(info.hull, 5)));

  // greenhouse: glass loft with a painted roof panel on top
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
  geo.glass.push(loft(refine(secs, 5), { capStart: true, capEnd: true }));

  // roof panel: the flattest, highest part of the cabin
  const top = keys.filter((k) => k.roof > Math.max(...keys.map((q) => q.roof)) - 0.07);
  const zs = top.map((k) => k.z);
  const zMin = Math.min(...zs) - 0.06;
  const zMax = Math.max(...zs) + 0.04;
  const roofAt = (z: number) => {
    // linear interpolation along the keys
    const ks = keys.slice().sort((a, b) => a.z - b.z);
    for (let i = 0; i < ks.length - 1; i++) {
      if (z >= ks[i].z && z <= ks[i + 1].z) {
        const t = (z - ks[i].z) / (ks[i + 1].z - ks[i].z);
        return { y: ks[i].roof + (ks[i + 1].roof - ks[i].roof) * t, w: ks[i].roofW + (ks[i + 1].roofW - ks[i].roofW) * t };
      }
    }
    return { y: ks[0].roof, w: ks[0].roofW };
  };
  const roofSecs: Section[] = [];
  for (let i = 0; i <= 6; i++) {
    const z = zMin + ((zMax - zMin) * i) / 6;
    const r = roofAt(z);
    const edge = i === 0 || i === 6 ? 0.6 : 1;
    roofSecs.push({ z, yb: r.y - 0.03, wb: (r.w - 0.02) * edge, ys: r.y - 0.005, ws: (r.w + 0.015) * edge, yt: r.y + 0.02, wt: (r.w - 0.06) * edge, crisp: 0.3 });
  }
  geo.paint.push(loft(roofSecs, { capStart: true, capEnd: true }));

  // side mirrors (painted caps on a trim stalk)
  const mk = keys.slice().sort((a, b) => b.z - a.z)[1];
  const mirror = rbox(0.14, 0.08, 0.12, 0.03);
  place(mirror, [mk.beltW + 0.1, mk.belt + 0.05, mk.z + 0.02]);
  geo.paint.push(...both(mirror));
  const stalk = rbox(0.12, 0.02, 0.04, 0.008);
  place(stalk, [mk.beltW + 0.02, mk.belt + 0.03, mk.z + 0.02]);
  geo.trim.push(...both(stalk));

  return { geo, info };
}

// ---------------------------------------------------------------- front

export function frontPart(id: string): PartGeo {
  const g = emptyPart();
  let secs: Section[];
  if (id === 'muscle') {
    secs = [
      joint(1.45),
      { z: 1.75, yb: 0.26, wb: 0.62, ys: 0.68, ws: 0.97, yt: 0.85, wt: 0.82, crisp: 0.85 },
      { z: 2.0, yb: 0.27, wb: 0.6, ys: 0.64, ws: 0.96, yt: 0.8, wt: 0.78, crisp: 0.95 },
      { z: 2.1, yb: 0.28, wb: 0.56, ys: 0.6, ws: 0.92, yt: 0.74, wt: 0.72, crisp: 0.95 },
    ];
    g.paint.push(loft(refine(secs, 4), { capEnd: true }));
    const s = new Surface(g.paint);
    const fz = s.faceZ(0, 0.5, 1, 2.1).z;
    g.trim.push(place(rbox(0.74, 0.2, 0.08, 0.02), [0, 0.52, fz - 0.02]));
    for (let i = -3; i <= 3; i++) g.chrome.push(place(rbox(0.012, 0.18, 0.02, 0.004), [i * 0.1, 0.52, fz + 0.025]));
    const bar = new CylinderGeometry(0.035, 0.035, 1.78, 12);
    place(bar, [0, 0.33, fz + 0.06], [0, 0, Math.PI / 2]);
    g.chrome.push(bar);
    g.trim.push(place(rbox(1.2, 0.08, 0.1, 0.02), [0, 0.24, fz - 0.01]));
  } else if (id === 'aggressive') {
    secs = [
      joint(1.45),
      { z: 1.72, yb: 0.25, wb: 0.62, ys: 0.65, ws: 0.96, yt: 0.8, wt: 0.78, crisp: 0.75 },
      { z: 1.98, yb: 0.23, wb: 0.6, ys: 0.52, ws: 0.93, yt: 0.66, wt: 0.68, crisp: 0.85 },
      { z: 2.12, yb: 0.22, wb: 0.56, ys: 0.4, ws: 0.86, yt: 0.5, wt: 0.58, crisp: 0.9 },
      { z: 2.2, yb: 0.22, wb: 0.42, ys: 0.32, ws: 0.7, yt: 0.38, wt: 0.42, crisp: 0.9 },
    ];
    g.paint.push(loft(refine(secs, 4), { capEnd: true }));
    const s = new Surface(g.paint);
    const fz = s.faceZ(0, 0.3, 1, 2.2).z;
    // splitter
    g.carbon.push(place(rbox(1.76, 0.03, 0.3, 0.01), [0, 0.17, fz - 0.06]));
    // side intakes
    for (const x of [0.52, -0.52]) {
      const z = s.faceZ(x, 0.3, 1, 2.1).z;
      g.trim.push(place(rbox(0.32, 0.12, 0.12, 0.03), [x, 0.3, z - 0.03], [0, x > 0 ? 0.35 : -0.35, 0]));
      g.carbon.push(place(rbox(0.2, 0.015, 0.16, 0.005), [x * 1.65, 0.36, z - 0.12], [0, 0, x > 0 ? 0.25 : -0.25]));
    }
    g.trim.push(place(rbox(0.5, 0.07, 0.1, 0.03), [0, 0.3, fz - 0.03]));
  } else {
    secs = [
      joint(1.45),
      { z: 1.75, yb: 0.25, wb: 0.62, ys: 0.66, ws: 0.95, yt: 0.8, wt: 0.78, crisp: 0.6 },
      { z: 2.0, yb: 0.24, wb: 0.58, ys: 0.56, ws: 0.9, yt: 0.68, wt: 0.64, crisp: 0.4 },
      { z: 2.13, yb: 0.25, wb: 0.5, ys: 0.46, ws: 0.8, yt: 0.56, wt: 0.5, crisp: 0.35 },
      { z: 2.19, yb: 0.28, wb: 0.32, ys: 0.4, ws: 0.6, yt: 0.48, wt: 0.3, crisp: 0.3 },
    ];
    g.paint.push(loft(refine(secs, 4), { capEnd: true }));
    const s = new Surface(g.paint);
    const fz = s.faceZ(0, 0.38, 1, 2.2).z;
    g.trim.push(place(rbox(0.62, 0.12, 0.08, 0.04), [0, 0.38, fz - 0.025]));
    g.chrome.push(place(rbox(0.66, 0.016, 0.02, 0.006), [0, 0.45, fz + 0.005]));
    for (const x of [0.6, -0.6]) {
      const z = s.faceZ(x, 0.32, 1, 2.0).z;
      g.trim.push(place(rbox(0.22, 0.06, 0.1, 0.025), [x, 0.32, z - 0.03]));
    }
  }
  return g;
}

// ---------------------------------------------------------------- rear

export function rearPart(id: string): PartGeo {
  const g = emptyPart();
  if (id === 'kamm') {
    const secs: Section[] = [
      { z: -2.1, yb: 0.3, wb: 0.56, ys: 0.64, ws: 0.92, yt: 0.86, wt: 0.74, crisp: 0.95 },
      { z: -1.82, yb: 0.27, wb: 0.6, ys: 0.68, ws: 0.96, yt: 0.86, wt: 0.83, crisp: 0.75 },
      joint(-1.45),
    ];
    g.paint.push(loft(refine(secs, 4), { capStart: true }));
    const s = new Surface(g.paint);
    // duck-tail lip
    g.paint.push(place(rbox(1.46, 0.035, 0.18, 0.012), [0, 0.88, -2.06], [-0.28, 0, 0]));
    for (const x of [0.66, 0.42]) {
      const z = s.faceZ(x, 0.66, -1, -2.1).z;
      for (const sx of [x, -x]) {
        const c = new CylinderGeometry(0.075, 0.075, 0.04, 20);
        place(c, [sx, 0.66, z - 0.005], [Math.PI / 2, 0, 0]);
        g.tail.push(c);
        const r = new TorusGeometry(0.085, 0.012, 6, 20);
        place(r, [sx, 0.66, z - 0.02]);
        g.chrome.push(r);
      }
    }
    const fz = s.faceZ(0, 0.3, -1, -2.1).z;
    g.trim.push(place(rbox(1.5, 0.14, 0.12, 0.03), [0, 0.3, fz + 0.02]));
  } else if (id === 'diffuser') {
    const secs: Section[] = [
      { z: -2.14, yb: 0.32, wb: 0.5, ys: 0.58, ws: 0.84, yt: 0.74, wt: 0.66, crisp: 0.85 },
      { z: -1.95, yb: 0.29, wb: 0.58, ys: 0.66, ws: 0.95, yt: 0.82, wt: 0.78, crisp: 0.75 },
      joint(-1.45),
    ];
    g.paint.push(loft(refine(secs, 4), { capStart: true }));
    const s = new Surface(g.paint);
    const fz = s.faceZ(0, 0.6, -1, -2.14).z;
    g.tail.push(place(rbox(1.36, 0.035, 0.03, 0.012), [0, 0.64, fz - 0.005]));
    g.trim.push(place(rbox(1.42, 0.07, 0.04, 0.02), [0, 0.64, fz + 0.01]));
    // diffuser
    g.carbon.push(place(rbox(1.6, 0.03, 0.5, 0.01), [0, 0.2, -2.0], [0.18, 0, 0]));
    for (let i = -2; i <= 2; i++) g.carbon.push(place(rbox(0.02, 0.1, 0.36, 0.006), [i * 0.32, 0.25, -2.0], [0.18, 0, 0]));
  } else {
    const secs: Section[] = [
      { z: -2.16, yb: 0.32, wb: 0.36, ys: 0.5, ws: 0.62, yt: 0.66, wt: 0.42, crisp: 0.35 },
      { z: -2.08, yb: 0.29, wb: 0.52, ys: 0.58, ws: 0.84, yt: 0.76, wt: 0.62, crisp: 0.4 },
      { z: -1.82, yb: 0.27, wb: 0.6, ys: 0.66, ws: 0.95, yt: 0.83, wt: 0.8, crisp: 0.6 },
      joint(-1.45),
    ];
    g.paint.push(loft(refine(secs, 4), { capStart: true }));
    const s = new Surface(g.paint);
    // wrap-around light bar following the tail
    for (let i = -6; i <= 6; i++) {
      const x = i * 0.1;
      const z = s.faceZ(x, 0.66, -1, -2.1).z;
      g.tail.push(place(rbox(0.105, 0.04, 0.03, 0.01), [x, 0.66, z + 0.004]));
    }
    const fz = s.faceZ(0, 0.38, -1, -2.1).z;
    g.trim.push(place(rbox(1.2, 0.12, 0.12, 0.04), [0, 0.34, fz + 0.03]));
  }
  return g;
}

// ---------------------------------------------------------------- hood

export function hoodPart(id: string, surface: Surface, hoodStart: number): PartGeo {
  const g = emptyPart();
  const z0 = hoodStart + 0.08;
  const z1 = SKELETON.frontJointZ + 0.15;
  const len = z1 - z0;
  if (len < 0.15) return g;
  const topAt = (x: number, z: number) => surface.topY(x, z, 0.84);
  const slope = (x: number, za: number, zb: number) => Math.atan2(topAt(x, za) - topAt(x, zb), zb - za);
  if (id === 'scoop') {
    const zc = z0 + len * 0.45;
    const h = topAt(0, zc);
    const secs: Section[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const z = z0 + len * (0.15 + 0.7 * t);
      const y = topAt(0, z);
      const k = Math.sin(t * Math.PI) ** 0.6;
      const height = 0.02 + 0.08 * (1 - t) * k + 0.01;
      secs.push({ z, yb: y - 0.03, wb: 0.18 + 0.06 * k, ys: y + height * 0.4, ws: 0.2 + 0.07 * k, yt: y + height, wt: 0.14 + 0.05 * k, crisp: 0.7 });
    }
    g.paint.push(loft(secs, { capStart: true, capEnd: true }));
    const front = secs[secs.length - 1];
    void h;
    g.trim.push(place(rbox(0.36, 0.06, 0.04, 0.015), [0, front.yt - 0.04, front.z - 0.2]));
    const zf = z0 + len * 0.3;
    g.trim.push(place(rbox(0.34, 0.05, 0.06, 0.02), [0, topAt(0, zf) + 0.05, zf + 0.02], [slope(0, zf - 0.1, zf + 0.1), 0, 0]));
  } else if (id === 'vented') {
    for (const x of [0.36, -0.36]) {
      const zc = z0 + len * 0.55;
      const y = topAt(x, zc);
      const rot: [number, number, number] = [slope(x, zc - 0.15, zc + 0.15), 0, 0];
      g.carbon.push(place(rbox(0.34, 0.03, Math.min(0.42, len * 0.7), 0.012), [x, y + 0.003, zc], rot));
      for (let k = -2; k <= 2; k++) {
        const zz = zc + k * Math.min(0.07, len * 0.12);
        g.trim.push(place(rbox(0.3, 0.02, 0.025, 0.006), [x, topAt(x, zz) + 0.018, zz], rot));
      }
    }
  } else {
    // power bulge with a crease
    const secs: Section[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const z = z0 + len * t;
      const y = topAt(0, z);
      const k = Math.sin(t * Math.PI) ** 0.5;
      secs.push({ z, yb: y - 0.03, wb: 0.3 * k + 0.02, ys: y + 0.005, ws: 0.34 * k + 0.02, yt: y + 0.012 + 0.018 * k, wt: 0.2 * k + 0.01, crisp: 0.3 });
    }
    g.paint.push(loft(secs, { capStart: true, capEnd: true }));
  }
  return g;
}

// ---------------------------------------------------------------- skirts

export function skirtPart(id: string): PartGeo {
  const g = emptyPart();
  const [za, zb] = SKELETON.skirtZ;
  const len = zb - za;
  const zc = (za + zb) / 2;
  if (id === 'blade') {
    g.paint.push(...both(place(rbox(0.26, 0.2, len, 0.05), [0.78, 0.3, zc])));
    g.carbon.push(...both(place(rbox(0.2, 0.025, len + 0.06, 0.01), [0.86, 0.19, zc])));
  } else if (id === 'wide') {
    g.paint.push(...both(place(rbox(0.34, 0.26, len, 0.08), [0.8, 0.31, zc])));
    for (let k = 0; k < 3; k++) {
      g.trim.push(...both(place(rbox(0.04, 0.16, 0.05, 0.015), [0.96, 0.32, za + 0.12 + k * 0.09])));
    }
  } else {
    g.paint.push(...both(place(rbox(0.22, 0.16, len, 0.05), [0.76, 0.3, zc])));
    g.trim.push(...both(place(rbox(0.2, 0.03, len - 0.04, 0.01), [0.78, 0.215, zc])));
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
  const g = new ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 8 });
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
    const wing = airfoil(0.4, 0.06, 1.86);
    place(wing, [0, h, z - 0.05], [-0.12, 0, 0]);
    g.carbon.push(wing);
    for (const x of [0.95, -0.95]) g.carbon.push(place(rbox(0.02, 0.24, 0.48, 0.008), [x, h - 0.02, z - 0.05]));
    for (const x of [0.42, -0.42]) {
      const top = h;
      const base = surface.topY(x, z + 0.05, deck) - 0.02;
      g.trim.push(place(rbox(0.03, top - base, 0.16, 0.01), [x, (top + base) / 2, z + 0.05]));
    }
  } else if (id === 'mid') {
    const h = deck + 0.2;
    const wing = airfoil(0.3, 0.045, 1.5);
    place(wing, [0, h, z - 0.04], [-0.08, 0, 0]);
    g.paint.push(wing);
    for (const x of [0.45, -0.45]) {
      const base = surface.topY(x, z, deck) - 0.02;
      g.trim.push(place(rbox(0.03, h - base, 0.12, 0.01), [x, (h + base) / 2, z]));
    }
  } else {
    const zz = z - 0.1;
    const y = Math.min(surface.topY(0, zz, deck), surface.topY(0.6, zz, deck));
    g.paint.push(place(rbox(1.3, 0.035, 0.14, 0.012), [0, y + 0.03, zz], [-0.3, 0, 0]));
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
    add(rbox(0.38, 0.15, 0.1, 0.05), g.trim, [0, 0, -0.03]);
    for (const dx of [-0.09, 0.09]) {
      const lens = new CylinderGeometry(0.058, 0.058, 0.03, 20);
      add(lens, g.light, [dx, 0, 0.02], [Math.PI / 2, 0, 0]);
      const ring = new TorusGeometry(0.064, 0.01, 6, 20);
      add(ring, g.chrome, [dx, 0, 0.025]);
    }
  } else if (id === 'slit') {
    add(rbox(0.42, 0.09, 0.1, 0.03), g.trim, [0, 0.01, -0.03], [0, 0, 0.14]);
    add(rbox(0.36, 0.022, 0.03, 0.008), g.light, [0, 0.016, 0.02], [0, 0, 0.14]);
    add(rbox(0.1, 0.018, 0.03, 0.006), g.light, [0.12, -0.02, 0.02], [0, 0, -0.5]);
  } else {
    add(rbox(0.46, 0.07, 0.1, 0.03), g.trim, [0, 0, -0.03]);
    add(rbox(0.42, 0.02, 0.03, 0.008), g.light, [0, 0.008, 0.02]);
    for (let k = 0; k < 3; k++) {
      const c = new CircleGeometry(0.012, 10);
      add(c, g.light, [-0.12 + k * 0.05, -0.018, 0.035]);
    }
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
    const len = 0.22;
    const pipe = new CylinderGeometry(r, r * 0.92, len, 20, 1, true);
    place(pipe, [x, y - 0.06, z + len / 2 - 0.08], [Math.PI / 2, 0, 0]);
    g.chrome.push(pipe);
    const inner = new CircleGeometry(r * 0.85, 16);
    place(inner, [x, y - 0.06, z - 0.06], [0, Math.PI, 0]);
    g.trim.push(inner);
    const lip = new TorusGeometry(r, 0.01, 6, 20);
    place(lip, [x, y - 0.06, z - 0.08]);
    g.chrome.push(lip);
    tips.push(new Vector3(x, y - 0.06, z - 0.08));
  }
  if (id === 'center') g.trim.push(place(rbox(0.42, 0.13, 0.06, 0.04), [0, y - 0.06, rear.faceZ(0, y, -1, -2.1).z + 0.04]));
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
  const pts: Vector2[] = [];
  const steps = 10;
  pts.push(new Vector2(rim, -W / 2 + 0.01));
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI;
    const bulge = 0.04;
    pts.push(new Vector2(R - bulge + Math.cos(a) * bulge, (Math.sin(a) * (W / 2 - 0.01))));
  }
  pts.push(new Vector2(rim, W / 2 - 0.01));
  // flip to make the lathe face outward
  const g = new LatheGeometry(pts, 36);
  g.rotateZ(Math.PI / 2); // axis along x
  return g;
}

/** Rim geometry; the outer face points to +x (mirror for the other side). */
export function rimGeometry(id: string): { main: BufferGeometry[]; accent: BufferGeometry[] } {
  const main: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const R = 0.245;
  const face = 0.1;
  // barrel
  const barrel = new CylinderGeometry(R, R, 0.24, 32, 1, true);
  barrel.rotateZ(Math.PI / 2);
  main.push(barrel);
  const lip = new TorusGeometry(R - 0.005, 0.014, 6, 32);
  lip.rotateY(Math.PI / 2);
  lip.translate(face + 0.01, 0, 0);
  main.push(lip);
  const hub = new CylinderGeometry(0.06, 0.07, 0.06, 16);
  hub.rotateZ(Math.PI / 2);
  hub.translate(face, 0, 0);
  main.push(hub);
  if (id === 'mesh') {
    for (let i = 0; i < 10; i++) {
      for (const s of [1, -1]) {
        const a = (i / 10) * Math.PI * 2;
        const sp = new BoxGeometry(0.02, 0.19, 0.016);
        sp.translate(0, 0.13, 0);
        sp.rotateX(a + s * 0.18);
        sp.translate(face - 0.01, 0, 0);
        main.push(sp);
      }
    }
  } else if (id === 'turbine') {
    const disc = new CylinderGeometry(R - 0.01, R - 0.01, 0.02, 32);
    disc.rotateZ(Math.PI / 2);
    disc.translate(face - 0.03, 0, 0);
    accent.push(disc);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const b = new BoxGeometry(0.03, 0.15, 0.04);
      b.rotateY(0.6);
      b.translate(0, 0.14, 0);
      b.rotateX(a);
      b.translate(face - 0.005, 0, 0);
      main.push(b);
    }
  } else {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const sp = new BoxGeometry(0.05, 0.2, 0.06);
      const pos = sp.getAttribute('position');
      for (let k = 0; k < pos.count; k++) {
        // taper the spoke towards the rim
        const yy = pos.getY(k);
        const t = (yy + 0.1) / 0.2;
        pos.setZ(k, pos.getZ(k) * (1.25 - 0.55 * t));
        pos.setX(k, pos.getX(k) - t * 0.03);
      }
      sp.computeVertexNormals();
      sp.translate(0, 0.13, 0);
      sp.rotateX(a);
      sp.translate(face - 0.01, 0, 0);
      main.push(sp);
    }
  }
  return { main, accent };
}

export function brakeGeometry(): { disc: BufferGeometry; caliper: BufferGeometry } {
  const disc = new CylinderGeometry(0.19, 0.19, 0.03, 24);
  disc.rotateZ(Math.PI / 2);
  disc.translate(0.02, 0, 0);
  const caliper = rbox(0.06, 0.16, 0.1, 0.02);
  caliper.translate(0.05, 0.12, 0.06);
  caliper.rotateX(-0.6);
  return { disc, caliper };
}
