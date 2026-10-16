import { BufferGeometry, Vector3 } from 'three';

interface Chunk {
  min: Float64Array;
  max: Float64Array;
  /** 9 floats per triangle */
  tri: Float32Array;
}

/**
 * Finds a surface by casting rays against a set of geometries. Placing the
 * detail of one car casts a few thousand rays, so this keeps its own tiny
 * acceleration structure (triangles bucketed on a coarse 3D grid, each bucket
 * with a tight box) and a hand-written ray/triangle test instead of going
 * through three's Raycaster.
 */
interface Node {
  min: Float64Array;
  max: Float64Array;
  /** leaf chunk, or two children */
  chunk?: Chunk;
  a?: Node;
  b?: Node;
}

function buildTree(list: Chunk[]): Node {
  const min = new Float64Array([Infinity, Infinity, Infinity]);
  const max = new Float64Array([-Infinity, -Infinity, -Infinity]);
  for (const c of list) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], c.min[k]);
      max[k] = Math.max(max[k], c.max[k]);
    }
  }
  if (list.length === 1) return { min, max, chunk: list[0] };
  let axis = 0;
  for (let k = 1; k < 3; k++) if (max[k] - min[k] > max[axis] - min[axis]) axis = k;
  const sorted = list.slice().sort((p, q) => p.min[axis] + p.max[axis] - q.min[axis] - q.max[axis]);
  const h = sorted.length >> 1;
  return { min, max, a: buildTree(sorted.slice(0, h)), b: buildTree(sorted.slice(h)) };
}

export class Surface {
  private chunks: Chunk[] = [];
  private root: Node | null = null;
  private cache = new Map<string, { point: Vector3; normal: Vector3 } | null>();
  constructor(geos: BufferGeometry[]) {
    for (const g of geos) this.chunks.push(...chunk(g));
    if (this.chunks.length) this.root = buildTree(this.chunks);
  }
  cast(origin: Vector3, dir: Vector3): { point: Vector3; normal: Vector3 } | null {
    const key = `${origin.x.toFixed(4)},${origin.y.toFixed(4)},${origin.z.toFixed(4)},${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached && { point: cached.point.clone(), normal: cached.normal.clone() };
    const out = this.trace(origin, dir.clone().normalize());
    this.cache.set(key, out);
    return out && { point: out.point.clone(), normal: out.normal.clone() };
  }
  private trace(o: Vector3, d: Vector3): { point: Vector3; normal: Vector3 } | null {
    const ox = o.x;
    const oy = o.y;
    const oz = o.z;
    const dx = d.x;
    const dy = d.y;
    const dz = d.z;
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    let best = Infinity;
    let hit: Float32Array | null = null;
    let hitI = 0;
    /** entry distance of the ray into a box, or Infinity if it misses (or the box is behind) */
    const enter = (mn: Float64Array, mx: Float64Array) => {
      let t0 = (mn[0] - ox) * ix;
      let t1 = (mx[0] - ox) * ix;
      let tmin = Math.min(t0, t1);
      let tmax = Math.max(t0, t1);
      t0 = (mn[1] - oy) * iy;
      t1 = (mx[1] - oy) * iy;
      tmin = Math.max(tmin, Math.min(t0, t1));
      tmax = Math.min(tmax, Math.max(t0, t1));
      t0 = (mn[2] - oz) * iz;
      t1 = (mx[2] - oz) * iz;
      tmin = Math.max(tmin, Math.min(t0, t1));
      tmax = Math.min(tmax, Math.max(t0, t1));
      // NaN-safe: a ray parallel to a slab and outside it gives NaN or an empty range
      return tmax >= Math.max(0, tmin) ? Math.max(0, tmin) : Infinity;
    };
    const testChunk = (c: Chunk) => {
      const t = c.tri;
      for (let i = 0; i < t.length; i += 9) {
        // Möller–Trumbore, both sides
        const e1x = t[i + 3] - t[i];
        const e1y = t[i + 4] - t[i + 1];
        const e1z = t[i + 5] - t[i + 2];
        const e2x = t[i + 6] - t[i];
        const e2y = t[i + 7] - t[i + 1];
        const e2z = t[i + 8] - t[i + 2];
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - t[i];
        const sy = oy - t[i + 1];
        const sz = oz - t[i + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 1e-6 && dist < best) {
          best = dist;
          hit = t;
          hitI = i;
        }
      }
    };
    // nearest-first walk of the box tree; stops as soon as every box left starts past the best hit
    const visit = (n: Node, tn: number) => {
      if (tn >= best) return;
      if (n.chunk) {
        testChunk(n.chunk);
        return;
      }
      const ta = enter(n.a!.min, n.a!.max);
      const tb = enter(n.b!.min, n.b!.max);
      if (ta <= tb) {
        if (ta < Infinity) visit(n.a!, ta);
        if (tb < Infinity) visit(n.b!, tb);
      } else {
        visit(n.b!, tb);
        if (ta < Infinity) visit(n.a!, ta);
      }
    };
    if (this.root) {
      const t = enter(this.root.min, this.root.max);
      if (t < Infinity) visit(this.root, t);
    }
    if (!hit) return null;
    const i = hitI;
    const a = new Vector3(hit[i], hit[i + 1], hit[i + 2]);
    const n = new Vector3(hit[i + 3], hit[i + 4], hit[i + 5]).sub(a).cross(new Vector3(hit[i + 6], hit[i + 7], hit[i + 8]).sub(a)).normalize();
    if (n.dot(d) > 0) n.negate();
    return { point: new Vector3(ox + dx * best, oy + dy * best, oz + dz * best), normal: n };
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

/** Buckets a geometry's triangles on a coarse 3D grid by triangle centre, each bucket with its own tight box. */
function chunk(g: BufferGeometry): Chunk[] {
  const index = g.getIndex()?.array;
  const pa = g.getAttribute('position');
  // read the raw arrays: attribute accessors are too slow for tens of thousands of vertices
  const P = pa.array as Float32Array;
  const stride = (pa as { data?: { stride: number } }).data?.stride ?? 3;
  const off = (pa as { offset?: number }).offset ?? 0;
  const count = index ? index.length : pa.count;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const N = count > 6000 ? [6, 4, 20] : [1, 1, 1];
  const sx = N[0] / (max.x - min.x + 1e-6);
  const sy = N[1] / (max.y - min.y + 1e-6);
  const sz = N[2] / (max.z - min.z + 1e-6);
  const lists = new Map<number, number[]>();
  for (let i = 0; i < count; i += 3) {
    const a = (index ? index[i] : i) * stride + off;
    const b = (index ? index[i + 1] : i + 1) * stride + off;
    const c = (index ? index[i + 2] : i + 2) * stride + off;
    const cx = (P[a] + P[b] + P[c]) / 3;
    const cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    const cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const kx = Math.min(N[0] - 1, Math.max(0, Math.floor((cx - min.x) * sx)));
    const ky = Math.min(N[1] - 1, Math.max(0, Math.floor((cy - min.y) * sy)));
    const kz = Math.min(N[2] - 1, Math.max(0, Math.floor((cz - min.z) * sz)));
    const k = (kz * N[1] + ky) * N[0] + kx;
    let l = lists.get(k);
    if (!l) lists.set(k, (l = []));
    l.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
  }
  return [...lists.values()].map((l) => {
    const tri = new Float32Array(l);
    const mn = new Float64Array([Infinity, Infinity, Infinity]);
    const mx = new Float64Array([-Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < tri.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], tri[i + k]);
        mx[k] = Math.max(mx[k], tri[i + k]);
      }
    }
    // a hair of padding so rays grazing a flat chunk still enter its box
    for (let k = 0; k < 3; k++) {
      mn[k] -= 1e-4;
      mx[k] += 1e-4;
    }
    return { min: mn, max: mx, tri };
  });
}
