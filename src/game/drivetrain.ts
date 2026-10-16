/**
 * Gearbox and engine revs. Only sound and effects read this (the arcade
 * physics push the car directly), but it behaves like a real drivetrain:
 * six closely stacked gears, clutch slip at launch, ignition cut on
 * upshifts, the rev limiter, free revving in the air and overrun pops.
 */

/** Top speed of each gear at the redline, as a fraction of the car's top speed. */
const GEAR_TOP = [0.22, 0.38, 0.54, 0.7, 0.86, 1.07];
export const IDLE = 0.12;

export interface DrivetrainTuning {
  revRate: number;
  popRate: number;
}

export interface DrivetrainInput {
  speed: number; // forward speed, m/s (negative = reversing)
  topSpeed: number;
  throttle: number;
  grounded: boolean;
  /** extra revs from wheelspin (drift, burnout) 0..1 */
  spin: number;
}

export type DrivetrainEvent = { type: 'shift'; up: boolean } | { type: 'pop'; strength: number };

export class Drivetrain {
  /** revs as a fraction of the redline */
  rpm = IDLE;
  gear = 0;
  /** ignition cut while a shift happens (seconds left) */
  cut = 0;
  limiter = false;
  /** throttle the engine actually sees (0 during a shift) */
  throttle = 0;
  private overrun = 0;
  private lastThrottle = 0;
  private seed: number;
  events: DrivetrainEvent[] = [];

  constructor(
    public tuning: DrivetrainTuning,
    seed = 1,
  ) {
    this.seed = seed * 7919 + 13;
  }

  private rnd() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  reset() {
    this.rpm = IDLE;
    this.gear = 0;
    this.cut = 0;
    this.overrun = 0;
    this.limiter = false;
  }

  /** Revs of gear `g` at this speed, as a fraction of the redline. */
  static roadRpm(speed: number, topSpeed: number, g: number) {
    return Math.abs(speed) / (GEAR_TOP[g] * topSpeed);
  }

  step(dt: number, i: DrivetrainInput) {
    const spd = Math.abs(i.speed);
    const thr = i.throttle;
    if (this.cut > 0) this.cut -= dt;

    // gear selection (reverse rides first gear)
    if (i.grounded) {
      if (i.speed < -0.5) {
        this.gear = 0;
      } else {
        const up = Drivetrain.roadRpm(spd, i.topSpeed, this.gear);
        if (this.gear < GEAR_TOP.length - 1 && up > 0.94 && this.cut <= 0) {
          this.gear++;
          this.cut = thr > 0 ? 0.1 : 0;
          this.events.push({ type: 'shift', up: true });
          if (thr > 0 && this.rnd() < this.tuning.popRate * 0.06) this.events.push({ type: 'pop', strength: 0.55 });
        } else if (this.gear > 0 && Drivetrain.roadRpm(spd, i.topSpeed, this.gear - 1) < 0.72) {
          this.gear--;
          this.events.push({ type: 'shift', up: false });
        }
      }
    }

    let target: number;
    let rate = this.tuning.revRate;
    if (!i.grounded) {
      // wheels in the air: the engine revs freely
      target = thr > 0 ? 1.02 : IDLE;
      rate *= thr > 0 ? 0.55 : 0.35;
    } else {
      let road = Drivetrain.roadRpm(spd, i.topSpeed, this.gear);
      // top gear is long: boosting past top speed leans on it instead of bouncing off the limiter
      if (this.gear === GEAR_TOP.length - 1 && road > 0.9) road = 0.9 + (road - 0.9) * 0.3;
      // clutch slip pulling away, plus wheelspin
      const launch = this.gear === 0 ? IDLE + thr * 0.42 * Math.max(0, 1 - spd / 9) : 0;
      target = Math.max(IDLE, road, launch) + i.spin * 0.12;
      if (this.cut > 0) rate = 26;
    }
    this.rpm += (Math.min(1.03, target) - this.rpm) * (1 - Math.exp(-rate * dt));
    this.limiter = thr > 0 && this.rpm > 0.985;
    this.throttle = this.cut > 0 ? 0 : thr;

    // lift-off at high revs: unburnt fuel crackles in the hot pipes
    if (this.lastThrottle > 0.5 && thr < 0.2 && this.rpm > 0.5) this.overrun = 0.7 + this.rpm * 0.9;
    this.lastThrottle = thr;
    if (this.overrun > 0) {
      this.overrun -= dt;
      if (thr > 0.3 || this.rpm < 0.3) this.overrun = 0;
      else if (this.rnd() < this.tuning.popRate * dt * (0.4 + this.rpm)) {
        this.events.push({ type: 'pop', strength: 0.35 + this.rnd() * 0.65 * this.rpm });
      }
    }
  }
}
