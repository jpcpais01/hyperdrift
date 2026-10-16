import { Track } from '../src/track/track';
import { SKYWAY } from '../src/track/skyway';
const t = new Track(SKYWAY);
console.log('length', t.length, 'closure', t.closureError.toFixed(1));
const W = 100, H = 50;
let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, miny = 1e9, maxy = -1e9;
for (const s of t.samples) { minx = Math.min(minx, s.pos.x); maxx = Math.max(maxx, s.pos.x); minz = Math.min(minz, s.pos.z); maxz = Math.max(maxz, s.pos.z); miny = Math.min(miny, s.pos.y); maxy = Math.max(maxy, s.pos.y); }
console.log('x', minx.toFixed(0), maxx.toFixed(0), 'z', minz.toFixed(0), maxz.toFixed(0), 'y', miny.toFixed(0), maxy.toFixed(0));
const g = Array.from({ length: H }, () => Array(W).fill(' '));
for (const s of t.samples) {
  const x = Math.floor(((s.pos.x - minx) / (maxx - minx + 1)) * W);
  const z = Math.floor(((s.pos.z - minz) / (maxz - minz + 1)) * H);
  g[H - 1 - z][W - 1 - x] = s.gap ? 'G' : s.loop ? 'L' : s.tunnel ? 'T' : s.s < 5 ? 'S' : '#';
}
console.log(g.map((r) => r.join('')).join('\n'));
