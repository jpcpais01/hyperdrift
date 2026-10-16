import {
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Texture,
  type WebGLRenderer,
} from 'three';

export const SUN_DIR = new Vector3(0.55, 0.2, -0.81).normalize();
export const HORIZON = new Color(0xf2b49a);
export const FOG_COLOR = new Color(0xd9b2b6);

const skyVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const skyFrag = /* glsl */ `
  uniform vec3 uSun;
  uniform float uTime;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; } return v; }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 zenith = vec3(0.07, 0.12, 0.32);
    vec3 mid = vec3(0.32, 0.38, 0.72);
    vec3 horizon = vec3(1.0, 0.62, 0.45);
    vec3 below = vec3(0.62, 0.5, 0.62);
    vec3 col;
    if (h > 0.0) {
      col = mix(horizon, mid, smoothstep(0.0, 0.25, h));
      col = mix(col, zenith, smoothstep(0.2, 0.9, h));
    } else {
      col = mix(horizon, below, smoothstep(0.0, 0.08, -h));
      col = mix(col, vec3(0.22, 0.2, 0.36), smoothstep(0.08, 0.5, -h));
    }
    float sd = max(dot(d, uSun), 0.0);
    col += vec3(1.0, 0.55, 0.3) * pow(sd, 8.0) * 0.35;
    col += vec3(1.0, 0.75, 0.5) * pow(sd, 64.0) * 0.8;
    col += vec3(8.0, 6.5, 4.5) * smoothstep(0.9993, 0.9997, sd);
    // high wispy clouds
    if (h > 0.0) {
      vec2 uv = d.xz / (h + 0.12) * 1.4 + vec2(uTime * 0.004, 0.0);
      float c = smoothstep(0.55, 0.85, fbm(uv * 1.5));
      vec3 cc = mix(vec3(1.0, 0.75, 0.65), vec3(1.0, 0.92, 0.85), sd);
      col = mix(col, cc, c * smoothstep(0.0, 0.15, h) * 0.55);
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

const cloudFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSun;
  uniform vec3 uFog;
  uniform vec3 uCam;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
  void main() {
    vec2 p = vWorld.xz * 0.004 + vec2(uTime * 0.01, uTime * 0.004);
    float n = fbm(p);
    float n2 = fbm(p * 2.7 + 3.1);
    float dens = smoothstep(0.3, 0.75, n * 0.75 + n2 * 0.35);
    vec3 lit = mix(vec3(0.5, 0.42, 0.58), vec3(0.95, 0.8, 0.74), dens);
    lit += vec3(1.0, 0.6, 0.35) * pow(max(dot(normalize(vWorld - uCam), uSun), 0.0), 6.0) * 0.5;
    float dist = length(vWorld.xz - uCam.xz);
    float f = smoothstep(1200.0, 4200.0, dist);
    gl_FragColor = vec4(mix(lit, uFog, f), 1.0);
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

  constructor() {
    this.domeMat = new ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      uniforms: { uSun: { value: SUN_DIR }, uTime: { value: 0 } },
      side: BackSide,
      depthWrite: false,
    });
    this.dome = new Mesh(new SphereGeometry(1000, 32, 16), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;

    this.cloudMat = new ShaderMaterial({
      vertexShader: cloudVert,
      fragmentShader: cloudFrag,
      uniforms: {
        uTime: { value: 0 },
        uSun: { value: SUN_DIR },
        uFog: { value: FOG_COLOR },
        uCam: { value: new Vector3() },
      },
    });
    const cg = new PlaneGeometry(9000, 9000, 1, 1);
    cg.rotateX(-Math.PI / 2);
    this.clouds = new Mesh(cg, this.cloudMat);
    this.clouds.position.y = 20;
    this.clouds.frustumCulled = false;

    this.sun = new DirectionalLight(0xffe2c4, 2.4);
    this.sun.position.copy(SUN_DIR).multiplyScalar(100);
    this.hemi = new HemisphereLight(0x9fb4ff, 0x8a6670, 0.35);
  }

  addTo(scene: Scene) {
    scene.add(this.dome, this.clouds, this.sun, this.sun.target, this.hemi);
    scene.fog = new Fog(FOG_COLOR, 1100, 4200);
    if (this.envMap) {
      scene.environment = this.envMap;
      scene.environmentIntensity = 0.9;
    }
  }

  /** Renders the sky once into a prefiltered environment map used for all reflections. */
  bakeEnvironment(gl: WebGLRenderer): Texture {
    if (this.envMap) return this.envMap;
    const s = new Scene();
    const dome = new Mesh(new SphereGeometry(100, 32, 16), this.domeMat);
    s.add(dome);
    // a band of "cloud sea" so reflections show the clouds below
    const pm = new PMREMGenerator(gl);
    this.envMap = pm.fromScene(s, 0, 0.1, 1000).texture;
    pm.dispose();
    dome.geometry.dispose();
    return this.envMap;
  }

  update(time: number, camPos: Vector3, cloudY = 20) {
    this.clouds.position.y = cloudY;
    this.domeMat.uniforms.uTime.value = time;
    this.cloudMat.uniforms.uTime.value = time;
    this.cloudMat.uniforms.uCam.value.copy(camPos);
    this.dome.position.copy(camPos);
    this.clouds.position.x = camPos.x;
    this.clouds.position.z = camPos.z;
  }
}
