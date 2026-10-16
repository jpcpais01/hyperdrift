// Generates the PWA icons as PNG with no dependencies (zlib only).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, shade) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const S = 3;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
        r += c[0]; g += c[1]; b += c[2]; a += c[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r / (S * S); raw[o + 1] = g / (S * S); raw[o + 2] = b / (S * S); raw[o + 3] = a / (S * S);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;
// Distance to segment
function seg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function icon(scale, rounded) {
  return (u, v) => {
    // map into the safe zone for maskable icons
    const x = 0.5 + (u - 0.5) / scale, y = 0.5 + (v - 0.5) / scale;
    // background: deep sky gradient with a horizon glow
    const glow = Math.exp(-((v - 0.62) ** 2) / 0.02);
    let r = mix(11, 40, v) + glow * 120, g = mix(16, 20, v) + glow * 40, b = mix(46, 70, v) + glow * 90;
    // stylised track ribbon swooping through the icon
    const d1 = seg(x, y, 0.18, 0.74, 0.5, 0.42);
    const d2 = seg(x, y, 0.5, 0.42, 0.82, 0.26);
    const d = Math.min(d1, d2);
    if (d < 0.075) { const t = d / 0.075; r = mix(20, 30, t); g = mix(240, 200, t); b = mix(255, 255, t); }
    if (d < 0.03) { r = 255; g = 255; b = 255; }
    // speed chevrons
    for (let i = 0; i < 3; i++) {
      const cx = 0.3 + i * 0.13, cy = 0.28 + i * 0.0;
      const dc = Math.min(seg(x, y, cx, cy - 0.06, cx + 0.06, cy), seg(x, y, cx + 0.06, cy, cx, cy + 0.06));
      if (dc < 0.02) { r = 255; g = 60 + i * 30; b = 200; }
    }
    let a = 255;
    if (rounded) {
      const q = Math.max(Math.abs(u - 0.5) - 0.32, 0) ** 2 + Math.max(Math.abs(v - 0.5) - 0.32, 0) ** 2;
      if (Math.sqrt(q) > 0.18) a = 0;
    }
    return [Math.min(255, r), Math.min(255, g), Math.min(255, b), a];
  };
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, icon(1, true)));
writeFileSync('public/icons/icon-512.png', png(512, icon(1, true)));
writeFileSync('public/icons/icon-maskable-512.png', png(512, icon(0.8, false)));
writeFileSync('public/icons/apple-touch-icon.png', png(180, icon(1, false)));
console.log('icons written');
