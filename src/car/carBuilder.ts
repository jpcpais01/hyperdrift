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
import { PART } from './damage';
import { damaged, type DamageKind } from './damageShader';
import { shellPanel, splitByPart, underSkin, withPart, type PanelRules } from './damageParts';
import { DamageRig, type PartPiece } from './damageRig';
import type { Surface } from './surface';
import { ZONE } from './zones';

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
  /** dents, loose panels and debris (null unless built with `damage`) */
  damage: DamageRig | null;
  /** wheel centres in car space (front +x, front -x, rear +x, rear -x) */
  wheelCentres: [number, number, number][];
  /** a wheel torn off: its tyre, rim and brake as a loose object in car space, centred on the hub */
  wheelDebris(i: number): Group;
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

type CarGeometry = {
  buckets: PartGeo;
  exhaustTips: Vector3[];
  layout: PaintLayout;
  /** which damage part each bucket geometry belongs to (body when missing) */
  partOf: Map<BufferGeometry, number>;
  /** inner skins behind the panels that can come off (hidden until they do) */
  under: { key: keyof PartGeo; geo: BufferGeometry; part: number }[];
  /** the outer skin, for placing hits */
  surface: Surface;
};

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
    const K = shell.K;
    // damage parts: the shell is cut into its bumper covers and hood panel, the rest go whole
    const rules: PanelRules = {
      hoodStart: shell.hoodStart + 0.06,
      hoodEnd: shell.hoodEnd,
      endFront: shell.bumpers.front,
      endRear: shell.bumpers.rear,
      archF: [K.front.r, K.front.z, K.front.arch - 0.004],
      archR: [K.rear.r, K.rear.z, K.rear.arch - 0.004],
      wellX: K.wellX,
    };
    const parts: [PartGeo, number][] = [
      [cabin, PART.body],
      [front, PART.front],
      [rear, PART.rear],
      [hood, PART.hood],
      [skirts, PART.skirts],
      [spoiler, PART.spoiler],
      [lights, PART.front],
      [exhaust.geo, PART.exhaust],
    ];
    const all = emptyPart();
    const partOf = new Map<BufferGeometry, number>();
    const under: CarGeometry['under'] = [];
    for (const k of Object.keys(all) as (keyof PartGeo)[]) {
      for (const g0 of shell.geo[k]) {
        const g = normalizeGeo(g0, k === 'paint');
        const auto = k === 'paint' && g.getAttribute('zone')?.getX(0) === ZONE.auto;
        for (const [part, piece] of splitByPart(g, (c, n) => shellPanel(c, n, rules, auto))) {
          all[k].push(piece);
          partOf.set(piece, part);
          if (auto && part !== PART.body) {
            const inner = part === PART.hood ? PART.underHood : part === PART.front ? PART.underFront : PART.underRear;
            under.push({ key: 'trim', geo: underSkin(piece, part === PART.hood ? 0.07 : 0.045), part: inner });
          }
        }
      }
    }
    for (const [p, part] of parts) {
      for (const k of Object.keys(all) as (keyof PartGeo)[]) {
        for (const g0 of p[k]) {
          const g = normalizeGeo(g0, k === 'paint');
          all[k].push(g);
          partOf.set(g, part);
        }
      }
    }
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
    return { buckets: all, exhaustTips: exhaust.tips, layout, partOf, under, surface: shell.surface };
  });
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
const _q2 = new Quaternion();
const _q3 = new Quaternion();
const _q4 = new Quaternion();
const _x = new Vector3(1, 0, 0);
const _z = new Vector3(0, 0, 1);
const ZERO_M = new Matrix4().makeScale(0, 0, 0);

/** How each bucket shows damage. */
const DAMAGE_KIND: Record<keyof PartGeo, DamageKind> = {
  paint: 'paint',
  trim: 'solid',
  carbon: 'solid',
  chrome: 'solid',
  plastic: 'solid',
  glass: 'glass',
  light: 'basicLamp',
  tail: 'basicLamp',
  housing: 'lamp',
  lens: 'lamp',
  tailLens: 'lamp',
};

/**
 * `damage`: the car can be dented and lose parts (races, free roam). Every
 * material becomes a per-car copy that reads this car's dents; the garage and
 * the ghost skip it.
 */
export function buildCar(build: CarBuild, opts: { ghost?: boolean; damage?: boolean } = {}): CarVisual {
  const shared = getSharedMaterials();
  const { buckets, exhaustTips, layout, partOf, under, surface } = buildCarGeometry(build);
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
  const withDamage = !!opts.damage && !opts.ghost;
  const pieces = new Map<number, PartPiece[]>();
  const boxes = new Map<number, Box3>();
  const ownedMats: Material[] = [];
  let rig: DamageRig | null = null;
  if (withDamage) {
    for (const [, part] of partOf) if (!boxes.has(part)) boxes.set(part, new Box3());
    rig = new DamageRig(boxes, pieces, surface);
  }
  const visibleBounds = new Box3();
  for (const [key, mat0] of table) {
    let mat = pick(mat0);
    let geo: BufferGeometry | null;
    if (rig) {
      // per-car copies (the paint and tail lamps are already this car's own)
      const own = mat0 === mats.paint || mat0 === mats.tail;
      mat = damaged(mat0, rig.uniforms, DAMAGE_KIND[key], own);
      if (!own) ownedMats.push(mat);
      const list = buckets[key];
      const tagged = list.map((g) => withPart(g, partOf.get(g) ?? PART.body));
      for (const u of under) if (u.key === key) tagged.push(withPart(u.geo, u.part));
      geo = tagged.length ? mergeGeometries(tagged, false) : null;
      for (const g of list) {
        const part = partOf.get(g) ?? PART.body;
        g.computeBoundingBox();
        if (g.boundingBox) boxes.get(part)?.union(g.boundingBox);
        if (part === PART.body) continue;
        let entry = pieces.get(part)?.find((p) => p.mat === mat);
        if (!entry) {
          entry = { mat, geos: [] };
          if (!pieces.has(part)) pieces.set(part, []);
          pieces.get(part)!.push(entry);
        }
        entry.geos.push(g);
      }
    } else geo = mergeAll(buckets[key], key === 'paint');
    if (!geo) continue;
    owned.push(geo);
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = false;
    if (rig) mesh.customDepthMaterial = rig.depthMaterial;
    body.add(mesh);
    // the hidden inner skins sit inside the shell: they never widen the hitbox
    if (!rig) {
      geo.computeBoundingBox();
      if (geo.boundingBox) visibleBounds.union(geo.boundingBox);
    }
  }
  if (rig) for (const b of boxes.values()) visibleBounds.union(b);

  // collision box: the union of every visible part plus the wheels, so a long
  // splitter, wide skirts or a tall wing all count
  const bounds = visibleBounds;
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
    damage: rig,
    wheelCentres: wheelPos.map(([x, z], i) => [x, (i < 2 ? K.front : K.rear).r, z] as [number, number, number]),
    wheelDebris(i: number) {
      const g = new Group();
      const [x, z, side] = wheelPos[i];
      const front = i < 2;
      g.position.set(x, (front ? K.front : K.rear).r, z);
      const sc = front ? frontScale : _s;
      for (const im of [...spinning, ...fixed]) {
        const m = new Mesh(im.geometry, im.material);
        m.scale.copy(sc);
        if (side < 0) m.rotation.y = Math.PI;
        m.frustumCulled = false;
        g.add(m);
      }
      return g;
    },
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
        const wd = rig?.wheels[i];
        if (wd?.gone) {
          for (const im of spinning) im.setMatrixAt(i, ZERO_M);
          for (const im of fixed) im.setMatrixAt(i, ZERO_M);
          continue;
        }
        // bent suspension: the wheel leans in at the top, points off line and wobbles as it turns
        const bend = wd ? Math.abs(wd.camber) + Math.abs(wd.toe) : 0;
        const toe = wd ? side * wd.toe + Math.sin(state.spin) * bend * 0.18 : 0;
        const camber = wd ? -side * wd.camber + Math.cos(state.spin) * bend * 0.08 : 0;
        if (wd) _p.y -= Math.abs(wd.camber) * 0.12;
        _e.set(0, steer + toe + flip, 0, 'YXZ');
        _q.setFromEuler(_e);
        if (camber) _q.premultiply(_q2.setFromAxisAngle(_z, camber));
        const spinQ = _q3.setFromAxisAngle(_x, side < 0 ? -state.spin : state.spin);
        _m.compose(_p, _q4.copy(_q).multiply(spinQ), sc);
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
      for (const m of ownedMats) m.dispose();
      rig?.dispose();
      ghostMat?.dispose();
    },
  };
  visual.updateWheels({ steer: 0, spin: 0, travel: [0, 0, 0, 0] });
  return visual;
}
