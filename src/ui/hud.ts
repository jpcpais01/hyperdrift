import type { Track } from '../track/track';
import { gradeFor, type DriftScore } from '../zone/driftScore';
import { BANK_IN, PLAZA_R, WALL_R, type ZoneLayout } from '../zone/layout';

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

export interface ZoneHudData {
  speedKmh: number;
  gear: number;
  nitro: number;
  nitroActive: boolean;
  drift: number;
  dots: HudCarDot[];
  /** player heading on the map, radians (atan2(fwd.x, fwd.z)) */
  heading: number;
}

const ORD = ['1º', '2º', '3º', '4º'];

/** 12345 → "12 345" */
export function formatScore(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
}

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
  private zone!: {
    best: HTMLElement;
    total: HTMLElement;
    drift: HTMLElement;
    score: HTMLElement;
    mult: HTMLElement;
    grace: HTMLElement;
    grade: HTMLElement;
    bank: HTMLElement;
    intro: HTMLElement;
    board: HTMLElement;
  };
  private boardKey = '';
  private shownBest = -1;
  private shownTotal = -1;
  private bankTimer = 0;

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
      <button class="hud-cam" aria-label="Câmara (C)" title="Câmara (C)"><svg class="cam-ico" viewBox="0 0 24 24"><path d="M3 8.5h12v9H3zM15 11.5l6-3.5v10l-6-3.5"/></svg><svg class="wheel-ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M3.6 11.2h6.2M14.2 11.2h6.2M12 14.2v6.2"/></svg><span class="hud-cam-dots"><i></i><i></i><i></i></span></button>
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
      <div class="hud-wrong">SENTIDO ERRADO</div>
      <div class="hud-zone">
        <div class="hz-title">ZONA LIVRE</div>
        <div class="hz-row">RECORDE <b class="hz-best">0</b></div>
        <div class="hz-row">TOTAL <b class="hz-total">0</b></div>
        <ol class="hz-board"></ol>
      </div>
      <div class="hud-drift">
        <div class="hd-label">DRIFT</div>
        <div class="hd-line"><span class="hd-score">0</span><span class="hd-mult">×1</span></div>
        <div class="hd-grace"><i></i></div>
        <div class="hd-grade"></div>
      </div>
      <div class="hud-bank"></div>
      <div class="hud-intro">
        <div class="hi-kicker">ZONA LIVRE</div>
        <h2>JARDIM CELESTE</h2>
        <p>Sem voltas, sem relógio. Encadeia drifts para multiplicar os pontos.</p>
        <small>Acelera para começar</small>
      </div>`;
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
    this.zone = {
      best: q('.hz-best'),
      total: q('.hz-total'),
      drift: q('.hud-drift'),
      score: q('.hd-score'),
      mult: q('.hd-mult'),
      grace: q('.hd-grace i'),
      grade: q('.hd-grade'),
      bank: q('.hud-bank'),
      intro: q('.hud-intro'),
      board: q('.hz-board'),
    };
    this.camBtn = q('.hud-cam');
    this.camBtn.addEventListener('click', () => {
      this.onCamera?.();
      this.camBtn.blur();
    });
  }

  /** Lights one dot per zoom step: near = 1, medium = 2, far = 3; the cockpit shows a steering wheel. */
  setCameraZoom(level: number, announce: string | null = null) {
    this.camBtn.dataset.zoom = String(level);
    if (announce) this.message(announce, 1.1);
  }

  show(v: boolean, mode: 'race' | 'timetrial' | 'zone' = 'race') {
    this.el.classList.toggle('hidden', !v);
    this.el.classList.toggle('tt', mode === 'timetrial');
    this.el.classList.toggle('zone', mode === 'zone');
    if (!v) {
      this.zone.drift.classList.remove('on', 'fail');
      this.zone.bank.className = 'hud-bank';
      this.msg.classList.remove('show');
      this.msgTimer = 0;
    }
  }

  // ------------------------------------------------------------ free roam

  /** Island map: rim ring, meadow, plaza, the ring and gates, kickers and groves. */
  setZoneMap(L: ZoneLayout) {
    const size = 180;
    const R = WALL_R + 4;
    const scale = (size - 16) / (2 * R);
    this.mapXf = { minx: -R - 8 / scale, minz: -R - 8 / scale, scale };
    const bg = document.createElement('canvas');
    bg.width = bg.height = size;
    const g = bg.getContext('2d')!;
    const [cx, cy] = this.project(0, 0);
    const circle = (r: number) => {
      g.beginPath();
      g.arc(cx, cy, r * scale, 0, Math.PI * 2);
    };
    circle(WALL_R);
    g.fillStyle = 'rgba(20,40,30,0.45)';
    g.fill();
    g.lineWidth = (WALL_R - BANK_IN) * scale;
    g.strokeStyle = 'rgba(30,32,40,0.6)';
    circle((WALL_R + BANK_IN) / 2);
    g.stroke();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(41,224,255,0.9)';
    circle(WALL_R);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 1.5;
    circle(BANK_IN);
    g.stroke();
    circle(PLAZA_R);
    g.fillStyle = 'rgba(60,64,74,0.85)';
    g.fill();
    g.stroke();
    // the meadow loop
    g.beginPath();
    L.tour.forEach((p, i) => {
      const [x, y] = this.project(p.x, p.z);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.closePath();
    g.strokeStyle = 'rgba(200,170,120,0.55)';
    g.lineWidth = 1.5;
    g.stroke();
    // groves
    g.fillStyle = 'rgba(255,150,190,0.55)';
    for (const t of L.trees) {
      if (Math.hypot(t.x, t.z) > WALL_R) continue;
      const [x, y] = this.project(t.x, t.z);
      g.beginPath();
      g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
    // kickers and gates
    g.fillStyle = '#ffcc1a';
    for (const k of L.kickers) {
      const [x, y] = this.project(k.x, k.z);
      g.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
    g.strokeStyle = 'rgba(41,224,255,0.95)';
    g.lineWidth = 2;
    for (const gt of L.gates) {
      const [x0, y0] = this.project(gt.x - gt.ax * gt.half, gt.z - gt.az * gt.half);
      const [x1, y1] = this.project(gt.x + gt.ax * gt.half, gt.z + gt.az * gt.half);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    // the chrome ring across the plaza
    const [r0x, r0y] = this.project(-21, 0);
    const [r1x, r1y] = this.project(21, 0);
    g.strokeStyle = '#fff';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(r0x, r0y);
    g.lineTo(r1x, r1y);
    g.stroke();
    this.mapBg = bg;
  }

  setZoneScore(s: DriftScore) {
    this.shownBest = this.shownTotal = -1;
    this.zone.best.textContent = formatScore(s.best);
    this.zone.total.textContent = formatScore(s.total);
  }

  /** Online: everybody in the zone, most points first (null hides it). */
  setZoneBoard(rows: { name: string; color: string; total: number; me: boolean }[] | null) {
    const key = rows ? JSON.stringify(rows) : '';
    if (key === this.boardKey) return;
    this.boardKey = key;
    const b = this.zone.board;
    b.replaceChildren();
    for (const r of rows ?? []) {
      const li = document.createElement('li');
      if (r.me) li.className = 'me';
      const dot = document.createElement('i');
      dot.style.background = r.color;
      const name = document.createElement('span');
      name.textContent = r.name;
      const pts = document.createElement('b');
      pts.textContent = formatScore(r.total);
      li.append(dot, name, pts);
      b.appendChild(li);
    }
  }

  zoneIntro(v: boolean) {
    this.zone.intro.classList.toggle('show', v);
  }

  zoneMult(m: number) {
    const el = this.zone.mult;
    el.textContent = `×${m}`;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  zoneBank(score: number, grade: string, best: boolean) {
    const b = this.zone.bank;
    b.innerHTML = `<span class="hb-score">+${formatScore(score)}</span>${grade ? `<span class="hb-grade">${grade}!</span>` : ''}${best ? '<span class="hb-best">NOVO RECORDE</span>' : ''}`;
    b.className = 'hud-bank';
    void b.offsetWidth;
    b.className = `hud-bank show${best ? ' best' : ''}`;
    this.bankTimer = 2.2;
    this.zone.drift.classList.remove('on');
  }

  zoneFail() {
    const d = this.zone.drift;
    d.classList.remove('fail');
    void d.offsetWidth;
    d.classList.add('fail');
    this.zone.grade.textContent = 'FALHOU';
    this.bankTimer = 0;
  }

  updateZone(d: ZoneHudData, s: DriftScore, dt: number) {
    this.speed.textContent = String(Math.round(d.speedKmh));
    this.gear.textContent = String(d.gear + 1);
    this.boostBar.style.transform = `scaleX(${d.nitro.toFixed(3)})`;
    this.nitroRow.classList.toggle('ready', d.nitro > 0.08);
    this.nitroRow.classList.toggle('burn', d.nitroActive);
    this.driftBar.style.transform = `scaleX(${d.drift.toFixed(3)})`;
    const z = this.zone;
    if (s.best !== this.shownBest) {
      this.shownBest = s.best;
      z.best.textContent = formatScore(s.best);
    }
    if (s.total !== this.shownTotal) {
      this.shownTotal = s.total;
      z.total.textContent = formatScore(s.total);
    }
    if (s.active) {
      z.drift.classList.add('on');
      z.drift.classList.remove('fail');
      z.score.textContent = formatScore(s.chain);
      if (z.mult.textContent !== `×${s.mult}`) z.mult.textContent = `×${s.mult}`;
      z.grace.style.transform = `scaleX(${s.grace.toFixed(3)})`;
      z.drift.dataset.m = String(s.mult);
      const grade = gradeFor(s.score);
      if (z.grade.textContent !== grade) z.grade.textContent = grade;
    } else if (!z.drift.classList.contains('fail')) {
      z.drift.classList.remove('on');
    }
    if (this.bankTimer > 0) {
      this.bankTimer -= dt;
      if (this.bankTimer <= 0) z.bank.classList.remove('show');
    }
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
        if (dot.player) {
          // an arrow pointing where you are heading (the map is mirrored in x)
          g.save();
          g.translate(x, y);
          g.rotate(-d.heading);
          g.beginPath();
          g.moveTo(0, -8);
          g.lineTo(5.5, 6);
          g.lineTo(0, 3);
          g.lineTo(-5.5, 6);
          g.closePath();
          g.fillStyle = dot.color;
          g.fill();
          g.lineWidth = 2;
          g.strokeStyle = '#fff';
          g.stroke();
          g.restore();
          continue;
        }
        g.beginPath();
        g.arc(x, y, 4, 0, Math.PI * 2);
        g.fillStyle = dot.color;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.stroke();
      }
    }
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
