import { Euler, Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { CarPhysics } from './carPhysics';
import { cameraOrbit } from './cameraOrbit';

/** 0-2: chase framings, 3: in the driver's seat */
export type CameraZoom = 0 | 1 | 2 | 3;
export const COCKPIT: CameraZoom = 3;
export const CAMERA_ZOOM_LABELS = ['PERTO', 'MÉDIA', 'LONGE', 'COCKPIT'] as const;

/** Third-person framings: near is tight and fast-feeling, far shows more of the road ahead. */
const ZOOMS = [
  { dist: 4.7, height: 2.05, look: 0.65, ahead: 2, fov: 66 },
  { dist: 6.4, height: 2.75, look: 0.75, ahead: 2.6, fov: 62 },
  { dist: 9.2, height: 3.75, look: 0.9, ahead: 3.4, fov: 58 },
];

/** Spring chase camera: follows the car's up vector through loops, widens FOV with speed and boost. */
export class ChaseCamera {
  private pos = new Vector3();
  private up = new Vector3(0, 1, 0);
  private look = new Vector3();
  private shake = 0;
  /** nitro surge above steady (set by the race): punches the FOV in and out */
  surge = 0;
  private side = 0;
  private initialised = false;
  private zoom: CameraZoom = 1;
  // current framing, eased towards ZOOMS[zoom] so switching glides instead of cutting
  private frame = { ...ZOOMS[1] };
  // driver's head: offset from the eye point (car space) and where it looks
  private head = new Vector3();
  private look2 = { yaw: 0, pitch: 0, roll: 0 };
  private lastFwd = 0;
  /** swipe-to-look; off for the attract / spectator shots */
  orbitEnabled = true;

  /** How far the driver's head (and body) leans under g-forces, car space. */
  get headLean(): Vector3 {
    return this.head;
  }

  get zoomLevel(): CameraZoom {
    return this.zoom;
  }

  get inCockpit() {
    return this.zoom === COCKPIT;
  }

  setZoom(level: CameraZoom, instant = false) {
    // coming out of the cockpit: start the chase spring from its rest position
    if (this.zoom === COCKPIT && level !== COCKPIT) this.initialised = false;
    this.zoom = level;
    if (level !== COCKPIT && instant) Object.assign(this.frame, ZOOMS[level]);
  }

  /**
   * First person: the eye rides the car body, and the head reacts like a
   * driver's: leaning against cornering forces, pushed back under
   * acceleration, glancing into the corner and towards the slide in a drift.
   */
  updateCockpit(cam: PerspectiveCamera, car: CarPhysics, body: Object3D, eye: Vector3, dt: number, time: number) {
    const k = (r: number) => 1 - Math.exp(-r * dt);
    const fwd = car.forwardSpeed;
    const longAcc = dt > 0 ? (fwd - this.lastFwd) / dt : 0;
    this.lastFwd = fwd;
    const lat = car.yawRate * car.speed;
    const hx = Math.max(-0.05, Math.min(0.05, -lat * 0.0011));
    const hz = Math.max(-0.045, Math.min(0.03, -longAcc * 0.0018));
    const hy = car.grounded ? 0 : 0.012;
    this.head.x += (hx - this.head.x) * k(5);
    this.head.z += (hz - this.head.z) * k(4);
    this.head.y += (hy - this.head.y) * k(3);
    const slide = Math.atan2(-car.lateralSpeed, Math.max(6, Math.abs(fwd)));
    const yaw = Math.max(-0.45, Math.min(0.45, slide * 0.55 + car.steerVisual * 0.22));
    const pitch = -0.03 + Math.max(-0.03, Math.min(0.03, longAcc * -0.0012)) + (car.grounded ? 0 : -0.04);
    this.look2.yaw += (yaw - this.look2.yaw) * k(car.drifting ? 3.5 : 5);
    this.look2.pitch += (pitch - this.look2.pitch) * k(4);
    this.look2.roll += (-this.head.x * 1.2 - this.look2.roll) * k(5);

    body.updateWorldMatrix(true, false);
    cam.position.copy(eye).add(this.head).applyMatrix4(body.matrixWorld);
    // road texture through the seat at speed, and the usual impact shake
    const buzz = Math.min(1, car.speed / 60) * (car.grounded ? 0.0016 : 0) + car.boostFx * 0.0025;
    cam.position.y += Math.sin(time * 61) * buzz;
    cam.position.x += Math.sin(time * 47 + 1) * buzz * 0.6;
    if (this.shake > 0.001) {
      const s = this.shake * 0.03;
      cam.position.x += Math.sin(time * 71) * s;
      cam.position.y += Math.sin(time * 53 + 1) * s;
      this.shake *= Math.exp(-5 * dt);
    }
    body.getWorldQuaternion(QB);
    // a swipe turns the driver's head on top of the reflexes
    const o = this.orbit(dt, true);
    // the camera looks down its -z, the car faces +z
    E.set(this.look2.pitch - o.pitch, Math.PI + this.look2.yaw + o.yaw, this.look2.roll * (1 - Math.min(1, Math.abs(o.yaw))), 'YXZ');
    cam.quaternion.copy(QB).multiply(Q.setFromEuler(E));
    cam.up.copy(car.draw.up);
    const fov = 70 + Math.min(1.2, car.speed / car.stats.topSpeed) * 7 + car.boostFx * 9 + car.nitroFx * 3;
    cam.fov += (fov - cam.fov) * k(6);
    cam.updateProjectionMatrix();
  }

  private orbit(dt: number, cockpit: boolean) {
    if (!this.orbitEnabled) return REST;
    cameraOrbit.use(cockpit);
    cameraOrbit.update(dt);
    return cameraOrbit;
  }

  addShake(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  snap() {
    this.initialised = false;
  }

  update(cam: PerspectiveCamera, car: CarPhysics, dt: number, time: number) {
    const speed = car.speed;
    const pose = car.draw;
    const top = car.stats.topSpeed;
    const boost = car.boostFx;
    // drift swings the camera to look into the slide
    const sideTarget = car.drifting ? -car.driftDir * 1.2 : -car.lateralSpeed * 0.04;
    this.side += (sideTarget - this.side) * (1 - Math.exp(-3 * dt));
    const f = this.frame;
    const z = ZOOMS[Math.min(2, this.zoom)];
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
    const target = TMP.copy(pose.pos)
      .addScaledVector(pose.fwd, -dist)
      .addScaledVector(pose.up, height)
      .addScaledVector(pose.right, this.side);
    if (!this.initialised) {
      this.pos.copy(target);
      this.up.copy(pose.up);
      this.look.copy(pose.pos);
      this.initialised = true;
    }
    const k = car.grounded ? 9 : 5;
    this.pos.lerp(target, 1 - Math.exp(-k * dt));
    // never let the camera fall behind too far at very high speed
    const max = dist * 1.6;
    const off = TMP2.copy(this.pos).sub(pose.pos);
    if (off.length() > max) this.pos.copy(pose.pos).addScaledVector(off.normalize(), max);
    this.up.lerp(pose.up, 1 - Math.exp(-(car.grounded ? 5 : 2) * dt)).normalize();
    const lookTarget = TMP2.copy(pose.pos).addScaledVector(pose.up, f.look).addScaledVector(pose.fwd, f.ahead + speed * 0.03);
    this.look.lerp(lookTarget, 1 - Math.exp(-14 * dt));

    // swipe orbit: swing the whole rig (eye, aim and up) rigidly around the car,
    // so the framing and every speed effect stay exactly as they are behind it
    const o = this.orbit(dt, false);
    cam.position.copy(this.pos);
    cam.up.copy(this.up);
    LOOK.copy(this.look);
    if (o.yaw !== 0 || o.pitch !== 0) {
      QO.setFromAxisAngle(pose.up, o.yaw);
      const off = TMP.copy(this.pos).sub(pose.pos).applyQuaternion(QO);
      // raise / lower around the horizontal axis square to where the camera now sits
      const flat = TMP2.copy(off).addScaledVector(pose.up, -off.dot(pose.up));
      if (flat.lengthSq() > 1e-6) {
        AX.crossVectors(flat.normalize(), pose.up).normalize();
        QO.premultiply(Q.setFromAxisAngle(AX, o.pitch));
      }
      cam.position.copy(this.pos).sub(pose.pos).applyQuaternion(QO).add(pose.pos);
      LOOK.sub(pose.pos).applyQuaternion(QO).add(pose.pos);
      cam.up.applyQuaternion(QO);
    }
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
    cam.lookAt(LOOK);
    const fov = f.fov + Math.min(1.2, speed / top) * 12 + boost * 14 + car.nitroFx * 5 + this.surge * 4;
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-6 * dt));
    cam.updateProjectionMatrix();
  }
}

const TMP = new Vector3();
const TMP2 = new Vector3();
const QB = new Quaternion();
const Q = new Quaternion();
const E = new Euler();
const QO = new Quaternion();
const AX = new Vector3();
const LOOK = new Vector3();
const REST = { yaw: 0, pitch: 0 };
