import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial, Vector3 } from 'three';

const MAX = 600;

/** One pooled point-sprite system for tyre smoke, sparks and boost embers (a single draw call). */
export class Particles {
  readonly points: Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 4);
  private size = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private grow = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  private a0 = new Float32Array(MAX);
  private next = 0;
  private geo: BufferGeometry;

  constructor() {
    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new BufferAttribute(this.col, 4));
    this.geo.setAttribute('size', new BufferAttribute(this.size, 1));
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec4 color;
        varying vec4 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 300.0 / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(d));
          gl_FragColor = vec4(vColor.rgb * vColor.a * a, 1.0);
        }`,
    });
    this.points = new Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  emit(p: Vector3, v: Vector3, color: Color, alpha: number, size: number, life: number, grow = 0, drag = 1) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b, alpha], i * 4);
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grow[i] = grow;
    this.drag[i] = drag;
    this.a0[i] = alpha;
  }

  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        if (this.col[i * 4 + 3] !== 0) this.col[i * 4 + 3] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      for (let a = 0; a < 3; a++) {
        this.vel[i * 3 + a] *= k;
        this.pos[i * 3 + a] += this.vel[i * 3 + a] * dt;
      }
      this.size[i] += this.grow[i] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.col[i * 4 + 3] = this.a0[i] * t;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.col.fill(0);
  }
}
