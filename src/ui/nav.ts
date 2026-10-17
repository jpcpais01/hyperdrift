import { audio } from '../core/audio';

/**
 * Console-style menu navigation: arrows / WASD / d-pad / left stick move a
 * focus highlight between the buttons of whatever layer is on top, Enter /
 * Space / ✕ press it, Esc / ◯ go back, Q E / L1 R1 flip tabs.
 *
 * The layer is the topmost visible `[data-modal]` overlay, otherwise the
 * topmost visible `.screen`. Inside it, `[data-back]` is the back button and
 * `[data-autofocus]` is where focus lands first.
 *
 * `<body data-input>` says what the player last touched (pointer, kbd, pad)
 * and `data-pad` which glyph family to draw (ps or xbox), so button hints
 * can show the right keycap with nothing but CSS.
 */

type InputKind = 'pointer' | 'kbd' | 'pad';
type Dir = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = 'button:not(:disabled):not([data-nav-skip])';
const REPEAT_DELAY = 0.36;
const REPEAT_RATE = 0.1;

function shown(el: Element) {
  return el.getClientRects().length > 0;
}

/** buttons inside a nested modal belong to that modal, not to the layer around it */
function own(layer: HTMLElement, el: Element) {
  const m = el.closest('[data-modal]');
  return !m || m === layer || !layer.contains(m);
}

class MenuNav {
  private kind: InputKind = 'pointer';
  private layer: HTMLElement | null = null;
  private padPrev: boolean[] = [];
  private held: Dir | null = null;
  private heldT = 0;
  private last = 0;
  /** in a race, Esc belongs to the driving input (pause), not to menus */
  inRace = false;
  /** ▶ / Options on a pad: toggle pause */
  onStart: (() => void) | null = null;

  init() {
    document.body.dataset.input = this.kind;
    document.body.dataset.pad = 'xbox';
    window.addEventListener(
      'pointerdown',
      () => {
        this.setKind('pointer');
      },
      true,
    );
    window.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('gamepadconnected', (e) => this.padType(e.gamepad));
    requestAnimationFrame(this.tick);
  }

  private setKind(k: InputKind) {
    if (this.kind === k) return;
    this.kind = k;
    document.body.dataset.input = k;
    if (k === 'pointer' && document.activeElement instanceof HTMLElement && document.activeElement.closest('#ui')) {
      document.activeElement.blur();
    }
  }

  private padType(p: Gamepad) {
    document.body.dataset.pad = /054c|playstation|dualsense|dualshock|sony/i.test(p.id) ? 'ps' : 'xbox';
  }

  /** the topmost visible layer */
  private findLayer(): HTMLElement | null {
    const ui = document.getElementById('ui');
    if (!ui) return null;
    const modals = [...ui.querySelectorAll<HTMLElement>('[data-modal]')].filter(shown);
    if (modals.length) return modals[modals.length - 1];
    const screens = [...ui.querySelectorAll<HTMLElement>(':scope > .screen')].filter(shown);
    return screens[screens.length - 1] ?? null;
  }

  private targets(layer: HTMLElement) {
    return [...layer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((b) => shown(b) && own(layer, b));
  }

  private current(layer: HTMLElement): HTMLElement | null {
    const a = document.activeElement as HTMLElement | null;
    return a && layer.contains(a) && a.matches(FOCUSABLE) && shown(a) ? a : null;
  }

  private focus(el: HTMLElement, sound = true) {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    if (sound) audio.nav();
  }

  private focusDefault(layer: HTMLElement) {
    const list = this.targets(layer);
    const auto = list.find((b) => b.matches('[data-autofocus]')) ?? list.find((b) => b.matches('.on')) ?? list[0];
    if (auto) this.focus(auto, false);
  }

  /** Spatial move: the nearest button in that direction, favouring ones in line. */
  move(dir: Dir) {
    const layer = this.layer;
    if (!layer) return;
    const cur = this.current(layer);
    if (!cur) return this.focusDefault(layer);
    // sliders (volume bars) take left / right for themselves
    if ((dir === 'left' || dir === 'right') && cur.hasAttribute('data-adjust')) {
      cur.dispatchEvent(new CustomEvent('nav-adjust', { detail: dir === 'right' ? 1 : -1 }));
      return;
    }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const b of this.targets(layer)) {
      if (b === cur) continue;
      const q = b.getBoundingClientRect();
      const bx = q.left + q.width / 2;
      const by = q.top + q.height / 2;
      let main: number;
      let side: number;
      if (dir === 'left' || dir === 'right') {
        main = dir === 'right' ? q.left - r.right : r.left - q.right;
        if ((dir === 'right' ? bx - cx : cx - bx) <= 1) continue;
        // overlapping rows count as in line
        side = Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top) > 0 ? 0 : Math.abs(by - cy);
      } else {
        main = dir === 'down' ? q.top - r.bottom : r.top - q.bottom;
        if ((dir === 'down' ? by - cy : cy - by) <= 1) continue;
        side = Math.min(q.right, r.right) - Math.max(q.left, r.left) > 0 ? 0 : Math.abs(bx - cx);
      }
      const score = Math.max(0, main) + side * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best) this.focus(best);
    else cur.animate([{ transform: 'translateX(0)' }, { transform: `translate${dir === 'left' || dir === 'right' ? 'X' : 'Y'}(${dir === 'left' || dir === 'up' ? -4 : 4}px)` }, { transform: 'translateX(0)' }], { duration: 160 });
  }

  private press() {
    const layer = this.layer;
    if (!layer) return;
    const cur = this.current(layer);
    if (!cur) return this.focusDefault(layer);
    cur.classList.remove('nav-press');
    void cur.offsetWidth;
    cur.classList.add('nav-press');
    cur.click();
  }

  private back(): boolean {
    const layer = this.layer;
    if (!layer) return false;
    const b = [...layer.querySelectorAll<HTMLElement>('[data-back]')].find((x) => shown(x) && own(layer, x));
    if (!b) return false;
    b.click();
    return true;
  }

  private tab(d: -1 | 1) {
    this.layer?.dispatchEvent(new CustomEvent('nav-tab', { detail: d }));
  }

  private key(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    this.layer = this.findLayer();
    if (!this.layer) return;
    const any = this.layer.querySelector<HTMLElement>('[data-anykey]');
    if (any && shown(any) && !e.repeat && !/^(Shift|Control|Alt|Meta|OS|Tab)/.test(e.code)) {
      e.preventDefault();
      this.setKind('kbd');
      any.click();
      return;
    }
    const dir: Dir | undefined = (
      { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' } as Record<string, Dir>
    )[e.code];
    if (dir) {
      const was = this.kind;
      this.setKind('kbd');
      e.preventDefault();
      // the first key only lights up the focus, like a console
      if (was !== 'kbd' && !this.current(this.layer)) this.focusDefault(this.layer);
      else this.move(dir);
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      if (e.defaultPrevented && e.code !== 'Space') return;
      if (e.repeat) return;
      this.setKind('kbd');
      e.preventDefault();
      this.press();
      return;
    }
    if ((e.code === 'Escape' || e.code === 'Backspace') && !e.defaultPrevented && !this.inRace) {
      if (e.repeat) return;
      if (this.back()) e.preventDefault();
      return;
    }
    if ((e.code === 'KeyQ' || e.code === 'KeyE' || e.code === 'PageUp' || e.code === 'PageDown') && !e.repeat) {
      this.tab(e.code === 'KeyQ' || e.code === 'PageUp' ? -1 : 1);
    }
  }

  private tick = (now: number) => {
    requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) pad = pad ?? p;
    if (!pad) return;
    const btn = (i: number) => !!pad!.buttons[i]?.pressed;
    const down: boolean[] = [];
    for (let i = 0; i < 16; i++) down[i] = btn(i);
    const edge = (i: number) => down[i] && !this.padPrev[i];
    const anyEdge = down.some((v, i) => v && !this.padPrev[i]);
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    let dir: Dir | null = null;
    if (down[12] || ay < -0.55) dir = 'up';
    else if (down[13] || ay > 0.55) dir = 'down';
    else if (down[14] || ax < -0.55) dir = 'left';
    else if (down[15] || ax > 0.55) dir = 'right';

    if (edge(9)) this.onStart?.();
    const layer = this.findLayer();
    if (layer !== this.layer) {
      this.layer = layer;
      if (layer && this.kind === 'pad' && !this.current(layer)) this.focusDefault(layer);
    }
    if (layer && (anyEdge || dir)) {
      const any = layer.querySelector<HTMLElement>('[data-anykey]');
      if (any && shown(any)) {
        this.setKind('pad');
        this.padType(pad);
        if (anyEdge) any.click();
        this.padPrev = down;
        return;
      }
      if (this.kind !== 'pad') {
        this.setKind('pad');
        this.padType(pad);
        if (!this.current(layer)) {
          // the first touch of the pad only lights up the focus
          this.focusDefault(layer);
          this.held = dir;
          this.heldT = -REPEAT_DELAY;
          this.padPrev = down;
          return;
        }
      }
      if (edge(0)) this.press();
      if (edge(1)) this.back();
      if (edge(4)) this.tab(-1);
      if (edge(5)) this.tab(1);
    }
    if (dir && layer) {
      if (dir !== this.held) {
        this.held = dir;
        this.heldT = -REPEAT_DELAY;
        this.move(dir);
      } else {
        this.heldT += dt;
        if (this.heldT > REPEAT_RATE) {
          this.heldT = 0;
          this.move(dir);
        }
      }
    } else this.held = null;
    this.padPrev = down;
  };

  /** keyboard/pad users get the focus put back after a screen redraws */
  refocus() {
    if (this.kind === 'pointer') return;
    const layer = this.findLayer();
    this.layer = layer;
    if (layer && !this.current(layer)) this.focusDefault(layer);
  }

  get usingPointer() {
    return this.kind === 'pointer';
  }
}

export const nav = new MenuNav();

/** Little keycap / face-button glyphs; CSS picks Enter, ✕ or A from <body data-input data-pad>. */
export function hint(kind: 'ok' | 'back' | 'tabs' | 'move', label: string) {
  return `<span class="hint"><i class="glyph g-${kind}"></i>${label}</span>`;
}
