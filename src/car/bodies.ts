import type { Section } from './loft';

/**
 * The section catalogue. A body owns the middle of the car (doors, cabin,
 * haunches) and its two joint sections; every nose and tail is written
 * relative to the joint it grows out of, so any combination is one smooth
 * skin with the character of each part kept.
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

export interface BodyInfo {
  /** sections strictly between the joints */
  hull: Section[];
  frontJoint: Section;
  rearJoint: Section;
  cabin: CabinKey[];
  sculpt: BodySculpt;
  /** body-specific trim: front fender gills, engine louvres, intakes */
  features: { gills?: boolean; louvres?: boolean; intake?: boolean };
}

type Sec = Omit<Section, 'z'>;
const at = (z: number, s: Sec): Section => ({ ...s, z });

export function bodySections(id: string): BodyInfo {
  switch (id) {
    case 'fastback': {
      // soft, muscular coupé: rounded sections, a long roof falling to the tail
      const F: Sec = { yb: 0.26, wb: 0.62, ys: 0.6, ws: 0.96, yt: 0.82, wt: 0.74, yc: 0.775, crisp: 0.58 };
      const R: Sec = { yb: 0.27, wb: 0.62, ys: 0.63, ws: 0.985, yt: 0.85, wt: 0.73, yc: 0.835, crisp: 0.58 };
      return {
        frontJoint: at(1.45, F),
        rearJoint: at(-1.45, R),
        hull: [
          { z: -1.05, yb: 0.25, wb: 0.64, ys: 0.64, ws: 1.0, yt: 0.865, wt: 0.76, yc: 0.86, crisp: 0.6 },
          { z: -0.4, yb: 0.245, wb: 0.63, ys: 0.62, ws: 0.95, yt: 0.85, wt: 0.77, yc: 0.85, crisp: 0.6 },
          { z: 0.45, yb: 0.245, wb: 0.63, ys: 0.61, ws: 0.94, yt: 0.835, wt: 0.77, yc: 0.82, crisp: 0.6 },
          { z: 1.05, yb: 0.25, wb: 0.63, ys: 0.6, ws: 0.965, yt: 0.83, wt: 0.75, yc: 0.785, crisp: 0.58 },
        ],
        cabin: [
          { z: 0.62, roof: 0.84, beltW: 0.77, roofW: 0.64 },
          { z: 0.25, roof: 1.08, beltW: 0.77, roofW: 0.6 },
          { z: -0.08, roof: 1.19, beltW: 0.77, roofW: 0.57 },
          { z: -0.5, roof: 1.17, beltW: 0.77, roofW: 0.57 },
          { z: -1.0, roof: 1.01, beltW: 0.76, roofW: 0.6 },
          { z: -1.46, roof: 0.86, beltW: 0.72, roofW: 0.64 },
        ],
        sculpt: { flareF: 0.06, flareR: 0.09, crease: { yF: 0.62, yR: 0.7, amount: 0.012 } },
        features: {},
      };
    }
    case 'wedge': {
      // mid-engine hyper car: low pointed front, cab-forward glasshouse, tall wide haunches, flank intakes
      const F: Sec = { yb: 0.25, wb: 0.62, ys: 0.57, ws: 0.96, yt: 0.8, wt: 0.75, yc: 0.68, crisp: 0.86 };
      const R: Sec = { yb: 0.28, wb: 0.62, ys: 0.65, ws: 1.0, yt: 0.91, wt: 0.78, yc: 0.885, crisp: 0.86 };
      return {
        frontJoint: at(1.45, F),
        rearJoint: at(-1.45, R),
        hull: [
          { z: -1.0, yb: 0.25, wb: 0.65, ys: 0.66, ws: 1.03, yt: 0.915, wt: 0.8, yc: 0.89, crisp: 0.88 },
          { z: -0.3, yb: 0.24, wb: 0.64, ys: 0.62, ws: 0.95, yt: 0.87, wt: 0.8, yc: 0.86, crisp: 0.88 },
          { z: 0.5, yb: 0.24, wb: 0.64, ys: 0.59, ws: 0.945, yt: 0.82, wt: 0.79, yc: 0.775, crisp: 0.88 },
          { z: 1.08, yb: 0.25, wb: 0.63, ys: 0.575, ws: 0.97, yt: 0.8, wt: 0.76, yc: 0.7, crisp: 0.86 },
        ],
        cabin: [
          { z: 1.0, roof: 0.76, beltW: 0.8, roofW: 0.68 },
          { z: 0.6, roof: 0.98, beltW: 0.8, roofW: 0.62 },
          { z: 0.28, roof: 1.11, beltW: 0.79, roofW: 0.57 },
          { z: -0.38, roof: 1.12, beltW: 0.78, roofW: 0.57 },
          { z: -0.8, roof: 0.99, beltW: 0.76, roofW: 0.6 },
          { z: -1.08, roof: 0.9, beltW: 0.72, roofW: 0.64 },
        ],
        sculpt: {
          flareF: 0.055,
          flareR: 0.11,
          intake: { z0: -0.98, z1: -0.28, y0: 0.4, y1: 0.7, depth: 0.1 },
          crease: { yF: 0.58, yR: 0.73, amount: 0.014 },
        },
        features: { louvres: true, intake: true },
      };
    }
    default: {
      // front-engine grand tourer: long hood sunk between the wings, cabin set back, strong rear haunch
      const F: Sec = { yb: 0.26, wb: 0.62, ys: 0.6, ws: 0.965, yt: 0.805, wt: 0.75, yc: 0.735, crisp: 0.75 };
      const R: Sec = { yb: 0.27, wb: 0.62, ys: 0.63, ws: 0.985, yt: 0.875, wt: 0.76, yc: 0.85, crisp: 0.75 };
      return {
        frontJoint: at(1.45, F),
        rearJoint: at(-1.45, R),
        hull: [
          { z: -1.05, yb: 0.25, wb: 0.64, ys: 0.64, ws: 1.0, yt: 0.885, wt: 0.76, yc: 0.86, crisp: 0.76 },
          { z: -0.45, yb: 0.24, wb: 0.63, ys: 0.61, ws: 0.935, yt: 0.855, wt: 0.77, yc: 0.845, crisp: 0.76 },
          { z: 0.35, yb: 0.24, wb: 0.63, ys: 0.6, ws: 0.93, yt: 0.83, wt: 0.77, yc: 0.81, crisp: 0.76 },
          { z: 1.0, yb: 0.25, wb: 0.63, ys: 0.6, ws: 0.96, yt: 0.815, wt: 0.75, yc: 0.755, crisp: 0.75 },
        ],
        cabin: [
          { z: 0.7, roof: 0.85, beltW: 0.77, roofW: 0.63 },
          { z: 0.32, roof: 1.08, beltW: 0.77, roofW: 0.59 },
          { z: 0.02, roof: 1.22, beltW: 0.77, roofW: 0.56 },
          { z: -0.55, roof: 1.23, beltW: 0.76, roofW: 0.56 },
          { z: -0.95, roof: 1.07, beltW: 0.75, roofW: 0.58 },
          { z: -1.2, roof: 0.9, beltW: 0.72, roofW: 0.62 },
        ],
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

/** Relative section: every field is an offset from the joint's (or, for the bottom, an absolute floor). */
type Rel = { z: number; yb?: number; wb: number; ys: number; ws: number; yt: number; wt: number; yc: number; crisp: number; ybAbs?: number };
const rel = (J: Section, r: Rel): Section =>
  fix({
    z: r.z,
    yb: r.ybAbs ?? J.yb + (r.yb ?? 0),
    wb: J.wb + r.wb,
    ys: J.ys + r.ys,
    ws: J.ws + r.ws,
    yt: J.yt + r.yt,
    wt: J.wt + r.wt,
    yc: (J.yc ?? J.yt) + r.yc,
    crisp: r.crisp,
  });

/** Nose sections, from the front joint forwards. */
export function frontSections(id: string, J: Section): Section[] {
  if (id === 'muscle') {
    // tall, blunt, almost vertical face: the fender crowns run right to the front
    return [
      J,
      rel(J, { z: 1.75, wb: 0, ys: 0.01, ws: 0, yt: 0.0, wt: -0.01, yc: 0.0, crisp: 0.86 }),
      rel(J, { z: 2.0, yb: 0.01, wb: -0.02, ys: -0.01, ws: -0.015, yt: -0.025, wt: -0.03, yc: -0.03, crisp: 0.94 }),
      rel(J, { z: 2.08, yb: 0.015, wb: -0.05, ys: -0.04, ws: -0.04, yt: -0.07, wt: -0.07, yc: -0.07, crisp: 0.96 }),
      rel(J, { z: 2.115, yb: 0.025, wb: -0.1, ys: -0.07, ws: -0.08, yt: -0.11, wt: -0.12, yc: -0.11, crisp: 0.96 }),
    ];
  }
  if (id === 'aggressive') {
    // knife-edge wedge falling to a low splitter, fenders kept proud above the lamps
    return [
      J,
      rel(J, { z: 1.72, yb: -0.01, wb: 0, ys: -0.03, ws: -0.005, yt: -0.035, wt: -0.015, yc: -0.045, crisp: 0.82 }),
      rel(J, { z: 1.98, ybAbs: 0.23, wb: -0.02, ys: -0.14, ws: -0.035, yt: -0.15, wt: -0.08, yc: -0.16, crisp: 0.9 }),
      rel(J, { z: 2.13, ybAbs: 0.22, wb: -0.06, ys: -0.26, ws: -0.1, yt: -0.3, wt: -0.19, yc: -0.3, crisp: 0.92 }),
      rel(J, { z: 2.21, ybAbs: 0.22, wb: -0.2, ys: -0.32, ws: -0.26, yt: -0.41, wt: -0.36, yc: -0.38, crisp: 0.92 }),
    ];
  }
  // classic: a rounded, gently falling nose with the lamps riding in the fender tips
  return [
    J,
    rel(J, { z: 1.75, yb: -0.01, wb: 0, ys: -0.02, ws: -0.01, yt: -0.03, wt: -0.02, yc: -0.03, crisp: 0.62 }),
    rel(J, { z: 2.0, ybAbs: 0.245, wb: -0.05, ys: -0.1, ws: -0.07, yt: -0.13, wt: -0.14, yc: -0.11, crisp: 0.46 }),
    rel(J, { z: 2.13, ybAbs: 0.255, wb: -0.13, ys: -0.19, ws: -0.17, yt: -0.25, wt: -0.32, yc: -0.21, crisp: 0.36 }),
    rel(J, { z: 2.19, ybAbs: 0.28, wb: -0.3, ys: -0.25, ws: -0.37, yt: -0.33, wt: -0.5, yc: -0.29, crisp: 0.3 }),
  ];
}

/** Tail sections, from the very back up to the rear joint. */
export function rearSections(id: string, J: Section): Section[] {
  if (id === 'kamm') {
    // chopped tail: full height and width right to the cut, slightly raised deck edge
    return [
      rel(J, { z: -2.1, ybAbs: 0.3, wb: -0.06, ys: -0.04, ws: -0.05, yt: 0.005, wt: -0.07, yc: 0.0, crisp: 0.95 }),
      rel(J, { z: -2.04, ybAbs: 0.285, wb: -0.04, ys: -0.015, ws: -0.02, yt: 0.012, wt: -0.04, yc: 0.008, crisp: 0.9 }),
      rel(J, { z: -1.8, ybAbs: 0.27, wb: -0.02, ys: 0.0, ws: 0.0, yt: 0.01, wt: 0.0, yc: 0.01, crisp: 0.78 }),
      J,
    ];
  }
  if (id === 'diffuser') {
    // track tail: tapering in plan to a crisp cut, high and open underneath for the diffuser
    return [
      rel(J, { z: -2.13, ybAbs: 0.36, wb: -0.24, ys: -0.06, ws: -0.22, yt: -0.07, wt: -0.22, yc: -0.06, crisp: 0.97 }),
      rel(J, { z: -2.11, ybAbs: 0.35, wb: -0.21, ys: -0.05, ws: -0.19, yt: -0.055, wt: -0.19, yc: -0.05, crisp: 0.96 }),
      rel(J, { z: -1.98, ybAbs: 0.32, wb: -0.12, ys: -0.025, ws: -0.09, yt: -0.025, wt: -0.1, yc: -0.025, crisp: 0.9 }),
      rel(J, { z: -1.75, ybAbs: 0.28, wb: -0.03, ys: 0.0, ws: -0.02, yt: 0.0, wt: -0.03, yc: 0.0, crisp: 0.8 }),
      J,
    ];
  }
  // tapered: a rounded boat tail
  return [
    rel(J, { z: -2.16, ybAbs: 0.32, wb: -0.26, ys: -0.19, ws: -0.36, yt: -0.21, wt: -0.38, yc: -0.2, crisp: 0.35 }),
    rel(J, { z: -2.08, ybAbs: 0.29, wb: -0.1, ys: -0.11, ws: -0.14, yt: -0.11, wt: -0.18, yc: -0.1, crisp: 0.4 }),
    rel(J, { z: -1.82, ybAbs: 0.27, wb: -0.02, ys: -0.03, ws: -0.03, yt: -0.04, wt: -0.02, yc: -0.03, crisp: 0.6 }),
    J,
  ];
}
