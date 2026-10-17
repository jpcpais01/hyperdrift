import { describe, expect, it } from 'vitest';
import { Box3, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cabinBase, cockpitLayout, dashPart, handbrakePart, mirrorPart, shifterPart, wheelPart, type IBuckets } from '../src/car/interiorGeometry';
import { INTERIOR_PARTS } from '../src/car/interiorParts';
import { DEFAULT_BUILD, VISUAL_PARTS } from '../src/car/parts';

function box(list: BufferGeometry[]) {
  const b = new Box3();
  let nan = false;
  for (const g of list) {
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const v = new Vector3().fromBufferAttribute(pos, i);
      if (!Number.isFinite(v.x + v.y + v.z)) nan = true;
      b.expandByPoint(v);
    }
  }
  return { b, nan };
}
const all = (b: IBuckets) => Object.values(b).flat();

describe('cockpit', () => {
  it('every cabin base and dash fits inside every body', () => {
    for (const body of VISUAL_PARTS.body) {
      for (const cockpit of INTERIOR_PARTS.cockpit) {
        for (const dash of INTERIOR_PARTS.dash) {
          const build = { ...DEFAULT_BUILD, body: body.id, cockpit: cockpit.id, dash: dash.id };
          const L = cockpitLayout(body.id);
          const d = dashPart(build, L);
          const { b, nan } = box([...all(cabinBase(build, L)), ...all(d.buckets), ...d.screens]);
          const tag = `${body.id}/${cockpit.id}/${dash.id}`;
          expect(nan, tag).toBe(false);
          // inside the glasshouse: within the doors and under the roof
          expect(Math.max(-b.min.x, b.max.x), tag).toBeLessThan(L.frame.halfW + 0.02);
          expect(b.max.y, tag).toBeLessThan(L.frame.roofY + 0.03);
          expect(b.min.y, tag).toBeGreaterThan(0.2);
          // the driver's head has room, and the dash sits below the eye line
          expect(L.frame.roofAt(L.eye.z) - L.eye.y, tag).toBeGreaterThan(0.12);
          expect(L.dashTop, tag).toBeLessThan(L.eye.y - 0.05);
        }
      }
    }
  }, 20000);

  it('nothing in the cabin rises into the view of the road over the bonnet', () => {
    for (const body of VISUAL_PARTS.body) {
      const L = cockpitLayout(body.id);
      for (const cockpit of INTERIOR_PARTS.cockpit) {
        for (const dash of INTERIOR_PARTS.dash) {
          const build = { ...DEFAULT_BUILD, body: body.id, cockpit: cockpit.id, dash: dash.id };
          const d = dashPart(build, L);
          let worst = -1;
          for (const g of [...all(cabinBase(build, L)), ...all(d.buckets), ...d.screens]) {
            const pos = g.getAttribute('position');
            for (let i = 0; i < pos.count; i++) {
              const x = pos.getX(i);
              const y = pos.getY(i);
              const z = pos.getZ(i);
              // ahead of the wheel, in front of the driver, below the eye
              if (z < L.eye.z + 0.15 || z > L.frame.zCowl || y > L.eye.y || Math.abs(x - L.driverX) > 0.15) continue;
              worst = Math.max(worst, y - L.sightAt(z));
            }
          }
          expect(worst, `${body.id}/${cockpit.id}/${dash.id}`).toBeLessThan(0.005);
        }
      }
      for (const w of INTERIOR_PARTS.wheel) {
        const g = wheelPart(w.id);
        const rimTop = L.wheel.y + g.rim * Math.cos(L.wheelTilt) + 0.02;
        expect(rimTop, `${body.id}/${w.id}`).toBeLessThan(L.sightAt(L.wheel.z));
      }
    }
  }, 20000);

  it('the driver can see every screen and dial, and the levers stay low', () => {
    const mat = new MeshBasicMaterial({ side: DoubleSide });
    const rc = new Raycaster();
    for (const body of VISUAL_PARTS.body) {
      const L = cockpitLayout(body.id);
      for (const cockpit of INTERIOR_PARTS.cockpit) {
        for (const dash of INTERIOR_PARTS.dash) {
          const build = { ...DEFAULT_BUILD, body: body.id, cockpit: cockpit.id, dash: dash.id };
          const d = dashPart(build, L);
          const geos = [...all(cabinBase(build, L)), ...all(d.buckets)].map((g) => {
            const n = g.index ? g.toNonIndexed() : g;
            for (const k of Object.keys(n.attributes)) if (k !== 'position') n.deleteAttribute(k);
            return n;
          });
          const solid = new Mesh(mergeGeometries(geos), mat);
          for (const [i, sg] of d.screens.entries()) {
            sg.computeBoundingBox();
            const c = sg.boundingBox!.getCenter(new Vector3());
            const dir = c.clone().sub(L.eye);
            const dist = dir.length();
            rc.set(L.eye, dir.normalize());
            rc.far = dist - 0.015;
            const hit = rc.intersectObject(solid)[0];
            expect(hit?.point.toArray().map((v) => +v.toFixed(3)), `${body.id}/${cockpit.id}/${dash.id} screen ${i} hidden`).toBeUndefined();
          }
        }
      }
      // gear lever and handbrake tops sit well below the eye: out of the view of the road
      for (const id of INTERIOR_PARTS.handbrake.map((o) => o.id)) {
        const g = handbrakePart(id, L.leverScale);
        const top = g.grip.clone().add(L.handbrake);
        const down = Math.atan2(L.eye.y - top.y - 0.05, top.z - L.eye.z);
        expect(down, `${body.id}/${id}`).toBeGreaterThan(0.45);
      }
    }
  }, 20000);

  it('the steering wheel clears the dash and the driver can reach the levers', () => {
    for (const body of VISUAL_PARTS.body) {
      const L = cockpitLayout(body.id);
      // arm length, plus the glove: the wrist sits ~8cm behind the grip
      const reach = 0.3 + 0.285 + 0.06;
      for (const w of INTERIOR_PARTS.wheel) {
        const g = wheelPart(w.id);
        expect(box(all(g.buckets)).nan).toBe(false);
        // hands at 9 and 3 are within arm's length
        for (const s of [L.shoulderL, L.shoulderR]) expect(s.distanceTo(L.wheel) + g.grip * 0.3, `${body.id}/${w.id}`).toBeLessThan(reach);
        expect(L.wheel.z + 0.05, body.id).toBeLessThan(L.zFace);
        // the gauges are seen through the top of the wheel, between the hub and the rim
        const k = (L.wheel.z - L.eye.z) / (L.cluster.z - L.eye.z);
        const y = L.eye.y + (L.cluster.y - L.eye.y) * k;
        const rimTop = L.wheel.y + g.rim * Math.cos(L.wheelTilt);
        expect(y, `${body.id}/${w.id}`).toBeLessThan(rimTop - 0.01);
        expect(y, `${body.id}/${w.id}`).toBeGreaterThan(L.wheel.y + 0.06);
      }
      for (const id of INTERIOR_PARTS.shifter.map((o) => o.id)) {
        const g = shifterPart(id);
        expect(L.shoulderR.distanceTo(g.grip.clone().add(L.shifter)), `${body.id}/${id}`).toBeLessThan(reach);
      }
      for (const id of INTERIOR_PARTS.handbrake.map((o) => o.id)) {
        const g = handbrakePart(id, L.leverScale);
        expect(L.shoulderR.distanceTo(g.grip.clone().add(L.handbrake)), `${body.id}/${id}`).toBeLessThan(reach);
      }
      for (const m of INTERIOR_PARTS.mirror) {
        const g = mirrorPart(m.id);
        // the stem reaches the headliner without poking through it
        expect(L.mirror.y + g.h / 2 + 0.055, `${body.id}/${m.id}`).toBeLessThan(L.frame.roofAt(L.mirror.z) - 0.03);
      }
    }
  });
});
