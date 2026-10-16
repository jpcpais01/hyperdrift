import type { SegmentDef } from './track';

/**
 * "Skyway Prime": the demo track. A ~4.5 km lap suspended above the cloud sea:
 * a suspension bridge climbing to a crest, a boosted sky dive, a steeply banked
 * hairpin around a waterfall island, two jumps, the loop, a climbing helix that
 * spirals around a crystal spire and passes over its own entry, a corkscrew
 * light tunnel and a sweeping run home.
 *
 * Headings add up to exactly 720 degrees (the helix is the extra turn); the
 * closure straights and the sweeper's climb were solved with scripts/solve.ts
 * so the lap meets itself, and scripts/trackcheck.ts keeps every part of the
 * lap clear of every other (the helix passes ~35 m over its own entry).
 */
export const SKYWAY: SegmentDef[] & { heading?: number } = [
  // start / finish straight
  { len: 208, mark: 'start' },
  // T1: fast right kink
  { len: 150, yaw: -38, bank: 10 },
  { len: 83, bank: 0 },
  // the suspension bridge, climbing towards the crest
  { len: 320, pitch: 5, bridge: true, mark: 'bridge' },
  { len: 70, pitch: 0 },
  // sky dive: a steep plunge lined with boost pads
  { len: 60, pitch: -13 },
  { len: 100, boost: true, mark: 'dive' },
  { len: 70, pitch: 0 },
  // cathedral hairpin: 180 degrees, steeply banked, around the waterfall island
  { len: 60, yaw: 10, bank: -24 },
  { len: 250, yaw: 160, bank: -34, mark: 'hairpin' },
  { len: 60, yaw: 10, bank: 0, pickups: true },
  // jump 1
  { len: 100, boost: true },
  { len: 55, pitch: 12 },
  { len: 34, pitch: -6, gap: true, mark: 'jump1' },
  { len: 70, pitch: -12 },
  { len: 60, pitch: 0 },
  // esses
  { len: 110, yaw: -42, bank: 13, pickups: true, mark: 'esses' },
  { len: 110, yaw: 42, bank: -13 },
  { len: 50, bank: 0 },
  // loop
  { len: 80, boost: true },
  { len: 176, pitchSpin: 360, shift: 22, loop: true, mark: 'loop' },
  { len: 180, pickups: true },
  // the helix: a full climbing turn around the crystal spire, passing over its own entry
  { len: 70, yaw: 40, pitch: 5, bank: -20 },
  { len: 420, yaw: 280, bank: -24, mark: 'helix' },
  { len: 70, yaw: 40, pitch: 0, bank: 0 },
  // corkscrew light tunnel (closure straight A)
  { len: 61 },
  { len: 40, tunnel: true },
  { len: 230, bank: 360, tunnel: true, mark: 'tunnel' },
  { len: 40, tunnel: true },
  { len: 130, boost: true },
  { len: 230, yaw: 112, pitch: 0.8, bank: -18, mark: 'sweeper' },
  { len: 30, pitch: 0, bank: 0 },
  // downhill boost run into the mega jump (closure straight B)
  { len: 95, pitch: -2, boost: true },
  { len: 60, pitch: 18 },
  { len: 52, pitch: -10, gap: true, mark: 'mega' },
  { len: 90, pitch: -14 },
  { len: 50, pitch: 0, pickups: true },
  // final sweeper back home
  { len: 230, yaw: 106, pitch: 0, bank: -14 },
  { len: 37, bank: 0 },
  { len: 120 },
];
// Turned so the long run through the jump, loop and light tunnel has the low sun
// off to the side instead of dead ahead, and the run home has it behind.
SKYWAY.heading = 70;
