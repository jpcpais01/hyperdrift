import {
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Track } from '../track/track';
import { ATMOSPHERE_GLSL, CLOUD_Y, SUN_DIR } from './atmosphere';

/** What the decor reads from a track; the drift zone passes bare points instead. */
type DecorTrack = Pick<Track, 'samples' | 'marks' | 'frameAt'>;

export function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 3D value noise + fbm, used once at load to sculpt and bake the islands. */
export function noise3(x: number, y: number, z: number) {
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
export function fbm3(x: number, y: number, z: number, oct = 4) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    v += a * noise3(x * f, y * f, z * f);
    f *= 2.07;
    a *= 0.5;
  }
  return v / (1 - Math.pow(0.5, oct));
}

// linear albedos and light colours for the bake (matched to the sky's sun / haze)
const GRASS_A = new Color(0.08, 0.19, 0.04);
const GRASS_B = new Color(0.2, 0.26, 0.07);
const MOSS = new Color(0.12, 0.16, 0.06);
const ROCK_A = new Color(0.34, 0.24, 0.17);
const ROCK_B = new Color(0.22, 0.16, 0.13);
const ROCK_PALE = new Color(0.46, 0.4, 0.34);
const DEEP = new Color(0.07, 0.055, 0.08);
const SUN_C = new Color(1.0, 0.72, 0.46).multiplyScalar(2.6);
const SKY_C = new Color(0.32, 0.38, 0.66);
const BOUNCE_C = new Color(0.5, 0.42, 0.55);

/** Soft sun + sky dome + cloud-sea bounce, shared by every baked prop. */
function bakeLight(nv: Vector3, ao: number, out: Color): Color {
  const ndl = nv.dot(SUN_DIR);
  const wrap = Math.max(0, (ndl + 0.25) / 1.25);
  out.copy(SUN_C).multiplyScalar(wrap * wrap * (0.6 + 0.4 * ao));
  out.r += (SKY_C.r * (0.5 + 0.5 * nv.y) + BOUNCE_C.r * (0.5 - 0.5 * nv.y)) * ao;
  out.g += (SKY_C.g * (0.5 + 0.5 * nv.y) + BOUNCE_C.g * (0.5 - 0.5 * nv.y)) * ao;
  out.b += (SKY_C.b * (0.5 + 0.5 * nv.y) + BOUNCE_C.b * (0.5 - 0.5 * nv.y)) * ao;
  return out;
}

/**
 * Floating island mesh: a grassy plateau with a mossy lip, a band of sheer
 * cliffs, then a rocky underside that hangs in several dripping lobes.
 * All lighting is baked into vertex colours (soft-wrapped sun, sky dome, lavender bounce from the
 * cloud sea, cavity + height AO), so it renders with an unlit material: one cheap draw per LOD.
 * The bake is in object space, so instances are scaled but never rotated.
 */
export function islandGeometry(detail: number, seed: number): BufferGeometry {
  let g: BufferGeometry = new IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  const cav = new Float32Array(pos.count);
  const kind = new Float32Array(pos.count);
  const o = seed * 17.3;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm3(v.x * 2.2 + o, v.y * 2.2, v.z * 2.2 - o, 4);
    const outline = 0.78 + n * 0.42;
    cav[i] = n;
    const ang = Math.atan2(v.z, v.x);
    if (v.y > 0.35) {
      // plateau with a gently rolling top and the odd knoll
      const roll = (fbm3(v.x * 3 + o, 0.5, v.z * 3, 3) - 0.5) * 0.09 + Math.pow(noise3(v.x * 2 + o, 3, v.z * 2), 4) * 0.12;
      const r = outline * Math.min(1, Math.sqrt(1 - v.y * v.y) / 0.94);
      v.set(Math.cos(ang) * r, 0.12 + roll + (v.y - 0.35) * 0.05, Math.sin(ang) * r);
      kind[i] = 0;
    } else if (v.y > -0.05) {
      // the cliff band: near-vertical rock wall under a slight overhang
      const t = (0.35 - v.y) / 0.4;
      const r = outline * (1.02 - t * 0.08) + (noise3(v.x * 9 + o, v.y * 9, v.z * 9) - 0.5) * 0.06;
      v.set(Math.cos(ang) * r, 0.12 - t * 0.32, Math.sin(ang) * r);
      kind[i] = 1;
    } else {
      // underside: hanging lobes, each tapering to a dripping point
      const k = Math.min(1, (-v.y + 0.05) / 1.05);
      const lobes = Math.pow(fbm3(Math.cos(ang) * 1.6 + o, Math.sin(ang) * 1.6, 3.3, 3), 2) * 2.2;
      const depth = 0.9 + lobes + Math.pow(noise3(v.x * 5 + o, 0, v.z * 5), 3) * 1.1 + n * 0.5;
      const taper = Math.pow(1 - k, 0.85) * 0.94;
      const r = outline * taper;
      // radial wobble so the drips twist a little
      v.set(Math.cos(ang + k * 0.4) * r, -0.2 - Math.pow(k, 1.15) * depth, Math.sin(ang + k * 0.4) * r);
      kind[i] = 2;
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
    const grassy = kind[i] === 0 && nv.y > 0.45;
    if (grassy) {
      c.copy(GRASS_A).lerp(GRASS_B, fbm3(v.x * 6 + 3 * seed, 1, v.z * 6, 2));
      // pale bare-rock patches and a mossy rim at the cliff edge
      const bare = Math.max(0, fbm3(v.x * 4, 7 + seed, v.z * 4, 3) - 0.62) * 3;
      c.lerp(ROCK_PALE, Math.min(0.7, bare));
    } else if (kind[i] === 1) {
      const band = 0.5 + 0.5 * Math.sin(v.y * 40 + cav[i] * 6);
      c.copy(ROCK_PALE).lerp(ROCK_A, band * 0.7);
      if (v.y > 0.08) c.lerp(MOSS, 0.6);
    } else {
      // sedimentary bands, darker and cooler with depth
      const band = 0.5 + 0.5 * Math.sin(v.y * 16 + cav[i] * 5);
      c.copy(ROCK_A).lerp(ROCK_B, band).lerp(DEEP, Math.min(1, -v.y / 2.4));
    }
    const ao = (0.55 + 0.45 * cav[i]) * (v.y < 0 ? 1 - Math.min(0.55, -v.y * 0.25) : 1);
    bakeLight(nv, ao, light);
    // grass catches a warm rim when back-lit
    if (grassy) light.add(tmpC.copy(SUN_C).multiplyScalar(Math.max(0, -nv.dot(SUN_DIR)) * 0.08));
    colors.push(c.r * light.r, c.g * light.g, c.b * light.b);
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

/** A lumpy, baked boulder for the debris field. */
function rockGeometry(): BufferGeometry {
  let g: BufferGeometry = new IcosahedronGeometry(1, 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 0.7 + fbm3(v.x * 1.7 + 4, v.y * 1.7, v.z * 1.7, 3) * 0.6;
    pos.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  const p2 = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const col: number[] = [];
  const nv = new Vector3();
  const c = new Color();
  const light = new Color();
  for (let i = 0; i < p2.count; i++) {
    v.fromBufferAttribute(p2, i);
    nv.fromBufferAttribute(nrm, i);
    c.copy(ROCK_A).lerp(ROCK_B, hash3(Math.floor(i / 3), 1, 2)).lerp(DEEP, Math.max(0, -v.y) * 0.5);
    bakeLight(nv, 0.6 + 0.4 * (v.y * 0.5 + 0.5), light);
    col.push(c.r * light.r, c.g * light.g, c.b * light.b);
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  return g;
}

/** Baked low-poly tree (conifer or broadleaf), ~1 unit tall, pivot at the base. */
function treeGeometry(kind: 0 | 1): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const trunk = new CylinderGeometry(0.03, 0.05, kind ? 0.45 : 0.3, 5).translate(0, kind ? 0.22 : 0.15, 0);
  parts.push(trunk);
  if (kind === 0) {
    for (let k = 0; k < 3; k++) parts.push(new ConeGeometry(0.32 - k * 0.07, 0.42, 7).translate(0, 0.32 + k * 0.22, 0));
  } else {
    for (const [x, y, z, r] of [
      [0, 0.62, 0, 0.3],
      [0.16, 0.5, 0.06, 0.2],
      [-0.14, 0.52, -0.08, 0.22],
    ]) {
      const blob = new IcosahedronGeometry(r, 1);
      const p = blob.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const s = 0.85 + 0.3 * hash3(p.getX(i) * 9, p.getY(i) * 9, p.getZ(i) * 9);
        p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i) * s);
      }
      blob.computeVertexNormals();
      parts.push(blob.translate(x, y, z));
    }
  }
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  for (const p of flat) if (p.getAttribute('uv')) p.deleteAttribute('uv');
  const g = mergeGeometries(flat, false)!;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const col: number[] = [];
  const v = new Vector3();
  const nv = new Vector3();
  const light = new Color();
  const leaf = kind ? new Color(0.13, 0.22, 0.05) : new Color(0.05, 0.13, 0.06);
  const bark = new Color(0.12, 0.08, 0.05);
  const trunkVerts = trunk.index ? trunk.index.count : trunk.getAttribute('position').count;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    nv.fromBufferAttribute(nrm, i);
    const isBark = i < trunkVerts;
    const ao = 0.45 + 0.55 * Math.min(1, v.y / 0.9);
    bakeLight(nv, ao, light);
    const c = isBark ? bark : leaf;
    col.push(c.r * light.r, c.g * light.g, c.b * light.b);
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  return g;
}

/** Falling water: soft vertical streaks with alpha, scrolled down the ribbon. */
function waterfallTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  if (!g) return null;
  // a thin sheet of water behind the streaks
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.fillRect(0, 0, 128, 256);
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 140; k++) {
    const x = rnd() * 128;
    const y = rnd() * 256;
    const w = 1 + rnd() * 5;
    const h = 30 + rnd() * 120;
    const a = 0.3 + rnd() * 0.55;
    // one gradient per wrapped copy, so streaks run seamlessly across the tile edge
    for (const oy of [-256, 0, 256]) {
      const grd = g.createLinearGradient(0, y + oy, 0, y + oy + h);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5, `rgba(255,255,255,${a})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(x, y + oy, w, h);
    }
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

/** 2x2 atlas of cumulus puffs (density in alpha, a little self-shadow baked into the value). */
function puffTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S * 2;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(S * 2, S * 2);
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * S;
    const oy = Math.floor(q / 2) * S;
    // a cluster of soft balls, flatter at the bottom
    const balls: [number, number, number][] = [];
    for (let k = 0; k < 7; k++) {
      const a = hash3(q, k, 1) * Math.PI * 2;
      const r = hash3(q, k, 2) * 0.22;
      balls.push([0.5 + Math.cos(a) * r, 0.52 + Math.sin(a) * r * 0.6 - 0.05, 0.16 + hash3(q, k, 3) * 0.12]);
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S;
        const v = y / S;
        let d = 0;
        for (const [bx, by, br] of balls) {
          const dx = (u - bx) / br;
          const dy = (v - by) / br;
          d = Math.max(d, 1 - (dx * dx + dy * dy));
        }
        const n = fbm3(u * 7 + q * 10, v * 7, q, 4);
        let a = Math.max(0, d * 1.3 + (n - 0.5) * 0.9 - 0.15);
        a *= Math.min(1, Math.max(0, (0.86 - v) * 6)); // flat base
        a = Math.min(1, a);
        const o = ((oy + y) * S * 2 + ox + x) * 4;
        // value: brighter towards the top of each ball cluster (cheap self-shadow)
        const lit = Math.min(1, Math.max(0, 0.55 + (0.5 - v) * 0.9 + (n - 0.5) * 0.4));
        img.data[o] = img.data[o + 1] = img.data[o + 2] = lit * 255;
        img.data[o + 3] = a * a * (3 - 2 * a) * 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  return t;
}

const puffVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  varying float vFade;
  varying float vTile;
  void main() {
    vec4 c4 = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 centre = c4.xyz;
    float size = length(instanceMatrix[0].xyz);
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 wp = centre + (camRight * position.x + camUp * position.y * 0.62) * size;
    vUv = uv;
    vWorld = wp;
    float d = distance(cameraPosition, centre);
    // fade out when the camera flies into a puff (no hard clipping, less overdraw)
    vFade = smoothstep(size * 0.35, size * 0.95, d);
    vTile = floor(fract(sin(dot(centre.xz, vec2(12.9898, 78.233))) * 43758.5453) * 4.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const puffFrag = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 uCam;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying float vFade;
  varying float vTile;
  ${ATMOSPHERE_GLSL}
  void main() {
    vec2 tile = vec2(mod(vTile, 2.0), floor(vTile / 2.0)) * 0.5;
    vec4 t = texture2D(map, tile + vUv * 0.5);
    float a = t.a * vFade;
    if (a < 0.01) discard;
    vec3 v = normalize(vWorld - uCam);
    // lit side towards the sun, lavender shadow underneath, silver lining against the light
    float sunSide = clamp(dot(normalize(vec3(ATM_SUN.x, 0.0, ATM_SUN.z)), -v) * 0.5 + 0.5, 0.0, 1.0);
    vec3 shadow = vec3(0.38, 0.38, 0.6);
    vec3 lit = ATM_SUN_COL * 1.6 + vec3(0.2, 0.22, 0.35);
    vec3 col = mix(shadow, lit, clamp(t.r * (0.55 + 0.45 * sunSide), 0.0, 1.0));
    col += ATM_SUN_COL * atmPhase(clamp(dot(v, ATM_SUN), -1.0, 1.0), 0.6) * (1.0 - t.a) * 2.5;
    float dist = length(vWorld - uCam);
    float f = 1.0 - exp(-dist / 1600.0);
    col = mix(col, atmHaze(v), clamp(f * f * 1.2, 0.0, 1.0));
    gl_FragColor = vec4(col, a * 0.92);
  }
`;

interface Island {
  pos: Vector3;
  scale: number;
  stretch: number;
  variant: number;
  /** placed by hand around a set piece (never culled to the low LOD) */
  hero?: boolean;
}

const ISLAND_VARIANTS = 3;

/**
 * Scenery: floating islands with forests and waterfalls (instanced, two LODs),
 * the crystal spire the helix winds around, cumulus banks drifting between the
 * decks, floating rock debris, colossal mesas on the horizon and the giant sky rings.
 */
export class Decor {
  readonly group = new Group();
  private islands: Island[] = [];
  private hi: InstancedMesh[] = [];
  private lo: InstancedMesh[] = [];
  private lodTimer = 0;
  private rings: Group[] = [];
  private fallTex: Texture | null = null;
  private puffMat: ShaderMaterial | null = null;
  private spireGlow: MeshBasicMaterial | null = null;
  private materials: Material[] = [];

  /**
   * @param src the lap to dress (islands, hero island, crystal spire), or for the drift zone
   * just the points its islands must keep clear of
   */
  constructor(src: Track | Vector3[]) {
    const track: DecorTrack = Array.isArray(src)
      ? { samples: src.map((pos) => ({ pos })) as unknown as Track['samples'], marks: {}, frameAt: () => { throw new Error('no track'); } }
      : src;
    const avoid = track.samples.map((p) => p.pos);
    // a lap is sampled every metre, so a coarse stride is plenty; bare points are already sparse
    const dense = !Array.isArray(src);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of avoid) {
      min = min.min(p);
      max = max.max(p);
    }
    const centre = min.clone().add(max).multiplyScalar(0.5);
    /** level direction across the deck; bare points have no frame, so pick any heading */
    const sideways = (smp: { right?: Vector3 }) => {
      if (smp.right) return smp.right.clone().setY(0).normalize();
      const a = rnd() * Math.PI * 2;
      return new Vector3(Math.cos(a), 0, Math.sin(a));
    };
    const clearOf = (p: Vector3, r: number) => {
      for (let i = 0; i < track.samples.length; i += dense ? 8 : 1) if (track.samples[i].pos.distanceTo(p) < r) return false;
      return true;
    };
    /** Centre of the circle a turning stretch of the lap is drawn around (its centroid would sit off-centre). */
    const arcCentre = (name: string) => {
      const m = track.marks[name];
      if (!m) return null;
      const c = new Vector3();
      let k = 0;
      for (let s = m.s0 + 10; s < m.s1 - 10; s += 5) {
        const a = track.frameAt(s - 5).fwd.clone().setY(0).normalize();
        const b = track.frameAt(s + 5).fwd.clone().setY(0).normalize();
        const turn = Math.atan2(a.x * b.z - a.z * b.x, a.dot(b));
        if (Math.abs(turn) < 1e-4) continue;
        const f = track.frameAt(s);
        // turning left (positive yaw) the centre is on the left
        const left = new Vector3(f.fwd.z, 0, -f.fwd.x).normalize();
        const r = 10 / Math.abs(turn);
        c.add(f.pos.clone().addScaledVector(left, (turn < 0 ? 1 : -1) * r));
        k++;
      }
      return k ? c.multiplyScalar(1 / k) : null;
    };

    // --- hero islands around the set pieces
    const hairpin = arcCentre('hairpin');
    const hairpinIsland: Island | null = hairpin
      ? { pos: new Vector3(hairpin.x, track.frameAt(track.marks.hairpin.s0 + 125).pos.y - 16, hairpin.z), scale: 46, stretch: 1, variant: 0, hero: true }
      : null;
    if (hairpinIsland) this.islands.push(hairpinIsland);
    const helix = arcCentre('helix');

    // --- the free-floating archipelago, keeping clear of every deck
    const pad = 750;
    let tries = 0;
    while (this.islands.length < 80 && tries++ < 6000) {
      const p = new Vector3(min.x - pad + rnd() * (max.x - min.x + pad * 2), min.y - 170 + rnd() * 280, min.z - pad + rnd() * (max.z - min.z + pad * 2));
      const scale = 12 + rnd() * rnd() * 72;
      if (!clearOf(p, scale * 1.8 + 50)) continue;
      if (helix && p.distanceTo(helix) < 160) continue;
      if (this.islands.some((o) => o.pos.distanceTo(p) < (o.scale + scale) * 1.6)) continue;
      this.islands.push({ pos: p, scale, stretch: 0.8 + rnd() * 0.45, variant: this.islands.length % ISLAND_VARIANTS });
    }
    // colossal mesas far out on the horizon
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + rnd() * 0.4;
      const r = 1900 + rnd() * 900;
      this.islands.push({
        pos: new Vector3(centre.x + Math.cos(a) * r, CLOUD_Y + 40 + rnd() * 160, centre.z + Math.sin(a) * r),
        scale: 160 + rnd() * 180,
        stretch: 0.7 + rnd() * 0.6,
        variant: k % ISLAND_VARIANTS,
      });
    }

    // fully baked: an unlit material is all the islands need
    const mat = new MeshBasicMaterial({ vertexColors: true });
    this.materials.push(mat);
    for (let v = 0; v < ISLAND_VARIANTS; v++) {
      const hi = new InstancedMesh(islandGeometry(7, v + 1), mat, this.islands.length);
      const lo = new InstancedMesh(islandGeometry(3, v + 1), mat, this.islands.length);
      hi.frustumCulled = lo.frustumCulled = false;
      this.hi.push(hi);
      this.lo.push(lo);
      this.group.add(hi, lo);
    }

    // --- forests on the island tops
    {
      const trees: { p: Vector3; s: number; kind: 0 | 1 }[] = [];
      for (const isl of this.islands) {
        if (isl.scale < 22 || isl.scale > 150) continue;
        // forests only where you can make them out: on islands that come within sight of the deck
        let near = isl.hero;
        for (let i = 0; i < track.samples.length && !near; i += dense ? 25 : 1) near = track.samples[i].pos.distanceTo(isl.pos) < 420 + isl.scale;
        if (!near) continue;
        const count = Math.floor(isl.scale * (isl.hero ? 1.6 : 0.6));
        for (let k = 0; k < count; k++) {
          const a = rnd() * Math.PI * 2;
          const r = Math.sqrt(rnd()) * 0.62;
          const lx = Math.cos(a) * r;
          const lz = Math.sin(a) * r;
          // follow the plateau's roll roughly (it sits ~0.12 above the island's origin)
          const h = 0.11 + (fbm3(lx * 3 + (isl.variant + 1) * 17.3, 0.5, lz * 3, 3) - 0.5) * 0.09;
          const p = new Vector3(isl.pos.x + lx * isl.scale * isl.stretch, isl.pos.y + h * isl.scale, isl.pos.z + (lz * isl.scale) / isl.stretch);
          trees.push({ p, s: 5 + rnd() * 7 + isl.scale * 0.04, kind: rnd() < 0.62 ? 0 : 1 });
        }
      }
      const tmat = new MeshBasicMaterial({ vertexColors: true });
      this.materials.push(tmat);
      for (const kind of [0, 1] as const) {
        const list = trees.filter((t) => t.kind === kind);
        if (!list.length) continue;
        const inst = new InstancedMesh(treeGeometry(kind), tmat, list.length);
        const m = new Matrix4();
        list.forEach((t, k) => {
          m.makeScale(t.s * (0.8 + hash3(t.p.x, 1, t.p.z) * 0.4), t.s, t.s * (0.8 + hash3(t.p.z, 2, t.p.x) * 0.4)).setPosition(t.p);
          inst.setMatrixAt(k, m);
        });
        inst.computeBoundingSphere();
        this.group.add(inst);
      }
    }

    // --- waterfalls pouring off the bigger islands into the void
    const puffs: { p: Vector3; size: number }[] = [];
    {
      this.fallTex = waterfallTexture();
      const falls: BufferGeometry[] = [];
      const candidates = this.islands.filter((i) => i.hero || (i.scale > 34 && i.scale < 150)).slice(0, 12);
      for (const isl of candidates) {
        const n = isl.hero ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const a = hash3(isl.pos.x, k, isl.pos.z) * Math.PI * 2;
          const dir = new Vector3(Math.cos(a), 0, Math.sin(a));
          // leave from just outside the cliff band's lip
          const edge = isl.pos.clone().add(new Vector3(dir.x * isl.scale * isl.stretch * 1.02, isl.scale * 0.1, (dir.z * isl.scale * 1.02) / isl.stretch));
          const width = isl.scale * 0.17;
          const height = isl.scale * 3.2;
          const g = waterfallRibbon(width, height, edge, dir);
          falls.push(g);
          puffs.push({ p: edge.clone().addScaledVector(dir, height * 0.12).add(new Vector3(0, -height * 0.92, 0)), size: width * 5 });
        }
      }
      if (falls.length && this.fallTex) {
        const fmat = new MeshBasicMaterial({
          map: this.fallTex,
          color: new Color(1.25, 1.35, 1.55),
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          side: DoubleSide,
        });
        this.materials.push(fmat);
        const merged = mergeGeometries(falls, false);
        if (merged) {
          merged.computeBoundingSphere();
          this.group.add(new Mesh(merged, fmat));
        }
      }
    }

    // --- the crystal spire at the heart of the helix
    if (helix) {
      const base = new Vector3(helix.x, CLOUD_Y - 30, helix.z);
      const crystal = new MeshStandardMaterial({
        color: new Color(0.16, 0.1, 0.36),
        emissive: new Color(0.3, 0.1, 0.55),
        emissiveIntensity: 0.3,
        roughness: 0.14,
        metalness: 0.55,
        envMapIntensity: 1.3,
        flatShading: true,
      });
      this.spireGlow = new MeshBasicMaterial({ color: new Color(1.6, 0.6, 2.8) });
      this.materials.push(crystal, this.spireGlow);
      const top = Math.max(...this.helixHeights(track)) + 70;
      const parts: BufferGeometry[] = [];
      const glow: BufferGeometry[] = [];
      const shard = (h: number, r: number, tilt: number, az: number, off: number) => {
        const body = new CylinderGeometry(r * 0.85, r, h, 6, 1).translate(0, h / 2, 0);
        const tip = new ConeGeometry(r * 0.85, r * 2.6, 6).translate(0, h + r * 1.3, 0);
        const g = mergeGeometries([body.toNonIndexed(), tip.toNonIndexed()], false)!;
        const m = new Matrix4().makeRotationY(az).multiply(new Matrix4().makeRotationZ(tilt));
        m.setPosition(base.x + Math.cos(az) * off, base.y, base.z + Math.sin(az) * off);
        g.applyMatrix4(m);
        g.deleteAttribute('uv');
        parts.push(g);
        // a glowing seam up one edge
        const seam = new CylinderGeometry(r * 0.08, r * 0.08, h * 0.9, 4).translate(r * 0.9, h * 0.5, 0);
        seam.applyMatrix4(m);
        seam.deleteAttribute('uv');
        glow.push(seam.toNonIndexed());
      };
      const H = top - base.y;
      shard(H, 12, 0, 0, 0);
      shard(H * 0.72, 8, 0.16, 0.6, 14);
      shard(H * 0.6, 6.5, -0.2, 2.4, 15);
      shard(H * 0.5, 5.5, 0.22, 4.1, 13);
      shard(H * 0.42, 5, -0.12, 5.3, 17);
      const g = mergeGeometries(parts, false);
      if (g) {
        g.computeVertexNormals();
        this.group.add(new Mesh(g, crystal));
      }
      const gg = mergeGeometries(glow, false);
      if (gg) this.group.add(new Mesh(gg, this.spireGlow));
      // floating shards orbiting the spire
      const orbit = new InstancedMesh(new OctahedronGeometry(1, 0), crystal, 18);
      const m = new Matrix4();
      for (let k = 0; k < 18; k++) {
        const a = (k / 18) * Math.PI * 2;
        const r = 32 + (k % 3) * 9;
        const y = base.y + H * (0.45 + 0.4 * hash3(k, 3, 9));
        const s = 2 + hash3(k, 1, 1) * 4;
        m.makeRotationFromQuaternion(new Quaternion().setFromAxisAngle(new Vector3(hash3(k, 1, 2), 1, hash3(k, 2, 1)).normalize(), a));
        m.scale(new Vector3(s * 0.6, s * 1.6, s * 0.6)).setPosition(helix.x + Math.cos(a) * r, y, helix.z + Math.sin(a) * r);
        orbit.setMatrixAt(k, m);
      }
      orbit.computeBoundingSphere();
      this.group.add(orbit);
    }

    // --- floating rock debris near the decks: parallax that sells the speed
    {
      const rocks: Matrix4[] = [];
      let t = 0;
      while (rocks.length < 140 && t++ < 5000) {
        const i = Math.floor(rnd() * track.samples.length);
        const smp = track.samples[i];
        const side = rnd() < 0.5 ? -1 : 1;
        const off = 45 + rnd() * 160;
        const p = smp.pos.clone().addScaledVector(sideways(smp), side * off).add(new Vector3(0, (rnd() - 0.6) * 70, 0));
        const s = 0.6 + rnd() * rnd() * 4.5;
        if (!clearOf(p, 22 + s)) continue;
        rocks.push(new Matrix4().makeScale(s, s * (0.6 + rnd() * 0.5), s * (0.8 + rnd() * 0.4)).setPosition(p));
      }
      const inst = new InstancedMesh(rockGeometry(), mat, rocks.length);
      rocks.forEach((m, k) => inst.setMatrixAt(k, m));
      inst.computeBoundingSphere();
      this.group.add(inst);
    }

    // --- cumulus banks: billboards drifting between the decks and over the cloud sea
    {
      for (let k = 0; k < 46; k++) {
        const i = Math.floor(rnd() * track.samples.length);
        const smp = track.samples[i];
        const side = rnd() < 0.5 ? -1 : 1;
        const size = 60 + rnd() * 140;
        const off = size * 0.6 + 40 + rnd() * 260;
        const p = smp.pos.clone().addScaledVector(sideways(smp), side * off);
        p.y = CLOUD_Y + 15 + rnd() * (smp.pos.y - CLOUD_Y + 30);
        if (!clearOf(p, size * 0.45 + 18)) continue;
        puffs.push({ p, size });
      }
      for (let k = 0; k < 26; k++) {
        const a = rnd() * Math.PI * 2;
        const r = 900 + rnd() * 1600;
        puffs.push({ p: new Vector3(centre.x + Math.cos(a) * r, CLOUD_Y + 20 + rnd() * 120, centre.z + Math.sin(a) * r), size: 250 + rnd() * 350 });
      }
      const tex = puffTexture();
      if (tex) {
        this.puffMat = new ShaderMaterial({
          vertexShader: puffVert,
          fragmentShader: puffFrag,
          uniforms: { map: { value: tex }, uCam: { value: new Vector3() } },
          transparent: true,
          depthWrite: false,
        });
        this.materials.push(this.puffMat);
        const inst = new InstancedMesh(new PlaneGeometry(1, 1), this.puffMat, puffs.length);
        const m = new Matrix4();
        puffs.forEach((pf, k) => inst.setMatrixAt(k, m.makeScale(pf.size, pf.size, pf.size).setPosition(pf.p)));
        inst.frustumCulled = false;
        inst.renderOrder = 4;
        this.group.add(inst);
      }
    }

    // --- giant surreal rings far away
    const ringMat = new MeshStandardMaterial({ color: 0xd8dde6, metalness: 0.9, roughness: 0.25, envMapIntensity: 1.2 });
    const glow = new MeshBasicMaterial({ color: new Color(0.6, 1.8, 2.6) });
    this.materials.push(ringMat, glow);
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

  private helixHeights(track: DecorTrack): number[] {
    const m = track.marks.helix;
    const out: number[] = [];
    for (let s = m.s0; s <= m.s1; s += 20) out.push(track.frameAt(s).pos.y);
    return out;
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
      const near = isl.hero || isl.pos.distanceTo(cam) < 450 + isl.scale * 4;
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

  update(dt: number, cam: Vector3, time = 0) {
    this.lodTimer -= dt;
    if (this.lodTimer <= 0) {
      this.lodTimer = 0.4;
      this.updateLod(cam);
    }
    for (const r of this.rings) r.rotateZ(dt * 0.03);
    if (this.fallTex) this.fallTex.offset.y = time * 0.35;
    if (this.puffMat) this.puffMat.uniforms.uCam.value.copy(cam);
    if (this.spireGlow) {
      const k = 0.8 + 0.2 * Math.sin(time * 1.3);
      this.spireGlow.color.setRGB(1.6 * k, 0.6 * k, 2.8 * k);
    }
  }
}

/**
 * A waterfall: a ribbon that leaves the island's edge, arcs outwards and falls,
 * fading in at the lip and out towards the bottom (vertex alpha).
 */
function waterfallRibbon(width: number, height: number, top: Vector3, out: Vector3): BufferGeometry {
  const rows = 14;
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const side = new Vector3(-out.z, 0, out.x);
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const drop = height * t;
    const reach = Math.sqrt(t) * height * 0.12;
    const w = width * (1 + t * 0.9);
    const c = top.clone().addScaledVector(out, reach).add(new Vector3(0, -drop, 0));
    const a = Math.min(1, t * 10) * Math.pow(1 - t, 1.4);
    for (const s of [-1, 1]) {
      const p = c.clone().addScaledVector(side, (s * w) / 2);
      pos.push(p.x, p.y, p.z);
      col.push(1, 1, 1, a);
      uv.push(s < 0 ? 0 : (width / 20) | 0 || 1, -t * (height / (width * 4)));
    }
    if (r > 0) {
      const b = (r - 1) * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 4));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g.toNonIndexed();
}
