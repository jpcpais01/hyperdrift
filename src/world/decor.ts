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
import type { Track } from '../track/track';
import { SUN_DIR } from './sky';

function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Floating island mesh: flat grassy top, rocky stalactite underside.
 * Lighting is baked into vertex colours (sun term + height AO), so the
 * material only needs a cheap ambient/env contribution.
 */
function islandGeometry(detail: number, seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, detail);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = hash3(Math.round(v.x * 4) + seed, Math.round(v.y * 4), Math.round(v.z * 4));
    const r = 1 + (n - 0.5) * 0.25;
    if (v.y > 0) {
      v.set(v.x * r, 0.12 + v.y * 0.18, v.z * r);
    } else {
      const k = Math.pow(-v.y, 1.3);
      const taper = 1 - k * 0.85;
      v.set(v.x * r * taper, -k * (1.6 + n * 0.9), v.z * r * taper);
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal');
  const colors: number[] = [];
  const grass = new Color(0x6a9a52);
  const rock = new Color(0x9a8274);
  const deep = new Color(0x3a2e3c);
  const c = new Color();
  const nv = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    nv.fromBufferAttribute(nrm, i);
    if (nv.y > 0.55 && v.y > 0.05) c.copy(grass);
    else c.copy(rock).lerp(deep, Math.min(1, -v.y / 2));
    // baked sun + ambient occlusion
    const sun = Math.max(0, nv.dot(SUN_DIR)) * 0.8 + 0.45;
    c.multiplyScalar(sun);
    colors.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

interface Island {
  pos: Vector3;
  scale: number;
  rot: number;
}

/** Scenery: floating islands (instanced, two LODs), crystals and giant sky rings. */
export class Decor {
  readonly group = new Group();
  private islands: Island[] = [];
  private hi: InstancedMesh;
  private lo: InstancedMesh;
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
      if (ok) this.islands.push({ pos: p, scale, rot: rnd() * Math.PI * 2 });
    }

    const mat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.35 });
    this.hi = new InstancedMesh(islandGeometry(3, 1), mat, this.islands.length);
    this.lo = new InstancedMesh(islandGeometry(1, 1), mat, this.islands.length);
    this.hi.frustumCulled = false;
    this.lo.frustumCulled = false;
    this.group.add(this.hi, this.lo);

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
    const up = new Vector3(0, 1, 0);
    let hi = 0;
    let lo = 0;
    for (const isl of this.islands) {
      q.setFromAxisAngle(up, isl.rot);
      m.compose(isl.pos, q, new Vector3(isl.scale, isl.scale, isl.scale));
      const near = isl.pos.distanceTo(cam) < 450 + isl.scale * 4;
      if (near) this.hi.setMatrixAt(hi++, m);
      else this.lo.setMatrixAt(lo++, m);
    }
    this.hi.count = hi;
    this.lo.count = lo;
    this.hi.instanceMatrix.needsUpdate = true;
    this.lo.instanceMatrix.needsUpdate = true;
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
