import { PATCH_NOTES } from '../patchNotes';
import {
  optionsFor,
  PAINTS,
  TECH_SLOTS,
  VISUAL_SLOTS,
  type CarBuild,
  type PartOption,
  type Slot,
} from '../car/parts';
import { computeStats, displayStats, type DisplayStats } from '../car/stats';
import { audio } from '../core/audio';
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

export class MenuScreen {
  readonly el: HTMLElement;
  onRace: (() => void) | null = null;
  onTimeTrial: (() => void) | null = null;
  onGarage: (() => void) | null = null;
  onToggleSound: (() => boolean) | null = null;

  constructor(root: HTMLElement, muted: boolean) {
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
        <button class="btn-icon" data-a="notes">PATCH NOTES</button>
        <span class="keys">Teclado: ↑ acelerar · ↓ travar/marcha-atrás · ← → virar · travar a curvar = drift · C câmara</span>
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
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      audio.click();
      const a = b.dataset.a;
      if (a === 'race') this.onRace?.();
      if (a === 'tt') this.onTimeTrial?.();
      if (a === 'garage') this.onGarage?.();
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
}

// ---------------------------------------------------------------- garage

const STAT_LABELS: [keyof DisplayStats, string][] = [
  ['speed', 'Velocidade'],
  ['accel', 'Aceleração'],
  ['grip', 'Aderência'],
  ['boost', 'Boost'],
];

export class GarageScreen {
  readonly el: HTMLElement;
  private tab: 'visual' | 'tech' = 'visual';
  private slot: Slot = 'body';
  private build!: CarBuild;
  private slotsEl: HTMLElement;
  private optsEl: HTMLElement;
  private statsEl: HTMLElement;
  onChange: ((b: CarBuild) => void) | null = null;
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
          <button data-tab="tech">Técnico</button>
        </div>
        <div class="slots"></div>
        <div class="options"></div>
        <div class="stats"></div>
      </aside>
      <div class="garage-hint">Arrasta para rodar o carro</div>`;
    root.appendChild(this.el);
    this.slotsEl = this.el.querySelector('.slots')!;
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
        this.tab = (b as HTMLElement).dataset.tab as 'visual' | 'tech';
        this.slot = this.tab === 'visual' ? VISUAL_SLOTS[0].slot : TECH_SLOTS[0].slot;
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
    const slots = this.tab === 'visual' ? VISUAL_SLOTS : TECH_SLOTS;
    this.slotsEl.innerHTML = '';
    for (const s of slots) {
      const b = h('button', s.slot === this.slot ? 'on' : '', esc(s.label));
      b.addEventListener('click', () => {
        audio.click();
        this.slot = s.slot;
        this.render();
      });
      this.slotsEl.appendChild(b);
    }
    this.optsEl.innerHTML = '';
    const opts: PartOption[] = optionsFor(this.slot);
    for (const o of opts) {
      const card = h('button', `opt${this.build[this.slot] === o.id ? ' on' : ''}`);
      const paint = this.slot === 'paint' ? PAINTS.find((p) => p.id === o.id) : null;
      card.innerHTML = `${paint ? `<i class="swatch" style="background:#${paint.color.toString(16).padStart(6, '0')}"></i>` : ''}<b>${esc(o.name)}</b><small>${esc(o.desc)}</small>`;
      card.addEventListener('click', () => {
        audio.click();
        this.build = { ...this.build, [this.slot]: o.id };
        this.onChange?.(this.build);
        this.render();
      });
      card.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.renderStats({ ...this.build, [this.slot]: o.id });
      });
      card.addEventListener('pointerleave', () => this.renderStats());
      this.optsEl.appendChild(card);
    }
    this.renderStats();
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

  constructor(root: HTMLElement) {
    this.el = h('div', 'screen pause hidden');
    this.el.innerHTML = `
      <div class="results-card">
        <h2>Pausa</h2>
        <div class="col">
          <button class="btn primary" data-a="resume">Continuar</button>
          <button class="btn" data-a="restart">Recomeçar</button>
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
    });
  }

  show(v: boolean) {
    this.el.classList.toggle('hidden', !v);
  }
}
