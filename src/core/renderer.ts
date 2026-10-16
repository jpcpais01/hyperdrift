import {
  ACESFilmicToneMapping,
  HalfFloatType,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SUN_DIR } from '../world/atmosphere';

/**
 * Final HDR pass (before tone mapping), one full-screen draw:
 * - cheap radial motion blur + vignette driven by speed/boost (8 taps, skipped when slow)
 * - sun glare: halo, anamorphic streak and lens ghosts, occluded by sampling the
 *   frame's own brightness at the sun (no depth buffer or occlusion queries needed)
 * - colour grading: log-space contrast, saturation, split toning (cool shadows, warm highs)
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uVignette: { value: 0.32 },
    uCenter: { value: new Vector2(0.5, 0.45) },
    uTint: { value: 0 },
    uSun: { value: new Vector2(0.5, 0.5) },
    uSunVis: { value: 0 },
    uAspect: { value: 1 },
    uContrast: { value: 1.12 },
    uSaturation: { value: 1.1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uVignette;
    uniform vec2 uCenter;
    uniform float uTint;
    uniform vec2 uSun;
    uniform float uSunVis;
    uniform float uAspect;
    uniform float uContrast;
    uniform float uSaturation;
    varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      vec2 dir = vUv - uCenter;
      float d = length(dir);
      vec4 col = texture2D(tDiffuse, vUv);
      if (uAmount > 0.001) {
        float k = uAmount * smoothstep(0.12, 0.7, d) * 0.06;
        vec4 acc = col;
        for (int i = 1; i < 8; i++) {
          acc += texture2D(tDiffuse, vUv - dir * k * float(i) / 7.0);
        }
        col = acc / 8.0;
        // slight chromatic fringe at the edges while boosting
        float ca = uAmount * smoothstep(0.25, 0.8, d) * 0.004;
        col.r = mix(col.r, texture2D(tDiffuse, vUv - dir * ca).r, 0.6);
        col.b = mix(col.b, texture2D(tDiffuse, vUv + dir * ca).b, 0.6);
      }

      if (uSunVis > 0.001) {
        // how much of the sun disc is unobstructed this frame
        vec2 px = vec2(0.004 / uAspect, 0.004);
        float occ = 0.0;
        occ += smoothstep(3.0, 9.0, luma(texture2D(tDiffuse, uSun).rgb));
        occ += smoothstep(3.0, 9.0, luma(texture2D(tDiffuse, uSun + vec2(px.x, 0.0)).rgb));
        occ += smoothstep(3.0, 9.0, luma(texture2D(tDiffuse, uSun - vec2(px.x, 0.0)).rgb));
        occ += smoothstep(3.0, 9.0, luma(texture2D(tDiffuse, uSun + vec2(0.0, px.y)).rgb));
        occ += smoothstep(3.0, 9.0, luma(texture2D(tDiffuse, uSun - vec2(0.0, px.y)).rgb));
        float vis = uSunVis * occ / 5.0;
        if (vis > 0.001) {
          vec2 q = (vUv - uSun) * vec2(uAspect, 1.0);
          float r = length(q);
          vec3 sunC = vec3(1.0, 0.7, 0.42);
          vec3 fl = sunC * (0.7 * exp(-r * 12.0) + 0.08 * exp(-r * 3.0));
          fl += sunC * 0.35 * exp(-abs(q.y) * 260.0) * exp(-abs(q.x) * 3.0);
          // ghosts mirrored through the screen centre
          vec2 axis = vec2(0.5) - uSun;
          for (int i = 0; i < 3; i++) {
            float t = float(i) * 0.55 + 0.6;
            vec2 gp = (vUv - (uSun + axis * t * 2.0)) * vec2(uAspect, 1.0);
            float sz = 0.03 + float(i) * 0.035;
            float g = smoothstep(sz, sz * 0.6, length(gp));
            fl += mix(vec3(0.3, 0.6, 1.0), vec3(1.0, 0.5, 0.3), float(i) * 0.5) * g * 0.05;
          }
          col.rgb += fl * vis;
        }
      }

      // grading in linear HDR (the output pass tone maps afterwards)
      vec3 c = max(col.rgb, 0.0);
      float l = luma(c);
      c = mix(vec3(l), c, uSaturation);
      const float MID = -2.47; // log2(0.18)
      c = exp2((log2(c + 1e-5) - MID) * uContrast + MID);
      c *= mix(vec3(0.93, 0.98, 1.08), vec3(1.05, 1.0, 0.93), smoothstep(0.0, 0.8, l));

      float v = smoothstep(0.85, 0.25, d * (1.0 + uAmount * 0.25));
      c *= mix(1.0 - uVignette, 1.0, v);
      c += vec3(0.1, 0.35, 0.6) * uTint * smoothstep(0.35, 0.8, d);
      gl_FragColor = vec4(c, col.a);
    }
  `,
};

/** Phones/tablets and weak CPUs get the cheap path (no real-time shadows, fewer noise octaves). */
export function detectLowEnd(): boolean {
  if (typeof window === 'undefined') return true;
  const touch = matchMedia('(pointer: coarse)').matches;
  return touch || (navigator.hardwareConcurrency ?? 8) <= 4;
}

export class Renderer {
  readonly gl: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  scene: Scene;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private speed: ShaderPass;
  private sunNdc = new Vector3();
  private maxRatio: number;
  pixelRatio: number;
  private frameAvg = 16.7;
  private adjustTimer = 0;
  readonly lowEnd: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.outputColorSpace = SRGBColorSpace;
    this.lowEnd = detectLowEnd();
    this.maxRatio = Math.min(window.devicePixelRatio || 1, this.lowEnd ? 1.5 : 2);
    this.pixelRatio = Math.min(this.maxRatio, this.lowEnd ? 1 : 1.5);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(62, 1, 0.3, 6000);

    const size = this.gl.getDrawingBufferSize(new Vector2());
    const rt = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: this.lowEnd ? 0 : 4 });
    this.composer = new EffectComposer(this.gl, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.32, 0.45, 1.3);
    this.composer.addPass(this.bloom);
    this.speed = new ShaderPass(FinalShader);
    this.composer.addPass(this.speed);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setScene(scene: Scene) {
    this.scene = scene;
    this.renderPass.scene = scene;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setPixelRatio(this.pixelRatio);
    this.gl.setSize(w, h, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    // bloom at reduced resolution is plenty and much cheaper
    this.bloom.resolution.set((w * this.pixelRatio) / 2, (h * this.pixelRatio) / 2);
    this.speed.uniforms.uAspect.value = w / h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setSpeedFx(blur: number, tint: number) {
    this.speed.uniforms.uAmount.value = blur;
    this.speed.uniforms.uTint.value = tint;
  }

  setBloom(strength: number) {
    this.bloom.strength = strength;
  }

  /** Dynamic resolution: keep the frame time near the display's budget. */
  private adapt(dt: number) {
    this.frameAvg += (dt * 1000 - this.frameAvg) * 0.05;
    this.adjustTimer += dt;
    if (this.adjustTimer < 1) return;
    let next = this.pixelRatio;
    if (this.frameAvg > 19) next = Math.max(0.5, this.pixelRatio * 0.88);
    else if (this.frameAvg < 14.5 && this.adjustTimer > 2.5) next = Math.min(this.maxRatio, this.pixelRatio * 1.06);
    else return;
    this.adjustTimer = 0;
    if (Math.abs(next - this.pixelRatio) > 0.01) {
      this.pixelRatio = next;
      this.resize();
    }
  }

  /** Projects the sun into screen space for the glare (fades out near the screen edges). */
  private updateSun() {
    const p = this.sunNdc.copy(SUN_DIR).multiplyScalar(1000).add(this.camera.position).project(this.camera);
    const u = this.speed.uniforms;
    const inFront = p.z < 1;
    const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
    u.uSunVis.value = inFront ? Math.max(0, Math.min(1, (1 - edge) / 0.15)) : 0;
    u.uSun.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  }

  render(dt: number) {
    if (dt > 0 && dt < 0.25) this.adapt(dt);
    this.camera.updateMatrixWorld();
    this.updateSun();
    this.composer.render(dt);
  }
}
