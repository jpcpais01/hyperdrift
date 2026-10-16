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
import { analyseTrack, type TrackLayout } from './trackLayout';

/** barrier: a low metal base, a glass panel set back from the road edge and a slim top rail */
const BASE_H = 0.42;
const GLASS_IN = 0.3;
const RAIL_TOP = 1.28;
const RAIL_W = 0.7;
const OUTER = HALF_WIDTH + RAIL_W;
/** the deck is a shallow keel under the road */
const FASCIA = 0.7;
const KEEL = 3.0;
const KEEL_HALF = HALF_WIDTH * 0.45;
const CHUNK = 220;
export const RING_SPACING = 12;
export const PICKUP_RESPAWN = 6;
/** where the tunnel's rings sit above the road, and their radius (unless the deck rolls round a heartline) */
export const TUNNEL_CENTRE = 4.5;
export const TUNNEL_RADIUS = 12.6;

/** The tunnel's axis above this sample's deck and a radius wide enough to clear the deck's edges. */
function tunnelAxis(smp: { axis: number }) {
  const axis = smp.axis || TUNNEL_CENTRE;
  return { axis, radius: Math.max(TUNNEL_RADIUS, Math.hypot(axis, HALF_WIDTH) + 1.6) };
}

const LEFT_GLOW = new Color(0.15, 0.85, 1.4);
const RIGHT_GLOW = new Color(1.3, 0.25, 1.0);
const LAMP_LIGHT = new Color(1.0, 0.78, 0.5);

/** Adds a baked emissive term (per-vertex light from rails, rings, pads, lamps) to a standard material. */
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

/**
 * Racing asphalt for one 16 m tile of the deck: aggregate grain, broad patches,
 * rubbered-in racing lines, panel joints every 4 m (the speed cue you feel at
 * 300 km/h) and solid edge lines with a thin coloured pinstripe.
 */
function roadTexture(): Texture | null {
  const W = 512;
  const H = 1024;
  const cv = canvas(W, H);
  if (!cv) return null;
  const [c, g] = cv;
  g.fillStyle = '#2f3137';
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // broad patches (resurfaced panels, slightly different mixes)
  for (let k = 0; k < 26; k++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const r = 40 + rnd() * 120;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const v = rnd() < 0.5 ? '255,255,255' : '0,0,0';
    grd.addColorStop(0, `rgba(${v},${0.025 + rnd() * 0.03})`);
    grd.addColorStop(1, `rgba(${v},0)`);
    g.fillStyle = grd;
    for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) g.fillRect(x - r + ox, y - r + oy, r * 2, r * 2);
  }
  // rubber laid down along two racing lines and the middle
  for (const [cx, w, a] of [
    [0.3, 0.16, 0.2],
    [0.7, 0.16, 0.2],
    [0.5, 0.3, 0.1],
  ]) {
    const grd = g.createLinearGradient((cx - w / 2) * W, 0, (cx + w / 2) * W, 0);
    grd.addColorStop(0, 'rgba(8,8,10,0)');
    grd.addColorStop(0.5, `rgba(8,8,10,${a})`);
    grd.addColorStop(1, 'rgba(8,8,10,0)');
    g.fillStyle = grd;
    g.fillRect((cx - w / 2) * W, 0, w * W, H);
  }
  // aggregate grain with the odd bright stone
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const r = rnd();
    const n = (r - 0.5) * 24 + (r > 0.985 ? 30 : 0);
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n + 2;
  }
  g.putImageData(img, 0, 0);
  // panel joints (sealed, slightly darker and glossier) every 4 m, plus a fine crack network
  for (let y = 0; y < H; y += H / 4) {
    g.fillStyle = 'rgba(0,0,0,0.42)';
    g.fillRect(0, y, W, 3);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, y + 3, W, 1);
  }
  g.strokeStyle = 'rgba(0,0,0,0.16)';
  g.lineWidth = 1;
  for (let k = 0; k < 18; k++) {
    let x = rnd() * W;
    let y = rnd() * H;
    g.beginPath();
    g.moveTo(x, y);
    for (let j = 0; j < 6; j++) {
      x += (rnd() - 0.5) * 40;
      y += (rnd() - 0.5) * 40;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // edge lines (solid) with a coloured pinstripe inside, and a faint dashed centre line
  const edge = 18;
  g.fillStyle = 'rgba(236,240,250,0.9)';
  g.fillRect(edge, 0, 10, H);
  g.fillRect(W - edge - 10, 0, 10, H);
  g.fillStyle = 'rgba(70,200,255,0.75)';
  g.fillRect(edge + 16, 0, 3, H);
  g.fillStyle = 'rgba(255,80,210,0.75)';
  g.fillRect(W - edge - 19, 0, 3, H);
  g.fillStyle = 'rgba(236,240,250,0.4)';
  for (let y = 40; y < H; y += H / 4) g.fillRect(W / 2 - 3, y, 6, 110);
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
export function roadDetailTextures(): { normal: Texture; rough: Texture } | null {
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
  normal.repeat.set(5, 10);
  rough.repeat.set(1.5, 3);
  return { normal, rough };
}

/** Brushed, panelled titanium for the barriers and the deck's keel. */
function structureTexture(): Texture | null {
  const cv = canvas(256, 256);
  if (!cv) return null;
  const [c, g] = cv;
  g.fillStyle = '#b4bac4';
  g.fillRect(0, 0, 256, 256);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // brushed streaks along the track
  for (let k = 0; k < 400; k++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + rnd() * 0.04})`;
    g.fillRect(rnd() * 256, 0, 1, 256);
  }
  // panel seams and rivets
  g.fillStyle = 'rgba(0,0,0,0.22)';
  for (let y = 0; y < 256; y += 64) g.fillRect(0, y, 256, 2);
  g.fillStyle = 'rgba(255,255,255,0.3)';
  for (let y = 2; y < 256; y += 64) g.fillRect(0, y, 256, 1);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  for (let y = 8; y < 256; y += 64) for (let x = 8; x < 256; x += 32) g.fillRect(x, y, 2, 2);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Red / white kerb blocks, 2 m each, with a darker grooved edge. */
function kerbTexture(): Texture | null {
  const cv = canvas(64, 128);
  if (!cv) return null;
  const [c, g] = cv;
  g.fillStyle = '#d8231f';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#f2f2f0';
  g.fillRect(0, 64, 64, 64);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 3, 128);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 62, 64, 2);
  g.fillRect(0, 126, 64, 2);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
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

/** Soft scan-lines for the light tunnel's glass tube (additive, scrolls along the tube). */
function tunnelTexture(): Texture | null {
  const cv = canvas(64, 256);
  if (!cv) return null;
  const [c, g] = cv;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 256);
  for (let y = 0; y < 256; y += 16) {
    const grd = g.createLinearGradient(0, y, 0, y + 16);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, y, 64, 16);
  }
  // hexagonal cell edges across the tube
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(0, 0, 2, 256);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

export class StripBuilder {
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

interface Frame {
  pos: Vector3;
  up: Vector3;
  right: Vector3;
  fwd: Vector3;
}

/** Visual representation of a Track: deck chunks, barriers, kerbs, tunnel, boost pads and pickups. */
export class TrackView {
  readonly group = new Group();
  readonly layout: TrackLayout;
  private padTex: Texture | null;
  private tunnelTex: Texture | null = null;
  private pickups: InstancedMesh;
  private pickupHidden: number[];
  private pickupPos: Vector3[] = [];
  private ringColors: Color[] = [];
  private padMat: MeshBasicMaterial;
  private materials: Material[] = [];
  private textures: Texture[] = [];

  constructor(track: Track) {
    this.layout = analyseTrack(track);
    const layout = this.layout;
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
    roadMat.normalScale.set(0.35, 0.35);
    if (detail) this.textures.push(detail.normal, detail.rough);
    const structMat = withBakedLight(new MeshStandardMaterial({ map: structureTexture(), roughness: 0.32, metalness: 0.75, vertexColors: true }));
    const kerbMat = withBakedLight(new MeshStandardMaterial({ map: kerbTexture(), roughness: 0.55, metalness: 0, vertexColors: true }));
    const glassMat = new MeshStandardMaterial({
      color: new Color(0.62, 0.8, 1.0),
      roughness: 0.04,
      metalness: 0.2,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: DoubleSide,
      envMapIntensity: 1.6,
    });
    const lightMatL = new MeshBasicMaterial({ color: LEFT_GLOW.clone().multiplyScalar(2.2) });
    const lightMatR = new MeshBasicMaterial({ color: RIGHT_GLOW.clone().multiplyScalar(2.2) });
    const keelGlowMat = new MeshBasicMaterial({ color: new Color(0.5, 1.8, 2.8) });
    this.materials.push(roadMat, structMat, kerbMat, glassMat, lightMatL, lightMatR, keelGlowMat);
    for (const m of [roadMat, structMat, kerbMat]) if (m.map) this.textures.push(m.map);

    const ringS: number[] = [];
    const n = track.samples.length;
    for (let i = 0; i < n; i++) {
      const smp = track.samples[i];
      if (smp.tunnel && i % RING_SPACING === 0) ringS.push(i);
    }
    ringS.forEach((_, k) => this.ringColors.push(new Color().setHSL((0.52 + k * 0.035) % 1, 1, 0.5).multiplyScalar(2.2)));

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
    // warm pools under the lamp masts (they lean out over the road)
    const lampAt = new Int32Array(n).fill(-1);
    layout.lamps.forEach((l, k) => {
      for (let d = -14; d <= 14; d++) lampAt[(Math.round(l.s) + d + n) % n] = k;
    });
    const lampLight = (i: number, lat: number, h: number, out: Color) => {
      const k = lampAt[i];
      if (k < 0) return out;
      const l = layout.lamps[k];
      const ds = track.wrapS(i - l.s + track.length / 2) - track.length / 2;
      const dl = lat - l.side * (HALF_WIDTH - 2.2);
      const dh = h;
      const f = Math.exp(-(ds * ds) / 40 - (dl * dl) / 30 - (dh * dh) / 8);
      return addScaled(out, LAMP_LIGHT, 0.12 * f);
    };

    const roadProfile: ProfilePoint[] = [];
    for (let k = 0; k <= 8; k++) {
      const lat = -HALF_WIDTH + (2 * HALF_WIDTH * k) / 8;
      roadProfile.push({ lat, h: 0, u: (lat + HALF_WIDTH) / (2 * HALF_WIDTH) });
    }

    const p = new Vector3();
    const nrm = new Vector3();
    const tmpC = new Color();
    const light = new Color();
    const black = new Color(0, 0, 0);

    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(n, start + CHUNK);
      const road = new StripBuilder();
      const struct = new StripBuilder();
      const kerbs = new StripBuilder();
      const glass = new StripBuilder();
      const glowL = new StripBuilder();
      const glowR = new StripBuilder();
      const keelGlow = new StripBuilder();

      /**
       * Sweeps a cross-section along the chunk. The profile can change per sample
       * (or vanish, returning null, which breaks the strip).
       */
      const sweep = (
        b: StripBuilder,
        profile: ProfilePoint[] | ((i: number) => ProfilePoint[] | null),
        normalOf: (fr: Frame, out: Vector3) => Vector3,
        aoOf: (pt: ProfilePoint, i: number) => number,
        lightOf: (pt: ProfilePoint, i: number, out: Color) => Color,
        vScale = 1 / 16,
      ) => {
        let prevRow: number[] | null = null;
        for (let i = start; i <= end; i++) {
          const ii = i % n;
          const smp = track.samples[ii];
          const nextGap = track.samples[(ii + 1) % n].gap;
          const pts = typeof profile === 'function' ? profile(ii) : profile;
          if (smp.gap || !pts) {
            prevRow = null;
            continue;
          }
          const row: number[] = [];
          normalOf(smp, nrm);
          for (const pt of pts) {
            p.copy(smp.pos).addScaledVector(smp.right, pt.lat).addScaledVector(smp.up, pt.h);
            row.push(b.vert(p, nrm, pt.u, i * vScale, aoOf(pt, ii), lightOf(pt, ii, light)));
          }
          if (prevRow && prevRow.length === row.length) {
            for (let k = 0; k < pts.length - 1; k++) b.quad(prevRow[k], prevRow[k + 1], row[k], row[k + 1], nrm);
          }
          prevRow = nextGap ? null : row;
        }
      };
      /** Small box along the frame (barrier posts, rail caps), lat/h/length in the deck's frame. */
      const post = (b: StripBuilder, i: number, lat: number, h0: number, h1: number, w: number, d: number, ao = 0.85) => {
        const smp = track.samples[i];
        const c = p.copy(smp.pos).addScaledVector(smp.right, lat).clone();
        const axes: [Vector3, number][] = [
          [smp.right, w / 2],
          [smp.fwd, d / 2],
        ];
        for (const [ax, half] of axes) {
          const other = ax === smp.right ? smp.fwd : smp.right;
          const oh = ax === smp.right ? d / 2 : w / 2;
          for (const sgn of [-1, 1]) {
            const nn = ax.clone().multiplyScalar(sgn);
            const v = [
              [-oh, h0],
              [oh, h0],
              [-oh, h1],
              [oh, h1],
            ].map(([o, h]) =>
              b.vert(
                p.copy(c).addScaledVector(ax, sgn * half).addScaledVector(other, o).addScaledVector(smp.up, h),
                nn,
                0.3,
                h * 0.2,
                h === h0 ? ao * 0.7 : ao,
                black,
              ),
            );
            b.quad(v[0], v[1], v[2], v[3], nn);
          }
        }
      };

      // road surface: baked AO at the foot of the barrier, glow from rails / rings / pads / lamps
      sweep(
        road,
        roadProfile,
        (fr, o) => o.copy(fr.up),
        (pt) => 1 - 0.38 * smoothstep(HALF_WIDTH - 1.4, HALF_WIDTH, Math.abs(pt.lat)),
        (pt, i, o) => {
          ringLight(i, o);
          const e = smoothstep(HALF_WIDTH - 2.0, HALF_WIDTH, Math.abs(pt.lat)) * 0.1;
          addScaled(o, pt.lat < 0 ? LEFT_GLOW : RIGHT_GLOW, e);
          lampLight(i, pt.lat, 0, o);
          return padLight(i, pt.lat, o);
        },
      );

      for (const side of [-1, 1]) {
        const glowC = side < 0 ? LEFT_GLOW : RIGHT_GLOW;
        const sideLight = (pt: ProfilePoint, i: number, o: Color) => {
          ringLight(i, o).multiplyScalar(0.6);
          addScaled(o, glowC, pt.h > 0 ? 0.03 : 0);
          return lampLight(i, pt.lat, pt.h, o);
        };
        // kerbs: a low ramped strip inside the barrier on the corners
        sweep(
          kerbs,
          (i) => {
            const k = layout.kerb[i];
            if (k <= 0) return null;
            const inner = HALF_WIDTH - 0.15 - 1.5 * k;
            return [
              { lat: side * inner, h: 0.005, u: 0 },
              { lat: side * (inner + 0.3 * k), h: 0.06 * k, u: 0.25 },
              { lat: side * (HALF_WIDTH - 0.02), h: 0.06 * k, u: 1 },
            ];
          },
          (fr, o) => o.copy(fr.up),
          () => 0.95,
          (pt, i, o) => lampLight(i, pt.lat, 0, ringLight(i, o)),
          1 / 4,
        );
        // barrier base: inner face, top
        sweep(
          struct,
          [
            { lat: side * HALF_WIDTH, h: 0, u: 0 },
            { lat: side * HALF_WIDTH, h: BASE_H, u: 0.1 },
          ],
          (fr, o) => o.copy(fr.right).multiplyScalar(-side),
          (pt) => (pt.h < 0.1 ? 0.45 : 0.85),
          sideLight,
          1 / 8,
        );
        sweep(
          struct,
          [
            { lat: side * HALF_WIDTH, h: BASE_H, u: 0.1 },
            { lat: side * OUTER, h: BASE_H, u: 0.2 },
          ],
          (fr, o) => o.copy(fr.up),
          (pt) => (Math.abs(pt.lat) > HALF_WIDTH + GLASS_IN ? 1 : 0.8),
          sideLight,
          1 / 8,
        );
        // glass panel
        sweep(
          glass,
          [
            { lat: side * (HALF_WIDTH + GLASS_IN), h: BASE_H, u: 0 },
            { lat: side * (HALF_WIDTH + GLASS_IN), h: RAIL_TOP, u: 1 },
          ],
          (fr, o) => o.copy(fr.right).multiplyScalar(-side),
          () => 1,
          () => black,
          1 / 8,
        );
        // top rail: a slim tube over the glass
        const rIn = side * (HALF_WIDTH + GLASS_IN - 0.11);
        const rOut = side * (HALF_WIDTH + GLASS_IN + 0.11);
        sweep(
          struct,
          [
            { lat: rIn, h: RAIL_TOP - 0.02, u: 0.3 },
            { lat: rIn, h: RAIL_TOP + 0.14, u: 0.32 },
            { lat: rOut, h: RAIL_TOP + 0.14, u: 0.34 },
            { lat: rOut, h: RAIL_TOP - 0.02, u: 0.36 },
          ],
          (fr, o) => o.copy(fr.up),
          () => 1,
          sideLight,
          1 / 8,
        );
        // outer fascia down to the keel
        sweep(
          struct,
          [
            { lat: side * OUTER, h: BASE_H, u: 0.2 },
            { lat: side * OUTER, h: -FASCIA, u: 0.45 },
          ],
          (fr, o) => o.copy(fr.right).multiplyScalar(side),
          (pt) => (pt.h < 0 ? 0.75 : 1),
          sideLight,
          1 / 8,
        );
        // keel: slopes in under the deck
        {
          const a = OUTER - KEEL_HALF;
          const b = KEEL - FASCIA;
          const l = Math.hypot(a, b);
          sweep(
            struct,
            [
              { lat: side * OUTER, h: -FASCIA, u: 0.45 },
              { lat: side * KEEL_HALF, h: -KEEL, u: 0.8 },
            ],
            (fr, o) => o.copy(fr.right).multiplyScalar((side * b) / l).addScaledVector(fr.up, -a / l),
            (pt) => (pt.h < -KEEL + 0.1 ? 0.5 : 0.7),
            (pt, i, o) => {
              ringLight(i, o).multiplyScalar(0.4);
              const d = ((i % 60) + 60) % 60;
              const k = Math.exp(-((Math.min(d, 60 - d) / 7) ** 2)) * (pt.h < -KEEL + 0.1 ? 1 : 0.35);
              return o.setRGB(o.r + 0.2 * k, o.g + 0.5 * k, o.b + 0.75 * k);
            },
            1 / 8,
          );
        }
        // LED lines: under the top rail (facing the road) and along the fascia
        const gb = side < 0 ? glowL : glowR;
        sweep(
          gb,
          [
            { lat: rIn - side * 0.005, h: RAIL_TOP + 0.02, u: 0 },
            { lat: rIn - side * 0.005, h: RAIL_TOP + 0.09, u: 1 },
          ],
          (fr, o) => o.copy(fr.right).multiplyScalar(-side),
          () => 1,
          () => black,
        );
        sweep(
          gb,
          [
            { lat: side * (OUTER + 0.01), h: -0.12, u: 0 },
            { lat: side * (OUTER + 0.01), h: -0.24, u: 1 },
          ],
          (fr, o) => o.copy(fr.right).multiplyScalar(side),
          () => 1,
          () => black,
        );
        // posts holding the glass every 3 m
        for (let i = start; i < end; i++) {
          if (i % 3 || track.samples[i].gap || track.samples[(i + 1) % n].gap || track.samples[(i - 1 + n) % n].gap) continue;
          post(struct, i, side * (HALF_WIDTH + GLASS_IN), BASE_H - 0.02, RAIL_TOP, 0.1, 0.1);
        }
        void glowC;
        void tmpC;
      }
      // keel underside, with a light strip down the middle
      sweep(
        struct,
        [
          { lat: KEEL_HALF, h: -KEEL, u: 0.8 },
          { lat: -KEEL_HALF, h: -KEEL, u: 1 },
        ],
        (fr, o) => o.copy(fr.up).multiplyScalar(-1),
        () => 0.5,
        (_pt, i, o) => {
          ringLight(i, o).multiplyScalar(0.3);
          const d = ((i % 60) + 60) % 60;
          const k = Math.exp(-((Math.min(d, 60 - d) / 6) ** 2));
          return o.setRGB(o.r + 0.25 * k, o.g + 0.6 * k, o.b + 0.9 * k);
        },
        1 / 8,
      );
      sweep(
        keelGlow,
        [
          { lat: 0.35, h: -KEEL - 0.01, u: 0 },
          { lat: -0.35, h: -KEEL - 0.01, u: 1 },
        ],
        (fr, o) => o.copy(fr.up).multiplyScalar(-1),
        () => 1,
        () => black,
      );

      // end caps where the deck meets a gap
      for (let i = start; i < end; i++) {
        const a = track.samples[i];
        const b = track.samples[(i + 1) % n];
        if (a.gap === b.gap) continue;
        const smp = a.gap ? b : a;
        const facing = a.gap ? -1 : 1;
        nrm.copy(smp.fwd).multiplyScalar(facing);
        const outline = [
          [-OUTER, BASE_H],
          [OUTER, BASE_H],
          [OUTER, -FASCIA],
          [KEEL_HALF, -KEEL],
          [-KEEL_HALF, -KEEL],
          [-OUTER, -FASCIA],
        ].map(([lat, h]) => struct.vert(p.copy(smp.pos).addScaledVector(smp.right, lat).addScaledVector(smp.up, h), nrm, 0, 0, 0.8, black));
        struct.quad(outline[0], outline[1], outline[5], outline[2], nrm);
        struct.quad(outline[5], outline[2], outline[4], outline[3], nrm);
      }

      for (const [b, m] of [
        [road, roadMat],
        [struct, structMat],
        [kerbs, kerbMat],
        [glass, glassMat],
        [glowL, lightMatL],
        [glowR, lightMatR],
        [keelGlow, keelGlowMat],
      ] as [StripBuilder, Material][]) {
        const g = b.build();
        if (!g) continue;
        const mesh = new Mesh(g, m);
        mesh.receiveShadow = m === roadMat || m === structMat || m === kerbMat;
        if (m === glassMat) mesh.renderOrder = 2;
        this.group.add(mesh);
      }
    }

    // light tunnel: hexagonal rings (instanced, per-instance colour) inside a glowing glass tube
    if (ringS.length) {
      const ringGeo = new TorusGeometry(TUNNEL_RADIUS, 0.42, 4, 6);
      ringGeo.rotateZ(Math.PI / 6);
      const ringMat = new MeshBasicMaterial({ color: 0xffffff });
      this.materials.push(ringMat);
      const rings = new InstancedMesh(ringGeo, ringMat, ringS.length);
      const m = new Matrix4();
      const q = new Quaternion();
      ringS.forEach((i, k) => {
        const smp = track.samples[i];
        // (right, up, fwd) is left-handed; flip z so the quaternion is a real rotation
        m.makeBasis(smp.right, smp.up, smp.fwd.clone().negate());
        q.setFromRotationMatrix(m);
        const { axis, radius } = tunnelAxis(smp);
        const r = radius / TUNNEL_RADIUS;
        m.compose(smp.pos.clone().addScaledVector(smp.up, axis), q, new Vector3(r, r, r));
        rings.setMatrixAt(k, m);
        rings.setColorAt(k, this.ringColors[k]);
      });
      rings.computeBoundingSphere();
      this.group.add(rings);

      this.tunnelTex = tunnelTexture();
      const tubeMat = new MeshBasicMaterial({
        map: this.tunnelTex,
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      });
      this.materials.push(tubeMat);
      const tube = new StripBuilder();
      const SIDES = 6;
      let prev: number[] | null = null;
      const first = ringS[0] - 4;
      const last = ringS[ringS.length - 1] + 4;
      const col = new Color();
      for (let i = first; i <= last; i++) {
        const smp = track.sample(i);
        const { axis, radius } = tunnelAxis(smp);
        const c = p.copy(smp.pos).addScaledVector(smp.up, axis).clone();
        const fade = Math.min(1, (i - first) / 14, (last - i) / 14);
        col.setHSL((0.52 + ((i - ringS[0]) / RING_SPACING) * 0.035) % 1, 1, 0.5).multiplyScalar(0.55 * Math.max(0, fade));
        const row: number[] = [];
        for (let k = 0; k <= SIDES; k++) {
          const a = (k / SIDES) * Math.PI * 2 + Math.PI / 6;
          const dir = nrm.copy(smp.right).multiplyScalar(Math.cos(a)).addScaledVector(smp.up, Math.sin(a));
          // the floor stays clear so the road reads cleanly
          const floor = Math.sin(a) < -0.6 ? 0 : 1;
          tube.vert(p.copy(c).addScaledVector(dir, radius - 0.25), dir, k / SIDES, i / 24, 1, black);
          tube.col.splice(tube.col.length - 3, 3, col.r * floor, col.g * floor, col.b * floor);
          row.push(tube.pos.length / 3 - 1);
        }
        if (prev) for (let k = 0; k < SIDES; k++) tube.quad(prev[k], prev[k + 1], row[k], row[k + 1], nrm.copy(smp.up));
        prev = row;
      }
      const g = tube.build();
      if (g) {
        const mesh = new Mesh(g, tubeMat);
        mesh.renderOrder = 3;
        this.group.add(mesh);
      }
    }

    // anti-gravity emitters under the keel
    {
      const idx: number[] = [];
      for (let i = 0; i < n; i += 60) if (!track.samples[i].gap) idx.push(i);
      const geo = new TorusGeometry(2.4, 0.28, 6, 24);
      const mat = new MeshBasicMaterial({ color: new Color(0.6, 2.2, 3.2) });
      this.materials.push(mat);
      const em = new InstancedMesh(geo, mat, idx.length);
      const m = new Matrix4();
      const q = new Quaternion();
      idx.forEach((i, k) => {
        const smp = track.samples[i];
        m.makeBasis(smp.right, smp.fwd, smp.up);
        q.setFromRotationMatrix(m);
        m.compose(smp.pos.clone().addScaledVector(smp.up, -KEEL - 0.15), q, new Vector3(1, 1, 1));
        em.setMatrixAt(k, m);
      });
      em.computeBoundingSphere();
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

    // start / finish line (the gantry over it is part of the roadside structures)
    {
      const fr = track.frameAt(2);
      const lineTex = checkerTexture();
      const lineMat = new MeshBasicMaterial({ map: lineTex, polygonOffset: true, polygonOffsetFactor: -2 });
      this.materials.push(lineMat);
      if (lineTex) this.textures.push(lineTex);
      const b = new StripBuilder();
      const row = (s: number, v: number) => {
        const f = track.frameAt(s);
        return [-HALF_WIDTH, HALF_WIDTH].map((lat, k) => b.vert(p.copy(f.pos).addScaledVector(f.right, lat).addScaledVector(f.up, 0.03), f.up, k, v, 1, black));
      };
      const r0 = row(1, 0);
      const r1 = row(3, 1);
      b.quad(r0[0], r0[1], r1[0], r1[1], fr.up);
      this.group.add(new Mesh(b.build()!, lineMat));
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
    if (this.tunnelTex) this.tunnelTex.offset.y = -time * 0.9;
    for (let i = 0; i < this.pickupPos.length; i++) {
      if (this.pickupHidden[i] > 0) this.pickupHidden[i] -= dt;
      const visible = this.pickupHidden[i] <= 0;
      Q.setFromAxisAngle(UP, time * 2 + i);
      const s = visible ? 1 : 0;
      V.copy(this.pickupPos[i]);
      V.y += Math.sin(time * 3 + i) * 0.25;
      M.compose(V, Q, S.set(s, s * 1.4, s));
      this.pickups.setMatrixAt(i, M);
    }
    this.pickups.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.group.traverse((o) => {
      if ((o as Mesh).geometry) (o as Mesh).geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.padTex?.dispose();
    this.tunnelTex?.dispose();
    for (const t of this.textures) t.dispose();
  }
}

const M = new Matrix4();
const Q = new Quaternion();
const V = new Vector3();
const S = new Vector3();
const UP = new Vector3(0, 1, 0);

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
