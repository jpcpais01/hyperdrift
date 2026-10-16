/**
 * Swipe-to-look for the driving cameras: drag a finger (or the mouse) across
 * the open screen to swing the chase camera around the car, or to turn the
 * driver's head in the cockpit. Let go and the view drifts back behind the car.
 *
 * One shared instance listens on the window. A swipe only counts when it starts
 * on the game itself (the canvas or the bare HUD), so the touch buttons, the
 * pause button and every menu keep their pointers.
 */
export class CameraOrbit {
  /** around the car's up axis; negative = camera swung to its left (scene follows the finger) */
  yaw = 0;
  /** positive = camera raised over the car / head tipped down */
  pitch = 0;
  private yawVel = 0;
  private pitchVel = 0;
  private id: number | null = null;
  private last = { x: 0, y: 0, t: 0 };
  private down = { x: 0, y: 0, t: 0, moved: false };
  private lastTap = 0;
  /** seconds since the finger lifted */
  private idle = 10;
  private lastUse = -1e9;
  private snapBack = false;
  private limits = { yawMin: -Infinity, yawMax: Infinity, pitchMin: -0.25, pitchMax: 1.05 };

  /** a camera drew with the orbit this frame: swipes are live for a moment after */
  use(cockpit: boolean) {
    this.lastUse = performance.now();
    this.limits = cockpit ? COCKPIT_LIMITS : CHASE_LIMITS;
  }

  get dragging() {
    return this.id !== null;
  }

  private get live() {
    return performance.now() - this.lastUse < 250;
  }

  bind(canvas: HTMLElement) {
    const accepts = (t: EventTarget | null) => {
      if (t === canvas) return true;
      const el = t instanceof Element ? t : null;
      return !!el && !!el.closest('.hud') && !el.closest('button, [role="button"], a, input, select');
    };
    window.addEventListener('pointerdown', (e) => {
      if (this.id !== null || !this.live || !accepts(e.target)) return;
      // mouse: any button drags; touch / pen: the first finger on open screen
      this.id = e.pointerId;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const now = performance.now();
      this.last = { x: e.clientX, y: e.clientY, t: now };
      this.down = { x: e.clientX, y: e.clientY, t: now, moved: false };
      this.yawVel = this.pitchVel = 0;
      this.snapBack = false;
      this.idle = 0;
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.id) return;
      const now = performance.now();
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      const step = Math.max(1, now - this.last.t) / 1000;
      this.last = { x: e.clientX, y: e.clientY, t: now };
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 8) this.down.moved = true;
      // a full-width swipe is a bit over half a lap: quick enough to look behind in one stroke
      const k = 4 / Math.max(480, window.innerWidth);
      this.yaw -= dx * k;
      this.pitch += dy * k * 0.8;
      const a = Math.min(1, step * 18);
      this.yawVel += ((-dx * k) / step - this.yawVel) * a;
      this.pitchVel += ((dy * k * 0.8) / step - this.pitchVel) * a;
      this.clamp();
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== this.id) return;
      this.id = null;
      this.idle = 0;
      const now = performance.now();
      // a finger that stopped before lifting shouldn't fling the view
      if (now - this.last.t > 90) this.yawVel = this.pitchVel = 0;
      this.yawVel = Math.max(-7, Math.min(7, this.yawVel));
      this.pitchVel = Math.max(-3, Math.min(3, this.pitchVel));
      // double tap: straight back behind the car
      if (!this.down.moved && now - this.down.t < 300 && e.type === 'pointerup') {
        if (now - this.lastTap < 320) {
          this.snapBack = true;
          this.lastTap = 0;
        } else this.lastTap = now;
      }
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', () => (this.id = null));
  }

  update(dt: number) {
    if (!this.live) {
      // nothing is drawing with us (menus, garage, attract): sit at rest
      this.id = null;
      this.yaw = this.pitch = this.yawVel = this.pitchVel = 0;
      return;
    }
    this.clamp();
    if (this.id !== null) return;
    // a flick carries on for a moment, then the view settles back behind the car
    const fric = Math.exp(-5 * dt);
    this.yaw += this.yawVel * dt;
    this.pitch += this.pitchVel * dt;
    this.yawVel *= fric;
    this.pitchVel *= fric;
    this.clamp();
    this.idle += dt;
    if (this.idle > RETURN_DELAY || this.snapBack) {
      // shortest way home, gentle at first so it doesn't yank
      this.yaw = wrap(this.yaw);
      const ramp = this.snapBack ? 1 : Math.min(1, (this.idle - RETURN_DELAY) / 0.6);
      const e = 1 - Math.exp(-(this.snapBack ? 7 : 3.2) * ramp * dt);
      this.yaw -= this.yaw * e;
      this.pitch -= this.pitch * e;
      if (Math.abs(this.yaw) + Math.abs(this.pitch) < 1e-3) {
        this.yaw = this.pitch = 0;
        this.snapBack = false;
      }
    }
  }

  private clamp() {
    const l = this.limits;
    if (l.yawMax !== Infinity) {
      this.yaw = wrap(this.yaw);
      this.yaw = Math.max(l.yawMin, Math.min(l.yawMax, this.yaw));
    }
    const p = Math.max(l.pitchMin, Math.min(l.pitchMax, this.pitch));
    if (p !== this.pitch) this.pitchVel = 0;
    this.pitch = p;
  }
}

const RETURN_DELAY = 0.9;
const CHASE_LIMITS = { yawMin: -Infinity, yawMax: Infinity, pitchMin: -0.22, pitchMax: 1.05 };
// a driver can look over a shoulder, not through the headrest
const COCKPIT_LIMITS = { yawMin: -2.1, yawMax: 2.1, pitchMin: -0.5, pitchMax: 0.6 };

const wrap = (a: number) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

export const cameraOrbit = new CameraOrbit();
