import { Vector3 } from 'three';
import type { Track } from '../track/track';

/**
 * Read-only analysis of a track's shape, shared by the deck mesh, the roadside
 * structures and the scenery so they all agree on where things go (kerbs on the
 * corners, lamps along the straights, pylons where nothing runs underneath).
 */
export interface TrackLayout {
  /** signed curvature in the deck plane, rad/m (+ = turning right), smoothed */
  curve: Float32Array;
  /** 0..1 kerb strength per sample (fades in and out around corners) */
  kerb: Float32Array;
  lamps: { s: number; side: number }[];
  /** corner warning boards on the outside of tight bends */
  signs: { s: number; side: number }[];
  /** support columns: sample index and the world height they reach down to */
  pylons: { i: number; bottom: number }[];
  /** samples within reach of a gap edge (no roadside furniture there) */
  nearGap: Uint8Array;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function analyseTrack(track: Track, floor = -40): TrackLayout {
  const n = track.samples.length;
  const S = track.samples;
  const raw = new Float32Array(n);
  const d = new Vector3();
  for (let i = 0; i < n; i++) {
    const a = S[(i - 3 + n) % n];
    const b = S[(i + 3) % n];
    raw[i] = d.copy(b.fwd).sub(a.fwd).dot(S[i].right) / 6;
  }
  const curve = new Float32Array(n);
  const W = 12;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -W; k <= W; k++) acc += raw[(i + k + n) % n];
    curve[i] = acc / (2 * W + 1);
  }

  const nearGap = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!S[i].gap) continue;
    for (let k = -30; k <= 30; k++) nearGap[(i + k + n) % n] = 1;
  }

  // kerbs from roughly a 400 m radius, full strength by 150 m; widened so they lead into the corner
  const kerbRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const smp = S[i];
    kerbRaw[i] = smp.tunnel || smp.loop || nearGap[i] ? 0 : smooth(1 / 420, 1 / 160, Math.abs(curve[i]));
  }
  const kerb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = -14; k <= 14; k++) m = Math.max(m, kerbRaw[(i + k + n) % n] * (1 - Math.abs(k) / 15));
    kerb[i] = m < 0.08 ? 0 : m;
  }

  const lamps: TrackLayout['lamps'] = [];
  let side = 1;
  for (let s = 20; s < n - 10; s += 36) {
    const i = Math.round(s);
    if (S[i].tunnel || S[i].loop || nearGap[i] || S[i].up.y < 0.55) continue;
    lamps.push({ s, side });
    side = -side;
  }

  const signs: TrackLayout['signs'] = [];
  let last = -1e9;
  for (let i = 0; i < n; i++) {
    if (Math.abs(curve[i]) < 1 / 140 || S[i].tunnel || nearGap[i] || i - last < 22) continue;
    signs.push({ s: i, side: curve[i] > 0 ? -1 : 1 });
    last = i;
  }

  // Support columns down into the cloud sea, only where the deck is level-ish
  // and no other part of the lap runs underneath.
  const pylons: TrackLayout['pylons'] = [];
  let lastP = -1e9;
  for (let i = 0; i < n; i += 6) {
    const smp = S[i];
    if (i - lastP < 150 || smp.gap || nearGap[i] || smp.loop || smp.tunnel || smp.bridge || smp.up.y < 0.93) continue;
    let blocked = false;
    for (let j = 0; j < n && !blocked; j += 3) {
      const o = S[j];
      if (Math.abs(j - i) < 40 || o.pos.y > smp.pos.y - 3) continue;
      const dx = o.pos.x - smp.pos.x;
      const dz = o.pos.z - smp.pos.z;
      if (dx * dx + dz * dz < 28 * 28) blocked = true;
    }
    if (blocked) continue;
    pylons.push({ i, bottom: floor });
    lastP = i;
  }

  return { curve, kerb, lamps, signs, pylons, nearGap };
}
