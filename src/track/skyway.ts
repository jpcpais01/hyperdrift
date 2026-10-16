import type { SegmentDef } from './track';

/**
 * "Skyway Prime": the demo track. A lap of ~3.6 km suspended above the clouds
 * with two jumps, a corkscrew light tunnel, a loop and boost zones.
 * Headings close to exactly 360 degrees; the two "closure" straights were
 * solved with scripts/solve.ts so the lap meets itself.
 */
/** the corkscrew rolls round the tunnel's axis, this high above the deck */
const HEARTLINE = 16;

export const SKYWAY: SegmentDef[] = [
  { len: 150 },
  { len: 130, yaw: -40, bank: 10, pickups: true },
  { len: 50, bank: 0 },
  { len: 90, pitch: -3 },
  { len: 260, yaw: 130, pitch: 0, bank: -16 },
  { len: 50, bank: 0 },
  { len: 140, boost: true },
  // jump 1
  { len: 55, pitch: 12 },
  { len: 34, pitch: -6, gap: true },
  { len: 70, pitch: -12 },
  { len: 60, pitch: 0 },
  // chicane
  { len: 110, yaw: 38, bank: -12, pickups: true },
  { len: 110, yaw: -38, bank: 12 },
  { len: 50, bank: 0 },
  // loop
  { len: 80, boost: true },
  { len: 176, pitchSpin: 360, shift: 22, loop: true },
  { len: 80, pickups: true },
  // turn towards the light tunnel
  { len: 190, yaw: 90, bank: -20 },
  { len: 50, bank: 0 },
  // corkscrew light tunnel (closure straight A)
  { len: 40, tunnel: true, heartline: HEARTLINE },
  { len: 230, bank: 360, tunnel: true, heartline: HEARTLINE },
  { len: 40, tunnel: true, heartline: HEARTLINE },
  { len: 208, boost: true },
  { len: 210, yaw: 90, pitch: -4, bank: -18 },
  { len: 50, pitch: 0, bank: 0 },
  // downhill boost run into the mega jump (closure straight B)
  { len: 140, pitch: -2, boost: true },
  { len: 60, pitch: 18 },
  { len: 52, pitch: -10, gap: true },
  { len: 90, pitch: -14 },
  { len: 70, pitch: 0 },
  { len: 160, pitch: 7, pickups: true },
  // final sweeper back home
  { len: 230, yaw: 90, pitch: 0, bank: -14 },
  { len: 60, bank: 0 },
  { len: 100 },
];
