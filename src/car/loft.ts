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
  /**
   * height of the centre line; defaults to yt. Lower than yt makes a valley
   * between two raised fender crowns (a hood or deck sunk between the wings),
   * higher makes a domed top.
   */
  yc?: number;
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
  const yc = sec.yc ?? yt;
  const pts = [
    new Vector3(0, yb, 0),
    new Vector3(wb * 0.6, yb, 0),
    new Vector3(wb, yb + (ys - yb) * 0.08, 0),
    new Vector3(wb + (ws - wb) * (0.55 + 0.25 * c), yb + (ys - yb) * (0.55 - 0.15 * c), 0),
    new Vector3(ws, ys, 0),
    new Vector3(ws - (ws - wt) * (0.35 - 0.2 * c), ys + (yt - ys) * (0.55 + 0.2 * c), 0),
    new Vector3(wt, yt - (yt - ys) * 0.04 * (1 - c), 0),
    new Vector3(wt * 0.55, yc + (yt - yc) * 0.38, 0),
    new Vector3(0, yc, 0),
  ];
  const curve = new CatmullRomCurve3(pts, false, 'centripetal');
  curve.arcLengthDivisions = 48;
  return curve;
}

/** The profile's control points as flat [x, y] pairs (same points as profileCurve). */
function controlPoints(sec: Section): number[] {
  const c = sec.crisp ?? 0.5;
  const { yb, wb, ys, ws, yt, wt } = sec;
  const yc = sec.yc ?? yt;
  return [
    0, yb,
    wb * 0.6, yb,
    wb, yb + (ys - yb) * 0.08,
    wb + (ws - wb) * (0.55 + 0.25 * c), yb + (ys - yb) * (0.55 - 0.15 * c),
    ws, ys,
    ws - (ws - wt) * (0.35 - 0.2 * c), ys + (yt - ys) * (0.55 + 0.2 * c),
    wt, yt - (yt - ys) * 0.04 * (1 - c),
    wt * 0.55, yc + (yt - yc) * 0.38,
    0, yc,
  ];
}

const ARC_DIV = 48;
const _arc = new Float64Array(ARC_DIV + 1);
const _coef = new Float64Array(8 * 8);

/**
 * Arc-length spaced points along the half profile. Numerically the same as
 * profileCurve(sec).getSpacedPoints(n - 1) (centripetal Catmull-Rom, 48 arc
 * divisions), written out flat because the shell evaluates it for every one
 * of its ~130 sections.
 */
function halfProfile(sec: Section, n = RING): Vector2[] {
  const P = controlPoints(sec);
  const l = P.length / 2;
  // per segment cubic coefficients for x and y (as three's CubicPoly)
  for (let seg = 0; seg < l - 1; seg++) {
    const i1 = seg;
    const i2 = seg + 1;
    const x1 = P[i1 * 2];
    const y1 = P[i1 * 2 + 1];
    const x2 = P[i2 * 2];
    const y2 = P[i2 * 2 + 1];
    const x0 = seg > 0 ? P[(seg - 1) * 2] : 2 * P[0] - P[2];
    const y0 = seg > 0 ? P[(seg - 1) * 2 + 1] : 2 * P[1] - P[3];
    const x3 = seg + 2 < l ? P[(seg + 2) * 2] : 2 * P[(l - 1) * 2] - P[(l - 2) * 2];
    const y3 = seg + 2 < l ? P[(seg + 2) * 2 + 1] : 2 * P[(l - 1) * 2 + 1] - P[(l - 2) * 2 + 1];
    let dt0 = Math.pow((x1 - x0) ** 2 + (y1 - y0) ** 2, 0.25);
    let dt1 = Math.pow((x2 - x1) ** 2 + (y2 - y1) ** 2, 0.25);
    let dt2 = Math.pow((x3 - x2) ** 2 + (y3 - y2) ** 2, 0.25);
    if (dt1 < 1e-4) dt1 = 1.0;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    const poly = (a0: number, a1: number, a2: number, a3: number, o: number) => {
      let t1 = (a1 - a0) / dt0 - (a2 - a0) / (dt0 + dt1) + (a2 - a1) / dt1;
      let t2 = (a2 - a1) / dt1 - (a3 - a1) / (dt1 + dt2) + (a3 - a2) / dt2;
      t1 *= dt1;
      t2 *= dt1;
      _coef[o] = a1;
      _coef[o + 1] = t1;
      _coef[o + 2] = -3 * a1 + 3 * a2 - 2 * t1 - t2;
      _coef[o + 3] = 2 * a1 - 2 * a2 + t1 + t2;
    };
    poly(x0, x1, x2, x3, seg * 8);
    poly(y0, y1, y2, y3, seg * 8 + 4);
  }
  const at = (t: number, out: number[]) => {
    const p = (l - 1) * t;
    let ip = Math.floor(p);
    let w = p - ip;
    if (ip >= l - 1) {
      ip = l - 2;
      w = 1;
    }
    const o = ip * 8;
    out[0] = _coef[o] + w * (_coef[o + 1] + w * (_coef[o + 2] + w * _coef[o + 3]));
    out[1] = _coef[o + 4] + w * (_coef[o + 5] + w * (_coef[o + 6] + w * _coef[o + 7]));
  };
  const q = [0, 0];
  at(0, q);
  let px = q[0];
  let py = q[1];
  _arc[0] = 0;
  for (let d = 1; d <= ARC_DIV; d++) {
    at(d / ARC_DIV, q);
    _arc[d] = _arc[d - 1] + Math.hypot(q[0] - px, q[1] - py);
    px = q[0];
    py = q[1];
  }
  const total = _arc[ARC_DIV];
  const out: Vector2[] = [];
  const divisions = n - 1;
  for (let d = 0; d <= divisions; d++) {
    const target = (d / divisions) * total;
    // binary search like Curve.getUtoTmapping
    let lo = 0;
    let hi = ARC_DIV;
    let i = 0;
    while (lo <= hi) {
      i = Math.floor(lo + (hi - lo) / 2);
      const cmp = _arc[i] - target;
      if (cmp < 0) lo = i + 1;
      else if (cmp > 0) hi = i - 1;
      else {
        hi = i;
        break;
      }
    }
    i = hi;
    let t: number;
    if (i < 0) t = 0;
    else if (_arc[i] === target) t = i / ARC_DIV;
    else {
      const segLen = _arc[i + 1] - _arc[i];
      t = (i + (target - _arc[i]) / segLen) / ARC_DIV;
    }
    at(t, q);
    out.push(new Vector2(Math.max(0, q[0]), q[1]));
  }
  return out;
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
    yc: l(a.yc ?? a.yt, b.yc ?? b.yt),
    crisp: l(a.crisp ?? 0.5, b.crisp ?? 0.5),
  };
}

/**
 * Smoothly resample a list of sections along z with a Catmull-Rom style
 * interpolation of every parameter so the loft has no visible kinks.
 */
export function refine(secs: Section[], steps: number | ((len: number) => number) = 4): Section[] {
  const out: Section[] = [];
  const keys: (keyof Section)[] = ['z', 'yb', 'wb', 'ys', 'ws', 'yt', 'wt', 'yc', 'crisp'];
  secs = secs.map((s) => ({ ...s, yc: s.yc ?? s.yt, crisp: s.crisp ?? 0.5 }));
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
