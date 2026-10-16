import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import { HALF_WIDTH, type Track } from '../track/track';

const RAIL_W = 0.55;
const RAIL_H = 0.9;
const DECK = 1.6;
const CHUNK = 110;
export const RING_SPACING = 12;
export const PICKUP_RESPAWN = 6;

const LEFT_GLOW = new Color(0.15, 0.85, 1.4);
const RIGHT_GLOW = new Color(1.3, 0.25, 1.0);

/** Adds a baked emissive term (per-vertex light from rails, rings, pads) to a standard material. */
function withBakedLight(m: MeshStandardMaterial): MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 bake;\nvarying vec3 vBake;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBake = bake;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBake;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vBake;');
  };
  m.customProgramCacheKey = () => 'baked-light';
  return m;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  return g ? [c, g] : null;
}

function roadTexture(): Texture | null {
  const cv = canvas(512, 512);
  if (!cv) return null;
  const [c, g] = cv;
  g.fillStyle = '#34373e';
  g.fillRect(0, 0, 512, 512);
  // fine aggregate grain
  const img = g.getImageData(0, 0, 512, 512);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 26;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n + 2;
  }
  g.putImageData(img, 0, 0);
  // panel seams
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < 512; y += 128) g.fillRect(0, y, 512, 3);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (const x of [128, 384]) g.fillRect(x, 0, 2, 512);
  // lane markings
  g.fillStyle = 'rgba(235,240,255,0.85)';
  g.fillRect(14, 0, 8, 512);
  g.fillRect(490, 0, 8, 512);
  g.fillStyle = 'rgba(235,240,255,0.55)';
  for (let y = 20; y < 512; y += 128) g.fillRect(252, y, 8, 64);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Asphalt micro-relief (normal map) and roughness variation, generated once.
 * Gives the low sun a broken, grainy specular sheen along the road instead of a flat plastic one.
 */
function roadDetailTextures(): { normal: Texture; rough: Texture } | null {
  const N = 256;
  const nc = canvas(N, N);
  const rc = canvas(N, N);
  if (!nc || !rc) return null;
  let seed = 99;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // height: fine grain + a few coarse blotches (wraps seamlessly)
  const h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = rnd();
  const coarse = new Float32Array(16 * 16).map(() => rnd());
  const cs = (x: number, y: number) => {
    const fx = (x / N) * 16;
    const fy = (y / N) * 16;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (a: number, b: number) => coarse[(b & 15) * 16 + (a & 15)];
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
  const H = (x: number, y: number) => h[((y + N) % N) * N + ((x + N) % N)];
  const ni = nc[1].createImageData(N, N);
  const ri = rc[1].createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * 0.9;
      const dy = (H(x, y + 1) - H(x, y - 1)) * 0.9;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * N + x) * 4;
      ni.data[o] = ((-dx / l) * 0.5 + 0.5) * 255;
      ni.data[o + 1] = ((dy / l) * 0.5 + 0.5) * 255;
      ni.data[o + 2] = (1 / l) * 0.5 * 255 + 127;
      ni.data[o + 3] = 255;
      // polished, darker tyre lines read smoother; worn grain rougher
      const r = 0.42 + cs(x, y) * 0.3 + (H(x, y) - 0.5) * 0.12;
      ri.data[o] = ri.data[o + 1] = ri.data[o + 2] = Math.max(0, Math.min(1, r)) * 255;
      ri.data[o + 3] = 255;
    }
  }
  nc[1].putImageData(ni, 0, 0);
  rc[1].putImageData(ri, 0, 0);
  const normal = new CanvasTexture(nc[0]);
  const rough = new CanvasTexture(rc[0]);
  for (const t of [normal, rough]) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 8;
  }
  // grain much finer than the lane-marking texture; roughness blotches broader
  normal.repeat.set(5, 5);
  rough.repeat.set(1.5, 1.5);
  return { normal, rough };
}

function structureTexture(): Texture | null {
  const cv = canvas(256, 256);
  if (!cv) return null;
  const [c, g] = cv;
  g.fillStyle = '#a7adb7';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 2, 256);
  for (let y = 0; y < 256; y += 32) g.fillRect(0, y, 256, 1);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  for (let x = 2; x < 256; x += 64) g.fillRect(x, 0, 1, 256);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  return t;
}

function chevronTexture(): Texture | null {
  const cv = canvas(128, 256);
  if (!cv) return null;
  const [c, g] = cv;
  g.clearRect(0, 0, 128, 256);
  g.strokeStyle = '#fff';
  g.lineWidth = 18;
  g.lineCap = 'round';
  for (let y = 40; y < 256; y += 85) {
    g.beginPath();
    g.moveTo(16, y + 34);
    g.lineTo(64, y);
    g.lineTo(112, y + 34);
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

function checkerTexture(): Texture | null {
  const cv = canvas(256, 32);
  if (!cv) return null;
  const [c, g] = cv;
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#eee';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

class StripBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  bake: number[] = [];
  idx: number[] = [];
  vert(p: Vector3, n: Vector3, u: number, v: number, ao: number, light: Color) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(ao, ao, ao);
    this.bake.push(light.r, light.g, light.b);
    return this.pos.length / 3 - 1;
  }
  /** Adds the quad a-b-c-d (a,b on the previous row; c,d on the next) facing along `n`. */
  quad(a: number, b: number, c: number, d: number, n: Vector3) {
    const P = this.pos;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
    const e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (nx * n.x + ny * n.y + nz * n.z >= 0) this.idx.push(a, b, c, b, d, c);
    else this.idx.push(a, c, b, b, c, d);
  }
  build(): BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('bake', new Float32BufferAttribute(this.bake, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

interface ProfilePoint {
  lat: number;
  h: number;
  u: number;
}

/** Visual representation of a Track: deck chunks, rails, rings, boost pads and pickups. */
export class TrackView {
  readonly group = new Group();
  private padTex: Texture | null;
  private pickups: InstancedMesh;
  private pickupHidden: number[];
  private pickupPos: Vector3[] = [];
  private ringColors: Color[] = [];
  private emitters: InstancedMesh | null = null;
  private padMat: MeshBasicMaterial;
  private materials: Material[] = [];
  private textures: Texture[] = [];

  constructor(track: Track) {
    const detail = roadDetailTextures();
    const roadMat = withBakedLight(
      new MeshStandardMaterial({
        map: roadTexture(),
        normalMap: detail?.normal ?? null,
        roughnessMap: detail?.rough ?? null,
        roughness: 1,
        metalness: 0.05,
        vertexColors: true,
      }),
    );
    roadMat.normalScale.set(0.3, 0.3);
    if (detail) this.textures.push(detail.normal, detail.rough);
    const structMat = withBakedLight(new MeshStandardMaterial({ map: structureTexture(), roughness: 0.38, metalness: 0.6, vertexColors: true }));
    const lightMatL = new MeshBasicMaterial({ color: LEFT_GLOW.clone().multiplyScalar(2.2) });
    const lightMatR = new MeshBasicMaterial({ color: RIGHT_GLOW.clone().multiplyScalar(2.2) });
    this.materials.push(roadMat, structMat, lightMatL, lightMatR);

    const ringS: number[] = [];
    const n = track.samples.length;
    for (let i = 0; i < n; i++) {
      const smp = track.samples[i];
      if (smp.tunnel && i % RING_SPACING === 0) ringS.push(i);
    }
    ringS.forEach((_, k) => this.ringColors.push(new Color().setHSL((0.52 + k * 0.035) % 1, 1, 0.5).multiplyScalar(2.6)));

    const ringLight = (i: number, out: Color) => {
      out.setRGB(0, 0, 0);
      if (!track.samples[i].tunnel) return out;
      for (let k = 0; k < ringS.length; k++) {
        const d = Math.abs(ringS[k] - i);
        if (d > 18) continue;
        addScaled(out, this.ringColors[k], 0.07 * Math.exp(-(d * d) / 40));
      }
      return out;
    };
    const padLight = (s: number, lat: number, out: Color) => {
      for (const p of track.boostPads) {
        const ds = Math.abs(track.wrapS(s - p.s + track.length / 2) - track.length / 2);
        if (ds > 10) continue;
        const dl = Math.abs(lat - p.lateral);
        out.r += 0.5 * Math.exp(-(ds * ds) / 30) * Math.exp(-(dl * dl) / 12);
        out.g += 0.22 * Math.exp(-(ds * ds) / 30) * Math.exp(-(dl * dl) / 12);
        out.b += 0.04 * Math.exp(-(ds * ds) / 30) * Math.exp(-(dl * dl) / 12);
      }
      return out;
    };

    const roadProfile: ProfilePoint[] = [];
    for (let k = 0; k <= 8; k++) {
      const lat = -HALF_WIDTH + (2 * HALF_WIDTH * k) / 8;
      roadProfile.push({ lat, h: 0, u: (lat + HALF_WIDTH) / (2 * HALF_WIDTH) });
    }

    const W = HALF_WIDTH + RAIL_W;
    const p = new Vector3();
    const nrm = new Vector3();
    const tmpC = new Color();
    const light = new Color();

    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(n, start + CHUNK);
      const road = new StripBuilder();
      const struct = new StripBuilder();
      const glowL = new StripBuilder();
      const glowR = new StripBuilder();

      // Generic strip sweep. `side` builds a piece with a fixed normal in the frame.
      const sweep = (b: StripBuilder, pts: ProfilePoint[], normalOf: (fr: { up: Vector3; right: Vector3 }, out: Vector3) => Vector3, aoOf: (pt: ProfilePoint, i: number) => number, lightOf: (pt: ProfilePoint, i: number, out: Color) => Color, vScale = 1 / 16) => {
        let prevRow: number[] | null = null;
        for (let i = start; i <= end; i++) {
          const ii = i % n;
          const smp = track.samples[ii];
          const nextGap = track.samples[(ii + 1) % n].gap;
          if (smp.gap) {
            prevRow = null;
            continue;
          }
          const row: number[] = [];
          normalOf(smp, nrm);
          for (const pt of pts) {
            p.copy(smp.pos).addScaledVector(smp.right, pt.lat).addScaledVector(smp.up, pt.h);
            row.push(b.vert(p, nrm, pt.u, i * vScale, aoOf(pt, ii), lightOf(pt, ii, light)));
          }
          if (prevRow) {
            for (let k = 0; k < pts.length - 1; k++) {
              const a = prevRow[k];
              const bb = prevRow[k + 1];
              const c = row[k];
              const d = row[k + 1];
              b.quad(a, bb, c, d, nrm);
            }
          }
          prevRow = nextGap ? null : row;
        }
      };

      // road surface: baked AO near the rails, glow from rails / rings / pads
      sweep(
        road,
        roadProfile,
        (fr, o) => o.copy(fr.up),
        (pt) => 1 - 0.35 * smoothstep(HALF_WIDTH - 1.6, HALF_WIDTH, Math.abs(pt.lat)),
        (pt, i, o) => {
          ringLight(i, o);
          const e = smoothstep(HALF_WIDTH - 2.5, HALF_WIDTH, Math.abs(pt.lat)) * 0.18;
          addScaled(o, pt.lat < 0 ? LEFT_GLOW : RIGHT_GLOW, e);
          return padLight(i, pt.lat, o);
        },
      );

      const noLight = (_pt: ProfilePoint, i: number, o: Color) => ringLight(i, o).multiplyScalar(0.6);
      for (const side of [-1, 1]) {
        const glowC = side < 0 ? LEFT_GLOW : RIGHT_GLOW;
        // inner rail wall (faces the road)
        sweep(
          struct,
          [
            { lat: side * HALF_WIDTH, h: 0, u: 0 },
            { lat: side * HALF_WIDTH, h: RAIL_H, u: 0.12 },
          ],
          (fr, o) => o.copy(fr.right).multiplyScalar(-side),
          (pt) => (pt.h < 0.1 ? 0.55 : 0.9),
          (pt, i, o) => addScaled(noLight(pt, i, o), glowC, 0.08),
          1 / 8,
        );
        // rail top
        sweep(
          struct,
          [
            { lat: side * HALF_WIDTH, h: RAIL_H, u: 0.12 },
            { lat: side * W, h: RAIL_H, u: 0.2 },
          ],
          (fr, o) => o.copy(fr.up),
          () => 1,
          noLight,
          1 / 8,
        );
        // outer wall
        sweep(
          struct,
          [
            { lat: side * W, h: RAIL_H, u: 0.2 },
            { lat: side * W, h: -DECK, u: 0.5 },
          ],
          (fr, o) => o.copy(fr.right).multiplyScalar(side),
          (pt) => (pt.h < 0 ? 0.7 : 1),
          noLight,
          1 / 8,
        );
        // light strips on the rail top and along the outer wall
        const gb = side < 0 ? glowL : glowR;
        sweep(
          gb,
          [
            { lat: side * (HALF_WIDTH + 0.12), h: RAIL_H + 0.01, u: 0 },
            { lat: side * (HALF_WIDTH + 0.32), h: RAIL_H + 0.01, u: 1 },
          ],
          (fr, o) => o.copy(fr.up),
          () => 1,
          (_a, _b, o) => o.setRGB(0, 0, 0),
        );
        sweep(
          gb,
          [
            { lat: side * (W + 0.01), h: -0.55, u: 0 },
            { lat: side * (W + 0.01), h: -0.7, u: 1 },
          ],
          (fr, o) => o.copy(fr.right).multiplyScalar(side),
          () => 1,
          (_a, _b, o) => o.setRGB(0, 0, 0),
        );
      }
      // deck underside, lit by the anti-gravity emitters
      sweep(
        struct,
        [
          { lat: W, h: -DECK, u: 0 },
          { lat: 0, h: -DECK, u: 0.5 },
          { lat: -W, h: -DECK, u: 1 },
        ],
        (fr, o) => o.copy(fr.up).multiplyScalar(-1),
        () => 0.55,
        (pt, i, o) => {
          const d = ((i % 60) + 60) % 60;
          const k = Math.exp(-((Math.min(d, 60 - d) / 6) ** 2)) * (1 - Math.abs(pt.lat) / W);
          return o.setRGB(0.25 * k, 0.6 * k, 0.9 * k);
        },
        1 / 8,
      );

      // end caps where the deck meets a gap
      for (let i = start; i < end; i++) {
        const a = track.samples[i];
        const b = track.samples[(i + 1) % n];
        if (a.gap === b.gap) continue;
        const smp = a.gap ? b : a;
        const facing = a.gap ? -1 : 1;
        nrm.copy(smp.fwd).multiplyScalar(facing);
        const corners = [
          [-W, RAIL_H],
          [W, RAIL_H],
          [W, -DECK],
          [-W, -DECK],
        ].map(([lat, h]) => struct.vert(p.copy(smp.pos).addScaledVector(smp.right, lat).addScaledVector(smp.up, h), nrm, 0, 0, 0.8, tmpC.setRGB(0, 0, 0)));
        struct.quad(corners[0], corners[1], corners[3], corners[2], nrm);
      }

      for (const [b, m] of [
        [road, roadMat],
        [struct, structMat],
        [glowL, lightMatL],
        [glowR, lightMatR],
      ] as [StripBuilder, Material][]) {
        const g = b.build();
        if (!g) continue;
        const mesh = new Mesh(g, m);
        mesh.receiveShadow = m === roadMat || m === structMat;
        this.group.add(mesh);
      }
    }

    // light-tunnel rings (instanced, per-instance colour)
    if (ringS.length) {
      const ringGeo = new TorusGeometry(12.6, 0.32, 6, 56);
      const ringMat = new MeshBasicMaterial({ color: 0xffffff });
      this.materials.push(ringMat);
      const rings = new InstancedMesh(ringGeo, ringMat, ringS.length);
      const m = new Matrix4();
      const q = new Quaternion();
      ringS.forEach((i, k) => {
        const smp = track.samples[i];
        m.makeBasis(smp.right, smp.up, smp.fwd);
        q.setFromRotationMatrix(m);
        // centred on the corkscrew's heartline, wide enough to clear the deck edges
        const axis = smp.axis || 4.5;
        const r = Math.max(12.6, Math.hypot(axis, HALF_WIDTH) + 1.6) / 12.6;
        m.compose(smp.pos.clone().addScaledVector(smp.up, axis), q, new Vector3(r, r, r));
        rings.setMatrixAt(k, m);
        rings.setColorAt(k, this.ringColors[k]);
      });
      rings.computeBoundingSphere();
      this.group.add(rings);
    }

    // anti-gravity emitters under the deck
    {
      const idx: number[] = [];
      for (let i = 0; i < n; i += 60) if (!track.samples[i].gap) idx.push(i);
      const geo = new TorusGeometry(2.2, 0.25, 6, 24);
      const mat = new MeshBasicMaterial({ color: new Color(0.6, 2.2, 3.2) });
      this.materials.push(mat);
      const em = new InstancedMesh(geo, mat, idx.length);
      const m = new Matrix4();
      const q = new Quaternion();
      idx.forEach((i, k) => {
        const smp = track.samples[i];
        m.makeBasis(smp.right, smp.fwd, smp.up);
        q.setFromRotationMatrix(m);
        m.compose(smp.pos.clone().addScaledVector(smp.up, -DECK - 0.1), q, new Vector3(1, 1, 1));
        em.setMatrixAt(k, m);
      });
      em.computeBoundingSphere();
      this.emitters = em;
      this.group.add(em);
    }

    // boost pads: conformed quads with a scrolling chevron texture
    this.padTex = chevronTexture();
    this.padMat = new MeshBasicMaterial({
      map: this.padTex,
      color: new Color(3.2, 1.3, 0.25),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.materials.push(this.padMat);
    {
      const b = new StripBuilder();
      const black = new Color(0, 0, 0);
      for (const pad of track.boostPads) {
        const rows = 6;
        const len = 9;
        let prev: number[] | null = null;
        for (let r = 0; r <= rows; r++) {
          const s = pad.s - len / 2 + (len * r) / rows;
          const fr = track.frameAt(s);
          const row: number[] = [];
          for (const dl of [-2.4, 2.4]) {
            p.copy(fr.pos).addScaledVector(fr.right, pad.lateral + dl).addScaledVector(fr.up, 0.04);
            row.push(b.vert(p, fr.up, dl < 0 ? 0 : 1, (r / rows) * 1.5, 1, black));
          }
          if (prev) b.quad(prev[0], prev[1], row[0], row[1], fr.up);
          prev = row;
        }
      }
      const g = b.build();
      if (g) this.group.add(new Mesh(g, this.padMat));
    }

    // start / finish line + gantry
    {
      const fr = track.frameAt(2);
      const lineTex = checkerTexture();
      const lineMat = new MeshBasicMaterial({ map: lineTex, polygonOffset: true, polygonOffsetFactor: -2 });
      this.materials.push(lineMat);
      const b = new StripBuilder();
      const black = new Color();
      const row = (s: number, v: number) => {
        const f = track.frameAt(s);
        return [-HALF_WIDTH, HALF_WIDTH].map((lat, k) => b.vert(p.copy(f.pos).addScaledVector(f.right, lat).addScaledVector(f.up, 0.03), f.up, k, v, 1, black));
      };
      const r0 = row(1, 0);
      const r1 = row(3, 1);
      b.quad(r0[0], r0[1], r1[0], r1[1], fr.up);
      this.group.add(new Mesh(b.build()!, lineMat));
      const gantryMat = new MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.35, metalness: 0.8 });
      const gantryGlow = new MeshBasicMaterial({ color: new Color(3, 3, 3.4) });
      this.materials.push(gantryMat, gantryGlow);
      const m = new Matrix4().makeBasis(fr.right, fr.up, fr.fwd);
      const gantry = new Group();
      gantry.quaternion.setFromRotationMatrix(m);
      gantry.position.copy(fr.pos);
      const pillarGeo = new OctahedronGeometry(1, 0);
      for (const side of [-1, 1]) {
        const pillar = new Mesh(pillarGeo, gantryMat);
        pillar.scale.set(0.7, 7, 0.7);
        pillar.position.set(side * (HALF_WIDTH + 1.6), 5, 0);
        gantry.add(pillar);
      }
      const beam = new Mesh(new TorusGeometry(HALF_WIDTH + 2, 0.45, 8, 48, Math.PI), gantryMat);
      beam.position.y = 5;
      gantry.add(beam);
      const beamGlow = new Mesh(new TorusGeometry(HALF_WIDTH + 2, 0.12, 6, 48, Math.PI), gantryGlow);
      beamGlow.position.set(0, 5, -0.5);
      gantry.add(beamGlow);
      this.group.add(gantry);
    }

    // nitro pickups
    const pickGeo = new OctahedronGeometry(0.85, 0);
    const pickMat = new MeshBasicMaterial({ color: new Color(0.5, 2.6, 3.4) });
    this.materials.push(pickMat);
    this.pickups = new InstancedMesh(pickGeo, pickMat, Math.max(1, track.pickups.length));
    this.pickups.count = track.pickups.length;
    this.pickupHidden = track.pickups.map(() => 0);
    for (const pk of track.pickups) this.pickupPos.push(track.pointAt(pk.s, pk.lateral, 1.4));
    this.pickups.frustumCulled = false;
    this.group.add(this.pickups);
  }

  get pickupPositions(): readonly Vector3[] {
    return this.pickupPos;
  }

  isPickupActive(i: number): boolean {
    return this.pickupHidden[i] <= 0;
  }

  collectPickup(i: number) {
    this.pickupHidden[i] = PICKUP_RESPAWN;
  }

  resetPickups() {
    this.pickupHidden.fill(0);
  }

  update(dt: number, time: number) {
    if (this.padTex) this.padTex.offset.y = -time * 1.6;
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    for (let i = 0; i < this.pickupPos.length; i++) {
      if (this.pickupHidden[i] > 0) this.pickupHidden[i] -= dt;
      const visible = this.pickupHidden[i] <= 0;
      q.setFromAxisAngle(up, time * 2 + i);
      const s = visible ? 1 : 0;
      const pos = this.pickupPos[i].clone();
      pos.y += Math.sin(time * 3 + i) * 0.25;
      m.compose(pos, q, new Vector3(s, s * 1.4, s));
      this.pickups.setMatrixAt(i, m);
    }
    this.pickups.instanceMatrix.needsUpdate = true;
    void this.emitters;
  }

  dispose() {
    this.group.traverse((o) => {
      if ((o as Mesh).geometry) (o as Mesh).geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.padTex?.dispose();
    for (const t of this.textures) t.dispose();
  }
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function addScaled(out: Color, c: Color, k: number): Color {
  out.r += c.r * k;
  out.g += c.g * k;
  out.b += c.b * k;
  return out;
}
