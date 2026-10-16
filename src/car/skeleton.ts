import type { Section } from './loft';

/**
 * The invisible skeleton of a car. Every body has its own (wheelbase, track,
 * wheel sizes, ride height, overhangs); every other part is generated against
 * the skeleton of the body it is fitted to, which is what lets any
 * combination work while the bodies stay truly different in shape.
 *
 * Car space: +z forward, +y up, origin on the ground between the axles.
 */
export interface Axle {
  /** axle position along the car */
  z: number;
  /** tyre radius; the wheel centre sits at y = r */
  r: number;
  /** tyre width */
  width: number;
  /** half track: x of the wheel's centre plane */
  x: number;
  /** wheel-arch opening radius (tyre plus drawn travel plus the body's gap) */
  arch: number;
}

export interface Skeleton {
  front: Axle;
  rear: Axle;
  /** rim radius as a share of the tyre radius: rally tyres get more sidewall */
  rimShare: number;
  /** front and rear parts meet the body at these cross-sections */
  frontJointZ: number;
  rearJointZ: number;
  /** nose and tail parts stretch along the car by these factors (1 = the base car's overhangs) */
  noseScale: number;
  tailScale: number;
  /** body height against the base car: bumpers, splitters, skirts and floor details move with it */
  lift: number;
  /** x of the wheel-well wall (inside the tyre's inner face even at full lock) */
  wellX: number;
  /** side skirts span between the arches */
  skirtZ: [number, number];
  /** spoiler mount along the car; its height is found on the rear deck */
  spoilerZ: number;
  /** exhaust mount height; z is found on the tail's surface */
  exhaustY: number;
}

/** How far the drawn wheels may move up into the arches / drop out of them. */
export const TRAVEL = { up: 0.05, down: 0.08 };

/** The base car every catalogue constant was first drawn against. */
export const BASE = { jointF: 1.45, jointR: -1.45, floor: 0.26, width: 0.965 };

interface AxleSpec {
  z: number;
  r: number;
  width: number;
  x: number;
  /** clearance between the tyre at full bump and the arch */
  gap?: number;
}

function axle(a: AxleSpec): Axle {
  return { z: a.z, r: a.r, width: a.width, x: a.x, arch: a.r + TRAVEL.up + (a.gap ?? 0.015) };
}

interface SkeletonSpec {
  front: AxleSpec;
  rear: AxleSpec;
  rimShare?: number;
  noseScale?: number;
  tailScale?: number;
  /** body floor height at the joints (the base car's is 0.26) */
  floor?: number;
}

function skeleton(s: SkeletonSpec): Skeleton {
  const front = axle(s.front);
  const rear = axle(s.rear);
  const noseScale = s.noseScale ?? 1;
  const tailScale = s.tailScale ?? 1;
  const frontJointZ = front.z + 0.13;
  const rearJointZ = rear.z - 0.15;
  const lift = (s.floor ?? BASE.floor) - BASE.floor;
  const inner = Math.min(front.x - front.width / 2, rear.x - rear.width / 2);
  return {
    front,
    rear,
    rimShare: s.rimShare ?? 0.77,
    frontJointZ,
    rearJointZ,
    noseScale,
    tailScale,
    lift,
    wellX: inner - 0.21,
    skirtZ: [rear.z + rear.r + TRAVEL.up + 0.015, front.z - front.r - TRAVEL.up - 0.015],
    spoilerZ: rearJointZ - 0.41 * tailScale,
    exhaustY: 0.36 + lift,
  };
}

const SKELETONS: Record<string, Skeleton> = {
  // front-engine grand tourer: the base car
  gt: skeleton({ front: { z: 1.32, r: 0.34, width: 0.28, x: 0.85 }, rear: { z: -1.3, r: 0.34, width: 0.28, x: 0.85 } }),
  // long, wide muscle fastback on fat tyres
  fastback: skeleton({
    front: { z: 1.4, r: 0.345, width: 0.29, x: 0.875 },
    rear: { z: -1.38, r: 0.355, width: 0.32, x: 0.885 },
    noseScale: 1.06,
    tailScale: 0.98,
  }),
  // mid-engine hyper car: staggered wheels, short nose, long tail
  wedge: skeleton({
    front: { z: 1.3, r: 0.33, width: 0.27, x: 0.85 },
    rear: { z: -1.34, r: 0.36, width: 0.34, x: 0.9 },
    noseScale: 0.94,
    tailScale: 1.06,
    floor: 0.25,
  }),
  // compact hot hatch: short wheelbase, short overhangs, narrow track
  hatch: skeleton({
    front: { z: 1.2, r: 0.32, width: 0.26, x: 0.8 },
    rear: { z: -1.16, r: 0.32, width: 0.26, x: 0.8 },
    noseScale: 0.84,
    tailScale: 0.72,
    floor: 0.27,
  }),
  // lifted rally raid coupé on chunky tall-sidewall tyres
  rally: skeleton({
    front: { z: 1.26, r: 0.4, width: 0.3, x: 0.86, gap: 0.06 },
    rear: { z: -1.22, r: 0.4, width: 0.3, x: 0.86, gap: 0.06 },
    rimShare: 0.6,
    noseScale: 0.9,
    tailScale: 0.84,
    floor: 0.42,
  }),
  // endurance prototype: very long and wide, low tub between tall wheel pods
  proto: skeleton({
    front: { z: 1.42, r: 0.335, width: 0.3, x: 0.88 },
    rear: { z: -1.44, r: 0.35, width: 0.35, x: 0.89 },
    noseScale: 1.0,
    tailScale: 0.96,
    floor: 0.24,
  }),
};

export function skeletonFor(bodyId: string): Skeleton {
  return SKELETONS[bodyId] ?? SKELETONS.gt;
}

/**
 * Default joint shapes (reference only: each body defines its own). Front and
 * rear parts are described relative to the joint they attach to, so any nose
 * or tail grows out of any body without a step.
 */
export const DEFAULT_FRONT_JOINT: Omit<Section, 'z'> = { yb: 0.26, wb: 0.62, ys: 0.645, ws: 0.965, yt: 0.81, wt: 0.79, yc: 0.745, crisp: 0.75 };
export const DEFAULT_REAR_JOINT: Omit<Section, 'z'> = { yb: 0.27, wb: 0.62, ys: 0.69, ws: 0.98, yt: 0.87, wt: 0.8, yc: 0.85, crisp: 0.75 };
