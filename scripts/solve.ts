/**
 * Closes the Skyway lap: nudges the lengths of a few straights (and the pitch
 * of one climb) until the end meets the start, while keeping every part of the
 * lap clear of every other. Prints the solved values to paste into skyway.ts.
 * Usage: npx tsx scripts/solve.ts <straight indices...> -- <pitch index>
 */
import { Track, trackClearance, type SegmentDef } from '../src/track/track';
import { SKYWAY } from '../src/track/skyway';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const plain = sep < 0 ? args : args.slice(0, sep);
const lens = plain.filter((a) => !a.startsWith('y')).map(Number);
// "y12:30" moves yaw between segments 12 and 30 (keeping the lap's total turn)
const yawPairs = plain.filter((a) => a.startsWith('y')).map((a) => a.slice(1).split(':').map(Number));
const pitchIdx = sep < 0 ? [] : args.slice(sep + 1).map(Number);
const defs: SegmentDef[] = SKYWAY.map((d) => ({ ...d }));
const params = [...lens.map((i) => ({ i, key: 'len' as const, min: 30 })), ...pitchIdx.map((i) => ({ i, key: 'pitch' as const, min: -12 }))];

function cost(): number {
  const t = new Track(defs);
  const e = t.closureVector;
  const c = trackClearance(t);
  const clear = c.ratio < 1.05 ? (1.05 - c.ratio) * 4000 : 0;
  return e.x * e.x + e.z * e.z + e.y * e.y * 4 + clear * clear;
}

let best = cost();
let step = 20;
for (let it = 0; it < 400 && step > 0.02; it++) {
  let improved = false;
  for (const p of params) {
    for (const dir of [1, -1]) {
      const d = defs[p.i] as Record<string, number>;
      const old = d[p.key] ?? 0;
      const k = p.key === 'pitch' ? step * 0.1 : step;
      const v = old + dir * k;
      if (v < p.min || (p.key === 'pitch' && v > 12)) continue;
      d[p.key] = v;
      const c = cost();
      if (c < best) {
        best = c;
        improved = true;
      } else d[p.key] = old;
    }
  }
  for (const [a, b] of yawPairs) {
    for (const dir of [1, -1]) {
      const k = step * 0.1 * dir;
      defs[a].yaw = (defs[a].yaw ?? 0) + k;
      defs[b].yaw = (defs[b].yaw ?? 0) - k;
      const c = cost();
      if (c < best) {
        best = c;
        improved = true;
      } else {
        defs[a].yaw! -= k;
        defs[b].yaw! += k;
      }
    }
  }
  if (!improved) step *= 0.5;
}
const t = new Track(defs);
console.log('cost', best.toFixed(2), 'closure', t.closureVector.toArray().map((v) => v.toFixed(2)).join(','), 'clearance', trackClearance(t).ratio.toFixed(2), 'length', t.length);
for (const [a, b] of yawPairs) console.log(a, 'yaw', defs[a].yaw!.toFixed(1), b, 'yaw', defs[b].yaw!.toFixed(1));
for (const p of params) console.log(p.i, p.key, ((defs[p.i] as Record<string, number>)[p.key] ?? 0).toFixed(1));
