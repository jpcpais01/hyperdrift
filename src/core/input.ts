import type { DriveInput } from '../game/carPhysics';

type Action = 'up' | 'down' | 'left' | 'right';

const KEYS: Record<string, Action> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};

/**
 * Four controls only: forward, back (brake, then reverse), left, right.
 * Keyboard, on-screen touch buttons and gamepads all feed the same state.
 */
export class Input {
  private keys = new Set<Action>();
  private touch = new Map<number, Action>();
  private steerSmooth = 0;
  readonly el: HTMLElement;
  onPause: (() => void) | null = null;

  constructor(root: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      const a = KEYS[e.code];
      if (a) {
        this.keys.add(a);
        e.preventDefault();
      }
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.onPause) this.onPause();
    });
    window.addEventListener('keyup', (e) => {
      const a = KEYS[e.code];
      if (a) this.keys.delete(a);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.touch.clear();
      this.refresh();
    });

    this.el = document.createElement('div');
    this.el.className = 'touch-controls';
    this.el.innerHTML = `
      <div class="tc-group tc-left">
        <button data-a="left" aria-label="Esquerda"><svg viewBox="0 0 24 24"><path d="M15 4 7 12l8 8"/></svg></button>
        <button data-a="right" aria-label="Direita"><svg viewBox="0 0 24 24"><path d="m9 4 8 8-8 8"/></svg></button>
      </div>
      <div class="tc-group tc-right">
        <button data-a="down" class="tc-brake" aria-label="Travar / marcha-atrás"><svg viewBox="0 0 24 24"><path d="m4 9 8 8 8-8"/></svg></button>
        <button data-a="up" class="tc-gas" aria-label="Acelerar"><svg viewBox="0 0 24 24"><path d="m4 15 8-8 8 8"/></svg></button>
      </div>`;
    root.appendChild(this.el);
    const buttons = Array.from(this.el.querySelectorAll('button'));
    // A finger can slide between buttons: resolve the button under each pointer on every move.
    const resolve = (e: PointerEvent) => {
      const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('button[data-a]') as HTMLButtonElement | null;
      if (t && this.el.contains(t)) this.touch.set(e.pointerId, t.dataset.a as Action);
      else this.touch.delete(e.pointerId);
      this.refresh();
    };
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.el.setPointerCapture?.(e.pointerId);
      resolve(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (this.touch.has(e.pointerId) || e.buttons) resolve(e);
    });
    const end = (e: PointerEvent) => {
      this.touch.delete(e.pointerId);
      this.refresh();
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.buttons = buttons;
  }

  private buttons: HTMLButtonElement[];

  private refresh() {
    const active = new Set(this.touch.values());
    for (const b of this.buttons) b.classList.toggle('on', active.has(b.dataset.a as Action));
  }

  setTouchVisible(v: boolean) {
    this.el.classList.toggle('visible', v);
  }

  private has(a: Action): boolean {
    if (this.keys.has(a)) return true;
    for (const t of this.touch.values()) if (t === a) return true;
    return false;
  }

  read(dt: number): DriveInput {
    let throttle = this.has('up') ? 1 : 0;
    let brake = this.has('down') ? 1 : 0;
    let steerTarget = (this.has('right') ? 1 : 0) - (this.has('left') ? 1 : 0);
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] ?? 0;
      if (Math.abs(ax) > 0.15) steerTarget = ax;
      throttle = Math.max(throttle, p.buttons[7]?.value ?? 0, p.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, p.buttons[6]?.value ?? 0, p.buttons[1]?.pressed ? 1 : 0);
      if (p.buttons[12]?.pressed) throttle = 1;
      if (p.buttons[13]?.pressed) brake = 1;
      if (p.buttons[14]?.pressed) steerTarget = -1;
      if (p.buttons[15]?.pressed) steerTarget = 1;
    }
    // digital steering is eased in so taps make small corrections
    const rate = Math.abs(steerTarget) > Math.abs(this.steerSmooth) ? 7 : 12;
    this.steerSmooth += (steerTarget - this.steerSmooth) * (1 - Math.exp(-rate * dt));
    if (Math.abs(this.steerSmooth) < 0.01 && steerTarget === 0) this.steerSmooth = 0;
    return { throttle, brake, steer: this.steerSmooth };
  }

  get anyPressed(): boolean {
    return this.keys.size > 0 || this.touch.size > 0;
  }

  clear() {
    this.keys.clear();
    this.touch.clear();
    this.steerSmooth = 0;
    this.refresh();
  }
}
