import {
  AdditiveBlending,
  BufferGeometry,
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
  NormalBlending,
  OctahedronGeometry,
  Points,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  Vector4,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  PlaneGeometry,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm3, islandGeometry, noise3 } from '../world/decor';
import { SUN_DIR } from '../world/sky';
import type { DayState } from '../world/timeOfDay';
import { roadDetailTextures } from '../world/trackView';
import {
  BANK_H,
  BANK_IN,
  LEDGE_R,
  PLAZA_R,
  RING_CY,
  RING_R,
  RING_TUBE,
  WALL_R,
  ZONE_Y,
  type ZoneLayout,
} from './layout';
import { bankTexture, grassTexture, kickerTexture, plazaTexture } from './textures';

const UP = new Vector3(0, 1, 0);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// linear albedos
const GRASS_LUSH = new Color(0.2, 0.36, 0.09);
const GRASS_DRY = new Color(0.42, 0.42, 0.13);
const GRASS_BLOOM = new Color(0.55, 0.3, 0.36);
const DIRT = new Color(0.36, 0.25, 0.16);
// baked light for the island's unlit underside (matched to the sky's sun / haze, like the decor islands)
const SUN_C = new Color(1.0, 0.72, 0.46).multiplyScalar(2.6);
const SKY_C = new Color(0.32, 0.38, 0.66);
const BOUNCE_C = new Color(0.5, 0.42, 0.55);

/** Radial grid between two radii, following a height function, with analytic normals. */
function radialGrid(
  r0: number,
  r1: number,
  rings: number,
  segs: number,
  height: (x: number, z: number) => number,
  normal: (x: number, z: number, out: Vector3) => Vector3,
  color: (x: number, z: number, r: number, out: Color) => Color,
  uv: (x: number, z: number, r: number, a: number) => [number, number],
): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const n = new Vector3();
  const c = new Color();
  for (let i = 0; i <= rings; i++) {
    const r = r0 + ((r1 - r0) * i) / rings;
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      pos.push(x, height(x, z), z);
      normal(x, z, n);
      nor.push(n.x, n.y, n.z);
      color(x, z, r, c);
      col.push(c.r, c.g, c.b);
      uvs.push(...uv(x, z, r, a));
    }
  }
  const row = segs + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * row + j;
      const b = a + 1;
      const d = a + row;
      const e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Bakes per-vertex colour into a geometry (albedo × ambient occlusion). */
function paint(g: BufferGeometry, fn: (p: Vector3, n: Vector3, out: Color) => Color): BufferGeometry {
  const pos = g.getAttribute('position');
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const nrm = g.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  const p = new Vector3();
  const n = new Vector3();
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    fn(p, n, c);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  return g;
}

/** Lumpy blob for canopies and rocks: an indexed icosphere pushed around by noise. */
function blob(radius: number, detail: number, seed: number, rough = 0.35): BufferGeometry {
  let g: BufferGeometry = new IcosahedronGeometry(radius, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + (fbm3(v.x * 0.9 + seed, v.y * 0.9, v.z * 0.9 - seed, 3) - 0.5) * rough * 2;
    v.multiplyScalar(k);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function trunk(h: number, r0: number, r1: number, lean: Vector3): BufferGeometry {
  const g = new CylinderGeometry(r1, r0, h, 7, 4, true);
  g.deleteAttribute('uv');
  g.translate(0, h / 2, 0);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = v.y / h;
    v.addScaledVector(lean, t * t);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

const BARK = new Color(0.16, 0.11, 0.085);

/** One tree species as a single vertex-coloured geometry (instanced across the island). */
function treeGeometry(variant: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const barkPaint = (g: BufferGeometry) => paint(g, (p, _n, c) => c.copy(BARK).multiplyScalar(0.6 + 0.4 * Math.min(1, p.y / 2.5)));
  if (variant === 2) {
    // slender cypress: stacked lumpy cones
    parts.push(barkPaint(trunk(2.2, 0.26, 0.18, new Vector3())));
    const green = new Color(0.05, 0.14, 0.06);
    for (let k = 0; k < 3; k++) {
      let g: BufferGeometry = new ConeGeometry(1.9 - k * 0.45, 4.2 - k * 0.6, 9, 4);
      g.deleteAttribute('uv');
      g.deleteAttribute('normal');
      g = mergeVertices(g);
      const pos = g.getAttribute('position');
      const v = new Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const n = 1 + (noise3(v.x * 2.1 + k, v.y * 2.1, v.z * 2.1) - 0.5) * 0.45;
        pos.setXYZ(i, v.x * n, v.y, v.z * n);
      }
      g.translate(0, 3.3 + k * 2.2, 0);
      g.computeVertexNormals();
      parts.push(paint(g, (p, n, c) => c.copy(green).multiplyScalar(0.55 + 0.45 * Math.max(0, n.y * 0.5 + 0.5) * (0.7 + 0.3 * Math.min(1, p.y / 9)))));
    }
  } else {
    // broad canopy tree: sakura (0) or golden ginkgo (1)
    const leaf = variant === 0 ? new Color(0.92, 0.42, 0.55) : new Color(0.95, 0.6, 0.1);
    const leaf2 = variant === 0 ? new Color(1.0, 0.62, 0.72) : new Color(0.85, 0.42, 0.05);
    parts.push(barkPaint(trunk(4.2, 0.34, 0.2, new Vector3(0.5, 0, 0.2))));
    const branches = [
      new Vector3(1.6, 1.5, 0.4),
      new Vector3(-1.3, 1.7, 0.8),
      new Vector3(0.2, 1.6, -1.5),
    ];
    for (const b of branches) {
      const g = trunk(b.length(), 0.16, 0.07, new Vector3());
      const q = new Quaternion().setFromUnitVectors(UP, b.clone().normalize());
      g.applyQuaternion(q);
      g.translate(0.5, 3.4, 0.2);
      parts.push(barkPaint(g));
    }
    const centre = new Vector3(0.5, 5.6, 0.2);
    const blobs = [
      [0, 0.6, 0, 2.4],
      [1.9, 0, 0.4, 1.9],
      [-1.7, 0.2, 0.9, 1.8],
      [0.3, 0.1, -1.9, 1.8],
      [-0.6, 1.5, -0.4, 1.6],
      [1.1, 1.2, 1.3, 1.5],
    ];
    blobs.forEach(([x, y, z, r], i) => {
      const g = blob(r, 1, variant * 10 + i, 0.3);
      g.translate(centre.x + x, centre.y + y, centre.z + z);
      parts.push(
        paint(g, (p, n, c) => {
          // darker deep inside the crown, lighter on the outer, upper shell
          const d = Math.min(1, p.distanceTo(centre) / 3.6);
          const ao = 0.35 + 0.65 * d * (0.75 + 0.25 * n.y);
          const mix = noise3(p.x * 0.9, p.y * 0.9, p.z * 0.9);
          return c.copy(leaf).lerp(leaf2, mix).multiplyScalar(ao);
        }),
      );
    });
  }
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  merged.computeBoundingSphere();
  return merged;
}

function rockGeometry(): BufferGeometry {
  const g = blob(1, 2, 3.7, 0.4);
  g.scale(1, 0.62, 1);
  g.computeVertexNormals();
  return paint(g, (p, n, c) => {
    const band = noise3(p.x * 3, p.y * 6, p.z * 3);
    c.setRGB(0.3, 0.27, 0.25).multiplyScalar(0.7 + band * 0.4);
    // moss on top
    if (n.y > 0.55) c.lerp(new Color(0.12, 0.2, 0.06), smooth(0.55, 0.85, n.y) * 0.8);
    return c.multiplyScalar(p.y < -0.2 ? 0.6 : 1);
  });
}

/** Stone lantern (tōrō): body (stone) and light box (emissive) as two geometries. */
function lanternGeometry(): { body: BufferGeometry; light: BufferGeometry } {
  const parts: BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, y: number) => new BoxGeometry(w, h, d).translate(0, y, 0);
  parts.push(box(1.3, 0.35, 1.3, 0.17));
  parts.push(new CylinderGeometry(0.28, 0.34, 1.6, 8).translate(0, 1.15, 0));
  parts.push(box(1.1, 0.22, 1.1, 2.05));
  // posts around the light box
  for (const [x, z] of [
    [-0.42, -0.42],
    [0.42, -0.42],
    [-0.42, 0.42],
    [0.42, 0.42],
  ])
    parts.push(box(0.12, 0.7, 0.12, 2.5).translate(x, 0, z));
  parts.push(new ConeGeometry(1.15, 0.7, 4, 1).rotateY(Math.PI / 4).translate(0, 3.2, 0));
  parts.push(new SphereGeometry(0.16, 8, 6).translate(0, 3.65, 0));
  const body = mergeGeometries(parts.map((g) => {
    g.deleteAttribute('uv');
    return g.index ? g.toNonIndexed() : g;
  }));
  paint(body, (p, n, c) => c.setRGB(0.42, 0.4, 0.37).multiplyScalar((0.7 + 0.3 * Math.max(0, n.y)) * (0.75 + 0.25 * Math.min(1, p.y / 2))));
  return { body, light: new BoxGeometry(0.66, 0.6, 0.66).translate(0, 2.5, 0) };
}

function lampGeometry(): { body: BufferGeometry; light: BufferGeometry } {
  const pole = new CylinderGeometry(0.09, 0.15, 7, 8).translate(0, 3.5, 0);
  const arm = new CylinderGeometry(0.06, 0.06, 1.6, 6).rotateZ(Math.PI / 2).translate(-0.7, 6.9, 0);
  const cap = new CylinderGeometry(0.42, 0.2, 0.22, 12).translate(-1.4, 6.95, 0);
  const base = new CylinderGeometry(0.3, 0.36, 0.5, 10).translate(0, 0.25, 0);
  const body = mergeGeometries([pole, arm, cap, base].map((g) => {
    g.deleteAttribute('uv');
    return g.index ? g.toNonIndexed() : g;
  }));
  return { body, light: new SphereGeometry(0.3, 12, 8).translate(-1.4, 6.68, 0) };
}

const fieldVert = /* glsl */ `
  varying vec3 vW;
  varying float vH;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vH = uv.y;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

/** The force field: a faint glowing hex lattice that lights up where a car comes close and ripples on impact. */
const fieldFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCar;
  uniform vec4 uHit;
  varying vec3 vW;
  varying float vH;
  float lat(vec2 p, vec2 d) {
    float x = dot(p, d);
    return smoothstep(0.08, 0.0, abs(fract(x) - 0.5) - 0.42);
  }
  void main() {
    float ang = atan(vW.z, vW.x);
    vec2 p = vec2(ang * ${WALL_R.toFixed(1)}, vW.y) / 2.6;
    float lines = max(max(lat(p, vec2(1.0, 0.0)), lat(p, vec2(0.5, 0.866))), lat(p, vec2(-0.5, 0.866)));
    float dc = distance(vW, uCar);
    float near = exp(-dc * dc / 160.0);
    float fade = 1.0 - vH;
    float base = pow(fade, 6.0) * 0.22;
    float sweep = smoothstep(0.985, 1.0, sin(ang * 6.0 - uTime * 0.6 + vW.y * 0.08)) * 0.08 * fade;
    float dh = distance(vW, uHit.xyz);
    float ring = (1.0 - uHit.w) * 22.0;
    float hit = uHit.w * exp(-(dh - ring) * (dh - ring) / 5.0) * 1.6;
    float a = base + sweep + lines * (near * 0.85 + 0.035 * fade + hit) + hit * 0.25;
    vec3 col = mix(vec3(0.25, 1.4, 2.4), vec3(1.6, 0.35, 1.6), clamp(vH * 1.3 + near * 0.2, 0.0, 1.0));
    gl_FragColor = vec4(col * a * fade, 1.0);
  }
`;

const waterVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vW;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const waterFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uLight;
  varying vec2 vUv;
  varying vec3 vW;
  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  void main() {
    float flow = vUv.y * 9.0 - uTime * 1.7;
    float streak = noise(vec2(vUv.x * 18.0, flow)) * 0.6 + noise(vec2(vUv.x * 41.0, flow * 2.3 + 4.0)) * 0.4;
    float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
    float foam = smoothstep(0.45, 0.9, streak) + smoothstep(0.12, 0.0, vUv.y) * 0.6;
    float a = edge * (0.42 + 0.5 * streak) * (1.0 - smoothstep(0.55, 1.0, vUv.y) * 0.9);
    vec3 deep = vec3(0.32, 0.46, 0.72);
    vec3 lit = vec3(1.25, 1.05, 0.92);
    vec3 col = mix(deep, lit, clamp(foam, 0.0, 1.0));
    // mist thickens and catches the low sun towards the bottom
    col = mix(col, vec3(1.1, 0.85, 0.75), smoothstep(0.35, 1.0, vUv.y) * 0.6);
    gl_FragColor = vec4(col * uLight, a);
  }
`;

const lanternVert = /* glsl */ `
  attribute vec3 seed;
  uniform float uTime;
  varying float vFlick;
  void main() {
    float span = 330.0;
    float y = mod(seed.y * span + uTime * (1.0 + seed.z * 0.8), span) - 90.0;
    vec3 p = position;
    p.y += y;
    p.x += sin(uTime * 0.21 + seed.x * 40.0) * 6.0;
    p.z += cos(uTime * 0.17 + seed.z * 40.0) * 6.0;
    vFlick = 0.75 + 0.25 * sin(uTime * (7.0 + seed.x * 5.0) + seed.z * 20.0);
    // fade in above the clouds, fade out up high
    vFlick *= smoothstep(-90.0, -40.0, y) * (1.0 - smoothstep(170.0, 240.0, y));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = 2.2 * 420.0 / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const lanternFrag = /* glsl */ `
  varying float vFlick;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    // paper lantern: a soft rounded body, brighter at the bottom where the flame is
    float body = smoothstep(0.32, 0.22, length(vec2(c.x * 1.25, c.y)));
    float flame = smoothstep(0.2, 0.0, length(c - vec2(0.0, 0.12)));
    float halo = smoothstep(0.5, 0.0, length(c)) * 0.35;
    vec3 col = vec3(2.4, 1.0, 0.32) * (body * 0.8 + flame * 1.6) + vec3(1.4, 0.5, 0.15) * halo;
    gl_FragColor = vec4(col * vFlick, 1.0);
  }
`;

const petalVert = /* glsl */ `
  attribute vec4 seed;
  uniform float uTime;
  uniform vec3 uCam;
  varying float vA;
  varying float vSpin;
  void main() {
    const float BOX = 70.0;
    vec3 wind = vec3(1.7, -0.9, 0.8);
    vec3 p = seed.xyz * BOX + wind * uTime * (0.7 + seed.w * 0.6);
    p.x += sin(uTime * 1.3 + seed.w * 30.0) * 1.5;
    p.z += cos(uTime * 1.1 + seed.w * 21.0) * 1.2;
    // wrap the box around the camera so petals are always drifting past
    p = mod(p - uCam + BOX * 0.5, BOX) - BOX * 0.5 + uCam;
    vSpin = sin(uTime * (3.0 + seed.w * 4.0) + seed.w * 50.0);
    float d = length(p - uCam);
    vA = smoothstep(BOX * 0.5, BOX * 0.25, d) * smoothstep(0.8, 3.0, d);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_PointSize = 0.16 * 520.0 / max(0.5, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const petalFrag = /* glsl */ `
  uniform vec3 uLight;
  varying float vA;
  varying float vSpin;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    c.x /= max(0.25, abs(vSpin));
    float a = smoothstep(0.5, 0.3, length(c * vec2(1.0, 1.6)));
    if (a < 0.02) discard;
    vec3 col = mix(vec3(1.0, 0.62, 0.74), vec3(1.15, 0.9, 0.95), abs(vSpin));
    gl_FragColor = vec4(col * uLight, a * vA * 0.9);
  }
`;

const mistVert = /* glsl */ `
  attribute vec2 seed;
  uniform float uTime;
  varying float vA;
  void main() {
    float t = fract(seed.x + uTime * 0.12);
    vec3 p = position + vec3(sin(seed.y * 40.0) * 3.0 * t, t * 6.0, cos(seed.y * 31.0) * 3.0 * t);
    vA = sin(t * 3.1416) * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (4.0 + t * 8.0) * 420.0 / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const mistFrag = /* glsl */ `
  uniform vec3 uLight;
  varying float vA;
  void main() {
    float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
    gl_FragColor = vec4(vec3(1.05, 0.95, 0.92) * uLight, a * vA);
  }
`;

/** Everything you see in the drift zone. Built once, reused every visit. */
export class ZoneView {
  readonly group = new Group();
  private materials: Material[] = [];
  private textures: Texture[] = [];
  private fieldMat: ShaderMaterial;
  private waterMat: ShaderMaterial;
  private lanternMat: ShaderMaterial;
  private petalMat: ShaderMaterial;
  private mistMat: ShaderMaterial;
  private ringGlow: MeshBasicMaterial;
  private ringGlowBase = new Color(0.4, 1.9, 3.0);
  private crystals: InstancedMesh;
  private treeTime = { value: 0 };
  private gateGlow: MeshBasicMaterial[] = [];
  private hit = 0;
  /** day light on the unlit, light-baked bits (shared by their shaders) */
  private dayLight = new Color(1, 1, 1);
  private baked: MeshBasicMaterial[] = [];
  private lampGlow: { mat: MeshBasicMaterial; base: Color }[] = [];
  private pools: MeshBasicMaterial | null = null;
  private poolMesh: InstancedMesh | null = null;

  constructor(readonly layout: ZoneLayout) {
    const L = layout;
    const detail = roadDetailTextures();
    if (detail) this.textures.push(detail.normal, detail.rough);

    // ---------------------------------------------------------------- plaza
    const plazaMap = plazaTexture();
    const plazaMat = new MeshStandardMaterial({
      map: plazaMap,
      normalMap: detail?.normal ?? null,
      roughnessMap: detail?.rough ?? null,
      roughness: 0.82,
      metalness: 0.08,
    });
    plazaMat.normalScale.set(0.35, 0.35);
    this.track(plazaMat, plazaMap);
    const R = PLAZA_R + 1;
    const plaza = new Mesh(
      radialGrid(
        0,
        R,
        24,
        192,
        () => ZONE_Y,
        (_x, _z, o) => o.copy(UP),
        (_x, _z, _r, o) => o.setRGB(1, 1, 1),
        (x, z) => [x / (2 * R) + 0.5, z / (2 * R) + 0.5],
      ),
      plazaMat,
    );
    plaza.receiveShadow = true;
    this.group.add(plaza);
    // the detail maps tile over the whole disc: repeat them on their own uv transform
    if (detail) {
      const n = detail.normal.clone();
      const r = detail.rough.clone();
      n.repeat.set(55, 55);
      r.repeat.set(14, 14);
      plazaMat.normalMap = n;
      plazaMat.roughnessMap = r;
      this.textures.push(n, r);
    }

    // ---------------------------------------------------------------- meadow
    const grass = grassTexture();
    const grassMat = new MeshStandardMaterial({ map: grass, vertexColors: true, roughness: 0.95, metalness: 0 });
    this.track(grassMat, grass);
    const solidTrees = L.trees.filter((t) => Math.hypot(t.x, t.z) < WALL_R);
    const tourDist = (x: number, z: number) => {
      let best = Infinity;
      for (let i = 0; i < L.tour.length; i += 2) {
        const p = L.tour[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    const meadowColor = (x: number, z: number, r: number, o: Color) => {
      const dry = fbm3(x * 0.012, 0.3, z * 0.012, 3);
      o.copy(GRASS_LUSH).lerp(GRASS_DRY, smooth(0.35, 0.75, dry));
      const bloom = smooth(0.6, 0.78, fbm3(x * 0.03 + 9, 1.7, z * 0.03, 3));
      o.lerp(GRASS_BLOOM, bloom * 0.45);
      // worn dirt trail where the touring car keeps driving
      const td = tourDist(x, z);
      o.lerp(DIRT, (1 - smooth(1.5, 5.5, td)) * 0.75);
      // a dusty fringe along the plaza curb and the foot of the banked ring
      o.lerp(DIRT, (1 - smooth(PLAZA_R, PLAZA_R + 5, r)) * 0.5 + smooth(BANK_IN - 4, BANK_IN, r) * 0.3);
      // tree shade
      let ao = 1;
      for (const t of solidTrees) {
        const d2 = (t.x - x) ** 2 + (t.z - z) ** 2;
        if (d2 < 49) ao *= 1 - 0.4 * (1 - Math.sqrt(d2) / 7);
      }
      for (const rk of L.rocks) {
        const d2 = (rk.x - x) ** 2 + (rk.z - z) ** 2;
        const rr = rk.scale * 1.6;
        if (d2 < rr * rr) ao *= 1 - 0.3 * (1 - Math.sqrt(d2) / rr);
      }
      return o.multiplyScalar(ao * 1.6);
    };
    const meadow = new Mesh(
      radialGrid(
        PLAZA_R - 0.8,
        BANK_IN + 1.2,
        62,
        360,
        (x, z) => L.baseHeight(x, z) - 0.02,
        (x, z, o) => this.baseNormal(x, z, o),
        meadowColor,
        (x, z) => [x / 7, z / 7],
      ),
      grassMat,
    );
    meadow.receiveShadow = true;
    this.group.add(meadow);

    // ---------------------------------------------------------------- banked ring
    const bankMap = bankTexture();
    const bankMat = new MeshStandardMaterial({ map: bankMap, roughness: 0.78, metalness: 0.05, normalMap: detail?.normal ?? null });
    bankMat.normalScale.set(0.3, 0.3);
    if (detail) {
      const n = detail.normal.clone();
      n.repeat.set(8, 60);
      bankMat.normalMap = n;
      this.textures.push(n);
    }
    this.track(bankMat, bankMap);
    const bIn = BANK_IN - 1;
    const bOut = WALL_R + 0.6;
    const bank = new Mesh(
      radialGrid(
        bIn,
        bOut,
        40,
        420,
        (x, z) => L.baseHeight(x, z),
        (x, z, o) => this.baseNormal(x, z, o),
        (_x, _z, _r, o) => o.setRGB(1, 1, 1),
        (_x, _z, r, a) => [(r - bIn) / (bOut - bIn), (a * 230) / 24],
      ),
      bankMat,
    );
    bank.receiveShadow = true;
    // the curb slightly overlaps the meadow: draw it on top
    bankMat.polygonOffset = true;
    bankMat.polygonOffsetFactor = -1;
    this.group.add(bank);

    // stone & grass ledge outside the field
    const ledge = new Mesh(
      radialGrid(
        bOut - 0.2,
        LEDGE_R,
        6,
        360,
        () => ZONE_Y + BANK_H,
        (_x, _z, o) => o.copy(UP),
        (x, z, r, o) => o.copy(GRASS_LUSH).lerp(DIRT, fbm3(x * 0.05, 0, z * 0.05, 2) * 0.6).multiplyScalar(1.5 - smooth(LEDGE_R - 2, LEDGE_R, r) * 0.5),
        (x, z) => [x / 7, z / 7],
      ),
      grassMat,
    );
    ledge.receiveShadow = true;
    this.group.add(ledge);

    // ---------------------------------------------------------------- island underside
    this.group.add(this.buildCliff());

    // ---------------------------------------------------------------- force field + rail
    const fieldH = 30;
    const fieldBase = L.baseHeight(WALL_R, 0) - 0.5;
    this.fieldMat = new ShaderMaterial({
      vertexShader: fieldVert,
      fragmentShader: fieldFrag,
      uniforms: {
        uTime: { value: 0 },
        uCar: { value: new Vector3(0, -999, 0) },
        uHit: { value: new Vector4(0, -999, 0, 0) },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.materials.push(this.fieldMat);
    const fieldGeo = new CylinderGeometry(WALL_R + 0.25, WALL_R + 0.25, fieldH, 256, 1, true);
    fieldGeo.translate(0, fieldBase + fieldH / 2, 0);
    const field = new Mesh(fieldGeo, this.fieldMat);
    field.frustumCulled = false;
    field.renderOrder = 5;
    this.group.add(field);

    const chrome = new MeshStandardMaterial({ color: 0xd8dde6, metalness: 0.95, roughness: 0.2, envMapIntensity: 1.3 });
    const darkMetal = new MeshStandardMaterial({ color: 0x2a2e36, metalness: 0.8, roughness: 0.35 });
    const glowCyan = new MeshBasicMaterial({ color: new Color(0.5, 2.6, 3.6) });
    const glowPink = new MeshBasicMaterial({ color: new Color(3.0, 0.6, 2.4) });
    this.materials.push(chrome, darkMetal, glowCyan, glowPink);
    const railY = fieldBase + 0.5;
    const rail = new Mesh(new TorusGeometry(WALL_R + 0.3, 0.09, 6, 512), chrome);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = railY + 1;
    const strip = new Mesh(new TorusGeometry(WALL_R + 0.3, 0.06, 4, 512), glowCyan);
    strip.rotation.x = Math.PI / 2;
    strip.position.y = railY + 0.05;
    this.group.add(rail, strip);
    {
      const n = 360;
      const posts = new InstancedMesh(new CylinderGeometry(0.05, 0.05, 1, 6).translate(0, 0.5, 0), chrome, n);
      const m = new Matrix4();
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        m.makeTranslation(Math.cos(a) * (WALL_R + 0.3), railY, Math.sin(a) * (WALL_R + 0.3));
        posts.setMatrixAt(i, m);
      }
      posts.computeBoundingSphere();
      this.group.add(posts);
    }

    // ---------------------------------------------------------------- the chrome ring
    {
      const ring = new Group();
      ring.position.set(0, ZONE_Y + RING_CY, 0);
      const body = new Mesh(new TorusGeometry(RING_R, RING_TUBE, 28, 220), chrome);
      this.ringGlow = new MeshBasicMaterial({ color: this.ringGlowBase.clone() });
      this.materials.push(this.ringGlow);
      const inner = new Mesh(new TorusGeometry(RING_R - RING_TUBE + 0.12, 0.2, 6, 220), this.ringGlow);
      const faceA = new Mesh(new TorusGeometry(RING_R, 0.12, 4, 220), glowPink);
      faceA.position.z = RING_TUBE * 0.93;
      const faceB = faceA.clone();
      faceB.position.z = -RING_TUBE * 0.93;
      ring.add(body, inner, faceA, faceB);
      this.group.add(ring);
      // dark footings where it meets the plaza
      const footMat = new MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.4, metalness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 });
      this.materials.push(footMat);
      for (const sx of [-1, 1]) {
        const foot = new Mesh(new CircleGeometry(3.6, 32).rotateX(-Math.PI / 2), footMat);
        foot.position.set(sx * Math.sqrt(RING_R * RING_R - RING_CY * RING_CY), ZONE_Y + 0.02, 0);
        foot.scale.set(1.3, 1, 0.8);
        foot.receiveShadow = true;
        this.group.add(foot);
        const halo = new Mesh(new TorusGeometry(3.6, 0.06, 4, 48).rotateX(Math.PI / 2), glowCyan);
        halo.position.copy(foot.position).setY(ZONE_Y + 0.05);
        halo.scale.set(1.3, 1, 0.8);
        this.group.add(halo);
      }
      // crystals orbiting the crown of the ring
      const cMat = new MeshBasicMaterial({ color: new Color(1.5, 0.55, 2.6) });
      this.materials.push(cMat);
      this.crystals = new InstancedMesh(new OctahedronGeometry(1, 0), cMat, 16);
      this.crystals.frustumCulled = false;
      this.group.add(this.crystals);
    }

    // ---------------------------------------------------------------- light gates
    for (const [i, g] of L.gates.entries()) {
      const gate = new Group();
      const y = L.baseHeight(g.x, g.z);
      gate.position.set(g.x, y, g.z);
      // gate plane: spanned by the axis across and the up vector
      gate.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(g.ax, 0, g.az), UP, new Vector3(-g.az, 0, g.ax)));
      for (const s of [-1, 1]) {
        const pillar = new Mesh(new OctahedronGeometry(1, 0), darkMetal);
        pillar.scale.set(0.9, 6.5, 0.9);
        pillar.position.set(s * g.half, 3.5, 0);
        gate.add(pillar);
      }
      const arch = new Mesh(new TorusGeometry(g.half, 0.45, 8, 64, Math.PI), chrome);
      arch.position.y = 6;
      gate.add(arch);
      const glowMat = new MeshBasicMaterial({ color: (i % 2 ? new Color(3.0, 0.6, 2.4) : new Color(0.5, 2.6, 3.6)).clone() });
      this.materials.push(glowMat);
      this.gateGlow.push(glowMat);
      for (const z of [-0.47, 0.47]) {
        const line = new Mesh(new TorusGeometry(g.half, 0.1, 4, 64, Math.PI), glowMat);
        line.position.set(0, 6, z);
        gate.add(line);
      }
      this.group.add(gate);
    }

    // ---------------------------------------------------------------- kickers
    {
      const tex = kickerTexture();
      const mat = new MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2 });
      this.track(mat, tex);
      for (const k of L.kickers) {
        const pos: number[] = [];
        const uv: number[] = [];
        const idx: number[] = [];
        const nu = 28;
        const nv = 12;
        const halfW = k.width / 2 + 2.5;
        for (let i = 0; i <= nu; i++) {
          const u = -k.len - 0.5 + ((k.len + k.back + 1) * i) / nu;
          for (let j = 0; j <= nv; j++) {
            const v = -halfW + (2 * halfW * j) / nv;
            const x = k.x + k.dx * u - k.dz * v;
            const z = k.z + k.dz * u + k.dx * v;
            pos.push(x, L.heightAt(x, z) + 0.03, z);
            uv.push(j / nv, Math.min(1, Math.max(0, -u / k.len)));
          }
        }
        for (let i = 0; i < nu; i++) {
          for (let j = 0; j < nv; j++) {
            const a = i * (nv + 1) + j;
            idx.push(a, a + 1, a + nv + 1, a + 1, a + nv + 2, a + nv + 1);
          }
        }
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
        g.setIndex(idx);
        g.computeVertexNormals();
        // make sure the faces point up
        const nrm = g.getAttribute('normal');
        if (nrm.getY(0) < 0) {
          for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
          g.setIndex(idx);
          g.computeVertexNormals();
        }
        const mesh = new Mesh(g, mat);
        mesh.receiveShadow = true;
        this.group.add(mesh);
        // a glowing bar along the lip
        const bar = new Mesh(new BoxGeometry(k.width, 0.12, 0.25), glowCyan);
        bar.position.set(k.x, L.heightAt(k.x, k.z) + 0.1, k.z);
        bar.rotation.y = Math.atan2(k.dx, k.dz) + Math.PI / 2;
        this.group.add(bar);
      }
    }

    // ---------------------------------------------------------------- trees, rocks, lights
    {
      const treeMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
      const time = this.treeTime;
      treeMat.onBeforeCompile = (shader) => {
        shader.uniforms.uWind = time;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uWind;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            #ifdef USE_INSTANCING
              float ph = instanceMatrix[3].x * 0.07 + instanceMatrix[3].z * 0.09;
              float sway = (sin(uWind * 1.4 + ph) * 0.6 + sin(uWind * 2.9 + ph * 1.7) * 0.25) * 0.05 * max(0.0, transformed.y - 1.8);
              transformed.x += sway;
              transformed.z += sway * 0.6;
            #endif`,
          );
      };
      treeMat.customProgramCacheKey = () => 'zone-tree';
      this.materials.push(treeMat);
      const m = new Matrix4();
      const q = new Quaternion();
      const s = new Vector3();
      const p = new Vector3();
      for (let v = 0; v < 3; v++) {
        const list = L.trees.filter((t) => t.variant === v);
        if (!list.length) continue;
        const mesh = new InstancedMesh(treeGeometry(v), treeMat, list.length);
        list.forEach((t, i) => {
          const y = Math.hypot(t.x, t.z) > WALL_R ? ZONE_Y + BANK_H : L.baseHeight(t.x, t.z);
          q.setFromAxisAngle(UP, t.rot);
          s.setScalar(t.scale);
          m.compose(p.set(t.x, y - 0.15, t.z), q, s);
          mesh.setMatrixAt(i, m);
        });
        mesh.computeBoundingSphere();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
      const rockMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
      this.materials.push(rockMat);
      const rocks = new InstancedMesh(rockGeometry(), rockMat, Math.max(1, L.rocks.length));
      L.rocks.forEach((r, i) => {
        q.setFromAxisAngle(UP, r.rot);
        m.compose(p.set(r.x, L.baseHeight(r.x, r.z) + r.scale * 0.15, r.z), q, s.set(r.scale * 1.2, r.scale, r.scale));
        rocks.setMatrixAt(i, m);
      });
      rocks.count = L.rocks.length;
      rocks.computeBoundingSphere();
      rocks.castShadow = true;
      this.group.add(rocks);

      const stoneMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
      const warm = new MeshBasicMaterial({ color: new Color(3.2, 1.7, 0.7) });
      const warmOrb = new MeshBasicMaterial({ color: new Color(3.0, 2.3, 1.5) });
      this.materials.push(stoneMat, warm, warmOrb);
      this.lampGlow.push({ mat: warm, base: warm.color.clone() }, { mat: warmOrb, base: warmOrb.color.clone() });
      const lg = lanternGeometry();
      const bodies = new InstancedMesh(lg.body, stoneMat, L.lanterns.length);
      const lights = new InstancedMesh(lg.light, warm, L.lanterns.length);
      L.lanterns.forEach((l, i) => {
        q.setFromAxisAngle(UP, Math.atan2(l.x, l.z));
        m.compose(p.set(l.x, L.baseHeight(l.x, l.z), l.z), q, s.setScalar(1));
        bodies.setMatrixAt(i, m);
        lights.setMatrixAt(i, m);
      });
      const lp = lampGeometry();
      const poles = new InstancedMesh(lp.body, darkMetal, L.lamps.length);
      const orbs = new InstancedMesh(lp.light, warmOrb, L.lamps.length);
      L.lamps.forEach((l, i) => {
        // arm reaches over the ring road
        q.setFromAxisAngle(UP, Math.atan2(l.z, -l.x));
        m.compose(p.set(l.x, L.baseHeight(l.x, l.z), l.z), q, s.setScalar(1));
        poles.setMatrixAt(i, m);
        orbs.setMatrixAt(i, m);
      });
      for (const im of [bodies, lights, poles, orbs]) {
        im.computeBoundingSphere();
        this.group.add(im);
      }
      bodies.castShadow = poles.castShadow = true;
      this.group.add(this.lightPools(L));
    }

    // ---------------------------------------------------------------- waterfalls
    this.waterMat = new ShaderMaterial({
      vertexShader: waterVert,
      fragmentShader: waterFrag,
      uniforms: { uTime: { value: 0 }, uLight: { value: this.dayLight } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.mistMat = new ShaderMaterial({
      vertexShader: mistVert,
      fragmentShader: mistFrag,
      uniforms: { uTime: { value: 0 }, uLight: { value: this.dayLight } },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.materials.push(this.waterMat, this.mistMat);
    const poolMat = new MeshStandardMaterial({ color: 0x1d3550, roughness: 0.05, metalness: 0.1, envMapIntensity: 1.4, polygonOffset: true, polygonOffsetFactor: -2 });
    this.materials.push(poolMat);
    const mistPos: number[] = [];
    const mistSeed: number[] = [];
    for (const a of [0.35, 1.45, 2.6, 3.55, 4.6, 5.55]) this.addWaterfall(a, poolMat, mistPos, mistSeed);
    const mg = new BufferGeometry();
    mg.setAttribute('position', new Float32BufferAttribute(mistPos, 3));
    mg.setAttribute('seed', new Float32BufferAttribute(mistSeed, 2));
    const mist = new Points(mg, this.mistMat);
    mist.frustumCulled = false;
    this.group.add(mist);

    // ---------------------------------------------------------------- neighbour: the great tree island
    {
      const isl = new Mesh(islandGeometry(4, 7), new MeshBasicMaterial({ vertexColors: true }));
      this.materials.push(isl.material as Material);
      this.baked.push(isl.material as MeshBasicMaterial);
      const S = 80;
      isl.scale.set(S * 1.1, S, S * 0.9);
      isl.position.set(140, ZONE_Y - 38, 560);
      this.group.add(isl);
      const big = new Mesh(treeGeometry(0), new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
      this.materials.push(big.material as Material);
      big.scale.setScalar(6.5);
      big.position.set(140, ZONE_Y - 38 + S * 0.2, 560);
      this.group.add(big);
      // and its own waterfall, catching the sun
      const fall = new Mesh(this.fallGeometry(new Vector3(140 - 40, ZONE_Y - 38 + S * 0.16, 560 - 62), new Vector3(-0.5, 0, -0.85).normalize(), 9, 150), this.waterMat);
      this.group.add(fall);
    }

    // ---------------------------------------------------------------- sky lanterns & petals
    {
      const n = 90;
      const pos: number[] = [];
      const seed: number[] = [];
      let sd = 31;
      const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const d = 290 + rnd() * 520;
        pos.push(Math.cos(a) * d, ZONE_Y, Math.sin(a) * d);
        seed.push(rnd(), rnd(), rnd());
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      g.setAttribute('seed', new Float32BufferAttribute(seed, 3));
      this.lanternMat = new ShaderMaterial({
        vertexShader: lanternVert,
        fragmentShader: lanternFrag,
        uniforms: { uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      this.materials.push(this.lanternMat);
      const pts = new Points(g, this.lanternMat);
      pts.frustumCulled = false;
      this.group.add(pts);

      const pn = 520;
      const pp = new Float32Array(pn * 3);
      const ps: number[] = [];
      for (let i = 0; i < pn; i++) ps.push(rnd(), rnd(), rnd(), rnd());
      const pg = new BufferGeometry();
      pg.setAttribute('position', new Float32BufferAttribute(pp, 3));
      pg.setAttribute('seed', new Float32BufferAttribute(ps, 4));
      this.petalMat = new ShaderMaterial({
        vertexShader: petalVert,
        fragmentShader: petalFrag,
        uniforms: { uTime: { value: 0 }, uCam: { value: new Vector3() }, uLight: { value: this.dayLight } },
        transparent: true,
        depthWrite: false,
      });
      this.materials.push(this.petalMat);
      const petals = new Points(pg, this.petalMat);
      petals.frustumCulled = false;
      petals.renderOrder = 6;
      this.group.add(petals);
    }
  }

  /** Warm pools of lamplight on the ground, only there after dark. */
  private lightPools(L: ZoneLayout): InstancedMesh {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.62)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new CanvasTexture(c);
    this.textures.push(tex);
    const mat = new MeshBasicMaterial({
      map: tex,
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      fog: true,
    });
    this.materials.push(mat);
    this.pools = mat;
    const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const spots: [number, number, number][] = [];
    // under each lamp's head (the arm leans 1.4 m out over the road) and round each stone lantern
    for (const l of L.lamps) {
      const r = Math.hypot(l.x, l.z);
      spots.push([l.x * (1 + 1.4 / r), l.z * (1 + 1.4 / r), 17]);
    }
    for (const l of L.lanterns) spots.push([l.x, l.z, 9]);
    const im = new InstancedMesh(geo, mat, spots.length);
    const m = new Matrix4();
    const q = new Quaternion();
    const n = new Vector3();
    spots.forEach(([x, z, size], i) => {
      L.normalAt(x, z, n);
      q.setFromUnitVectors(UP, n);
      m.compose(new Vector3(x, L.baseHeight(x, z) + 0.06, z), q, new Vector3(size, 1, size));
      im.setMatrixAt(i, m);
    });
    im.computeBoundingSphere();
    im.renderOrder = 2;
    im.visible = false;
    this.poolMesh = im;
    return im;
  }

  /** Time of day: dim the light-baked rock and water at night, turn the lamps up and pool their light. */
  setDay(s: DayState) {
    this.dayLight.copy(s.ambient);
    for (const m of this.baked) m.color.copy(s.ambient);
    const lit = Math.max(s.night, s.twilight * 0.6);
    for (const { mat, base } of this.lampGlow) mat.color.copy(base).multiplyScalar(1 + 1.3 * lit);
    if (this.pools) {
      this.pools.color.setRGB(1.0, 0.62, 0.3).multiplyScalar(0.85 * lit);
      if (this.poolMesh) this.poolMesh.visible = lit > 0.01;
    }
  }

  private track(m: Material, t: Texture | null) {
    this.materials.push(m);
    if (t) this.textures.push(t);
  }

  private baseNormal(x: number, z: number, out: Vector3) {
    const e = 0.5;
    const L = this.layout;
    const hx = L.baseHeight(x + e, z) - L.baseHeight(x - e, z);
    const hz = L.baseHeight(x, z + e) - L.baseHeight(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Rocky underside: a lathe from the ledge down to a point, carved by noise, lighting baked in. */
  private buildCliff(): Group {
    const out = new Group();
    const prof: [number, number][] = [
      [LEDGE_R, BANK_H],
      [LEDGE_R - 0.5, BANK_H - 3],
      [LEDGE_R - 2, BANK_H - 9],
      [LEDGE_R - 6, -6],
      [LEDGE_R - 16, -20],
      [LEDGE_R - 34, -36],
      [LEDGE_R - 62, -58],
      [LEDGE_R - 100, -86],
      [LEDGE_R - 146, -118],
      [LEDGE_R - 190, -152],
      [LEDGE_R - 226, -188],
      [8, -222],
      [0, -236],
    ];
    const rows = 56;
    const segs = 220;
    const pos: number[] = [];
    const idx: number[] = [];
    const cav: number[] = [];
    // resample the profile smoothly
    const at = (t: number): [number, number] => {
      const f = t * (prof.length - 1);
      const i = Math.min(prof.length - 2, Math.floor(f));
      const u = f - i;
      const s = u * u * (3 - 2 * u);
      return [prof[i][0] + (prof[i + 1][0] - prof[i][0]) * (u * 0.4 + s * 0.6), prof[i][1] + (prof[i + 1][1] - prof[i][1]) * u];
    };
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      const [r, y] = at(t);
      for (let j = 0; j <= segs; j++) {
        const a = (j / segs) * Math.PI * 2;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        const w = smooth(0, 0.06, t);
        // vertical gullies + chunky strata + big lobes
        const gully = fbm3(cx * 9, y * 0.012, cz * 9, 3);
        const strata = Math.sin(y * 0.55 + gully * 6) * 0.5 + 0.5;
        const lobes = fbm3(cx * 2.2 + 3, y * 0.01, cz * 2.2, 3);
        const k = 1 + w * ((gully - 0.5) * 0.16 + (strata - 0.5) * 0.04 + (lobes - 0.5) * 0.3 * Math.min(1, t * 3));
        // hanging spikes near the bottom
        const spike = t > 0.45 ? Math.pow(noise3(cx * 7, 0, cz * 7), 4) * 50 * (t - 0.45) : 0;
        pos.push(cx * r * k, ZONE_Y + y - spike, cz * r * k);
        cav.push(gully * 0.6 + strata * 0.4);
      }
    }
    const row = segs + 1;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * row + j;
        idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const nrm = g.getAttribute('normal');
    const col: number[] = [];
    const n = new Vector3();
    const c = new Color();
    const light = new Color();
    const ROCK_A = new Color(0.32, 0.22, 0.16);
    const ROCK_B = new Color(0.2, 0.15, 0.13);
    const DEEP = new Color(0.07, 0.055, 0.08);
    for (let i = 0; i < pos.length / 3; i++) {
      n.fromBufferAttribute(nrm, i);
      const y = pos[i * 3 + 1] - ZONE_Y;
      const top = y > BANK_H - 4;
      if (top) c.copy(GRASS_LUSH).multiplyScalar(0.9);
      else c.copy(ROCK_A).lerp(ROCK_B, 0.5 + 0.5 * Math.sin(y * 0.55 + cav[i] * 5)).lerp(DEEP, Math.min(1, -y / 200));
      const ao = 0.5 + 0.5 * cav[i];
      const ndl = n.dot(SUN_DIR);
      const wrap = Math.max(0, (ndl + 0.25) / 1.25);
      light.copy(SUN_C).multiplyScalar(wrap * wrap * (0.6 + 0.4 * ao));
      light.r += (SKY_C.r * (0.5 + 0.5 * n.y) + BOUNCE_C.r * (0.5 - 0.5 * n.y)) * ao;
      light.g += (SKY_C.g * (0.5 + 0.5 * n.y) + BOUNCE_C.g * (0.5 - 0.5 * n.y)) * ao;
      light.b += (SKY_C.b * (0.5 + 0.5 * n.y) + BOUNCE_C.b * (0.5 - 0.5 * n.y)) * ao;
      col.push(c.r * light.r, c.g * light.g, c.b * light.b);
    }
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    const mat = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
    this.materials.push(mat);
    this.baked.push(mat);
    out.add(new Mesh(g, mat));

    // anti-gravity crystal cluster at the very bottom
    const cMat = new MeshBasicMaterial({ color: new Color(0.6, 2.4, 3.4) });
    this.materials.push(cMat);
    const cr = new InstancedMesh(new OctahedronGeometry(1, 0), cMat, 9);
    const m = new Matrix4();
    const q = new Quaternion();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const tilt = i === 0 ? 0 : 0.5;
      q.setFromAxisAngle(new Vector3(Math.cos(a), 0, Math.sin(a)), tilt);
      const h = i === 0 ? 26 : 10 + (i % 3) * 5;
      m.compose(new Vector3(Math.cos(a) * (i ? 9 : 0), ZONE_Y - 236 - h * 0.6, Math.sin(a) * (i ? 9 : 0)), q, new Vector3(h * 0.28, h, h * 0.28));
      cr.setMatrixAt(i, m);
    }
    cr.computeBoundingSphere();
    out.add(cr);
    return out;
  }

  /** A falling ribbon of water from `top`, pushed out along `out`, widening as it falls. */
  private fallGeometry(top: Vector3, out: Vector3, width: number, drop: number): BufferGeometry {
    const side = new Vector3().crossVectors(UP, out).normalize();
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const rows = 40;
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      const c = top.clone().addScaledVector(out, 2 + 9 * Math.sqrt(t)).addScaledVector(UP, -drop * t);
      const w = width * (0.6 + 1.6 * t);
      for (const s of [-0.5, 0.5]) {
        const p = c.clone().addScaledVector(side, s * w);
        pos.push(p.x, p.y, p.z);
        uv.push(s + 0.5, t);
      }
      if (i) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    // the curved lip where the water pours over
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  private addWaterfall(angle: number, poolMat: Material, mistPos: number[], mistSeed: number[]) {
    const out = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const top = out.clone().multiplyScalar(LEDGE_R - 1.5).setY(ZONE_Y + BANK_H + 0.05);
    const pool = new Mesh(new CircleGeometry(4.2, 28).rotateX(-Math.PI / 2), poolMat);
    pool.position.copy(out).multiplyScalar(LEDGE_R - 4.5).setY(ZONE_Y + BANK_H + 0.04);
    pool.scale.set(1, 1, 1);
    this.group.add(pool);
    const fall = new Mesh(this.fallGeometry(top, out, 4.5, 100), this.waterMat);
    this.group.add(fall);
    // spray where it pours over the edge, and a cloud of mist lower down
    for (let i = 0; i < 26; i++) {
      const p = top.clone().addScaledVector(out, 2 + Math.random() * 3).addScaledVector(UP, -2 - Math.random() * (i < 14 ? 6 : 70));
      mistPos.push(p.x, p.y, p.z);
      mistSeed.push(Math.random(), Math.random());
    }
  }

  /** Lights up the force field where a car hits it. */
  fieldHit(at: Vector3, strength: number) {
    this.hit = Math.max(this.hit, Math.min(1, strength));
    const u = this.fieldMat.uniforms.uHit.value as Vector4;
    u.x = at.x;
    u.y = at.y;
    u.z = at.z;
    u.w = this.hit;
  }

  update(dt: number, time: number, cam: Vector3, focus: Vector3) {
    this.treeTime.value = time;
    const f = this.fieldMat.uniforms;
    f.uTime.value = time;
    (f.uCar.value as Vector3).copy(focus);
    this.hit = Math.max(0, this.hit - dt * 0.9);
    (f.uHit.value as Vector4).w = this.hit;
    this.waterMat.uniforms.uTime.value = time;
    this.mistMat.uniforms.uTime.value = time;
    this.lanternMat.uniforms.uTime.value = time;
    this.petalMat.uniforms.uTime.value = time;
    (this.petalMat.uniforms.uCam.value as Vector3).copy(cam);
    const pulse = 0.75 + 0.25 * Math.sin(time * 2.2);
    this.ringGlow.color.copy(this.ringGlowBase).multiplyScalar(pulse);
    this.gateGlow.forEach((m, i) => {
      const k = 0.7 + 0.3 * Math.sin(time * 3 + i * 2);
      m.color.setRGB(i % 2 ? 3.0 * k : 0.5 * k, i % 2 ? 0.6 * k : 2.6 * k, i % 2 ? 2.4 * k : 3.6 * k);
    });
    const m = new Matrix4();
    const q = new Quaternion();
    const s = new Vector3();
    const p = new Vector3();
    const crown = ZONE_Y + RING_CY + RING_R + 3;
    for (let i = 0; i < 16; i++) {
      const a = time * 0.4 + (i / 16) * Math.PI * 2;
      const rr = 7 + (i % 3) * 2.5;
      p.set(Math.cos(a) * rr, crown + Math.sin(time * 1.3 + i) * 1.2 + (i % 2) * 2, Math.sin(a) * rr);
      q.setFromAxisAngle(UP, time * 1.5 + i);
      const sc = 0.5 + (i % 4) * 0.18;
      s.set(sc * 0.55, sc * 1.4, sc * 0.55);
      m.compose(p, q, s);
      this.crystals.setMatrixAt(i, m);
    }
    this.crystals.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.group.traverse((o) => {
      const g = (o as Mesh).geometry;
      if (g) g.dispose();
    });
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
