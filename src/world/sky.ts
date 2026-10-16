import {
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  PCFShadowMap,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { ATM, ATMOSPHERE_GLSL, CLOUD_Y, SUN_DIR, installAtmosphereFog, setAtmosphere } from './atmosphere';
import { dayState, GOLDEN_HOUR, type DayState } from './timeOfDay';

export { SUN_DIR } from './atmosphere';

// light-space axes for snapping the shadow map (follow the key light)
const LIGHT_RIGHT = new Vector3();
const LIGHT_UP = new Vector3();
function lightBasis() {
  LIGHT_RIGHT.set(0, 1, 0).cross(SUN_DIR).normalize();
  LIGHT_UP.copy(SUN_DIR).cross(LIGHT_RIGHT).normalize();
}
lightBasis();

/** Fog tint multiplier: the actual haze colour comes from the atmosphere model. */
export const FOG_COLOR = new Color(1, 1, 1);

const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float hash3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);
  float fbm(vec2 p, int oct) {
    float v = 0.0; float a = 0.5;
    for (int i = 0; i < 6; i++) { if (i >= oct) break; v += a * noise(p); p = ROT * p; a *= 0.5; }
    return v;
  }
`;

const skyVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const skyFrag = /* glsl */ `
  uniform float uTime;
  varying vec3 vDir;
  ${ATMOSPHERE_GLSL}
  ${NOISE_GLSL}
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = atmSky(d);
    float c = clamp(dot(d, ATM_SUN), -1.0, 1.0);
    // high cirrus, lit from behind near the sun
    if (h > 0.0) {
      vec2 uv = d.xz / (h + 0.1) * 0.9 + vec2(uTime * 0.003, 0.0);
      float n = fbm(uv * 1.7, 4);
      float cir = smoothstep(0.5, 0.82, n) * smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.5, 0.95, h));
      vec3 cc = mix(atmPal(vec3(0.92, 0.92, 0.98), vec3(0.85, 0.66, 0.78), vec3(0.05, 0.055, 0.09)), ATM_SUN_COL * 2.4, pow(clamp(c * 0.5 + 0.5, 0.0, 1.0), 6.0));
      cc += vec3(0.30, 0.12, 0.22) * uAtmK.w;
      // stars: one per cell of a fine grid on the dome, twinkling, gone behind the cirrus
      float night = uAtmK.z;
      if (night > 0.01) {
        vec3 sp = d * 260.0;
        vec3 cell = floor(sp);
        float r = hash3(cell);
        if (r > 0.985) {
          vec3 f = fract(sp) - 0.5;
          float size = 0.10 + 0.22 * hash3(cell + 7.1);
          float star = smoothstep(size, 0.0, length(f));
          float tw = 0.65 + 0.35 * sin(uTime * (1.5 + 3.0 * hash3(cell + 3.3)) + r * 40.0);
          vec3 tint = mix(vec3(0.75, 0.85, 1.25), vec3(1.25, 1.0, 0.8), hash3(cell + 1.7));
          col += tint * star * tw * (r - 0.985) * 260.0 * night * smoothstep(0.0, 0.25, h);
        }
        // a faint milky band across the sky
        float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.2, 0.93))) * 3.2, 2.0));
        col += vec3(0.05, 0.05, 0.085) * band * fbm(d.xz / (h + 0.3) * 3.0, 4) * night * smoothstep(0.0, 0.3, h);
      }
      col = mix(col, cc, cir * 0.6);
      col += atmSun(d) * (1.0 - cir * 0.8);
      col += atmMoonDisc(d) * (1.0 - cir * 0.6);
    } else {
      col += atmSun(d);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

const cloudVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

/** Sea of clouds: 2D noise density with one light sample towards the sun for self-shadowing and lit edges. */
const cloudFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCam;
  varying vec3 vWorld;
  ${ATMOSPHERE_GLSL}
  ${NOISE_GLSL}
  void main() {
    vec2 p = vWorld.xz * 0.0035 + vec2(uTime * 0.01, uTime * 0.004);
    float detail = fbm(p * 2.7 + 3.1, 3);
    float base = fbm(p, OCT);
    vec2 toSun = normalize(ATM_SUN.xz) * 0.09;
    float baseL = fbm(p + toSun, 3);
    float d = smoothstep(0.3, 0.78, base * 0.75 + detail * 0.35);
    float dl = smoothstep(0.3, 0.78, baseL * 0.75 + detail * 0.35);
    // facing the sun -> brighter, the far side of each billow falls into shadow
    float shade = clamp(0.55 + (d - dl) * 2.4, 0.0, 1.0);
    vec3 amb = atmPal(vec3(0.56, 0.62, 0.84), vec3(0.36, 0.38, 0.62), vec3(0.030, 0.038, 0.085));
    vec3 col = amb * (0.55 + 0.5 * d) + ATM_SUN_COL * 1.15 * shade * (0.3 + 0.7 * d);
    // moonlight silvers the tops of the billows
    col += vec3(0.10, 0.13, 0.24) * shade * d * uAtmMoon.w;
    // a rosy afterglow on the clouds once the sun is down
    col += vec3(0.30, 0.12, 0.20) * d * uAtmK.w;
    // gaps between billows look deep and blue
    col = mix(atmPal(vec3(0.30, 0.38, 0.62), vec3(0.16, 0.15, 0.30), vec3(0.010, 0.012, 0.030)), col, smoothstep(0.0, 0.4, d));
    vec3 v = normalize(vWorld - uCam);
    // silver lining: thin cloud edges light up when looking towards the sun
    col += ATM_SUN_COL * atmPhase(dot(v, ATM_SUN), 0.65) * (1.0 - d) * 2.2;
    float dist = length(vWorld.xz - uCam.xz);
    float f = 1.0 - exp(-dist / 1400.0);
    gl_FragColor = vec4(mix(col, atmHaze(v), clamp(f * f * 1.25, 0.0, 1.0)), 1.0);
  }
`;

export class Sky {
  readonly dome: Mesh;
  readonly clouds: Mesh;
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  private domeMat: ShaderMaterial;
  private cloudMat: ShaderMaterial;
  /** the golden-hour environment (races, garage) */
  envMap: Texture | null = null;
  private envs: Partial<Record<DayState['env'], Texture>> = {};
  private gl: WebGLRenderer | null = null;
  private scenes = new Set<Scene>();
  private envKey: DayState['env'] = 'golden';
  private dayNow = dayState(GOLDEN_HOUR);
  /** Real-time sun shadows (on for every device once enableShadows runs). */
  shadows = false;

  constructor() {
    installAtmosphereFog();
    this.domeMat = new ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      uniforms: { uTime: { value: 0 }, ...ATM },
      side: BackSide,
      depthWrite: false,
    });
    this.dome = new Mesh(new SphereGeometry(1000, 32, 16), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;

    this.cloudMat = new ShaderMaterial({
      vertexShader: cloudVert,
      fragmentShader: cloudFrag,
      defines: { OCT: 5 },
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new Vector3() },
        ...ATM,
      },
    });
    const cg = new PlaneGeometry(9000, 9000, 1, 1);
    cg.rotateX(-Math.PI / 2);
    this.clouds = new Mesh(cg, this.cloudMat);
    this.clouds.position.y = CLOUD_Y;
    this.clouds.frustumCulled = false;

    this.sun = new DirectionalLight(0xffd6ae, 4.6);
    this.sun.position.copy(SUN_DIR).multiplyScalar(100);
    this.hemi = new HemisphereLight(0x8fa4ff, 0x6a5068, 0.22);
  }

  /** Turns on a tight shadow map that follows the action. */
  enableShadows(gl: WebGLRenderer) {
    this.shadows = true;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = PCFShadowMap;
    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(2048, 2048);
    const cam = s.shadow.camera;
    cam.left = -28;
    cam.right = 28;
    cam.top = 28;
    cam.bottom = -28;
    cam.near = 1;
    cam.far = 260;
    cam.updateProjectionMatrix();
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.04;
    s.shadow.radius = 3;
  }

  /** Marks every opaque mesh under `root` as a shadow caster (no-op without shadows). */
  castShadows(root: Object3D) {
    if (!this.shadows) return;
    root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      m.castShadow = mats.every((x) => !x.transparent && x.depthWrite);
    });
  }

  addTo(scene: Scene) {
    scene.add(this.dome, this.clouds, this.sun, this.sun.target, this.hemi);
    scene.fog = new Fog(FOG_COLOR, 900, 4800);
    this.scenes.add(scene);
    if (this.envMap) {
      scene.environment = this.envs[this.envKey] ?? this.envMap;
      scene.environmentIntensity = 0.75;
    }
  }

  /** Renders sky + cloud sea once into a prefiltered environment map used for all reflections and ambient light. */
  bakeEnvironment(gl: WebGLRenderer): Texture {
    this.gl = gl;
    if (this.envMap) return this.envMap;
    this.envMap = this.bake(gl);
    this.envs.golden = this.envMap;
    return this.envMap;
  }

  private bake(gl: WebGLRenderer): Texture {
    const s = new Scene();
    const dome = new Mesh(new SphereGeometry(100, 32, 16), this.domeMat);
    dome.renderOrder = -10;
    const sea = new Mesh(new PlaneGeometry(1800, 1800).rotateX(-Math.PI / 2), this.cloudMat);
    sea.position.y = -100;
    s.add(dome, sea);
    const pm = new PMREMGenerator(gl);
    const tex = pm.fromScene(s, 0.02, 0.1, 1000).texture;
    pm.dispose();
    dome.geometry.dispose();
    sea.geometry.dispose();
    return tex;
  }

  /** The reflections for a time of day (noon and night are baked the first time they're needed). */
  private envFor(key: DayState['env']): Texture | null {
    const have = this.envs[key];
    if (have || !this.gl) return have ?? null;
    // bake it with the sky as it looks at that time, then put the current sky back
    const probe = dayState(key === 'day' ? 12.5 : 0.5);
    setAtmosphere(probe);
    const tex = this.bake(this.gl);
    setAtmosphere(this.dayNow);
    this.envs[key] = tex;
    return tex;
  }

  /**
   * Move the sun (or the moon) to a time of day: sky, clouds, haze, lights and
   * reflections all follow. Races never call this and stay at the golden hour.
   */
  setDay(s: DayState) {
    this.dayNow = s;
    setAtmosphere(s);
    lightBasis();
    this.sun.color.copy(s.lightColor);
    this.sun.intensity = s.lightIntensity;
    this.sun.position.copy(SUN_DIR).multiplyScalar(100);
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;
    if (s.env !== this.envKey) {
      this.envKey = s.env;
      const tex = this.envFor(s.env);
      if (tex) for (const sc of this.scenes) sc.environment = tex;
    }
  }

  /** Bake the noon and night reflections now (while a level loads) instead of mid-drive. */
  prepareDayEnvs() {
    this.envFor('day');
    this.envFor('night');
  }

  /** Back to the golden hour the tracks were made for. */
  resetDay() {
    this.setDay(dayState(GOLDEN_HOUR));
  }

  /**
   * @param focus where the shadow map should be centred (the player car); defaults to the camera.
   */
  update(time: number, camPos: Vector3, cloudY = CLOUD_Y, focus: Vector3 = camPos) {
    this.clouds.position.y = cloudY;
    this.domeMat.uniforms.uTime.value = time;
    this.cloudMat.uniforms.uTime.value = time;
    this.cloudMat.uniforms.uCam.value.copy(camPos);
    this.dome.position.copy(camPos);
    this.clouds.position.x = camPos.x;
    this.clouds.position.z = camPos.z;
    if (this.shadows) {
      // snap to shadow-map texels in light space so edges don't shimmer as the car moves
      const step = 56 / 2048;
      const a = Math.round(focus.dot(LIGHT_RIGHT) / step) * step;
      const b = Math.round(focus.dot(LIGHT_UP) / step) * step;
      const c = focus.dot(SUN_DIR);
      this.sun.target.position.copy(LIGHT_RIGHT).multiplyScalar(a).addScaledVector(LIGHT_UP, b).addScaledVector(SUN_DIR, c);
      this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIR, 120);
      this.sun.target.updateMatrixWorld();
    }
  }
}
