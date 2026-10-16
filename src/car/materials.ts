import {
  AdditiveBlending,
  Vector4,
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
import { PAINT_ZONE_SLOTS, paintById, RIM_COLORS, VINYL_COLORS, type CarBuild, type PaintOption } from './parts';
import { ZONE, ZONE_COUNT } from './zones';
import { PAINT_GLSL } from './paintShader';


/** Shared, immutable materials (one program each, reused by every car). */
export interface SharedMaterials {
  trim: MeshStandardMaterial;
  carbon: MeshStandardMaterial;
  chrome: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  tire: MeshStandardMaterial;
  headlight: MeshBasicMaterial;
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
    brake: new MeshStandardMaterial({ color: 0x55585c, roughness: 0.45, metalness: 0.9 }),
    caliper: new MeshStandardMaterial({ color: 0xd4141c, roughness: 0.35, metalness: 0.3 }),
    shadow: new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.9 }),
  };
  return shared;
}

/** Per-car materials: paint (all zones and the vinyl in one shader), rims, brake lights, boost flames. */
export interface CarMaterials {
  paint: MeshPhysicalMaterial;
  rim: MeshStandardMaterial;
  tail: MeshBasicMaterial;
  flame: MeshBasicMaterial;
  setBrake(on: number): void;
  setPaint(build: CarBuild): void;
  dispose(): void;
}

const VINYL_IDS: Record<string, number> = {
  none: 0,
  stripes: 1,
  side: 2,
  shards: 3,
  checker: 4,
  flames: 5,
  camo: 6,
  tiger: 7,
  halftone: 8,
  livery: 9,
  pinstripe: 10,
  hex: 11,
};

const FINISH = { solid: 0, carbon: 1, flip: 2, well: 3 };

/** The geometry facts the paint shader needs to place panel lines on this build. */
export interface PaintLayout {
  hoodStart: number;
  hoodEnd: number;
}

function hashBuild(b: CarBuild): number {
  let h = 7;
  for (const v of Object.values(b)) for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) % 9973;
  return h;
}

export function createCarMaterials(build: CarBuild, layout: PaintLayout = { hoodStart: 0.72, hoodEnd: 2.0 }): CarMaterials {
  const uniforms = {
    uZoneCol: { value: Array.from({ length: ZONE_COUNT }, () => new Color()) },
    uZoneCol2: { value: Array.from({ length: ZONE_COUNT }, () => new Color()) },
    uZoneMat: { value: Array.from({ length: ZONE_COUNT }, () => new Vector4()) },
    uAccent: { value: new Color() },
    uVinyl: { value: 0 },
    uHood: { value: new Vector4(layout.hoodStart, layout.hoodEnd, 0.6, 0.6) },
    uNumber: { value: 7 },
  };
  // clearcoat on the material switches the clearcoat code path on; each zone then sets its own amount
  const paint = new MeshPhysicalMaterial({ clearcoat: 1, clearcoatRoughness: 0.06, roughness: 0.3, metalness: 0.5 });
  paint.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float zone;\nvarying vec3 vObjPos;\nvarying vec3 vObjN;\nflat varying int vZone;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjN = normal;\nvZone = int(zone + 0.5);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;\nflat varying int vZone;\n${PAINT_GLSL}`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nfloat paintClearcoat = 1.0;\npaintSurface(diffuseColor.rgb, metalnessFactor, roughnessFactor, paintClearcoat, normal, normalize(vViewPosition));')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= paintClearcoat;\n#endif');
  };
  paint.customProgramCacheKey = () => 'hyperdrift-paint-v2';

  const rim = new MeshStandardMaterial({ color: 0xd5dae0, roughness: 0.22, metalness: 1 });
  const tail = new MeshBasicMaterial({ color: new Color(1.6, 0.05, 0.08) });
  const flame = new MeshBasicMaterial({
    color: new Color(0.35, 0.8, 2.2),
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });

  const setZone = (zone: number, p: PaintOption) => {
    uniforms.uZoneCol.value[zone].setHex(p.color);
    uniforms.uZoneCol2.value[zone].setHex(p.color2 ?? p.color);
    const finish = p.finish === 'carbon' ? FINISH.carbon : p.finish === 'flip' ? FINISH.flip : FINISH.solid;
    uniforms.uZoneMat.value[zone].set(p.metalness, p.roughness, p.clearcoat, finish);
  };

  const mats: CarMaterials = {
    paint,
    rim,
    tail,
    flame,
    setBrake(on: number) {
      const k = 1.6 + on * 3.5;
      tail.color.setRGB(k, 0.05 + on * 0.1, 0.08);
    },
    setPaint(b: CarBuild) {
      const base = paintById(b.paint);
      const zoneOf: Record<string, number> = {
        paintFront: ZONE.front,
        paintRear: ZONE.rear,
        paintHood: ZONE.hood,
        paintRoof: ZONE.roof,
        paintSkirts: ZONE.skirts,
        paintSpoiler: ZONE.spoiler,
      };
      setZone(ZONE.body, base);
      for (const slot of PAINT_ZONE_SLOTS) {
        const id = b[slot];
        setZone(zoneOf[slot], id && id !== 'same' ? paintById(id) : base);
      }
      uniforms.uZoneCol.value[ZONE.well].setRGB(0.012, 0.012, 0.014);
      uniforms.uZoneMat.value[ZONE.well].set(0, 0.85, 0, FINISH.well);
      const vc = VINYL_COLORS.find((c) => c.id === b.vinylColor);
      uniforms.uAccent.value.setHex(vc && vc.color >= 0 ? vc.color : base.accent);
      uniforms.uVinyl.value = VINYL_IDS[b.vinyl] ?? 0;
      uniforms.uNumber.value = (hashBuild(b) % 98) + 1;
      // rims: stock colour per design, a chosen colour, or the body paint
      const rc = RIM_COLORS.find((c) => c.id === b.rimColor);
      if (rc && rc.id === 'body') {
        rim.color.setHex(base.finish === 'carbon' ? 0x1a1c20 : base.color);
        rim.metalness = Math.max(0.5, base.metalness);
        rim.roughness = 0.28;
      } else if (rc && rc.color >= 0) {
        rim.color.setHex(rc.color);
        rim.metalness = rc.id === 'white' ? 0.2 : rc.id === 'black' ? 0.6 : 0.95;
        rim.roughness = rc.id === 'black' ? 0.18 : 0.26;
      } else {
        const stock = b.rims === 'mesh' ? [0x3a3e44, 0.9, 0.35] : b.rims === 'turbine' ? [0xf2f2f2, 0.2, 0.3] : [0xd5dae0, 1, 0.22];
        rim.color.setHex(stock[0]);
        rim.metalness = stock[1];
        rim.roughness = stock[2];
      }
    },
    dispose() {
      paint.dispose();
      rim.dispose();
      tail.dispose();
      flame.dispose();
    },
  };
  mats.setPaint(build);
  return mats;
}
