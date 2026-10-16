import { Color, Vector3 } from 'three';
import type { CarVisual } from '../car/carBuilder';
import type { Particles } from '../world/particles';
import type { CarContact } from './carCollision';
import type { CarPhysics } from './carPhysics';

/**
 * Particle effects every car makes, shared by races and free roam:
 * tyre smoke and drift sparks, boost embers and nitro sparks, exhaust pops,
 * nitro ignition and sparks from car-to-car contact.
 */

export const SMOKE = new Color(0.9, 0.9, 0.95);
export const SPARK = new Color(1.6, 0.9, 0.3);
export const SPARK_HOT = new Color(0.6, 1.6, 3.0);
export const EMBER = new Color(0.9, 0.45, 0.15);
export const NITRO_SPARK = new Color(0.35, 0.9, 2.6);
export const NITRO_WHITE = new Color(2.2, 2.4, 2.8);

const TMP = new Vector3();
const TMP2 = new Vector3();
const TMP3 = new Vector3();

/** Smoke while sliding, drift-charge sparks, boost embers and nitro sparks (call every frame). */
export function emitDriveFx(parts: Particles, p: CarPhysics, visual: CarVisual) {
  if (p.grounded && (p.drifting || p.slip > 6) && p.speed > 10) {
    for (const side of [-1, 1]) {
      const wp = TMP.copy(p.pos).addScaledVector(p.fwd, -1.3).addScaledVector(p.right, side * 0.85).addScaledVector(p.up, 0.25);
      const v = TMP2.copy(p.up).multiplyScalar(1.5).addScaledVector(p.vel, 0.25);
      parts.emit(wp, v, SMOKE, 0.12, 0.7, 0.9, 2.5, 1.5);
    }
    if (p.drifting && p.driftTime > 0.7) {
      const charge = Math.min(1, p.driftTime / 3);
      const col = charge > 0.6 ? SPARK_HOT : SPARK;
      const wp = TMP.copy(p.pos).addScaledVector(p.fwd, -1.3).addScaledVector(p.right, -p.driftDir * 0.85).addScaledVector(p.up, 0.1);
      parts.emit(wp, TMP2.set((Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4).addScaledVector(p.vel, 0.6), col, 1, 0.12, 0.35, 0, 1);
    }
  }
  if (p.boostFx > 0.3 && visual.exhaustTips.length) {
    const nitro = p.nitroFx > 0.3;
    const tips = visual.exhaustTips.length;
    // nitro sheds bright blue sparks; a plain boost a few embers
    const n = nitro ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const wp = visual.tipWorld(Math.floor(Math.random() * tips), TMP);
      const v = TMP2.copy(p.vel)
        .multiplyScalar(0.75)
        .addScaledVector(p.fwd, -(nitro ? 10 : 6) - Math.random() * 6)
        .addScaledVector(p.up, (Math.random() - 0.3) * 2)
        .addScaledVector(p.right, (Math.random() - 0.5) * 2.5);
      parts.emit(wp, v, nitro ? (Math.random() < 0.3 ? NITRO_WHITE : NITRO_SPARK) : EMBER, (nitro ? 0.9 : 0.5) * p.boostFx, nitro ? 0.1 : 0.14, nitro ? 0.28 : 0.2, -0.2, 2.5);
    }
  }
}

/** Sparks out of an exhaust tip on a big backfire. */
export function emitPopFx(parts: Particles, p: CarPhysics, visual: CarVisual, strength: number) {
  if (strength <= 0.6 || !visual.exhaustTips.length) return;
  const wp = visual.tipWorld(Math.floor(Math.random() * visual.exhaustTips.length), TMP);
  for (let k = 0; k < 3; k++) {
    parts.emit(wp, TMP2.copy(p.vel).addScaledVector(p.fwd, -4 - Math.random() * 4).addScaledVector(p.up, Math.random() * 2), SPARK, 0.9, 0.08, 0.25, 0, 2);
  }
}

/** The burst of blue sparks when the nitro lights. */
export function emitNitroFx(parts: Particles, p: CarPhysics, visual: CarVisual) {
  const tips = visual.exhaustTips.length;
  for (let k = 0; k < 12 && tips; k++) {
    const wp = visual.tipWorld(k, TMP);
    const v = TMP2.set((Math.random() - 0.5) * 5, (Math.random() - 0.2) * 4, (Math.random() - 0.5) * 5).addScaledVector(p.vel, 0.8).addScaledVector(p.fwd, -8);
    parts.emit(wp, v, k % 3 ? NITRO_SPARK : NITRO_WHITE, 1, 0.16, 0.35, 0.4, 2);
  }
}

/** Sparks flying out of a car-to-car contact, carried along by both cars. */
export function emitContactFx(parts: Particles, ct: CarContact) {
  const hard = Math.min(1, ct.impulse / 14);
  const n = Math.min(14, Math.round(ct.impulse * 0.9 + ct.scrape * 0.15));
  const carry = TMP3.copy(ct.a.vel).add(ct.b.vel).multiplyScalar(0.5);
  for (let k = 0; k < n; k++) {
    const out = Math.random() < 0.5 ? 1 : -1;
    const v = TMP2.set((Math.random() - 0.5) * 7, 1.5 + Math.random() * 5, (Math.random() - 0.5) * 7)
      .addScaledVector(ct.normal, out * (2 + ct.impulse * 0.4))
      .add(carry);
    parts.emit(TMP.copy(ct.point).addScaledVector(ct.a.up, 0.45 + Math.random() * 0.3), v, k % 3 ? SPARK : SPARK_HOT, 1, 0.1 + 0.06 * hard, 0.25 + 0.3 * Math.random(), 0, 1.4);
  }
}

/** Sparks off the bodywork scraping a wall or obstacle. */
export function emitWallFx(parts: Particles, p: CarPhysics, side: Vector3) {
  for (let k = 0; k < 8; k++) {
    const wp = TMP.copy(p.pos).add(side).addScaledVector(p.up, 0.4);
    parts.emit(wp, TMP2.set((Math.random() - 0.5) * 6, Math.random() * 6, (Math.random() - 0.5) * 6).addScaledVector(p.vel, 0.8), SPARK_HOT, 1, 0.12, 0.4, 0, 1);
  }
}

/** Visual pose of a car from its physics: body, suspension, wheels, brake lights, exhaust flames. */
export function poseCar(p: CarPhysics, v: CarVisual, brake: number, dt: number, fxTime: number) {
  v.root.position.copy(p.draw.pos);
  v.root.quaternion.copy(p.draw.quat);
  v.body.rotation.set(p.pitch, 0, p.roll);
  v.body.position.y = p.heave * 0.5;
  const counter = p.drifting ? p.driftDir * 0.35 : 0;
  v.updateWheels({
    steer: p.steerVisual + counter,
    spin: p.wheelSpin,
    travel: [p.heave * 0.4 - p.roll * 0.6, p.heave * 0.4 + p.roll * 0.6, p.heave * 0.4 - p.roll * 0.6, p.heave * 0.4 + p.roll * 0.6].map((x) => Math.max(-0.08, Math.min(0.08, x))),
  });
  v.materials.setBrake(brake > 0 && p.forwardSpeed > 1 ? 1 : 0);
  v.exhaust?.update(dt, fxTime, Math.max(0, p.boostFx - p.nitroFx), p.nitroFx);
}
