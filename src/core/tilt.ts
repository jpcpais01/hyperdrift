/**
 * Tilt steering: hold the phone in landscape like a steering wheel.
 *
 * We read DeviceOrientation (alpha/beta/gamma), rebuild the world "up" vector in
 * device space, rotate it into screen space using the current screen rotation,
 * and steer from how far "up" leans sideways on screen. Working from the vector
 * instead of raw beta/gamma avoids the Euler flip that happens exactly at the
 * landscape pose (gamma = ±90°), and it does not care how far the phone is tipped
 * towards the player.
 */

type PermissionFn = () => Promise<'granted' | 'denied' | 'default'>;

/** Full lock angle (degrees) for each sensitivity step: low, medium, high. */
export const TILT_LOCK_DEG = [32, 22, 15] as const;
export const TILT_SENS_LABELS = ['BAIXA', 'MÉDIA', 'ALTA'] as const;
export type TiltSens = 0 | 1 | 2;

const DEADZONE_DEG = 2.2;
const DEG = Math.PI / 180;

export const tiltSupported = () => typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;

function needsPermission(): boolean {
  const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: PermissionFn } }).DeviceOrientationEvent;
  return typeof D?.requestPermission === 'function';
}

function screenAngle(): number {
  const o = screen.orientation?.angle;
  if (typeof o === 'number') return o;
  const w = (window as unknown as { orientation?: number }).orientation;
  return typeof w === 'number' ? w : 0;
}

export class TiltSteer {
  /** Raw wheel angle in radians (+ = turned clockwise / right). */
  private raw = 0;
  private filtered = 0;
  private lastEvent = 0;
  private listening = false;
  private granted = !needsPermission();
  enabled = false;
  center = 0;
  sens: TiltSens = 1;

  private onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    const b = e.beta * DEG;
    const g = e.gamma * DEG;
    // world up expressed in device axes (x right, y top, z out of the screen)
    const ux = -Math.sin(g) * Math.cos(b);
    const uy = Math.sin(b);
    // rotate into screen axes for the current screen rotation
    const a = screenAngle() * DEG;
    const sx = ux * Math.cos(a) - uy * Math.sin(a);
    const sy = ux * Math.sin(a) + uy * Math.cos(a);
    // turning the phone clockwise makes "up" lean left on screen; atan2 keeps it
    // continuous, and the length guard handles a phone lying almost flat
    const len = Math.hypot(sx, sy);
    if (len < 0.12) return; // nearly flat: the wheel angle is meaningless, hold the last value
    this.raw = Math.atan2(-sx, sy);
    this.lastEvent = performance.now();
  };

  /** True once orientation events are actually arriving. */
  get live(): boolean {
    return this.listening && performance.now() - this.lastEvent < 1000;
  }

  /** Current wheel angle relative to the calibrated centre, in degrees. */
  get angleDeg(): number {
    return wrap(this.raw - this.center) / DEG;
  }

  get needsGesture(): boolean {
    return !this.granted;
  }

  /**
   * Ask for sensor access. On iOS this must run inside a tap/click handler.
   * Resolves true when events can flow.
   */
  async request(): Promise<boolean> {
    if (!tiltSupported()) return false;
    if (needsPermission() && !this.granted) {
      try {
        const D = (window as unknown as { DeviceOrientationEvent: { requestPermission: PermissionFn } }).DeviceOrientationEvent;
        this.granted = (await D.requestPermission()) === 'granted';
      } catch {
        this.granted = false;
      }
      if (!this.granted) return false;
    }
    this.listen();
    return true;
  }

  /** Start listening without prompting (works where no permission is needed, or once granted). */
  listen() {
    if (this.listening || !this.granted || !tiltSupported()) return;
    window.addEventListener('deviceorientation', this.onOrient);
    this.listening = true;
  }

  stop() {
    if (!this.listening) return;
    window.removeEventListener('deviceorientation', this.onOrient);
    this.listening = false;
  }

  /** Make the way the phone is held right now the straight-ahead position. */
  calibrate() {
    this.center = this.raw;
  }

  /** Steering in -1..1 with deadzone, a gentle curve and light smoothing. */
  read(dt: number): number {
    const lock = TILT_LOCK_DEG[this.sens];
    const deg = this.angleDeg;
    const mag = Math.max(0, Math.abs(deg) - DEADZONE_DEG) / (lock - DEADZONE_DEG);
    const m = Math.min(1, mag);
    // a touch of expo: fine control around centre, full lock still reachable
    const target = Math.sign(deg) * (0.55 * m + 0.45 * m * m);
    this.filtered += (target - this.filtered) * (1 - Math.exp(-22 * dt));
    if (Math.abs(this.filtered) < 0.002) this.filtered = 0;
    return this.filtered;
  }

  reset() {
    this.filtered = 0;
  }
}

function wrap(r: number): number {
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}
