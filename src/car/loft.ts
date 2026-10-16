import { BufferGeometry, CatmullRomCurve3, Float32BufferAttribute, Vector2, Vector3 } from 'three';

/**
 * Cross-section of a car body, in the car's local frame (x = left/right,
 * y = up). Only the right half is described; it is mirrored.
 */
export interface Section {
  z: number;
  /** bottom height */
  yb: number;
  /** half width at the bottom (tucked in, under the wheels) */
  wb: number;
  /** shoulder height and half width (widest line) */
  ys: number;
  ws: number;
  /** top height and half width of the flat top */
  yt: number;
  wt: number;
  /** 0 = soft and round, 1 = crisp and boxy */
  crisp?: number;
}

export const RING = 28; // points per half section

/**
 * Control points of the half profile. Point k sits at curve parameter k/8, so
 * t = 0.5 is the shoulder (belt line on a cabin), t = 0.75 the top edge and
 * t = 1 the top centre line.
 */
export function profileCurve(sec: Section): CatmullRomCurve3 {
  const c = sec.crisp ?? 0.5;
  const { yb, wb, ys, ws, yt, wt } = sec;
  const pts = [
    new Vector3(0, yb, 0),
    new Vector3(wb * 0.6, yb, 0),
    new Vector3(wb, yb + (ys - yb) * 0.08, 0),
    new Vector3(wb + (ws - wb) * (0.55 + 0.25 * c), yb + (ys - yb) * (0.55 - 0.15 * c), 0),
    new Vector3(ws, ys, 0),
    new Vector3(ws - (ws - wt) * (0.35 - 0.2 * c), ys + (yt - ys) * (0.55 + 0.2 * c), 0),
    new Vector3(wt, yt - (yt - ys) * 0.04 * (1 - c), 0),
    new Vector3(wt * 0.5, yt, 0),
    new Vector3(0, yt, 0),
  ];
  const curve = new CatmullRomCurve3(pts, false, 'centripetal');
  curve.arcLengthDivisions = 48;
  return curve;
}

function halfProfile(sec: Section, n = RING): Vector2[] {
  return profileCurve(sec)
    .getSpacedPoints(n - 1)
    .map((p) => new Vector2(Math.max(0, p.x), p.y));
}

/** Section at an arbitrary z, linearly interpolated from a (finely refined) list. */
export function sectionAt(secs: Section[], z: number): Section {
  const asc = secs[secs.length - 1].z > secs[0].z;
  const list = asc ? secs : secs.slice().reverse();
  if (z <= list[0].z) return { ...list[0], z };
  for (let i = 0; i < list.length - 1; i++) {
    if (z <= list[i + 1].z) return lerpSection(list[i], list[i + 1], (z - list[i].z) / Math.max(1e-6, list[i + 1].z - list[i].z));
  }
  return { ...list[list.length - 1], z };
}

/** Full ring (right half then mirrored left half), starting and ending at the bottom centre. */
export function ring(sec: Section, n = RING): Vector2[] {
  const half = halfProfile(sec, n);
  const out = [...half];
  for (let i = half.length - 2; i >= 0; i--) out.push(new Vector2(-half[i].x, half[i].y));
  return out;
}

export function lerpSection(a: Section, b: Section, t: number): Section {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    z: l(a.z, b.z),
    yb: l(a.yb, b.yb),
    wb: l(a.wb, b.wb),
    ys: l(a.ys, b.ys),
    ws: l(a.ws, b.ws),
    yt: l(a.yt, b.yt),
    wt: l(a.wt, b.wt),
    crisp: l(a.crisp ?? 0.5, b.crisp ?? 0.5),
  };
}

/**
 * Smoothly resample a list of sections along z with a Catmull-Rom style
 * interpolation of every parameter so the loft has no visible kinks.
 */
export function refine(secs: Section[], steps: number | ((len: number) => number) = 4): Section[] {
  const out: Section[] = [];
  const keys: (keyof Section)[] = ['z', 'yb', 'wb', 'ys', 'ws', 'yt', 'wt', 'crisp'];
  for (let i = 0; i < secs.length - 1; i++) {
    const p0 = secs[Math.max(0, i - 1)];
    const p1 = secs[i];
    const p2 = secs[i + 1];
    const p3 = secs[Math.min(secs.length - 1, i + 2)];
    const n = typeof steps === 'number' ? steps : Math.max(1, Math.round(steps(Math.abs(p2.z - p1.z))));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const s = {} as Section;
      for (const key of keys) {
        const a = (p0[key] ?? 0.5) as number;
        const b = (p1[key] ?? 0.5) as number;
        const c = (p2[key] ?? 0.5) as number;
        const d = (p3[key] ?? 0.5) as number;
        // monotone-ish catmull-rom
        const v = 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
        (s[key] as number) = key === 'z' ? b + (c - b) * t : clampBetween(v, b, c, key);
      }
      out.push(s);
    }
  }
  out.push({ ...secs[secs.length - 1] });
  return out;
}

function clampBetween(v: number, b: number, c: number, key: string) {
  // allow a little overshoot for curvature but never wildly
  const lo = Math.min(b, c) - 0.03;
  const hi = Math.max(b, c) + 0.03;
  if (key === 'crisp') return Math.min(1, Math.max(0, v));
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Loft a list of sections (ordered by z, any direction) into a closed mesh.
 * capStart/capEnd close the ends with a fan.
 */
export function loft(
  secs: Section[],
  opts: { capStart?: boolean; capEnd?: boolean; tipStart?: Vector3; tipEnd?: Vector3; ring?: number } = {},
): BufferGeometry {
  const rings = secs.map((s) => ring(s, opts.ring));
  const n = rings[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  const uv: number[] = [];
  for (let r = 0; r < rings.length; r++) {
    for (let i = 0; i < n; i++) {
      const p = rings[r][i];
      pos.push(p.x, p.y, secs[r].z);
      uv.push(i / (n - 1), r / (rings.length - 1));
    }
  }
  const forward = secs[secs.length - 1].z > secs[0].z;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < n - 1; i++) {
      const a = r * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      if (forward) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const cap = (r: number, outwardPlusZ: boolean, tip?: Vector3) => {
    const base = pos.length / 3;
    let cx = 0;
    let cy = 0;
    for (const p of rings[r]) {
      cx += p.x;
      cy += p.y;
    }
    cx /= n;
    cy /= n;
    const t = tip ?? new Vector3(cx, cy, secs[r].z);
    pos.push(t.x, t.y, t.z);
    uv.push(0.5, 0.5);
    // duplicate ring vertices so the cap gets its own (flat-ish) normals
    for (let i = 0; i < n; i++) {
      const p = rings[r][i];
      pos.push(p.x, p.y, secs[r].z);
      uv.push(0.5 + p.x, p.y);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + 1 + i;
      const b = a + 1;
      if (outwardPlusZ) idx.push(base, a, b);
      else idx.push(base, b, a);
    }
  };
  if (opts.capStart) cap(0, !forward, opts.tipStart);
  if (opts.capEnd) cap(rings.length - 1, forward, opts.tipEnd);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
