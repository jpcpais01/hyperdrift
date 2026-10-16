import { ShaderChunk, Vector3 } from 'three';

/** Direction towards the sun (world space). Golden hour: low, warm, long shadows. */
export const SUN_DIR = new Vector3(0.55, 0.25, -0.8).normalize();

/** World height of the cloud sea; the haze thickens towards it. */
export const CLOUD_Y = 20;

const v3 = (v: Vector3) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;

/**
 * Analytic atmosphere shared by the sky dome, the cloud sea and the fog, so
 * distant geometry dissolves into exactly the colour of the sky behind it.
 * All colours are linear HDR (tone mapped later by the output pass).
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
  // the rounded literal is a hair longer than 1, so dot(d, ATM_SUN) can pass 1.0 at the
  // sun: every use below clamps it, since pow() of a negative base is NaN on Windows/D3D
  const vec3 ATM_SUN = ${v3(SUN_DIR)};
  const vec3 ATM_SUN_COL = vec3(1.0, 0.72, 0.46);

  // Henyey-Greenstein phase (forward scattering around the sun)
  float atmPhase(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
  }

  // Colour of the haze seen along direction d, near the horizon.
  vec3 atmHaze(vec3 d) {
    float c = clamp(dot(d, ATM_SUN), -1.0, 1.0);
    float toward = pow(max(c * 0.5 + 0.5, 0.0), 2.5);
    vec3 away = vec3(0.50, 0.50, 0.74);
    vec3 near = vec3(1.05, 0.66, 0.45);
    vec3 col = mix(away, near, toward);
    col += ATM_SUN_COL * atmPhase(c, 0.7) * 0.45;
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
    vec3 zenith = vec3(0.06, 0.15, 0.48) * (1.0 + 0.5 * (c * 0.5 + 0.5));
    vec3 col = mix(atmHaze(d), zenith, smoothstep(0.0, 0.42, up) * (0.35 + 0.65 * extinction.b));
    // rayleigh brightening around the sun's side
    col += vec3(0.30, 0.22, 0.30) * (1.0 + c * c) * 0.25 * smoothstep(0.4, 0.0, up);
    // below the horizon: haze over the cloud sea
    if (h < 0.0) col = mix(atmHaze(d), vec3(0.42, 0.36, 0.52), smoothstep(0.0, 0.35, -h));
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
    vec3 s = vec3(26.0, 20.0, 13.0) * disc * (0.55 + 0.45 * limb);
    s += ATM_SUN_COL * pow(max(c, 0.0), 400.0) * 3.0;
    return s;
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
