import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
  Mesh,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Track } from '../track/track';
import { SUN_DIR } from './sky';

function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 3D value noise + fbm, used once at load to sculpt and bake the islands. */
function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const h = (i: number, j: number, k: number) => hash3(xi + i, yi + j, zi + k);
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), u), l(h(0, 1, 0), h(1, 1, 0), u), v),
    l(l(h(0, 0, 1), h(1, 0, 1), u), l(h(0, 1, 1), h(1, 1, 1), u), v),
    w,
  );
}
function fbm3(x: number, y: number, z: number, oct = 4) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    v += a * noise3(x * f, y * f, z * f);
    f *= 2.07;
    a *= 0.5;
  }
  return v / (1 - Math.pow(0.5, oct));
}

// linear albedos and light colours for the bake (matched to the sky's sun / haze)
const GRASS_A = new Color(0.1, 0.2, 0.05);
const GRASS_B = new Color(0.17, 0.24, 0.07);
const ROCK_A = new Color(0.3, 0.21, 0.15);
const ROCK_B = new Color(0.2, 0.15, 0.13);
const DEEP = new Color(0.07, 0.055, 0.08);
const SUN_C = new Color(1.0, 0.72, 0.46).multiplyScalar(2.6);
const SKY_C = new Color(0.32, 0.38, 0.66);
const BOUNCE_C = new Color(0.5, 0.42, 0.55);

/**
 * Floating island mesh: grassy plateau, stratified rocky underside tapering into stalactites.
 * All lighting is baked into vertex colours (soft-wrapped sun, sky dome, lavender bounce from the
 * cloud sea, cavity + height AO), so it renders with an unlit material: one cheap draw per LOD.
 * The bake is in object space, so instances are scaled but never rotated.
 */
function islandGeometry(detail: number, seed: number): BufferGeometry {
  let g: BufferGeometry = new IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  const cav = new Float32Array(pos.count);
  const o = seed * 17.3;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm3(v.x * 2.2 + o, v.y * 2.2, v.z * 2.2 - o, 4);
    const r = 0.82 + n * 0.36;
    cav[i] = n;
    if (v.y > 0) {
      // plateau with a gentle rolling top
      const roll = (fbm3(v.x * 3 + o, 0.5, v.z * 3, 3) - 0.5) * 0.07;
      v.set(v.x * r, 0.1 + v.y * 0.14 + roll, v.z * r);
    } else {
      const k = Math.pow(-v.y, 1.25);
      const taper = 1 - k * 0.82;
      const spike = Math.pow(noise3(v.x * 5 + o, 0, v.z * 5), 3) * 1.3;
      v.set(v.x * r * taper, -k * (1.5 + n * 0.8 + spike), v.z * r * taper);
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal');
  const colors: number[] = [];
  const c = new Color();
  const light = new Color();
  const tmpC = new Color();
  const nv = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    nv.fromBufferAttribute(nrm, i);
    const grassy = nv.y > 0.5 + (cav[i] - 0.5) * 0.4 && v.y > 0.02;
    if (grassy) {
      c.copy(GRASS_A).lerp(GRASS_B, fbm3(v.x * 6 + o, 1, v.z * 6, 2));
    } else {
      // sedimentary bands, darker and cooler with depth
      const band = 0.5 + 0.5 * Math.sin(v.y * 16 + cav[i] * 5);
      c.copy(ROCK_A).lerp(ROCK_B, band).lerp(DEEP, Math.min(1, -v.y / 2.2));
    }
    const ndl = nv.dot(SUN_DIR);
    const wrap = Math.max(0, (ndl + 0.25) / 1.25);
    const ao = (0.55 + 0.45 * cav[i]) * (v.y < 0 ? 1 - Math.min(0.55, -v.y * 0.25) : 1);
    light.copy(SUN_C).multiplyScalar(wrap * wrap * (0.6 + 0.4 * ao));
    light.r += (SKY_C.r * (0.5 + 0.5 * nv.y) + BOUNCE_C.r * (0.5 - 0.5 * nv.y)) * ao;
    light.g += (SKY_C.g * (0.5 + 0.5 * nv.y) + BOUNCE_C.g * (0.5 - 0.5 * nv.y)) * ao;
    light.b += (SKY_C.b * (0.5 + 0.5 * nv.y) + BOUNCE_C.b * (0.5 - 0.5 * nv.y)) * ao;
    // grass blades catch a warm rim when back-lit
    if (grassy) light.add(tmpC.copy(SUN_C).multiplyScalar(Math.max(0, -ndl) * 0.08));
    colors.push(c.r * light.r, c.g * light.g, c.b * light.b);
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

interface Island {
  pos: Vector3;
  scale: number;
  rot: number;
  stretch: number;
  variant: number;
}

const ISLAND_VARIANTS = 2;

/** Scenery: floating islands (instanced, two LODs), crystals and giant sky rings. */
export class Decor {
  readonly group = new Group();
  private islands: Island[] = [];
  private hi: InstancedMesh[] = [];
  private lo: InstancedMesh[] = [];
  private lodTimer = 0;
  private rings: Group[] = [];

  constructor(track: Track) {
    // seeded placement around the track, keeping clear of the deck
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const s of track.samples) {
      min = min.min(s.pos);
      max = max.max(s.pos);
    }
    const pad = 700;
    let tries = 0;
    while (this.islands.length < 70 && tries++ < 4000) {
      const p = new Vector3(min.x - pad + rnd() * (max.x - min.x + pad * 2), min.y - 160 + rnd() * 260, min.z - pad + rnd() * (max.z - min.z + pad * 2));
      const scale = 14 + rnd() * rnd() * 70;
      let ok = true;
      for (let i = 0; i < track.samples.length; i += 10) {
        if (track.samples[i].pos.distanceTo(p) < scale * 1.8 + 45) {
          ok = false;
          break;
        }
      }
      if (ok) this.islands.push({ pos: p, scale, rot: rnd() * Math.PI * 2, stretch: 0.8 + rnd() * 0.45, variant: this.islands.length % ISLAND_VARIANTS });
    }

    // fully baked: an unlit material is all the islands need
    const mat = new MeshBasicMaterial({ vertexColors: true });
    for (let v = 0; v < ISLAND_VARIANTS; v++) {
      const hi = new InstancedMesh(islandGeometry(4, v + 1), mat, this.islands.length);
      const lo = new InstancedMesh(islandGeometry(2, v + 1), mat, this.islands.length);
      hi.frustumCulled = lo.frustumCulled = false;
      this.hi.push(hi);
      this.lo.push(lo);
      this.group.add(hi, lo);
    }

    // glowing crystal clusters on the larger islands
    const big = this.islands.filter((i) => i.scale > 30);
    const crystals = new InstancedMesh(new OctahedronGeometry(1, 0), new MeshBasicMaterial({ color: new Color(1.4, 0.5, 2.4) }), big.length * 3);
    const m = new Matrix4();
    const q = new Quaternion();
    big.forEach((isl, k) => {
      for (let j = 0; j < 3; j++) {
        const a = isl.rot + j * 2.1;
        const r = isl.scale * 0.35 * (0.4 + j * 0.2);
        q.setFromAxisAngle(new Vector3(Math.cos(a), 0, Math.sin(a)), 0.25);
        const h = isl.scale * (0.08 + j * 0.03);
        m.compose(new Vector3(isl.pos.x + Math.cos(a) * r, isl.pos.y + isl.scale * 0.3 + h, isl.pos.z + Math.sin(a) * r), q, new Vector3(h * 0.35, h, h * 0.35));
        crystals.setMatrixAt(k * 3 + j, m);
      }
    });
    crystals.computeBoundingSphere();
    this.group.add(crystals);

    // giant surreal rings far away
    const ringMat = new MeshStandardMaterial({ color: 0xd8dde6, metalness: 0.9, roughness: 0.25, envMapIntensity: 1.2 });
    const glow = new MeshBasicMaterial({ color: new Color(0.6, 1.8, 2.6) });
    const centre = min.clone().add(max).multiplyScalar(0.5);
    const placements = [
      [1500, 300, -400, 380],
      [-900, 200, 1600, 260],
      [600, 120, 2200, 200],
    ];
    for (const [x, y, z, r] of placements) {
      const ring = new Group();
      const body = new Mesh(new TorusGeometry(r, r * 0.06, 12, 96), ringMat);
      const line = new Mesh(new TorusGeometry(r * 1.0, r * 0.012, 6, 96), glow);
      line.position.z = r * 0.05;
      ring.add(body, line);
      ring.position.set(centre.x + x, y, centre.z + z);
      ring.lookAt(centre.x, y, centre.z);
      this.rings.push(ring);
      this.group.add(ring);
    }
    this.updateLod(centre);
  }

  private updateLod(cam: Vector3) {
    const m = new Matrix4();
    const q = new Quaternion();
    const sc = new Vector3();
    const hi = this.hi.map(() => 0);
    const lo = this.lo.map(() => 0);
    for (const isl of this.islands) {
      // no rotation: the bake is in object space; stretching x/z keeps the variants from looking cloned
      sc.set(isl.scale * isl.stretch, isl.scale, isl.scale / isl.stretch);
      m.compose(isl.pos, q, sc);
      const v = isl.variant;
      const near = isl.pos.distanceTo(cam) < 450 + isl.scale * 4;
      if (near) this.hi[v].setMatrixAt(hi[v]++, m);
      else this.lo[v].setMatrixAt(lo[v]++, m);
    }
    this.hi.forEach((mesh, v) => {
      mesh.count = hi[v];
      mesh.instanceMatrix.needsUpdate = true;
    });
    this.lo.forEach((mesh, v) => {
      mesh.count = lo[v];
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  update(dt: number, cam: Vector3) {
    this.lodTimer -= dt;
    if (this.lodTimer <= 0) {
      this.lodTimer = 0.4;
      this.updateLod(cam);
    }
    for (const r of this.rings) r.rotateZ(dt * 0.03);
  }
}
