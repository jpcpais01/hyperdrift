import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';
import { BANK_IN, PLAZA_R, STADIUM, WALL_R } from './layout';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  return g ? [c, g] : null;
}

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true): Texture {
  const t = new CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Grass detail: thousands of short blades in light, slightly green greys. The real hue
 * comes from the terrain's vertex colours, so the same tile reads as lush, dry or worn.
 */
export function grassTexture(): Texture | null {
  const cv = canvas(512, 512);
  if (!cv) return null;
  const [c, g] = cv;
  const r = rng(77);
  g.fillStyle = '#b9c2ad';
  g.fillRect(0, 0, 512, 512);
  // soft clumps
  for (let i = 0; i < 160; i++) {
    const x = r() * 512;
    const y = r() * 512;
    const rad = 10 + r() * 40;
    const l = 150 + r() * 80;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(${l - 10},${l + 8},${l - 25},0.35)`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    for (const ox of [-512, 0, 512]) for (const oy of [-512, 0, 512]) {
      g.save();
      g.translate(ox, oy);
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      g.restore();
    }
  }
  // blades, drawn wrapped so the tile is seamless
  g.lineCap = 'round';
  for (let i = 0; i < 9000; i++) {
    const x = r() * 512;
    const y = r() * 512;
    const len = 4 + r() * 9;
    const a = -Math.PI / 2 + (r() - 0.5) * 1.1;
    const l = 120 + r() * 135;
    g.strokeStyle = `rgba(${l - 12},${l + 10},${l - 30},${0.35 + r() * 0.45})`;
    g.lineWidth = 0.8 + r() * 1.2;
    for (const ox of [-512, 0, 512]) for (const oy of [-512, 0, 512]) {
      if (x + ox < -20 || x + ox > 532 || y + oy < -20 || y + oy > 532) continue;
      g.beginPath();
      g.moveTo(x + ox, y + oy);
      g.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
      g.stroke();
    }
  }
  // tiny wildflowers
  const petals = ['#fff4f8', '#ffd6e8', '#fff3b0', '#e8e0ff'];
  for (let i = 0; i < 260; i++) {
    const x = r() * 512;
    const y = r() * 512;
    g.fillStyle = petals[Math.floor(r() * petals.length)];
    g.beginPath();
    g.arc(x, y, 1.2 + r() * 1.3, 0, Math.PI * 2);
    g.fill();
  }
  return finish(c);
}

/**
 * The drift plaza, painted: circular paving with slab seams, drift circles, a lettered
 * ring, red and white curbs and hundreds of baked tyre marks from earlier sessions.
 * Mapped planar over the whole disc (≈10 px per metre).
 */
export function plazaTexture(): Texture | null {
  const S = 2048;
  const cv = canvas(S, S);
  if (!cv) return null;
  const [c, g] = cv;
  const R = PLAZA_R + 1;
  const k = S / 2 / R;
  const r = rng(1234);
  g.translate(S / 2, S / 2);
  // base: polished dark concrete with broad mottling
  g.fillStyle = '#3a3d44';
  g.fillRect(-S / 2, -S / 2, S, S);
  for (let i = 0; i < 260; i++) {
    const x = (r() - 0.5) * S;
    const y = (r() - 0.5) * S;
    const rad = 30 + r() * 160;
    const l = 40 + r() * 34;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(${l},${l + 2},${l + 8},0.22)`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // paving: concentric slab rings and radial joints
  g.strokeStyle = 'rgba(15,16,20,0.55)';
  g.lineWidth = 2;
  for (let rr = 12; rr < PLAZA_R - 3; rr += 12) {
    g.beginPath();
    g.arc(0, 0, rr * k, 0, Math.PI * 2);
    g.stroke();
    const n = Math.max(8, Math.round((rr * Math.PI * 2) / 12));
    for (let i = 0; i < n; i++) {
      const a = ((i + (rr / 12) * 0.5) / n) * Math.PI * 2;
      g.beginPath();
      g.moveTo(Math.cos(a) * rr * k, Math.sin(a) * rr * k);
      g.lineTo(Math.cos(a) * Math.min(PLAZA_R - 3, rr + 12) * k, Math.sin(a) * Math.min(PLAZA_R - 3, rr + 12) * k);
      g.stroke();
    }
  }
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = 1;
  for (let rr = 12; rr < PLAZA_R - 3; rr += 12) {
    g.beginPath();
    g.arc(0, 0, rr * k + 2, 0, Math.PI * 2);
    g.stroke();
  }

  // tyre marks: donuts around the circles, long arcs and figure-eight swoops
  const mark = (cx: number, cy: number, rad: number, a0: number, a1: number, alpha: number, w: number) => {
    g.strokeStyle = `rgba(8,8,10,${alpha})`;
    g.lineWidth = w;
    for (const off of [-0.8, 0.8]) {
      g.beginPath();
      g.arc(cx * k, cy * k, (rad + off) * k, a0, a1);
      g.stroke();
    }
  };
  // canvas y runs against world z
  const { x: sx, z: sz, half, r: sr } = STADIUM;
  for (let i = 0; i < 70; i++) {
    // the stadium hairpins are black with rubber
    const top = i % 2 ? 1 : -1;
    const a0 = top > 0 ? Math.PI : 0;
    const a = a0 + r() * Math.PI;
    mark(sx, -(sz + top * half), sr - 3 + r() * 7, a, a + 0.5 + r() * 1.6, 0.08 + r() * 0.16, 3 + r() * 2);
  }
  for (let i = 0; i < 30; i++) {
    const a = r() * Math.PI * 2;
    const rr = 26 + r() * 10;
    mark(0, 0, rr, a, a + 0.6 + r() * 2.2, 0.05 + r() * 0.1, 3 + r() * 2);
  }
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2;
    const d = 30 + r() * 50;
    const cx = Math.cos(a) * d;
    const cy = Math.sin(a) * d;
    mark(cx, cy, 4 + r() * 6, 0, Math.PI * 2, 0.06 + r() * 0.12, 3);
  }
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    mark(Math.cos(a) * 40, Math.sin(a) * 40, 35 + r() * 30, a + 2, a + 2.6 + r(), 0.06 + r() * 0.1, 3);
  }

  // painted lines
  const ring = (rad: number, color: string, w: number, dash: number[] = []) => {
    g.strokeStyle = color;
    g.lineWidth = w * k;
    g.setLineDash(dash.map((d) => d * k));
    g.beginPath();
    g.arc(0, 0, rad * k, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  };
  ring(30, 'rgba(240,244,255,0.75)', 0.35);
  // the gymkhana stadium: two hairpins joined by straights, dashed cyan with cone dots
  g.strokeStyle = 'rgba(41,224,255,0.75)';
  g.lineWidth = 0.45 * k;
  g.setLineDash([5 * k, 3.5 * k]);
  for (const off of [-5, 5]) {
    const rr = sr + off;
    g.beginPath();
    g.moveTo((sx + rr) * k, -(sz - half) * k);
    g.lineTo((sx + rr) * k, -(sz + half) * k);
    g.arc(sx * k, -(sz + half) * k, rr * k, 0, Math.PI, true);
    g.lineTo((sx - rr) * k, -(sz - half) * k);
    g.arc(sx * k, -(sz - half) * k, rr * k, Math.PI, 0, true);
    g.closePath();
    g.stroke();
  }
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,140,40,0.85)';
  for (const top of [-1, 1]) {
    g.beginPath();
    g.arc(sx * k, -(sz + top * half) * k, 0.8 * k, 0, Math.PI * 2);
    g.fill();
  }
  ring(78, 'rgba(240,244,255,0.6)', 0.3);
  ring(80, 'rgba(255,63,180,0.55)', 0.3);
  // centre emblem under the ring: a thin compass star
  g.fillStyle = 'rgba(240,244,255,0.14)';
  g.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rr = (i % 2 ? 5 : i % 4 ? 13 : 20) * k;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
  // lettering around the outer lane
  g.fillStyle = 'rgba(240,244,255,0.5)';
  g.font = `italic 900 ${Math.round(4.2 * k)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const words = ['JARDIM CELESTE', 'HYPERDRIFT', 'ZONA LIVRE', 'HYPERDRIFT'];
  words.forEach((word, wi) => {
    const mid = (wi / words.length) * Math.PI * 2 + Math.PI / 4;
    const step = 0.031;
    const chars = [...word];
    chars.forEach((ch, ci) => {
      const a = mid + (ci - (chars.length - 1) / 2) * step;
      g.save();
      g.rotate(a);
      g.translate(0, -86.5 * k);
      g.fillText(ch, 0, 0);
      g.restore();
    });
  });
  // red and white curbs on the outer edge
  const segs = 144;
  for (let i = 0; i < segs; i++) {
    g.fillStyle = i % 2 ? '#e8ecf2' : '#d0283c';
    g.beginPath();
    g.arc(0, 0, (PLAZA_R + 0.6) * k, (i / segs) * Math.PI * 2, ((i + 1) / segs) * Math.PI * 2);
    g.arc(0, 0, (PLAZA_R - 2.2) * k, ((i + 1) / segs) * Math.PI * 2, (i / segs) * Math.PI * 2, true);
    g.closePath();
    g.fill();
  }
  return finish(c, false);
}

/**
 * Banked rim ring: asphalt with a curb on the inside, lane dashes and a white edge line.
 * u runs across the ring (inside → force field), v along it (one tile every 24 m).
 */
export function bankTexture(): Texture | null {
  const W = 512;
  const H = 512;
  const cv = canvas(W, H);
  if (!cv) return null;
  const [c, g] = cv;
  const r = rng(99);
  const span = WALL_R + 0.6 - (BANK_IN - 1);
  const u = (rad: number) => ((rad - (BANK_IN - 1)) / span) * W;
  g.fillStyle = '#373a41';
  g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 22;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n + 2;
  }
  g.putImageData(img, 0, 0);
  // darker racing groove where everyone drives
  const grd = g.createLinearGradient(u(222), 0, u(240), 0);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.22)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(u(222), 0, u(240) - u(222), H);
  // tyre streaks
  for (let i = 0; i < 40; i++) {
    const x = u(216 + r() * 30);
    g.fillStyle = `rgba(5,5,8,${0.05 + r() * 0.1})`;
    g.fillRect(x, r() * H, 3 + r() * 3, 60 + r() * 300);
  }
  // inner curb blocks
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#e8ecf2' : '#d0283c';
    g.fillRect(0, (i * H) / 8, u(BANK_IN + 1.6), H / 8);
  }
  g.fillStyle = 'rgba(240,244,255,0.85)';
  g.fillRect(u(BANK_IN + 2.2), 0, u(BANK_IN + 2.5) - u(BANK_IN + 2.2) + 2, H);
  g.fillRect(u(WALL_R - 2.2), 0, 5, H);
  g.fillStyle = 'rgba(240,244,255,0.55)';
  for (const rad of [224, 236]) for (let y = 0; y < H; y += H / 2) g.fillRect(u(rad), y + 20, 4, H / 4);
  // glowing strip at the foot of the force field
  g.fillStyle = 'rgba(41,224,255,0.9)';
  g.fillRect(u(WALL_R - 0.6), 0, 4, H);
  return finish(c);
}

/** Concrete ramp surface with hazard stripes at the lip and chevrons pointing up the ramp. */
export function kickerTexture(): Texture | null {
  const cv = canvas(256, 512);
  if (!cv) return null;
  const [c, g] = cv;
  const r = rng(5);
  g.fillStyle = '#9da2aa';
  g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 3000; i++) {
    const l = 120 + r() * 80;
    g.fillStyle = `rgba(${l},${l},${l + 4},0.25)`;
    g.fillRect(r() * 256, r() * 512, 2, 2);
  }
  // seams
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 64; y < 512; y += 96) g.fillRect(0, y, 256, 2);
  // chevrons
  g.strokeStyle = 'rgba(41,224,255,0.85)';
  g.lineWidth = 14;
  g.lineCap = 'round';
  for (let y = 150; y < 470; y += 90) {
    g.beginPath();
    g.moveTo(70, y + 30);
    g.lineTo(128, y);
    g.lineTo(186, y + 30);
    g.stroke();
  }
  // hazard band at the lip (v = 0)
  for (let i = -2; i < 12; i++) {
    g.fillStyle = '#ffcc1a';
    g.beginPath();
    g.moveTo(i * 32, 0);
    g.lineTo(i * 32 + 16, 0);
    g.lineTo(i * 32 + 40, 40);
    g.lineTo(i * 32 + 24, 40);
    g.closePath();
    g.fill();
  }
  g.fillStyle = 'rgba(20,20,24,0.9)';
  g.fillRect(0, 40, 256, 6);
  return finish(c, false);
}
