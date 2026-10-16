import { PerspectiveCamera, Vector3 } from 'three';
import type { CarPhysics } from './carPhysics';

export type CameraZoom = 0 | 1 | 2;
export const CAMERA_ZOOM_LABELS = ['PERTO', 'MÉDIA', 'LONGE'] as const;

/** Third-person framings: near is tight and fast-feeling, far shows more of the road ahead. */
const ZOOMS = [
  { dist: 4.7, height: 1.55, look: 0.95, ahead: 2.4, fov: 66 },
  { dist: 6.4, height: 2.15, look: 1.05, ahead: 3, fov: 62 },
  { dist: 9.2, height: 3.05, look: 1.3, ahead: 4.2, fov: 58 },
];

/** Spring chase camera: follows the car's up vector through loops, widens FOV with speed and boost. */
export class ChaseCamera {
  private pos = new Vector3();
  private up = new Vector3(0, 1, 0);
  private look = new Vector3();
  private shake = 0;
  private side = 0;
  private initialised = false;
  private zoom: CameraZoom = 1;
  // current framing, eased towards ZOOMS[zoom] so switching glides instead of cutting
  private frame = { ...ZOOMS[1] };

  get zoomLevel(): CameraZoom {
    return this.zoom;
  }

  setZoom(level: CameraZoom, instant = false) {
    this.zoom = level;
    if (instant) Object.assign(this.frame, ZOOMS[level]);
  }

  addShake(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  snap() {
    this.initialised = false;
  }

  update(cam: PerspectiveCamera, car: CarPhysics, dt: number, time: number) {
    const speed = car.speed;
    const top = car.stats.topSpeed;
    const boost = car.boostFx;
    // drift swings the camera to look into the slide
    const sideTarget = car.drifting ? -car.driftDir * 1.2 : -car.lateralSpeed * 0.04;
    this.side += (sideTarget - this.side) * (1 - Math.exp(-3 * dt));
    const f = this.frame;
    const z = ZOOMS[this.zoom];
    const ez = 1 - Math.exp(-4 * dt);
    f.dist += (z.dist - f.dist) * ez;
    f.height += (z.height - f.height) * ez;
    f.look += (z.look - f.look) * ez;
    f.ahead += (z.ahead - f.ahead) * ez;
    f.fov += (z.fov - f.fov) * ez;
    // speed and boost effects scale with the framing so every level feels the rush
    const scale = f.dist / ZOOMS[1].dist;
    const dist = f.dist + (Math.min(speed, 90) * 0.018 - boost * 0.7) * scale;
    const height = f.height + boost * 0.1 * scale;
    const target = TMP.copy(car.pos)
      .addScaledVector(car.fwd, -dist)
      .addScaledVector(car.up, height)
      .addScaledVector(car.right, this.side);
    if (!this.initialised) {
      this.pos.copy(target);
      this.up.copy(car.up);
      this.look.copy(car.pos);
      this.initialised = true;
    }
    const k = car.grounded ? 9 : 5;
    this.pos.lerp(target, 1 - Math.exp(-k * dt));
    // never let the camera fall behind too far at very high speed
    const max = dist * 1.6;
    const off = TMP2.copy(this.pos).sub(car.pos);
    if (off.length() > max) this.pos.copy(car.pos).addScaledVector(off.normalize(), max);
    this.up.lerp(car.up, 1 - Math.exp(-(car.grounded ? 5 : 2) * dt)).normalize();
    const lookTarget = TMP2.copy(car.pos).addScaledVector(car.up, f.look).addScaledVector(car.fwd, f.ahead + speed * 0.03);
    this.look.lerp(lookTarget, 1 - Math.exp(-14 * dt));

    cam.position.copy(this.pos);
    if (this.shake > 0.001) {
      const s = this.shake * 0.12;
      cam.position.x += Math.sin(time * 71) * s;
      cam.position.y += Math.sin(time * 53 + 1) * s;
      cam.position.z += Math.sin(time * 61 + 2) * s;
      this.shake *= Math.exp(-5 * dt);
    }
    // high-speed buzz while boosting
    if (boost > 0.05) {
      const b = boost * 0.035;
      cam.position.x += Math.sin(time * 90) * b;
      cam.position.y += Math.sin(time * 83) * b;
    }
    cam.up.copy(this.up);
    cam.lookAt(this.look);
    const fov = f.fov + Math.min(1.2, speed / top) * 12 + boost * 14;
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-6 * dt));
    cam.updateProjectionMatrix();
  }
}

const TMP = new Vector3();
const TMP2 = new Vector3();
