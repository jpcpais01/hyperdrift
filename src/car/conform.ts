import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type { Surface } from './surface';

/**
 * Conforming patches: flat 2D outlines projected onto the body shell, so lamps,
 * intakes, vents and bezels sit exactly on the curved skin of whatever body,
 * nose and tail the player picked, instead of boxes floating in front of it.
 */

/** Maps an outline coordinate (a, b) to a ray: origin outside the car, direction into the skin. */
export type Projector = (a: number, b: number) => { o: Vector3; d: Vector3 };

/**
 * Planar projection along `dir` through `centre`; a runs along `u` and b along
 * `v` (both made perpendicular to the ray), in metres.
 */
export function planar(centre: Vector3, dir: Vector3, u = new Vector3(1, 0, 0), v = new Vector3(0, 1, 0)): Projector {
  const d = dir.clone().normalize();
  const uu = u.clone().addScaledVector(d, -u.dot(d)).normalize();
  const vv = v.clone().addScaledVector(d, -v.dot(d)).addScaledVector(uu, -v.dot(uu)).normalize();
  return (a, b) => ({ o: centre.clone().addScaledVector(uu, a).addScaledVector(vv, b).addScaledVector(d, -3), d });
}

/** Projection onto the front (+1) or rear (-1) face: a = x, b = y. */
export const face = (side: 1 | -1): Projector => (a, b) => ({ o: new Vector3(a, b, side * 4), d: new Vector3(0, 0, -side) });

/** Projection onto the right flank: a = z, b = y. */
export const flank = (): Projector => (a, b) => ({ o: new Vector3(3, b, a), d: new Vector3(-1, 0, 0) });

/** Projection from above: a = x, b = z. */
export const above = (): Projector => (a, b) => ({ o: new Vector3(a, 3, b), d: new Vector3(0, -1, 0) });

/**
 * Wrap-around projection for lamps that turn the corner: rays point at a
 * vertical axis at (0, zc). a = angle from straight ahead (front, side +1) or
 * straight back (rear, side -1) towards +x, b = y.
 */
export function wrap(side: 1 | -1, zc: number): Projector {
  return (a, b) => {
    const w = new Vector3(Math.sin(a), 0, side * Math.cos(a));
    return { o: new Vector3(w.x * 4, b, zc + w.z * 4), d: w.negate() };
  };
}

interface Hit {
  p: Vector3;
  n: Vector3;
}

function project(s: Surface, proj: Projector, a: number, b: number, off: number, fallbackDepth: number): Hit {
  const { o, d } = proj(a, b);
  const h = s.cast(o, d);
  // a ray that slips past an edge can run on and hit a far part of the body (under the tail, into an arch): treat it as a miss
  if (h && h.point.distanceTo(o) < fallbackDepth + 0.4) return { p: h.point.addScaledVector(h.normal, off), n: h.normal };
  // missed the body (outline runs past an edge): stay on the projection plane at the centre's depth
  return { p: o.clone().addScaledVector(d, fallbackDepth - off), n: d.clone().negate() };
}

function centreDepth(s: Surface, proj: Projector, a: number, b: number): number {
  const { o, d } = proj(a, b);
  const h = s.cast(o, d);
  return h ? h.point.distanceTo(o) : 3;
}

/** Inserts points so no edge of the closed outline is longer than `step`. */
export function resample(pts: [number, number][], step: number, closed = true): [number, number][] {
  const out: [number, number][] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const [a0, b0] = pts[i];
    const [a1, b1] = pts[(i + 1) % pts.length];
    const k = Math.max(1, Math.ceil(Math.hypot(a1 - a0, b1 - b0) / step));
    for (let j = 0; j < k; j++) out.push([a0 + ((a1 - a0) * j) / k, b0 + ((b1 - b0) * j) / k]);
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Makes the indexed patch. The first `topCount` indices are the face the
 * patch shows; if they came out facing into the body, every index up to
 * `flipEnd` is flipped (walls built to follow the top flip with it).
 */
function build(pos: number[], idx: number[], outward: Vector3, topCount = idx.length, flipEnd = idx.length): BufferGeometry {
  let dot = 0;
  const v = (i: number) => new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  for (let i = 0; i < topCount; i += 3) {
    const a = v(idx[i]);
    const n = v(idx[i + 1]).sub(a).cross(v(idx[i + 2]).sub(a));
    dot += n.dot(outward);
  }
  if (dot < 0) for (let i = 0; i < flipEnd; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface ConformOpts {
  /** height above the skin */
  off?: number;
  /** rings between the centre and the outline (more = follows tighter curvature) */
  rings?: number;
  /** longest outline edge before it gets subdivided, in outline units */
  step?: number;
  /** a side wall running from the outline back into the skin, so the patch has visible thickness */
  wall?: number;
  /** extra height at the centre, easing to none at the outline: a moulded lens or a raised panel */
  dome?: number;
}

/**
 * A filled, star-shaped outline projected onto the skin. The outline is a
 * closed polygon in projector coordinates; it is filled by rings shrinking to
 * its centroid, so it should be roughly convex.
 */
export function conform(s: Surface, outline: [number, number][], proj: Projector, opts: ConformOpts = {}): BufferGeometry {
  const off = opts.off ?? 0.006;
  const rings = opts.rings ?? 3;
  const pts = resample(outline, opts.step ?? 0.03);
  let ca = 0;
  let cb = 0;
  for (const [a, b] of pts) {
    ca += a;
    cb += b;
  }
  ca /= pts.length;
  cb /= pts.length;
  const depth = centreDepth(s, proj, ca, cb);
  const n = pts.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const dome = opts.dome ?? 0;
  const lift = (k: number) => off + dome * (1 - k * k);
  const centre = project(s, proj, ca, cb, lift(0), depth);
  pos.push(centre.p.x, centre.p.y, centre.p.z);
  for (let r = 1; r <= rings; r++) {
    const k = r / rings;
    for (const [a, b] of pts) {
      const h = project(s, proj, ca + (a - ca) * k, cb + (b - cb) * k, lift(k), depth);
      pos.push(h.p.x, h.p.y, h.p.z);
    }
  }
  for (let i = 0; i < n; i++) idx.push(0, 1 + i, 1 + ((i + 1) % n));
  for (let r = 0; r < rings - 1; r++) {
    const a0 = 1 + r * n;
    const b0 = 1 + (r + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(a0 + i, b0 + i, b0 + j, a0 + i, b0 + j, a0 + j);
    }
  }
  const topCount = idx.length;
  if (opts.wall) {
    // duplicate the rim so the wall gets its own crisp normals
    const top = pos.length / 3;
    for (const [a, b] of pts) {
      const h = project(s, proj, a, b, off, depth);
      pos.push(h.p.x, h.p.y, h.p.z);
    }
    const bot = pos.length / 3;
    for (const [a, b] of pts) {
      const h = project(s, proj, a, b, off - opts.wall, depth);
      pos.push(h.p.x, h.p.y, h.p.z);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(top + i, bot + i, bot + j, top + i, bot + j, top + j);
    }
  }
  return build(pos, idx, centre.n, topCount);
}

/**
 * A band between two outlines with the same number of points (a bezel, a
 * frame, a ring). `inner` defaults to the outline shrunk towards its centroid.
 */
export function conformBand(s: Surface, outer: [number, number][], proj: Projector, opts: ConformOpts & { inner?: [number, number][]; shrink?: number; offInner?: number } = {}): BufferGeometry {
  const off = opts.off ?? 0.008;
  const offIn = opts.offInner ?? off;
  let ca = 0;
  let cb = 0;
  for (const [a, b] of outer) {
    ca += a;
    cb += b;
  }
  ca /= outer.length;
  cb /= outer.length;
  const k = opts.shrink ?? 0.85;
  const inner = opts.inner ?? outer.map(([a, b]) => [ca + (a - ca) * k, cb + (b - cb) * k] as [number, number]);
  // resample both the same way: subdivide each edge pair by the outer edge's length
  const step = opts.step ?? 0.03;
  const o2: [number, number][] = [];
  const i2: [number, number][] = [];
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    const m = Math.max(1, Math.ceil(Math.hypot(outer[j][0] - outer[i][0], outer[j][1] - outer[i][1]) / step));
    for (let t = 0; t < m; t++) {
      const f = t / m;
      o2.push([outer[i][0] + (outer[j][0] - outer[i][0]) * f, outer[i][1] + (outer[j][1] - outer[i][1]) * f]);
      i2.push([inner[i][0] + (inner[j][0] - inner[i][0]) * f, inner[i][1] + (inner[j][1] - inner[i][1]) * f]);
    }
  }
  const depth = centreDepth(s, proj, ca, cb);
  const n = o2.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const nrm = new Vector3();
  for (const [a, b] of o2) {
    const h = project(s, proj, a, b, off, depth);
    nrm.add(h.n);
    pos.push(h.p.x, h.p.y, h.p.z);
  }
  for (const [a, b] of i2) {
    const h = project(s, proj, a, b, offIn, depth);
    pos.push(h.p.x, h.p.y, h.p.z);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // wound like a fan from the centre, so the walls below agree with it
    idx.push(i, n + j, n + i, i, j, n + j);
  }
  const topCount = idx.length;
  if (opts.wall) {
    const top = pos.length / 3;
    for (const [a, b] of o2) {
      const h = project(s, proj, a, b, off, depth);
      pos.push(h.p.x, h.p.y, h.p.z);
    }
    const bot = pos.length / 3;
    for (const [a, b] of o2) {
      const h = project(s, proj, a, b, off - opts.wall, depth);
      pos.push(h.p.x, h.p.y, h.p.z);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(top + i, bot + i, bot + j, top + i, bot + j, top + j);
    }
  }
  return build(pos, idx, nrm.normalize(), topCount);
}

/**
 * A strip of constant width along an open path (an LED line, a crease
 * highlight, a slat). Width is in projector units, measured across the path.
 */
export function conformStrip(s: Surface, path: [number, number][], width: number, proj: Projector, opts: ConformOpts = {}): BufferGeometry {
  const off = opts.off ?? 0.007;
  const pts = resample(path, opts.step ?? 0.025, false);
  const mid = pts[Math.floor(pts.length / 2)];
  const depth = centreDepth(s, proj, mid[0], mid[1]);
  const pos: number[] = [];
  const idx: number[] = [];
  const nrm = new Vector3();
  const rows = [width / 2, -width / 2];
  const edge = (lift: number) => {
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[Math.min(pts.length - 1, i + 1)];
      let ta = p1[0] - p0[0];
      let tb = p1[1] - p0[1];
      const l = Math.hypot(ta, tb) || 1;
      ta /= l;
      tb /= l;
      for (const w of rows) {
        const h = project(s, proj, pts[i][0] - tb * w, pts[i][1] + ta * w, lift, depth);
        nrm.add(h.n);
        pos.push(h.p.x, h.p.y, h.p.z);
      }
    }
    return base;
  };
  edge(off);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const topCount = idx.length;
  if (opts.wall) {
    // two side walls (both long edges) so the strip reads as a raised bead;
    // each wall triangle is turned to face away from the strip's centre line
    const top = edge(off);
    const bot = edge(off - opts.wall);
    const P = (i: number) => new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const tri = (a: number, b: number, c: number, away: Vector3) => {
      const n = new Vector3().subVectors(P(b), P(a)).cross(new Vector3().subVectors(P(c), P(a)));
      if (n.dot(away) < 0) idx.push(a, c, b);
      else idx.push(a, b, c);
    };
    for (const r of [0, 1]) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = top + i * 2 + r;
        const b = bot + i * 2 + r;
        const away = P(a).sub(P(top + i * 2 + (1 - r)));
        tri(a, b, b + 2, away);
        tri(a, b + 2, a + 2, away);
      }
    }
  }
  return build(pos, idx, nrm.normalize(), topCount, topCount);
}

/** Regular outlines in projector units. */
export function ellipse(ca: number, cb: number, ra: number, rb: number, n = 24, rot = 0): [number, number][] {
  const out: [number, number][] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.cos(t) * ra;
    const y = Math.sin(t) * rb;
    out.push([ca + x * c - y * s, cb + x * s + y * c]);
  }
  return out;
}

/** Rounded rectangle (or, with a skew, a parallelogram) in projector units. */
export function roundRect(ca: number, cb: number, w: number, h: number, r: number, skew = 0, n = 4): [number, number][] {
  const out: [number, number][] = [];
  const rr = Math.min(r, w / 2, h / 2);
  const corners: [number, number, number][] = [
    [w / 2 - rr, h / 2 - rr, 0],
    [-w / 2 + rr, h / 2 - rr, Math.PI / 2],
    [-w / 2 + rr, -h / 2 + rr, Math.PI],
    [w / 2 - rr, -h / 2 + rr, (3 * Math.PI) / 2],
  ];
  for (const [x, y, a0] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      out.push([ca + px + py * skew, cb + py]);
    }
  }
  return out;
}

/** Rounds the corners of any polygon by cutting each corner with a short curve. */
export function soften(pts: [number, number][], cut = 0.25, n = 3): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const a: [number, number] = [p1[0] + (p0[0] - p1[0]) * cut, p1[1] + (p0[1] - p1[1]) * cut];
    const b: [number, number] = [p1[0] + (p2[0] - p1[0]) * cut, p1[1] + (p2[1] - p1[1]) * cut];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      // quadratic bezier a -> p1 -> b
      const u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * p1[0] + t * t * b[0], u * u * a[1] + 2 * u * t * p1[1] + t * t * b[1]]);
    }
  }
  return out;
}
