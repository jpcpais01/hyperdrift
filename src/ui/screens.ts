import { PATCH_NOTES } from '../patchNotes';
import {
  optionsFor,
  paintById,
  SUB_SLOTS,
  TECH_SLOTS,
  VISUAL_SLOTS,
  type CarBuild,
  type PartOption,
  type Slot,
} from '../car/parts';
import { INTERIOR_SLOTS, INTERIOR_SUB_SLOTS } from '../car/interiorParts';
import { computeStats, displayStats, type DisplayStats } from '../car/stats';
import { audio } from '../core/audio';
import { isTouch } from '../core/fullscreen';
import type { ControlMode, Input } from '../core/input';
import { checkAndReload, onUpdatePhase, type UpdatePhase } from '../core/updater';
import { TILT_LOCK_DEG, TILT_SENS_LABELS, type TiltSens } from '../core/tilt';
import type { RaceResult } from '../game/race';
import { formatTime } from './hud';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------------------------------------------------------------- main menu

const UPDATE_LABELS: Record<UpdatePhase, string> = {
  idle: 'ATUALIZAR',
  checking: 'A PROCURAR…',
  installing: 'A INSTALAR…',
  reloading: 'A RECARREGAR…',
};

export class MenuScreen {
  readonly el: HTMLElement;
  onRace: (() => void) | null = null;
  onTimeTrial: (() => void) | null = null;
  onGarage: (() => void) | null = null;
  onToggleSound: (() => boolean) | null = null;
  onControls: (() => void) | null = null;

  constructor(root: HTMLElement, muted: boolean, controlsLabel: string | null) {
    this.el = h('div', 'screen menu hidden');
    this.el.innerHTML = `
      <div class="menu-inner">
        <h1 class="logo">HYPER<span>DRIFT</span></h1>
        <p class="tagline">Pistas suspensas no céu. Carros feitos peça a peça.</p>
        <nav class="menu-buttons">
          <button class="btn primary" data-a="race">Corrida <small>contra 3 rivais</small></button>
          <button class="btn" data-a="tt">Contrarrelógio <small>contra o teu fantasma</small></button>
          <button class="btn" data-a="garage">Garagem <small>monta o teu carro</small></button>
        </nav>
      </div>
      <div class="menu-foot">
        <button class="btn-icon" data-a="sound" aria-label="Som">${muted ? 'SOM: DESLIGADO' : 'SOM: LIGADO'}</button>
        ${controlsLabel ? `<button class="btn-icon" data-a="controls">${controlsLabel}</button>` : ''}
        <button class="btn-icon" data-a="notes">PATCH NOTES</button>
        <button class="btn-icon btn-update" data-a="update" aria-label="Atualizar o jogo"><span class="upd-ico" aria-hidden="true">↻</span><span class="upd-label">ATUALIZAR</span></button>
        <span class="keys">Teclado: ↑ acelerar · ↓ travar/marcha-atrás · ← → virar · Espaço nitro · travar a curvar = drift · C câmara</span>
      </div>
      <div class="notes hidden">
        <div class="results-card">
          <h2>Patch notes</h2>
          <div class="notes-list">${PATCH_NOTES.map(
            (g) => `<section><h3>${g.hour}</h3><ul>${g.entries.map((e) => `<li>${e}</li>`).join('')}</ul></section>`,
          ).join('')}</div>
          <button class="btn primary" data-a="notes-close">Fechar</button>
        </div>
      </div>`;
    root.appendChild(this.el);
    const upd = this.el.querySelector<HTMLButtonElement>('[data-a="update"]')!;
    onUpdatePhase((p) => {
      upd.dataset.phase = p;
      upd.disabled = p !== 'idle';
      upd.querySelector('.upd-label')!.textContent = UPDATE_LABELS[p];
    });
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      audio.click();
      const a = b.dataset.a;
      if (a === 'race') this.onRace?.();
      if (a === 'tt') this.onTimeTrial?.();
      if (a === 'garage') this.onGarage?.();
      if (a === 'controls') this.onControls?.();
      if (a === 'update') void checkAndReload();
      if (a === 'notes' || a === 'notes-close') this.el.querySelector('.notes')!.classList.toggle('hidden', a === 'notes-close');
      if (a === 'sound' && this.onToggleSound) {
        const m = this.onToggleSound();
        b.textContent = m ? 'SOM: DESLIGADO' : 'SOM: LIGADO';
      }
    });
  }

  show(v: boolean) {
    this.el.classList.toggle('hidden', !v);
    if (!v) this.el.querySelector('.notes')!.classList.add('hidden');
  }

  setControlsLabel(label: string) {
    const b = this.el.querySelector('[data-a="controls"]');
    if (b) b.textContent = label;
  }
}

// ---------------------------------------------------------------- garage

type GarageTab = 'visual' | 'tech' | 'interior';

const STAT_LABELS: [keyof DisplayStats, string][] = [
  ['speed', 'Velocidade'],
  ['accel', 'Aceleração'],
  ['grip', 'Aderência'],
  ['boost', 'Boost'],
];

export class GarageScreen {
  readonly el: HTMLElement;
  private tab: GarageTab = 'visual';
  private slot: Slot = 'body';
  /** the chosen sub-entry when the slot has a row of them (paint zones, vinyl/rim colour) */
  private sub: Slot = 'body';
  private build!: CarBuild;
  private slotsEl: HTMLElement;
  private subEl: HTMLElement;
  private optsEl: HTMLElement;
  private statsEl: HTMLElement;
  onChange: ((b: CarBuild, slot: Slot) => void) | null = null;
  /** the camera follows what's being edited: the interior tab sits you in the driver's seat */
  onView: ((interior: boolean, slot: Slot) => void) | null = null;
  onBack: (() => void) | null = null;
  onRace: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = h('div', 'screen garage hidden');
    this.el.innerHTML = `
      <header class="garage-top">
        <button class="btn small" data-a="back">‹ Menu</button>
        <h2>Garagem</h2>
        <button class="btn small primary" data-a="race">Correr ›</button>
      </header>
      <aside class="garage-panel">
        <div class="tabs">
          <button data-tab="visual" class="on">Visual</button>
          <button data-tab="interior">Interior</button>
          <button data-tab="tech">Técnico</button>
        </div>
        <div class="slots"></div>
        <div class="slots subslots"></div>
        <div class="options"></div>
        <div class="stats"></div>
      </aside>
      <div class="garage-hint"><span class="orbit-ico" aria-hidden="true"></span>${
        isTouch() ? 'Arrasta para orbitar · Pinça para zoom · Toque duplo repõe' : 'Arrasta para orbitar · Roda para zoom · Duplo clique repõe'
      }</div>`;
    root.appendChild(this.el);
    this.slotsEl = this.el.querySelector('.slots')!;
    this.subEl = this.el.querySelector('.subslots')!;
    this.optsEl = this.el.querySelector('.options')!;
    this.statsEl = this.el.querySelector('.stats')!;
    this.el.querySelector('[data-a="back"]')!.addEventListener('click', () => {
      audio.click();
      this.onBack?.();
    });
    this.el.querySelector('[data-a="race"]')!.addEventListener('click', () => {
      audio.click();
      this.onRace?.();
    });
    this.el.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        audio.click();
        this.tab = (b as HTMLElement).dataset.tab as GarageTab;
        this.slot = (this.tab === 'visual' ? VISUAL_SLOTS : this.tab === 'interior' ? INTERIOR_SLOTS : TECH_SLOTS)[0].slot;
        this.sub = this.slot;
        this.el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
        this.render();
      }),
    );
  }

  show(v: boolean, build?: CarBuild) {
    if (build) this.build = { ...build };
    this.el.classList.toggle('hidden', !v);
    if (v) this.render();
  }

  private render() {
    const slots: { slot: Slot; label: string }[] = this.tab === 'visual' ? VISUAL_SLOTS : this.tab === 'interior' ? INTERIOR_SLOTS : TECH_SLOTS;
    this.slotsEl.innerHTML = '';
    for (const s of slots) {
      const b = h('button', s.slot === this.slot ? 'on' : '', esc(s.label));
      b.addEventListener('click', () => {
        audio.click();
        this.slot = s.slot;
        this.sub = s.slot;
        this.render();
      });
      this.slotsEl.appendChild(b);
    }
    const subs: { slot: Slot; label: string }[] | undefined =
      SUB_SLOTS[this.slot as keyof typeof SUB_SLOTS] ?? INTERIOR_SUB_SLOTS[this.slot as keyof typeof INTERIOR_SUB_SLOTS];
    this.subEl.innerHTML = '';
    this.subEl.classList.toggle('hidden', !subs);
    if (!subs || !subs.some((x) => x.slot === this.sub)) this.sub = this.slot;
    for (const s of subs ?? []) {
      const sw = this.swatchOf(s.slot, this.build[s.slot]);
      const b = h('button', s.slot === this.sub ? 'on' : '', `${sw ? `<i class="dot" style="background:${sw}"></i>` : ''}${esc(s.label)}`);
      b.addEventListener('click', () => {
        audio.click();
        this.sub = s.slot;
        this.render();
      });
      this.subEl.appendChild(b);
    }
    const slot = this.sub;
    this.onView?.(this.tab === 'interior', slot);
    this.optsEl.innerHTML = '';
    const opts: PartOption[] = optionsFor(slot);
    for (const o of opts) {
      const card = h('button', `opt${this.build[slot] === o.id ? ' on' : ''}`);
      const sw = this.swatchOf(slot, o.id);
      card.innerHTML = `${sw ? `<i class="swatch" style="background:${sw}"></i>` : ''}<b>${esc(o.name)}</b><small>${esc(o.desc)}</small>`;
      card.addEventListener('click', () => {
        audio.click();
        this.build = { ...this.build, [slot]: o.id };
        this.onChange?.(this.build, slot);
        this.render();
      });
      card.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.renderStats({ ...this.build, [slot]: o.id });
      });
      card.addEventListener('pointerleave', () => this.renderStats());
      this.optsEl.appendChild(card);
    }
    this.renderStats();
  }

  /** CSS background of the colour an option stands for, or null for non-colour options. */
  private swatchOf(slot: Slot, id: string): string | null {
    const o = optionsFor(slot).find((x) => x.id === id);
    if (!o?.swatch) {
      // "same as the body" shows the body paint
      if (id === 'same') return paintById(this.build.paint).swatch ?? null;
      return null;
    }
    if (slot === 'vinylColor' && id === 'auto') return '#' + paintById(this.build.paint).accent.toString(16).padStart(6, '0');
    if (slot === 'rimColor' && id === 'body') return paintById(this.build.paint).swatch ?? null;
    return o.swatch;
  }

  private renderStats(preview?: CarBuild) {
    const cur = displayStats(computeStats(this.build));
    const pre = preview ? displayStats(computeStats(preview)) : cur;
    this.statsEl.innerHTML = STAT_LABELS.map(([k, label]) => {
      const a = cur[k];
      const b = pre[k];
      const lo = Math.min(a, b);
      const diff = b - a;
      return `<div class="stat"><span>${label}</span><div class="sbar"><i style="width:${lo * 10}%"></i>${
        Math.abs(diff) > 0.05 ? `<em class="${diff > 0 ? 'up' : 'down'}" style="left:${lo * 10}%;width:${Math.abs(diff) * 10}%"></em>` : ''
      }</div><b>${b.toFixed(1)}</b></div>`;
    }).join('');
  }
}

// ---------------------------------------------------------------- results

export class ResultsScreen {
  readonly el: HTMLElement;
  onAgain: (() => void) | null = null;
  onGarage: (() => void) | null = null;
  onMenu: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = h('div', 'screen results hidden');
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      audio.click();
      if (b.dataset.a === 'again') this.onAgain?.();
      if (b.dataset.a === 'garage') this.onGarage?.();
      if (b.dataset.a === 'menu') this.onMenu?.();
    });
  }

  show(r: RaceResult | null) {
    this.el.classList.toggle('hidden', !r);
    if (!r) return;
    const player = r.entries.find((e) => e.isPlayer);
    const title = r.mode === 'timetrial' ? (r.newRecord ? 'Novo recorde!' : 'Contrarrelógio') : player?.place === 1 ? 'Vitória!' : `${player?.place ?? '-'}º lugar`;
    const rows =
      r.mode === 'race'
        ? r.entries
            .map(
              (e) =>
                `<tr class="${e.isPlayer ? 'me' : ''}"><td>${e.place}º</td><td><i class="dot" style="background:${e.color}"></i>${esc(e.name)}</td><td>${formatTime(e.time)}</td><td>${formatTime(e.bestLap)}</td></tr>`,
            )
            .join('')
        : r.lapTimes
            .map((t, i) => `<tr class="${t === r.bestLap ? 'me' : ''}"><td>Volta ${i + 1}</td><td></td><td>${formatTime(t)}</td><td>${t === r.bestLap ? 'melhor' : ''}</td></tr>`)
            .join('');
    this.el.innerHTML = `
      <div class="results-card">
        <h2>${esc(title)}</h2>
        <table>
          <thead><tr><th></th><th>${r.mode === 'race' ? 'Piloto' : ''}</th><th>Tempo</th><th>${r.mode === 'race' ? 'Melhor volta' : ''}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${r.bestLap !== null ? `<p class="best">A tua melhor volta: <b>${formatTime(r.bestLap)}</b></p>` : ''}
        <div class="row">
          <button class="btn primary" data-a="again">Outra vez</button>
          <button class="btn" data-a="garage">Garagem</button>
          <button class="btn" data-a="menu">Menu</button>
        </div>
      </div>`;
  }
}

// ---------------------------------------------------------------- pause

export class PauseScreen {
  readonly el: HTMLElement;
  onResume: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  onControls: (() => void) | null = null;

  constructor(root: HTMLElement, withControls: boolean) {
    this.el = h('div', 'screen pause hidden');
    this.el.innerHTML = `
      <div class="results-card">
        <h2>Pausa</h2>
        <div class="col">
          <button class="btn primary" data-a="resume">Continuar</button>
          <button class="btn" data-a="restart">Recomeçar</button>
          ${withControls ? '<button class="btn" data-a="controls">Controlos</button>' : ''}
          <button class="btn" data-a="quit">Sair para o menu</button>
        </div>
      </div>`;
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      audio.click();
      if (b.dataset.a === 'resume') this.onResume?.();
      if (b.dataset.a === 'restart') this.onRestart?.();
      if (b.dataset.a === 'quit') this.onQuit?.();
      if (b.dataset.a === 'controls') this.onControls?.();
    });
  }

  show(v: boolean) {
    this.el.classList.toggle('hidden', !v);
  }
}

// ---------------------------------------------------------------- controls (mobile)

export interface ControlSettings {
  controls: ControlMode;
  tiltSens: TiltSens;
  tiltCenter: number;
}

const WHEEL_SVG = `<svg viewBox="0 0 100 100" class="cp-wheel"><circle cx="50" cy="50" r="40"/><circle cx="50" cy="50" r="9"/><path d="M14 46 Q50 36 86 46 M50 59 V89 M41 52 L19 70 M59 52 L81 70"/><path class="cp-wheel-top" d="M44 11 h12"/></svg>`;

/**
 * Pick touch buttons or tilt steering. Tilt shows a live steering wheel that
 * follows the phone, a sensitivity picker and a one-tap calibration.
 */
export class ControlsPanel {
  readonly el: HTMLElement;
  private raf = 0;
  private last = 0;
  private wheel: HTMLElement;
  private bar: HTMLElement;
  private status: HTMLElement;
  onChange: ((s: ControlSettings) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    private input: Input,
    private settings: ControlSettings,
  ) {
    this.el = h('div', 'controls-panel hidden');
    this.el.innerHTML = `
      <div class="results-card cp-card">
        <h2>Controlos</h2>
        <div class="cp-modes">
          <button class="cp-mode" data-mode="buttons">
            <span class="cp-ico cp-ico-btn"><i></i><i></i></span>
            <b>Botões</b><small>Vira com ← → no ecrã</small>
          </button>
          <button class="cp-mode" data-mode="tilt">
            <span class="cp-ico cp-ico-tilt"><i></i></span>
            <b>Inclinação</b><small>Roda o telemóvel como um volante</small>
          </button>
        </div>
        <div class="cp-tilt">
          <div class="cp-live">
            ${WHEEL_SVG}
            <div class="cp-meter"><i></i><em></em></div>
          </div>
          <div class="cp-side">
            <span class="cp-label">Sensibilidade</span>
            <div class="cp-seg">${TILT_SENS_LABELS.map((l, i) => `<button data-sens="${i}">${l}</button>`).join('')}</div>
            <button class="btn small" data-a="calib">Calibrar centro</button>
            <p class="cp-status"></p>
          </div>
        </div>
        <button class="btn primary" data-a="close">Fechar</button>
      </div>`;
    root.appendChild(this.el);
    this.wheel = this.el.querySelector<HTMLElement>('.cp-wheel')!;
    this.bar = this.el.querySelector('.cp-meter i')!;
    this.status = this.el.querySelector('.cp-status')!;
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      audio.click();
      if (b.dataset.mode) void this.setMode(b.dataset.mode as ControlMode);
      if (b.dataset.sens) {
        this.settings.tiltSens = Number(b.dataset.sens) as TiltSens;
        this.input.tilt.sens = this.settings.tiltSens;
        this.emit();
      }
      if (b.dataset.a === 'calib') {
        this.input.tilt.calibrate();
        this.settings.tiltCenter = this.input.tilt.center;
        this.emit();
        this.wheel.classList.remove('pulse');
        void this.wheel.getBoundingClientRect();
        this.wheel.classList.add('pulse');
      }
      if (b.dataset.a === 'close') {
        this.show(false);
        this.onClose?.();
      }
    });
  }

  private async setMode(m: ControlMode) {
    if (m === 'tilt') {
      // iOS asks for permission here, inside the tap
      this.status.textContent = '';
      const ok = await this.input.tilt.request();
      if (!ok) {
        this.status.textContent = 'Sem acesso ao giroscópio. Autoriza "Movimento e orientação" nas definições do browser.';
        this.status.classList.add('bad');
        m = 'buttons';
      }
    }
    this.settings.controls = m;
    this.input.setMode(m);
    this.emit();
  }

  private emit() {
    this.render();
    this.onChange?.(this.settings);
  }

  private render() {
    const tilt = this.settings.controls === 'tilt';
    this.el.querySelectorAll<HTMLElement>('.cp-mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === this.settings.controls));
    this.el.querySelectorAll<HTMLElement>('[data-sens]').forEach((b) => b.classList.toggle('on', Number(b.dataset.sens) === this.settings.tiltSens));
    this.el.querySelector('.cp-tilt')!.classList.toggle('show', tilt);
  }

  show(v: boolean) {
    this.el.classList.toggle('hidden', !v);
    cancelAnimationFrame(this.raf);
    if (!v) return;
    this.status.textContent = '';
    this.status.classList.remove('bad');
    this.render();
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.settings.controls === 'tilt') {
        const t = this.input.tilt;
        const steer = t.read(dt);
        const lock = TILT_LOCK_DEG[t.sens];
        // the drawn wheel turns like a real one: a few times the phone's angle
        const ang = Math.max(-lock * 1.4, Math.min(lock * 1.4, t.angleDeg)) * 4;
        this.wheel.style.transform = `rotate(${ang}deg)`;
        this.bar.style.transform = `scaleX(${steer})`;
        this.wheel.classList.toggle('full', Math.abs(steer) > 0.98);
        if (!t.live && !this.status.classList.contains('bad')) this.status.textContent = 'À espera do sensor… segura o telemóvel na horizontal.';
        else if (t.live && !this.status.classList.contains('bad')) this.status.textContent = 'Segura na horizontal como um volante. Toca na barra durante a corrida para recentrar.';
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
}
