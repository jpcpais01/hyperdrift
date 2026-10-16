import {
  ACESFilmicToneMapping,
  HalfFloatType,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * Speed pass: cheap radial motion blur + vignette, driven by speed/boost.
 * 8 taps towards the screen centre; skipped entirely (amount 0) when slow.
 */
const SpeedShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0 },
    uVignette: { value: 0.35 },
    uCenter: { value: new Vector2(0.5, 0.45) },
    uTint: { value: 0 },
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
    varying vec2 vUv;
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
      }
      float v = smoothstep(0.85, 0.25, d * (1.0 + uAmount * 0.25));
      col.rgb *= mix(1.0 - uVignette, 1.0, v);
      col.rgb += vec3(0.1, 0.35, 0.6) * uTint * smoothstep(0.35, 0.8, d);
      gl_FragColor = col;
    }
  `,
};

export class Renderer {
  readonly gl: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  scene: Scene;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private speed: ShaderPass;
  private maxRatio: number;
  pixelRatio: number;
  private frameAvg = 16.7;
  private adjustTimer = 0;
  readonly lowEnd: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.1;
    this.gl.outputColorSpace = SRGBColorSpace;
    const touch = matchMedia('(pointer: coarse)').matches;
    this.lowEnd = touch || (navigator.hardwareConcurrency ?? 8) <= 4;
    this.maxRatio = Math.min(window.devicePixelRatio || 1, this.lowEnd ? 1.5 : 2);
    this.pixelRatio = Math.min(this.maxRatio, this.lowEnd ? 1 : 1.5);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(62, 1, 0.3, 6000);

    const size = this.gl.getDrawingBufferSize(new Vector2());
    const rt = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: this.lowEnd ? 0 : 4 });
    this.composer = new EffectComposer(this.gl, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.32, 0.35, 1.25);
    this.composer.addPass(this.bloom);
    this.speed = new ShaderPass(SpeedShader);
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

  render(dt: number) {
    if (dt > 0 && dt < 0.25) this.adapt(dt);
    this.composer.render(dt);
  }
}
