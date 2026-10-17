import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { PART } from './damage';

/**
 * Cutting the one-piece body shell into the panels that can come off: the
 * bumper covers (everything past the bumper shut lines) and the hood panel,
 * using the same rules the paint shader uses for its two-tone zones, so the
 * cut follows the drawn shut lines on every body.
 */
export interface PanelRules {
  hoodStart: number;
  hoodEnd: number;
  endFront: number;
  endRear: number;
  /** wheel arches: centre height, axle z, opening radius */
  archF: [number, number, number];
  archR: [number, number, number];
  wellX: number;
}

const HOOD_HALF_X = 0.6;
const HOOD_Y = 0.6;

export function shellPanel(c: Vector3, n: Vector3, R: PanelRules, paint: boolean): number {
  const rf = Math.hypot(c.y - R.archF[0], c.z - R.archF[1]) - R.archF[2];
  const rr = Math.hypot(c.y - R.archR[0], c.z - R.archR[1]) - R.archR[2];
  if (Math.min(rf, rr) < 0 && Math.abs(c.x) > R.wellX - 0.2) return PART.body;
  if (paint && c.z > R.hoodStart && c.z < R.hoodEnd && Math.abs(c.x) < HOOD_HALF_X && c.y > HOOD_Y && n.y > 0) return PART.hood;
  if (c.z > R.endFront) return PART.front;
  if (c.z < R.endRear) return PART.rear;
  return PART.body;
}

const A = new Vector3();
const B = new Vector3();
const C = new Vector3();
const CEN = new Vector3();
const NRM = new Vector3();

/**
 * Splits a geometry triangle by triangle into one geometry per part. Vertices
 * shared across a cut are duplicated, so each piece is whole on its own and a
 * panel can swing away without stretching the triangles at its edge.
 */
export function splitByPart(g: BufferGeometry, classify: (centre: Vector3, normal: Vector3) => number): Map<number, BufferGeometry> {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const index = g.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const vert = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const ids = new Uint8Array(triCount);
  const used = new Set<number>();
  for (let t = 0; t < triCount; t++) {
    const a = vert(t, 0);
    const b = vert(t, 1);
    const c = vert(t, 2);
    A.fromBufferAttribute(pos, a);
    B.fromBufferAttribute(pos, b);
    C.fromBufferAttribute(pos, c);
    CEN.copy(A).add(B).add(C).multiplyScalar(1 / 3);
    if (nor) {
      NRM.fromBufferAttribute(nor, a);
      A.fromBufferAttribute(nor, b);
      NRM.add(A);
      A.fromBufferAttribute(nor, c);
      NRM.add(A);
    } else NRM.subVectors(B, A).cross(C.sub(A));
    ids[t] = classify(CEN, NRM);
    used.add(ids[t]);
  }
  const out = new Map<number, BufferGeometry>();
  if (used.size === 1) {
    out.set([...used][0], g);
    return out;
  }
  const names = Object.keys(g.attributes);
  for (const id of used) {
    const remap = new Int32Array(pos.count).fill(-1);
    const order: number[] = [];
    const idx: number[] = [];
    for (let t = 0; t < triCount; t++) {
      if (ids[t] !== id) continue;
      for (let k = 0; k < 3; k++) {
        const v = vert(t, k);
        let m = remap[v];
        if (m < 0) {
          m = order.length;
          remap[v] = m;
          order.push(v);
        }
        idx.push(m);
      }
    }
    const piece = new BufferGeometry();
    for (const name of names) {
      const src = g.getAttribute(name) as BufferAttribute;
      const size = src.itemSize;
      const arr = new Float32Array(order.length * size);
      const from = src.array;
      const plain = !(src as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute && !src.normalized;
      for (let i = 0; i < order.length; i++) {
        const v = order[i];
        for (let s = 0; s < size; s++) arr[i * size + s] = plain ? from[v * size + s] : src.getComponent(v, s);
      }
      piece.setAttribute(name, new Float32BufferAttribute(arr, size));
    }
    piece.setIndex(new BufferAttribute(order.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    out.set(id, piece);
  }
  return out;
}

/**
 * The inner skin behind a panel: a copy pushed in along its normals, in the
 * satin dark metal of the trim (the crash structure). Hidden while the panel is on;
 * what you see through the gap once a bumper hangs or the hood pops.
 */
export function underSkin(g: BufferGeometry, inset: number): BufferGeometry {
  const out = g.clone();
  const pos = out.getAttribute('position');
  const nor = out.getAttribute('normal');
  if (nor) {
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) - nor.getX(i) * inset, pos.getY(i) - nor.getY(i) * inset, pos.getZ(i) - nor.getZ(i) * inset);
    }
  }
  out.deleteAttribute('zone');
  return out;
}

/** A shallow copy of `g` carrying a constant `part` attribute (attributes are shared, not copied). */
export function withPart(g: BufferGeometry, part: number): BufferGeometry {
  const out = new BufferGeometry();
  if (g.index) out.setIndex(g.index);
  for (const [name, attr] of Object.entries(g.attributes)) out.setAttribute(name, attr);
  out.setAttribute('part', new Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(part), 1));
  return out;
}
