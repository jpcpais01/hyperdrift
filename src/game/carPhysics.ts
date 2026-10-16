import { Quaternion, Vector3, Matrix4 } from 'three';
import { HALF_WIDTH, makeQuery, type Track } from '../track/track';
import type { CarStats } from '../car/stats';

export interface DriveInput {
  throttle: number;
  brake: number;
  /** -1 = left, +1 = right */
  steer: number;
}

export const GRAVITY = 24;
const CAR_HALF_WIDTH = 1.05;

export type CarEvent =
  | { type: 'land'; strength: number }
  | { type: 'wall'; strength: number }
  | { type: 'boost'; power: number }
  | { type: 'driftStart' }
  | { type: 'driftBoost'; amount: number }
  | { type: 'respawn' };

/**
 * Arcade car physics. The car lives in "track space": every step it is
 * projected on the track frame, so loops, corkscrews and banked turns all
 * just work (the deck is magnetic), while gaps let it fly ballistically.
 */
export class CarPhysics {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  readonly fwd = new Vector3(0, 0, 1);
  readonly up = new Vector3(0, 1, 0);
  readonly right = new Vector3(-1, 0, 0);
  readonly quat = new Quaternion();
  yawRate = 0;
  grounded = true;
  airTime = 0;
  trackIndex = 0;
  lastGroundIndex = 0;
  /** distance along the track, in metres, of the projection */
  trackS = 0;
  lateral = 0;
  forwardSpeed = 0;
  lateralSpeed = 0;
  steerVisual = 0;
  wheelSpin = 0;

  drifting = false;
  driftDir = 0;
  driftTime = 0;
  private driftRelease = 0;
  private steerHold = 0;
  private prevBrake = 0;

  boostTime = 0;
  boostPower = 0;
  /** smoothed 0..1 boost intensity for effects */
  boostFx = 0;

  // visual suspension
  pitch = 0;
  roll = 0;
  heave = 0;
  private pitchVel = 0;
  private rollVel = 0;
  private heaveVel = 0;

  rpm = 0.2;
  gear = 0;
  slip = 0;
  events: CarEvent[] = [];
  private q = makeQuery();
  private lastQ = makeQuery();

  constructor(
    public track: Track,
    public stats: CarStats,
  ) {}

  /** Place the car at distance s along the track, lateral offset `lat`. */
  reset(s: number, lat: number) {
    const fr = this.track.frameAt(s);
    this.pos.copy(fr.pos).addScaledVector(fr.right, lat);
    this.fwd.copy(fr.fwd);
    this.up.copy(fr.up);
    this.right.copy(fr.right);
    this.vel.set(0, 0, 0);
    this.yawRate = 0;
    this.grounded = true;
    this.trackIndex = fr.index;
    this.lastGroundIndex = fr.index;
    this.trackS = fr.s;
    this.drifting = false;
    this.driftTime = 0;
    this.boostTime = 0;
    this.boostFx = 0;
    this.pitch = this.roll = this.heave = 0;
    this.updateQuat();
  }

  triggerBoost(duration: number, power: number) {
    if (this.boostTime <= 0.05) this.events.push({ type: 'boost', power });
    this.boostTime = Math.max(this.boostTime, duration);
    this.boostPower = Math.max(this.boostTime > 0.05 ? this.boostPower : 0, power);
  }

  get speed(): number {
    return this.vel.length();
  }

  step(dt: number, input: DriveInput) {
    const st = this.stats;
    const q = this.track.query(this.pos, this.trackIndex, this.q);
    this.trackIndex = q.index;
    this.trackS = q.s;
    this.lateral = q.lateral;
    const overDeck = !q.gap && Math.abs(q.lateral) < HALF_WIDTH + 0.4;
    const snap = this.grounded ? 1.6 : 0.4;
    const towards = this.vel.dot(q.up);
    const wasGrounded = this.grounded;
    this.grounded = overDeck && q.height < snap && q.height > -3.5 && (wasGrounded || towards < 3);

    if (this.boostTime > 0) this.boostTime -= dt;
    const boosting = this.boostTime > 0;
    this.boostFx += ((boosting ? 1 : 0) - this.boostFx) * (1 - Math.exp(-(boosting ? 10 : 3) * dt));

    if (this.grounded) {
      if (!wasGrounded) this.land(q.up);
      this.airTime = 0;
      this.lastGroundIndex = q.index;
      // stick to the deck
      this.pos.addScaledVector(q.up, -q.height);
      this.up.lerp(q.up, 1 - Math.exp(-25 * dt)).normalize();
      this.vel.addScaledVector(q.up, -this.vel.dot(q.up));
      this.fwd.addScaledVector(this.up, -this.fwd.dot(this.up)).normalize();
      this.right.crossVectors(this.fwd, this.up).normalize();

      // --- steering & drift
      let vf = this.vel.dot(this.fwd);
      const spd = Math.abs(vf);
      const steer = input.steer;
      const brakeTap = input.brake > 0 && this.prevBrake <= 0;
      if (!this.drifting) {
        const fast = spd > st.topSpeed * st.driftThreshold && input.throttle > 0;
        this.steerHold = Math.abs(steer) > 0.85 && fast ? this.steerHold + dt : 0;
        if ((Math.abs(steer) > 0.4 && spd > 20 && (brakeTap || (input.brake > 0 && input.throttle > 0))) || this.steerHold > 0.35) {
          this.drifting = true;
          this.driftDir = Math.sign(steer);
          this.driftTime = 0;
          this.driftRelease = 0;
          this.events.push({ type: 'driftStart' });
        }
      } else {
        this.driftTime += dt;
        const counter = steer * this.driftDir < -0.3;
        this.driftRelease = Math.abs(steer) < 0.2 || counter ? this.driftRelease + dt : 0;
        if (spd < 14 || this.driftRelease > (counter ? 0.12 : 0.28)) this.endDrift();
      }

      const sign = vf >= -0.5 ? 1 : -1;
      const steerFactor = Math.min(1, spd / 7) * (1 - 0.42 * Math.min(1, spd / 85));
      let targetYaw: number;
      if (this.drifting) {
        const into = steer * this.driftDir; // -1..1
        targetYaw = -this.driftDir * (1.25 + 0.75 * into) * 1.15 * st.turn * steerFactor;
      } else {
        targetYaw = -steer * 1.9 * st.turn * steerFactor * sign;
      }
      this.yawRate += (targetYaw - this.yawRate) * (1 - Math.exp(-st.yawResponse * dt));
      rotateAround(this.fwd, this.up, this.yawRate * dt);
      this.right.crossVectors(this.fwd, this.up).normalize();

      // --- longitudinal
      vf = this.vel.dot(this.fwd);
      let vr = this.vel.dot(this.right);
      const top = st.topSpeed * (boosting ? 1 + 0.28 * this.boostPower : 1);
      if (input.throttle > 0) {
        const t = Math.max(0, Math.min(1.2, vf / st.topSpeed));
        let a = st.accel * Math.max(0, 1 - Math.pow(t, 2.2));
        a += st.turboLow * Math.max(0, 1 - t * 1.4);
        a += st.turboHigh * smoothstep(0.3, 0.75, t) * Math.max(0, 1 - Math.pow(t, 4));
        if (vf < 0) a += 20;
        vf += a * input.throttle * dt;
      }
      if (input.brake > 0) {
        if (vf > 1) {
          vf = Math.max(0, vf - (this.drifting ? 6 : 34) * input.brake * dt);
        } else if (input.throttle <= 0) {
          vf = Math.max(-17, vf - 11 * input.brake * dt);
        }
      }
      if (boosting) vf += 24 * this.boostPower * dt;
      // rolling + aero drag, and soft limiter above the current top speed
      const coast = input.throttle <= 0 && input.brake <= 0 ? 3 : 0.6;
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), (coast + 0.0009 * vf * vf) * dt);
      if (vf > top) vf -= (vf - top) * 2.2 * dt;

      // --- lateral grip
      const grip = this.drifting ? st.driftGrip : st.grip;
      const vrNew = vr * Math.exp(-grip * dt);
      if (this.drifting) vf += Math.abs(vr - vrNew) * 0.4;
      vr = vrNew;
      this.slip = Math.abs(vr);

      // slopes: gravity along the deck (the deck holds you on, so no normal part)
      const g = TMP.set(0, -GRAVITY, 0);
      g.addScaledVector(this.up, -g.dot(this.up));
      this.vel.copy(this.fwd).multiplyScalar(vf).addScaledVector(this.right, vr).addScaledVector(g, dt * 0.8);

      // --- rails
      const limit = HALF_WIDTH - CAR_HALF_WIDTH;
      if (Math.abs(q.lateral) > limit) {
        const side = Math.sign(q.lateral);
        this.pos.addScaledVector(q.right, -side * (Math.abs(q.lateral) - limit));
        const vn = this.vel.dot(q.right) * side;
        if (vn > 0) {
          this.vel.addScaledVector(q.right, -side * vn * 1.25);
          this.vel.multiplyScalar(1 - Math.min(0.25, vn * 0.01));
          // steer the nose back along the wall
          this.fwd.lerp(q.fwd, Math.min(1, vn * 0.02)).normalize();
          if (vn > 3) this.events.push({ type: 'wall', strength: Math.min(1, vn / 25) });
          if (this.drifting && vn > 8) this.endDrift(false);
        }
      }
      this.forwardSpeed = this.vel.dot(this.fwd);
      this.lateralSpeed = this.vel.dot(this.right);

      // suspension feel from accelerations
      const longAcc = (this.forwardSpeed - this.lastForward) / Math.max(dt, 1e-3);
      const latAcc = this.forwardSpeed * this.yawRate;
      this.spring(dt, -longAcc * 0.0028, -latAcc * 0.0035 * st.rollAmount, 0);
    } else {
      // --- airborne
      this.airTime += dt;
      this.vel.y -= GRAVITY * dt;
      const ctrl = st.airControl;
      rotateAround(this.fwd, this.up, -input.steer * 1.6 * ctrl * dt);
      this.right.crossVectors(this.fwd, this.up).normalize();
      const pitchIn = (input.brake - input.throttle) * 1.1 * ctrl * dt;
      rotateAround(this.fwd, this.right, pitchIn);
      rotateAround(this.up, this.right, pitchIn);
      // gently line up with the deck below for a clean landing
      const target = q.up;
      const k = 1 - Math.exp(-1.4 * ctrl * dt);
      const qa = new Quaternion().setFromUnitVectors(this.up, TMP2.copy(this.up).lerp(target, k).normalize());
      this.up.applyQuaternion(qa);
      this.fwd.applyQuaternion(qa);
      this.fwd.addScaledVector(this.up, -this.fwd.dot(this.up)).normalize();
      this.right.crossVectors(this.fwd, this.up).normalize();
      if (this.drifting && this.airTime > 0.6) this.endDrift(false);
      this.forwardSpeed = this.vel.dot(this.fwd);
      this.spring(dt, 0, 0, 0);
      const fell = (!overDeck || q.height < -3.5) && (q.height < -45 || Math.abs(q.lateral) > HALF_WIDTH + 70);
      if (fell) this.respawn();
    }
    this.lastForward = this.forwardSpeed;
    this.prevBrake = input.brake;

    this.pos.addScaledVector(this.vel, dt);
    this.updateQuat();

    // drivetrain for sound
    const spd = Math.abs(this.forwardSpeed);
    const gears = 6;
    const span = st.topSpeed / gears;
    const g = Math.min(gears - 1, Math.floor(spd / span));
    this.gear = g;
    const inGear = (spd - g * span) / span;
    const targetRpm = this.grounded ? (g === 0 ? 0.18 + inGear * 0.8 : 0.45 + inGear * 0.55) : Math.min(1, this.rpm + (input.throttle ? 0.5 : -0.3) * dt * 4);
    this.rpm += (Math.max(0.15, targetRpm) - this.rpm) * (1 - Math.exp(-12 * dt));
    this.wheelSpin += (this.forwardSpeed / 0.34) * dt;
    this.steerVisual += (input.steer * -0.45 - this.steerVisual) * (1 - Math.exp(-14 * dt));
  }

  private lastForward = 0;

  private spring(dt: number, pitchT: number, rollT: number, heaveT: number) {
    const k = 120;
    const d = 14;
    this.pitchVel += ((clamp(pitchT, -0.06, 0.06) - this.pitch) * k - this.pitchVel * d) * dt;
    this.rollVel += ((clamp(rollT, -0.07, 0.07) - this.roll) * k - this.rollVel * d) * dt;
    this.heaveVel += ((heaveT - this.heave) * k - this.heaveVel * d) * dt;
    this.pitch += this.pitchVel * dt;
    this.roll += this.rollVel * dt;
    this.heave += this.heaveVel * dt;
  }

  private land(normal: Vector3) {
    const into = -this.vel.dot(normal);
    const misalign = 1 - this.up.dot(normal);
    const loss = this.stats.landingLoss * Math.min(1, misalign * 4 + into / 40);
    this.vel.multiplyScalar(1 - loss);
    this.heaveVel -= Math.min(4, into * 0.12) * (1.2 - this.stats.landingLoss * 2);
    if (this.airTime > 0.25) this.events.push({ type: 'land', strength: Math.min(1, into / 25 + this.airTime * 0.2) });
  }

  private endDrift(reward = true) {
    if (reward && this.driftTime > 0.7) {
      const amount = Math.min(this.driftTime, 3.2) * 0.42 * this.stats.driftCharge;
      this.triggerBoost(amount, this.stats.boostPower * 0.85);
      this.events.push({ type: 'driftBoost', amount });
    }
    this.drifting = false;
    this.driftTime = 0;
    this.steerHold = 0;
  }

  respawn() {
    const n = this.track.samples.length;
    let i = (this.lastGroundIndex - 25 + n) % n;
    while (this.track.samples[i].gap) i = (i - 1 + n) % n;
    const fr = this.track.frameAt(i);
    this.pos.copy(fr.pos).addScaledVector(fr.up, 0.3);
    this.fwd.copy(fr.fwd);
    this.up.copy(fr.up);
    this.right.copy(fr.right);
    this.vel.copy(fr.fwd).multiplyScalar(28);
    this.trackIndex = i;
    this.grounded = true;
    this.drifting = false;
    this.airTime = 0;
    this.yawRate = 0;
    this.events.push({ type: 'respawn' });
  }

  private updateQuat() {
    // car space: +z forward, +y up, so x = up x fwd
    TMP.crossVectors(this.up, this.fwd).normalize();
    MAT.makeBasis(TMP, this.up, this.fwd);
    this.quat.setFromRotationMatrix(MAT);
  }

  /** Track query from the last step (for AI / race logic). */
  get lastQuery() {
    return this.q;
  }

  snapshotQuery() {
    return Object.assign(this.lastQ, this.q);
  }
}

const TMP = new Vector3();
const TMP2 = new Vector3();
const MAT = new Matrix4();
const QR = new Quaternion();

function rotateAround(v: Vector3, axis: Vector3, angle: number) {
  QR.setFromAxisAngle(axis, angle);
  v.applyQuaternion(QR);
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function smoothstep(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
