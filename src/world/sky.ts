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
import { ATMOSPHERE_GLSL, CLOUD_Y, SUN_DIR, installAtmosphereFog } from './atmosphere';

export { SUN_DIR } from './atmosphere';

const LIGHT_RIGHT = new Vector3(0, 1, 0).cross(SUN_DIR).normalize();
const LIGHT_UP = SUN_DIR.clone().cross(LIGHT_RIGHT).normalize();

/** Fog tint multiplier: the actual haze colour comes from the atmosphere model. */
export const FOG_COLOR = new Color(1, 1, 1);

const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
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
    float c = dot(d, ATM_SUN);
    // high cirrus, lit from behind near the sun
    if (h > 0.0) {
      vec2 uv = d.xz / (h + 0.1) * 0.9 + vec2(uTime * 0.003, 0.0);
      float n = fbm(uv * 1.7, 4);
      float cir = smoothstep(0.5, 0.82, n) * smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.5, 0.95, h));
      vec3 cc = mix(vec3(0.85, 0.66, 0.78), ATM_SUN_COL * 2.4, pow(clamp(c * 0.5 + 0.5, 0.0, 1.0), 6.0));
      col = mix(col, cc, cir * 0.6);
      col += atmSun(d) * (1.0 - cir * 0.8);
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
    vec3 amb = vec3(0.36, 0.38, 0.62);
    vec3 col = amb * (0.55 + 0.5 * d) + ATM_SUN_COL * 1.15 * shade * (0.3 + 0.7 * d);
    // gaps between billows look deep and blue
    col = mix(vec3(0.16, 0.15, 0.30), col, smoothstep(0.0, 0.4, d));
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
  envMap: Texture | null = null;
  /** Real-time sun shadows (on for every device once enableShadows runs). */
  shadows = false;

  constructor() {
    installAtmosphereFog();
    this.domeMat = new ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      uniforms: { uTime: { value: 0 } },
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
    if (this.envMap) {
      scene.environment = this.envMap;
      scene.environmentIntensity = 0.75;
    }
  }

  /** Renders sky + cloud sea once into a prefiltered environment map used for all reflections and ambient light. */
  bakeEnvironment(gl: WebGLRenderer): Texture {
    if (this.envMap) return this.envMap;
    const s = new Scene();
    const dome = new Mesh(new SphereGeometry(100, 32, 16), this.domeMat);
    dome.renderOrder = -10;
    const sea = new Mesh(new PlaneGeometry(1800, 1800).rotateX(-Math.PI / 2), this.cloudMat);
    sea.position.y = -100;
    s.add(dome, sea);
    const pm = new PMREMGenerator(gl);
    this.envMap = pm.fromScene(s, 0.02, 0.1, 1000).texture;
    pm.dispose();
    dome.geometry.dispose();
    sea.geometry.dispose();
    return this.envMap;
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
