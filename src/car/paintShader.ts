/**
 * Paint shader chunk, injected into MeshPhysicalMaterial. Everything here works
 * in the car's own space (vObjPos / vObjN), so patterns stay glued to the body
 * and the same program serves every car: one draw call for all painted parts.
 *
 *  - zones: each painted vertex carries a zone id (see zones.ts); the one-piece
 *    shell is split into body / front / rear / hood by position, which gives
 *    crisp two-tone edges that line up with the panel shut lines.
 *  - finishes: solid, woven carbon, or a colour-shift ("flip") paint.
 *  - vinyls: procedural patterns in the vinyl colour.
 *  - panel lines: door, hood and bumper shut lines and a fuel filler, drawn
 *    as thin anti-aliased dark lines instead of geometry.
 */
import { SKELETON } from './skeleton';
import { ARCH_RADIUS } from './geometry';

const f = (n: number) => n.toFixed(4);

export const PAINT_GLSL = /* glsl */ `
uniform vec3 uZoneCol[8];
uniform vec3 uZoneCol2[8];
uniform vec4 uZoneMat[8];
uniform vec3 uAccent;
uniform float uVinyl;
uniform vec4 uHood;
uniform vec3 uDoor;
uniform float uNumber;

float band(float d, float w) { float aa = fwidth(d) * 1.2 + 1e-4; return 1.0 - smoothstep(w - aa, w + aa, d); }
float edgeIn(float d) { float aa = fwidth(d) * 1.2 + 1e-4; return smoothstep(-aa, aa, d); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}

int shellZone(vec3 p, vec3 n) {
  // inside the wheel arches: the well walls and the arch's inner return
  float r = min(length(vec2(p.y - ${f(SKELETON.wheelY)}, p.z - ${f(SKELETON.frontAxleZ)})), length(vec2(p.y - ${f(SKELETON.wheelY)}, p.z - ${f(SKELETON.rearAxleZ)})));
  if (r < ${f(ARCH_RADIUS - 0.004)} && abs(p.x) > 0.3) return 7;
  if (p.z > uHood.x && p.z < uHood.y && abs(p.x) < uHood.z && p.y > uHood.w && n.y > 0.0) return 3;
  if (p.z > 1.78) return 1;
  if (p.z < -1.78) return 2;
  return 0;
}

float panelLines(vec3 p, vec3 n) {
  float ax = abs(p.x);
  float side = smoothstep(0.35, 0.6, abs(n.x));
  float top = step(0.0, n.y) * step(uHood.w, p.y);
  float inHoodX = step(ax, uHood.z);
  float inHoodZ = step(uHood.x, p.z) * step(p.z, uHood.y);
  float w = 0.0032;
  float l = side * step(0.3, p.y) * step(p.y, 0.92) * max(band(abs(p.z - uDoor.x), w), band(abs(p.z - uDoor.y), w));
  l = max(l, top * inHoodZ * band(abs(ax - uHood.z), w));
  l = max(l, top * inHoodX * max(band(abs(p.z - uHood.y), w), band(abs(p.z - uHood.x - 0.01), w)));
  l = max(l, band(abs(abs(p.z) - 1.78), w) * (1.0 - top * inHoodX * inHoodZ));
  if (p.x > 0.0) l = max(l, side * band(abs(length(vec2(p.z - uDoor.z, p.y - 0.72)) - 0.05), w));
  return clamp(l, 0.0, 1.0);
}

vec3 carbonWeave(vec3 p, vec3 n) {
  vec3 a = abs(n);
  vec2 uv = a.y > max(a.x, a.z) ? p.xz : (a.x > a.z ? p.zy : p.xy);
  uv *= 55.0;
  vec2 c = floor(uv);
  vec2 f = fract(uv);
  float odd = mod(c.x + c.y, 2.0);
  float g = odd > 0.5 ? f.x : f.y;
  float s = 0.5 + 0.5 * sin(g * 3.14159);
  float fade = clamp(1.0 - length(fwidth(uv)) * 0.9, 0.0, 1.0);
  s = mix(0.55, s, fade);
  return mix(vec3(0.016, 0.017, 0.02), vec3(0.085, 0.09, 0.1), s);
}

// seven-segment digit; q spans about [-0.5, 0.5] x [-1, 1]; returns coverage
float segLine(vec2 q, vec2 a, vec2 b) {
  vec2 pa = q - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float digit(vec2 q, int d) {
  int masks[10] = int[10](0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F);
  int m = masks[clamp(d, 0, 9)];
  float dist = 1e3;
  if ((m & 1) != 0) dist = min(dist, segLine(q, vec2(-0.38, 0.9), vec2(0.38, 0.9)));
  if ((m & 2) != 0) dist = min(dist, segLine(q, vec2(0.45, 0.82), vec2(0.45, 0.08)));
  if ((m & 4) != 0) dist = min(dist, segLine(q, vec2(0.45, -0.08), vec2(0.45, -0.82)));
  if ((m & 8) != 0) dist = min(dist, segLine(q, vec2(-0.38, -0.9), vec2(0.38, -0.9)));
  if ((m & 16) != 0) dist = min(dist, segLine(q, vec2(-0.45, -0.08), vec2(-0.45, -0.82)));
  if ((m & 32) != 0) dist = min(dist, segLine(q, vec2(-0.45, 0.82), vec2(-0.45, 0.08)));
  if ((m & 64) != 0) dist = min(dist, segLine(q, vec2(-0.38, 0.0), vec2(0.38, 0.0)));
  return band(dist, 0.13);
}

vec2 hexCell(vec2 uv) {
  vec2 r = vec2(1.0, 1.732);
  vec2 h = r * 0.5;
  vec2 a = mod(uv, r) - h;
  vec2 b = mod(uv - h, r) - h;
  return dot(a, a) < dot(b, b) ? a : b;
}
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, vec2(0.5, 0.866)), p.x);
}

/** Vinyl colour and coverage for this point. */
vec4 vinyl(vec3 p, vec3 n, vec3 base) {
  int id = int(uVinyl + 0.5);
  float ax = abs(p.x);
  float sideW = smoothstep(0.45, 0.8, abs(n.x));
  bool isSide = abs(n.x) > abs(n.y);
  // a 2D coordinate on the skin: along the car and across it
  float across = isSide ? p.y : ax;
  vec2 uv = vec2(p.z, across);
  vec3 acc = uAccent;
  float m = 0.0;
  if (id == 1) {
    m = band(abs(ax - 0.15), 0.065) * smoothstep(0.2, 0.55, n.y);
  } else if (id == 2) {
    float y0 = 0.47 + 0.05 * p.z;
    float w = 0.018 + 0.03 * clamp((p.z + 1.6) / 3.2, 0.0, 1.0);
    m = sideW * band(abs(p.y - y0), w) * smoothstep(-2.0, -1.7, p.z);
    m = max(m, sideW * band(abs(p.y - y0 + 0.075), 0.008) * smoothstep(-1.8, -1.2, p.z) * (1.0 - smoothstep(1.2, 1.5, p.z)));
  } else if (id == 3) {
    float k = fract(p.z * 1.3 + p.y * 2.2);
    float k2 = fract(p.z * 0.55 - p.y * 1.7 + 0.3);
    float shard = band(abs(k - 0.5), 0.17) * band(abs(k2 - 0.5), 0.3);
    m = sideW * shard * smoothstep(-1.4, 0.4, p.z) * (1.0 - smoothstep(1.2, 1.8, p.z));
  } else if (id == 4) {
    vec2 g = uv * 11.0;
    vec2 c = floor(g);
    float fade = smoothstep(0.1, -1.7, p.z + (hash2(c * 0.37) - 0.5) * 0.9);
    float on = step(hash2(c), fade);
    float par = mod(c.x + c.y, 2.0);
    vec2 f = abs(fract(g) - 0.5);
    float cell = band(max(f.x, f.y), 0.5);
    m = on * cell;
    acc = par > 0.5 ? uAccent : vec3(0.02);
  } else if (id == 5) {
    // licks of flame running back from the nose, sharp tips, a hot core and a dark outline
    float t = 2.3 - p.z;
    float a2 = isSide ? p.y : ax * 0.8 + 0.25;
    float wave = abs(sin(a2 * 22.0)) * 0.55 + abs(sin(a2 * 47.0 + 1.3)) * 0.25 + 0.2 * sin(a2 * 9.0 + 2.0);
    float L = 0.45 + 0.75 * pow(max(wave, 0.0), 2.5);
    float region = isSide ? smoothstep(0.3, 0.38, p.y) * (1.0 - smoothstep(0.8, 0.88, p.y)) : step(0.6, p.y);
    float d = L - t;
    m = edgeIn(d) * region;
    float core = edgeIn(d - 0.14) * (1.0 - smoothstep(0.0, 0.5, t / max(L, 0.05) - 0.4));
    acc = mix(uAccent, mix(uAccent, vec3(1.0, 0.92, 0.55), 0.45), core);
    acc = mix(acc, vec3(0.02), band(d, 0.01));
  } else if (id == 6) {
    vec3 a = abs(n);
    vec2 cuv = a.y > max(a.x, a.z) ? p.xz : (a.x > a.z ? p.zy : p.xy);
    vec2 c = floor(cuv * 9.0);
    float v = vnoise(c * 0.31) * 0.7 + vnoise(c * 0.83 + 7.0) * 0.3;
    m = 1.0;
    acc = v < 0.36 ? base : v < 0.58 ? base * 0.35 : uAccent * 0.8;
  } else if (id == 7) {
    float v = vnoise(vec2(p.z * 2.2, across * 5.0 + ax * 3.0));
    float s = sin(p.z * 17.0 + v * 7.0 + across * 3.0);
    float taper = 0.55 + 0.35 * sin(across * 9.0 + p.z * 2.0);
    m = edgeIn(s - (1.0 - taper * 0.45)) * smoothstep(0.26, 0.34, p.y);
  } else if (id == 8) {
    vec2 g = uv * 24.0;
    vec2 f = fract(g) - 0.5;
    float r = 0.52 * smoothstep(0.6, -1.9, p.z);
    m = edgeIn(r - length(f)) * step(0.02, r);
  } else if (id == 9) {
    // diagonal band on the flanks and a centre band over the top
    float d = p.y - 0.36 - (p.z + 0.2) * 0.42;
    m = sideW * band(abs(d), 0.07);
    m = max(m, sideW * band(abs(d - 0.11), 0.012));
    m = max(m, smoothstep(0.3, 0.6, n.y) * band(abs(p.x), 0.11) * step(-0.5, p.z));
    // roundel with the race number on the doors and the hood
    vec2 c = isSide ? vec2((p.x > 0.0 ? -1.0 : 1.0) * (p.z - 0.08), p.y - 0.56) : vec2(-p.x, -(p.z - 1.32));
    float rr = isSide ? 0.15 : 0.17;
    float inDisc = edgeIn(rr - length(c)) * (isSide ? sideW : smoothstep(0.4, 0.7, n.y) * step(1.0, p.z));
    vec3 disc = dot(uAccent, vec3(0.33)) > 0.6 ? vec3(0.03) : vec3(0.95);
    int num = int(uNumber + 0.5);
    vec2 q = c / (rr * 0.42);
    float dg = max(digit((q - vec2(-0.62, 0.0)) * vec2(1.0, 1.0), num / 10), digit(q - vec2(0.62, 0.0), num - (num / 10) * 10));
    vec3 numCol = disc.r > 0.5 ? vec3(0.03) : vec3(0.95);
    if (inDisc > 0.0) {
      acc = mix(disc, numCol, dg);
      m = inDisc;
    }
  } else if (id == 10) {
    float s = sideW * (band(abs(p.y - 0.6 - p.z * 0.012), 0.004) + band(abs(p.y - 0.625 - p.z * 0.012), 0.0025));
    float t = smoothstep(0.4, 0.7, n.y) * (band(abs(ax - 0.3), 0.004) + band(abs(ax - 0.33), 0.0025));
    m = clamp(s + t, 0.0, 1.0) * smoothstep(2.05, 1.85, p.z) * smoothstep(-2.05, -1.85, p.z);
  } else if (id == 11) {
    vec2 h = hexCell(uv * 16.0);
    float size = 0.5 * smoothstep(0.66, 0.3, p.y + (isSide ? 0.0 : 1.0));
    m = edgeIn(size - hexDist(h)) * step(0.02, size);
  }
  return vec4(acc, clamp(m, 0.0, 1.0));
}

void paintSurface(inout vec3 col, inout float metal, inout float rough, inout float cc, vec3 nView, vec3 viewDir) {
  vec3 p = vObjPos;
  vec3 n = normalize(vObjN);
  int z = vZone;
  bool shell = z == 8;
  if (shell) z = shellZone(p, n);
  z = clamp(z, 0, 7);
  vec4 mat = uZoneMat[z];
  vec3 base = uZoneCol[z];
  metal = mat.x;
  rough = mat.y;
  cc = mat.z;
  if (mat.w > 2.5) {
    col = base;
    return;
  }
  bool carbon = mat.w > 0.5 && mat.w < 1.5;
  if (mat.w > 1.5) {
    float f = pow(1.0 - clamp(abs(dot(nView, viewDir)), 0.0, 1.0), 1.4);
    base = mix(base, uZoneCol2[z], smoothstep(0.05, 0.85, f));
  } else if (carbon) {
    base = carbonWeave(p, n);
  }
  col = base;
  if (uVinyl > 0.5 && !carbon) {
    vec4 v = vinyl(p, n, base);
    col = mix(col, v.rgb, v.a);
  }
  if (shell) {
    float l = panelLines(p, n);
    col *= 1.0 - 0.85 * l;
    rough = mix(rough, 0.9, l);
    cc *= 1.0 - l;
  }
}
`;
