/**
 * The cockpit's live displays, all painted into one small canvas texture:
 * the instrument cluster, the centre screen (or analogue clock) and the
 * yoke's display. Static dial faces are cached; only needles and numbers are
 * redrawn, at a modest rate.
 */
import { CanvasTexture, SRGBColorSpace } from 'three';

export interface DashState {
  rpm: number;
  speedKmh: number;
  gear: string;
  nitro: number;
  nitroActive: boolean;
  limiter: boolean;
  /** lateral and longitudinal g, roughly -1..1 */
  gLat: number;
  gLong: number;
  time: number;
}

export type DashStyle = 'analog' | 'digital' | 'race';

const W = 1024;
const H = 512;
const TACH_MAX = 8;
const SPEED_MAX = 360;

export class DashDisplay {
  readonly texture: CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private faces: HTMLCanvasElement | null = null;
  private trail: { x: number; y: number }[] = [];
  private lastClock = -1;

  constructor(
    private style: DashStyle,
    private accent: string,
    private yoke: boolean,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
    if (style === 'analog') this.faces = this.paintFaces();
  }

  dispose() {
    this.texture.dispose();
  }

  draw(s: DashState) {
    const g = this.g;
    if (this.style === 'analog') this.drawAnalog(s);
    else if (this.style === 'digital') this.drawDigital(s);
    else this.drawRace(s);
    if (this.yoke) {
      g.save();
      g.translate(0, 256);
      this.drawWheelLcd(s);
      g.restore();
    }
    this.texture.needsUpdate = true;
  }

  // ------------------------------------------------------------ analogue

  private dial(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, max: number, step: number, red: number, label: string, fmt: (v: number) => string) {
    const a0 = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    const bg = g.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
    bg.addColorStop(0, '#1a1d23');
    bg.addColorStop(1, '#050608');
    g.fillStyle = bg;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    // red zone
    g.strokeStyle = '#d0141e';
    g.lineWidth = r * 0.07;
    g.beginPath();
    g.arc(cx, cy, r * 0.86, a0 + (sweep * red) / max, a0 + sweep);
    g.stroke();
    const ticks = Math.round((max * 5) / step);
    for (let i = 0; i <= ticks; i++) {
      // integer steps: no 7.000000001 labels
      const v = (i * step) / 5;
      const major = i % 5 === 0;
      const a = a0 + (sweep * v) / max;
      const r0 = r * (major ? 0.74 : 0.8);
      g.strokeStyle = v >= red ? '#ff4040' : '#e8ecef';
      g.lineWidth = major ? 4 : 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
      g.stroke();
      if (major) {
        g.fillStyle = v >= red ? '#ff5050' : '#f2f4f6';
        g.font = `600 ${Math.round(r * 0.16)}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(fmt(Math.round(v)), cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
      }
    }
    g.fillStyle = '#8a929c';
    g.font = `500 ${Math.round(r * 0.11)}px system-ui, sans-serif`;
    g.fillText(label, cx, cy + r * 0.32);
  }

  private paintFaces(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#030304';
    g.fillRect(0, 0, 512, 256);
    this.dial(g, 128, 128, 118, TACH_MAX, 1, 6.8, 'x1000 rpm', (v) => String(v));
    this.dial(g, 384, 128, 118, SPEED_MAX, 40, 1e9, 'km/h', (v) => String(v));
    // clock face for the centre stack
    const cx = 768;
    const cy = 128;
    const r = 120;
    const bg = g.createRadialGradient(cx, cy - 40, 10, cx, cy, r);
    bg.addColorStop(0, '#f4efe4');
    bg.addColorStop(1, '#cfc6b4');
    g.fillStyle = bg;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const major = i % 5 === 0;
      g.strokeStyle = '#1b1b1d';
      g.lineWidth = major ? 6 : 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r * (major ? 0.78 : 0.86), cy + Math.sin(a) * r * (major ? 0.78 : 0.86));
      g.lineTo(cx + Math.cos(a) * r * 0.93, cy + Math.sin(a) * r * 0.93);
      g.stroke();
    }
    g.fillStyle = '#1b1b1d';
    g.font = '700 22px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('HYPERDRIFT', cx, cy + 46);
    return c;
  }

  private needle(cx: number, cy: number, r: number, frac: number, color: string) {
    const g = this.g;
    const a = Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1.02, frac));
    g.save();
    g.translate(cx, cy);
    g.rotate(a);
    g.shadowColor = color;
    g.shadowBlur = 12;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(-r * 0.16, -4);
    g.lineTo(r * 0.86, -1.5);
    g.lineTo(r * 0.86, 1.5);
    g.lineTo(-r * 0.16, 4);
    g.closePath();
    g.fill();
    g.restore();
    g.fillStyle = '#16181c';
    g.beginPath();
    g.arc(cx, cy, r * 0.12, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = this.accent;
    g.lineWidth = 3;
    g.stroke();
  }

  private drawAnalog(s: DashState) {
    const g = this.g;
    g.drawImage(this.faces!, 0, 0, 512, 256, 0, 0, 512, 256);
    this.needle(128, 128, 118, (s.rpm * 7.6) / TACH_MAX, '#ff6a1a');
    this.needle(384, 128, 118, s.speedKmh / SPEED_MAX, '#ff6a1a');
    // gear and odometer windows
    g.fillStyle = '#0b0d10';
    g.fillRect(108, 168, 40, 34);
    g.fillRect(350, 170, 68, 28);
    g.fillStyle = s.limiter ? '#ff3030' : '#f0f3f5';
    g.font = '700 28px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.gear, 128, 186);
    g.font = '600 20px ui-monospace, monospace';
    g.fillStyle = '#d6dade';
    g.fillText(String(Math.round(s.speedKmh)).padStart(3, '0'), 384, 185);
    // warning lamps between the dials
    g.fillStyle = s.nitroActive ? '#3cc8ff' : '#11232c';
    g.font = '700 18px system-ui, sans-serif';
    g.fillText('N₂O', 256, 222);
    g.fillStyle = s.limiter ? '#ff2a2a' : '#2a0c0c';
    g.beginPath();
    g.arc(256, 40, 9, 0, Math.PI * 2);
    g.fill();
    // nitro level as a little vertical gauge
    g.fillStyle = '#0d1418';
    g.fillRect(248, 80, 16, 100);
    g.fillStyle = '#3cc8ff';
    g.fillRect(248, 80 + 100 * (1 - s.nitro), 16, 100 * s.nitro);

    // clock (only redraws once a second)
    const now = new Date();
    const sec = now.getSeconds();
    if (sec !== this.lastClock) {
      this.lastClock = sec;
      g.drawImage(this.faces!, 640, 0, 256, 256, 640, 0, 256, 256);
      const cx = 768;
      const cy = 128;
      const hand = (a: number, len: number, w: number, c: string) => {
        g.strokeStyle = c;
        g.lineWidth = w;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(cx - Math.sin(a) * len * 0.15, cy + Math.cos(a) * len * 0.15);
        g.lineTo(cx + Math.sin(a) * len, cy - Math.cos(a) * len);
        g.stroke();
      };
      const m = now.getMinutes() + sec / 60;
      hand(((now.getHours() % 12) + m / 60) * (Math.PI / 6), 62, 8, '#1b1b1d');
      hand(m * (Math.PI / 30), 92, 6, '#1b1b1d');
      hand(sec * (Math.PI / 30), 100, 2, '#c8141c');
    }
  }

  // ------------------------------------------------------------ digital

  private drawDigital(s: DashState) {
    const g = this.g;
    // cluster
    const bg = g.createLinearGradient(0, 0, 0, 256);
    bg.addColorStop(0, '#05070b');
    bg.addColorStop(1, '#0c1119');
    g.fillStyle = bg;
    g.fillRect(0, 0, 512, 256);
    // tach: a sweeping arc of segments
    const n = 40;
    const lit = Math.round(Math.min(1.02, s.rpm) * n);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const a = Math.PI * (1.08 + 0.84 * t);
      const on = i < lit;
      g.strokeStyle = on ? (t > 0.88 ? '#ff2a3a' : t > 0.72 ? '#ffb020' : this.accent) : '#141b24';
      g.lineWidth = 14;
      g.beginPath();
      g.arc(256, 300, 250, a, a + 0.018);
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#f4f7fa';
    g.font = '700 104px system-ui, sans-serif';
    g.fillText(String(Math.round(s.speedKmh)), 256, 178);
    g.fillStyle = '#7d8a99';
    g.font = '600 22px system-ui, sans-serif';
    g.fillText('KM/H', 256, 210);
    // gear box
    g.strokeStyle = s.limiter ? '#ff2a3a' : this.accent;
    g.lineWidth = 3;
    g.strokeRect(410, 110, 64, 74);
    g.fillStyle = s.limiter ? '#ff2a3a' : '#f4f7fa';
    g.font = '700 56px system-ui, sans-serif';
    g.fillText(s.gear, 442, 167);
    // nitro bar
    g.fillStyle = '#0f1722';
    g.fillRect(30, 230, 180, 10);
    g.fillStyle = s.nitroActive ? '#9ff0ff' : '#3cc8ff';
    g.fillRect(30, 230, 180 * s.nitro, 10);
    g.fillStyle = '#7d8a99';
    g.font = '600 16px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText('N₂O', 30, 222);

    // centre screen: g-meter and boost
    g.save();
    g.translate(512, 0);
    const bg2 = g.createLinearGradient(0, 0, 512, 256);
    bg2.addColorStop(0, '#071019');
    bg2.addColorStop(1, '#0d1420');
    g.fillStyle = bg2;
    g.fillRect(0, 0, 512, 256);
    const cx = 150;
    const cy = 128;
    g.strokeStyle = '#1d2a3a';
    g.lineWidth = 2;
    for (const r of [35, 70, 105]) {
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(cx - 110, cy);
    g.lineTo(cx + 110, cy);
    g.moveTo(cx, cy - 110);
    g.lineTo(cx, cy + 110);
    g.stroke();
    const px = cx + Math.max(-1, Math.min(1, s.gLat)) * 100;
    const py = cy - Math.max(-1, Math.min(1, s.gLong)) * 100;
    this.trail.push({ x: px, y: py });
    if (this.trail.length > 24) this.trail.shift();
    for (let i = 0; i < this.trail.length; i++) {
      const p = this.trail[i];
      g.fillStyle = `rgba(60,200,255,${(i / this.trail.length) * 0.4})`;
      g.beginPath();
      g.arc(p.x, p.y, 5, 0, Math.PI * 2);
      g.fill();
    }
    g.shadowColor = this.accent;
    g.shadowBlur = 16;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(px, py, 9, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = '#7d8a99';
    g.font = '600 18px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('FORÇA G', cx, 246);
    g.textAlign = 'left';
    g.fillStyle = '#f4f7fa';
    g.font = '700 30px system-ui, sans-serif';
    g.fillText('HYPERDRIFT', 290, 60);
    g.fillStyle = '#7d8a99';
    g.font = '600 18px system-ui, sans-serif';
    g.fillText('NITRO', 290, 120);
    g.fillStyle = '#0f1722';
    g.fillRect(290, 132, 190, 22);
    g.fillStyle = s.nitroActive ? '#9ff0ff' : '#3cc8ff';
    g.fillRect(290, 132, 190 * s.nitro, 22);
    g.fillStyle = '#7d8a99';
    g.fillText('ROTAÇÃO', 290, 192);
    g.fillStyle = '#f4f7fa';
    g.font = '700 30px system-ui, sans-serif';
    g.fillText(`${Math.round(Math.min(1.02, s.rpm) * 7600)}`, 290, 228);
    g.restore();
  }

  // ------------------------------------------------------------ race

  private drawRace(s: DashState) {
    const g = this.g;
    g.fillStyle = '#020304';
    g.fillRect(0, 0, 512, 256);
    // rpm strip
    const n = 24;
    const lit = Math.round(Math.min(1, s.rpm) * n);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      g.fillStyle = i < lit ? (t > 0.85 ? '#ff2030' : t > 0.65 ? '#ffc020' : '#30ff70') : '#0e1410';
      g.fillRect(16 + i * 20.3, 14, 16, 30);
    }
    const flash = s.limiter && Math.sin(s.time * 40) > 0;
    g.fillStyle = flash ? '#ff2030' : '#ffffff';
    g.font = '800 150px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.gear, 256, 156);
    g.font = '700 54px ui-monospace, monospace';
    g.fillStyle = '#e8eef4';
    g.textAlign = 'left';
    g.fillText(String(Math.round(s.speedKmh)), 22, 150);
    g.font = '600 20px ui-monospace, monospace';
    g.fillStyle = '#6a7a88';
    g.fillText('KM/H', 24, 196);
    g.textAlign = 'right';
    g.font = '700 54px ui-monospace, monospace';
    g.fillStyle = s.nitroActive ? '#9ff0ff' : '#3cc8ff';
    g.fillText(`${Math.round(s.nitro * 100)}`, 490, 150);
    g.font = '600 20px ui-monospace, monospace';
    g.fillStyle = '#6a7a88';
    g.fillText('N₂O %', 488, 196);
    g.strokeStyle = this.accent;
    g.lineWidth = 3;
    g.strokeRect(4, 4, 504, 248);
  }

  private drawWheelLcd(s: DashState) {
    const g = this.g;
    g.fillStyle = '#020304';
    g.fillRect(0, 0, 256, 128);
    const n = 10;
    const lit = Math.round(Math.min(1, s.rpm) * n);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      g.fillStyle = i < lit ? (t > 0.8 ? '#ff2030' : t > 0.55 ? '#ffc020' : '#30ff70') : '#0e1410';
      g.fillRect(10 + i * 24, 8, 18, 14);
    }
    g.fillStyle = '#ffffff';
    g.font = '800 84px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.gear, 128, 80);
    g.font = '700 26px ui-monospace, monospace';
    g.textAlign = 'left';
    g.fillText(String(Math.round(s.speedKmh)), 8, 100);
    g.textAlign = 'right';
    g.fillStyle = '#3cc8ff';
    g.fillText(`${Math.round(s.nitro * 100)}`, 248, 100);
  }
}
