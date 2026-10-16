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
  Vector3,
  type PerspectiveCamera,
} from 'three';
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
  private dragging = false;
  private lastX = 0;
  private idle = 0;
  private demo: { t: number; nitro: boolean; dt: Drivetrain; nitroFx: number; lit: boolean } | null = null;

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
    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.angle += (e.clientX - this.lastX) * 0.01;
      this.lastX = e.clientX;
      this.idle = 0;
    });
    window.addEventListener('pointerup', () => (this.dragging = false));
  }

  update(dt: number, time: number, camera: PerspectiveCamera, sky: Sky, viewOffset = 0) {
    this.idle += dt;
    if (!this.dragging && this.idle > 1.5) this.angle += dt * 0.35;
    this.turntable.rotation.y = this.angle;
    const narrow = camera.aspect < 1.2;
    const dist = narrow ? 10.5 : 7.6 + viewOffset * 0.6;
    // shift the view along the camera's right vector so the car sits beside the parts panel
    const a = 0.5;
    const rx = Math.cos(a) * viewOffset;
    const rz = -Math.sin(a) * viewOffset;
    camera.position.set(Math.sin(a) * dist + rx, narrow ? 3.2 : 2.1, Math.cos(a) * dist + rz);
    camera.lookAt(rx, narrow ? -0.6 : 0.55, rz);
    camera.fov = 40;
    camera.updateProjectionMatrix();
    this.updatePreview(dt, time);
    sky.update(time, camera.position, -80, ORIGIN);
    this.scene.fog = null;
  }
}
