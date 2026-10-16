import type { DriveInput } from '../game/carPhysics';
import { TiltSteer } from './tilt';

export type ControlMode = 'buttons' | 'tilt';

type Action = 'up' | 'down' | 'left' | 'right' | 'nitro';

const KEYS: Record<string, Action> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'nitro',
  ShiftLeft: 'nitro',
  ShiftRight: 'nitro',
  KeyN: 'nitro',
};

/**
 * Four driving controls: forward, back (brake, then reverse), left, right,
 * plus a nitro button.
 * Keyboard, on-screen touch buttons and gamepads all feed the same state.
 */
export class Input {
  private keys = new Set<Action>();
  private touch = new Map<number, Action>();
  private steerSmooth = 0;
  readonly el: HTMLElement;
  readonly tilt = new TiltSteer();
  private mode: ControlMode = 'buttons';
  private meter: HTMLElement;
  private meterDot: HTMLElement;
  private meterFill: HTMLElement;
  onPause: (() => void) | null = null;
  onCamera: (() => void) | null = null;

  constructor(root: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      const a = KEYS[e.code];
      if (a) {
        this.keys.add(a);
        e.preventDefault();
      }
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.onPause) this.onPause();
      if (e.code === 'KeyC' && !e.repeat && !e.ctrlKey && !e.metaKey && this.onCamera) this.onCamera();
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
        <button data-a="nitro" class="tc-nitro" aria-label="Nitro"><b>N₂O</b><i></i></button>
        <button data-a="down" class="tc-brake" aria-label="Travar / marcha-atrás"><svg viewBox="0 0 24 24"><path d="m4 9 8 8 8-8"/></svg></button>
        <button data-a="up" class="tc-gas" aria-label="Acelerar"><svg viewBox="0 0 24 24"><path d="m4 15 8-8 8 8"/></svg></button>
      </div>
      <div class="tc-tilt" role="button" aria-label="Recentrar inclinação">
        <div class="tc-tilt-track"><i class="tc-tilt-fill"></i><i class="tc-tilt-dot"></i></div>
        <small>TOCA PARA RECENTRAR</small>
      </div>`;
    root.appendChild(this.el);
    this.meter = this.el.querySelector('.tc-tilt')!;
    this.meterDot = this.el.querySelector('.tc-tilt-dot')!;
    this.meterFill = this.el.querySelector('.tc-tilt-fill')!;
    this.meter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.tilt.calibrate();
      this.onRecenter?.(this.tilt.center);
      this.meter.classList.remove('flash');
      void this.meter.offsetWidth;
      this.meter.classList.add('flash');
    });
    const buttons = Array.from(this.el.querySelectorAll('button'));
    // A finger can slide between buttons: resolve the button under each pointer on every move.
    const resolve = (e: PointerEvent) => {
      const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('button[data-a]') as HTMLButtonElement | null;
      if (t && this.el.contains(t)) this.touch.set(e.pointerId, t.dataset.a as Action);
      else this.touch.delete(e.pointerId);
      this.refresh();
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (this.meter.contains(e.target as Node)) return;
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
  onRecenter: ((center: number) => void) | null = null;

  /** Switch between on-screen steering buttons and tilt steering. */
  setMode(m: ControlMode) {
    this.mode = m;
    if (m === 'tilt') this.tilt.listen();
    else this.tilt.stop();
    this.tilt.reset();
  }

  get controlMode(): ControlMode {
    return this.mode;
  }

  private tiltShown = false;

  /** Tilt layout: steering buttons hide, brake moves under the left thumb, gas stays right. */
  private showTilt(on: boolean) {
    this.tiltShown = on;
    this.el.classList.toggle('tilt', on);
    const brake = this.el.querySelector('.tc-brake')!;
    const group = this.el.querySelector(on ? '.tc-left' : '.tc-right')!;
    if (on) group.appendChild(brake);
    else group.insertBefore(brake, group.querySelector('.tc-gas'));
    // a finger resting on a button that just hid must not keep steering
    for (const [id, a] of this.touch) if (on && (a === 'left' || a === 'right')) this.touch.delete(id);
    this.refresh();
  }

  private get tiltActive(): boolean {
    return this.mode === 'tilt' && this.tilt.live;
  }

  private refresh() {
    const active = new Set(this.touch.values());
    for (const b of this.buttons) b.classList.toggle('on', active.has(b.dataset.a as Action));
  }

  /** Shows how full the nitro tank is on the touch button. */
  setNitro(level: number, active: boolean) {
    const b = this.nitroBtn;
    if (!b) return;
    b.style.setProperty('--n', level.toFixed(3));
    b.classList.toggle('ready', level > 0.08);
    b.classList.toggle('burn', active);
  }

  private get nitroBtn() {
    return this.buttons.find((b) => b.dataset.a === 'nitro');
  }

  setTouchVisible(v: boolean) {
    this.el.classList.toggle('visible', v);
    this.showTilt(this.tiltActive);
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
    let nitro = this.has('nitro') ? 1 : 0;
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
      if (p.buttons[2]?.pressed || p.buttons[5]?.pressed) nitro = 1;
    }
    // if the sensor goes quiet (denied, unsupported, phone flat) the steering buttons come back
    const tilting = this.tiltActive;
    if (tilting !== this.tiltShown) this.showTilt(tilting);
    if (tilting) {
      const t = this.tilt.read(dt);
      this.updateMeter(t);
      // keys/pad still win when used, otherwise the wheel is analog and needs no easing
      if (steerTarget === 0) {
        this.steerSmooth = t;
        return { throttle, brake, steer: t, nitro };
      }
    }
    // digital steering is eased in so taps make small corrections
    const rate = Math.abs(steerTarget) > Math.abs(this.steerSmooth) ? 7 : 12;
    this.steerSmooth += (steerTarget - this.steerSmooth) * (1 - Math.exp(-rate * dt));
    if (Math.abs(this.steerSmooth) < 0.01 && steerTarget === 0) this.steerSmooth = 0;
    return { throttle, brake, steer: this.steerSmooth, nitro };
  }

  private updateMeter(t: number) {
    const pct = t * 50;
    this.meterDot.style.transform = `translateX(${pct * 1.6}px)`;
    this.meterFill.style.transform = `scaleX(${t})`;
    this.meter.classList.toggle('full', Math.abs(t) > 0.98);
  }

  get anyPressed(): boolean {
    return this.keys.size > 0 || this.touch.size > 0;
  }

  clear() {
    this.keys.clear();
    this.touch.clear();
    this.steerSmooth = 0;
    this.tilt.reset();
    this.refresh();
  }
}
