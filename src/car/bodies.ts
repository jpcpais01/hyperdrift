import type { Section } from './loft';
import { BASE, skeletonFor, type Skeleton } from './skeleton';

/**
 * The section catalogue. A body owns its skeleton (wheelbase, track, wheels,
 * ride height), the middle of the car (doors, cabin, haunches) and its two
 * joint sections; every nose and tail is written relative to the joint it
 * grows out of and stretched by the body's overhangs, so any combination is
 * one smooth skin with the character of each part kept.
 */

export interface CabinKey {
  z: number;
  /** roof height */
  roof: number;
  /** half width of the glasshouse at the belt and at the roof */
  beltW: number;
  roofW: number;
}

export interface BodySculpt {
  /** extra fender width over the front and rear wheels */
  flareF: number;
  flareR: number;
  /** a scoop pressed into the flank ahead of the rear wheel (mid-engine intakes) */
  intake?: { z0: number; z1: number; y0: number; y1: number; depth: number };
  /** a sharp crease along the flank: height at the front and rear, how proud it stands */
  crease?: { yF: number; yR: number; amount: number };
}

export interface BodyFeatures {
  /** raked gills behind the front wheels */
  gills?: boolean;
  /** engine-cover louvres between the rear glass and the tail */
  louvres?: boolean;
  /** a grille deep in the flank scoop */
  intake?: boolean;
  /** black plastic arch and sill cladding */
  cladding?: boolean;
  /** roof rails */
  rails?: boolean;
  /** a wiper on the rear glass */
  rearWiper?: boolean;
  /** a stability fin running from the roof down the engine cover */
  fin?: boolean;
  /** extractor louvres on top of the front wheel pods */
  podVents?: boolean;
}

export interface BodyInfo {
  skeleton: Skeleton;
  /** sections strictly between the joints */
  hull: Section[];
  frontJoint: Section;
  rearJoint: Section;
  cabin: CabinKey[];
  /** how boxy the glasshouse is (0 = bubble, 1 = upright slab) */
  cabinCrisp: number;
  sculpt: BodySculpt;
  /** body-specific trim */
  features: BodyFeatures;
}

type Sec = Omit<Section, 'z'>;
const at = (z: number, s: Sec): Section => ({ ...s, z });
const S = (z: number, yb: number, wb: number, ys: number, ws: number, yt: number, wt: number, yc: number, crisp: number): Section => ({ z, yb, wb, ys, ws, yt, wt, yc, crisp });

export function bodySections(id: string): BodyInfo {
  const K = skeletonFor(id);
  const joints = (F: Sec, R: Sec) => ({ frontJoint: at(K.frontJointZ, F), rearJoint: at(K.rearJointZ, R) });
  switch (id) {
    case 'fastback': {
      // long, wide muscle coupé: tall slab sides under a sharp shoulder, a long high hood and a fastback roof that runs to the tail
      return {
        skeleton: K,
        ...joints({ yb: 0.27, wb: 0.64, ys: 0.72, ws: 1.0, yt: 0.89, wt: 0.86, yc: 0.875, crisp: 0.9 }, { yb: 0.28, wb: 0.64, ys: 0.75, ws: 1.02, yt: 0.95, wt: 0.84, yc: 0.94, crisp: 0.9 }),
        hull: [
          S(-1.12, 0.26, 0.66, 0.76, 1.06, 0.97, 0.86, 0.955, 0.9),
          S(-0.5, 0.25, 0.66, 0.72, 0.985, 0.925, 0.86, 0.915, 0.9),
          S(0.4, 0.25, 0.66, 0.71, 0.975, 0.9, 0.86, 0.89, 0.9),
          S(1.12, 0.26, 0.65, 0.71, 1.0, 0.895, 0.86, 0.88, 0.9),
        ],
        cabin: [
          { z: 0.36, roof: 0.92, beltW: 0.82, roofW: 0.7 },
          { z: 0.06, roof: 1.14, beltW: 0.82, roofW: 0.66 },
          { z: -0.26, roof: 1.21, beltW: 0.81, roofW: 0.64 },
          { z: -0.66, roof: 1.17, beltW: 0.81, roofW: 0.64 },
          { z: -1.12, roof: 1.07, beltW: 0.8, roofW: 0.67 },
          { z: -1.5, roof: 1.0, beltW: 0.78, roofW: 0.7 },
        ],
        cabinCrisp: 0.7,
        sculpt: { flareF: 0.04, flareR: 0.07, crease: { yF: 0.76, yR: 0.8, amount: 0.02 }, intake: { z0: -0.94, z1: -0.6, y0: 0.55, y1: 0.7, depth: 0.03 } },
        features: { intake: true },
      };
    }
    case 'wedge': {
      // mid-engine hyper car: a true wedge from a knife-low nose to tall haunches, the cabin pushed far forward, flank intakes
      return {
        skeleton: K,
        ...joints({ yb: 0.25, wb: 0.62, ys: 0.5, ws: 0.95, yt: 0.79, wt: 0.8, yc: 0.575, crisp: 0.9 }, { yb: 0.28, wb: 0.64, ys: 0.68, ws: 1.05, yt: 0.96, wt: 0.82, yc: 0.93, crisp: 0.9 }),
        hull: [
          S(-1.06, 0.25, 0.66, 0.7, 1.07, 0.97, 0.84, 0.935, 0.92),
          S(-0.35, 0.24, 0.65, 0.63, 0.95, 0.89, 0.8, 0.87, 0.92),
          S(0.45, 0.24, 0.64, 0.555, 0.935, 0.81, 0.8, 0.72, 0.9),
          S(1.04, 0.25, 0.63, 0.51, 0.96, 0.8, 0.8, 0.6, 0.9),
        ],
        cabin: [
          { z: 1.14, roof: 0.7, beltW: 0.8, roofW: 0.7 },
          { z: 0.72, roof: 0.95, beltW: 0.8, roofW: 0.6 },
          { z: 0.36, roof: 1.05, beltW: 0.78, roofW: 0.59 },
          { z: -0.26, roof: 1.06, beltW: 0.77, roofW: 0.56 },
          { z: -0.66, roof: 0.99, beltW: 0.75, roofW: 0.58 },
          { z: -0.96, roof: 0.95, beltW: 0.72, roofW: 0.62 },
        ],
        cabinCrisp: 0.45,
        sculpt: {
          flareF: 0.065,
          flareR: 0.11,
          intake: { z0: -0.98, z1: -0.3, y0: 0.42, y1: 0.72, depth: 0.085 },
          crease: { yF: 0.53, yR: 0.75, amount: 0.014 },
        },
        features: { louvres: true, intake: true },
      };
    }
    case 'hatch': {
      // compact hot hatch: tall and upright, a short hood, a long flat roof chopped off by a near-vertical tailgate
      return {
        skeleton: K,
        ...joints({ yb: 0.27, wb: 0.6, ys: 0.71, ws: 0.9, yt: 0.9, wt: 0.8, yc: 0.885, crisp: 0.74 }, { yb: 0.3, wb: 0.6, ys: 0.77, ws: 0.92, yt: 0.985, wt: 0.82, yc: 0.98, crisp: 0.8 }),
        hull: [
          S(-1.0, 0.27, 0.62, 0.765, 0.94, 0.975, 0.82, 0.97, 0.8),
          S(-0.3, 0.26, 0.62, 0.745, 0.9, 0.955, 0.82, 0.95, 0.8),
          S(0.45, 0.26, 0.62, 0.725, 0.89, 0.935, 0.82, 0.93, 0.78),
          S(0.95, 0.27, 0.61, 0.715, 0.905, 0.915, 0.81, 0.905, 0.76),
        ],
        cabin: [
          { z: 0.9, roof: 0.98, beltW: 0.77, roofW: 0.66 },
          { z: 0.5, roof: 1.3, beltW: 0.77, roofW: 0.66 },
          { z: 0.1, roof: 1.4, beltW: 0.77, roofW: 0.665 },
          { z: -0.62, roof: 1.405, beltW: 0.77, roofW: 0.665 },
          { z: -1.06, roof: 1.37, beltW: 0.76, roofW: 0.67 },
          { z: -1.29, roof: 1.14, beltW: 0.74, roofW: 0.69 },
        ],
        cabinCrisp: 0.72,
        sculpt: { flareF: 0.045, flareR: 0.055, crease: { yF: 0.74, yR: 0.78, amount: 0.014 } },
        features: { rearWiper: true },
      };
    }
    case 'rally': {
      // lifted rally raid coupé: high ground clearance, big tyres in clad arches, a tall cabin with roof rails
      return {
        skeleton: K,
        ...joints({ yb: 0.42, wb: 0.62, ys: 0.82, ws: 0.92, yt: 1.02, wt: 0.84, yc: 1.0, crisp: 0.76 }, { yb: 0.44, wb: 0.62, ys: 0.86, ws: 0.94, yt: 1.06, wt: 0.84, yc: 1.05, crisp: 0.78 }),
        hull: [
          S(-1.0, 0.42, 0.64, 0.86, 0.955, 1.06, 0.84, 1.05, 0.78),
          S(-0.3, 0.41, 0.64, 0.84, 0.925, 1.04, 0.84, 1.03, 0.78),
          S(0.45, 0.41, 0.64, 0.83, 0.915, 1.03, 0.84, 1.02, 0.77),
          S(0.98, 0.42, 0.63, 0.82, 0.93, 1.02, 0.84, 1.005, 0.76),
        ],
        cabin: [
          { z: 0.8, roof: 1.08, beltW: 0.78, roofW: 0.66 },
          { z: 0.4, roof: 1.4, beltW: 0.78, roofW: 0.64 },
          { z: 0.05, roof: 1.54, beltW: 0.77, roofW: 0.62 },
          { z: -0.6, roof: 1.545, beltW: 0.77, roofW: 0.62 },
          { z: -1.0, roof: 1.46, beltW: 0.76, roofW: 0.64 },
          { z: -1.33, roof: 1.2, beltW: 0.74, roofW: 0.66 },
        ],
        cabinCrisp: 0.66,
        sculpt: { flareF: 0.08, flareR: 0.075, crease: { yF: 0.84, yR: 0.87, amount: 0.012 } },
        features: { cladding: true, rails: true, rearWiper: true },
      };
    }
    case 'proto': {
      // endurance prototype: a low tub slung between tall wheel pods, a narrow bubble canopy and a long fin
      return {
        skeleton: K,
        ...joints({ yb: 0.24, wb: 0.62, ys: 0.58, ws: 1.0, yt: 0.83, wt: 0.82, yc: 0.6, crisp: 0.9 }, { yb: 0.28, wb: 0.64, ys: 0.665, ws: 1.04, yt: 0.955, wt: 0.84, yc: 0.83, crisp: 0.9 }),
        hull: [
          S(-1.12, 0.25, 0.66, 0.68, 1.075, 0.965, 0.86, 0.8, 0.92),
          S(-0.42, 0.24, 0.64, 0.6, 0.96, 0.86, 0.82, 0.72, 0.92),
          S(0.45, 0.24, 0.64, 0.56, 0.945, 0.78, 0.8, 0.62, 0.9),
          S(1.12, 0.24, 0.63, 0.57, 0.985, 0.83, 0.82, 0.59, 0.9),
        ],
        cabin: [
          { z: 1.06, roof: 0.66, beltW: 0.58, roofW: 0.44 },
          { z: 0.66, roof: 0.93, beltW: 0.6, roofW: 0.4 },
          { z: 0.3, roof: 1.05, beltW: 0.6, roofW: 0.38 },
          { z: -0.3, roof: 1.06, beltW: 0.6, roofW: 0.38 },
          { z: -0.8, roof: 0.97, beltW: 0.57, roofW: 0.4 },
          { z: -1.3, roof: 0.86, beltW: 0.5, roofW: 0.4 },
        ],
        cabinCrisp: 0.35,
        sculpt: { flareF: 0.03, flareR: 0.05, intake: { z0: -1.08, z1: -0.36, y0: 0.38, y1: 0.64, depth: 0.1 } },
        features: { intake: true, fin: true, podVents: true },
      };
    }
    default: {
      // front-engine grand tourer: long hood sunk between the wings, cabin set back, strong rear haunch
      return {
        skeleton: K,
        ...joints({ yb: 0.26, wb: 0.62, ys: 0.6, ws: 0.965, yt: 0.805, wt: 0.75, yc: 0.735, crisp: 0.75 }, { yb: 0.27, wb: 0.62, ys: 0.63, ws: 0.985, yt: 0.875, wt: 0.76, yc: 0.85, crisp: 0.75 }),
        hull: [
          S(-1.05, 0.25, 0.64, 0.64, 1.0, 0.885, 0.76, 0.86, 0.76),
          S(-0.45, 0.24, 0.63, 0.61, 0.935, 0.855, 0.77, 0.845, 0.76),
          S(0.35, 0.24, 0.63, 0.6, 0.93, 0.83, 0.77, 0.81, 0.76),
          S(1.0, 0.25, 0.63, 0.6, 0.96, 0.815, 0.75, 0.755, 0.75),
        ],
        cabin: [
          { z: 0.7, roof: 0.85, beltW: 0.77, roofW: 0.63 },
          { z: 0.32, roof: 1.08, beltW: 0.77, roofW: 0.59 },
          { z: 0.02, roof: 1.22, beltW: 0.77, roofW: 0.56 },
          { z: -0.55, roof: 1.23, beltW: 0.76, roofW: 0.56 },
          { z: -0.95, roof: 1.07, beltW: 0.75, roofW: 0.58 },
          { z: -1.2, roof: 0.9, beltW: 0.72, roofW: 0.62 },
        ],
        cabinCrisp: 0.55,
        sculpt: { flareF: 0.065, flareR: 0.095, crease: { yF: 0.63, yR: 0.69, amount: 0.012 } },
        features: { gills: true },
      };
    }
  }
}

/** Keeps a generated section well-formed whatever joint it was derived from. */
function fix(s: Section): Section {
  const ys = Math.max(s.ys, s.yb + 0.06);
  const yt = Math.max(s.yt, ys + 0.025);
  const ws = Math.max(s.ws, 0.2);
  return {
    ...s,
    ys,
    yt,
    yc: Math.max(s.yc ?? yt, ys + 0.02),
    ws,
    wb: Math.min(s.wb, ws - 0.02),
    wt: Math.min(s.wt, ws - 0.02),
  };
}

/**
 * Relative section, drawn against the base car: z is where the section sat on
 * the base car (the overhang is measured from the base car's joint and
 * stretched by the body's overhang scale), every other field is an offset from
 * the joint. `ybAbs` is the base car's floor height there, which moves with
 * the body's own floor.
 */
type Rel = { z: number; yb?: number; wb: number; ys: number; ws: number; yt: number; wt: number; yc: number; crisp: number; ybAbs?: number };
function relTo(J: Section, baseJointZ: number, scale: number, baseFloor: number) {
  return (r: Rel): Section =>
    fix({
      z: J.z + (r.z - baseJointZ) * scale,
      yb: r.ybAbs !== undefined ? J.yb + r.ybAbs - baseFloor : J.yb + (r.yb ?? 0),
      wb: J.wb + r.wb,
      ys: J.ys + r.ys,
      ws: J.ws + r.ws,
      yt: J.yt + r.yt,
      wt: J.wt + r.wt,
      yc: (J.yc ?? J.yt) + r.yc,
      crisp: r.crisp,
    });
}

/** Nose sections, from the front joint forwards. */
export function frontSections(id: string, J: Section, K: Skeleton): Section[] {
  const rel = relTo(J, BASE.jointF, K.noseScale, 0.26);
  if (id === 'muscle') {
    // tall, blunt, almost vertical face: the fender crowns run right to the front
    return [
      J,
      rel({ z: 1.75, wb: 0, ys: 0.01, ws: 0, yt: 0.0, wt: -0.01, yc: 0.0, crisp: 0.86 }),
      rel({ z: 2.0, yb: 0.01, wb: -0.02, ys: -0.01, ws: -0.015, yt: -0.025, wt: -0.03, yc: -0.03, crisp: 0.94 }),
      rel({ z: 2.08, yb: 0.015, wb: -0.05, ys: -0.04, ws: -0.04, yt: -0.07, wt: -0.07, yc: -0.07, crisp: 0.96 }),
      rel({ z: 2.115, yb: 0.025, wb: -0.1, ys: -0.07, ws: -0.08, yt: -0.11, wt: -0.12, yc: -0.11, crisp: 0.96 }),
    ];
  }
  if (id === 'aggressive') {
    // knife-edge wedge falling to a low splitter, fenders kept proud above the lamps
    return [
      J,
      rel({ z: 1.72, yb: -0.01, wb: 0, ys: -0.03, ws: -0.005, yt: -0.035, wt: -0.015, yc: -0.045, crisp: 0.82 }),
      rel({ z: 1.98, ybAbs: 0.23, wb: -0.02, ys: -0.14, ws: -0.035, yt: -0.15, wt: -0.08, yc: -0.16, crisp: 0.9 }),
      rel({ z: 2.13, ybAbs: 0.22, wb: -0.06, ys: -0.26, ws: -0.1, yt: -0.3, wt: -0.19, yc: -0.3, crisp: 0.92 }),
      rel({ z: 2.21, ybAbs: 0.22, wb: -0.2, ys: -0.32, ws: -0.26, yt: -0.41, wt: -0.36, yc: -0.38, crisp: 0.92 }),
    ];
  }
  if (id === 'shark') {
    // long, low and pointed in plan: the centre ridge leads, the corners are swept far back
    return [
      J,
      rel({ z: 1.76, yb: -0.01, wb: 0, ys: -0.04, ws: -0.02, yt: -0.05, wt: -0.05, yc: -0.025, crisp: 0.86 }),
      rel({ z: 2.02, ybAbs: 0.23, wb: -0.08, ys: -0.15, ws: -0.13, yt: -0.18, wt: -0.21, yc: -0.11, crisp: 0.9 }),
      rel({ z: 2.2, ybAbs: 0.22, wb: -0.22, ys: -0.25, ws: -0.32, yt: -0.3, wt: -0.41, yc: -0.21, crisp: 0.92 }),
      rel({ z: 2.29, ybAbs: 0.22, wb: -0.4, ys: -0.3, ws: -0.56, yt: -0.36, wt: -0.62, yc: -0.28, crisp: 0.94 }),
    ];
  }
  if (id === 'rally') {
    // upright and squared off, with the bottom raked up for approach angle over a skid plate
    return [
      J,
      rel({ z: 1.74, wb: 0, ys: 0.0, ws: -0.01, yt: -0.01, wt: -0.02, yc: -0.01, crisp: 0.84 }),
      rel({ z: 1.97, yb: 0.05, wb: -0.04, ys: -0.02, ws: -0.03, yt: -0.04, wt: -0.05, yc: -0.04, crisp: 0.92 }),
      rel({ z: 2.06, yb: 0.09, wb: -0.1, ys: -0.05, ws: -0.065, yt: -0.085, wt: -0.11, yc: -0.08, crisp: 0.94 }),
      rel({ z: 2.1, yb: 0.12, wb: -0.17, ys: -0.08, ws: -0.11, yt: -0.125, wt: -0.17, yc: -0.12, crisp: 0.94 }),
    ];
  }
  // classic: a rounded, gently falling nose with the lamps riding in the fender tips
  return [
    J,
    rel({ z: 1.75, yb: -0.01, wb: 0, ys: -0.02, ws: -0.01, yt: -0.03, wt: -0.02, yc: -0.03, crisp: 0.62 }),
    rel({ z: 2.0, ybAbs: 0.245, wb: -0.05, ys: -0.1, ws: -0.07, yt: -0.13, wt: -0.14, yc: -0.11, crisp: 0.46 }),
    rel({ z: 2.13, ybAbs: 0.255, wb: -0.13, ys: -0.19, ws: -0.17, yt: -0.25, wt: -0.32, yc: -0.21, crisp: 0.36 }),
    rel({ z: 2.19, ybAbs: 0.28, wb: -0.3, ys: -0.25, ws: -0.37, yt: -0.33, wt: -0.5, yc: -0.29, crisp: 0.3 }),
  ];
}

/** Tail sections, from the very back up to the rear joint. */
export function rearSections(id: string, J: Section, K: Skeleton): Section[] {
  const rel = relTo(J, BASE.jointR, K.tailScale, 0.27);
  if (id === 'kamm') {
    // chopped tail: full height and width right to the cut, slightly raised deck edge
    return [
      rel({ z: -2.1, ybAbs: 0.3, wb: -0.06, ys: -0.04, ws: -0.05, yt: 0.005, wt: -0.07, yc: 0.0, crisp: 0.95 }),
      rel({ z: -2.04, ybAbs: 0.285, wb: -0.04, ys: -0.015, ws: -0.02, yt: 0.012, wt: -0.04, yc: 0.008, crisp: 0.9 }),
      rel({ z: -1.8, ybAbs: 0.27, wb: -0.02, ys: 0.0, ws: 0.0, yt: 0.01, wt: 0.0, yc: 0.01, crisp: 0.78 }),
      J,
    ];
  }
  if (id === 'diffuser') {
    // track tail: tapering in plan to a crisp cut, high and open underneath for the diffuser
    return [
      rel({ z: -2.13, ybAbs: 0.36, wb: -0.24, ys: -0.06, ws: -0.22, yt: -0.07, wt: -0.22, yc: -0.06, crisp: 0.97 }),
      rel({ z: -2.11, ybAbs: 0.35, wb: -0.21, ys: -0.05, ws: -0.19, yt: -0.055, wt: -0.19, yc: -0.05, crisp: 0.96 }),
      rel({ z: -1.98, ybAbs: 0.32, wb: -0.12, ys: -0.025, ws: -0.09, yt: -0.025, wt: -0.1, yc: -0.025, crisp: 0.9 }),
      rel({ z: -1.75, ybAbs: 0.28, wb: -0.03, ys: 0.0, ws: -0.02, yt: 0.0, wt: -0.03, yc: 0.0, crisp: 0.8 }),
      J,
    ];
  }
  if (id === 'boxy') {
    // square, upright tail: a flat face with crisp corners, high off the ground
    return [
      rel({ z: -1.99, ybAbs: 0.34, wb: -0.05, ys: -0.012, ws: -0.035, yt: -0.012, wt: -0.05, yc: -0.012, crisp: 0.98 }),
      rel({ z: -1.975, ybAbs: 0.32, wb: -0.025, ys: -0.004, ws: -0.016, yt: -0.004, wt: -0.024, yc: -0.004, crisp: 0.97 }),
      rel({ z: -1.72, ybAbs: 0.28, wb: 0, ys: 0, ws: 0, yt: 0, wt: 0, yc: 0, crisp: 0.86 }),
      J,
    ];
  }
  if (id === 'jet') {
    // a tall, rounded tail cut off just short of a point, framing two big round lamps
    return [
      rel({ z: -2.13, ybAbs: 0.34, wb: -0.17, ys: -0.06, ws: -0.19, yt: -0.08, wt: -0.25, yc: -0.05, crisp: 0.55 }),
      rel({ z: -2.07, ybAbs: 0.31, wb: -0.07, ys: -0.025, ws: -0.075, yt: -0.03, wt: -0.11, yc: -0.02, crisp: 0.58 }),
      rel({ z: -1.82, ybAbs: 0.28, wb: -0.01, ys: 0, ws: -0.01, yt: 0, wt: -0.02, yc: 0, crisp: 0.7 }),
      J,
    ];
  }
  // tapered: a rounded boat tail
  return [
    rel({ z: -2.16, ybAbs: 0.32, wb: -0.26, ys: -0.19, ws: -0.36, yt: -0.21, wt: -0.38, yc: -0.2, crisp: 0.35 }),
    rel({ z: -2.08, ybAbs: 0.29, wb: -0.1, ys: -0.11, ws: -0.14, yt: -0.11, wt: -0.18, yc: -0.1, crisp: 0.4 }),
    rel({ z: -1.82, ybAbs: 0.27, wb: -0.02, ys: -0.03, ws: -0.03, yt: -0.04, wt: -0.02, yc: -0.03, crisp: 0.6 }),
    J,
  ];
}
