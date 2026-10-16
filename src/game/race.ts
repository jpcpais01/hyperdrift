import { Color, PerspectiveCamera, Scene, Vector3 } from 'three';
import { buildCar, type CarVisual } from '../car/carBuilder';
import { paintById, randomBuild, type CarBuild } from '../car/parts';
import { computeStats, type CarStats } from '../car/stats';
import { engineProfile } from '../audio/engineProfile';
import { audio } from '../core/audio';
import type { Input } from '../core/input';
import type { Renderer } from '../core/renderer';
import { Track } from '../track/track';
import { SKYWAY } from '../track/skyway';
import { Decor } from '../world/decor';
import { Particles } from '../world/particles';
import type { Sky } from '../world/sky';
import { TrackView } from '../world/trackView';
import type { Hud } from '../ui/hud';
import { AiDriver } from './ai';
import { collideCars, type CarContact } from './carCollision';
import { emitContactFx, emitDriveFx, emitNitroFx, emitPopFx, emitWallFx, poseCar } from './carFx';
import { CarPhysics, NITRO_PICKUP, type DriveInput } from './carPhysics';
import { ChaseCamera, type CameraZoom } from './chaseCamera';
import { GhostPlayer, GhostRecorder, type GhostLap } from './ghost';

/** The static race world (built once, reused by every race and by the menu backdrop). */
export class RaceWorld {
  readonly scene = new Scene();
  readonly track = new Track(SKYWAY);
  readonly view: TrackView;
  readonly decor: Decor;
  readonly particles = new Particles();

  constructor(readonly sky: Sky) {
    this.view = new TrackView(this.track);
    this.decor = new Decor(this.track.samples.filter((_, i) => i % 10 === 0).map((s) => s.pos));
    this.scene.add(this.view.group, this.decor.group, this.particles.points);
  }

  attach() {
    this.sky.addTo(this.scene);
  }
}

export type RaceMode = 'race' | 'timetrial' | 'attract';

export interface RaceEntry {
  name: string;
  isPlayer: boolean;
  time: number | null;
  bestLap: number | null;
  place: number;
  color: string;
}

export interface RaceResult {
  mode: 'race' | 'timetrial';
  entries: RaceEntry[];
  lapTimes: number[];
  bestLap: number | null;
  newRecord: boolean;
}

interface RaceCar {
  name: string;
  build: CarBuild;
  stats: CarStats;
  physics: CarPhysics;
  visual: CarVisual;
  ai: AiDriver | null;
  isPlayer: boolean;
  lap: number;
  passedHalf: boolean;
  lapStart: number;
  lapTimes: number[];
  finished: boolean;
  finishTime: number;
  place: number;
  color: string;
  padCooldown: number;
  lastInput: DriveInput;
  wrongWay: number;
  /** engine voice id when this car is heard (player and rivals) */
  voice: string | null;
}

export const LAPS = 3;
const scratchFocus = new Vector3();
const AI_NAMES = ['VEX', 'NOVA', 'ROOK'];
const AI_SEEDS = [11, 42, 97];
const AI_SKILL = [0.93, 0.96, 0.985];
const FIXED = 1 / 120;

export class Race {
  readonly cars: RaceCar[] = [];
  private physicsList: CarPhysics[] = [];
  private contacts: CarContact[] = [];
  private bumpCooldown = 0;
  private scrapeCooldown = 0;
  private player: RaceCar | null = null;
  private chase = new ChaseCamera();
  private countdown: number;
  private lastCount = -1;
  time = 0;
  private finishedAt = -1;
  private recorder = new GhostRecorder();
  private ghostPlayer: GhostPlayer | null = null;
  private ghostVisual: CarVisual | null = null;
  private ghostBest: GhostLap | null;
  private newRecord = false;
  private attractCam = 0;
  private attractTarget = 0;
  private acc = 0;
  private done = false;
  private fxTime = 0;
  paused = false;
  onFinish: ((r: RaceResult) => void) | null = null;

  constructor(
    private world: RaceWorld,
    readonly mode: RaceMode,
    playerBuild: CarBuild | null,
    private input: Input | null,
    private hud: Hud | null,
    ghost: GhostLap | null = null,
  ) {
    const track = world.track;
    this.ghostBest = ghost;
    this.countdown = mode === 'attract' ? 0 : 3.6;
    world.view.resetPickups();
    world.particles.clear();

    const grid: { build: CarBuild; name: string; ai: boolean; skill: number; seed: number }[] = [];
    if (mode === 'race' || mode === 'attract') {
      AI_NAMES.forEach((name, i) => grid.push({ build: randomBuild(AI_SEEDS[i] + (mode === 'attract' ? 100 : 0)), name, ai: true, skill: AI_SKILL[i], seed: AI_SEEDS[i] }));
    }
    if (mode === 'attract') grid.push({ build: randomBuild(7), name: 'ZEN', ai: true, skill: 0.97, seed: 3 });
    else if (playerBuild) grid.push({ build: playerBuild, name: 'TU', ai: false, skill: 1, seed: 0 });

    // dev helpers: ?start=<metres> places the grid elsewhere, ?autopilot lets the AI drive the player car
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    const startOffset = Number(params.get('start') ?? 0) || 0;
    const autopilot = params.has('autopilot');

    // player starts at the back of the grid, like a proper underdog
    grid.forEach((g, i) => {
      const stats = computeStats(g.build);
      const physics = new CarPhysics(track, stats, g.seed + i + 1);
      const row = Math.floor(i / 2);
      const s = (mode === 'timetrial' ? track.length - 12 : track.length - 14 - row * 13) + startOffset;
      const lat = mode === 'timetrial' ? 0 : i % 2 ? 4.2 : -4.2;
      physics.reset(s, lat);
      const visual = buildCar(g.build);
      physics.hitbox = visual.hitbox;
      world.sky.castShadows(visual.root);
      world.scene.add(visual.root);
      const car: RaceCar = {
        name: g.name,
        build: g.build,
        stats,
        physics,
        visual,
        ai: g.ai || autopilot ? new AiDriver(track, g.ai ? g.skill : 1, g.seed) : null,
        isPlayer: !g.ai,
        lap: 0,
        passedHalf: false,
        lapStart: 0,
        lapTimes: [],
        finished: false,
        finishTime: 0,
        place: i + 1,
        color: '#' + new Color(paintById(g.build.paint).color).getHexString(),
        padCooldown: 0,
        lastInput: { throttle: 0, brake: 0, steer: 0 },
        wrongWay: 0,
        voice: mode === 'attract' ? null : g.ai ? `rival${i}` : 'player',
      };
      this.cars.push(car);
      this.physicsList.push(physics);
      if (car.isPlayer) this.player = car;
    });

    if (mode === 'timetrial' && ghost) {
      this.ghostPlayer = new GhostPlayer(ghost);
      this.ghostVisual = buildCar(ghost.build, { ghost: true });
      this.ghostVisual.root.visible = false;
      world.scene.add(this.ghostVisual.root);
    }
    if (this.player) {
      this.startAudio();
      hud?.setTrack(track);
      hud?.show(true, mode === 'timetrial' ? 'timetrial' : 'race');
    }
    this.attractTarget = 0;
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

  private progress(c: RaceCar): number {
    const L = this.world.track.length;
    const s = c.physics.trackS;
    // before crossing the start line the car is "behind" lap 1
    const base = c.lap === 0 ? s - L : (c.lap - 1) * L + s;
    return c.finished ? 1e9 - c.finishTime : base;
  }

  update(dt: number, renderer: Renderer) {
    const camera = renderer.camera;
    if (this.paused) {
      this.updateVisuals(0);
      return;
    }
    const racing = this.countdown <= 0;

    // countdown
    if (!racing) {
      this.countdown -= dt;
      const c = Math.ceil(this.countdown - 0.6);
      if (c !== this.lastCount && c <= 3) {
        this.lastCount = c;
        if (c > 0) {
          this.hud?.setCountdown(String(c));
          audio.beep(false);
        } else {
          this.hud?.setCountdown('JÁ!');
          audio.beep(true);
        }
      }
      if (this.countdown <= 0) {
        setTimeout(() => this.hud?.setCountdown(''), 700);
        for (const c of this.cars) c.lapStart = 0;
        this.recorder.start();
      }
    } else if (!this.done) {
      this.time += dt;
    }

    // inputs
    const playerInput = this.input && this.player && racing && !this.player.finished ? this.input.read(dt) : { throttle: 0, brake: 0, steer: 0 };
    const physicsList = this.physicsList;
    this.bumpCooldown -= dt;
    this.scrapeCooldown -= dt;
    const leader = this.player ? this.progress(this.player) : 0;
    for (const c of this.cars) {
      if (!racing) {
        c.lastInput = { throttle: 0, brake: 0, steer: 0 };
        // engine rev during countdown for the player
        if (c.isPlayer && this.input) {
          const i = this.input.read(dt);
          c.physics.rpm += ((i.throttle ? 0.85 : 0.15) - c.physics.rpm) * (1 - Math.exp(-6 * dt));
        }
        continue;
      }
      if (c.ai) {
        if (this.player && this.mode === 'race') {
          const gap = leader - this.progress(c);
          c.ai.pace = 1 + Math.max(-0.07, Math.min(0.09, gap / 500));
        }
        c.lastInput = c.finished ? { throttle: 0.6, brake: 0, steer: c.ai.drive(c.physics, physicsList, dt).steer } : c.ai.drive(c.physics, physicsList, dt);
      } else if (c.isPlayer) {
        c.lastInput = c.finished ? { throttle: 0, brake: 0.3, steer: 0 } : playerInput;
      }
    }

    // physics (fixed sub-steps)
    if (racing) {
      this.acc += Math.min(dt, 0.1);
      while (this.acc >= FIXED) {
        this.acc -= FIXED;
        for (const c of this.cars) c.physics.step(FIXED, c.lastInput);
        this.collide();
      }
    }

    if (racing && this.player && this.player.lap >= 1 && !this.player.finished) {
      this.recorder.record(dt, this.player.physics.pos, this.player.physics.quat);
    }

    // game logic per car
    for (const c of this.cars) {
      this.updateCarLogic(c, dt, racing);
      this.handleEvents(c);
    }

    // standings
    const order = [...this.cars].sort((a, b) => this.progress(b) - this.progress(a));
    order.forEach((c, i) => (c.place = i + 1));

    // ghost
    if (this.ghostPlayer && this.ghostVisual && this.player) {
      const t = this.time - this.player.lapStart;
      const ok = racing && this.player.lap >= 1 && this.ghostPlayer.sample(t, this.ghostVisual.root.position, this.ghostVisual.root.quaternion);
      this.ghostVisual.root.visible = ok;
    }

    this.fxTime += dt;
    this.updateVisuals(dt);
    this.world.view.update(dt, this.time);
    this.world.particles.update(dt);

    // camera
    const t = performance.now() / 1000;
    if (this.mode === 'attract') this.updateAttractCamera(camera, dt, t);
    else if (this.player) this.chase.update(camera, this.player.physics, dt, t);
    this.world.decor.update(dt, camera.position);
    // shadows follow the player (or whatever the attract camera is looking at)
    const focus = this.player ? this.player.physics.pos : camera.getWorldDirection(scratchFocus).multiplyScalar(18).add(camera.position);
    this.world.sky.update(t, camera.position, 20, focus);

    // post fx + audio + hud
    if (this.player) {
      if (audio.ctx && !audio.hasVoice('player')) this.startAudio();
      const p = this.player.physics;
      const speedK = Math.max(0, (p.speed - 45) / 50);
      renderer.setSpeedFx(Math.min(1.2, speedK * 0.6 + p.boostFx * 0.9), p.boostFx * 0.5);
      this.updateAudio(dt, camera);
      this.updateHud(dt);
    } else {
      renderer.setSpeedFx(0, 0);
    }

    // finish
    if (this.player && this.player.finished && this.finishedAt < 0) this.finishedAt = this.time;
    if (this.finishedAt >= 0 && !this.done && this.time - this.finishedAt > 2.5) {
      this.done = true;
      this.onFinish?.(this.result());
    }
  }

  private updateAudio(dt: number, camera: PerspectiveCamera) {
    const player = this.player!;
    const p = player.physics;
    const racing = this.countdown <= 0;
    const d = p.drivetrain;
    audio.updateVoice(
      'player',
      {
        rpm: p.rpm,
        throttle: racing ? d.throttle : player.lastInput.throttle || (p.rpm > 0.3 ? 1 : 0),
        nitro: p.nitroFx,
        limiter: d.limiter,
        cut: d.cut > 0,
      },
      dt,
    );
    audio.updateEnv({
      speed: p.speed,
      slip: Math.min(1, (p.drifting ? 0.6 : 0) + Math.max(0, p.slip - 4) / 14),
      grounded: p.grounded,
    });
    // rivals: distance, stereo position and Doppler from the camera
    const right = TMP3.set(1, 0, 0).applyQuaternion(camera.quaternion);
    for (const c of this.cars) {
      if (c.isPlayer || !c.voice) continue;
      const q = c.physics;
      const to = TMP.copy(q.pos).sub(camera.position);
      const dist = to.length();
      to.divideScalar(Math.max(1e-3, dist));
      const gain = dist > 130 ? 0 : 0.85 / (1 + (dist / 11) ** 2);
      const closing = -TMP2.copy(q.vel).sub(p.vel).dot(to);
      const pitch = Math.max(0.75, Math.min(1.35, 343 / (343 - closing * 0.9)));
      audio.updateVoice(
        c.voice,
        { rpm: q.rpm, throttle: q.drivetrain.throttle, nitro: q.nitroFx, limiter: q.drivetrain.limiter, cut: q.drivetrain.cut > 0, gain, pan: to.dot(right) * 0.9, pitch },
        dt,
      );
    }
  }

  private updateCarLogic(c: RaceCar, dt: number, racing: boolean) {
    const p = c.physics;
    const track = this.world.track;
    const L = track.length;
    const s = p.trackS;

    // lap counting: crossing s=0 forwards
    if (racing) {
      if (s > L * 0.4 && s < L * 0.6) c.passedHalf = true;
      const prev = (c as RaceCar & { prevS?: number }).prevS ?? s;
      (c as RaceCar & { prevS?: number }).prevS = s;
      if (prev > L - 60 && s < 60 && (c.passedHalf || c.lap === 0)) {
        if (c.lap >= 1) {
          const lapTime = this.time - c.lapStart;
          c.lapTimes.push(lapTime);
          if (c.isPlayer) this.onPlayerLap(lapTime);
        }
        c.lap += 1;
        c.lapStart = this.time;
        c.passedHalf = false;
        if (c.isPlayer && c.lap === 1) this.recorder.start();
        if (c.lap > LAPS && !c.finished && this.mode !== 'attract') {
          c.finished = true;
          c.finishTime = this.time;
          if (c.isPlayer) {
            this.hud?.message(c.place === 1 || this.mode === 'timetrial' ? 'META!' : `${c.place}º LUGAR`, 3, 'big');
            audio.lap();
          }
        } else if (c.isPlayer && c.lap > 1) {
          this.hud?.message(c.lap === LAPS ? 'ÚLTIMA VOLTA' : `VOLTA ${c.lap}`, 1.5);
          audio.lap();
        }
        if (this.mode === 'attract' && c.lap > 50) c.lap = 1;
      }
    }

    // wrong way
    if (c.isPlayer) {
      const fwdDot = p.vel.dot(p.lastQuery.fwd);
      c.wrongWay = fwdDot < -4 && p.grounded ? c.wrongWay + dt : 0;
    }

    // boost pads
    c.padCooldown -= dt;
    if (p.grounded && c.padCooldown <= 0) {
      for (const pad of track.boostPads) {
        let ds = s - pad.s;
        if (ds > L / 2) ds -= L;
        if (ds < -L / 2) ds += L;
        if (Math.abs(ds) < 4.5 && Math.abs(p.lateral - pad.lateral) < 2.8) {
          p.triggerBoost(1.15, 1);
          c.padCooldown = 0.6;
          if (c.isPlayer) this.chase.addShake(0.4);
          break;
        }
      }
    }

    // nitro pickups
    const picks = this.world.view.pickupPositions;
    for (let i = 0; i < picks.length; i++) {
      if (!this.world.view.isPickupActive(i)) continue;
      if (picks[i].distanceToSquared(p.pos) < 3.2 * 3.2) {
        this.world.view.collectPickup(i);
        p.addNitro(NITRO_PICKUP);
        if (c.isPlayer) {
          audio.pickup();
          this.hud?.message(p.nitro >= 0.999 ? 'NITRO CHEIO!' : '+ NITRO', 0.9, 'nitro');
          this.chase.addShake(0.25);
        }
        for (let k = 0; k < 14; k++) {
          const v = new Vector3((Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14);
          this.world.particles.emit(picks[i], v, PICK_COLOR, 1, 0.5, 0.6, 0, 2);
        }
      }
    }

    // effects: drift smoke and sparks, boost embers
    emitDriveFx(this.world.particles, p, c.visual);
  }

  private handleEvents(c: RaceCar) {
    const p = c.physics;
    for (const e of p.events) {
      // exhaust effects and engine sounds happen for every car
      if (e.type === 'pop') {
        c.visual.exhaust?.pop(e.strength);
        if (c.voice) audio.pop(c.voice, e.strength);
        emitPopFx(this.world.particles, p, c.visual, e.strength);
        continue;
      }
      if (e.type === 'nitro') {
        c.visual.exhaust?.ignite();
        if (c.voice) audio.nitroStart(c.voice);
        emitNitroFx(this.world.particles, p, c.visual);
        if (c.isPlayer) {
          this.chase.addShake(0.55);
          this.hud?.message('NITRO!', 0.7, 'nitro');
        }
        continue;
      }
      if (!c.isPlayer) continue;
      switch (e.type) {
        case 'land':
          audio.land(e.strength, p.stats.mass);
          this.chase.addShake(e.strength * 0.8);
          break;
        case 'wall':
          audio.wall(e.strength);
          this.chase.addShake(e.strength * 0.5);
          emitWallFx(this.world.particles, p, TMP.copy(p.right).multiplyScalar(Math.sign(p.lateral)));
          break;
        case 'boost':
          audio.boost();
          this.chase.addShake(0.3);
          break;
        case 'driftBoost':
          this.hud?.message(e.amount > 1 ? 'SUPER DRIFT BOOST!' : 'DRIFT BOOST!', 1.1, 'drift');
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
    const pl = this.player?.physics;
    for (const ct of contacts) {
      const hard = Math.min(1, ct.impulse / 14);
      // sparks fly out of the contact, carried along by the cars
      emitContactFx(this.world.particles, ct);
      if (ct.a !== pl && ct.b !== pl) continue;
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

  private onPlayerLap(lapTime: number) {
    if (this.mode !== 'timetrial' || !this.player) {
      this.recorder.start();
      return;
    }
    const lap = this.recorder.finish(lapTime, this.player.build);
    if (!this.ghostBest || lapTime < this.ghostBest.time) {
      this.ghostBest = lap;
      this.newRecord = true;
      this.hud?.message('NOVO RECORDE!', 2, 'record');
      this.ghostPlayer = new GhostPlayer(lap);
      if (!this.ghostVisual) {
        this.ghostVisual = buildCar(lap.build, { ghost: true });
        this.world.scene.add(this.ghostVisual.root);
      }
    }
    this.recorder.start();
  }

  get bestGhost(): GhostLap | null {
    return this.newRecord ? this.ghostBest : null;
  }

  private updateVisuals(dt: number) {
    for (const c of this.cars) poseCar(c.physics, c.visual, c.lastInput.brake, dt, this.fxTime + c.place * 3.1);
  }

  setCameraZoom(level: CameraZoom, instant = false) {
    this.chase.setZoom(level, instant);
  }

  private updateAttractCamera(cam: PerspectiveCamera, dt: number, t: number) {
    this.attractCam -= dt;
    if (this.attractCam <= 0) {
      this.attractCam = 7;
      this.attractTarget = (this.attractTarget + 1) % this.cars.length;
      this.chase.snap();
    }
    const car = this.cars[this.attractTarget].physics;
    const phase = Math.floor(t / 7) % 3;
    if (phase === 0) {
      this.chase.update(cam, car, dt, t);
    } else {
      // orbiting cinematic shot
      const a = t * 0.35;
      const off = TMP.copy(car.right).multiplyScalar(Math.cos(a) * 9).addScaledVector(car.fwd, Math.sin(a) * 9 + 4).addScaledVector(car.up, phase === 1 ? 2.2 : 5);
      cam.position.copy(car.pos).add(off);
      cam.up.copy(car.up);
      cam.lookAt(TMP2.copy(car.pos).addScaledVector(car.up, 0.8));
      cam.fov = 55;
      cam.updateProjectionMatrix();
    }
  }

  private updateHud(dt: number) {
    if (!this.hud || !this.player) return;
    const p = this.player.physics;
    this.input?.setNitro(p.nitro, p.nitroActive);
    const best = this.mode === 'timetrial' ? this.ghostBest?.time ?? null : this.player.lapTimes.length ? Math.min(...this.player.lapTimes) : null;
    let ghostDelta: number | null = null;
    if (this.mode === 'timetrial' && this.ghostBest && this.player.lap >= 1 && this.player.lapTimes.length > 0) {
      ghostDelta = this.player.lapTimes[this.player.lapTimes.length - 1] - this.ghostBest.time;
    }
    this.hud.update(
      {
        speedKmh: p.speed * 3.6,
        gear: p.gear,
        nitro: p.nitro,
        nitroActive: p.nitroActive,
        drift: p.drifting ? Math.min(1, p.driftTime / 3.2) : 0,
        place: this.player.place,
        total: this.cars.length,
        lap: this.player.lap,
        laps: LAPS,
        time: this.time,
        lapTime: this.time - this.player.lapStart,
        bestLap: best,
        ghostDelta,
        dots: this.cars.map((c) => ({ x: c.physics.pos.x, z: c.physics.pos.z, color: c.color, player: c.isPlayer })),
        wrongWay: this.player.wrongWay > 1.2,
      },
      dt,
    );
  }

  result(): RaceResult {
    const L = this.world.track.length;
    const entries: RaceEntry[] = this.cars.map((c) => {
      let time: number | null = c.finished ? c.finishTime : null;
      if (time === null && c.lap >= 1) {
        // estimate the remaining distance at the car's average pace
        const done = (c.lap - 1) * L + c.physics.trackS;
        const pace = done / Math.max(1, this.time);
        time = this.time + (LAPS * L - done) / Math.max(20, pace);
      }
      return {
        name: c.name,
        isPlayer: c.isPlayer,
        time,
        bestLap: c.lapTimes.length ? Math.min(...c.lapTimes) : null,
        place: 0,
        color: c.color,
      };
    });
    entries.sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9));
    entries.forEach((e, i) => (e.place = i + 1));
    const lapTimes = this.player?.lapTimes ?? [];
    return {
      mode: this.mode === 'timetrial' ? 'timetrial' : 'race',
      entries,
      lapTimes,
      bestLap: lapTimes.length ? Math.min(...lapTimes) : null,
      newRecord: this.newRecord,
    };
  }

  dispose() {
    for (const c of this.cars) {
      this.world.scene.remove(c.visual.root);
      c.visual.dispose();
    }
    if (this.ghostVisual) {
      this.world.scene.remove(this.ghostVisual.root);
      this.ghostVisual.dispose();
    }
    if (this.player) audio.stopEngine();
    this.hud?.show(false);
    this.hud?.setCountdown('');
  }
}

const TMP = new Vector3();
const TMP2 = new Vector3();
const TMP3 = new Vector3();
const PICK_COLOR = new Color(0.4, 2.2, 3.0);
