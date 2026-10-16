import { techById, type CarBuild } from '../car/parts';

/**
 * How a car sounds, derived from its parts: the engine sets the cylinder
 * layout, firing order and rev range; the turbo, nitro, tyres and weight add
 * their own layers and colour; the exhaust part tunes the pipe resonance.
 */
export interface EngineProfile {
  engine: 'v6' | 'rotary' | 'v12';
  idleRpm: number;
  redline: number;
  /** firing instants inside one 720° cycle (0..1) */
  fires: number[];
  /** exhaust pipe (0 or 1) each firing feeds */
  banks: number[];
  /** combustion pulse width, as a fraction of the firing interval */
  pulseWidth: number;
  /** firing-to-firing amplitude randomness (0 = turbine smooth) */
  rough: number;
  /** fixed cylinder-to-cylinder amplitude spread */
  imbalance: number;
  /** chance a firing misfires at idle (rotary lope) */
  misfire: number;
  /** combustion noise in each pulse */
  noise: number;
  /** pipe fundamentals, Hz (one per bank) */
  pipeHz: [number, number];
  pipeFeedback: number;
  /** chassis/body boom */
  bodyHz: number;
  bodyGain: number;
  /** muffler low-pass base, Hz */
  muffler: number;
  drive: number;
  /** intake roar amount */
  intake: number;
  level: number;
  /** how fast the revs follow the throttle (1/s) */
  revRate: number;
  turbo: 'none' | 'single' | 'twin';
  /** overrun pops per second off-throttle */
  popRate: number;
  nitro: 'burst' | 'long' | 'drift';
  tires: 'street' | 'slick' | 'drift';
  /** kg, for landing thumps */
  mass: number;
}

const even = (n: number) => Array.from({ length: n }, (_, i) => i / n);

type Base = Omit<EngineProfile, 'turbo' | 'nitro' | 'tires' | 'mass'>;

const ENGINES: Record<EngineProfile['engine'], Base> = {
  // 60° even-fire V6, one pipe per bank: a hoarse, metallic howl
  v6: {
    engine: 'v6',
    idleRpm: 850,
    redline: 7800,
    fires: even(6).map((f, i) => f + [0, 0.006, -0.004, 0.003, -0.006, 0.002][i]),
    banks: [0, 1, 0, 1, 0, 1],
    pulseWidth: 0.34,
    rough: 0.22,
    imbalance: 0.14,
    misfire: 0,
    noise: 0.35,
    pipeHz: [158, 171],
    pipeFeedback: -0.62,
    bodyHz: 115,
    bodyGain: 6,
    muffler: 1500,
    drive: 2.2,
    intake: 0.5,
    level: 0.9,
    revRate: 11,
    popRate: 3.5,
  },
  // twin-rotor Wankel: four short, sharp pulses per cycle, lumpy at idle, braaap at the top
  rotary: {
    engine: 'rotary',
    idleRpm: 1000,
    redline: 9400,
    fires: even(4),
    banks: [0, 0, 0, 0],
    pulseWidth: 0.22,
    rough: 0.45,
    imbalance: 0.2,
    misfire: 0.12,
    noise: 0.75,
    pipeHz: [138, 138],
    pipeFeedback: -0.7,
    bodyHz: 140,
    bodyGain: 4,
    muffler: 2600,
    drive: 3.2,
    intake: 0.7,
    level: 0.8,
    revRate: 16,
    popRate: 7,
  },
  // 60° V12: twelve overlapping pulses, a smooth, high, operatic scream
  v12: {
    engine: 'v12',
    idleRpm: 950,
    redline: 9000,
    fires: even(12),
    banks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
    pulseWidth: 0.5,
    rough: 0.1,
    imbalance: 0.06,
    misfire: 0,
    noise: 0.22,
    pipeHz: [232, 246],
    pipeFeedback: -0.55,
    bodyHz: 170,
    bodyGain: 3,
    muffler: 2300,
    drive: 1.8,
    intake: 0.6,
    level: 1.35,
    revRate: 9,
    popRate: 2,
  },
};

export function engineProfile(build: CarBuild): EngineProfile {
  const engine = techById('engine', build.engine).mods.voice ?? 'v6';
  const base = ENGINES[engine];
  const p: EngineProfile = {
    ...base,
    fires: [...base.fires],
    banks: [...base.banks],
    pipeHz: [...base.pipeHz] as [number, number],
    turbo: build.turbo === 'single' || build.turbo === 'twin' ? build.turbo : 'none',
    nitro: build.nitro === 'burst' || build.nitro === 'drift' ? build.nitro : 'long',
    tires: build.tires === 'slick' || build.tires === 'drift' ? build.tires : 'street',
    mass: techById('weight', build.weight).mods.mass ?? 1300,
  };
  // a turbine in the exhaust smooths and muffles the pulses, and loves to spit flames on lift-off
  if (p.turbo === 'single') {
    p.muffler *= 0.72;
    p.rough *= 0.65;
    p.noise *= 1.15;
    p.popRate += 2.5;
  } else if (p.turbo === 'twin') {
    p.muffler *= 0.8;
    p.rough *= 0.75;
    p.popRate += 1.5;
  } else {
    p.intake *= 1.4;
    p.drive *= 1.1;
  }
  // the exhaust part tunes the pipes: more, smaller tips are brighter; one big pipe booms
  if (build.exhaust === 'quad') {
    p.pipeHz = [p.pipeHz[0] * 1.22, p.pipeHz[1] * 1.26];
    p.muffler *= 1.12;
  } else if (build.exhaust === 'center') {
    p.pipeHz = [p.pipeHz[0] * 0.8, p.pipeHz[0] * 0.8];
    p.bodyGain += 3;
    p.bodyHz *= 0.88;
    p.drive *= 1.12;
  }
  if (build.weight === 'light') p.revRate *= 1.15;
  if (build.weight === 'heavy') p.revRate *= 0.9;
  return p;
}
