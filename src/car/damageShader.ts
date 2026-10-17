import { Matrix4, MeshDepthMaterial, Vector4, type Material } from 'three';
import { MAX_DENTS, PART_COUNT } from './damage';

/**
 * Damage in the shaders. Every material on a damageable car gets the same
 * vertex chunk: the car's dents (a uniform table) push and crumple the
 * geometry and bend the normals with them, then each vertex follows its
 * part's transform (a hanging bumper, a popped hood, a part that is gone).
 * Because it works on car-space positions, it fits every body and part
 * combination with no per-part work, and costs nothing on a fresh car (the
 * loop runs over zero dents).
 *
 * The fragment chunk adds what the metal shows: scratched paint down to
 * primer and bare metal, chipped creases, crazed glass, smashed lamps, soot.
 */

export interface DamageUniforms {
  /** centre.xyz, radius */
  uDentA: { value: Vector4[] };
  /** push dir.xyz (into the car), drawn depth */
  uDentB: { value: Vector4[] };
  /** scuff, seed, glass cracks, 0 */
  uDentC: { value: Vector4[] };
  uDentN: { value: number };
  uPartM: { value: Matrix4[] };
  /** x: soot and scorching (wreck), y: windscreen cracks, z: lamps out +x side, w: lamps out -x side */
  uWreck: { value: Vector4 };
}

export function createDamageUniforms(): DamageUniforms {
  return {
    uDentA: { value: Array.from({ length: MAX_DENTS }, () => new Vector4(0, -50, 0, 0.001)) },
    uDentB: { value: Array.from({ length: MAX_DENTS }, () => new Vector4(0, 1, 0, 0)) },
    uDentC: { value: Array.from({ length: MAX_DENTS }, () => new Vector4()) },
    uDentN: { value: 0 },
    uPartM: { value: Array.from({ length: PART_COUNT }, () => new Matrix4()) },
    uWreck: { value: new Vector4() },
  };
}

const COMMON = /* glsl */ `
#define DMG_N ${MAX_DENTS}
uniform vec4 uDentA[DMG_N];
uniform vec4 uDentB[DMG_N];
uniform vec4 uDentC[DMG_N];
uniform int uDentN;
uniform vec4 uWreck;
varying vec3 vDmgPos;
varying vec3 vDmgN;
`;

export const DAMAGE_VERT = /* glsl */ `
${COMMON}
uniform mat4 uPartM[${PART_COUNT}];
attribute float part;

// Bend p and its normal n through every dent: a smooth push along the dent's
// direction, plus folds across it that grow with the depth (crumpled metal).
// Normals follow the push analytically (the inverse transpose of its Jacobian),
// so reflections ripple over the dents like they do on a real panel.
void dmgDeform(inout vec3 p, inout vec3 n) {
  vec3 p0 = p;
  vec3 n0 = n;
  vec3 disp = vec3(0.0);
  vec3 nAdj = vec3(0.0);
  for (int i = 0; i < DMG_N; i++) {
    if (i >= uDentN) break;
    vec4 A = uDentA[i];
    vec4 B = uDentB[i];
    vec3 d = p0 - A.xyz;
    float r2 = A.w * A.w;
    float q = dot(d, d) / r2;
    if (q >= 1.0 || B.w <= 0.0) continue;
    float s = 1.0 - q;
    float f = s * s;
    vec3 gf = d * (-4.0 * s / r2);
    vec3 a = B.xyz * B.w;
    // folds: two crossed waves across the push, a third along it (the accordion)
    float seed = uDentC[i].y;
    vec3 helper = abs(B.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 u = normalize(cross(B.xyz, helper));
    vec3 v = cross(B.xyz, u);
    float ca = cos(seed);
    float sa = sin(seed);
    vec3 k1 = (u * ca + v * sa) * 29.0 + B.xyz * 6.0;
    vec3 k2 = (v * ca - u * sa) * 21.0 + B.xyz * 11.0;
    float x1 = dot(p0, k1) + seed * 7.0;
    float x2 = dot(p0, k2) + seed * 3.0;
    float w = sin(x1) * sin(x2);
    vec3 gw = cos(x1) * sin(x2) * k1 + sin(x1) * cos(x2) * k2;
    float amp = min(B.w * B.w * 0.55, 0.055);
    float h = f * w * amp;
    vec3 gh = (gf * w + f * gw) * amp;
    disp += a * f + n0 * h;
    nAdj -= gf * dot(a, n0) + (gh - dot(gh, n0) * n0);
  }
  p = p0 + disp;
  vec3 nn = n0 + nAdj;
  n = dot(nn, nn) > 1e-8 ? normalize(nn) : n0;
}

void dmgPart(inout vec3 p, inout vec3 n) {
  mat4 M = uPartM[int(part + 0.5)];
  p = (M * vec4(p, 1.0)).xyz;
  vec3 pn = mat3(M) * n;
  n = dot(pn, pn) > 1e-10 ? normalize(pn) : n;
}
`;

export const DAMAGE_FRAG = /* glsl */ `
${COMMON}
float dmgHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float dmgNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dmgHash(i), dmgHash(i + vec3(1, 0, 0)), f.x), mix(dmgHash(i + vec3(0, 1, 0)), dmgHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(dmgHash(i + vec3(0, 0, 1)), dmgHash(i + vec3(1, 0, 1)), f.x), mix(dmgHash(i + vec3(0, 1, 1)), dmgHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

// How hard this spot was hit: x = crush (depth-weighted), y = scuff, z = distance to the nearest
// dent centre over its radius, w = index of that dent.
vec4 dmgAt(vec3 p) {
  float crush = 0.0;
  float scuff = 0.0;
  float nearest = 9.0;
  float idx = -1.0;
  for (int i = 0; i < DMG_N; i++) {
    if (i >= uDentN) break;
    vec4 A = uDentA[i];
    vec3 d = p - A.xyz;
    float t = length(d) / A.w;
    if (t < nearest) { nearest = t; idx = float(i); }
    float f = clamp(1.0 - t * t, 0.0, 1.0);
    crush += f * f * uDentB[i].w;
    float g = clamp(1.0 - t * 0.8, 0.0, 1.0);
    scuff += g * uDentC[i].x;
  }
  return vec4(crush, scuff, nearest, idx);
}

// Scratch streaks, running the way the body slides past things.
float dmgStreaks(vec3 p, vec3 n) {
  vec3 a = abs(n);
  vec2 uv = a.x > max(a.y, a.z) ? p.zy : (a.z > a.y ? p.xy : p.zx);
  float s = dmgNoise(vec3(uv.x * 2.5, uv.y * 120.0, 0.5)) * 0.6 + dmgNoise(vec3(uv.x * 7.0, uv.y * 260.0, 3.1)) * 0.4;
  return smoothstep(0.62, 0.8, s);
}

// Spider-web cracks round an impact: radial splits and broken rings.
float dmgCracks(vec3 p, vec3 c, float r, float seed) {
  vec3 d = p - c;
  float len = length(d);
  vec3 a = abs(d);
  vec2 q = a.x < min(a.y, a.z) ? d.yz : (a.y < a.z ? d.xz : d.xy);
  float ang = atan(q.y, q.x);
  float rays = 11.0 + floor(fract(seed) * 6.0);
  float wob = dmgNoise(vec3(ang * 3.0, len * 9.0, seed)) * 1.6;
  float radial = abs(sin(ang * rays * 0.5 + wob));
  float aaR = fwidth(radial) * 1.5 + 1e-3;
  float lineR = 1.0 - smoothstep(0.0, 0.035 + aaR, radial);
  float ringv = abs(sin(len * 46.0 + dmgNoise(vec3(ang * 5.0, seed, 1.0)) * 4.0));
  float aaG = fwidth(ringv) * 1.5 + 1e-3;
  float lineG = (1.0 - smoothstep(0.0, 0.05 + aaG, ringv)) * step(0.55, dmgNoise(vec3(ang * 7.0, len * 13.0, seed + 4.0)));
  float core = 1.0 - smoothstep(0.0, 0.05, len);
  return clamp(max(lineR, lineG * 0.8) * (1.0 - smoothstep(r * 0.45, r * 1.1, len)) + core, 0.0, 1.0);
}

// Crazed safety glass: a fine web of cells over the whole pane.
float dmgCraze(vec3 p) {
  vec3 g = p * 38.0;
  vec3 i = floor(g);
  vec3 f = fract(g);
  float d1 = 9.0;
  float d2 = 9.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 h = vec3(dmgHash(i + o), dmgHash(i + o + 17.0), dmgHash(i + o + 41.0));
    float dd = length(o + h - f);
    if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) d2 = dd;
  }
  float e = d2 - d1;
  float w = fwidth(e);
  float lines = 1.0 - smoothstep(0.0, 0.035 + w * 1.5 + 1e-3, e);
  // past where the cells can be drawn, an even frosting instead of speckle
  return mix(lines, 0.3, smoothstep(0.12, 0.4, w));
}
`;

export type DamageKind = 'paint' | 'solid' | 'glass' | 'lamp' | 'basicLamp';

/** What each kind of material shows of the damage (after its own colour is known). */
function fragBody(kind: DamageKind): string {
  if (kind === 'paint' || kind === 'solid') {
    return /* glsl */ `
    if (uDentN > 0 || uWreck.x > 0.0) {
      vec4 dm = dmgAt(vDmgPos);
      vec3 dn = normalize(vDmgN);
      float grain = dmgNoise(vDmgPos * 60.0);
      // scratches: through the clear and the colour to grey primer, deeper ones to bright metal
      float sc = smoothstep(0.15, 0.85, dm.y * (0.55 + grain * 0.7)) * dmgStreaks(vDmgPos, dn);
      float metalLine = sc * step(0.62, dmgNoise(vDmgPos * 23.0 + 5.0));
      // creased metal chips: flakes of paint off the folds
      float chip = smoothstep(0.1, 0.32, dm.x) * smoothstep(0.66, 0.8, dmgNoise(vDmgPos * 18.0));
      float primer = clamp(sc + chip, 0.0, 1.0);
      ${kind === 'paint' ? 'vec3 under = vec3(0.32, 0.33, 0.33);' : 'vec3 under = diffuseColor.rgb * 1.8 + 0.12;'}
      diffuseColor.rgb = mix(diffuseColor.rgb, under, primer * 0.9);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.63, 0.65), metalLine);
      metalnessFactor = mix(metalnessFactor, ${kind === 'paint' ? '0.0' : 'metalnessFactor'}, primer);
      metalnessFactor = mix(metalnessFactor, 1.0, metalLine);
      roughnessFactor = mix(roughnessFactor, 0.62, primer);
      roughnessFactor = mix(roughnessFactor, 0.32, metalLine);
      // grime in the folds
      diffuseColor.rgb *= 1.0 - smoothstep(0.06, 0.4, dm.x) * (0.12 + 0.18 * grain);
      // soot and scorching once the car has burned
      float soot = uWreck.x * smoothstep(0.25, 0.75, dmgNoise(vDmgPos * 3.3) + dmgNoise(vDmgPos * 11.0) * 0.4 - 0.15 + uWreck.x * 0.35);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.016, 0.015), soot * 0.92);
      roughnessFactor = mix(roughnessFactor, 0.92, soot);
      metalnessFactor = mix(metalnessFactor, 0.1, soot);
      dmgCoat = 1.0 - max(primer, soot);
    }`;
  }
  if (kind === 'glass') {
    return /* glsl */ `
    if (uDentN > 0 || uWreck.y > 0.0) {
      vec4 dm = dmgAt(vDmgPos);
      float crack = 0.0;
      if (dm.w >= 0.0) {
        int k = int(dm.w + 0.5);
        vec4 A = uDentA[k];
        float hit = smoothstep(0.03, 0.14, uDentB[k].w);
        crack = dmgCracks(vDmgPos, A.xyz, A.w, uDentC[k].y) * hit;
      }
      float craze = smoothstep(0.8, 1.0, uWreck.y) + smoothstep(0.22, 0.4, dm.x);
      if (craze > 0.0) crack = max(crack, dmgCraze(vDmgPos) * craze);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.6, 0.62), crack * 0.85);
      roughnessFactor = mix(roughnessFactor, 0.5, crack);
      dmgCoat = 1.0 - crack * 0.8;
      float soot = uWreck.x * smoothstep(0.4, 0.8, dmgNoise(vDmgPos * 4.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), soot * 0.8);
    }`;
  }
  // lamps: a smashed lamp goes dark behind broken glass
  return /* glsl */ `
    {
      float out_ = vDmgPos.z > 0.0 ? (vDmgPos.x > 0.0 ? uWreck.z : uWreck.w) : 0.0;
      if (uDentN > 0) out_ = max(out_, smoothstep(0.05, 0.12, dmgAt(vDmgPos).x));
      if (uWreck.x > 0.5) out_ = 1.0;
      float crack = out_ > 0.0 ? dmgCraze(vDmgPos * 1.6) * out_ : 0.0;
      dmgLampOut = out_;
      dmgLampCrack = crack;
    }`;
}

function inject(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> }, u: DamageUniforms, kind: DamageKind, depthOnly = false) {
  Object.assign(shader.uniforms, u);
  let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${DAMAGE_VERT}`);
  const lit = !depthOnly && kind !== 'basicLamp';
  if (lit && vs.includes('#include <beginnormal_vertex>')) {
    vs = vs
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvec3 dmgP = position;\nvDmgPos = position;\nvDmgN = objectNormal;\ndmgDeform(dmgP, objectNormal);\ndmgPart(dmgP, objectNormal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = dmgP;');
  } else {
    vs = vs.replace(
      '#include <begin_vertex>',
      'vec3 transformed = position;\nvec3 dmgN = normal;\nvDmgPos = position;\nvDmgN = normal;\ndmgDeform(transformed, dmgN);\ndmgPart(transformed, dmgN);',
    );
  }
  shader.vertexShader = vs;
  if (depthOnly) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${COMMON}`);
    return;
  }
  let fs = shader.fragmentShader.replace('#include <common>', `#include <common>\n${DAMAGE_FRAG}`);
  if (kind === 'basicLamp') {
    fs = fs.replace(
      '#include <opaque_fragment>',
      `float dmgLampOut = 0.0;\nfloat dmgLampCrack = 0.0;\n${fragBody(kind)}\noutgoingLight = mix(outgoingLight, vec3(0.025, 0.026, 0.03) + dmgLampCrack * 0.18, dmgLampOut);\n#include <opaque_fragment>`,
    );
  } else if (kind === 'lamp') {
    fs = fs
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\nfloat dmgCoat = 1.0;\nfloat dmgLampOut = 0.0;\nfloat dmgLampCrack = 0.0;\n${fragBody(kind)}\ntotalEmissiveRadiance *= 1.0 - dmgLampOut;\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5), dmgLampCrack * 0.6);\nroughnessFactor = mix(roughnessFactor, 0.55, dmgLampCrack);\ndiffuseColor.a = mix(diffuseColor.a, 0.9, dmgLampCrack);`)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= dmgCoat;\n#endif');
  } else {
    fs = fs
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\nfloat dmgCoat = 1.0;\n${fragBody(kind)}`)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= dmgCoat;\n#endif');
  }
  shader.fragmentShader = fs;
}

/**
 * A per-car copy of `base` that bends and shows this car's damage. The copy
 * keeps the base's own shader tweaks (paint, triplanar maps) and shares one
 * program with the same material on every other car.
 */
export function damaged<T extends Material>(base: T, u: DamageUniforms, kind: DamageKind, own = false): T {
  const mat = own ? base : (base.clone() as T);
  const prev = base.onBeforeCompile;
  const prevKey = base.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(base, shader, renderer);
    inject(shader, u, kind);
  };
  mat.customProgramCacheKey = () => `${prevKey}|dmg-${kind}-v1`;
  return mat;
}

/** Shadow caster that follows the same dents and parts (so a part that is gone casts no shadow). */
export function damageDepthMaterial(u: DamageUniforms): MeshDepthMaterial {
  const mat = new MeshDepthMaterial();
  mat.onBeforeCompile = (shader) => inject(shader, u, 'solid', true);
  mat.customProgramCacheKey = () => 'hyperdrift-dmg-depth-v1';
  return mat;
}
