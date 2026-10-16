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
import { LAPS, type RaceResult } from '../game/race';
import { MAX_PLAYERS } from '../net/protocol';
import { formatScore, formatTime } from './hud';
import { hint, nav } from './nav';

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
  idle: 'Procurar',
  checking: 'A procurar…',
  installing: 'A instalar…',
  reloading: 'A recarregar…',
};

type MenuMode = 'race' | 'online' | 'tt' | 'zone' | 'garage';

interface ModeInfo {
  id: MenuMode;
  name: string;
  kicker: string;
  desc: string;
  cta: string;
  c1: string;
  c2: string;
  art: string;
}

const ART = {
  race: `<svg viewBox="0 0 64 64"><path class="pole" d="M14 58V7"/><path class="flag" d="M16 9c8-4 14 4 22 0s10-3 14-1v24c-4-2-6-3-14 1s-14-4-22 0z"/><path class="chk" d="M16 9v8c4-2 7-1 10 0V9c-3-1-6-2-10 0zM26 17v8c4 1 8 1 12 0v-8c-4 1-8 1-12 0zM38 9v8c5-2 9-3 14-1V8c-5-2-9-1-14 1zM16 25v7c4-2 7-1 10 0v-7c-3-1-6-2-10 0zM38 25v7c5-2 9-3 14-1v-7c-5-2-9-1-14 1z"/></svg>`,
  online: `<svg viewBox="0 0 64 64"><circle class="ring" cx="32" cy="32" r="24"/><path class="ring" d="M8 32h48M32 8c-8 8-10 16-10 24s2 16 10 24M32 8c8 8 10 16 10 24s-2 16-10 24"/><circle class="dot" cx="14" cy="20" r="5"/><circle class="dot" cx="50" cy="20" r="5"/><circle class="dot" cx="32" cy="54" r="5"/></svg>`,
  tt: `<svg viewBox="0 0 64 64"><circle class="ring" cx="32" cy="36" r="21"/><path class="ring" d="M26 6h12M32 6v9M49 17l4-4"/><path class="hand" d="M32 36 43 25"/><path class="ghost" d="M10 36a22 22 0 0 1 3-11" /><circle class="dot" cx="32" cy="36" r="3.5"/></svg>`,
  zone: `<svg viewBox="0 0 64 64"><path class="ring" d="M7 29c0-5 11-9 25-9s25 4 25 9-11 9-25 9S7 34 7 29z"/><path class="ring" d="M9 32l11 13 8 3 4 9 5-8 9-4 10-13"/><path class="ghost" d="M16 29c7 4 19 4 23-1s-3-8-9-6"/><path class="hand" d="M47 25V14"/><circle class="dot" cx="47" cy="11" r="5.5"/><circle class="dot" cx="41" cy="15" r="3.5"/></svg>`,
  garage: `<svg viewBox="0 0 64 64"><path class="ring" d="M6 40c0-5 3-8 8-9l8-9c2-2 4-3 7-3h10c3 0 5 1 7 3l6 8c6 1 9 4 9 10v4H6z"/><path class="ring" d="M22 31h28M33 22v9"/><circle class="dot" cx="18" cy="44" r="6"/><circle class="dot" cx="46" cy="44" r="6"/><path class="hand" d="M40 58l9-9m-2-2 6 6"/></svg>`,
};

const MODES: ModeInfo[] = [
  { id: 'race', name: 'Corrida', kicker: `Grande Prémio · ${LAPS} voltas`, desc: 'Enfrenta 3 rivais montados peça a peça numa pista suspensa no céu. Drifta, voa e queima nitro até à meta.', cta: 'Correr', c1: '#29e0ff', c2: '#6a5bff', art: ART.race },
  { id: 'online', name: 'Multijogador', kicker: `Online · até ${MAX_PLAYERS} pilotos`, desc: 'Cria uma sala, partilha o código de 4 números e corre contra os teus amigos. Os lugares vazios enchem-se de IA.', cta: 'Entrar', c1: '#ff3fb4', c2: '#ff8a3d', art: ART.online },
  { id: 'tt', name: 'Contrarrelógio', kicker: 'Sozinho · contra o fantasma', desc: 'Só tu, a pista e o fantasma da tua melhor volta. Cada décima conta.', cta: 'Começar', c1: '#7dff9e', c2: '#18b6a4', art: ART.tt },
  { id: 'zone', name: 'Zona livre', kicker: 'Drift livre · Jardim Celeste', desc: 'Uma ilha-jardim a flutuar nas nuvens, sem voltas nem relógio. Encadeia drifts, salta as rampas e persegue o teu melhor combo. Online, abre a zona para a tua sala.', cta: 'Explorar', c1: '#ff8ee0', c2: '#3fd6a0', art: ART.zone },
  { id: 'garage', name: 'Garagem', kicker: 'Personalização', desc: 'Carroçaria, jantes, pintura, interior, motor, turbo e pneus. Cada peça muda o visual e a condução.', cta: 'Abrir garagem', c1: '#ffcf3f', c2: '#ff5a3d', art: ART.garage },
];

const ICON_GEAR = `<svg viewBox="0 0 24 24"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.4 7.4 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 2.6-1.5l2.4 1 2-3.4z"/></svg>`;
const ICON_NOTES = `<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/></svg>`;
const ICON_SOUND = `<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="wave" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`;
const ICON_PAD = `<svg viewBox="0 0 24 24"><rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7 10.5v4M5 12.5h4"/><circle cx="16" cy="11.5" r=".9"/><circle cx="18" cy="13.5" r=".9"/></svg>`;
const ICON_RES = `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 9h3M7 9v3M17 13h-3M17 13v-3"/></svg>`;
const ICON_UPDATE = `<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const ICON_RESTART = `<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/></svg>`;
const ICON_EXIT = `<svg viewBox="0 0 24 24"><path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/></svg>`;
const ICON_GARAGE = `<svg viewBox="0 0 24 24"><path d="M3 20V9l9-5 9 5v11"/><path d="M7 20v-7h10v7M7 16h10"/></svg>`;

const KEYMAP: [string, string][] = [
  ['↑ W', 'Acelerar'],
  ['↓ S', 'Travar · marcha-atrás'],
  ['← → A D', 'Virar'],
  ['Espaço', 'Nitro'],
  ['C', 'Câmara'],
  ['Esc P', 'Pausa'],
];

const NOTES_SEEN = 'hd-notes-seen';
const LAST_MODE = 'hd-menu-mode';

function store(k: string, v?: string): string | null {
  try {
    if (v !== undefined) localStorage.setItem(k, v);
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/** "2026-10-16 19:00 UTC" → "16 out · 20:00" in the player's own clock */
function noteWhen(hour: string) {
  const d = new Date(hour.replace(' UTC', ':00Z').replace(' ', 'T'));
  if (isNaN(+d)) return hour;
  const day = d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short' }).replace('.', '');
  return `${day} · ${d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`;
}

/** labels come in as "RESOLUÇÃO: AUTO"; the settings rows show only the value */
function valueOf(label: string) {
  const v = label.includes(':') ? label.slice(label.indexOf(':') + 1).trim() : label;
  return v.charAt(0) + v.slice(1).toLowerCase();
}

/**
 * Console-style home: a title screen on boot, then a row of mode tiles over
 * the live race. The focused tile fills the hero with its art, blurb and a
 * big call to action; settings and patch notes slide in as sheets.
 */
export class MenuScreen {
  readonly el: HTMLElement;
  onRace: (() => void) | null = null;
  onTimeTrial: (() => void) | null = null;
  onGarage: (() => void) | null = null;
  onZone: (() => void) | null = null;
  onOnline: (() => void) | null = null;
  onToggleSound: (() => boolean) | null = null;
  onControls: (() => void) | null = null;
  /** Cycles the render resolution and returns the new button label. */
  onResolution: (() => string) | null = null;

  private sel: MenuMode = 'race';
  private titled = false;
  private clockTimer = 0;
  private hero: HTMLElement;
  private record: number | null = null;
  private stats: DisplayStats | null = null;
  private bestDrift = 0;

  constructor(root: HTMLElement, muted: boolean, controlsLabel: string | null, resolutionLabel: string) {
    this.el = h('div', 'screen menu hidden');
    const last = store(LAST_MODE) as MenuMode | null;
    if (last && MODES.some((m) => m.id === last)) this.sel = last;
    const touch = isTouch();
    this.el.innerHTML = `
      <div class="menu-shade"></div>
      <button class="menu-title" data-anykey data-nav-skip aria-label="Começar">
        <span class="mt-glow"></span>
        <span class="mt-lines">${'<i></i>'.repeat(9)}</span>
        <span class="mt-logo"><span class="logo">HYPER<span>DRIFT</span></span>
        <span class="mt-tag">Pistas suspensas no céu · Carros feitos peça a peça</span></span>
        <span class="mt-press">${touch ? 'Toca para começar' : '<span class="kbd-only">Prime qualquer tecla</span><span class="pad-only">Prime <i class="glyph g-ok"></i></span><span class="ptr-only">Clica ou prime qualquer tecla</span>'}</span>
      </button>
      <div class="menu-home">
        <header class="topbar">
          <div class="tb-brand">HYPER<span>DRIFT</span></div>
          <div class="tb-right">
            <button class="tb-btn" data-a="notes" aria-label="Patch notes">${ICON_NOTES}<i class="tb-badge"></i></button>
            <button class="tb-btn" data-a="settings" aria-label="Definições">${ICON_GEAR}</button>
            <span class="tb-clock"></span>
          </div>
        </header>
        <nav class="tiles">${MODES.map(
          (m, i) =>
            `<button class="tile" data-mode="${m.id}" style="--c1:${m.c1};--c2:${m.c2};--i:${i}"><span class="tile-art">${m.art}</span><span class="tile-name">${m.name}</span>${m.id === 'zone' ? '<em class="tile-new">Novo</em>' : ''}</button>`,
        ).join('')}</nav>
        <section class="hero" aria-live="polite"></section>
        <footer class="menu-hints">${hint('move', 'Navegar')}${hint('ok', 'Selecionar')}</footer>
      </div>
      <div class="sheet settings hidden" data-modal>
        <div class="sheet-card">
          <header class="sheet-head"><h2>Definições</h2><button class="sheet-x" data-a="settings-close" data-back aria-label="Fechar">✕</button></header>
          <div class="set-list">
            <button class="set-row" data-a="sound" data-autofocus>
              <span class="set-ico">${ICON_SOUND}</span><span class="set-txt"><b>Som</b><small>Motor, música e efeitos</small></span>
              <span class="switch${muted ? '' : ' on'}"><i></i></span>
            </button>
            ${
              controlsLabel
                ? `<button class="set-row" data-a="controls">
              <span class="set-ico">${ICON_PAD}</span><span class="set-txt"><b>Controlos</b><small>Botões no ecrã ou inclinação</small></span>
              <span class="set-val" data-v="controls">${valueOf(controlsLabel)}</span><span class="chev">›</span>
            </button>`
                : ''
            }
            <button class="set-row" data-a="res">
              <span class="set-ico">${ICON_RES}</span><span class="set-txt"><b>Resolução</b><small>Auto ajusta para manter a fluidez</small></span>
              <span class="set-cycle"><i>‹</i><span class="set-val" data-v="res">${valueOf(resolutionLabel)}</span><i>›</i></span>
            </button>
            <button class="set-row btn-update" data-a="update">
              <span class="set-ico upd-ico">${ICON_UPDATE}</span><span class="set-txt"><b>Atualizar o jogo</b><small>Instala a versão mais recente</small></span>
              <span class="set-val upd-label">${UPDATE_LABELS.idle}</span>
            </button>
          </div>
          ${
            touch
              ? ''
              : `<div class="set-keys"><h3>Teclado</h3><div class="keys-grid">${KEYMAP.map(
                  ([k, l]) => `<span class="keycaps">${k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('')}</span><span>${l}</span>`,
                ).join('')}</div><p>Comando ligado? Também funciona, nos menus e em pista.</p></div>`
          }
          <footer class="sheet-hints">${hint('ok', 'Escolher')}${hint('back', 'Fechar')}</footer>
        </div>
      </div>
      <div class="sheet notes hidden" data-modal>
        <div class="sheet-card notes-card">
          <header class="sheet-head"><h2>Patch notes</h2><button class="sheet-x" data-a="notes-close" data-back aria-label="Fechar">✕</button></header>
          <div class="notes-list">${PATCH_NOTES.map(
            (g, i) =>
              `<section${i === 0 ? ' class="latest"' : ''}><h3><span>${esc(noteWhen(g.hour))}</span>${i === 0 ? '<em>Novo</em>' : ''}</h3><ul>${g.entries
                .map((e) => `<li>${e}</li>`)
                .join('')}</ul></section>`,
          ).join('')}</div>
          <footer class="sheet-hints">${hint('back', 'Fechar')}</footer>
        </div>
      </div>`;
    root.appendChild(this.el);
    this.hero = this.el.querySelector('.hero')!;
    if (store(NOTES_SEEN) !== this.notesKey()) this.el.classList.add('notes-new');

    const upd = this.el.querySelector<HTMLButtonElement>('[data-a="update"]')!;
    onUpdatePhase((p) => {
      upd.dataset.phase = p;
      upd.disabled = p !== 'idle';
      upd.querySelector('.upd-label')!.textContent = UPDATE_LABELS[p];
    });

    const tiles = this.el.querySelector('.tiles')!;
    tiles.addEventListener('focusin', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('.tile');
      if (t) this.select(t.dataset.mode as MenuMode);
    });
    tiles.addEventListener('pointerover', (e) => {
      if ((e as PointerEvent).pointerType !== 'mouse') return;
      const t = (e.target as HTMLElement).closest<HTMLElement>('.tile');
      if (t) this.select(t.dataset.mode as MenuMode);
    });

    this.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.menu-title')) return this.enterHome();
      // tapping the dimmed backdrop around a sheet closes it
      if (target.classList.contains('sheet')) return this.sheet(null);
      const tile = target.closest<HTMLElement>('.tile');
      if (tile) {
        const m = tile.dataset.mode as MenuMode;
        if (m === this.sel) {
          audio.click();
          this.launch(m);
        } else this.select(m);
        return;
      }
      const b = target.closest('button');
      if (!b) return;
      audio.click();
      const a = b.dataset.a;
      if (a === 'go') this.launch(this.sel);
      if (a === 'controls') this.onControls?.();
      if (a === 'res' && this.onResolution) this.setResolutionLabel(this.onResolution());
      if (a === 'update') void checkAndReload();
      if (a === 'settings') this.sheet('settings');
      if (a === 'notes') {
        this.sheet('notes');
        store(NOTES_SEEN, this.notesKey());
        this.el.classList.remove('notes-new');
      }
      if (a === 'settings-close' || a === 'notes-close') this.sheet(null);
      if (a === 'sound' && this.onToggleSound) {
        const m = this.onToggleSound();
        b.querySelector('.switch')!.classList.toggle('on', !m);
      }
    });
    this.renderHero(false);
    this.el.querySelector(`.tile[data-mode="${this.sel}"]`)!.classList.add('on');
  }

  private notesKey() {
    const g = PATCH_NOTES[0];
    return g ? `${g.hour}#${g.entries.length}` : '';
  }

  private enterHome() {
    if (this.titled) return;
    this.titled = true;
    audio.start();
    this.el.dataset.phase = 'home';
    this.el.querySelector<HTMLElement>(`.tile[data-mode="${this.sel}"]`)?.setAttribute('data-autofocus', '');
    requestAnimationFrame(() => nav.refocus());
  }

  private sheet(which: 'settings' | 'notes' | null) {
    for (const k of ['settings', 'notes'] as const) this.el.querySelector(`.sheet.${k}`)!.classList.toggle('hidden', k !== which);
    if (!which) {
      // focus goes back to where it was before the sheet opened
      const btn = this.el.querySelector<HTMLElement>('[data-a="settings"]');
      if (!nav.usingPointer) btn?.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => nav.refocus());
  }

  private select(m: MenuMode) {
    if (m === this.sel) return;
    this.sel = m;
    store(LAST_MODE, m);
    this.el.querySelectorAll<HTMLElement>('.tile').forEach((t) => {
      const on = t.dataset.mode === m;
      t.classList.toggle('on', on);
      t.toggleAttribute('data-autofocus', on);
    });
    if (nav.usingPointer) audio.nav();
    this.renderHero(true);
  }

  private launch(m: MenuMode) {
    if (m === 'race') this.onRace?.();
    if (m === 'tt') this.onTimeTrial?.();
    if (m === 'garage') this.onGarage?.();
    if (m === 'online') this.onOnline?.();
    if (m === 'zone') this.onZone?.();
  }

  private renderHero(anim: boolean) {
    const m = MODES.find((x) => x.id === this.sel)!;
    this.el.style.setProperty('--c1', m.c1);
    this.el.style.setProperty('--c2', m.c2);
    let extra = '';
    if (m.id === 'tt' || m.id === 'race') {
      extra = `<div class="hero-meta"><span class="chip"><b>${LAPS}</b> voltas</span>${
        m.id === 'race' ? '<span class="chip"><b>3</b> rivais IA</span>' : '<span class="chip">Fantasma</span>'
      }${this.record !== null ? `<span class="chip rec">Recorde <b>${formatTime(this.record)}</b></span>` : ''}</div>`;
    } else if (m.id === 'zone') {
      extra = `<div class="hero-meta"><span class="chip">Sem voltas</span><span class="chip">Combos até <b>×5</b></span>${
        this.bestDrift > 0 ? `<span class="chip rec">Recorde <b>${formatScore(this.bestDrift)}</b></span>` : ''
      }</div>`;
    } else if (m.id === 'online') {
      extra = `<div class="hero-meta"><span class="chip"><b>${MAX_PLAYERS}</b> pilotos</span><span class="chip">Código de 4 números</span><span class="chip">Convite por link</span></div>`;
    } else if (this.stats) {
      extra = `<div class="hero-stats">${STAT_LABELS.map(
        ([k, label]) => `<div class="hs"><span>${label}</span><div class="sbar"><i style="width:${this.stats![k] * 10}%"></i></div><b>${this.stats![k].toFixed(1)}</b></div>`,
      ).join('')}</div>`;
    }
    this.hero.innerHTML = `
      <div class="hero-kicker">${esc(m.kicker)}</div>
      <h2 class="hero-title" style="--len:${m.name.length}">${esc(m.name)}</h2>
      <p class="hero-desc">${esc(m.desc)}</p>
      ${extra}
      <div class="hero-actions"><button class="cta" data-a="go">${ICON_PLAY}<span>${esc(m.cta)}</span></button></div>`;
    if (anim) {
      this.hero.classList.remove('swap');
      void this.hero.offsetWidth;
      this.hero.classList.add('swap');
    }
  }

  /** best lap for the hero chip and the current car's numbers for the garage tile (and the best drift for the zone's) */
  setInfo(record: number | null, stats: DisplayStats, bestDrift = 0) {
    this.record = record;
    this.stats = stats;
    this.bestDrift = bestDrift;
    this.renderHero(false);
  }

  show(v: boolean) {
    this.el.classList.toggle('hidden', !v);
    clearInterval(this.clockTimer);
    if (!v) {
      this.sheet(null);
      return;
    }
    // the title card shows once per visit; after that the menu opens straight onto the tiles
    this.el.dataset.phase = this.titled ? 'home' : 'title';
    const clock = this.el.querySelector('.tb-clock')!;
    const tick = () => (clock.textContent = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }));
    tick();
    this.clockTimer = window.setInterval(tick, 10000);
    requestAnimationFrame(() => nav.refocus());
  }

  /** skip the title card (invite links land straight in a room) */
  skipTitle() {
    this.titled = true;
  }

  setResolutionLabel(label: string) {
    this.el.querySelector('[data-v="res"]')!.textContent = valueOf(label);
  }

  setControlsLabel(label: string) {
    const v = this.el.querySelector('[data-v="controls"]');
    if (v) v.textContent = valueOf(label);
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

const TABS: { id: GarageTab; label: string; intro: string }[] = [
  { id: 'visual', label: 'Exterior', intro: 'O aspeto do carro. Todas as peças encaixam umas nas outras.' },
  { id: 'interior', label: 'Interior', intro: 'O que vês ao volante, na vista de cockpit.' },
  { id: 'tech', label: 'Desempenho', intro: 'Como o carro anda. Cada peça muda as barras em baixo.' },
];

/** a one-liner under each category, so it's clear what it changes */
const SLOT_HINTS: Partial<Record<Slot, string>> = {
  body: 'Silhueta e cabine',
  front: 'Nariz e para-choques',
  rear: 'Traseira e luzes',
  hood: 'Capô',
  skirts: 'Embaladeiras',
  spoiler: 'Asa traseira',
  rims: 'Modelo e cor',
  headlights: 'Faróis da frente',
  exhaust: 'Saídas de escape',
  paint: 'Cor por zona do carro',
  vinyl: 'Padrão e cor',
  engine: 'Velocidade e aceleração',
  turbo: 'Força em baixa ou alta',
  nitro: 'Força e duração do boost',
  tires: 'Aderência e drift',
  suspension: 'Curvas, saltos e aterragens',
  weight: 'Agilidade e estabilidade',
  cockpit: 'Estilo e cor do habitáculo',
  dash: 'Mostradores',
  wheel: 'Volante',
  mirror: 'Retrovisor',
  shifter: 'Alavanca das mudanças',
  handbrake: 'Travão de mão',
};

const g = (d: string) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const SLOT_ICONS: Partial<Record<Slot, string>> = {
  body: g('<path d="M2 15v-2.5l3-1 3.5-4h7l3.5 4 3 1V15z"/><circle cx="7" cy="16" r="2"/><circle cx="17" cy="16" r="2"/>'),
  front: g('<path d="M3 16v-4l3-3h12l3 3v4z"/><path d="M6 13h3M15 13h3M9 16h6"/>'),
  rear: g('<path d="M3 16V9h18v7z"/><path d="M5 12h4M15 12h4M10 16v2M14 16v2"/>'),
  hood: g('<path d="M4 18 7 6h10l3 12z"/><path d="M12 6v12M9 12h6"/>'),
  skirts: g('<path d="M2 14h20M4 17h16"/><circle cx="6" cy="11" r="2"/><circle cx="18" cy="11" r="2"/>'),
  spoiler: g('<path d="M3 8h18M6 8v5M18 8v5M4 16h16"/>'),
  rims: g('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v6.5M12 14.5V21M3.5 9.5l6 1.8M14.5 12.7l6 1.8M3.5 14.5l6-1.8M14.5 11.3l6-1.8"/>'),
  headlights: g('<path d="M9 7a5 5 0 0 0 0 10z"/><path d="M13 8h8M13 12h8M13 16h8"/>'),
  exhaust: g('<circle cx="8" cy="14" r="4"/><circle cx="8" cy="14" r="1.5"/><path d="M14 11c2-2 4 0 6-2M14 15c2-1 4 1 6 0"/>'),
  paint: g('<path d="M4 20c4 0 4-3 4-5l9-9a2 2 0 0 1 3 3l-9 9c-2 0-5 0-5 4z"/>'),
  vinyl: g('<path d="M3 17 9 7h4l-6 10zM11 17l6-10h4l-6 10z"/>'),
  vinylColor: g('<circle cx="12" cy="12" r="8"/>'),
  engine: g('<path d="M4 9h3l1-2h6l1 2h3l2 3v4l-2 2H7l-3-3z"/><path d="M10 11v4M13 11v4"/>'),
  turbo: g('<circle cx="12" cy="12" r="8"/><path d="M12 4c-2 4 0 8 0 8s4-2 8 0M12 20c2-4 0-8 0-8s-4 2-8 0"/>'),
  nitro: g('<path d="M9 3h6M10 3v3h4V3M8 8h8v12H8z"/><path d="M13 10l-3 4h3l-2 4"/>'),
  tires: g('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/>'),
  suspension: g('<path d="M12 2v3M12 19v3M8 5h8M8 19h8M9 7l6 2-6 2 6 2-6 2 6 2"/>'),
  weight: g('<path d="M7 9h10l3 11H4z"/><circle cx="12" cy="6" r="2.5"/>'),
  cockpit: g('<path d="M6 20v-6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v6M8 11V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6"/>'),
  dash: g('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/><circle cx="12" cy="16" r="1.5"/>'),
  wheel: g('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M3.5 10.5Q12 8 20.5 10.5M12 14.5V21"/>'),
  mirror: g('<rect x="3" y="7" width="18" height="8" rx="3"/><path d="M12 7V4"/>'),
  shifter: g('<circle cx="12" cy="5" r="2.5"/><path d="M12 7.5V17M8 21h8l-1-4H9z"/>'),
  handbrake: g('<path d="M5 19 17 7"/><rect x="14" y="3.5" width="7" height="5" rx="2.5" transform="rotate(45 17.5 6)"/><path d="M3 21h6"/>'),
};

/** One number to sum the car up, with a class letter, like a racing game's PI. */
function rating(s: DisplayStats) {
  const v = (s.speed * 1.2 + s.accel + s.grip + s.boost * 0.8) / 4;
  const pi = Math.round(100 + v * 80);
  const cls = pi >= 640 ? 'S' : pi >= 580 ? 'A' : pi >= 520 ? 'B' : pi >= 460 ? 'C' : 'D';
  return { pi, cls };
}

/**
 * Console-style garage: pick a section (Exterior / Interior / Desempenho), then
 * a category from a list that shows what's fitted, then a part. Each part
 * card says what it does, and performance parts show their stat changes up
 * front. The 3D camera follows whatever category is highlighted.
 */
export class GarageScreen {
  readonly el: HTMLElement;
  private tab: GarageTab = 'visual';
  private slot: Slot = 'body';
  /** the chosen sub-entry when the slot has a row of them (paint zones, vinyl/rim colour) */
  private sub: Slot = 'body';
  private view: 'cats' | 'opts' = 'cats';
  private build!: CarBuild;
  private panel: HTMLElement;
  private catsEl: HTMLElement;
  private subEl: HTMLElement;
  private optsEl: HTMLElement;
  private statsEl: HTMLElement;
  private menuBtn: HTMLElement;
  private backBtn: HTMLElement;
  onChange: ((b: CarBuild, slot: Slot) => void) | null = null;
  /** the camera follows what's being edited: the interior tab sits you in the driver's seat */
  onView: ((interior: boolean, slot: Slot) => void) | null = null;
  onBack: (() => void) | null = null;
  onRace: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = h('div', 'screen garage hidden');
    this.el.innerHTML = `
      <header class="garage-top">
        <button class="pill" data-a="back" data-back><i class="glyph g-back"></i><span class="pill-arrow">‹</span>Menu</button>
        <h2><small>Hyperdrift</small>Garagem</h2>
        <button class="pill primary" data-a="race">Correr<span class="pill-arrow">›</span></button>
      </header>
      <aside class="garage-panel" data-view="cats">
        <div class="tabs">
          <i class="glyph g-l1" aria-hidden="true"></i>
          ${TABS.map((t) => `<button data-tab="${t.id}"${t.id === 'visual' ? ' class="on"' : ''}>${t.label}</button>`).join('')}
          <i class="glyph g-r1" aria-hidden="true"></i>
        </div>
        <div class="gp-body">
          <div class="gp-cats">
            <p class="gp-intro"></p>
            <div class="cat-list"></div>
          </div>
          <div class="gp-opts">
            <button class="opts-back" data-a="cats"><span class="ob-arrow">‹</span><span class="ob-ico"></span><span class="ob-txt"><b></b><small></small></span></button>
            <div class="slots subslots"></div>
            <div class="options"></div>
          </div>
        </div>
        <div class="gp-stats"></div>
        <footer class="gp-hints"></footer>
      </aside>
      <div class="garage-hint"><span class="orbit-ico" aria-hidden="true"></span>${
        isTouch() ? 'Arrasta para orbitar · Pinça para zoom · Toque duplo repõe' : 'Arrasta para orbitar · Roda para zoom · Duplo clique repõe'
      }</div>`;
    root.appendChild(this.el);
    this.panel = this.el.querySelector('.garage-panel')!;
    this.catsEl = this.el.querySelector('.cat-list')!;
    this.subEl = this.el.querySelector('.subslots')!;
    this.optsEl = this.el.querySelector('.options')!;
    this.statsEl = this.el.querySelector('.gp-stats')!;
    this.menuBtn = this.el.querySelector('[data-a="back"]')!;
    this.backBtn = this.el.querySelector('.opts-back')!;
    this.menuBtn.addEventListener('click', () => {
      audio.click();
      this.onBack?.();
    });
    this.el.querySelector('[data-a="race"]')!.addEventListener('click', () => {
      audio.click();
      this.onRace?.();
    });
    this.backBtn.addEventListener('click', () => {
      audio.click();
      this.setView('cats');
    });
    this.el.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        audio.click();
        this.setTab(b.dataset.tab as GarageTab);
      }),
    );
    // L1 / R1 (or Q / E) flip through the sections
    this.el.addEventListener('nav-tab', (e) => {
      const i = TABS.findIndex((t) => t.id === this.tab);
      audio.nav();
      this.setTab(TABS[(i + (e as CustomEvent<number>).detail + TABS.length) % TABS.length].id);
      nav.refocus();
    });
    // the camera swings to whichever category is highlighted
    const peek = (e: Event) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.cat');
      if (row && this.view === 'cats') this.onView?.(this.tab === 'interior', row.dataset.slot as Slot);
    };
    this.catsEl.addEventListener('focusin', peek);
    this.catsEl.addEventListener('pointerover', (e) => (e as PointerEvent).pointerType === 'mouse' && peek(e));
    // pad and keyboard users preview a part's stats just by landing on it
    this.optsEl.addEventListener('focusin', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.opt');
      if (card?.dataset.id && !nav.usingPointer) this.renderStats({ ...this.build, [this.sub]: card.dataset.id });
    });
    this.optsEl.addEventListener('focusout', () => this.renderStats());
  }

  show(v: boolean, build?: CarBuild) {
    if (build) this.build = { ...build };
    this.el.classList.toggle('hidden', !v);
    if (v) {
      this.setView('cats', false);
      requestAnimationFrame(() => nav.refocus());
    }
  }

  private slots(): { slot: Slot; label: string }[] {
    return this.tab === 'visual' ? VISUAL_SLOTS : this.tab === 'interior' ? INTERIOR_SLOTS : TECH_SLOTS;
  }

  private setTab(tab: GarageTab) {
    this.tab = tab;
    this.slot = this.slots()[0].slot;
    this.sub = this.slot;
    this.el.querySelectorAll<HTMLElement>('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    this.setView('cats');
  }

  private setView(v: 'cats' | 'opts', anim = true) {
    this.view = v;
    this.panel.dataset.view = v;
    // Esc / ◯ steps back out of a category before leaving the garage
    this.menuBtn.toggleAttribute('data-back', v === 'cats');
    this.backBtn.toggleAttribute('data-back', v === 'opts');
    const body = this.el.querySelector<HTMLElement>('.gp-body')!;
    if (anim) {
      body.classList.remove('slide-in', 'slide-out');
      void body.offsetWidth;
      body.classList.add(v === 'opts' ? 'slide-in' : 'slide-out');
    }
    this.el.querySelector<HTMLElement>('.gp-hints')!.innerHTML =
      v === 'cats' ? `${hint('ok', 'Abrir')}${hint('tabs', 'Secção')}${hint('back', 'Menu')}` : `${hint('ok', 'Equipar')}${hint('back', 'Voltar')}`;
    this.render();
    requestAnimationFrame(() => nav.refocus());
  }

  private render() {
    if (this.view === 'cats') this.renderCats();
    else this.renderOpts();
    this.renderStats();
  }

  /** what's fitted in a slot, as text plus an optional colour dot */
  private fitted(slot: Slot) {
    const subs = SUB_SLOTS[slot as keyof typeof SUB_SLOTS] ?? INTERIOR_SUB_SLOTS[slot as keyof typeof INTERIOR_SUB_SLOTS];
    const main = optionsFor(slot).find((o) => o.id === this.build[slot]);
    const dots = (subs ?? [{ slot }]).map((s) => this.swatchOf(s.slot, this.build[s.slot])).filter((x): x is string => !!x);
    const uniq = [...new Set(dots)].slice(0, 4);
    return { name: main?.name ?? '', dots: uniq };
  }

  private renderCats() {
    const t = TABS.find((x) => x.id === this.tab)!;
    this.el.querySelector('.gp-intro')!.textContent = t.intro;
    const had = (document.activeElement as HTMLElement | null)?.dataset?.slot;
    this.catsEl.innerHTML = '';
    this.slots().forEach((s, i) => {
      const f = this.fitted(s.slot);
      const b = h(
        'button',
        'cat',
        `<span class="cat-ico">${SLOT_ICONS[s.slot] ?? ''}</span><span class="cat-txt"><b>${esc(s.label)}</b><small>${esc(SLOT_HINTS[s.slot] ?? '')}</small></span><span class="cat-val">${f.dots
          .map((c) => `<i class="dot" style="background:${c}"></i>`)
          .join('')}<em>${esc(f.name)}</em></span><span class="chev">›</span>`,
      );
      b.dataset.slot = s.slot;
      b.style.setProperty('--i', String(i));
      if (s.slot === this.slot) b.dataset.autofocus = '';
      b.addEventListener('click', () => {
        audio.click();
        this.slot = s.slot;
        this.sub = s.slot;
        this.setView('opts');
      });
      this.catsEl.appendChild(b);
    });
    if (had) this.catsEl.querySelector<HTMLElement>(`[data-slot="${had}"]`)?.focus({ preventScroll: true });
    this.onView?.(this.tab === 'interior', this.slot);
  }

  private renderOpts() {
    const label = this.slots().find((s) => s.slot === this.slot)?.label ?? '';
    this.backBtn.querySelector('.ob-ico')!.innerHTML = SLOT_ICONS[this.slot] ?? '';
    this.backBtn.querySelector('b')!.textContent = label;
    this.backBtn.querySelector('small')!.textContent = SLOT_HINTS[this.slot] ?? '';

    // re-rendering replaces the buttons: remember which one had the focus
    const had = document.activeElement as HTMLElement | null;
    const keep = had && this.el.contains(had) ? (had.dataset.id ? `.opt[data-id="${had.dataset.id}"]` : had.closest('.subslots') ? '.subslots .on' : null) : null;

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
        this.renderOpts();
      });
      this.subEl.appendChild(b);
    }
    const slot = this.sub;
    this.onView?.(this.tab === 'interior', slot);
    this.optsEl.innerHTML = '';
    const opts: PartOption[] = optionsFor(slot);
    const colours = opts.every((o) => !!this.swatchOf(slot, o.id));
    this.optsEl.classList.toggle('colours', colours);
    const tech = this.tab === 'tech';
    const cur = displayStats(computeStats(this.build));
    for (const o of opts) {
      const on = this.build[slot] === o.id;
      const card = h('button', `opt${on ? ' on' : ''}`);
      card.dataset.id = o.id;
      if (on) card.dataset.autofocus = '';
      const sw = this.swatchOf(slot, o.id);
      let deltas = '';
      if (tech && !on) {
        const nx = displayStats(computeStats({ ...this.build, [slot]: o.id }));
        deltas = STAT_LABELS.map(([k, l]) => {
          const d = nx[k] - cur[k];
          return Math.abs(d) < 0.05 ? '' : `<span class="dl ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${l} ${d > 0 ? '+' : ''}${d.toFixed(1)}</span>`;
        }).join('');
        deltas = deltas ? `<span class="deltas">${deltas}</span>` : '<span class="deltas"><span class="dl">Sem efeito nas barras</span></span>';
      }
      card.innerHTML = `${sw ? `<i class="swatch" style="background:${sw}"></i>` : ''}<span class="opt-txt"><b>${esc(o.name)}</b><small>${esc(o.desc)}</small>${deltas}</span>${
        on ? '<em class="opt-on">Equipado</em>' : ''
      }`;
      card.addEventListener('click', () => {
        audio.click();
        this.build = { ...this.build, [slot]: o.id };
        this.onChange?.(this.build, slot);
        this.renderOpts();
        this.renderStats();
      });
      card.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.renderStats({ ...this.build, [slot]: o.id });
      });
      card.addEventListener('pointerleave', () => this.renderStats());
      this.optsEl.appendChild(card);
    }
    if (keep) this.el.querySelector<HTMLElement>(keep)?.focus({ preventScroll: true });
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
    const r = rating(pre);
    const r0 = rating(cur);
    const dpi = r.pi - r0.pi;
    this.statsEl.innerHTML = `<div class="pi pi-${r.cls}"><span class="pi-cls">${r.cls}</span><span class="pi-num">${r.pi}</span>${
      dpi ? `<em class="${dpi > 0 ? 'up' : 'down'}">${dpi > 0 ? '+' : ''}${dpi}</em>` : ''
    }</div><div class="stats">${STAT_LABELS.map(([k, label]) => {
      const a = cur[k];
      const b = pre[k];
      const lo = Math.min(a, b);
      const diff = b - a;
      return `<div class="stat"><span>${label}</span><div class="sbar"><i style="width:${lo * 10}%"></i>${
        Math.abs(diff) > 0.05 ? `<em class="${diff > 0 ? 'up' : 'down'}" style="left:${lo * 10}%;width:${Math.abs(diff) * 10}%"></em>` : ''
      }</div><b class="${Math.abs(diff) > 0.05 ? (diff > 0 ? 'up' : 'down') : ''}">${b.toFixed(1)}</b></div>`;
    }).join('')}</div>`;
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
    const redraw = !this.el.classList.contains('hidden');
    this.el.classList.toggle('hidden', !r);
    if (!r) return;
    const player = r.entries.find((e) => e.isPlayer);
    if (r.online) return this.showOnline(r, player, redraw);
    const tt = r.mode === 'timetrial';
    const place = player?.place ?? 0;
    const title = tt ? (r.newRecord ? 'Novo recorde!' : 'Contrarrelógio') : place === 1 ? 'Vitória!' : place === 2 || place === 3 ? 'Pódio!' : `${place || '-'}º lugar`;
    const rows = tt
      ? r.lapTimes
          .map((t, i) =>
            this.row(i, t === r.bestLap, `<span class="rr-pos">${i + 1}</span>`, `Volta ${i + 1}`, formatTime(t), t === r.bestLap ? '<em class="rr-tag">Melhor</em>' : ''),
          )
          .join('')
      : r.entries
          .map((e, i) => this.row(i, e.isPlayer, `<span class="rr-pos">${e.place}</span>`, `<i class="dot" style="background:${e.color}"></i>${esc(e.name)}`, formatTime(e.time), formatTime(e.bestLap)))
          .join('');
    this.render(
      tt ? (r.newRecord ? 'record' : 'tt') : place === 1 ? 'win' : place <= 3 ? 'podium' : 'place',
      tt ? `<span class="rc-ico">⏱</span>` : `<span class="rc-num">${place || '-'}</span><span class="rc-ord">º</span>`,
      tt ? 'Contrarrelógio · Resultado' : 'Corrida · Resultado',
      title,
      tt ? ['Volta', 'Tempo', ''] : ['Piloto', 'Tempo', 'Melhor volta'],
      rows,
      r.bestLap !== null ? `A tua melhor volta <b>${formatTime(r.bestLap)}</b>` : '',
      ['Outra vez', 'Garagem', 'Menu'],
    );
  }

  private row(i: number, me: boolean, pos: string, name: string, time: string, extra: string) {
    return `<div class="rr${me ? ' me' : ''}" style="--i:${i}">${pos}<span class="rr-name">${name}</span><span class="rr-time">${time}</span><span class="rr-extra">${extra}</span></div>`;
  }

  private render(kind: string, badge: string, kicker: string, title: string, heads: string[], rows: string, foot: string, buttons: [string, string, string]) {
    this.el.innerHTML = `
      <div class="results-card rc-${kind}">
        <div class="rc-head">
          <div class="rc-badge">${badge}</div>
          <div class="rc-titles"><small>${esc(kicker)}</small><h2>${esc(title)}</h2></div>
        </div>
        <div class="rc-board">
          <div class="rr rr-th"><span></span><span>${heads[0]}</span><span>${heads[1]}</span><span>${heads[2]}</span></div>
          ${rows}
        </div>
        ${foot ? `<p class="best">${foot}</p>` : ''}
        <div class="row">
          <button class="pill primary" data-a="again" data-autofocus>${ICON_RESTART}${esc(buttons[0])}</button>
          <button class="pill" data-a="garage">${ICON_GARAGE}${esc(buttons[1])}</button>
          <button class="pill" data-a="menu" data-back>${ICON_EXIT}${esc(buttons[2])}</button>
        </div>
        <footer class="rc-hints">${hint('ok', 'Escolher')}${hint('back', esc(buttons[2]))}</footer>
      </div>`;
    requestAnimationFrame(() => nav.refocus());
  }

  /** Online board: live while others are still racing, with who's a person and who's an AI. */
  private showOnline(r: RaceResult, player: RaceResult['entries'][number] | undefined, redraw: boolean) {
    const done = r.entries.filter((e) => !e.racing).length;
    const racing = !player || !!player.racing;
    const place = player?.place ?? 0;
    const title = racing ? 'Corrida' : place === 1 ? 'Vitória!' : `${place}º lugar`;
    const rows = r.entries
      .map((e, i) =>
        this.row(
          i,
          e.isPlayer,
          `<span class="rr-pos">${e.racing ? '' : e.place}</span>`,
          `<i class="dot" style="background:${e.color}"></i>${esc(e.name)}${e.human ? '' : ' <em class="tag-ai">IA</em>'}`,
          e.racing ? `<span class="live-pill">${esc(e.racing)}</span>` : formatTime(e.time),
          formatTime(e.bestLap),
        ).replace('class="rr', `class="rr${e.racing ? ' live' : ''}`),
      )
      .join('');
    // the live board redraws as others finish: keep the player's focus where it was
    const had = (document.activeElement as HTMLElement | null)?.dataset?.a;
    this.render(
      racing ? 'live' : place === 1 ? 'win' : place <= 3 ? 'podium' : 'place',
      racing ? '<span class="rc-ico"><span class="mp-dots"><i></i><i></i><i></i></span></span>' : `<span class="rc-num">${place}</span><span class="rc-ord">º</span>`,
      'Online · Resultado',
      title,
      ['Piloto', 'Tempo', 'Melhor volta'],
      rows,
      done < r.entries.length ? '<span class="mp-dots"><i></i><i></i><i></i></span> Ainda há pilotos em pista' : 'Todos cortaram a meta',
      ['Voltar à sala', 'Garagem', 'Sair da sala'],
    );
    if (had) this.el.querySelector<HTMLElement>(`[data-a="${had}"]`)?.focus({ preventScroll: true });
    if (redraw) this.el.querySelector('.results-card')!.classList.add('no-anim');
  }
}

// ---------------------------------------------------------------- pause

export class PauseScreen {
  readonly el: HTMLElement;
  onResume: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  onControls: (() => void) | null = null;
  onResolution: (() => string) | null = null;

  constructor(root: HTMLElement, withControls: boolean, resolutionLabel: string) {
    this.el = h('div', 'screen pause hidden');
    const row = (a: string, icon: string, label: string, extra = '') =>
      `<button class="prow" data-a="${a}"${extra}><span class="prow-ico">${icon}</span><span class="prow-label">${label}</span>${
        a === 'res' ? `<em class="prow-val" data-v="res">${valueOf(resolutionLabel)}</em>` : ''
      }</button>`;
    this.el.innerHTML = `
      <div class="pause-blade">
        <div class="pb-head"><small class="pb-kicker">Hyperdrift</small><h2>Pausa</h2></div>
        <div class="pb-list">
          ${row('resume', ICON_PLAY, 'Continuar', ' data-autofocus data-back')}
          ${row('restart', ICON_RESTART, 'Recomeçar')}
          ${withControls ? row('controls', ICON_PAD, 'Controlos') : ''}
          ${row('res', ICON_RES, 'Resolução')}
          ${row('quit', ICON_EXIT, 'Sair para o menu')}
        </div>
        <footer class="pb-hints">${hint('ok', 'Escolher')}${hint('back', 'Continuar')}</footer>
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
      if (b.dataset.a === 'res' && this.onResolution) this.setResolutionLabel(this.onResolution());
    });
  }

  show(v: boolean) {
    this.el.classList.toggle('hidden', !v);
    if (v) requestAnimationFrame(() => nav.refocus());
  }

  /** Online there's no restarting the race for everybody (the zone just puts you back at the start); "quit" goes back to the room. */
  setOnline(v: boolean, zone = false) {
    const restart = this.el.querySelector<HTMLElement>('[data-a="restart"]')!;
    restart.classList.toggle('hidden', v && !zone);
    restart.querySelector('.prow-label')!.textContent = zone ? 'Voltar ao início' : 'Recomeçar';
    this.el.querySelector('[data-a="quit"] .prow-label')!.textContent = v ? 'Voltar à sala' : 'Sair para o menu';
    this.el.querySelector('.pb-head h2')!.textContent = v ? 'Menu' : 'Pausa';
    this.el.querySelector('.pb-kicker')!.textContent = v ? (zone ? 'Online · a zona continua' : 'Online · a corrida continua') : zone ? 'Zona livre' : 'Hyperdrift';
  }

  setResolutionLabel(label: string) {
    this.el.querySelector('[data-v="res"]')!.textContent = valueOf(label);
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
    this.el.dataset.modal = '';
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
        <button class="btn primary" data-a="close" data-back>Fechar</button>
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
    requestAnimationFrame(() => nav.refocus());
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
