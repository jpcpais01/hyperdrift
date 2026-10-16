import { describe, expect, it } from 'vitest';
import { engineProfile } from '../src/audio/engineProfile';
import { DEFAULT_BUILD, TECH_PARTS } from '../src/car/parts';
import { computeStats } from '../src/car/stats';
import { CarPhysics, NITRO_START } from '../src/game/carPhysics';
import { Drivetrain } from '../src/game/drivetrain';
import { Track } from '../src/track/track';
import { SKYWAY } from '../src/track/skyway';
import { render, stats } from './engineHarness';

describe('engine sound', () => {
  it('every engine x turbo x exhaust renders clean, bounded audio', () => {
    for (const engine of TECH_PARTS.engine) {
      for (const turbo of TECH_PARTS.turbo) {
        for (const exhaust of ['twin', 'quad', 'center']) {
          const p = engineProfile({ ...DEFAULT_BUILD, engine: engine.id, turbo: turbo.id, exhaust });
          const x = render(p, [
            { seconds: 0.4, rpm: p.idleRpm, throttle: 0 },
            { seconds: 0.4, rpm: p.redline, throttle: 1, limiter: 1, nitro: 1 },
            { seconds: 0.3, rpm: p.redline * 0.6, throttle: 0, pop: 1 },
          ]);
          const s = stats(x);
          const key = `${engine.id}/${turbo.id}/${exhaust}`;
          expect(s.finite, key).toBe(true);
          expect(s.peak, key).toBeLessThan(1.5);
          expect(s.rms, key).toBeGreaterThan(0.02);
        }
      }
    }
  });

  it('the engine part changes the firing pattern and rev range', () => {
    const v6 = engineProfile({ ...DEFAULT_BUILD, engine: 'v6' });
    const v12 = engineProfile({ ...DEFAULT_BUILD, engine: 'v12' });
    const rotary = engineProfile({ ...DEFAULT_BUILD, engine: 'rotary' });
    expect(v12.fires.length).toBeGreaterThan(v6.fires.length);
    expect(rotary.redline).toBeGreaterThan(v6.redline);
    expect(engineProfile({ ...DEFAULT_BUILD, turbo: 'single' }).muffler).toBeLessThan(engineProfile({ ...DEFAULT_BUILD, turbo: 'none' }).muffler);
  });
});

describe('drivetrain', () => {
  it('shifts up through the gears and pops on lift-off', () => {
    const d = new Drivetrain({ revRate: 11, popRate: 6 });
    let ups = 0;
    let pops = 0;
    for (let i = 0; i < 1200; i++) {
      d.step(1 / 120, { speed: (i / 1200) * 70, topSpeed: 70, throttle: 1, grounded: true, spin: 0 });
      for (const e of d.events) if (e.type === 'shift' && e.up) ups++;
      d.events.length = 0;
      expect(d.rpm).toBeLessThan(1.05);
    }
    expect(ups).toBe(5);
    for (let i = 0; i < 240; i++) {
      d.step(1 / 120, { speed: 70, topSpeed: 70, throttle: 0, grounded: true, spin: 0 });
      for (const e of d.events) if (e.type === 'pop') pops++;
      d.events.length = 0;
    }
    expect(pops).toBeGreaterThan(0);
  });
});

describe('nitro', () => {
  it('burns the tank while held and pushes the car faster', () => {
    const track = new Track(SKYWAY);
    const run = (nitro: number) => {
      const car = new CarPhysics(track, computeStats(DEFAULT_BUILD));
      car.reset(20, 0);
      for (let i = 0; i < 240; i++) car.step(1 / 120, { throttle: 1, brake: 0, steer: 0, nitro });
      return car;
    };
    const plain = run(0);
    const boosted = run(1);
    expect(plain.nitro).toBeCloseTo(NITRO_START);
    expect(boosted.nitro).toBeLessThan(NITRO_START);
    expect(boosted.speed).toBeGreaterThan(plain.speed + 2);
    expect(boosted.events.some((e) => e.type === 'nitro')).toBe(true);
  });
});
