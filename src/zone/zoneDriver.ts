import { Vector3 } from 'three';
import type { CarPhysics, DriveInput } from '../game/carPhysics';

export interface DriverStyle {
  /** cruising speed as a fraction of the car's top speed */
  pace: number;
  /** burns nitro on the straights */
  nitro: boolean;
}

/**
 * Ambient free-roam driver: follows a closed path (the plaza hairpins, the meadow tour,
 * the banked rim) with a speed-dependent look-ahead. On the tight plaza loop the car
 * holds full lock at speed, so the physics throws it into proper slides by itself.
 * It steps around cars in its way and quietly resets if it gets stuck.
 */
export class ZoneDriver {
  private idx = 0;
  private stuck = 0;
  private reverse = 0;
  private tries = 0;
  private lost = 0;
  private dodge = 0;

  constructor(
    readonly path: Vector3[],
    readonly style: DriverStyle,
  ) {}

  /** Path index nearest to p (searched around the last one). */
  private nearest(p: Vector3): number {
    const n = this.path.length;
    let best = this.idx;
    let bd = Infinity;
    for (let k = -30; k <= 30; k++) {
      const i = (this.idx + k + n) % n;
      const q = this.path[i];
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    // lost the line (a long jump, a big shove): search all of it
    if (bd > 15 * 15) {
      for (let i = 0; i < n; i++) {
        const q = this.path[i];
        const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    }
    return best;
  }

  /** Puts the car back on its line (spawn, or after getting stuck). */
  place(car: CarPhysics, at: number) {
    const n = this.path.length;
    this.idx = ((at % n) + n) % n;
    const a = this.path[this.idx];
    const b = this.path[(this.idx + 3) % n];
    const ground = car.ground!;
    TMP.set(a.x, ground.heightAt(a.x, a.z) + 0.05, a.z);
    car.place(TMP, TMP2.copy(b).sub(a).setY(0).normalize());
  }

  get index() {
    return this.idx;
  }

  drive(car: CarPhysics, others: CarPhysics[], dt: number): DriveInput {
    const n = this.path.length;
    const speed = car.speed;
    this.idx = this.nearest(car.pos);
    const step = this.path[0].distanceTo(this.path[1]);
    const lookM = 9 + speed * 0.45;
    const ahead = this.path[(this.idx + Math.round(lookM / step)) % n];

    // make room for anyone right in front
    let dodgeTarget = 0;
    for (const o of others) {
      if (o === car) continue;
      const d = TMP.copy(o.pos).sub(car.pos);
      const fwd = d.dot(car.fwd);
      const side = d.dot(car.right);
      if (fwd > 0 && fwd < 18 + speed * 0.3 && Math.abs(side) < 3.2) dodgeTarget = side > 0 ? -5 : 5;
    }
    this.dodge += (dodgeTarget - this.dodge) * (1 - Math.exp(-3 * dt));

    const target = TMP2.copy(ahead).addScaledVector(car.right, this.dodge);
    const to = TMP.copy(target).sub(car.pos);
    to.addScaledVector(car.up, -to.dot(car.up)).normalize();
    const sideA = to.dot(car.right);
    const aheadA = to.dot(car.fwd);
    let steer = Math.max(-1, Math.min(1, Math.atan2(sideA, aheadA) * 2.4));

    // corner speed from how much the line bends ahead
    const a0 = this.path[this.idx];
    const a1 = this.path[(this.idx + 6) % n];
    const b0 = this.path[(this.idx + 18) % n];
    const b1 = this.path[(this.idx + 24) % n];
    const t0x = a1.x - a0.x;
    const t0z = a1.z - a0.z;
    const t1x = b1.x - b0.x;
    const t1z = b1.z - b0.z;
    const bend = 1 - (t0x * t1x + t0z * t1z) / Math.max(1e-6, Math.hypot(t0x, t0z) * Math.hypot(t1x, t1z));
    const top = car.stats.topSpeed;
    const want = top * this.style.pace * (1 - Math.min(0.45, bend * 9));
    let throttle = speed < want ? 1 : 0.35;
    let brake = speed > want + 10 ? 1 : 0;

    if (!car.grounded) {
      steer *= 0.2;
      throttle = 0;
      brake = 0;
    }
    if (car.forwardSpeed < -2) {
      throttle = 1;
      brake = 0;
    }

    // stuck against something: back off for a moment, then try again; reset onto the line if that fails
    if (this.reverse > 0) {
      this.reverse -= dt;
      throttle = 0;
      brake = 1;
      steer = -steer;
    } else if (car.grounded && speed < 3) {
      this.stuck += dt;
      if (this.stuck > 0.9) {
        this.stuck = 0;
        this.reverse = 1.1;
        this.tries++;
      }
    } else if (speed > 8) {
      this.stuck = 0;
      this.tries = 0;
    }
    const line = this.path[this.idx];
    this.lost = Math.hypot(line.x - car.pos.x, line.z - car.pos.z) > 30 ? this.lost + dt : 0;
    if (this.tries > 2 || this.lost > 5) {
      this.place(car, this.idx + 10);
      this.stuck = this.reverse = this.lost = 0;
      this.tries = 0;
    }

    const straight = car.grounded && bend < 0.01 && Math.abs(steer) < 0.25 && throttle > 0;
    const nitro = this.style.nitro && straight && (car.nitroActive ? car.nitro > 0.05 : car.nitro > 0.6) ? 1 : 0;
    return { throttle, brake, steer, nitro };
  }
}

const TMP = new Vector3();
const TMP2 = new Vector3();
