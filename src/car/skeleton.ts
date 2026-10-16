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
  wheelX: 0.85,
  wheelY: 0.34,
  frontAxleZ: 1.32,
  rearAxleZ: -1.3,
  /** front and rear parts meet the body at these standard cross-sections */
  frontJointZ: 1.45,
  rearJointZ: -1.45,
  /** how far the drawn wheels may move up into the arches / drop out of them */
  travelUp: 0.05,
  travelDown: 0.08,
  /** exhaust mount height; z is found on the rear part's surface */
  exhaustY: 0.36,
  /** spoiler mount; y is found on the rear deck */
  spoilerZ: -1.86,
  /** side skirts span between the wheel arches */
  skirtZ: [-0.9, 0.9] as const,
  skirtX: 0.8,
};

/**
 * Every body defines its own two joint sections; front and rear parts are
 * described relative to the joint they attach to, so any nose or tail grows
 * out of any body without a step.
 */
export const DEFAULT_FRONT_JOINT: Omit<Section, 'z'> = { yb: 0.26, wb: 0.62, ys: 0.645, ws: 0.965, yt: 0.81, wt: 0.79, yc: 0.745, crisp: 0.75 };
export const DEFAULT_REAR_JOINT: Omit<Section, 'z'> = { yb: 0.27, wb: 0.62, ys: 0.69, ws: 0.98, yt: 0.87, wt: 0.8, yc: 0.85, crisp: 0.75 };
