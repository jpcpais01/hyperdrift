import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { buildCarGeometry } from '../src/car/carBuilder';
import { DEFAULT_BUILD, VISUAL_PARTS, randomBuild, sanitizeBuild, type CarBuild } from '../src/car/parts';
import { computeStats, displayStats } from '../src/car/stats';

function bounds(build: CarBuild) {
  const { buckets, exhaustTips } = buildCarGeometry(build);
  const box = new Box3();
  let nan = false;
  for (const list of Object.values(buckets)) {
    for (const g of list) {
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const v = new Vector3().fromBufferAttribute(pos, i);
        if (!Number.isFinite(v.x + v.y + v.z)) nan = true;
        box.expandByPoint(v);
      }
    }
  }
  return { box, nan, exhaustTips, buckets };
}

describe('car parts', () => {
  it('every visual option builds clean geometry inside the standard envelope', () => {
    for (const [slot, options] of Object.entries(VISUAL_PARTS)) {
      for (const o of options) {
        const b = bounds({ ...DEFAULT_BUILD, [slot]: o.id });
        expect(b.nan, `${slot}:${o.id}`).toBe(false);
        expect(b.box.min.y, `${slot}:${o.id}`).toBeGreaterThan(0.05);
        expect(b.box.max.y, `${slot}:${o.id}`).toBeLessThan(1.9);
        expect(Math.max(-b.box.min.x, b.box.max.x), `${slot}:${o.id}`).toBeLessThan(1.15);
        expect(b.box.max.z, `${slot}:${o.id}`).toBeLessThan(2.5);
        expect(b.box.min.z, `${slot}:${o.id}`).toBeGreaterThan(-2.5);
      }
    }
  });

  it('every front x headlight and rear x exhaust combination snaps onto the body', () => {
    for (const front of VISUAL_PARTS.front) {
      for (const lights of VISUAL_PARTS.headlights) {
        const { buckets } = bounds({ ...DEFAULT_BUILD, front: front.id, headlights: lights.id });
        // the light lenses must sit right on the nose surface
        const box = new Box3();
        for (const g of buckets.light) {
          g.computeBoundingBox();
          box.union(g.boundingBox!);
        }
        expect(box.max.z, `${front.id}/${lights.id}`).toBeGreaterThan(1.85);
        expect(box.max.z, `${front.id}/${lights.id}`).toBeLessThan(2.35);
      }
    }
    for (const rear of VISUAL_PARTS.rear) {
      for (const ex of VISUAL_PARTS.exhaust) {
        const { exhaustTips } = bounds({ ...DEFAULT_BUILD, rear: rear.id, exhaust: ex.id });
        for (const t of exhaustTips) {
          expect(t.z, `${rear.id}/${ex.id}`).toBeLessThan(-1.9);
          expect(t.z, `${rear.id}/${ex.id}`).toBeGreaterThan(-2.4);
        }
      }
    }
  });

  it('random combinations always build', () => {
    for (let seed = 0; seed < 25; seed++) expect(bounds(randomBuild(seed)).nan).toBe(false);
  });

  it('sanitises unknown or missing parts', () => {
    const b = sanitizeBuild({ body: 'nope', paint: 'ruby' } as Partial<CarBuild>);
    expect(b.body).toBe(DEFAULT_BUILD.body);
    expect(b.paint).toBe('ruby');
  });

  it('stats stay in display range for every combination of technical parts', () => {
    for (let seed = 0; seed < 40; seed++) {
      const d = displayStats(computeStats(randomBuild(seed)));
      for (const v of Object.values(d)) {
        expect(v).toBeGreaterThanOrEqual(0.5);
        expect(v).toBeLessThanOrEqual(10);
      }
    }
  });
});
