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
  emptyPart,
  exhaustPart,
  flameGeometry,
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
} from './geometry';
import { createCarMaterials, getSharedMaterials, type CarMaterials } from './materials';
import type { CarBuild } from './parts';
import { SKELETON } from './skeleton';

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
  flames: Mesh[];
  /** tight collision box measured from the assembled parts (car space) */
  hitbox: { front: number; back: number; halfWidth: number; height: number };
  updateWheels(state: WheelState): void;
  setBoost(amount: number, time: number): void;
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
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}

/** Builds all visual part geometry for a build, grouped per material. Pure geometry: usable in tests. */
export function buildCarGeometry(build: CarBuild) {
  const shell = shellPart(build.body, build.front, build.rear);
  const s = shell.surface;
  const cabin = cabinPart(build.body, shell);
  const front = frontPart(build.front, s);
  const rear = rearPart(build.rear, s);
  const hood = hoodPart(build.hood, s, shell.hoodStart, shell.hoodEnd);
  const skirts = skirtPart(build.skirts, s);
  const spoiler = spoilerPart(build.spoiler, s);
  const lights = headlightPart(build.headlights, s);
  const exhaust = exhaustPart(build.exhaust, s);
  const parts: PartGeo[] = [shell.geo, cabin, front, rear, hood, skirts, spoiler, lights, exhaust.geo];
  const all = emptyPart();
  for (const p of parts) {
    for (const k of Object.keys(all) as (keyof PartGeo)[]) all[k].push(...p[k]);
  }
  return { buckets: all, exhaustTips: exhaust.tips, layout: { hoodStart: shell.hoodStart + 0.06, hoodEnd: shell.hoodEnd } };
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
  const wr = SKELETON.wheelRadius;
  bounds.expandByPoint(_p.set(SKELETON.wheelX + SKELETON.wheelWidth / 2, 0, SKELETON.frontAxleZ + wr));
  bounds.expandByPoint(_p.set(-SKELETON.wheelX - SKELETON.wheelWidth / 2, 0, SKELETON.rearAxleZ - wr));
  const hitbox = {
    front: bounds.max.z,
    back: -bounds.min.z,
    // mirrors/flares stick out a little: trim the sides so scrapes feel fair
    halfWidth: Math.max(Math.abs(bounds.min.x), bounds.max.x) * 0.96,
    height: bounds.max.y,
  };

  // boost flames
  const flames: Mesh[] = [];
  if (!opts.ghost) {
    const fg = flameGeometry();
    owned.push(fg);
    for (const t of exhaustTips) {
      const f = new Mesh(fg, mats.flame);
      f.position.copy(t);
      f.visible = false;
      body.add(f);
      flames.push(f);
    }
  }

  // wheels: instanced, 4 per car
  const brakes = brakeGeometry();
  const tire = mergeAll([tireGeometry()]);
  const rim = rimGeometry(build.rims);
  const rimMain = mergeAll(rim.main);
  const rimAccent = mergeAll([...rim.accent, brakes.holes]);
  const disc = mergeAll([brakes.disc]);
  const caliper = mergeAll([brakes.caliper]);
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
    [SKELETON.wheelX, SKELETON.frontAxleZ, 1],
    [-SKELETON.wheelX, SKELETON.frontAxleZ, -1],
    [SKELETON.wheelX, SKELETON.rearAxleZ, 1],
    [-SKELETON.wheelX, SKELETON.rearAxleZ, -1],
  ];

  const visual: CarVisual = {
    root,
    body,
    materials: mats,
    flames,
    hitbox,
    updateWheels(state: WheelState) {
      for (let i = 0; i < 4; i++) {
        const [x, z, side] = wheelPos[i];
        const front = i < 2;
        // the arches are cut for this much lock and travel; never draw past it
        const steer = front ? Math.max(-0.6, Math.min(0.6, state.steer)) : 0;
        _p.set(x, SKELETON.wheelY + Math.max(-0.08, Math.min(0.06, state.travel[i] ?? 0)), z);
        // left-side wheels are the right-side wheel turned around, so no mirroring is needed
        const flip = side < 0 ? Math.PI : 0;
        _e.set(0, steer + flip, 0, 'YXZ');
        _q.setFromEuler(_e);
        const spinQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), side < 0 ? -state.spin : state.spin);
        _m.compose(_p, _q.clone().multiply(spinQ), _s);
        for (const im of spinning) im.setMatrixAt(i, _m);
        _m.compose(_p, _q, _s);
        for (const im of fixed) im.setMatrixAt(i, _m);
      }
      for (const im of spinning) im.instanceMatrix.needsUpdate = true;
      for (const im of fixed) im.instanceMatrix.needsUpdate = true;
    },
    setBoost(amount: number, time: number) {
      mats.flame.opacity = Math.min(1, amount) * (0.75 + 0.25 * Math.sin(time * 60));
      for (const f of flames) {
        f.visible = amount > 0.02;
        const k = 0.6 + amount * (0.8 + 0.3 * Math.sin(time * 47 + f.position.x * 10));
        f.scale.set(1 + amount * 0.4, 1 + amount * 0.4, k);
      }
    },
    dispose() {
      for (const g of owned) g.dispose();
      mats.dispose();
      ghostMat?.dispose();
    },
  };
  visual.updateWheels({ steer: 0, spin: 0, travel: [0, 0, 0, 0] });
  return visual;
}
