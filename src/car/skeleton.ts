import type { Section } from './loft';

/**
 * The invisible skeleton every car shares. Visual parts are generated to fit
 * these standard mounting points, which is what lets any combination work.
 *
 * Car space: +z forward, +y up, origin on the ground between the axles.
 */
export const SKELETON = {
  wheelRadius: 0.34,
  wheelWidth: 0.28,
  wheelX: 0.8,
  wheelY: 0.34,
  frontAxleZ: 1.32,
  rearAxleZ: -1.3,
  /** front and rear parts meet the body at these standard cross-sections */
  frontJointZ: 1.45,
  rearJointZ: -1.45,
  /** headlight mount (mirrored); z is found on the front part's surface */
  headlight: { x: 0.58, y: 0.56 },
  /** exhaust mount height; z is found on the rear part's surface */
  exhaustY: 0.36,
  /** spoiler mount; y is found on the rear deck */
  spoilerZ: -1.86,
  /** side skirts span between the wheel arches */
  skirtZ: [-0.9, 0.9] as const,
  skirtX: 0.8,
};

export const JOINT: Omit<Section, 'z'> = {
  yb: 0.26,
  wb: 0.62,
  ys: 0.68,
  ws: 0.96,
  yt: 0.84,
  wt: 0.84,
  crisp: 0.75,
};

export const joint = (z: number): Section => ({ ...JOINT, z });
