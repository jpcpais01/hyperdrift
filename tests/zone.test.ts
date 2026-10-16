import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { CarPhysics } from '../src/game/carPhysics';
import { collideCars, type CarContact } from '../src/game/carCollision';
import { computeStats } from '../src/car/stats';
import { DEFAULT_BUILD, randomBuild } from '../src/car/parts';
import { circlePath, stadiumPoint, PLAZA_R, samplePath, WALL_R, ZONE_Y, ZoneLayout } from '../src/zone/layout';
import { ZoneDriver, type DriverStyle } from '../src/zone/zoneDriver';
import { DriftScore } from '../src/zone/driftScore';

const layout = new ZoneLayout();

function car(build = DEFAULT_BUILD, seed = 1) {
  const c = new CarPhysics(null, computeStats(build), seed);
  c.ground = layout;
  return c;
}

describe('drift zone layout', () => {
  it('is deterministic and populated', () => {
    const again = new ZoneLayout();
    expect(again.trees.length).toBe(layout.trees.length);
    expect(again.obstacles.map((o) => o.x)).toEqual(layout.obstacles.map((o) => o.x));
    expect(layout.trees.filter((t) => Math.hypot(t.x, t.z) < WALL_R).length).toBeGreaterThan(50);
    expect(layout.kickers.length).toBe(3);
  });

  it('keeps the tour line and the plaza clear of obstacles', () => {
    for (const o of layout.obstacles) {
      if (o.kind === 'gate' || o.kind === 'lamp' || o.kind === 'lantern' || o.kind === 'ring') continue;
      for (const p of layout.tour) expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeGreaterThan(10);
      expect(Math.hypot(o.x, o.z)).toBeGreaterThan(PLAZA_R + 8);
    }
  });

  it('has a flat plaza, a smooth meadow and a banked rim', () => {
    expect(layout.heightAt(0, 0)).toBe(ZONE_Y);
    expect(layout.heightAt(60, -40)).toBe(ZONE_Y);
    expect(layout.heightAt(0, 245) - ZONE_Y).toBeGreaterThan(8);
    // no cliffs anywhere a car can drive: the slope stays climbable
    let maxSlope = 0;
    for (let x = -245; x <= 245; x += 1.5) {
      for (let z = -245; z <= 245; z += 1.5) {
        if (Math.hypot(x, z) > WALL_R - 1) continue;
        const n = layout.normalAt(x, z);
        maxSlope = Math.max(maxSlope, Math.acos(n.y));
      }
    }
    expect((maxSlope * 180) / Math.PI).toBeLessThan(60);
  });
});

describe('free-roam physics', () => {
  it('drives straight off the spawn through the chrome ring', () => {
    const c = car();
    c.spawnSlot = 1;
    c.respawn();
    c.events.length = 0;
    let hits = 0;
    for (let t = 0; t < 5; t += 1 / 120) {
      c.step(1 / 120, { throttle: 1, brake: 0, steer: 0 });
      if (c.impact > 0) hits++;
      c.impact = 0;
    }
    expect(hits).toBe(0);
    expect(c.grounded).toBe(true);
    expect(c.pos.z).toBeGreaterThan(0);
    expect(c.speed).toBeGreaterThan(35);
    expect(Math.abs(c.pos.y - ZONE_Y)).toBeLessThan(0.05);
  });

  it('launches off a kicker at speed and lands back on the island', () => {
    const k = layout.kickers[0];
    const c = car();
    const start = new Vector3(k.x - k.dx * 60, 0, k.z - k.dz * 60);
    start.y = layout.heightAt(start.x, start.z) + 0.05;
    c.place(start, new Vector3(k.dx, 0, k.dz));
    c.vel.set(k.dx, 0, k.dz).multiplyScalar(40);
    let air = 0;
    let maxAir = 0;
    for (let t = 0; t < 6; t += 1 / 120) {
      c.step(1 / 120, { throttle: 1, brake: 0, steer: 0 });
      if (!c.grounded) air += 1 / 120;
      else air = 0;
      maxAir = Math.max(maxAir, air);
    }
    expect(maxAir).toBeGreaterThan(0.6);
    expect(c.grounded).toBe(true);
    expect(c.pos.y).toBeGreaterThan(ZONE_Y - 1);
  });

  it('never leaves the island through the force field', () => {
    const c = car();
    c.place(new Vector3(0, ZONE_Y + 0.05, 150), new Vector3(0, 0, 1));
    let maxR = 0;
    for (let t = 0; t < 12; t += 1 / 120) {
      c.step(1 / 120, { throttle: 1, brake: 0, steer: 0.1, nitro: 1 });
      maxR = Math.max(maxR, Math.hypot(c.pos.x, c.pos.z));
    }
    expect(maxR).toBeLessThan(WALL_R);
    expect(c.pos.y).toBeGreaterThan(ZONE_Y - 1);
  });
});

describe('island residents', () => {
  it('drift, cruise and fly around without getting lost', () => {
    const plaza = samplePath(stadiumPoint, 2);
    const rim = samplePath(circlePath(231), 2.5);
    const setup: [Vector3[], DriverStyle, number, number][] = [
      [plaza, { pace: 0.42, nitro: false }, 0, 21],
      [plaza, { pace: 0.42, nitro: false }, Math.floor(plaza.length / 2), 64],
      [layout.tour, { pace: 0.8, nitro: true }, 40, 97],
      [rim, { pace: 0.95, nitro: true }, 200, 133],
    ];
    const cars = setup.map(([path, style, start, seed], i) => {
      const c = car(randomBuild(seed), i + 2);
      const d = new ZoneDriver(path, style);
      d.place(c, start);
      return { c, d, drift: 0, air: 0, travelled: 0, last: c.pos.clone(), offLine: 0 };
    });
    const list = cars.map((x) => x.c);
    const contacts: CarContact[] = [];
    const dt = 1 / 120;
    const T = 90;
    for (let t = 0; t < T; t += dt) {
      for (const x of cars) {
        const input = x.d.drive(x.c, list, dt);
        x.c.step(dt, input);
        x.c.events.length = 0;
        if (x.c.drifting) x.drift += dt;
        if (!x.c.grounded) x.air += dt;
        x.travelled += x.c.pos.distanceTo(x.last);
        x.last.copy(x.c.pos);
        const p = x.d.path[x.d.index];
        if (Math.hypot(p.x - x.c.pos.x, p.z - x.c.pos.z) > 25) x.offLine += dt;
        expect(Number.isFinite(x.c.pos.x + x.c.pos.y + x.c.pos.z)).toBe(true);
      }
      collideCars(list, contacts);
    }
    const report = cars.map((x) => ({ drift: +(x.drift / T).toFixed(2), air: +x.air.toFixed(1), km: +(x.travelled / 1000).toFixed(2), off: +x.offLine.toFixed(1) }));
    console.log('residents', JSON.stringify(report));
    // the plaza pair spends most of its time sideways
    expect(cars[0].drift / T).toBeGreaterThan(0.4);
    expect(cars[1].drift / T).toBeGreaterThan(0.4);
    // the tourer flies off the kickers
    expect(cars[2].air).toBeGreaterThan(1.5);
    for (const x of cars) {
      expect(x.travelled).toBeGreaterThan(1500);
      expect(x.offLine).toBeLessThan(T * 0.1);
    }
  });
});

describe('drift score', () => {
  it('scores a held drift with a growing multiplier and banks it after the grace window', () => {
    const c = car();
    c.place(new Vector3(0, ZONE_Y + 0.05, -60), new Vector3(0, 0, 1));
    const score = new DriftScore(0);
    // get up to speed, then flick into a long slide
    const dt = 1 / 120;
    let t = 0;
    for (; t < 3; t += dt) c.step(dt, { throttle: 1, brake: 0, steer: 0 });
    let maxMult = 1;
    for (; t < 10; t += dt) {
      const flick = t < 3.05;
      c.step(dt, { throttle: 1, brake: flick ? 1 : 0, steer: -1 });
      score.update(dt, c, c.impact);
      c.impact = 0;
      maxMult = Math.max(maxMult, score.mult);
    }
    expect(maxMult).toBeGreaterThanOrEqual(2);
    for (; t < 14; t += dt) {
      c.step(dt, { throttle: 0, brake: 1, steer: 0 });
      score.update(dt, c, c.impact);
    }
    const bank = score.events.find((e) => e.type === 'bank');
    expect(bank).toBeTruthy();
    expect(score.best).toBeGreaterThan(1000);
    expect(score.active).toBe(false);
  });
});
