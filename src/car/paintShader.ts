/**
 * Paint shader chunk, injected into MeshPhysicalMaterial. Everything here works
 * in the car's own space (vObjPos / vObjN), so patterns stay glued to the body
 * and the same program serves every car: one draw call for all painted parts.
 *
 *  - zones: each painted vertex carries a zone id (see zones.ts); the one-piece
 *    shell is split into body / front / rear / hood by position, which gives
 *    crisp two-tone edges that line up with the panel shut lines.
 *  - finishes: solid, woven carbon, or a colour-shift ("flip") paint.
 *  - vinyls: procedural patterns in the vinyl colour. The rare ones move
 *    (uTime) and glow: they write paintGlow, which is added to the emissive
 *    light, so they light up at night and feed the bloom.
 *  - panel lines: door, hood and bumper shut lines and a fuel filler, drawn
 *    as thin anti-aliased dark lines instead of geometry.
 */
export const PAINT_GLSL = /* glsl */ `
uniform vec3 uZoneCol[8];
uniform vec3 uZoneCol2[8];
uniform vec4 uZoneMat[8];
uniform vec3 uAccent;
uniform float uVinyl;
uniform vec4 uHood;
uniform vec3 uDoor;
uniform vec3 uDoorY;
uniform vec2 uEnds;
uniform vec4 uArchF;
uniform vec4 uArchR;
uniform float uNumber;
uniform float uTime;

#define HD_PAINT_GLOW
vec3 paintGlow = vec3(0.0);

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
  float rf = length(vec2(p.y - uArchF.x, p.z - uArchF.y)) - (uArchF.z - 0.004);
  float rr = length(vec2(p.y - uArchR.x, p.z - uArchR.y)) - (uArchR.z - 0.004);
  // a hood or deck sunk below the arch tops passes through the circle too: skin that faces
  // up or in towards the centre line is body, not well (the well walls face the wheel)
  bool top = n.y > 0.45 || n.x * sign(p.x) < -0.2;
  if (min(rf, rr) < 0.0 && abs(p.x) > uArchF.w - 0.2 && !top) return 7;
  if (p.z > uHood.x && p.z < uHood.y && abs(p.x) < uHood.z && p.y > uHood.w && n.y > 0.0) return 3;
  if (p.z > uEnds.x) return 1;
  if (p.z < uEnds.y) return 2;
  return 0;
}

float panelLines(vec3 p, vec3 n) {
  float ax = abs(p.x);
  float side = smoothstep(0.35, 0.6, abs(n.x));
  float top = step(0.0, n.y) * step(uHood.w, p.y);
  float inHoodX = step(ax, uHood.z);
  float inHoodZ = step(uHood.x, p.z) * step(p.z, uHood.y);
  float w = 0.0032;
  float l = side * step(uDoorY.x, p.y) * step(p.y, uDoorY.y) * max(band(abs(p.z - uDoor.x), w), band(abs(p.z - uDoor.y), w));
  l = max(l, top * inHoodZ * band(abs(ax - uHood.z), w));
  l = max(l, top * inHoodX * max(band(abs(p.z - uHood.y), w), band(abs(p.z - uHood.x - 0.01), w)));
  l = max(l, max(band(abs(p.z - uEnds.x), w), band(abs(p.z - uEnds.y), w)) * (1.0 - top * inHoodX * inHoodZ));
  if (p.x > 0.0) l = max(l, side * band(abs(length(vec2(p.z - uDoor.z, p.y - uDoorY.z)) - 0.05), w));
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

vec3 hueShift(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec2 hash22(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
// cells that churn slowly: x = distance to the nearest centre, y = gap to the second (0 on a border)
vec2 cells(vec2 x, float t) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int v = -1; v <= 1; v++) {
    for (int u = -1; u <= 1; u++) {
      vec2 g = vec2(float(u), float(v));
      vec2 o = 0.5 + 0.42 * sin(t + 6.2831 * hash22(i + g));
      float d = length(g + o - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2(d1, d2 - d1);
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
  } else if (id == 12) {
    // aurora: two curtains of light that fold and drift along the flanks, rays rising off their hems
    float t = uTime;
    float a = isSide ? p.y : ax * 0.7 + 0.5;
    float flow = vnoise(vec2(p.z * 0.9 - t * 0.22, t * 0.07)) * 5.0;
    float e1 = a - (0.5 + 0.13 * sin(p.z * 2.6 + flow - t * 0.6));
    float e2 = a - (0.72 + 0.09 * sin(p.z * 1.7 - t * 0.45 + flow * 0.6 + 2.0));
    float rays = 0.2 + 0.8 * smoothstep(0.25, 0.85, vnoise(vec2(p.z * 26.0 + flow * 2.0 - t * 1.4, 0.5)));
    float rays2 = 0.2 + 0.8 * smoothstep(0.25, 0.85, vnoise(vec2(p.z * 19.0 - flow - t * 0.9, 4.5)));
    float s1 = smoothstep(-0.01, 0.012, e1) * exp(-max(e1, 0.0) * 11.0) * rays;
    float s2 = smoothstep(-0.01, 0.012, e2) * exp(-max(e2, 0.0) * 14.0) * rays2 * 0.85;
    float shimmer = 0.8 + 0.2 * sin(t * 2.3 + p.z * 5.0 + flow);
    vec3 c1 = mix(uAccent, hueShift(uAccent, 1.7), smoothstep(0.0, 0.3, e1));
    vec3 c2 = mix(hueShift(uAccent, 0.9), hueShift(uAccent, 2.4), smoothstep(0.0, 0.25, e2));
    float k1 = clamp(s1 * shimmer, 0.0, 1.0);
    float k2 = clamp(s2 * shimmer, 0.0, 1.0);
    m = max(k1, k2);
    acc = (c1 * k1 + c2 * k2) / max(k1 + k2, 1e-3);
    paintGlow = (c1 * k1 + c2 * k2) * 1.7;
  } else if (id == 13) {
    // magma: cooled black crust drifting back over rivers of lava that breathe
    float t = uTime;
    vec2 q = vec2(p.z, across) * 3.4 + vec2(t * 0.16, 0.0);
    vec2 e = cells(q, t * 0.35);
    float crack = 1.0 - smoothstep(0.0, 0.07 + 0.05 * fwidth(q.x) * 8.0, e.y);
    float warm = 1.0 - smoothstep(0.0, 0.3, e.y);
    float heat = 0.55 + 0.45 * sin(t * 2.1 + vnoise(q * 0.6 - t * 0.35) * 9.0);
    vec3 rock = mix(vec3(0.022, 0.018, 0.017), vec3(0.07, 0.04, 0.032), vnoise(q * 3.1));
    rock = mix(rock, uAccent * 0.3, warm * warm * heat);
    vec3 lava = mix(uAccent, vec3(1.0, 0.86, 0.45), heat * 0.6);
    // the crust climbs from the sills and the nose, with a ragged glowing rim
    float line = isSide ? 0.66 + 0.12 * vnoise(vec2(p.z * 2.4 + t * 0.3, 1.0)) + 0.05 * sin(p.z * 5.0 - t * 1.1) - p.y
                        : p.z - 0.35 - 0.45 * vnoise(vec2(p.x * 3.0 - t * 0.2, t * 0.15));
    float reg = edgeIn(line);
    float rim = band(abs(line), 0.02) * (0.6 + 0.4 * heat);
    m = max(reg, rim);
    acc = mix(mix(rock, lava, crack), lava, rim);
    paintGlow = lava * (crack * reg * (0.6 + 2.2 * heat) + warm * warm * reg * heat * 0.25 + rim * 2.0);
  } else if (id == 14) {
    // circuit: traces and pads, with pulses of light racing back along each lane
    float t = uTime;
    vec2 g = uv * vec2(9.0, 18.0);
    vec2 c = floor(g);
    vec2 f = fract(g) - 0.5;
    float r = hash2(c);
    float on = step(0.4, hash2(vec2(floor(c.x / 3.0), c.y) + 3.1));
    float tr = on * band(abs(f.y), 0.07);
    tr = max(tr, step(0.8, r) * band(abs(f.x), 0.07));
    float pad = step(0.9, r) * max(band(abs(length(f) - 0.2), 0.06), band(length(f), 0.07));
    tr = max(tr, pad);
    float h = hash2(vec2(c.y, 7.0));
    float s = fract(p.z * 0.4 + t * (0.35 + 0.5 * h) + h * 9.0);
    float pulse = pow(1.0 - s, 9.0) + pad * 0.6 * (0.5 + 0.5 * sin(t * 4.0 + r * 30.0));
    float breathe = 0.7 + 0.3 * sin(t * 1.5);
    m = tr;
    acc = mix(uAccent * 0.3 + 0.03, mix(uAccent, vec3(1.0), 0.35), clamp(pulse, 0.0, 1.0));
    paintGlow = uAccent * tr * (0.22 * breathe + 3.2 * pulse);
  } else if (id == 15) {
    // hyperspace: a slow nebula behind star streaks that rush back down the car, and stars that twinkle
    float t = uTime;
    vec2 q = uv * vec2(1.2, 2.5);
    float neb = vnoise(q * 1.7 + vec2(t * 0.06, 0.0)) * 0.6 + vnoise(q * 4.3 + vec2(t * 0.1, 3.0)) * 0.4;
    vec3 space = mix(vec3(0.008, 0.01, 0.026), uAccent * 0.2, smoothstep(0.4, 0.95, neb));
    space = mix(space, hueShift(uAccent, -1.3) * 0.16, smoothstep(0.62, 0.95, vnoise(q * 2.9 + 11.0)));
    float ly = across * 46.0;
    float li = floor(ly);
    float fy = fract(ly) - 0.5;
    float h = hash2(vec2(li, 3.7));
    float z = p.z * 1.6 + t * (1.4 + h * 2.6) + h * 17.0;
    float fz = fract(z);
    float len = 0.35 + 0.5 * hash2(vec2(li, floor(z) + 0.5));
    float tail = clamp(1.0 - fz / len, 0.0, 1.0);
    float streak = step(0.55, hash2(vec2(li, floor(z)))) * smoothstep(0.0, 0.015, fz) * tail * tail * band(abs(fy), 0.05 + 0.13 * tail);
    vec2 sg = uv * 34.0;
    vec2 sc = floor(sg);
    float sh = hash2(sc + 1.7);
    float star = step(0.9, sh) * band(length(fract(sg) - 0.5), 0.05 + 0.04 * fract(sh * 13.0)) * (0.5 + 0.5 * sin(t * (2.0 + sh * 3.0) + sh * 40.0));
    vec3 white = mix(vec3(0.85, 0.92, 1.0), uAccent, 0.35);
    m = 1.0;
    acc = space + white * max(streak, star);
    paintGlow = white * (streak * 2.6 + star * 1.6) + space * 0.3;
  } else if (id == 16) {
    // prism: holographic foil, rainbow bands rolling over the body and a scan of light sweeping nose to tail
    float t = uTime;
    float ph = p.z * 0.45 + p.y * 0.8 + ax * 0.5 - t * 0.22;
    float wob = vnoise(uv * 2.0 + t * 0.12) * 3.0;
    float bands = 0.5 + 0.5 * sin(ph * 12.566 + wob);
    vec3 rainbow = 0.55 + 0.45 * cos(6.2831 * (ph + bands * 0.12 + vec3(0.0, 0.33, 0.67)));
    float la = (p.z + p.y * 0.4) * 240.0;
    float lines = mix(0.85, 0.7 + 0.3 * sin(la), clamp(1.0 - fwidth(la) * 0.4, 0.0, 1.0));
    float sz = mix(2.8, -2.8, fract(t * 0.3));
    float scan = exp(-abs(p.z - sz + p.y * 0.35) * 16.0);
    m = 1.0;
    acc = mix(base, rainbow, 0.55 + 0.35 * bands) * lines;
    paintGlow = rainbow * (0.08 + 0.22 * bands * bands) + mix(uAccent, rainbow, 0.3) * scan * 2.4;
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
    // vinyls are drawn on the base car: follow this body's ride height
    vec4 v = vinyl(p - vec3(0.0, uArchR.w, 0.0), n, base);
    col = mix(col, v.rgb, v.a);
  }
  if (shell) {
    float l = panelLines(p, n);
    col *= 1.0 - 0.85 * l;
    paintGlow *= 1.0 - 0.85 * l;
    rough = mix(rough, 0.9, l);
    cc *= 1.0 - l;
  }
}
`;
