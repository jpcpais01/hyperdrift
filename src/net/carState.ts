import { Quaternion, Vector3 } from 'three';
import type { CarPhysics, DriveInput } from '../game/carPhysics';

/**
 * A car on the wire: a flat array of rounded numbers (~30 values, ~200 bytes
 * of JSON), sent 20 times a second by whoever owns the car.
 */
export interface CarSnapshot {
  /** sender's race clock, seconds since the green light */
  rt: number;
  pos: Vector3;
  vel: Vector3;
  quat: Quaternion;
  yawRate: number;
  spin: number;
  input: DriveInput;
  nitro: number;
  boostTime: number;
  boostPower: number;
  grounded: boolean;
  drifting: boolean;
  driftDir: number;
  driftTime: number;
  trackIndex: number;
  lap: number;
  finished: boolean;
  finishTime: number;
  bestLap: number | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function packCar(
  p: CarPhysics,
  input: DriveInput,
  race: { rt: number; lap: number; finished: boolean; finishTime: number; bestLap: number | null },
): number[] {
  const flags = (p.grounded ? 1 : 0) | (p.drifting ? 2 : 0) | (race.finished ? 4 : 0);
  return [
    r3(race.rt),
    r3(p.pos.x), r3(p.pos.y), r3(p.pos.z),
    r2(p.vel.x), r2(p.vel.y), r2(p.vel.z),
    r4(p.quat.x), r4(p.quat.y), r4(p.quat.z), r4(p.quat.w),
    r3(p.yawRate), r3(p.spin),
    r2(input.throttle), r2(input.brake), r2(input.steer), input.nitro && input.nitro > 0.5 ? 1 : 0,
    r3(p.nitro), r3(p.boostTime), r2(p.boostPower),
    flags, p.driftDir, r2(p.driftTime),
    p.trackIndex, race.lap, r3(race.finishTime), race.bestLap === null ? -1 : r3(race.bestLap),
  ];
}

const FIELDS = 27;

export function unpackCar(d: unknown, out?: CarSnapshot): CarSnapshot | null {
  if (!Array.isArray(d) || d.length < FIELDS) return null;
  for (let i = 0; i < FIELDS; i++) if (typeof d[i] !== 'number' || !isFinite(d[i])) return null;
  const a = d as number[];
  const s: CarSnapshot = out ?? {
    rt: 0,
    pos: new Vector3(),
    vel: new Vector3(),
    quat: new Quaternion(),
    yawRate: 0,
    spin: 0,
    input: { throttle: 0, brake: 0, steer: 0, nitro: 0 },
    nitro: 0,
    boostTime: 0,
    boostPower: 0,
    grounded: true,
    drifting: false,
    driftDir: 0,
    driftTime: 0,
    trackIndex: 0,
    lap: 0,
    finished: false,
    finishTime: 0,
    bestLap: null,
  };
  s.rt = a[0];
  s.pos.set(a[1], a[2], a[3]);
  s.vel.set(a[4], a[5], a[6]);
  s.quat.set(a[7], a[8], a[9], a[10]).normalize();
  s.yawRate = a[11];
  s.spin = a[12];
  s.input = { throttle: a[13], brake: a[14], steer: a[15], nitro: a[16] };
  s.nitro = a[17];
  s.boostTime = a[18];
  s.boostPower = a[19];
  s.grounded = (a[20] & 1) !== 0;
  s.drifting = (a[20] & 2) !== 0;
  s.finished = (a[20] & 4) !== 0;
  s.driftDir = a[21];
  s.driftTime = a[22];
  s.trackIndex = Math.max(0, Math.floor(a[23]));
  s.lap = a[24];
  s.finishTime = a[25];
  s.bestLap = a[26] < 0 ? null : a[26];
  return s;
}

const Z = new Vector3(0, 0, 1);
const Y = new Vector3(0, 1, 0);

/** Put a locally simulated copy of someone else's car exactly where its owner says it was. */
export function applyCar(p: CarPhysics, s: CarSnapshot, trackSamples: number) {
  p.pos.copy(s.pos);
  p.vel.copy(s.vel);
  p.quat.copy(s.quat);
  p.fwd.copy(Z).applyQuaternion(s.quat);
  p.up.copy(Y).applyQuaternion(s.quat);
  p.right.crossVectors(p.fwd, p.up).normalize();
  p.yawRate = s.yawRate;
  p.spin = s.spin;
  p.nitro = s.nitro;
  p.boostTime = s.boostTime;
  p.boostPower = s.boostPower;
  p.grounded = s.grounded;
  p.drifting = s.drifting;
  p.driftDir = s.driftDir;
  p.driftTime = s.driftTime;
  if (s.trackIndex < trackSamples) {
    p.trackIndex = s.trackIndex;
    if (s.grounded) p.lastGroundIndex = s.trackIndex;
  }
}
