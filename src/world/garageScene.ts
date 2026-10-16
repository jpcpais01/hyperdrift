import {
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  Scene,
  Matrix4,
  Vector3,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';
import { Cockpit, IDLE_DRIVE, type CockpitDrive } from '../car/cockpit';
import { isTouch } from '../core/fullscreen';
import { engineProfile } from '../audio/engineProfile';
import { buildCar, type CarVisual } from '../car/carBuilder';
import type { CarBuild, Slot } from '../car/parts';
import { computeStats } from '../car/stats';
import { audio } from '../core/audio';
import { Drivetrain } from '../game/drivetrain';
import type { Sky } from './sky';

function platformTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#23262c';
  g.fillRect(0, 0, 512, 512);
  // radial "baked" ambient occlusion around the centre where the car sits
  const ao = g.createRadialGradient(256, 256, 30, 256, 256, 256);
  ao.addColorStop(0, 'rgba(0,0,0,0.55)');
  ao.addColorStop(0.45, 'rgba(0,0,0,0.15)');
  ao.addColorStop(1, 'rgba(255,255,255,0.05)');
  g.fillStyle = ao;
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = 2;
  for (let r = 60; r < 256; r += 48) {
    g.beginPath();
    g.arc(256, 256, r, 0, Math.PI * 2);
    g.stroke();
  }
  const t = new CanvasTexture(c);
  return t;
}

const ORIGIN = new Vector3();

/** The garage: a floating turntable above the clouds. */
export class GarageScene {
  readonly scene = new Scene();
  private turntable = new Group();
  private car: CarVisual | null = null;
  private angle = 0.6;
  /** turntable spin speed: eases in when the player leaves the camera alone */
  private spin = 0;
  private orbit = new GarageOrbit();
  private demo: { t: number; nitro: boolean; dt: Drivetrain; nitroFx: number; lit: boolean } | null = null;
  private cockpit: Cockpit | null = null;
  /** looking at the interior parts from inside the car */
  private interior = false;
  private focus: Slot = 'cockpit';
  private shotPos = new Vector3();
  private shotLook = new Vector3();
  private shotFresh = true;
  private demoT = 0;
  private lowEnd = isTouch();

  constructor(private readonly sky: Sky) {
    sky.addTo(this.scene);
    const top = new Mesh(
      new CylinderGeometry(4.2, 4.2, 0.3, 64),
      new MeshStandardMaterial({ color: 0xffffff, map: platformTexture(), roughness: 0.35, metalness: 0.6 }),
    );
    top.position.y = -0.15;
    top.receiveShadow = true;
    const base = new Mesh(new CylinderGeometry(4.0, 1.2, 2.4, 48, 1, true), new MeshStandardMaterial({ color: 0x181b21, roughness: 0.6, metalness: 0.7 }));
    base.position.y = -1.5;
    const rim = new Mesh(new RingGeometry(4.18, 4.32, 64), new MeshBasicMaterial({ color: new Color(0.3, 1.3, 1.9) }));
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.011;
    const glow = new Mesh(new RingGeometry(0.9, 1.25, 48), new MeshBasicMaterial({ color: new Color(2.5, 0.6, 2.2) }));
    glow.rotation.x = Math.PI / 2;
    glow.position.y = -2.72;
    this.turntable.add(top, rim);
    this.scene.add(this.turntable, base, glow);
    this.scene.fog = null;
  }

  setBuild(build: CarBuild) {
    if (this.car) {
      this.turntable.remove(this.car.root);
      this.car.dispose();
    }
    this.car = buildCar(build);
    this.sky.castShadows(this.car.root);
    this.turntable.add(this.car.root);
    this.cockpit?.dispose();
    this.cockpit = new Cockpit(build, this.lowEnd, this.sky.envMap);
  }

  /** Switches between the turntable and the driver's seat, framing the part being edited. */
  setView(interior: boolean, slot: Slot) {
    if (interior !== this.interior) {
      this.shotFresh = true;
      this.orbit.resetNow();
    } else if (slot !== this.focus) this.orbit.resetSoft();
    this.interior = interior;
    if (slot !== this.focus) this.demoT = 0;
    this.focus = slot;
  }

  /** The cockpit scene to draw over the world, when the camera is inside. */
  get overlay() {
    return this.interior && this.cockpit ? this.cockpit.scene : null;
  }

  renderMirror(gl: WebGLRenderer) {
    if (this.interior) this.cockpit?.renderMirror(gl, this.scene);
  }

  /** Camera shot (car space) for each interior part. */
  private shot(slot: Slot, pos: Vector3, look: Vector3) {
    const L = this.cockpit!.layout;
    const E = L.eye;
    switch (slot) {
      case 'dash':
        pos.copy(E).add(V(-0.05, 0.0, 0.06));
        look.copy(L.cluster).add(V(-0.08, 0, 0));
        break;
      case 'wheel':
        pos.copy(E).add(V(-0.03, -0.02, 0.1));
        look.copy(L.wheel);
        break;
      case 'mirror':
        pos.copy(E).add(V(-0.1, -0.03, 0.08));
        look.copy(L.mirror);
        break;
      case 'shifter':
        // from the passenger seat, so the driver's arm is behind the lever, not in front of it
        pos.set(L.shifter.x - 0.36, E.y - 0.1, L.shifter.z - 0.05);
        look.copy(L.shifter).add(V(0, 0.1, 0));
        break;
      case 'handbrake':
        pos.set(L.handbrake.x - 0.38, E.y - 0.08, L.handbrake.z - 0.02);
        look.copy(L.handbrake).add(V(0, 0.1, 0.06));
        break;
      case 'cabinColor':
        pos.set(E.x - 0.12, E.y + 0.02, E.z + 0.5);
        look.set(-L.driverX, 0.62, L.seatZ - 0.12);
        break;
      default:
        pos.set(0.0, E.y + 0.07, E.z - 0.42);
        look.set(0.12, L.dashTop - 0.08, L.zFace + 0.1);
    }
  }

  /** Little demos of what the selected part does: gauge sweep, steering, shifting, handbrake. */
  private demoDrive(dt: number): CockpitDrive {
    this.demoT += dt;
    const t = this.demoT;
    const d: CockpitDrive = { ...IDLE_DRIVE, rpm: 0.13 + Math.sin(t * 9) * 0.005, steer: Math.sin(t * 0.7) * 0.04 };
    if (!this.interior) return d;
    switch (this.focus) {
      case 'dash': {
        const c = (t % 4) / 2.4;
        const k = c < 1 ? Math.sin(c * Math.PI) : 0;
        d.rpm = Math.max(d.rpm, k);
        d.speed = k * 300 / 3.6;
        d.gear = Math.min(5, Math.floor(k * 6));
        d.limiter = k > 0.97;
        d.latAccel = Math.sin(t * 1.3) * 12;
        d.nitroActive = k > 0.6;
        break;
      }
      case 'wheel':
        d.steer = Math.sin(t * 1.2) * 0.5;
        break;
      case 'shifter': {
        const g = Math.floor(t / 1.6) % 7;
        d.gear = Math.min(5, g);
        d.rpm = 0.45 + ((t % 1.6) / 1.6) * 0.5;
        d.speed = 4 + d.gear * 8;
        break;
      }
      case 'handbrake':
        d.drifting = t % 2.4 > 0.5 && t % 2.4 < 1.1;
        d.steer = d.drifting ? 0.2 : 0;
        break;
    }
    return d;
  }

  /**
   * Picking an engine, turbo, exhaust or nitro part blips the throttle so you
   * hear (and see) what it changed: rev, lift-off pops, blow-off, nitro purge.
   */
  preview(build: CarBuild, slot: Slot) {
    const nitro = slot === 'nitro';
    if (!nitro && slot !== 'engine' && slot !== 'turbo' && slot !== 'exhaust' && slot !== 'weight') return;
    audio.startVoice('garage', engineProfile(build), { full: true });
    this.demo = { t: 0, nitro, dt: new Drivetrain(computeStats(build), 5), nitroFx: 0, lit: false };
  }

  stopPreview() {
    this.demo = null;
    audio.stopVoice('garage');
  }

  private updatePreview(dt: number, time: number) {
    const d = this.demo;
    if (!d) {
      this.car?.exhaust?.update(dt, time, 0, 0);
      return;
    }
    d.t += dt;
    const t = d.t;
    const throttle = d.nitro ? (t > 0.15 && t < 2.1 ? 1 : 0) : (t > 0.15 && t < 0.95) || (t > 1.45 && t < 1.75) ? 1 : 0;
    const nitroOn = d.nitro && t > 0.55 && t < 2.0;
    if (nitroOn && !d.lit) {
      d.lit = true;
      this.car?.exhaust?.ignite();
      audio.nitroStart('garage');
    }
    d.nitroFx += ((nitroOn ? 1 : 0) - d.nitroFx) * (1 - Math.exp(-(nitroOn ? 14 : 4) * dt));
    d.dt.step(dt, { speed: 0, topSpeed: 70, throttle, grounded: false, spin: 0 });
    for (const e of d.dt.events) {
      if (e.type !== 'pop') continue;
      this.car?.exhaust?.pop(e.strength);
      audio.pop('garage', e.strength);
    }
    d.dt.events.length = 0;
    audio.updateVoice('garage', { rpm: d.dt.rpm, throttle, nitro: d.nitroFx, limiter: d.dt.limiter, cut: false, gain: t > 3.4 ? 0 : 1 }, dt);
    this.car?.exhaust?.update(dt, time, 0, d.nitroFx);
    if (t > 3.8) this.stopPreview();
  }

  bindDrag(el: HTMLElement) {
    this.orbit.bind(el);
  }

  /** input only steers the camera while the garage is on screen */
  setActive(v: boolean) {
    this.orbit.setActive(v);
  }

  update(dt: number, time: number, camera: PerspectiveCamera, sky: Sky, viewOffset = 0) {
    const o = this.orbit;
    o.update(dt);
    if (this.interior && this.car && this.cockpit) {
      this.updateInterior(dt, time, camera, sky, viewOffset);
      return;
    }
    // the turntable keeps showing the car off whenever the player isn't orbiting
    this.spin += ((o.idle > 3 ? 0.35 : 0) - this.spin) * (1 - Math.exp(-1.2 * dt));
    this.angle += this.spin * dt;
    this.turntable.rotation.y = this.angle;
    const narrow = camera.aspect < 1.2;
    const baseDist = narrow ? 10.5 : 7.6 + viewOffset * 0.6;
    const lookY = narrow ? -0.6 : 0.55;
    const camY = narrow ? 3.2 : 2.1;
    const basePitch = Math.atan2(camY - lookY, baseDist);
    const dist = Math.hypot(baseDist, camY - lookY) * o.zoom;
    // keep the camera above the deck and below straight-down
    const minPitch = Math.asin(Math.max(-0.95, Math.min(0.95, (0.35 - lookY) / dist)));
    const pitch = Math.max(minPitch, Math.min(1.35, basePitch + o.pitch));
    if (pitch !== basePitch + o.pitch) o.pitch = pitch - basePitch;
    const yaw = 0.5 + o.yaw;
    // shift the view along the camera's right vector so the car sits beside the parts panel
    // (scaled with zoom so it stays in the same spot on screen)
    const off = viewOffset * o.zoom;
    const rx = Math.cos(yaw) * off;
    const rz = -Math.sin(yaw) * off;
    const flat = Math.cos(pitch) * dist;
    camera.position.set(rx + Math.sin(yaw) * flat, lookY + Math.sin(pitch) * dist, rz + Math.cos(yaw) * flat);
    camera.lookAt(rx, lookY, rz);
    camera.fov = 40;
    camera.updateProjectionMatrix();
    this.updatePreview(dt, time);
    sky.update(time, camera.position, -80, ORIGIN);
    this.scene.fog = null;
  }

  private updateInterior(dt: number, time: number, camera: PerspectiveCamera, sky: Sky, viewOffset: number) {
    const o = this.orbit;
    const cockpit = this.cockpit!;
    // the turntable settles while you sit inside
    this.spin += (0 - this.spin) * (1 - Math.exp(-3 * dt));
    this.angle += this.spin * dt;
    this.turntable.rotation.y = this.angle;
    this.shot(this.focus, _a, _b);
    const e = this.shotFresh ? 1 : 1 - Math.exp(-5 * dt);
    this.shotFresh = false;
    this.shotPos.lerp(_a, e);
    this.shotLook.lerp(_b, e);
    this.car!.body.updateWorldMatrix(true, false);
    cockpit.follow(this.car!.body);
    const m = this.car!.body.matrixWorld;
    camera.position.copy(this.shotPos).applyMatrix4(m);
    // drag to look around; the parts panel covers the right, so the subject sits left of centre
    const dir = _b.copy(this.shotLook).sub(this.shotPos).normalize();
    const yaw = Math.atan2(dir.x, dir.z) - o.yaw * 0.8 - viewOffset * 0.07;
    const pitch = Math.max(-1.2, Math.min(1.0, Math.asin(Math.max(-1, Math.min(1, dir.y))) - o.pitch * 0.8));
    if (Math.abs(o.pitch) > 1.4) o.pitch = Math.sign(o.pitch) * 1.4;
    const look = _a.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).add(this.shotPos).applyMatrix4(m);
    camera.up.set(0, 1, 0).transformDirection(_m.extractRotation(m));
    camera.lookAt(look);
    camera.fov = Math.max(34, Math.min(84, 62 * o.zoom));
    camera.updateProjectionMatrix();
    cockpit.update(dt, this.demoDrive(dt));
    this.updatePreview(dt, time);
    sky.update(time, camera.position, -80, ORIGIN);
    this.scene.fog = null;
  }
}

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
const _m = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();

const ZOOM_MIN = 0.55;
const ZOOM_MAX = 1.6;

/**
 * Showroom camera: drag to orbit (with a flick of inertia), pinch or wheel to
 * zoom, double-tap / double-click to glide back to the default view.
 */
class GarageOrbit {
  yaw = 0;
  pitch = 0;
  zoom = 1;
  /** seconds since the player last touched the camera */
  idle = 10;
  private active = false;
  private yawVel = 0;
  private pitchVel = 0;
  private zoomTarget = 1;
  private resetting = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private lastMove = 0;
  private down = { x: 0, y: 0, t: 0, moved: false };
  private lastTap = 0;

  setActive(v: boolean) {
    this.active = v;
    if (!v) {
      this.pointers.clear();
      this.yawVel = this.pitchVel = 0;
    }
  }

  bind(el: HTMLElement) {
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      el.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.touch();
      this.yawVel = this.pitchVel = 0;
      this.resetting = false;
      if (this.pointers.size === 1) this.down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      else {
        this.down.moved = true;
        this.pinchDist = this.spread();
      }
      this.lastMove = performance.now();
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p || !this.active) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.touch();
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 8) this.down.moved = true;
      if (this.pointers.size >= 2) {
        const d = this.spread();
        if (this.pinchDist > 0 && d > 0) this.setZoom(this.zoomTarget * (this.pinchDist / d), true);
        this.pinchDist = d;
        return;
      }
      // same feel on any screen size: a full-width drag is roughly one lap around the car
      const k = 5.5 / Math.max(500, el.clientWidth);
      const now = performance.now();
      const step = Math.max(1, now - this.lastMove) / 1000;
      this.lastMove = now;
      this.yaw -= dx * k;
      this.pitch += dy * k;
      // smoothed release velocity for the flick
      const a = Math.min(1, step * 18);
      this.yawVel += ((-dx * k) / step - this.yawVel) * a;
      this.pitchVel += ((dy * k) / step - this.pitchVel) * a;
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      this.touch();
      if (this.pointers.size === 1) {
        // lifting one finger of a pinch: carry on orbiting with the other, no jump
        this.pinchDist = 0;
        this.yawVel = this.pitchVel = 0;
        return;
      }
      if (this.pointers.size > 0) return;
      const now = performance.now();
      // a finger that stopped before letting go shouldn't fling the car
      if (now - this.lastMove > 90) this.yawVel = this.pitchVel = 0;
      this.yawVel = clamp(this.yawVel, -9, 9);
      this.pitchVel = clamp(this.pitchVel, -4, 4);
      if (!this.down.moved && now - this.down.t < 300 && e.type === 'pointerup') {
        if (now - this.lastTap < 320) {
          this.reset();
          this.lastTap = 0;
        } else this.lastTap = now;
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        this.touch();
        this.resetting = false;
        const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        // trackpad pinch arrives as ctrl+wheel with small deltas
        this.setZoom(this.zoomTarget * Math.exp(clamp(px, -120, 120) * (e.ctrlKey ? 0.01 : 0.0015)));
      },
      { passive: false },
    );
  }

  private spread() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private setZoom(z: number, instant = false) {
    // a little rubber band past the limits, settled back on release
    this.zoomTarget = clamp(z, ZOOM_MIN * 0.92, ZOOM_MAX * 1.06);
    if (instant) this.zoom = this.zoomTarget;
  }

  private touch() {
    this.idle = 0;
    document.querySelector('.garage-hint')?.classList.add('used');
  }

  /** jump straight back to the default view */
  resetNow() {
    this.yaw = this.pitch = this.yawVel = this.pitchVel = 0;
    this.zoom = this.zoomTarget = 1;
    this.resetting = false;
  }

  /** glide back to the default view */
  resetSoft() {
    this.reset();
  }

  private reset() {
    this.resetting = true;
    this.yawVel = this.pitchVel = 0;
    this.zoomTarget = 1;
  }

  update(dt: number) {
    this.idle += dt;
    if (this.pointers.size === 0) {
      this.yaw += this.yawVel * dt;
      this.pitch += this.pitchVel * dt;
      const f = Math.exp(-3.2 * dt);
      this.yawVel *= f;
      this.pitchVel *= Math.exp(-5 * dt);
      this.zoomTarget = clamp(this.zoomTarget, ZOOM_MIN, ZOOM_MAX);
    }
    if (this.resetting) {
      const f = 1 - Math.exp(-5 * dt);
      // take the short way round
      const target = Math.round(this.yaw / (Math.PI * 2)) * Math.PI * 2;
      this.yaw += (target - this.yaw) * f;
      this.pitch += -this.pitch * f;
      if (Math.abs(target - this.yaw) < 0.002 && Math.abs(this.pitch) < 0.002 && Math.abs(this.zoom - 1) < 0.002) this.resetting = false;
    }
    this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.exp(-12 * dt));
  }
}

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}
