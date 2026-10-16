import { describe, expect, it } from 'vitest';
import { Track } from '../src/track/track';
import { SKYWAY } from '../src/track/skyway';
import { CarPhysics } from '../src/game/carPhysics';
import { AiDriver } from '../src/game/ai';
import { computeStats } from '../src/car/stats';
import { DEFAULT_BUILD, randomBuild } from '../src/car/parts';

const track = new Track(SKYWAY);

function simulate(build = DEFAULT_BUILD, seconds = 140, skill = 0.97) {
  const car = new CarPhysics(track, computeStats(build));
  car.reset(track.length - 12, 0);
  const ai = new AiDriver(track, skill, 1);
  const dt = 1 / 120;
  let respawns = 0;
  let dist = 0;
  let prevS = car.trackS;
  let maxSpeed = 0;
  let airborne = 0;
  for (let t = 0; t < seconds; t += dt) {
    const input = ai.drive(car, [car], dt);
    car.step(dt, input);
    for (const e of car.events) if (e.type === 'respawn') respawns++;
    car.events.length = 0;
    let ds = car.trackS - prevS;
    if (ds < -track.length / 2) ds += track.length;
    if (ds > track.length / 2) ds -= track.length;
    dist += ds;
    prevS = car.trackS;
    maxSpeed = Math.max(maxSpeed, car.speed);
    if (!car.grounded) airborne += dt;
  }
  return { respawns, laps: dist / track.length, maxSpeed, airborne };
}

describe('track', () => {
  it('closes the lap', () => {
    expect(track.closureError).toBeLessThan(40);
    expect(track.length).toBeGreaterThan(3000);
  });
  it('projects positions back onto the track', () => {
    for (const s of [10, 900, 1500, 2600]) {
      const p = track.pointAt(s, 3, 1);
      const q = track.query(p, Math.floor(s) - 5);
      expect(Math.abs(q.s - s)).toBeLessThan(0.6);
      expect(q.lateral).toBeCloseTo(3, 0);
      expect(q.height).toBeCloseTo(1, 0);
    }
  });
});

describe('physics', () => {
  it('an AI car laps the whole track (loop, corkscrew, jumps) without falling', () => {
    const r = simulate();
    console.log(r);
    expect(r.respawns).toBe(0);
    expect(r.laps).toBeGreaterThan(2);
    expect(r.airborne).toBeGreaterThan(0.5);
  });
  it('works for several random part combinations', () => {
    for (const seed of [1, 2, 3]) {
      const r = simulate(randomBuild(seed), 60, 0.93);
      console.log(seed, r);
      expect(r.respawns).toBe(0);
      expect(r.laps).toBeGreaterThan(0.8);
    }
  });
  it('nothing glues the car to the deck: too slow upside down and it falls', () => {
    const mid = (k: number) => SKYWAY.slice(0, k).reduce((a, d) => a + d.len, 0) + SKYWAY[k].len / 2;
    const loopTop = mid(SKYWAY.findIndex((d) => d.loop));
    const corkscrew = mid(SKYWAY.findIndex((d) => d.bank === 360));
    const ride = (s: number, v: number) => {
      const car = new CarPhysics(track, computeStats(DEFAULT_BUILD));
      car.reset(s, 0);
      expect(car.up.y).toBeLessThan(-0.9);
      car.vel.copy(car.fwd).multiplyScalar(v);
      for (let i = 0; i < 30; i++) car.step(1 / 120, { throttle: 1, brake: 0, steer: 0 });
      return car.grounded;
    };
    for (const s of [loopTop, corkscrew]) {
      expect(ride(s, 0)).toBe(false);
      expect(ride(s, 15)).toBe(false);
      expect(ride(s, 60)).toBe(true);
    }
  });
  it('stays in contact on ordinary deck (no flicker, no hops over crests)', () => {
    const car = new CarPhysics(track, computeStats(DEFAULT_BUILD));
    car.reset(track.length - 12, 0);
    const ai = new AiDriver(track, 0.97, 1);
    let takeoffs = 0;
    let was = true;
    for (let t = 0; t < 90; t += 1 / 120) {
      car.step(1 / 120, ai.drive(car, [car], 1 / 120));
      car.events.length = 0;
      if (was && !car.grounded) takeoffs++;
      was = car.grounded;
    }
    // ~90 s is a bit over a lap and a half: two ramps per lap, nothing else
    expect(takeoffs).toBeLessThanOrEqual(4);
  });
  it('technical parts change how fast the car is', () => {
    const slow = computeStats({ ...DEFAULT_BUILD, engine: 'rotary', weight: 'heavy' });
    const fast = computeStats({ ...DEFAULT_BUILD, engine: 'v12', weight: 'light' });
    expect(fast.topSpeed).toBeGreaterThan(slow.topSpeed);
  });
});
