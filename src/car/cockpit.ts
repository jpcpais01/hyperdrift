/**
 * The driver's-eye cockpit: the interior parts assembled for one car, with
 * live gauges, a working rear-view mirror, and gloved hands that steer, shift
 * and pull the handbrake.
 *
 * It lives in its own small scene that is drawn over the world (after a depth
 * clear), so the camera can sit a few centimetres from the dash without
 * wrecking the world's depth precision. The scene follows the car body every
 * frame. Lighting is cheap but convincing: sun and sky, the baked environment
 * for reflections, vertex-baked ambient occlusion, and an analytic roof/door
 * shadow so sunlight only falls in through the glass.
 */
import {
  BufferAttribute,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HalfFloatType,
  HemisphereLight,
  InstancedMesh,
  LinearFilter,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  RepeatWrapping,
  Scene,
  ShaderChunk,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
  type BufferGeometry,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { SUN_DIR } from '../world/atmosphere';
import { mergeAll } from './carBuilder';
import { DashDisplay, type DashStyle } from './dashDisplay';
import {
  ball,
  cabinBase,
  cockpitLayout,
  dashPart,
  faceBasis,
  gloveGeometry,
  handbrakePart,
  mirrorPart,
  mirrorXGeo,
  shifterPart,
  sleeve,
  wheelPart,
  WRIST,
  type CockpitLayout,
  type IBucket,
  type IBuckets,
  type LeverGeo,
} from './interiorGeometry';
import { cabinColor } from './interiorParts';
import { getSharedMaterials } from './materials';
import { paintById, type CarBuild } from './parts';

/** What the cockpit needs to know about the car each frame. */
export interface CockpitDrive {
  /** front-wheel steer angle as the visual wheels show it (rad, + = left) */
  steer: number;
  rpm: number;
  gear: number;
  /** signed forward speed, m/s */
  speed: number;
  nitro: number;
  nitroActive: boolean;
  limiter: boolean;
  drifting: boolean;
  /** lateral acceleration, m/s^2 (+ = pushed left) */
  latAccel: number;
  /** 0..1 handbrake held (countdown / parked) */
  parked: number;
}

const UPPER = 0.3;
const FORE = 0.285;

// ---------------------------------------------------------------- shading

interface ShadeUniforms {
  uCarInv: { value: Matrix4 };
  uSunL: { value: Vector3 };
  uCab0: { value: [number, number, number, number] };
  uCab1: { value: [number, number, number, number] };
}

const SHADE_VERT_HEAD = /* glsl */ `
uniform mat4 uCarInv;
varying vec3 vCab;
`;

const SHADE_FRAG_HEAD = /* glsl */ `
uniform vec3 uSunL;
uniform vec4 uCab0; // roofY, beltY, halfW, zCowl
uniform vec4 uCab1; // zRoofFront, zRoofRear, zB, zBack
varying vec3 vCab;
// Sunlight only reaches a point inside the cabin if the ray towards the sun
// leaves through glass: the windscreen, the rear screen or a side window.
float cabinSun(vec3 p) {
  vec3 s = uSunL;
  if (s.y < 0.01) return 0.25;
  float tR = (uCab0.x - p.y) / s.y;
  // windscreen base / cowl: rays leaving forward below the belt hit the body
  if (s.z > 1e-3) {
    float tc = (uCab0.w - p.z) / s.z;
    if (tc > 0.0 && tc < tR && p.y + s.y * tc < uCab0.y - 0.02) return 0.0;
  }
  if (s.z < -1e-3) {
    float tb = (uCab1.w - p.z) / s.z;
    if (tb > 0.0 && tb < tR && p.y + s.y * tb < uCab0.y) return 0.0;
  }
  if (abs(s.x) > 1e-3) {
    float ts = ((s.x > 0.0 ? uCab0.z : -uCab0.z) - p.x) / s.x;
    if (ts > 0.0 && ts < tR) {
      float y = p.y + s.y * ts;
      float z = p.z + s.z * ts;
      float lit = smoothstep(uCab0.y - 0.015, uCab0.y + 0.03, y);
      lit *= smoothstep(0.04, 0.08, abs(z - uCab1.z));
      lit *= 1.0 - smoothstep(uCab0.w - 0.12, uCab0.w - 0.02, z);
      return lit;
    }
  }
  float hz = p.z + s.z * tR;
  return clamp(smoothstep(uCab1.x - 0.04, uCab1.x + 0.04, hz) + 1.0 - smoothstep(uCab1.y - 0.04, uCab1.y + 0.04, hz), 0.0, 1.0);
}
`;

const LIGHTS_PATCHED = ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cabinSun( vCab );',
);

function cabinMaterial(u: ShadeUniforms, params: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ ...params, vertexColors: true });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${SHADE_VERT_HEAD}`)
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvCab = (uCarInv * modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${SHADE_FRAG_HEAD}`)
      .replace('#include <lights_fragment_begin>', LIGHTS_PATCHED);
  };
  m.customProgramCacheKey = () => 'cabin-sun';
  return m;
}

function woodTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#5a2c12');
  grad.addColorStop(0.5, '#7a3e1a');
  grad.addColorStop(1, '#4d250f');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 64);
  for (let i = 0; i < 46; i++) {
    g.strokeStyle = `rgba(${30 + (i % 3) * 10},${12 + (i % 4) * 4},4,${0.25 + (i % 5) * 0.08})`;
    g.lineWidth = 0.6 + (i % 3) * 0.5;
    g.beginPath();
    const y0 = (i * 64) / 46;
    for (let x = 0; x <= 256; x += 8) g.lineTo(x, y0 + Math.sin(x * 0.045 + i) * 2.2 + Math.sin(x * 0.013 + i * 0.7) * 3);
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(10, 1);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// ---------------------------------------------------------------- the cockpit

interface Arm {
  upper: Mesh;
  fore: Mesh;
  elbow: Mesh;
  shoulder: Vector3;
  pole: Vector3;
}

type HandTask = 'wheel' | 'shift' | 'brake';

export class Cockpit {
  readonly scene = new Scene();
  readonly root = new Group();
  readonly layout: CockpitLayout;
  /** driver's eye in car space */
  readonly eye: Vector3;
  private uniforms: ShadeUniforms;
  private mats: Material[] = [];
  private geos: BufferGeometry[] = [];
  private bucketMat: Record<IBucket, Material>;
  private wheelPivot = new Group();
  private wheelSpin = new Group();
  private grip: number;
  private shifter = new Group();
  private shifterLever = new Group();
  private shifterGeo: LeverGeo;
  private brake = new Group();
  private brakeLever = new Group();
  private brakeGeo: LeverGeo;
  private hands: Group[] = [];
  private arms: Arm[] = [];
  private mirror = new Group();
  private mirrorRT: WebGLRenderTarget | null = null;
  private mirrorCam: PerspectiveCamera;
  private mirrorCamNear: PerspectiveCamera;
  private mirrorFrame = 0;
  private dash: DashDisplay | null = null;
  private screenMat: Material | null = null;
  private dashTimer = 0;
  private leds: InstancedMesh | null = null;
  private ledColor = new Color();
  private sun: DirectionalLight;
  // animation state
  private wheelAngle = 0;
  private lastGear = 0;
  private gearShown = 0;
  private task: HandTask = 'wheel';
  private taskTime = 0;
  private handBlend = 0;
  private shiftKick = 0;
  private brakePull = 0;
  private wasDrifting = false;
  private lastParked = 0;
  private lastSpeed = 0;
  private gLong = 0;
  private gLat = 0;
  private time = 0;

  constructor(
    readonly build: CarBuild,
    private readonly lowEnd = false,
    envMap: Texture | null = null,
  ) {
    const L = cockpitLayout(build.body);
    this.layout = L;
    this.eye = L.eye.clone();
    const f = L.frame;
    this.uniforms = {
      uCarInv: { value: new Matrix4() },
      uSunL: { value: new Vector3(0, 1, 0) },
      uCab0: { value: [f.roofY - 0.02, f.beltY, f.halfW - 0.01, f.zCowl] },
      uCab1: { value: [f.zRoofFront, f.zRoofRear, f.zB, f.zBack + 0.15] },
    };

    // --- lights: same sun and sky as the world, plus the baked environment for reflections
    this.sun = new DirectionalLight(0xffd6ae, 3.4);
    this.sun.position.copy(SUN_DIR).multiplyScalar(50);
    this.scene.add(this.sun, this.sun.target, new HemisphereLight(0xa8b8ff, 0x4a3a36, 0.95));
    if (envMap) {
      this.scene.environment = envMap;
      this.scene.environmentIntensity = 0.8;
    }
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);

    // --- materials
    const paint = paintById(build.paint);
    const accent = new Color(paint.color);
    if (lum(accent) < 0.04) accent.set(paint.accent);
    if (lum(accent) < 0.04) accent.set(0x18e0ff);
    // ambient light strips take the paint's hue; greys, whites and blacks get a cool cyan
    const hsl = { h: 0, s: 0, l: 0 };
    accent.getHSL(hsl);
    const glow = hsl.s < 0.3 ? new Color(0x18e0ff) : new Color().setHSL(hsl.h, Math.max(0.7, hsl.s), 0.55);
    glow.multiplyScalar(1.5);
    const leather = new Color(cabinColor(build.cabinColor));
    const u = this.uniforms;
    const shared = getSharedMaterials();
    const mk = (p: ConstructorParameters<typeof MeshStandardMaterial>[0]) => this.own(cabinMaterial(u, p));
    this.bucketMat = {
      dark: mk({ color: 0x1d1e22, roughness: 0.66, metalness: 0.05 }),
      soft: mk({ color: 0x2a2b30, roughness: 0.82, metalness: 0 }),
      leather: mk({ color: leather, roughness: 0.52, metalness: 0 }),
      fabric: mk({ color: build.cockpit === 'future' ? 0x34363c : 0x25262a, roughness: 0.96, metalness: 0 }),
      carbon: mk({ color: 0x9aa0a8, map: shared.carbon.map, roughness: 0.26, metalness: 0.25 }),
      metal: mk({ color: 0x8f959d, roughness: 0.34, metalness: 1 }),
      chrome: mk({ color: 0xc9cdd3, roughness: 0.1, metalness: 1 }),
      accent: mk({ color: accent, roughness: 0.38, metalness: Math.min(0.6, paint.metalness) }),
      wood: mk({ color: 0xffffff, map: woodTexture(), roughness: 0.28, metalness: 0 }),
      glow: this.own(new MeshBasicMaterial({ color: glow, vertexColors: true })),
      red: mk({ color: 0xc4111b, roughness: 0.38, metalness: 0.1 }),
    };
    const accentCss = '#' + accent.getHexString();

    // --- static cabin: base + dash parts, baked ambient occlusion
    const base = cabinBase(build, L);
    const dash = dashPart(build, L);
    for (const k of Object.keys(dash.buckets) as IBucket[]) base[k].push(...dash.buckets[k]);
    this.addBuckets(this.root, base, (p) => this.ao(p));
    if (dash.screens.length || build.wheel === 'yoke') {
      this.dash = new DashDisplay(build.dash as DashStyle, accentCss, build.wheel === 'yoke');
      const screenMat = this.own(new MeshBasicMaterial({ map: this.dash.texture, color: new Color(1.25, 1.25, 1.25) }));
      const sg = mergeAll(dash.screens);
      if (sg) this.root.add(this.mesh(this.withAO(sg, null), screenMat));
      this.screenMat = screenMat;
    }
    if (dash.leds.length) {
      const g = this.geo(new SphereGeometry(0.0065, 10, 8));
      const m = this.own(new MeshBasicMaterial({ color: 0xffffff }));
      const im = new InstancedMesh(g, m, dash.leds.length);
      dash.leds.forEach((p, i) => im.setMatrixAt(i, new Matrix4().setPosition(p)));
      im.frustumCulled = false;
      this.leds = im;
      this.root.add(im);
    }

    // --- steering wheel on its column
    const wg = wheelPart(build.wheel);
    this.grip = wg.grip;
    this.wheelPivot.matrixAutoUpdate = false;
    this.wheelPivot.matrix.copy(faceBasis(new Vector3(0, Math.sin(L.wheelTilt), -Math.cos(L.wheelTilt)), L.wheel));
    this.wheelPivot.add(this.wheelSpin);
    const wheelToCar = this.wheelPivot.matrix.clone();
    this.addBuckets(this.wheelSpin, wg.buckets, (p) => this.ao(p.applyMatrix4(wheelToCar)));
    if (wg.screen && this.screenMat) this.wheelSpin.add(this.mesh(this.withAO(wg.screen, null), this.screenMat));
    this.root.add(this.wheelPivot);

    // --- gear lever and handbrake
    this.shifterGeo = shifterPart(build.shifter);
    this.shifter.position.copy(L.shifter);
    this.shifter.add(this.shifterLever);
    this.addBuckets(this.shifter, this.shifterGeo.base, (p) => this.ao(p.add(L.shifter)));
    this.addBuckets(this.shifterLever, this.shifterGeo.lever, (p) => this.ao(p.add(L.shifter)));
    this.root.add(this.shifter);
    this.brakeGeo = handbrakePart(build.handbrake);
    this.brake.position.copy(L.handbrake);
    this.brake.add(this.brakeLever);
    this.addBuckets(this.brake, this.brakeGeo.base, (p) => this.ao(p.add(L.handbrake)));
    this.addBuckets(this.brakeLever, this.brakeGeo.lever, (p) => this.ao(p.add(L.handbrake)));
    this.root.add(this.brake);

    // --- rear-view mirror: a live render of what's behind
    const mg = mirrorPart(build.mirror);
    const toEye = L.eye.clone().sub(L.mirror).normalize();
    const n = toEye.add(new Vector3(0, 0, -1)).normalize();
    this.mirror.matrixAutoUpdate = false;
    this.mirror.matrix.copy(faceBasis(n, L.mirror));
    const mirrorToCar = this.mirror.matrix.clone();
    this.addBuckets(this.mirror, mg.buckets, (p) => this.ao(p.applyMatrix4(mirrorToCar)));
    const aspect = mg.w / mg.h;
    const rtW = lowEnd ? 320 : 512;
    this.mirrorRT = new WebGLRenderTarget(rtW, Math.round(rtW / aspect), { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter });
    const glassMat = this.own(new MeshBasicMaterial({ map: this.mirrorRT.texture, color: new Color(0.82, 0.84, 0.88) }));
    const glass = this.mesh(mg.glass, glassMat);
    this.mirror.add(glass);
    // the mirror's camera sits at the glass and looks along the eye ray reflected in it
    const v = L.mirror.clone().sub(L.eye).normalize();
    const r = v.clone().addScaledVector(n, -2 * v.dot(n));
    const vfov = 2 * Math.atan(mg.h / 2 / L.eye.distanceTo(L.mirror)) * (180 / Math.PI) * 2.2;
    this.mirrorCam = new PerspectiveCamera(vfov, aspect, 0.6, 1600);
    this.mirrorCamNear = new PerspectiveCamera(vfov, aspect, 0.02, 4);
    const camMat = new Matrix4().lookAt(L.mirror, L.mirror.clone().sub(r), new Vector3(0, 1, 0)).setPosition(L.mirror);
    for (const c of [this.mirrorCam, this.mirrorCamNear]) {
      c.matrixAutoUpdate = false;
      c.matrix.copy(camMat);
      this.root.add(c);
    }
    this.root.add(this.mirror);

    // --- driver: gloved hands and sleeves
    const gl = gloveGeometry();
    const gloveMat = mk({ color: 0x17181b, roughness: 0.62, metalness: 0 });
    // race suit: charcoal with a hint of the car's colour
    const suitMat = mk({ color: new Color(0x23262c).lerp(accent, 0.3), roughness: 0.9, metalness: 0 });
    const gGlove = this.withAO(mergeAll(gl.glove)!, null);
    const gTrim = this.withAO(mergeAll(gl.trim)!, null);
    for (const side of [1, -1]) {
      const hand = new Group();
      hand.matrixAutoUpdate = false;
      hand.add(this.mesh(side > 0 ? gGlove : this.withAO(mirrorXGeo(gGlove), null), gloveMat));
      hand.add(this.mesh(side > 0 ? gTrim : this.withAO(mirrorXGeo(gTrim), null), this.bucketMat.accent));
      this.root.add(hand);
      this.hands.push(hand);
    }
    const gUpper = this.withAO(sleeve(UPPER, 0.052, 0.046), null);
    const gFore = this.withAO(sleeve(FORE, 0.045, 0.036), null);
    const gElbow = this.withAO(ball(0.047, [0, 0, 0], 12, 10), null);
    for (const side of [1, -1]) {
      const arm: Arm = {
        upper: this.mesh(gUpper, suitMat),
        fore: this.mesh(gFore, suitMat),
        elbow: this.mesh(gElbow, suitMat),
        // hands[0] is the right hand: shoulder on the car's right (-x)
        shoulder: side > 0 ? L.shoulderR.clone() : L.shoulderL.clone(),
        pole: new Vector3(side > 0 ? -1 : 1, -1.1, -0.2).normalize(),
      };
      this.root.add(arm.upper, arm.fore, arm.elbow);
      this.arms.push(arm);
    }
    this.update(0, IDLE_DRIVE);
  }

  private own<M extends Material>(m: M): M {
    this.mats.push(m);
    return m;
  }

  private geo<G extends BufferGeometry>(g: G): G {
    this.geos.push(g);
    return g;
  }

  private mesh(g: BufferGeometry, m: Material): Mesh {
    if (!this.geos.includes(g)) this.geos.push(g);
    const mesh = new Mesh(g, m);
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Cheap baked ambient occlusion from where a point sits in the cabin. */
  private ao(p: Vector3): number {
    const L = this.layout;
    const f = L.frame;
    const sm = (a: number, b: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    let k = 0.5 + 0.5 * sm(L.floorY, L.dashTop + 0.06, p.y);
    // deep under the dash and in the footwells
    if (p.y < L.dashTop - 0.04) k *= 1 - 0.45 * sm(L.zFace - 0.05, L.zFace + 0.3, p.z);
    // corners where the headliner meets the pillars
    if (p.y > f.beltY + 0.1) k *= 1 - 0.25 * sm(f.roofW * 0.55, f.roofW, Math.abs(p.x));
    return Math.max(0.25, Math.min(1, k));
  }

  private withAO(g: BufferGeometry, fn: ((p: Vector3) => number) | null): BufferGeometry {
    const pos = g.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    const v = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      const k = fn ? fn(v.fromBufferAttribute(pos, i)) : 1;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    return g;
  }

  private addBuckets(parent: Object3D, b: IBuckets, ao: (p: Vector3) => number) {
    for (const k of Object.keys(b) as IBucket[]) {
      const g = mergeAll(b[k]);
      if (!g) continue;
      parent.add(this.mesh(this.withAO(g, k === 'glow' ? null : ao), this.bucketMat[k]));
    }
  }

  /** Puts the cockpit where the car body is (call after the body has moved). */
  follow(body: Object3D) {
    body.updateWorldMatrix(true, false);
    this.root.matrix.copy(body.matrixWorld);
    this.root.matrixWorldNeedsUpdate = true;
    this.uniforms.uCarInv.value.copy(body.matrixWorld).invert();
    this.uniforms.uSunL.value.copy(SUN_DIR).transformDirection(this.uniforms.uCarInv.value);
  }

  /** Eye position in world space (after follow). */
  eyeWorld(out: Vector3): Vector3 {
    return out.copy(this.eye).applyMatrix4(this.root.matrix);
  }

  update(dt: number, d: CockpitDrive) {
    this.time += dt;
    const k = (rate: number) => 1 - Math.exp(-rate * dt);

    // --- steering wheel: the front wheels' angle times the steering ratio
    const target = Math.max(-2.3, Math.min(2.3, d.steer * 3.6));
    this.wheelAngle += (target - this.wheelAngle) * (dt > 0 ? k(22) : 1);
    this.wheelSpin.rotation.z = this.wheelAngle;
    this.wheelSpin.updateMatrix();

    // --- g-forces for the displays
    if (dt > 0) {
      const acc = (d.speed - this.lastSpeed) / dt;
      this.gLong += (acc / 14 - this.gLong) * k(5);
      this.gLat += (d.latAccel / 22 - this.gLat) * k(5);
    }
    this.lastSpeed = d.speed;

    // --- hand tasks: shifting and the handbrake take the right hand off the wheel
    const reversing = d.speed < -0.5;
    if (d.gear !== this.lastGear && !reversing && dt > 0) {
      const up = d.gear > this.lastGear;
      this.lastGear = d.gear;
      this.task = 'shift';
      this.taskTime = 0;
      this.shiftKick = up ? 1 : -1;
    }
    // lights out: the driver drops the handbrake
    if (this.lastParked > 0.5 && d.parked < 0.5 && dt > 0) {
      this.task = 'brake';
      this.taskTime = 0.2;
    }
    this.lastParked = d.parked;
    if (d.drifting && !this.wasDrifting && dt > 0) {
      this.task = 'brake';
      this.taskTime = 0;
    }
    this.wasDrifting = d.drifting;
    this.taskTime += dt;
    const hold = this.task === 'shift' ? 0.42 : this.task === 'brake' ? 0.55 : 0;
    if (this.task !== 'wheel' && this.taskTime > hold) this.task = 'wheel';
    const want = this.task === 'wheel' ? 0 : 1;
    this.handBlend += (want - this.handBlend) * (dt > 0 ? k(want ? 16 : 9) : 1);

    // gear lever: moves once the hand gets there
    const reach = this.handBlend > 0.6 || dt === 0;
    if (reach) this.gearShown = reversing ? -1 : d.gear;
    this.poseShifter(dt);
    const pull = Math.max(d.parked, this.task === 'brake' && this.handBlend > 0.6 ? 1 : 0);
    this.brakePull += (pull - this.brakePull) * (dt > 0 ? k(pull > this.brakePull ? 18 : 7) : 1);
    this.poseHandbrake();

    // --- hands and arms
    this.poseHands();

    // --- displays
    this.dashTimer -= dt;
    if (this.dash && this.dashTimer <= 0) {
      this.dashTimer = this.lowEnd ? 1 / 15 : 1 / 30;
      this.dash.draw({
        rpm: d.rpm,
        speedKmh: Math.abs(d.speed) * 3.6,
        gear: reversing ? 'R' : Math.abs(d.speed) < 0.3 && d.rpm < 0.2 ? 'N' : String(d.gear + 1),
        nitro: d.nitro,
        nitroActive: d.nitroActive,
        limiter: d.limiter,
        gLat: this.gLat,
        gLong: this.gLong,
        time: this.time,
      });
    }
    if (this.leds) {
      const n = this.leds.count;
      const flash = d.limiter && Math.sin(this.time * 38) > 0;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const on = d.rpm > 0.55 + t * 0.42;
        if (flash) this.ledColor.setRGB(0.6, 1.4, 4);
        else if (!on) this.ledColor.setRGB(0.04, 0.04, 0.05);
        else if (t < 0.4) this.ledColor.setRGB(0.3, 3, 0.6);
        else if (t < 0.75) this.ledColor.setRGB(3, 1.8, 0.2);
        else this.ledColor.setRGB(3.4, 0.3, 0.3);
        this.leds.setColorAt(i, this.ledColor);
      }
      if (this.leds.instanceColor) this.leds.instanceColor.needsUpdate = true;
    }
  }

  private poseShifter(dt: number) {
    const lever = this.shifterLever;
    const id = this.build.shifter;
    const g = this.gearShown;
    let rx = 0;
    let rz = 0;
    if (id === 'sequential') {
      // springs back to centre: pulled for an upshift, pushed for a downshift
      this.shiftKick *= Math.exp(-7 * dt);
      rx = -this.shiftKick * 0.32 * Math.min(1, this.handBlend * 1.5);
    } else {
      // H pattern: 1-2 on the left, 3-4 middle, 5-6 right; odd gears forward
      const col = g < 0 ? -1 : Math.floor(g / 2);
      const fwd = g < 0 ? 1 : g % 2 === 0 ? 1 : -1;
      // driver's left is +x
      rz = -(col - 1) * 0.16 * (id === 'gated' ? 1 : 0.9);
      rx = fwd * 0.3;
    }
    const e = dt > 0 ? 1 - Math.exp(-20 * dt) : 1;
    lever.rotation.x += (rx - lever.rotation.x) * e;
    lever.rotation.z += (rz - lever.rotation.z) * e;
  }

  private poseHandbrake() {
    const p = this.brakePull;
    const id = this.build.handbrake;
    if (id === 'hydro') this.brakeLever.rotation.x = -p * 0.42;
    else if (id === 'button') this.brakeLever.position.y = -p * 0.006;
    else this.brakeLever.rotation.x = -p * 0.38;
  }

  private gripMatrix(group: Object3D, lever: Object3D, geo: LeverGeo, out: Matrix4) {
    group.updateMatrix();
    lever.updateMatrix();
    const m = _m1.multiplyMatrices(group.matrix, lever.matrix);
    const pos = _v1.copy(geo.grip).applyMatrix4(m);
    const y = _v2.copy(geo.gripAxis).transformDirection(m);
    const shoulder = this.arms[0].shoulder;
    const z = _v3.copy(shoulder).sub(pos);
    z.addScaledVector(y, -z.dot(y)).normalize();
    const x = _v4.crossVectors(y, z);
    return out.makeBasis(x, y, z).setPosition(pos);
  }

  private poseHands() {
    const wheelM = _m2.multiplyMatrices(this.wheelPivot.matrix, this.wheelSpin.matrix);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const hand = this.hands[i];
      const onWheel = _m3.multiplyMatrices(wheelM, _m4.makeTranslation(side * this.grip, 0, 0));
      if (i === 0 && this.handBlend > 0.001) {
        const target = this.task === 'brake' || (this.task === 'wheel' && this.brakePull > 0.5 && this.handBlend > 0.01)
          ? this.gripMatrix(this.brake, this.brakeLever, this.brakeGeo, _m5)
          : this.gripMatrix(this.shifter, this.shifterLever, this.shifterGeo, _m5);
        blendMatrix(onWheel, target, this.handBlend, hand.matrix);
      } else hand.matrix.copy(onWheel);
      hand.matrixWorldNeedsUpdate = true;
      // arm: two-bone IK from the shoulder to the glove's wrist
      const wrist = _v1.set(side * WRIST.x, WRIST.y, WRIST.z).applyMatrix4(hand.matrix);
      this.solveArm(this.arms[i], wrist);
    }
  }

  private solveArm(arm: Arm, wrist: Vector3) {
    const S = arm.shoulder;
    const dir = _v2.copy(wrist).sub(S);
    const d = Math.min(UPPER + FORE - 0.002, Math.max(0.05, dir.length()));
    dir.normalize();
    const cosA = (UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const perp = _v3.copy(arm.pole).addScaledVector(dir, -arm.pole.dot(dir)).normalize();
    const elbow = _v4.copy(S).addScaledVector(dir, UPPER * cosA).addScaledVector(perp, UPPER * sinA);
    place(arm.upper, S, elbow);
    place(arm.fore, elbow, wrist);
    arm.elbow.position.copy(elbow);
  }

  /** Renders the live rear view into the mirror (every other frame or so). */
  renderMirror(gl: WebGLRenderer, world: Scene) {
    if (!this.mirrorRT) return;
    this.mirrorFrame++;
    if (this.mirrorFrame % (this.lowEnd ? 3 : 2) !== 0) return;
    this.root.updateMatrixWorld(true);
    const prevTarget = gl.getRenderTarget();
    const autoClear = gl.autoClear;
    const shadowAuto = gl.shadowMap.autoUpdate;
    gl.autoClear = false;
    gl.shadowMap.autoUpdate = false;
    this.mirror.visible = false;
    gl.setRenderTarget(this.mirrorRT);
    gl.clear(true, true, true);
    gl.render(world, this.mirrorCam);
    gl.clearDepth();
    gl.render(this.scene, this.mirrorCamNear);
    gl.setRenderTarget(prevTarget);
    this.mirror.visible = true;
    gl.autoClear = autoClear;
    gl.shadowMap.autoUpdate = shadowAuto;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) {
      const map = (m as MeshStandardMaterial).map;
      if (map && map !== getSharedMaterials().carbon.map) map.dispose();
      m.dispose();
    }
    this.dash?.dispose();
    this.mirrorRT?.dispose();
    this.leds?.dispose();
  }
}

/** A parked car at idle (garage, countdown). */
export const IDLE_DRIVE: CockpitDrive = {
  steer: 0,
  rpm: 0.12,
  gear: 0,
  speed: 0,
  nitro: 1,
  nitroActive: false,
  limiter: false,
  drifting: false,
  latAccel: 0,
  parked: 0,
};

const _m1 = new Matrix4();
const _m2 = new Matrix4();
const _m3 = new Matrix4();
const _m4 = new Matrix4();
const _m5 = new Matrix4();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _pa = new Vector3();
const _pb = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _s = new Vector3();
const UP = new Vector3(0, 1, 0);

function blendMatrix(a: Matrix4, b: Matrix4, t: number, out: Matrix4) {
  a.decompose(_pa, _qa, _s);
  b.decompose(_pb, _qb, _s);
  // arc the hand a little upwards on the way, so it doesn't clip through the console
  const lift = Math.sin(t * Math.PI) * 0.05;
  _pa.lerp(_pb, t);
  _pa.y += lift;
  _qa.slerp(_qb, t);
  out.compose(_pa, _qa, _s.set(1, 1, 1));
}

function place(m: Mesh, a: Vector3, b: Vector3) {
  const d = _pb.copy(b).sub(a);
  m.position.copy(a);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
}
