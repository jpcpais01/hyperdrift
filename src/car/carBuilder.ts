import {
  BufferAttribute,
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
  bodyPart,
  brakeGeometry,
  emptyPart,
  exhaustPart,
  flameGeometry,
  frontPart,
  headlightPart,
  hoodPart,
  rearPart,
  rimGeometry,
  skirtPart,
  spoilerPart,
  Surface,
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
  updateWheels(state: WheelState): void;
  setBoost(amount: number, time: number): void;
  dispose(): void;
}

function normalizeGeo(g: BufferGeometry): BufferGeometry {
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
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
  }
  geo.morphAttributes = {};
  return geo;
}

export function mergeAll(list: BufferGeometry[]): BufferGeometry | null {
  if (!list.length) return null;
  const geos = list.map((g) => normalizeGeo(g.index ? g : g));
  // mixing 16 and 32 bit indices is fine for mergeGeometries, which rebuilds the index
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}

/** Builds all visual part geometry for a build, grouped per material. Pure geometry: usable in tests. */
export function buildCarGeometry(build: CarBuild) {
  const body = bodyPart(build.body);
  const front = frontPart(build.front);
  const rear = rearPart(build.rear);
  const shell = new Surface([...body.geo.paint, ...front.paint, ...rear.paint]);
  const frontSurface = new Surface(front.paint);
  const rearSurface = new Surface(rear.paint);
  const hood = hoodPart(build.hood, shell, body.info.hoodStart);
  const skirts = skirtPart(build.skirts);
  const spoiler = spoilerPart(build.spoiler, shell);
  const lights = headlightPart(build.headlights, frontSurface);
  const exhaust = exhaustPart(build.exhaust, rearSurface);
  const parts: PartGeo[] = [body.geo, front, rear, hood, skirts, spoiler, lights, exhaust.geo];
  const all = emptyPart();
  for (const p of parts) {
    for (const k of Object.keys(all) as (keyof PartGeo)[]) all[k].push(...p[k]);
  }
  return { buckets: all, exhaustTips: exhaust.tips };
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);

export function buildCar(build: CarBuild, opts: { ghost?: boolean } = {}): CarVisual {
  const shared = getSharedMaterials();
  const mats = createCarMaterials(build.paint, build.vinyl);
  const ghostMat = opts.ghost
    ? new MeshBasicMaterial({ color: new Color(0.3, 0.9, 1.4), transparent: true, opacity: 0.22, depthWrite: false })
    : null;
  const pick = (m: Material) => ghostMat ?? m;

  const root = new Group();
  const body = new Group();
  root.add(body);

  const { buckets, exhaustTips } = buildCarGeometry(build);
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
    const geo = mergeAll(buckets[key]);
    if (!geo) continue;
    owned.push(geo);
    const mesh = new Mesh(geo, pick(mat));
    mesh.castShadow = false;
    body.add(mesh);
  }

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
  const tire = mergeAll([tireGeometry(), brakeGeometry().disc]);
  const rim = rimGeometry(build.rims);
  const rimMain = mergeAll(rim.main);
  const rimAccent = mergeAll(rim.accent);
  const caliper = mergeAll([brakeGeometry().caliper]);
  const rimMat = build.rims === 'mesh' ? shared.rimGraphite : build.rims === 'turbine' ? shared.rimWhite : shared.rimSilver;
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
  addInst(rimMain, rimMat, spinning);
  addInst(rimAccent, shared.trim, spinning);
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
    updateWheels(state: WheelState) {
      for (let i = 0; i < 4; i++) {
        const [x, z, side] = wheelPos[i];
        const front = i < 2;
        const steer = front ? state.steer : 0;
        _p.set(x, SKELETON.wheelY + (state.travel[i] ?? 0), z);
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
