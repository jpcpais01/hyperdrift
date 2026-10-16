import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { buildCarGeometry } from '../src/car/carBuilder';
import { ALL_SLOTS, DEFAULT_BUILD, VISUAL_PARTS, optionsFor, randomBuild, sanitizeBuild, type CarBuild } from '../src/car/parts';
import { SKELETON } from '../src/car/skeleton';
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
  }, 30000);

  it('wheels never pass through the body, for any body, front, rear and skirt, at full travel', () => {
    // the tyre's envelope: radius plus the most upward travel we ever draw, across its width plus steering sweep
    const reach = SKELETON.wheelRadius + SKELETON.travelUp;
    let n = 0;
    for (const body of VISUAL_PARTS.body) {
      for (const front of VISUAL_PARTS.front) {
        for (const rear of VISUAL_PARTS.rear) {
          // every body x front x rear, cycling skirts and exhausts through them
          {
            const skirts = VISUAL_PARTS.skirts[n % 3];
            const exhaust = VISUAL_PARTS.exhaust[Math.floor(n++ / 3) % 3];
            const { buckets } = buildCarGeometry({ ...DEFAULT_BUILD, body: body.id, front: front.id, rear: rear.id, skirts: skirts.id, exhaust: exhaust.id });
            for (const [bucket, list] of Object.entries(buckets)) {
              if (bucket === 'glass') continue;
              for (const g of list) {
                const pos = g.getAttribute('position');
                for (let i = 0; i < pos.count; i++) {
                  const ax = Math.abs(pos.getX(i));
                  if (ax < 0.62 || ax > 0.98) continue;
                  for (const az of [SKELETON.frontAxleZ, SKELETON.rearAxleZ]) {
                    const r = Math.hypot(pos.getY(i) - SKELETON.wheelY, pos.getZ(i) - az);
                    expect(r, `${body.id}/${front.id}/${rear.id}/${skirts.id} ${bucket}`).toBeGreaterThan(reach);
                  }
                }
              }
            }
          }
        }
      }
    }
  }, 60000);

  it('every painted vertex carries a paint zone', () => {
    const { buckets } = buildCarGeometry(randomBuild(3));
    for (const g of buckets.paint) expect(g.getAttribute('zone')).toBeTruthy();
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
  }, 30000);

  it('random combinations always build, with valid options in every slot', () => {
    for (let seed = 0; seed < 25; seed++) {
      const b = randomBuild(seed);
      for (const slot of ALL_SLOTS) expect(optionsFor(slot).some((o) => o.id === b[slot]), slot).toBe(true);
      expect(bounds(b).nan).toBe(false);
    }
  }, 30000);

  it('sanitises unknown or missing parts', () => {
    const b = sanitizeBuild({ body: 'nope', paint: 'ruby' } as Partial<CarBuild>);
    expect(b.body).toBe(DEFAULT_BUILD.body);
    expect(b.paint).toBe('ruby');
    // builds saved before per-part paint existed get the defaults
    expect(b.paintHood).toBe(DEFAULT_BUILD.paintHood);
    expect(b.vinylColor).toBe('auto');
    expect(sanitizeBuild({ paintHood: 'carbon', rimColor: 'gold', vinyl: 'flames' } as Partial<CarBuild>)).toMatchObject({ paintHood: 'carbon', rimColor: 'gold', vinyl: 'flames' });
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
