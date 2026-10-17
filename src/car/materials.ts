import {
  AdditiveBlending,
  Vector2,
  Vector3,
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
  carbon: MeshPhysicalMaterial;
  chrome: MeshStandardMaterial;
  glass: MeshPhysicalMaterial;
  tire: MeshStandardMaterial;
  housing: MeshStandardMaterial;
  lens: MeshPhysicalMaterial;
  tailLens: MeshPhysicalMaterial;
  plastic: MeshStandardMaterial;
  headlight: MeshBasicMaterial;
  brake: MeshStandardMaterial;
  caliper: MeshStandardMaterial;
  shadow: MeshBasicMaterial;
}

let shared: SharedMaterials | null = null;

function carbonTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  // 2x2 twill weave: tows run in diagonal steps, each lit along its length so the
  // weave flips between light and dark as the car turns (with the clearcoat on top)
  const N = 128;
  const tow = 8;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#0c0d10';
  g.fillRect(0, 0, N, N);
  for (let j = 0; j < N / tow; j++) {
    for (let i = 0; i < N / tow; i++) {
      const warp = Math.floor((i + j) / 2) % 2 === 0;
      const x = i * tow;
      const y = j * tow;
      const grad = warp ? g.createLinearGradient(x, y, x + tow, y) : g.createLinearGradient(x, y, x, y + tow);
      grad.addColorStop(0, '#0e1013');
      grad.addColorStop(0.35, warp ? '#3a3f47' : '#22262c');
      grad.addColorStop(0.65, warp ? '#2e333a' : '#1a1d22');
      grad.addColorStop(1, '#0e1013');
      g.fillStyle = grad;
      g.fillRect(x + 0.5, y + 0.5, tow - 1, tow - 1);
    }
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  // the cockpit maps it by UV at this repeat; the body samples it triplanar
  t.repeat.set(6, 6);
  t.anisotropy = 4;
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Fine grain for black plastic so it reads as moulded trim, not flat paint. */
function grainTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const N = 64;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(N, N);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N * N; i++) {
    const v = 150 + rnd() * 105;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
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


/**
 * Tyre textures laid out on the tyre's UVs (see tireGeometry): u around the
 * tyre, v across the profile with the outer sidewall at the bottom of the
 * canvas, the tread in the middle and the inner sidewall at the top.
 */
function tireTextures(): { map: Texture; bump: Texture; rough: Texture } | null {
  if (typeof document === 'undefined') return null;
  const Wd = 2048;
  const H = 512;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = Wd;
    c.height = H;
    return [c, c.getContext('2d')!] as const;
  };
  const [cm, gm] = mk();
  const [cb, gb] = mk();
  const [cr, gr] = mk();
  if (!gm || !gb || !gr) return null;
  // canvas y for a profile v (flipY puts v = 0 at the bottom)
  const Y = (v: number) => H * (1 - v);
  const band = (g: CanvasRenderingContext2D, v0: number, v1: number, fill: string) => {
    g.fillStyle = fill;
    g.fillRect(0, Y(v1), Wd, Y(v0) - Y(v1));
  };
  // base: satin sidewalls, matte tread
  band(gm, 0, 1, '#1b1b1d');
  band(gb, 0, 1, '#808080');
  band(gr, 0, 1, '#b8b8b8');
  band(gr, 0.33, 0.67, '#f0f0f0');
  // rim protector rib and a fine ring just under the shoulder, both sides
  for (const [v0, v1] of [[0.025, 0.05], [0.27, 0.278], [0.722, 0.73], [0.95, 0.975]] as const) {
    band(gb, v0, v1, '#c8c8c8');
    band(gr, v0, v1, '#9a9a9a');
  }
  // tread: raised blocks cut by two circumferential grooves, directional sipes and shoulder slots
  band(gb, 0.33, 0.67, '#d8d8d8');
  band(gm, 0.33, 0.67, '#1a1a1b');
  gb.fillStyle = '#202020';
  for (const vc of [0.44, 0.56]) gb.fillRect(0, Y(vc + 0.012), Wd, Y(vc - 0.012) - Y(vc + 0.012));
  const pitch = Wd / 72;
  gb.strokeStyle = '#303030';
  for (let i = 0; i < 72; i++) {
    const x = i * pitch;
    // centre rib: thin angled sipes
    gb.lineWidth = 3;
    gb.beginPath();
    gb.moveTo(x, Y(0.452));
    gb.lineTo(x + pitch * 0.45, Y(0.548));
    gb.stroke();
    // the outer blocks: wide slots running out over the shoulders, slanted the same way on both sides
    gb.lineWidth = 7;
    for (const [va, vb] of [[0.43, 0.33], [0.57, 0.67]] as const) {
      gb.beginPath();
      gb.moveTo(x + pitch * 0.15, Y(va));
      gb.lineTo(x + pitch * 0.55, Y(vb));
      gb.stroke();
    }
  }
  // outer sidewall lettering: raised, a touch lighter and glossier than the rubber round it
  const words = ['HYPERDRIFT', 'SPORT R  ·  275/35 ZR20  ·  98Y'];
  const vText = 0.155;
  for (let k = 0; k < 4; k++) {
    const txt = words[k % 2];
    const size = k % 2 === 0 ? 46 : 26;
    const cx = (k + 0.5) * (Wd / 4);
    for (const [g, fill] of [[gm, '#4a4a4e'], [gb, '#e8e8e8'], [gr, '#7a7a7a']] as const) {
      g.save();
      g.font = `${k % 2 === 0 ? '900 italic' : '700'} ${size}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = fill;
      g.translate(cx, Y(vText));
      // stretch the letters along the tyre: u covers the whole circumference
      g.scale(1.6, 1);
      g.fillText(txt, 0, 0);
      g.restore();
    }
  }
  const map = new CanvasTexture(cm);
  map.colorSpace = SRGBColorSpace;
  const bump = new CanvasTexture(cb);
  const rough = new CanvasTexture(cr);
  for (const t of [map, bump, rough]) {
    t.wrapS = RepeatWrapping;
    t.anisotropy = 4;
  }
  return { map, bump, rough };
}

/**
 * Sample a material's map (or roughness map) triplanar in car space, so the
 * texture lies evenly on any generated or conformed part without UVs.
 */
function triplanar<T extends MeshStandardMaterial>(mat: T, scale: number, key: string): T {
  const which = mat.map ? 'map' : 'roughnessMap';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTriPos = position;\nvTriN = normal;');
    const sample = `vec4 triSample(sampler2D t) {
      vec3 w = pow(abs(normalize(vTriN)), vec3(4.0));
      w /= (w.x + w.y + w.z);
      vec3 p = vTriPos * uTriScale;
      return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
    }`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nuniform float uTriScale;\nvarying vec3 vTriPos;\nvarying vec3 vTriN;\n${sample}`);
    if (which === 'map') {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', 'diffuseColor *= triSample(map);');
    } else {
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * triSample(roughnessMap).g;');
    }
  };
  mat.customProgramCacheKey = () => `hyperdrift-tri-${key}`;
  return mat;
}

export function getSharedMaterials(): SharedMaterials {
  if (shared) return shared;
  shared = {
    // satin black trim (window surrounds, grille frames, housings): a soft sheen that shows its shape
    trim: new MeshStandardMaterial({ color: 0x121418, roughness: 0.42, metalness: 0.35 }),
    // twill carbon under a thick clearcoat
    carbon: triplanar(new MeshPhysicalMaterial({ color: 0xffffff, map: carbonTexture(), roughness: 0.38, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 }), 2.2, 'carbon'),
    chrome: new MeshStandardMaterial({ color: 0xf2f5f8, roughness: 0.06, metalness: 1, envMapIntensity: 1.2 }),
    // tinted glass: a dark dielectric, so it mirrors the sky at grazing angles and goes deep smoked-black head on
    glass: new MeshPhysicalMaterial({ color: 0x0a0f16, roughness: 0.02, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.01, envMapIntensity: 1.8, specularIntensity: 1 }),
    tire: (() => {
      const t = tireTextures();
      return new MeshStandardMaterial({ color: t ? 0xffffff : 0x17171a, map: t?.map ?? null, bumpMap: t?.bump ?? null, bumpScale: 1.4, roughnessMap: t?.rough ?? null, roughness: t ? 1 : 0.88, metalness: 0 });
    })(),
    // polished dark reflector bowls behind every lamp
    housing: new MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.14, metalness: 1 }),
    // clear lamp cover: barely there head on, a bright sky reflection at the edges
    lens: new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false, envMapIntensity: 2.2, clearcoat: 1, clearcoatRoughness: 0 }),
    // red tail-lamp bed: deep glossy red when off, under the lit elements
    tailLens: new MeshPhysicalMaterial({ color: 0x4a0309, emissive: new Color(0.16, 0.0, 0.008), roughness: 0.08, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 1.4 }),
    plastic: triplanar(new MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.85, metalness: 0, roughnessMap: grainTexture() }), 9, 'plastic'),
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
  /** door shut lines (front, rear) and the fuel filler's z */
  doors?: [number, number, number];
  /** height span of the door lines and the fuel filler's height */
  doorY?: [number, number, number];
  /** z of the front and rear bumper splits */
  ends?: [number, number];
  /** wheel arches: centre height, axle z and opening radius */
  archF?: [number, number, number];
  archR?: [number, number, number];
  /** body height against the base car (vinyls follow it) */
  lift?: number;
  /** x of the wheel-well walls */
  wellX?: number;
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
    uDoor: { value: new Vector3(...(layout.doors ?? [0.84, -0.64, -0.98])) },
    uDoorY: { value: new Vector3(...(layout.doorY ?? [0.3, 0.92, 0.72])) },
    uEnds: { value: new Vector2(...(layout.ends ?? [1.78, -1.78])) },
    uArchF: { value: new Vector4(...(layout.archF ?? [0.34, 1.32, 0.405]), layout.wellX ?? 0.5) },
    uArchR: { value: new Vector4(...(layout.archR ?? [0.34, -1.3, 0.405]), layout.lift ?? 0) },
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
  paint.customProgramCacheKey = () => 'hyperdrift-paint-v4';

  const rim = new MeshStandardMaterial({ color: 0xd5dae0, roughness: 0.22, metalness: 1 });
  const tail = new MeshBasicMaterial({ color: new Color(1.5, 0.012, 0.02) });
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
      tail.color.setRGB(k, 0.012 + on * 0.06, 0.02);
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
        const STOCK: Record<string, [number, number, number]> = {
          mesh: [0x3a3e44, 0.9, 0.35],
          turbine: [0xf2f2f2, 0.2, 0.3],
          dish: [0xe8ecf0, 1, 0.12],
          rally: [0xf4f4f2, 0.15, 0.4],
          blade: [0x8a6a3a, 0.9, 0.28],
        };
        const stock = STOCK[b.rims] ?? [0xd5dae0, 1, 0.22];
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
