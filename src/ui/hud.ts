import type { Track } from '../track/track';

export interface HudCarDot {
  x: number;
  z: number;
  color: string;
  player: boolean;
}

export interface HudData {
  speedKmh: number;
  gear: number;
  nitro: number; // 0..1 nitro tank
  nitroActive: boolean;
  drift: number; // 0..1 drift charge
  place: number;
  total: number;
  lap: number;
  laps: number;
  time: number;
  lapTime: number;
  bestLap: number | null;
  ghostDelta: number | null;
  dots: HudCarDot[];
  wrongWay: boolean;
}

export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t * 1000) % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

const ORD = ['1º', '2º', '3º', '4º'];

export class Hud {
  readonly el: HTMLElement;
  private speed: HTMLElement;
  private gear: HTMLElement;
  private boostBar: HTMLElement;
  private nitroRow: HTMLElement;
  private driftBar: HTMLElement;
  private place: HTMLElement;
  private lap: HTMLElement;
  private time: HTMLElement;
  private best: HTMLElement;
  private msg: HTMLElement;
  private countdown: HTMLElement;
  private wrong: HTMLElement;
  private map: HTMLCanvasElement;
  private mapBg: HTMLCanvasElement | null = null;
  private mapXf = { minx: 0, minz: 0, scale: 1 };
  private msgTimer = 0;
  onPause: (() => void) | null = null;
  onCamera: (() => void) | null = null;
  private camBtn: HTMLElement;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud hidden';
    this.el.innerHTML = `
      <div class="hud-tl">
        <div class="hud-place"><span class="v">1º</span><small>/4</small></div>
        <div class="hud-lap">VOLTA <span class="v">1/3</span></div>
      </div>
      <div class="hud-tc">
        <div class="hud-time">0:00.000</div>
        <div class="hud-best">MELHOR --:--.---</div>
      </div>
      <canvas class="hud-map" width="180" height="180"></canvas>
      <button class="hud-cam" aria-label="Câmara (C)" title="Câmara (C)"><svg viewBox="0 0 24 24"><path d="M3 8.5h12v9H3zM15 11.5l6-3.5v10l-6-3.5"/></svg><span class="hud-cam-dots"><i></i><i></i><i></i></span></button>
      <button class="hud-pause" aria-label="Pausa"><svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg></button>
      <div class="hud-br">
        <div class="hud-speed"><span class="v">0</span><small>km/h</small></div>
        <div class="hud-gear">1</div>
        <div class="hud-bars">
          <div class="nitro-row"><b>N₂O</b><div class="bar boost"><i></i></div></div>
          <div class="bar drift"><i></i></div>
        </div>
      </div>
      <div class="hud-msg"></div>
      <div class="hud-count"></div>
      <div class="hud-wrong">SENTIDO ERRADO</div>`;
    root.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.speed = q('.hud-speed .v');
    this.gear = q('.hud-gear');
    this.boostBar = q('.bar.boost i');
    this.nitroRow = q('.nitro-row');
    this.driftBar = q('.bar.drift i');
    this.place = q('.hud-place');
    this.lap = q('.hud-lap .v');
    this.time = q('.hud-time');
    this.best = q('.hud-best');
    this.msg = q('.hud-msg');
    this.countdown = q('.hud-count');
    this.wrong = q('.hud-wrong');
    this.map = q('.hud-map') as HTMLCanvasElement;
    q('.hud-pause').addEventListener('click', () => this.onPause?.());
    this.camBtn = q('.hud-cam');
    this.camBtn.addEventListener('click', () => {
      this.onCamera?.();
      this.camBtn.blur();
    });
  }

  /** Lights one dot per zoom step: near = 1, medium = 2, far = 3. */
  setCameraZoom(level: number, announce: string | null = null) {
    this.camBtn.dataset.zoom = String(level);
    if (announce) this.message(announce, 1.1);
  }

  show(v: boolean, mode: 'race' | 'timetrial' = 'race') {
    this.el.classList.toggle('hidden', !v);
    this.el.classList.toggle('tt', mode === 'timetrial');
  }

  setTrack(track: Track) {
    let minx = Infinity;
    let maxx = -Infinity;
    let minz = Infinity;
    let maxz = -Infinity;
    for (const s of track.samples) {
      minx = Math.min(minx, s.pos.x);
      maxx = Math.max(maxx, s.pos.x);
      minz = Math.min(minz, s.pos.z);
      maxz = Math.max(maxz, s.pos.z);
    }
    const size = 180;
    const pad = 14;
    const scale = (size - pad * 2) / Math.max(maxx - minx, maxz - minz);
    this.mapXf = { minx: minx - (size / scale - (maxx - minx)) / 2 + 0, minz: minz - (size / scale - (maxz - minz)) / 2, scale };
    const bg = document.createElement('canvas');
    bg.width = bg.height = size;
    const g = bg.getContext('2d')!;
    g.lineJoin = 'round';
    const path = () => {
      g.beginPath();
      track.samples.forEach((s, i) => {
        const [x, y] = this.project(s.pos.x, s.pos.z);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
    };
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 7;
    path();
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 3;
    path();
    g.stroke();
    const [sx, sy] = this.project(track.samples[0].pos.x, track.samples[0].pos.z);
    g.fillStyle = '#fff';
    g.fillRect(sx - 4, sy - 4, 8, 8);
    this.mapBg = bg;
  }

  private project(x: number, z: number): [number, number] {
    const { minx, minz, scale } = this.mapXf;
    // mirror x so the map matches the driver's left/right
    return [180 - (x - minx) * scale, 180 - (z - minz) * scale];
  }

  message(text: string, seconds = 1.6, cls = '') {
    this.msg.textContent = text;
    this.msg.className = `hud-msg show ${cls}`;
    this.msgTimer = seconds;
  }

  setCountdown(text: string) {
    this.countdown.textContent = text;
    this.countdown.classList.toggle('show', !!text);
    if (text) {
      this.countdown.classList.remove('pop');
      void this.countdown.offsetWidth;
      this.countdown.classList.add('pop');
    }
  }

  update(d: HudData, dt: number) {
    this.speed.textContent = String(Math.round(d.speedKmh));
    this.gear.textContent = String(d.gear + 1);
    this.boostBar.style.transform = `scaleX(${d.nitro.toFixed(3)})`;
    this.nitroRow.classList.toggle('ready', d.nitro > 0.08);
    this.nitroRow.classList.toggle('burn', d.nitroActive);
    this.driftBar.style.transform = `scaleX(${d.drift.toFixed(3)})`;
    this.place.innerHTML = `<span class="v">${ORD[d.place - 1] ?? d.place}</span><small>/${d.total}</small>`;
    this.lap.textContent = `${Math.max(1, Math.min(d.lap, d.laps))}/${d.laps}`;
    this.time.textContent = formatTime(d.time);
    let best = `MELHOR ${formatTime(d.bestLap)}`;
    if (d.ghostDelta !== null) best += `  <b class="${d.ghostDelta <= 0 ? 'good' : 'bad'}">${d.ghostDelta <= 0 ? '−' : '+'}${Math.abs(d.ghostDelta).toFixed(2)}</b>`;
    this.best.innerHTML = best;
    this.wrong.classList.toggle('show', d.wrongWay);
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msg.classList.remove('show');
    }
    const g = this.map.getContext('2d');
    if (g && this.mapBg) {
      g.clearRect(0, 0, 180, 180);
      g.drawImage(this.mapBg, 0, 0);
      for (const dot of d.dots) {
        const [x, y] = this.project(dot.x, dot.z);
        g.beginPath();
        g.arc(x, y, dot.player ? 6 : 4.5, 0, Math.PI * 2);
        g.fillStyle = dot.color;
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = dot.player ? '#fff' : 'rgba(0,0,0,0.6)';
        g.stroke();
      }
    }
  }
}
