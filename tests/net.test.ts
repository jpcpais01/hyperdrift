import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUILD, randomBuild } from '../src/car/parts';
import { computeStats } from '../src/car/stats';
import { CarPhysics } from '../src/game/carPhysics';
import { applyCar, packCar, unpackCar } from '../src/net/carState';
import { codeFromUrl, isValidCode, peerIdFor, randomCode, uniqueName } from '../src/net/protocol';
import { Room, RoomRejected } from '../src/net/room';
import { MemoryNet, MemoryTransport, TransportFailure } from '../src/net/transport';
import { Track } from '../src/track/track';
import { SKYWAY } from '../src/track/skyway';

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const open: Room[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.leave();
});

async function setup(guests = 2) {
  const net = new MemoryNet();
  let hostT = 1000;
  const host = await Room.create(new MemoryTransport(net), 'ANA', DEFAULT_BUILD, { now: () => hostT });
  open.push(host);
  const gs: Room[] = [];
  for (let i = 0; i < guests; i++) {
    // every guest's clock is way off from the host's
    const skew = 50000 * (i + 1);
    const g = await Room.join(new MemoryTransport(net), host.code, 'ANA', randomBuild(i + 3), { now: () => hostT + skew });
    open.push(g);
    gs.push(g);
  }
  await flush();
  return { net, host, guests: gs, tick: (ms: number) => (hostT += ms) };
}

describe('room codes', () => {
  it('are 4 digits and never start with 0', () => {
    for (let i = 0; i < 200; i++) {
      const c = randomCode();
      expect(isValidCode(c)).toBe(true);
      expect(c[0]).not.toBe('0');
    }
    expect(isValidCode('123')).toBe(false);
    expect(isValidCode('12a4')).toBe(false);
    expect(isValidCode('123456')).toBe(false);
  });
  it('map to a game-prefixed peer id and read from invite links', () => {
    expect(peerIdFor('4827')).toMatch(/^hyperdrift-.*4827$/);
    expect(codeFromUrl('?sala=4827')).toBe('4827');
    expect(codeFromUrl('?sala=48')).toBeNull();
  });
  it('dedupes call signs', () => {
    expect(uniqueName('RAIO', ['RAIO', 'RAIO 2'])).toBe('RAIO 3');
  });
});

describe('room', () => {
  it('rolls a new code when the first one is taken', async () => {
    const net = new MemoryNet();
    const a = await Room.create(new MemoryTransport(net), 'A', DEFAULT_BUILD, { rnd: () => 0.5 });
    // b's dice land on a's code first (5555), then on 7777
    const rolls = [0.5, 0.5, 0.5, 0.5, 0.75, 0.75, 0.75, 0.75];
    let k = 0;
    const b = await Room.create(new MemoryTransport(net), 'B', DEFAULT_BUILD, { rnd: () => rolls[k++] });
    open.push(a, b);
    expect(a.code).toBe('5555');
    expect(b.code).toBe('7777');
  });

  it('syncs the roster with unique names and ids', async () => {
    const { host, guests } = await setup(2);
    expect(host.players.map((p) => p.id)).toEqual(['h', 'p1', 'p2']);
    expect(host.players.map((p) => p.name)).toEqual(['ANA', 'ANA 2', 'ANA 3']);
    for (const g of guests) expect(g.players.map((p) => p.id)).toEqual(['h', 'p1', 'p2']);
    expect(guests[1].me?.name).toBe('ANA 3');
  });

  it('locks every guest onto the host clock', async () => {
    const { host, guests } = await setup(2);
    for (const g of guests) expect(Math.abs(g.hostNow() - host.hostNow())).toBeLessThan(1);
  });

  it('starts a session for everyone at the same host time', async () => {
    const { host, guests } = await setup(2);
    const got: number[] = [];
    for (const g of guests) g.onSession = (s) => got.push(s.at - g.hostNow());
    const s = host.startSession('race', { grid: [] }, 4000)!;
    await flush();
    expect(got).toHaveLength(2);
    for (const d of got) expect(d).toBeCloseTo(4000, 0);
    expect(guests[0].session?.seq).toBe(s.seq);
  });

  it('relays state to everyone but the sender, and drops stale sessions', async () => {
    const { host, guests } = await setup(2);
    host.startSession('race', {}, 0);
    await flush();
    const seen: Record<string, string[]> = { h: [], p1: [], p2: [] };
    host.onState = (id) => seen.h.push(id);
    guests[0].onState = (id) => seen.p1.push(id);
    guests[1].onState = (id) => seen.p2.push(id);
    guests[0].sendState('p1', [1]);
    host.sendState('ai0', [2]);
    // a guest can't speak for somebody else
    guests[1].sendState('p1', [3]);
    await flush();
    expect(seen.h).toEqual(['p1']);
    expect(seen.p1).toEqual(['ai0']);
    expect(seen.p2.sort()).toEqual(['ai0', 'p1']);
    // a new session: old packets in flight are ignored
    host.startSession('race', {}, 0);
    await flush();
    seen.p2.length = 0;
    guests[1].onState = (id) => seen.p2.push(id);
    (guests[0] as unknown as { session: { seq: number } }).session.seq = 1;
    guests[0].sendState('p1', [4]);
    await flush();
    expect(seen.p2).toEqual([]);
  });

  it('turns away the fifth player and other versions', async () => {
    const { net, host } = await setup(3);
    await expect(Room.join(new MemoryTransport(net), host.code, 'X', DEFAULT_BUILD)).rejects.toBeInstanceOf(RoomRejected);
    await expect(Room.join(new MemoryTransport(net), '0000', 'X', DEFAULT_BUILD)).rejects.toBeInstanceOf(TransportFailure);
  });

  it('notices when people leave and when the host closes the room', async () => {
    const { host, guests } = await setup(2);
    guests[0].leave();
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    expect(host.players.map((p) => p.id)).toEqual(['h', 'p2']);
    expect(guests[1].players.map((p) => p.id)).toEqual(['h', 'p2']);
    let why = '';
    guests[1].onClose = (r) => (why = r);
    host.leave();
    await flush();
    expect(why).toBe('host-left');
  });
});

describe('car snapshots', () => {
  it('round-trip a car mid-race onto another simulation', () => {
    const track = new Track(SKYWAY);
    const stats = computeStats(DEFAULT_BUILD);
    const a = new CarPhysics(track, stats, 1);
    a.reset(200, 2);
    const input = { throttle: 1, brake: 0, steer: 0.3, nitro: 0 };
    for (let i = 0; i < 240; i++) a.step(1 / 120, input);
    const wire = JSON.parse(JSON.stringify(packCar(a, input, { rt: 12.5, lap: 2, finished: false, finishTime: 0, bestLap: 61.234 })));
    const s = unpackCar(wire)!;
    expect(s.rt).toBe(12.5);
    expect(s.lap).toBe(2);
    expect(s.bestLap).toBeCloseTo(61.234, 3);
    const b = new CarPhysics(track, stats, 2);
    b.reset(0, 0);
    applyCar(b, s, track.samples.length);
    expect(b.pos.distanceTo(a.pos)).toBeLessThan(0.01);
    expect(b.fwd.distanceTo(a.fwd)).toBeLessThan(0.01);
    expect(b.up.distanceTo(a.up)).toBeLessThan(0.01);
    expect(b.right.distanceTo(a.right)).toBeLessThan(0.01);
    // and both keep driving the same way
    for (let i = 0; i < 12; i++) {
      a.step(1 / 120, input);
      b.step(1 / 120, s.input);
    }
    expect(b.pos.distanceTo(a.pos)).toBeLessThan(0.3);
  });

  it('rejects garbage', () => {
    expect(unpackCar(null)).toBeNull();
    expect(unpackCar([1, 2, 3])).toBeNull();
    expect(unpackCar(new Array(27).fill('x'))).toBeNull();
  });
});
