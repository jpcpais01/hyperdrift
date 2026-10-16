import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { paintById } from './parts';

const VINYL_IDS: Record<string, number> = { none: 0, stripes: 1, side: 2, shards: 3 };

/** Shared, immutable materials (one program each, reused by every car). */
export interface SharedMaterials {
  trim: MeshStandardMaterial;
  carbon: MeshStandardMaterial;
  chrome: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  tire: MeshStandardMaterial;
  headlight: MeshBasicMaterial;
  rimSilver: MeshStandardMaterial;
  rimGraphite: MeshStandardMaterial;
  rimWhite: MeshStandardMaterial;
  brake: MeshStandardMaterial;
  caliper: MeshStandardMaterial;
  shadow: MeshBasicMaterial;
}

let shared: SharedMaterials | null = null;

function carbonTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  for (let y = 0; y < 64; y += 8) {
    for (let x = 0; x < 64; x += 8) {
      const odd = ((x + y) / 8) % 2 === 0;
      const grad = g.createLinearGradient(x, y, x + (odd ? 8 : 0), y + (odd ? 0 : 8));
      grad.addColorStop(0, '#16181c');
      grad.addColorStop(0.5, '#2c3036');
      grad.addColorStop(1, '#16181c');
      g.fillStyle = grad;
      g.fillRect(x, y, 8, 8);
    }
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(6, 6);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function shadowTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.85)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.5)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

export function getSharedMaterials(): SharedMaterials {
  if (shared) return shared;
  shared = {
    trim: new MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.55, metalness: 0.2 }),
    carbon: new MeshStandardMaterial({ color: 0x9aa0a8, map: carbonTexture(), roughness: 0.32, metalness: 0.2 }),
    chrome: new MeshStandardMaterial({ color: 0xe8edf2, roughness: 0.12, metalness: 1 }),
    glass: new MeshStandardMaterial({ color: 0x05080d, roughness: 0.04, metalness: 0.9, envMapIntensity: 1.6 }),
    tire: new MeshStandardMaterial({ color: 0x141414, roughness: 0.92, metalness: 0 }),
    headlight: new MeshBasicMaterial({ color: new Color(5, 5.2, 5.6) }),
    rimSilver: new MeshStandardMaterial({ color: 0xd5dae0, roughness: 0.22, metalness: 1 }),
    rimGraphite: new MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.35, metalness: 0.9 }),
    rimWhite: new MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.3, metalness: 0.2 }),
    brake: new MeshStandardMaterial({ color: 0x55585c, roughness: 0.45, metalness: 0.9 }),
    caliper: new MeshStandardMaterial({ color: 0xd4141c, roughness: 0.35, metalness: 0.3 }),
    shadow: new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.9 }),
  };
  return shared;
}

/** Per-car materials (paint colour, vinyl, brake lights and boost flames change per car). */
export interface CarMaterials {
  paint: MeshPhysicalMaterial;
  tail: MeshBasicMaterial;
  flame: MeshBasicMaterial;
  setBrake(on: number): void;
  setPaint(paintId: string, vinylId: string): void;
  dispose(): void;
}

export function createCarMaterials(paintId: string, vinylId: string, ghost = false): CarMaterials {
  const uniforms = {
    uAccent: { value: new Color() },
    uVinyl: { value: 0 },
  };
  const paint = new MeshPhysicalMaterial({ clearcoatRoughness: 0.08 });
  paint.onBeforeCompile = (shader) => {
    shader.uniforms.uAccent = uniforms.uAccent;
    shader.uniforms.uVinyl = uniforms.uVinyl;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vObjPos;
varying vec3 vObjN;
uniform vec3 uAccent;
uniform float uVinyl;
float band(float d, float w) { float aa = fwidth(d) * 1.2 + 1e-4; return 1.0 - smoothstep(w - aa, w + aa, d); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float m = 0.0;
  vec3 n = normalize(vObjN);
  if (uVinyl > 0.5 && uVinyl < 1.5) {
    float ax = abs(vObjPos.x);
    m = band(abs(ax - 0.15), 0.065) * smoothstep(0.2, 0.55, n.y);
  } else if (uVinyl > 1.5 && uVinyl < 2.5) {
    float side = smoothstep(0.45, 0.8, abs(n.x));
    float y0 = 0.47 + 0.05 * vObjPos.z;
    float w = 0.018 + 0.03 * clamp((vObjPos.z + 1.6) / 3.2, 0.0, 1.0);
    m = side * band(abs(vObjPos.y - y0), w) * smoothstep(-2.0, -1.7, vObjPos.z);
    m = max(m, side * band(abs(vObjPos.y - y0 + 0.075), 0.008) * smoothstep(-1.8, -1.2, vObjPos.z) * (1.0 - smoothstep(1.2, 1.5, vObjPos.z)));
  } else if (uVinyl > 2.5) {
    float side = smoothstep(0.45, 0.8, abs(n.x));
    float k = fract(vObjPos.z * 1.3 + vObjPos.y * 2.2);
    float k2 = fract(vObjPos.z * 0.55 - vObjPos.y * 1.7 + 0.3);
    float shard = band(abs(k - 0.5), 0.17) * band(abs(k2 - 0.5), 0.3);
    m = side * shard * smoothstep(-1.4, 0.4, vObjPos.z) * (1.0 - smoothstep(1.2, 1.8, vObjPos.z));
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, m);
}`,
      );
  };
  paint.customProgramCacheKey = () => 'hyperdrift-paint';

  const tail = new MeshBasicMaterial({ color: new Color(1.6, 0.05, 0.08) });
  const flame = new MeshBasicMaterial({
    color: new Color(0.35, 0.8, 2.2),
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });

  const mats: CarMaterials = {
    paint,
    tail,
    flame,
    setBrake(on: number) {
      const k = 1.6 + on * 3.5;
      tail.color.setRGB(k, 0.05 + on * 0.1, 0.08);
    },
    setPaint(paintId: string, vinylId: string) {
      const p = paintById(paintId);
      paint.color.setHex(p.color);
      paint.metalness = p.metalness;
      paint.roughness = p.roughness;
      paint.clearcoat = p.clearcoat;
      uniforms.uAccent.value.setHex(p.accent);
      uniforms.uVinyl.value = VINYL_IDS[vinylId] ?? 0;
    },
    dispose() {
      paint.dispose();
      tail.dispose();
      flame.dispose();
    },
  };
  mats.setPaint(paintId, vinylId);
  if (ghost) {
    paint.transparent = true;
    paint.opacity = 0.35;
    paint.depthWrite = false;
  }
  return mats;
}
