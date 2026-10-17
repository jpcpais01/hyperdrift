import {
  BufferAttribute,
  Box3,
  BufferGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  brakeGeometry,
  cabinPart,
  RIM_R,
  RIM_W,
  emptyPart,
  exhaustPart,
  frontPart,
  headlightPart,
  hoodPart,
  rearPart,
  rimGeometry,
  shellPart,
  skirtPart,
  spoilerPart,
  tireGeometry,
  type PartGeo,
  type ShellInfo,
} from './geometry';
import { ExhaustFx } from './exhaustFx';
import { Underglow } from './underglow';
import { createCarMaterials, getSharedMaterials, type CarMaterials, type PaintLayout } from './materials';
import type { CarBuild } from './parts';
import { skeletonFor, TRAVEL } from './skeleton';

export interface WheelState {
  steer: number;
  spin: number;
  /** suspension compression per wheel (metres, + = up) */
  travel: number[];
}

export interface CarVisual {
  root: Group;
  body: Group;
  materials: CarMaterials;
  /** tight collision box measured from the assembled parts (car space) */
  hitbox: { front: number; back: number; halfWidth: number; height: number };
  /** exhaust tip positions in body space */
  exhaustTips: Vector3[];
  /** flames, pops and nitro (null for the ghost) */
  exhaust: ExhaustFx | null;
  /** LED tubes under the car and their light on the road (null when off, and for the ghost) */
  underglow: Underglow | null;
  /** world position of exhaust tip i */
  tipWorld(i: number, out: Vector3): Vector3;
  updateWheels(state: WheelState): void;
  dispose(): void;
}

function normalizeGeo(g: BufferGeometry, keepZone: boolean): BufferGeometry {
  let geo = g;
  if (!geo.getIndex()) {
    const n = geo.getAttribute('position').count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new BufferAttribute(idx, 1));
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position').count;
    geo.setAttribute('uv', new Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (keepZone && !geo.getAttribute('zone')) {
    geo.setAttribute('zone', new Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1));
  }
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(keepZone && name === 'zone')) geo.deleteAttribute(name);
  }
  geo.morphAttributes = {};
  return geo;
}

export function mergeAll(list: BufferGeometry[], keepZone = false): BufferGeometry | null {
  if (!list.length) return null;
  const geos = list.map((g) => normalizeGeo(g, keepZone));
  // mixing 16 and 32 bit indices is fine for mergeGeometries, which rebuilds the index
  // the inputs are CPU-only (never uploaded) and may be cached: leave them alone
  return mergeGeometries(geos, false);
}

type CarGeometry = { buckets: PartGeo; exhaustTips: Vector3[]; layout: PaintLayout };

/** Small LRU caches: swapping one part in the garage only rebuilds what that part changes. */
const shellCache = new Map<string, ShellInfo>();
const geoCache = new Map<string, CarGeometry>();
function cached<T>(cache: Map<string, T>, key: string, size: number, make: () => T): T {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const v = make();
  cache.set(key, v);
  while (cache.size > size) cache.delete(cache.keys().next().value!);
  return v;
}

/**
 * Builds all visual part geometry for a build, grouped per material. Pure
 * geometry: usable in tests. The result is shared between calls with the same
 * shape, so callers must not change it (merging into new geometry is fine).
 */
export function buildCarGeometry(build: CarBuild): CarGeometry {
  const key = [build.body, build.front, build.rear, build.hood, build.skirts, build.spoiler, build.headlights, build.exhaust].join('|');
  return cached(geoCache, key, 8, () => {
    const dome = build.hood === 'smooth';
    const shell = cached(shellCache, `${build.body}|${build.front}|${build.rear}|${dome}`, 4, () => shellPart(build.body, build.front, build.rear, dome));
    const cabin = cabinPart(build.body, shell);
    const front = frontPart(build.front, shell);
    const rear = rearPart(build.rear, shell);
    const hood = hoodPart(build.hood, shell);
    const skirts = skirtPart(build.skirts, shell);
    const spoiler = spoilerPart(build.spoiler, shell);
    const lights = headlightPart(build.headlights, shell);
    const exhaust = exhaustPart(build.exhaust, shell);
    const parts: PartGeo[] = [shell.geo, cabin, front, rear, hood, skirts, spoiler, lights, exhaust.geo];
    const all = emptyPart();
    for (const p of parts) {
      for (const k of Object.keys(all) as (keyof PartGeo)[]) all[k].push(...p[k].map((g) => normalizeGeo(g, k === 'paint')));
    }
    const K = shell.K;
    const layout: PaintLayout = {
      hoodStart: shell.hoodStart + 0.06,
      hoodEnd: shell.hoodEnd,
      doors: [shell.doors.front, shell.doors.rear, shell.doors.rear - 0.32],
      doorY: shell.doorY,
      ends: [shell.bumpers.front, shell.bumpers.rear],
      archF: [K.front.r, K.front.z, K.front.arch],
      archR: [K.rear.r, K.rear.z, K.rear.arch],
      lift: K.lift,
      wellX: K.wellX,
    };
    return { buckets: all, exhaustTips: exhaust.tips, layout };
  });
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);

export function buildCar(build: CarBuild, opts: { ghost?: boolean } = {}): CarVisual {
  const shared = getSharedMaterials();
  const { buckets, exhaustTips, layout } = buildCarGeometry(build);
  const mats = createCarMaterials(build, layout);
  const ghostMat = opts.ghost
    ? new MeshBasicMaterial({ color: new Color(0.3, 0.9, 1.4), transparent: true, opacity: 0.22, depthWrite: false })
    : null;
  const pick = (m: Material) => ghostMat ?? m;

  const root = new Group();
  const body = new Group();
  root.add(body);

  const table: [keyof PartGeo, Material][] = [
    ['paint', mats.paint],
    ['trim', shared.trim],
    ['carbon', shared.carbon],
    ['chrome', shared.chrome],
    ['glass', shared.glass],
    ['light', shared.headlight],
    ['tail', mats.tail],
    ['housing', shared.housing],
    ['plastic', shared.plastic],
    ['tailLens', shared.tailLens],
    ['lens', shared.lens],
  ];
  const owned: BufferGeometry[] = [];
  for (const [key, mat] of table) {
    const geo = mergeAll(buckets[key], key === 'paint');
    if (!geo) continue;
    owned.push(geo);
    const mesh = new Mesh(geo, pick(mat));
    mesh.castShadow = false;
    body.add(mesh);
  }

  // collision box: the union of every visible part plus the wheels, so a long
  // splitter, wide skirts or a tall wing all count
  const bounds = new Box3();
  for (const child of body.children) {
    const g = (child as Mesh).geometry;
    if (!g) continue;
    g.computeBoundingBox();
    if (g.boundingBox) bounds.union(g.boundingBox);
  }
  const K = skeletonFor(build.body);
  bounds.expandByPoint(_p.set(K.front.x + K.front.width / 2, 0, K.front.z + K.front.r));
  bounds.expandByPoint(_p.set(-K.rear.x - K.rear.width / 2, 0, K.rear.z - K.rear.r));
  const hitbox = {
    front: bounds.max.z,
    back: -bounds.min.z,
    // mirrors/flares stick out a little: trim the sides so scrapes feel fair
    halfWidth: Math.max(Math.abs(bounds.min.x), bounds.max.x) * 0.96,
    height: bounds.max.y,
  };

  // exhaust flames, pops and nitro: one draw call, positioned from the exhaust part's tips
  const exhaust = opts.ghost ? null : new ExhaustFx(exhaustTips);
  if (exhaust) {
    body.add(exhaust.flames);
    root.add(exhaust.glow);
  }

  const underglow = opts.ghost || build.underglow === 'none' ? null : new Underglow(build, hitbox);
  if (underglow) {
    body.add(underglow.strips);
    root.add(underglow.pool);
  }

  // wheels: instanced, 4 per car, drawn at the rear wheel's size; the front pair is scaled to its own
  const rimR = K.rear.r * K.rimShare;
  const toWheel = (g: BufferGeometry) => g.scale(K.rear.width / RIM_W, rimR / RIM_R, rimR / RIM_R);
  const brakes = brakeGeometry();
  const tire = mergeAll([tireGeometry(K.rear.r, rimR, K.rear.width)]);
  const rim = rimGeometry(build.rims);
  const rimMain = mergeAll(rim.main.map(toWheel));
  const rimAccent = mergeAll([...rim.accent, brakes.holes].map(toWheel));
  const rimPolish = mergeAll(rim.polish.map(toWheel));
  const disc = mergeAll([toWheel(brakes.disc)]);
  const caliper = mergeAll([toWheel(brakes.caliper)]);
  const spinning: InstancedMesh[] = [];
  const fixed: InstancedMesh[] = [];
  const addInst = (g: BufferGeometry | null, m: Material, list: InstancedMesh[]) => {
    if (!g) return;
    owned.push(g);
    const im = new InstancedMesh(g, pick(m), 4);
    im.frustumCulled = false;
    root.add(im);
    list.push(im);
  };
  addInst(tire, shared.tire, spinning);
  addInst(rimMain, mats.rim, spinning);
  addInst(rimAccent, shared.trim, spinning);
  addInst(rimPolish, shared.chrome, spinning);
  addInst(disc, shared.brake, spinning);
  addInst(caliper, shared.caliper, fixed);

  // blob shadow (baked, cheap)
  const shadowGeo = new PlaneGeometry(2.5, 5.2);
  shadowGeo.rotateX(-Math.PI / 2);
  owned.push(shadowGeo);
  const shadow = new Mesh(shadowGeo, shared.shadow);
  shadow.position.y = 0.03;
  shadow.renderOrder = -1;
  if (!opts.ghost) root.add(shadow);

  const wheelPos = [
    [K.front.x, K.front.z, 1],
    [-K.front.x, K.front.z, -1],
    [K.rear.x, K.rear.z, 1],
    [-K.rear.x, K.rear.z, -1],
  ];
  const frontScale = new Vector3(K.front.width / K.rear.width, K.front.r / K.rear.r, K.front.r / K.rear.r);

  const visual: CarVisual = {
    root,
    body,
    materials: mats,
    hitbox,
    exhaustTips,
    exhaust,
    underglow,
    tipWorld(i: number, out: Vector3) {
      body.updateWorldMatrix(true, false);
      return body.localToWorld(out.copy(exhaustTips[i % Math.max(1, exhaustTips.length)] ?? _p.set(0, 0.3, -2.2)));
    },
    updateWheels(state: WheelState) {
      for (let i = 0; i < 4; i++) {
        const [x, z, side] = wheelPos[i];
        const front = i < 2;
        // the arches are cut for this much lock and travel; never draw past it
        const steer = front ? Math.max(-0.6, Math.min(0.6, state.steer)) : 0;
        const a = front ? K.front : K.rear;
        _p.set(x, a.r + Math.max(-TRAVEL.down, Math.min(TRAVEL.up, state.travel[i] ?? 0)), z);
        const sc = front ? frontScale : _s;
        // left-side wheels are the right-side wheel turned around, so no mirroring is needed
        const flip = side < 0 ? Math.PI : 0;
        _e.set(0, steer + flip, 0, 'YXZ');
        _q.setFromEuler(_e);
        const spinQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), side < 0 ? -state.spin : state.spin);
        _m.compose(_p, _q.clone().multiply(spinQ), sc);
        for (const im of spinning) im.setMatrixAt(i, _m);
        _m.compose(_p, _q, sc);
        for (const im of fixed) im.setMatrixAt(i, _m);
      }
      for (const im of spinning) im.instanceMatrix.needsUpdate = true;
      for (const im of fixed) im.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      exhaust?.dispose();
      underglow?.dispose();
      for (const g of owned) g.dispose();
      mats.dispose();
      ghostMat?.dispose();
    },
  };
  visual.updateWheels({ steer: 0, spin: 0, travel: [0, 0, 0, 0] });
  return visual;
}
