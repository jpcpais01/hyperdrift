/**
 * Layout checker for track definitions: closure, size, clearance between
 * sections that pass near each other, plus a top view and elevation profile.
 * Usage: npx tsx scripts/trackcheck.ts
 */
import { Track } from '../src/track/track';
import { SKYWAY } from '../src/track/skyway';
import { trackClearance } from '../src/track/track';

const t = new Track(SKYWAY);
console.log('length', t.length, 'closure', t.closureError.toFixed(1), t.closureVector.toArray().map((v) => v.toFixed(1)).join(','));
let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, miny = 1e9, maxy = -1e9;
for (const s of t.samples) {
  minx = Math.min(minx, s.pos.x); maxx = Math.max(maxx, s.pos.x);
  minz = Math.min(minz, s.pos.z); maxz = Math.max(maxz, s.pos.z);
  miny = Math.min(miny, s.pos.y); maxy = Math.max(maxy, s.pos.y);
}
console.log('x', minx.toFixed(0), maxx.toFixed(0), 'z', minz.toFixed(0), maxz.toFixed(0), 'y', miny.toFixed(0), maxy.toFixed(0));
const c = trackClearance(t);
console.log('min clearance', c.dist.toFixed(1), 'at s', c.a, c.b);

const W = 110, H = 55;
const g = Array.from({ length: H }, () => Array(W).fill(' '));
for (const s of t.samples) {
  const x = Math.floor(((s.pos.x - minx) / (maxx - minx + 1)) * W);
  const z = Math.floor(((s.pos.z - minz) / (maxz - minz + 1)) * H);
  const ch = s.gap ? 'G' : s.loop ? 'L' : s.tunnel ? 'T' : s.s < 8 ? 'S' : String.fromCharCode(97 + Math.floor((s.s / t.length) * 26));
  g[H - 1 - z][W - 1 - x] = ch;
}
console.log(g.map((r) => r.join('')).join('\n'));
// elevation profile
const PH = 16;
const p = Array.from({ length: PH }, () => Array(W).fill(' '));
for (const s of t.samples) {
  const x = Math.floor((s.s / t.length) * W);
  const y = Math.floor(((s.pos.y - miny) / (maxy - miny + 1)) * PH);
  p[PH - 1 - y][x] = s.gap ? 'G' : '#';
}
console.log(p.map((r) => r.join('')).join('\n'));
