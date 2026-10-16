import { ShaderChunk, ShaderLib, UniformsLib } from 'three';
import { dayState, GOLDEN_HOUR, GOLDEN_SUN, type DayState } from './timeOfDay';

/**
 * Direction towards the key light (world space): the sun by day, the moon at night.
 * Races keep the golden hour (low, warm, long shadows); the drift zone moves it.
 */
export const SUN_DIR = GOLDEN_SUN.clone();

type V4 = { x: number; y: number; z: number; w: number };
const v4 = (): V4 => ({ x: 0, y: 0, z: 0, w: 0 });

/**
 * The atmosphere's live state, shared by every shader that draws sky or haze.
 * Plain objects on purpose: three clones Vector3/Color uniform values per
 * material, but passes plain {x,y,z,w} objects through by reference, so one
 * write here reaches every material at once.
 */
export const ATM = {
  /** towards the sun (may be below the horizon) */
  uAtmSun: { value: v4() },
  /** sun radiance, already faded by how much of it is up */
  uAtmSunCol: { value: v4() },
  /** x day, y golden, z night, w twilight */
  uAtmK: { value: v4() },
  /** xyz towards the moon, w moon visibility */
  uAtmMoon: { value: v4() },
};

/** Push a time of day into the sky, the clouds and the haze on every material. */
export function setAtmosphere(s: DayState) {
  const set = (o: V4, x: number, y: number, z: number, w: number) => {
    o.x = x;
    o.y = y;
    o.z = z;
    o.w = w;
  };
  set(ATM.uAtmSun.value, s.sun.x, s.sun.y, s.sun.z, s.sunVis);
  // the sun reddens as it sinks
  const g = s.golden;
  set(ATM.uAtmSunCol.value, s.sunVis, s.sunVis * (0.95 - 0.23 * g), s.sunVis * (0.88 - 0.42 * g), 0);
  set(ATM.uAtmK.value, s.day, s.golden, s.night, s.twilight);
  set(ATM.uAtmMoon.value, s.moon.x, s.moon.y, s.moon.z, s.moonVis);
  SUN_DIR.copy(s.lightDir);
}
setAtmosphere(dayState(GOLDEN_HOUR));

/** World height of the cloud sea; the haze thickens towards it. */
export const CLOUD_Y = 20;

/**
 * Analytic atmosphere shared by the sky dome, the cloud sea and the fog, so
 * distant geometry dissolves into exactly the colour of the sky behind it.
 * All colours are linear HDR (tone mapped later by the output pass).
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
  // the rounded literal is a hair longer than 1, so dot(d, ATM_SUN) can pass 1.0 at the
  // sun: every use below clamps it, since pow() of a negative base is NaN on Windows/D3D
  uniform vec4 uAtmSun;
  uniform vec4 uAtmSunCol;
  uniform vec4 uAtmK;
  uniform vec4 uAtmMoon;
  #define ATM_SUN uAtmSun.xyz
  #define ATM_SUN_COL uAtmSunCol.rgb

  // one colour for each time of day: blue noon, golden hour, moonlit night
  vec3 atmPal(vec3 day, vec3 gold, vec3 night) {
    return mix(night, mix(day, gold, uAtmK.y), uAtmK.x);
  }

  // Henyey-Greenstein phase (forward scattering around the sun)
  float atmPhase(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  }

  // Colour of the haze seen along direction d, near the horizon.
  vec3 atmHaze(vec3 d) {
    float c = clamp(dot(d, ATM_SUN), -1.0, 1.0);
    float toward = pow(max(c * 0.5 + 0.5, 0.0), 2.5);
    vec3 away = atmPal(vec3(0.60, 0.68, 0.90), vec3(0.50, 0.50, 0.74), vec3(0.028, 0.036, 0.080));
    vec3 near = atmPal(vec3(0.92, 0.86, 0.80), vec3(1.05, 0.66, 0.45), vec3(0.036, 0.042, 0.090));
    vec3 col = mix(away, near, toward);
    col += ATM_SUN_COL * atmPhase(c, 0.7) * 0.45;
    // after sunset the horizon keeps a rose and violet glow on the sun's side
    col += vec3(0.42, 0.16, 0.26) * pow(max(c * 0.5 + 0.5, 0.0), 3.0) * uAtmK.w;
    // moonlit haze
    float cm = clamp(dot(d, uAtmMoon.xyz), -1.0, 1.0);
    col += vec3(0.07, 0.09, 0.16) * atmPhase(cm, 0.6) * uAtmMoon.w;
    return col;
  }

  // Full sky radiance (without sun disc and clouds).
  vec3 atmSky(vec3 d) {
    float h = d.y;
    float c = dot(d, ATM_SUN);
    // optical depth grows towards the horizon: blue overhead, warm & dense low down
    float up = max(h, 0.0);
    float depth = 1.0 / (up * 2.6 + 0.12);
    vec3 rayleigh = vec3(0.18, 0.38, 1.0);
    vec3 extinction = exp(-rayleigh * depth * 0.32);
    vec3 zenith = atmPal(vec3(0.09, 0.25, 0.74), vec3(0.06, 0.15, 0.48), vec3(0.005, 0.009, 0.032)) * (1.0 + 0.5 * (c * 0.5 + 0.5));
    vec3 col = mix(atmHaze(d), zenith, smoothstep(0.0, 0.42, up) * (0.35 + 0.65 * extinction.b));
    // rayleigh brightening around the sun's side
    col += vec3(0.30, 0.22, 0.30) * (1.0 + c * c) * 0.25 * smoothstep(0.4, 0.0, up) * uAtmK.x;
    // below the horizon: haze over the cloud sea
    if (h < 0.0) col = mix(atmHaze(d), atmPal(vec3(0.56, 0.62, 0.80), vec3(0.42, 0.36, 0.52), vec3(0.022, 0.026, 0.055)), smoothstep(0.0, 0.35, -h));
    return col;
  }

  // Sun disc with limb darkening plus a tight bloom halo.
  vec3 atmSun(vec3 d) {
    float c = clamp(dot(d, ATM_SUN), -1.0, 1.0);
    float disc = smoothstep(0.99955, 0.99975, c);
    // no pow() here: pow(x, 2.0) of a negative x is NaN on D3D, and one NaN pixel
    // at the sun was smeared by the bloom into a huge dark block over the screen
    float r = (1.0 - c) / 0.00045;
    float limb = sqrt(max(0.0, 1.0 - r * r));
    vec3 s = vec3(26.0, 20.0, 13.0) * disc * (0.55 + 0.45 * limb) * uAtmSun.w;
    s += ATM_SUN_COL * pow(max(c, 0.0), 400.0) * 3.0;
    return s;
  }

  // The moon: a pale cratered disc and a soft halo.
  vec3 atmMoonDisc(vec3 d) {
    float c = clamp(dot(d, uAtmMoon.xyz), -1.0, 1.0);
    float disc = smoothstep(0.99935, 0.99952, c);
    // a few darker maria, from the position on the disc
    vec3 side = normalize(cross(uAtmMoon.xyz, vec3(0.0, 1.0, 0.0)));
    vec3 upv = cross(side, uAtmMoon.xyz);
    vec2 q = vec2(dot(d, side), dot(d, upv)) / 0.031;
    float maria = smoothstep(0.35, 0.0, length(q - vec2(-0.25, 0.2))) * 0.35 + smoothstep(0.28, 0.0, length(q - vec2(0.3, -0.15))) * 0.3 + smoothstep(0.2, 0.0, length(q - vec2(0.05, 0.42))) * 0.25;
    vec3 m = vec3(2.1, 2.2, 2.45) * disc * (1.0 - maria);
    m += vec3(0.16, 0.2, 0.34) * pow(max(c, 0.0), 900.0) * 1.4;
    m += vec3(0.05, 0.065, 0.12) * pow(max(c, 0.0), 60.0);
    return m * uAtmMoon.w;
  }
`;

/**
 * Replace three's linear fog with aerial perspective: distance + height fog
 * (thicker near the cloud sea) coloured by the same scattering as the sky,
 * so geometry towards the sun glows warm and the far side fades to lavender.
 * fogNear/fogFar keep their meaning (start / fully hazed distance).
 */
let installed = false;
export function installAtmosphereFog() {
  if (installed) return;
  installed = true;
  // every material that can take fog gets the shared atmosphere uniforms (same objects)
  Object.assign(UniformsLib.fog, ATM);
  for (const k of Object.keys(ShaderLib) as (keyof typeof ShaderLib)[]) {
    const u = ShaderLib[k].uniforms as Record<string, unknown>;
    if (u && 'fogColor' in u) Object.assign(u, ATM);
  }
  ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogRay;
#endif`;
  ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // view-space offset rotated back to world space (transpose of the view rotation)
  vFogRay = (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;
#endif`;
  ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogRay;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${ATMOSPHERE_GLSL}
#endif`;
  ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  float fogDist = length(vFogRay);
  vec3 fogDir = vFogRay / max(fogDist, 1e-3);
  #ifdef FOG_EXP2
    float fogAmt = 1.0 - exp(- fogDensity * fogDensity * fogDist * fogDist);
  #else
    float fd = max(fogDist - fogNear, 0.0) / (fogFar - fogNear);
    float fogAmt = 1.0 - exp(- fd * (0.9 + fd * 2.2));
    // height fog: density falls off exponentially above the cloud sea
    float y0 = cameraPosition.y - ${CLOUD_Y.toFixed(1)};
    float dy = vFogRay.y;
    const float H = 55.0;
    float k = abs(dy) > 0.5 ? H * (exp(- y0 / H) - exp(- (y0 + dy) / H)) / dy : exp(- y0 / H);
    fogAmt = 1.0 - (1.0 - fogAmt) * exp(- 0.0016 * max(k, 0.0) * fogDist);
  #endif
  vec3 fogCol = atmHaze(fogDir) * fogColor;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, clamp(fogAmt, 0.0, 1.0));
#endif`;
}
