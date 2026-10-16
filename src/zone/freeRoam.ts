import { Color, PerspectiveCamera, Scene, Vector3 } from 'three';
import { buildCar, type CarVisual } from '../car/carBuilder';
import { paintById, randomBuild, type CarBuild } from '../car/parts';
import { computeStats, type CarStats } from '../car/stats';
import { engineProfile } from '../audio/engineProfile';
import { audio } from '../core/audio';
import type { Input } from '../core/input';
import type { Renderer } from '../core/renderer';
import { collideCars, type CarContact } from '../game/carCollision';
import { emitContactFx, emitDriveFx, emitNitroFx, emitPopFx, emitWallFx, poseCar } from '../game/carFx';
import { CarPhysics, type DriveInput } from '../game/carPhysics';
import { ChaseCamera, type CameraZoom } from '../game/chaseCamera';
import type { Hud } from '../ui/hud';
import { Decor } from '../world/decor';
import { Particles } from '../world/particles';
import type { Sky } from '../world/sky';
import { DriftScore } from './driftScore';
import { circlePath, stadiumPoint, samplePath, WALL_R, ZONE_Y, ZoneLayout } from './layout';
import { ZoneDriver, type DriverStyle } from './zoneDriver';
import { ZoneView } from './zoneView';

/** The drift zone's static world, built the first time someone visits and then kept. */
export class ZoneWorld {
  readonly scene = new Scene();
  readonly layout = new ZoneLayout();
  readonly view: ZoneView;
  readonly decor: Decor;
  readonly particles = new Particles();

  constructor(readonly sky: Sky) {
    this.view = new ZoneView(this.layout);
    // distant floating islands all around, clear of the zone and of the great tree's island
    const avoid: Vector3[] = [];
    for (let x = -300; x <= 300; x += 60) for (let z = -300; z <= 300; z += 60) if (Math.hypot(x, z) < 320) avoid.push(new Vector3(x, ZONE_Y, z));
    for (const [x, z] of [
      [140, 560],
      [100, 520],
      [180, 600],
    ])
      avoid.push(new Vector3(x, ZONE_Y - 30, z));
    this.decor = new Decor(avoid);
    this.scene.add(this.view.group, this.decor.group, this.particles.points);
  }

  attach() {
    this.sky.addTo(this.scene);
  }
}

interface ZoneCar {
  name: string;
  build: CarBuild;
  stats: CarStats;
  physics: CarPhysics;
  visual: CarVisual;
  driver: ZoneDriver | null;
  isPlayer: boolean;
  color: string;
  voice: string | null;
  lastInput: DriveInput;
}

interface Resident {
  name: string;
  seed: number;
  path: Vector3[];
  style: DriverStyle;
  start: number;
}

const FIXED = 1 / 120;
const INTRO = 5.2;

/**
 * Free roam in the drift zone: no laps, no clock. The island's residents cruise and
 * drift around (a tandem pair on the plaza circle, a tourer through the meadow, a
 * speedster on the banked rim) while you chain drifts for points.
 */
export class FreeRoam {
  readonly cars: ZoneCar[] = [];
  private physicsList: CarPhysics[] = [];
  private contacts: CarContact[] = [];
  private player: ZoneCar;
  private chase = new ChaseCamera();
  readonly score: DriftScore;
  private acc = 0;
  private time = 0;
  private fxTime = 0;
  private intro = INTRO;
  private bumpCooldown = 0;
  private scrapeCooldown = 0;
  private introFrom = new Vector3();
  paused = false;
  /** called whenever the best drift improves (to save it) */
  onBest: ((best: number) => void) | null = null;

  constructor(
    private world: ZoneWorld,
    playerBuild: CarBuild,
    private input: Input,
    private hud: Hud,
    bestDrift: number,
  ) {
    const L = world.layout;
    this.score = new DriftScore(bestDrift);
    world.particles.clear();

    const plaza = samplePath(stadiumPoint, 2);
    const rim = samplePath(circlePath(231), 2.5);
    const residents: Resident[] = [
      { name: 'KAI', seed: 21, path: plaza, style: { pace: 0.42, nitro: false }, start: 0 },
      { name: 'MEI', seed: 64, path: plaza, style: { pace: 0.42, nitro: false }, start: Math.floor(plaza.length / 2) },
      { name: 'ROOK', seed: 97, path: L.tour, style: { pace: 0.8, nitro: true }, start: 40 },
      { name: 'VEX', seed: 133, path: rim, style: { pace: 0.95, nitro: true }, start: 200 },
    ];
    residents.forEach((r, i) => {
      const build = randomBuild(r.seed);
      const car = this.addCar(r.name, build, false, i + 1);
      car.driver = new ZoneDriver(r.path, r.style);
      car.driver.place(car.physics, r.start);
      // ambient engines: the two closest are heard, the rest stay quiet
      car.voice = `zone${i}`;
    });
    this.player = this.addCar('TU', playerBuild, true, 0);
    this.player.voice = 'player';
    this.player.physics.spawnSlot = 1;
    this.player.physics.respawn();
    this.player.physics.events.length = 0;
    this.player.physics.nitro = 0.6;

    this.startAudio();
    hud.setZoneMap(L);
    hud.show(true, 'zone');
    hud.setZoneScore(this.score);
    hud.zoneIntro(true);
    this.introFrom.set(-420, ZONE_Y + 150, -520);
  }

  private addCar(name: string, build: CarBuild, isPlayer: boolean, seed: number): ZoneCar {
    const stats = computeStats(build);
    const physics = new CarPhysics(null, stats, seed + 1);
    physics.ground = this.world.layout;
    const visual = buildCar(build);
    physics.hitbox = visual.hitbox;
    this.world.sky.castShadows(visual.root);
    this.world.scene.add(visual.root);
    const car: ZoneCar = {
      name,
      build,
      stats,
      physics,
      visual,
      driver: null,
      isPlayer,
      color: '#' + new Color(paintById(build.paint).color).getHexString(),
      voice: null,
      lastInput: { throttle: 0, brake: 0, steer: 0 },
    };
    this.cars.push(car);
    this.physicsList.push(physics);
    return car;
  }

  private startAudio() {
    for (const c of this.cars) {
      if (!c.voice) continue;
      const profile = engineProfile(c.build);
      if (c.isPlayer) audio.startEngine(profile);
      else audio.startVoice(c.voice, profile, { full: false, spatial: true });
    }
  }

  get playerCar() {
    return this.player;
  }

  get introActive() {
    return this.intro > 0;
  }

  /** Back to the start line (pause menu), keeping the score. */
  restart() {
    this.score.flush();
    this.player.physics.respawn();
    this.chase.snap();
  }

  setCameraZoom(level: CameraZoom, instant = false) {
    this.chase.setZoom(level, instant);
  }

  update(dt: number, renderer: Renderer) {
    const camera = renderer.camera;
    if (this.paused) {
      this.pose(0);
      return;
    }
    this.time += dt;
    const t = performance.now() / 1000;

    // intro flyover: skipped as soon as the player touches the controls
    let playerInput: DriveInput = { throttle: 0, brake: 0, steer: 0 };
    const raw = this.input.read(dt);
    if (this.intro > 0) {
      this.intro -= dt;
      if (raw.throttle > 0 || raw.brake > 0 || Math.abs(raw.steer) > 0.5 || (raw.nitro ?? 0) > 0) this.intro = Math.min(this.intro, 0);
      if (this.intro <= 0) {
        this.hud.zoneIntro(false);
        this.chase.snap();
      }
    } else playerInput = raw;

    this.bumpCooldown -= dt;
    this.scrapeCooldown -= dt;
    for (const c of this.cars) {
      if (c.driver) c.lastInput = c.driver.drive(c.physics, this.physicsList, dt);
      else c.lastInput = playerInput;
    }

    this.acc += Math.min(dt, 0.1);
    while (this.acc >= FIXED) {
      this.acc -= FIXED;
      for (const c of this.cars) c.physics.step(FIXED, c.lastInput);
      this.collide();
    }

    const p = this.player.physics;
    // the tank slowly tops itself up out here: no pickups to hunt
    p.addNitro(dt * 0.018);
    for (const c of this.cars) {
      if (c.driver) c.physics.addNitro(dt * 0.03);
      emitDriveFx(this.world.particles, c.physics, c.visual);
      this.handleEvents(c);
      if (c.physics.impact > 0) {
        const q = c.physics.pos;
        if (Math.hypot(q.x, q.z) > WALL_R - 4) this.world.view.fieldHit(q, c.physics.impact / 14);
      }
    }

    this.score.update(dt, p, p.impact);
    for (const c of this.cars) c.physics.impact = 0;
    this.handleScore();

    this.fxTime += dt;
    this.pose(dt);
    this.world.particles.update(dt);

    // camera
    if (this.intro > 0) this.updateIntroCamera(camera, t);
    else this.chase.update(camera, p, dt, t);
    this.world.decor.update(dt, camera.position);
    this.world.view.update(dt, this.time, camera.position, p.pos);
    this.world.sky.update(t, camera.position, 20, p.pos);

    if (audio.ctx && !audio.hasVoice('player')) this.startAudio();
    const speedK = Math.max(0, (p.speed - 45) / 50);
    renderer.setSpeedFx(this.intro > 0 ? 0 : Math.min(1.2, speedK * 0.6 + p.boostFx * 0.9), p.boostFx * 0.5);
    this.updateAudio(dt, camera);
    this.hud.updateZone(
      {
        speedKmh: p.speed * 3.6,
        gear: p.gear,
        nitro: p.nitro,
        nitroActive: p.nitroActive,
        drift: p.drifting ? Math.min(1, p.driftTime / 3.2) : 0,
        dots: this.cars.map((c) => ({ x: c.physics.pos.x, z: c.physics.pos.z, color: c.color, player: c.isPlayer })),
        heading: Math.atan2(p.fwd.x, p.fwd.z),
      },
      this.score,
      dt,
    );
    this.input.setNitro(p.nitro, p.nitroActive);
  }

  /** Swoops in from far out over the clouds, round the island, down behind your car. */
  private updateIntroCamera(cam: PerspectiveCamera, t: number) {
    const k = 1 - Math.max(0, this.intro) / INTRO;
    const e = k * k * (3 - 2 * k);
    const p = this.player.physics;
    // the chase position the swoop lands on
    const end = TMP.copy(p.pos).addScaledVector(p.fwd, -6.4).addScaledVector(p.up, 2.15);
    const mid = TMP2.set(-160, ZONE_Y + 70, -260);
    const a = TMP3.copy(this.introFrom).lerp(mid, e);
    const b = mid.clone().lerp(end, e);
    cam.position.copy(a.lerp(b, e));
    const lookFar = new Vector3(0, ZONE_Y + 10, 0);
    const lookNear = TMP.copy(p.pos).addScaledVector(p.up, 1.05).addScaledVector(p.fwd, 3);
    cam.up.set(0, 1, 0);
    cam.lookAt(lookFar.lerp(lookNear, Math.pow(e, 1.6)));
    cam.fov = 50 + 12 * e;
    cam.updateProjectionMatrix();
    void t;
  }

  private handleScore() {
    for (const e of this.score.events) {
      switch (e.type) {
        case 'bank':
          this.hud.zoneBank(e.score, e.grade, e.best);
          if (e.best) audio.lap();
          else audio.pickup();
          this.onBest?.(this.score.best);
          break;
        case 'fail':
          this.hud.zoneFail();
          break;
        case 'air':
          this.hud.message(`NO AR ${e.seconds.toFixed(1)}s  +${e.bonus}`, 1.3, 'nitro');
          break;
        case 'mult':
          this.hud.zoneMult(e.mult);
          break;
      }
    }
    this.score.events.length = 0;
  }

  private handleEvents(c: ZoneCar) {
    const p = c.physics;
    const parts = this.world.particles;
    for (const e of p.events) {
      if (e.type === 'pop') {
        c.visual.exhaust?.pop(e.strength);
        if (c.voice) audio.pop(c.voice, e.strength);
        emitPopFx(parts, p, c.visual, e.strength);
        continue;
      }
      if (e.type === 'nitro') {
        c.visual.exhaust?.ignite();
        if (c.voice) audio.nitroStart(c.voice);
        emitNitroFx(parts, p, c.visual);
        if (c.isPlayer) {
          this.chase.addShake(0.55);
          this.hud.message('NITRO!', 0.7, 'nitro');
        }
        continue;
      }
      if (e.type === 'wall') emitWallFx(parts, p, TMP.copy(p.fwd).multiplyScalar(1.6));
      if (!c.isPlayer) continue;
      switch (e.type) {
        case 'land':
          audio.land(e.strength, p.stats.mass);
          this.chase.addShake(e.strength * 0.8);
          break;
        case 'wall':
          audio.wall(e.strength);
          this.chase.addShake(e.strength * 0.5);
          break;
        case 'boost':
          audio.boost();
          this.chase.addShake(0.3);
          break;
        case 'driftBoost':
          this.hud.message(e.amount > 1 ? 'SUPER DRIFT BOOST!' : 'DRIFT BOOST!', 1.1, 'drift');
          break;
        case 'respawn':
          this.chase.snap();
          audio.whoosh();
          break;
        default:
          break;
      }
    }
    p.events.length = 0;
  }

  private collide() {
    const contacts = collideCars(this.physicsList, this.contacts);
    const pl = this.player.physics;
    for (const ct of contacts) {
      emitContactFx(this.world.particles, ct);
      if (ct.a !== pl && ct.b !== pl) continue;
      const hard = Math.min(1, ct.impulse / 14);
      // a real shunt costs you the chain, a rub does not
      if (ct.impulse > 6) pl.impact = Math.max(pl.impact, ct.impulse);
      if (ct.impulse > 1.2 && this.bumpCooldown <= 0) {
        audio.bump(0.25 + hard * 0.75);
        this.chase.addShake(0.15 + hard * 0.55);
        this.bumpCooldown = 0.12;
      } else if (ct.scrape > 3 && this.scrapeCooldown <= 0) {
        audio.scrape(ct.scrape / 20);
        this.scrapeCooldown = 0.07;
      }
    }
  }

  private updateAudio(dt: number, camera: PerspectiveCamera) {
    const player = this.player;
    const p = player.physics;
    const d = p.drivetrain;
    audio.updateVoice('player', { rpm: p.rpm, throttle: this.intro > 0 ? 0 : d.throttle, nitro: p.nitroFx, limiter: d.limiter, cut: d.cut > 0 }, dt);
    audio.updateEnv({
      speed: p.speed,
      slip: Math.min(1, (p.drifting ? 0.6 : 0) + Math.max(0, p.slip - 4) / 14),
      grounded: p.grounded,
    });
    const right = TMP3.set(1, 0, 0).applyQuaternion(camera.quaternion);
    for (const c of this.cars) {
      if (c.isPlayer || !c.voice) continue;
      const q = c.physics;
      const to = TMP.copy(q.pos).sub(camera.position);
      const dist = to.length();
      to.divideScalar(Math.max(1e-3, dist));
      const gain = dist > 140 ? 0 : 0.8 / (1 + (dist / 12) ** 2);
      const closing = -TMP2.copy(q.vel).sub(p.vel).dot(to);
      const pitch = Math.max(0.75, Math.min(1.35, 343 / (343 - closing * 0.9)));
      audio.updateVoice(
        c.voice,
        { rpm: q.rpm, throttle: q.drivetrain.throttle, nitro: q.nitroFx, limiter: q.drivetrain.limiter, cut: q.drivetrain.cut > 0, gain, pan: to.dot(right) * 0.9, pitch },
        dt,
      );
    }
  }

  private pose(dt: number) {
    this.cars.forEach((c, i) => poseCar(c.physics, c.visual, c.lastInput.brake, dt, this.fxTime + i * 3.1));
  }

  dispose() {
    this.score.flush();
    for (const c of this.cars) {
      this.world.scene.remove(c.visual.root);
      c.visual.dispose();
    }
    audio.stopEngine();
    this.hud.zoneIntro(false);
    this.hud.show(false);
  }
}

const TMP = new Vector3();
const TMP2 = new Vector3();
const TMP3 = new Vector3();
