import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, MeshDepthMaterial, MeshPhysicalMaterial, MeshStandardMaterial, ShaderLib, Vector3, type Material } from 'three';
import { CarDamage, LOOSE_PARTS, MAX_DENTS, PART, PartState, type DamageShape } from '../src/car/damage';
import { createDamageUniforms, damaged, damageDepthMaterial, type DamageKind } from '../src/car/damageShader';
import { buildCarGeometry } from '../src/car/carBuilder';
import { DEFAULT_BUILD, VISUAL_PARTS } from '../src/car/parts';

const SHAPE: DamageShape = {
  front: 2.2,
  back: 2.2,
  halfWidth: 1,
  height: 1.3,
  wheels: [
    [0.85, 0.34, 1.3],
    [-0.85, 0.34, 1.3],
    [0.85, 0.34, -1.3],
    [-0.85, 0.34, -1.3],
  ],
  mass: 1300,
};

const FRONT = new Vector3(0.3, 0.5, 2.1);
const INTO_FRONT = new Vector3(0, 0, -1);

describe('damage model', () => {
  it('a nudge only scuffs, a shunt dents, repeated big crashes total the car', () => {
    const d = new CarDamage(SHAPE, 'full', 3);
    d.hit(FRONT, INTO_FRONT, 2.5, 6);
    expect(d.health).toBe(1);
    d.hit(FRONT, INTO_FRONT, 8);
    expect(d.health).toBeLessThan(1);
    expect(d.health).toBeGreaterThan(0.95);
    expect(d.dents.length).toBeGreaterThan(0);
    let wrecked = false;
    for (let i = 0; i < 6 && !wrecked; i++) wrecked = d.hit(new Vector3(0.1 * i, 0.5, 2.1), INTO_FRONT, 34).totaled;
    expect(wrecked).toBe(true);
    expect(d.totaled).toBe(true);
    expect(d.power).toBe(0);
    // a wreck sheds what it had left, and a wheel
    expect(d.parts[CarDamage.slot(PART.front)]).toBe(PartState.Gone);
    expect(d.wheels.some((w) => w.gone)).toBe(true);
  });

  it('panels hang loose before they come off', () => {
    const d = new CarDamage(SHAPE, 'full', 5);
    const seen = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const r = d.hit(new Vector3(0.5, 0.5, 2.1), INTO_FRONT, 15);
      r.loosened.forEach((p) => seen.add(p));
      if (r.detached.includes(PART.front)) {
        expect(seen.has(PART.front)).toBe(true);
        return;
      }
    }
    throw new Error('the bumper never came off');
  });

  it('visual mode never wrecks and never changes the handling', () => {
    const d = new CarDamage(SHAPE, 'visual', 2);
    for (let i = 0; i < 12; i++) d.hit(FRONT, INTO_FRONT, 40);
    expect(d.totaled).toBe(false);
    expect(d.health).toBeGreaterThan(0);
    expect(d.power).toBe(1);
    expect(d.pull).toBe(0);
    expect(d.dents.length).toBeGreaterThan(0);
  });

  it('off mode does nothing', () => {
    const d = new CarDamage(SHAPE, 'off', 2);
    d.hit(FRONT, INTO_FRONT, 40);
    expect(d.damaged).toBe(false);
  });

  it('never keeps more than MAX_DENTS dents and keeps them sane', () => {
    const d = new CarDamage(SHAPE, 'visual', 9);
    for (let i = 0; i < 80; i++) {
      const a = (i / 80) * Math.PI * 2;
      const p = new Vector3(Math.sin(a) * 1.0, 0.3 + (i % 5) * 0.2, Math.cos(a) * 2.2);
      d.hit(p, p.clone().setY(0).negate().normalize(), 6 + (i % 7) * 4, i % 3 ? 0 : 10);
      d.update(1 / 60);
    }
    expect(d.dents.length).toBeLessThanOrEqual(MAX_DENTS);
    for (const dn of d.dents) {
      expect(dn.depth).toBeLessThanOrEqual(0.44);
      expect(dn.r).toBeLessThanOrEqual(1.15);
      expect(Number.isFinite(dn.shown)).toBe(true);
      expect(Math.abs(dn.dir.length() - 1)).toBeLessThan(1e-6);
    }
  });

  it('dents spring in and settle', () => {
    const d = new CarDamage(SHAPE, 'full', 1);
    d.hit(FRONT, INTO_FRONT, 20);
    const dent = d.dents[0];
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      d.update(1 / 120);
      peak = Math.max(peak, dent.shown);
    }
    expect(peak).toBeGreaterThan(dent.depth);
    expect(Math.abs(dent.shown - dent.depth)).toBeLessThan(dent.depth * 0.05);
  });

  it('repair makes it new again', () => {
    const d = new CarDamage(SHAPE, 'full', 4);
    for (let i = 0; i < 6; i++) d.hit(FRONT, INTO_FRONT, 34);
    d.repair();
    expect(d.damaged).toBe(false);
    expect(d.totaled).toBe(false);
    expect(d.parts.every((p) => p === PartState.On)).toBe(true);
    expect(d.wheels.every((w) => !w.gone && w.camber === 0)).toBe(true);
  });

  it('survives the trip over the wire', () => {
    const a = new CarDamage(SHAPE, 'full', 7);
    a.hit(new Vector3(0.6, 0.5, 2.1), INTO_FRONT, 22, 3);
    a.hit(new Vector3(-1, 0.6, -0.4), new Vector3(1, 0, 0), 18, 12);
    a.hit(new Vector3(0, 0.5, -2.1), new Vector3(0, 0, 1), 26);
    const wire = JSON.parse(JSON.stringify([1, 2, 3, ...a.pack()]));
    const b = new CarDamage(SHAPE, 'full', 99);
    const r = b.unpack(wire, 3)!;
    expect(r).not.toBeNull();
    expect(b.health).toBeCloseTo(a.health, 2);
    expect(b.dents.length).toBe(a.dents.length);
    a.dents.forEach((d, i) => {
      expect(b.dents[i].c.distanceTo(d.c)).toBeLessThan(0.01);
      expect(b.dents[i].dir.angleTo(d.dir)).toBeLessThan(0.05);
      expect(b.dents[i].depth).toBeCloseTo(d.depth, 2);
      expect(Math.abs(b.dents[i].r - d.r)).toBeLessThan(0.02);
      expect(b.dents[i].seed).toBeCloseTo(d.seed, 2);
    });
    expect(b.parts).toEqual(a.parts);
    expect(b.lightsOut).toEqual(a.lightsOut);
    a.wheels.forEach((w, i) => {
      expect(b.wheels[i].camber).toBeCloseTo(w.camber, 2);
      expect(b.wheels[i].toe).toBeCloseTo(w.toe, 2);
    });
    for (let i = 0; i < 5; i++) expect(b.zone[i]).toBeCloseTo(Math.min(1.5, a.zone[i]), 1);
    // parts that came off are reported once, so they are thrown once
    expect(r.detached.sort()).toEqual(LOOSE_PARTS.filter((p) => a.partState(p) === PartState.Gone).sort());
    expect(b.unpack(wire, 3)!.detached).toEqual([]);
    // junk is refused
    expect(b.unpack([0, 0, 0, 0, 0, 0, 40], 0)).toBeNull();
    expect(b.unpack([0, 99, 0, 0, 0, 0, 1, NaN, 1, 1], 0)).toBeNull();
  });
});

describe('damage parts on every body', () => {
  it('cuts the bumpers and hood out of every shell and tags every piece', () => {
    for (const body of VISUAL_PARTS.body.map((o) => o.id)) {
      for (const front of VISUAL_PARTS.front.map((o) => o.id)) {
        const build = { ...DEFAULT_BUILD, body, front, hood: 'smooth' };
        const { buckets, partOf, under } = buildCarGeometry(build);
        const parts = new Set<number>();
        for (const list of Object.values(buckets)) for (const g of list) parts.add(partOf.get(g) ?? -1);
        expect(parts.has(-1), `${body}/${front}`).toBe(false);
        for (const p of [PART.body, PART.front, PART.rear]) expect(parts.has(p), `${body}/${front} part ${p}`).toBe(true);
        expect(under.length, body).toBeGreaterThan(0);
        // pieces are whole triangles with nothing lost
        for (const list of Object.values(buckets)) {
          for (const g of list) {
            const n = g.getIndex() ? g.getIndex()!.count : g.getAttribute('position').count;
            expect(n % 3).toBe(0);
          }
        }
      }
    }
  }, 60000);

  it('the front bumper cover lies past the bumper line, the hood on top', () => {
    const { buckets, partOf } = buildCarGeometry({ ...DEFAULT_BUILD, hood: 'smooth' });
    for (const g of buckets.paint) {
      const p = partOf.get(g);
      g.computeBoundingBox();
      const b = g.boundingBox!;
      if (p === PART.front) expect(b.min.z).toBeGreaterThan(1.3);
      if (p === PART.rear) expect(b.max.z).toBeLessThan(-1.3);
      if (p === PART.hood) expect(b.min.y).toBeGreaterThan(0.45);
    }
  });
});

describe('damage shaders', () => {
  const kinds: [Material, DamageKind][] = [
    [new MeshPhysicalMaterial({ clearcoat: 1 }), 'paint'],
    [new MeshStandardMaterial(), 'solid'],
    [new MeshPhysicalMaterial(), 'glass'],
    [new MeshPhysicalMaterial({ emissive: 0xff0000 }), 'lamp'],
    [new MeshBasicMaterial(), 'basicLamp'],
  ];
  const lib = (m: Material) => (m instanceof MeshBasicMaterial ? ShaderLib.basic : m instanceof MeshDepthMaterial ? ShaderLib.depth : ShaderLib.physical);

  it('finds every hook in three.js shaders', () => {
    const u = createDamageUniforms();
    for (const [base, kind] of kinds) {
      const m = damaged(base, u, kind);
      const L = lib(base);
      const shader = { vertexShader: L.vertexShader, fragmentShader: L.fragmentShader, uniforms: {} as Record<string, unknown> };
      m.onBeforeCompile(shader as never, null as never);
      expect(shader.vertexShader, kind).toContain('void dmgDeform');
      expect(shader.vertexShader, kind).toMatch(/dmgDeform\((dmgP|transformed)/);
      expect(shader.vertexShader, kind).toContain('dmgPart(');
      expect(shader.vertexShader, kind).not.toContain('#include <begin_vertex>');
      expect(shader.fragmentShader, kind).toContain('dmgAt');
      expect(shader.uniforms.uDentA, kind).toBe(u.uDentA);
      expect(m.customProgramCacheKey()).toContain(`dmg-${kind}`);
    }
    const depth = damageDepthMaterial(u);
    const shader = { vertexShader: ShaderLib.depth.vertexShader, fragmentShader: ShaderLib.depth.fragmentShader, uniforms: {} as Record<string, unknown> };
    depth.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('dmgPart(transformed');
  });

  it('never raises a possibly negative base to a power', () => {
    const u = createDamageUniforms();
    for (const [base, kind] of kinds) {
      const m = damaged(base, u, kind);
      const L = lib(base);
      const shader = { vertexShader: L.vertexShader, fragmentShader: L.fragmentShader, uniforms: {} };
      m.onBeforeCompile(shader as never, null as never);
      const ours = (shader.vertexShader + shader.fragmentShader).split('\n').filter((l) => /dmg|uDent|uWreck/.test(l));
      for (const l of ours) expect(l).not.toMatch(/pow\(/);
    }
  });
});
