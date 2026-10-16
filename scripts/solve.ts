import { Track } from '../src/track/track';
import { SKYWAY } from '../src/track/skyway';
const defs = SKYWAY.map((d) => ({ ...d }));
const A = Number(process.argv[2] ?? 0), B = Number(process.argv[3] ?? 6);
const ev = () => new Track(defs).closureVector;
for (let it = 0; it < 6; it++) {
  const e0 = ev();
  defs[A].len += 1; const ea = ev(); defs[A].len -= 1;
  defs[B].len += 1; const eb = ev(); defs[B].len -= 1;
  const ja = [ea.x - e0.x, ea.z - e0.z], jb = [eb.x - e0.x, eb.z - e0.z];
  const det = ja[0] * jb[1] - jb[0] * ja[1];
  const da = (-e0.x * jb[1] + jb[0] * e0.z) / det;
  const db = (-ja[0] * e0.z + e0.x * ja[1]) / det;
  defs[A].len += da; defs[B].len += db;
  console.log(it, e0.x.toFixed(1), e0.y.toFixed(1), e0.z.toFixed(1), '->', defs[A].len.toFixed(1), defs[B].len.toFixed(1));
}
