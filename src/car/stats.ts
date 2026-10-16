import { TECH_SLOTS, techById, type CarBuild } from './parts';

/** Everything the physics needs to know about a car, derived only from its technical parts. */
export interface CarStats {
  topSpeed: number; // m/s
  accel: number; // m/s^2 at low speed
  turboLow: number;
  turboHigh: number;
  boostPower: number;
  boostDuration: number;
  driftCharge: number;
  grip: number;
  driftGrip: number;
  turn: number;
  driftThreshold: number;
  yawResponse: number;
  airControl: number;
  landingLoss: number;
  mass: number;
  rollAmount: number;
  voice: 'v6' | 'rotary' | 'v12';
  whistle: number;
}

export function computeStats(build: CarBuild): CarStats {
  const s: CarStats = {
    topSpeed: 70,
    accel: 15,
    turboLow: 0,
    turboHigh: 0,
    boostPower: 1,
    boostDuration: 1,
    driftCharge: 1,
    grip: 10,
    driftGrip: 2.4,
    turn: 1,
    driftThreshold: 0.72,
    yawResponse: 8,
    airControl: 1,
    landingLoss: 0.12,
    mass: 1300,
    rollAmount: 1,
    voice: 'v6',
    whistle: 0,
  };
  let accelMul = 1;
  let topMul = 1;
  let gripMul = 1;
  let driftChargeMul = 1;
  let topAdd = 0;
  for (const { slot } of TECH_SLOTS) {
    const m = techById(slot, build[slot]).mods;
    if (m.topSpeed !== undefined) {
      if (slot === 'engine') s.topSpeed = m.topSpeed;
      else topAdd += m.topSpeed;
    }
    if (m.accel !== undefined) s.accel = m.accel;
    if (m.accelMul) accelMul *= m.accelMul;
    if (m.topMul) topMul *= m.topMul;
    if (m.gripMul) gripMul *= m.gripMul;
    if (m.turboLow) s.turboLow += m.turboLow;
    if (m.turboHigh) s.turboHigh += m.turboHigh;
    if (m.boostPower !== undefined) s.boostPower = m.boostPower;
    if (m.boostDuration !== undefined) s.boostDuration = m.boostDuration;
    if (m.driftCharge) driftChargeMul *= m.driftCharge;
    if (m.grip !== undefined) s.grip = m.grip;
    if (m.driftGrip !== undefined) s.driftGrip = m.driftGrip;
    if (m.turn !== undefined) s.turn = m.turn;
    if (m.driftThreshold !== undefined) s.driftThreshold = m.driftThreshold;
    if (m.yawResponse !== undefined) s.yawResponse = m.yawResponse;
    if (m.airControl !== undefined) s.airControl = m.airControl;
    if (m.landingLoss !== undefined) s.landingLoss = m.landingLoss;
    if (m.mass !== undefined) s.mass = m.mass;
    if (m.rollAmount !== undefined) s.rollAmount = m.rollAmount;
    if (m.voice) s.voice = m.voice;
    if (m.whistle) s.whistle = Math.max(s.whistle, m.whistle);
  }
  s.topSpeed = (s.topSpeed + topAdd) * topMul;
  s.accel *= accelMul;
  s.turboLow *= accelMul;
  s.turboHigh *= accelMul;
  s.grip *= gripMul;
  s.driftCharge = driftChargeMul;
  return s;
}

/** 0..10 bars shown in the garage. */
export interface DisplayStats {
  speed: number;
  accel: number;
  grip: number;
  boost: number;
}

const clamp10 = (v: number) => Math.max(0.5, Math.min(10, v));

export function displayStats(s: CarStats): DisplayStats {
  const effAccel = s.accel + s.turboLow * 0.7 + s.turboHigh * 0.5;
  return {
    speed: clamp10(((s.topSpeed - 62) / 22) * 10),
    accel: clamp10(((effAccel - 11) / 10) * 10),
    grip: clamp10((((s.grip - 6) / 10) * 0.7 + ((s.yawResponse - 5) / 7) * 0.3) * 10),
    boost: clamp10(((s.boostPower * s.boostDuration * (0.6 + 0.4 * s.driftCharge) - 0.6) / 1.6) * 10),
  };
}
