import { Vector3 } from 'three';
import { HALF_WIDTH, type Track } from '../track/track';
import type { CarPhysics, DriveInput } from './carPhysics';

/**
 * AI driver: follows a weaving racing line with a speed-dependent look-ahead,
 * eases off for sharp corners, dodges cars ahead and recovers when stuck.
 */
export class AiDriver {
  private stuck = 0;
  private laneSeed: number;
  private dodge = 0;
  /** extra pace multiplier set by the race (rubber band) */
  pace = 1;

  constructor(
    private track: Track,
    public skill: number,
    seed: number,
  ) {
    this.laneSeed = seed * 1.7;
  }

  private lane(s: number): number {
    // a smooth, car-specific racing line within the deck
    const a = Math.sin(s * 0.004 + this.laneSeed) * 0.55 + Math.sin(s * 0.011 + this.laneSeed * 2.3) * 0.3;
    return a * (HALF_WIDTH - 3);
  }

  drive(car: CarPhysics, others: CarPhysics[], dt: number): DriveInput {
    const speed = car.speed;
    const s = car.trackS;
    const look = 10 + speed * 0.55;

    // avoid the car in front
    let dodgeTarget = 0;
    for (const o of others) {
      if (o === car) continue;
      let ds = o.trackS - s;
      if (ds < -this.track.length / 2) ds += this.track.length;
      if (ds > this.track.length / 2) ds -= this.track.length;
      if (ds > 0 && ds < 22 && Math.abs(o.lateral - car.lateral) < 3) {
        dodgeTarget = o.lateral > car.lateral ? -5 : 5;
      }
    }
    this.dodge += (dodgeTarget - this.dodge) * (1 - Math.exp(-2 * dt));

    const lat = Math.max(-HALF_WIDTH + 2.5, Math.min(HALF_WIDTH - 2.5, this.lane(s + look) + this.dodge));
    const target = this.track.pointAt(s + look, lat, 0, TMP);
    const to = TMP2.copy(target).sub(car.pos);
    to.addScaledVector(car.up, -to.dot(car.up)).normalize();
    const side = to.dot(car.right); // + means target is to the right
    const ahead = to.dot(car.fwd);
    let steer = Math.max(-1, Math.min(1, Math.atan2(side, ahead) * 2.6));

    // corner speed: how much the track turns in the deck plane ahead
    const f0 = this.track.frameAt(s);
    const f1 = this.track.frameAt(s + 35 + speed * 0.4);
    const bend = Math.abs(f1.fwd.dot(f0.right));
    const want = car.stats.topSpeed * this.skill * this.pace * (1.12 - Math.min(0.55, bend * 0.85));
    let throttle = speed < want ? 1 : 0;
    let brake = speed > want + 9 ? 1 : 0;

    if (!car.grounded) {
      steer *= 0.3;
      brake = 0;
      throttle = 0;
    }

    // stuck recovery
    if (speed < 3 && car.grounded) this.stuck += dt;
    else this.stuck = 0;
    if (this.stuck > 2.5) {
      car.respawn();
      this.stuck = 0;
    }
    if (car.forwardSpeed < -2) {
      throttle = 1;
      brake = 0;
    }

    // nitro on the straights, saving a bit of tank
    const straight = car.grounded && bend < 0.14 && Math.abs(steer) < 0.3 && throttle > 0 && brake === 0;
    const nitro = straight && (car.nitroActive ? car.nitro > 0.02 : car.nitro > 0.55 && speed > car.stats.topSpeed * 0.5) ? 1 : 0;
    return { throttle, brake, steer, nitro };
  }
}

const TMP = new Vector3();
const TMP2 = new Vector3();
