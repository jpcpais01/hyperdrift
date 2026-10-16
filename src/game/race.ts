import { Color, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { buildCar, type CarVisual } from '../car/carBuilder';
import { Cockpit } from '../car/cockpit';
import { isTouch } from '../core/fullscreen';
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
import { CarPhysics, NITRO_PICKUP, type DriveInput } from './carPhysics';
import { ChaseCamera, type CameraZoom } from './chaseCamera';
import { GhostPlayer, GhostRecorder, type GhostLap } from './ghost';
import { applyCar, packCar, unpackCar, type CarSnapshot } from '../net/carState';
import type { Room } from '../net/room';

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
  /** online: still on track (shown live on the results board) */
  racing?: string;
  /** online: a person, not an AI */
  human?: boolean;
}

export interface RaceResult {
  mode: 'race' | 'timetrial';
  entries: RaceEntry[];
  lapTimes: number[];
  bestLap: number | null;
  newRecord: boolean;
  online?: boolean;
}

/** One grid slot of an online race, as the host sent it. */
export interface NetGridEntry {
  id: string;
  name: string;
  build: CarBuild;
  ai: boolean;
  skill: number;
  seed: number;
}

/** What the host's "go" carries for a race session. */
export interface RacePayload {
  grid: NetGridEntry[];
}

/** An online race: the room, the grid and when the lights go green (local clock, ms). */
export interface NetRace {
  room: Room;
  grid: NetGridEntry[];
  startAt: number;
}

interface RaceCar {
  /** online id (player id, or 'ai0'…) */
  id: string;
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
  /** online: simulated here but steered by someone else's snapshots */
  remote: boolean;
  human: boolean;
  /** online: this machine sends this car's state (my car; the AI on the host) */
  owned: boolean;
  lastRt: number;
  lastHeard: number;
  netBest: number | null;
  /** visual smoothing after a snapshot correction, decays to zero */
  netOffset: Vector3;
  netQuat: Quaternion;
  gone: boolean;
  tag: HTMLElement | null;
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
  /** the player's interior, for the first-person camera */
  private cockpit: Cockpit | null = null;
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
  /** online: the race keeps running but I'm only watching (lobby backdrop, pause menu) */
  private spectate = false;
  /** online: my car coasts (pause menu open, the race goes on for everybody else) */
  inputLocked = false;
  private sendTimer = 0;
  private snap: CarSnapshot | null = null;
  private tags: HTMLElement | null = null;
  onFinish: ((r: RaceResult) => void) | null = null;

  constructor(
    private world: RaceWorld,
    readonly mode: RaceMode,
    playerBuild: CarBuild | null,
    private input: Input | null,
    private hud: Hud | null,
    ghost: GhostLap | null = null,
    readonly net: NetRace | null = null,
  ) {
    const track = world.track;
    this.ghostBest = ghost;
    this.countdown = mode === 'attract' ? 0 : net ? Math.max(0.7, (net.startAt - performance.now()) / 1000) : 3.6;
    world.view.resetPickups();
    world.particles.clear();

    const grid: { id: string; build: CarBuild; name: string; ai: boolean; skill: number; seed: number; remote: boolean; human: boolean }[] = [];
    if (net) {
      // online: the host decided the grid; my car is mine, the AI belongs to the host, the rest arrive over the wire
      for (const g of net.grid) {
        const mine = g.id === net.room.myId;
        const remote = !mine && !(g.ai && net.room.isHost);
        grid.push({ ...g, ai: g.ai && !remote, remote, human: !g.ai });
      }
    } else {
      if (mode === 'race' || mode === 'attract') {
        AI_NAMES.forEach((name, i) =>
          grid.push({ id: `ai${i}`, build: randomBuild(AI_SEEDS[i] + (mode === 'attract' ? 100 : 0)), name, ai: true, skill: AI_SKILL[i], seed: AI_SEEDS[i], remote: false, human: false }),
        );
      }
      if (mode === 'attract') grid.push({ id: 'ai3', build: randomBuild(7), name: 'ZEN', ai: true, skill: 0.97, seed: 3, remote: false, human: false });
      else if (playerBuild) grid.push({ id: 'me', build: playerBuild, name: 'TU', ai: false, skill: 1, seed: 0, remote: false, human: true });
    }

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
      const isPlayer = net ? g.id === net.room.myId : !g.ai;
      const car: RaceCar = {
        id: g.id,
        name: g.name,
        build: g.build,
        stats,
        physics,
        visual,
        ai: !g.remote && (g.ai || (autopilot && isPlayer)) ? new AiDriver(track, g.ai ? g.skill : 1, g.seed) : null,
        isPlayer,
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
        voice: mode === 'attract' ? null : isPlayer ? 'player' : `rival${i}`,
        remote: g.remote,
        human: g.human,
        owned: !!net && !g.remote,
        lastRt: -Infinity,
        lastHeard: performance.now(),
        netBest: null,
        netOffset: new Vector3(),
        netQuat: new Quaternion(),
        gone: false,
        tag: null,
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
      this.cockpit = new Cockpit(this.player.build, isTouch(), world.sky.envMap);
      this.startAudio();
      hud?.setTrack(track);
      hud?.show(true, mode === 'timetrial' ? 'timetrial' : 'race');
    }
    this.attractTarget = 0;

    if (net) {
      net.room.onState = (id, d) => this.onNetState(id, d);
      // floating call signs over the other players' cars
      if (hud) {
        this.tags = document.createElement('div');
        this.tags.className = 'name-tags';
        hud.el.appendChild(this.tags);
        for (const c of this.cars) {
          if (c.isPlayer) continue;
          c.tag = document.createElement('div');
          c.tag.className = `name-tag${c.human ? ' human' : ''}`;
          c.tag.innerHTML = `<i style="background:${c.color}"></i><span></span>`;
          c.tag.querySelector('span')!.textContent = c.name;
          this.tags.appendChild(c.tag);
        }
      }
    }
  }

  /** A snapshot of somebody else's car: jump the simulation there, keep the picture smooth. */
  private onNetState(id: string, d: unknown) {
    const c = this.cars.find((x) => x.id === id);
    if (!c || !c.remote || c.gone) return;
    const s = unpackCar(d, this.snap ?? undefined);
    if (!s) return;
    this.snap = s;
    if (s.rt <= c.lastRt) return; // late, out-of-order packet
    c.lastRt = s.rt;
    c.lastHeard = performance.now();
    const p = c.physics;
    // where the car is drawn right now
    const seenPos = TMP.copy(p.pos).add(c.netOffset);
    const seenQuat = TQ.copy(c.netQuat).multiply(p.quat);
    applyCar(p, s, this.world.track.samples.length);
    c.lastInput = s.input;
    c.lap = s.lap;
    c.finished = s.finished;
    c.finishTime = s.finishTime;
    c.netBest = s.bestLap;
    // the snapshot is a few ms old: replay that bit with the inputs it carried
    if (this.countdown <= 0) {
      const lag = Math.max(0, Math.min(0.25, this.time - s.rt));
      const steps = Math.round(lag / FIXED);
      for (let k = 0; k < steps; k++) p.step(FIXED, s.input);
      p.events = p.events.filter((e) => e.type === 'nitro' || e.type === 'pop');
    }
    c.netOffset.copy(seenPos).sub(p.pos);
    if (c.netOffset.lengthSq() > 7 * 7) {
      // a respawn or a big hiccup: no point sliding across the map
      c.netOffset.set(0, 0, 0);
      c.netQuat.identity();
    } else {
      c.netQuat.copy(seenQuat).multiply(TQ2.copy(p.quat).invert());
    }
  }

  /** Online: someone left the room. Their car fades off the track. */
  dropCar(id: string) {
    const c = this.cars.find((x) => x.id === id);
    if (!c || c.isPlayer || c.gone) return;
    c.gone = true;
    c.visual.root.visible = false;
    c.tag?.remove();
    this.physicsList = this.physicsList.filter((p) => p !== c.physics);
    if (c.voice) audio.stopVoice(c.voice);
    if (this.player) this.hud?.message(`${c.name} SAIU`, 1.6);
  }

  /** Online: keep the race running behind the lobby, watching from cinematic cameras. */
  setSpectate(v: boolean) {
    if (this.spectate === v) return;
    this.spectate = v;
    this.hud?.show(!v, 'race');
    if (v) {
      audio.stopEngine();
      for (const c of this.cars) if (c.voice && !c.isPlayer) audio.stopVoice(c.voice);
      this.attractCam = 0;
    }
  }

  get spectating() {
    return this.spectate;
  }

  private get live() {
    return this.cars.filter((c) => !c.gone);
  }

  private startAudio() {
    for (const c of this.cars) {
      if (!c.voice || c.gone) continue;
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
      if (this.net) this.countdown = (this.net.startAt - performance.now()) / 1000;
      else this.countdown -= dt;
      const c = Math.ceil(this.countdown - 0.6);
      if (c !== this.lastCount && c <= 3 && !this.spectate) {
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
    const driving = this.input && this.player && racing && !this.player.finished && !this.spectate && !this.inputLocked;
    const playerInput = driving ? this.input!.read(dt) : { throttle: 0, brake: this.player && (this.spectate || this.inputLocked) && racing ? 0.4 : 0, steer: 0 };
    const physicsList = this.physicsList;
    this.bumpCooldown -= dt;
    this.scrapeCooldown -= dt;
    // AI rubber band: measured against the best human
    let leader = this.player ? this.progress(this.player) : 0;
    if (this.net) for (const c of this.cars) if (c.human && !c.gone) leader = Math.max(leader, this.progress(c));
    for (const c of this.cars) {
      if (c.remote) continue; // steered by its owner's snapshots
      if (!racing) {
        c.lastInput = { throttle: 0, brake: 0, steer: 0 };
        // engine rev during countdown for the player
        if (c.isPlayer && this.input && !this.spectate) {
          const i = this.input.read(dt);
          c.physics.rpm += ((i.throttle ? 0.85 : 0.15) - c.physics.rpm) * (1 - Math.exp(-6 * dt));
        }
        continue;
      }
      if (c.ai) {
        if (this.player && this.mode === 'race' && !c.finished) {
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
        for (const c of this.cars) if (!c.gone) c.physics.step(FIXED, c.lastInput);
        this.collide();
      }
    }
    // draw every car where it is *now*, between two physics steps, not where the
    // last step left it: otherwise frames that fit 1 or 3 steps instead of 2 judder
    const alpha = racing ? this.acc / FIXED : 1;
    for (const c of this.cars) if (!c.gone) c.physics.interpolate(c.remote ? 1 : alpha);

    if (racing && this.player && this.player.lap >= 1 && !this.player.finished) {
      this.recorder.record(dt, this.player.physics.pos, this.player.physics.quat);
    }

    // game logic per car
    for (const c of this.cars) {
      if (c.gone) continue;
      this.updateCarLogic(c, dt, racing);
      this.handleEvents(c);
    }

    // standings
    const order = this.live.sort((a, b) => this.progress(b) - this.progress(a));
    order.forEach((c, i) => (c.place = i + 1));

    if (this.net) this.netSend(dt);

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
    const cockpit = this.player && !this.spectate && this.chase.inCockpit ? this.cockpit : null;
    if (this.mode === 'attract' || this.spectate) this.updateAttractCamera(camera, dt, t);
    else if (cockpit && this.player) this.updateCockpit(cockpit, this.player, camera, dt, t, racing);
    else if (this.player) this.chase.update(camera, this.player.physics, dt, t);
    renderer.setOverlay(cockpit ? cockpit.scene : null);
    this.world.decor.update(dt, camera.position);
    // shadows follow the player (or whatever the attract camera is looking at)
    const focus = this.player ? this.player.physics.pos : camera.getWorldDirection(scratchFocus).multiplyScalar(18).add(camera.position);
    this.world.sky.update(t, camera.position, 20, focus);
    cockpit?.renderMirror(renderer.gl, this.world.scene);

    // post fx + audio + hud
    this.updateTags(camera);
    if (this.player && !this.spectate) {
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
    if (this.finishedAt >= 0 && !this.done && this.time - this.finishedAt > 2.5 && !this.spectate) {
      this.done = true;
      this.onFinish?.(this.result());
    }
  }

  /** Online: stream the cars this machine owns, 20 times a second. */
  private netSend(dt: number) {
    const net = this.net!;
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = 0.05;
    for (const c of this.cars) {
      if (!c.owned || c.gone) continue;
      const best = c.lapTimes.length ? Math.min(...c.lapTimes) : null;
      net.room.sendState(c.id, packCar(c.physics, c.lastInput, { rt: this.countdown > 0 ? 0 : this.time, lap: c.lap, finished: c.finished, finishTime: c.finishTime, bestLap: best }));
    }
  }

  private updateTags(camera: PerspectiveCamera) {
    if (!this.tags) return;
    const off = this.spectate || !!this.player?.finished;
    this.tags.classList.toggle('hidden', off);
    if (off) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const c of this.cars) {
      if (!c.tag) continue;
      const v = c.visual.root;
      const p = TMP.copy(c.physics.up).multiplyScalar(2.1).add(v.position);
      const dist = p.distanceTo(camera.position);
      p.project(camera);
      const show = !c.gone && p.z < 1 && dist < 160 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
      c.tag.style.opacity = show ? String(Math.max(0, Math.min(1, (160 - dist) / 60))) : '0';
      if (!show) continue;
      const sc = Math.max(0.6, Math.min(1, 30 / dist + 0.45));
      c.tag.style.zIndex = String(1000 - Math.round(dist));
      c.tag.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -100%) scale(${sc.toFixed(3)})`;
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
      if (c.isPlayer || !c.voice || c.gone) continue;
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

    // lap counting: crossing s=0 forwards (remote cars report their own)
    if (racing && !c.remote) {
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
            const place = this.net ? 1 + this.live.filter((o) => o !== c && o.finished && o.finishTime <= c.finishTime).length : c.place;
            this.hud?.message(place === 1 || this.mode === 'timetrial' ? 'META!' : `${place}º LUGAR`, 3, 'big');
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

    // effects: drift smoke and boost embers
    const parts = this.world.particles;
    if (p.grounded && (p.drifting || p.slip > 6) && p.speed > 10) {
      for (const side of [-1, 1]) {
        const wp = TMP.copy(p.pos).addScaledVector(p.fwd, -1.3).addScaledVector(p.right, side * 0.85).addScaledVector(p.up, 0.25);
        const v = TMP2.copy(p.up).multiplyScalar(1.5).addScaledVector(p.vel, 0.25);
        parts.emit(wp, v, SMOKE, 0.12, 0.7, 0.9, 2.5, 1.5);
      }
      if (p.drifting && p.driftTime > 0.7) {
        const charge = Math.min(1, p.driftTime / 3);
        const col = charge > 0.6 ? SPARK_HOT : SPARK;
        const wp = TMP.copy(p.pos).addScaledVector(p.fwd, -1.3).addScaledVector(p.right, -p.driftDir * 0.85).addScaledVector(p.up, 0.1);
        parts.emit(wp, TMP2.set((Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4).addScaledVector(p.vel, 0.6), col, 1, 0.12, 0.35, 0, 1);
      }
    }
    if (p.boostFx > 0.3 && c.visual.exhaustTips.length) {
      const nitro = p.nitroFx > 0.3;
      const tips = c.visual.exhaustTips.length;
      // nitro sheds bright blue sparks; a plain boost a few embers
      const n = nitro ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const wp = c.visual.tipWorld(Math.floor(Math.random() * tips), TMP);
        const v = TMP2.copy(p.vel)
          .multiplyScalar(0.75)
          .addScaledVector(p.fwd, -(nitro ? 10 : 6) - Math.random() * 6)
          .addScaledVector(p.up, (Math.random() - 0.3) * 2)
          .addScaledVector(p.right, (Math.random() - 0.5) * 2.5);
        parts.emit(wp, v, nitro ? (Math.random() < 0.3 ? NITRO_WHITE : NITRO_SPARK) : EMBER, (nitro ? 0.9 : 0.5) * p.boostFx, nitro ? 0.1 : 0.14, nitro ? 0.28 : 0.2, -0.2, 2.5);
      }
    }
  }

  private handleEvents(c: RaceCar) {
    const p = c.physics;
    for (const e of p.events) {
      // exhaust effects and engine sounds happen for every car
      if (e.type === 'pop') {
        c.visual.exhaust?.pop(e.strength);
        if (c.voice) audio.pop(c.voice, e.strength);
        if (e.strength > 0.6 && c.visual.exhaustTips.length) {
          const wp = c.visual.tipWorld(Math.floor(Math.random() * c.visual.exhaustTips.length), TMP);
          for (let k = 0; k < 3; k++) {
            this.world.particles.emit(wp, TMP2.copy(p.vel).addScaledVector(p.fwd, -4 - Math.random() * 4).addScaledVector(p.up, Math.random() * 2), SPARK, 0.9, 0.08, 0.25, 0, 2);
          }
        }
        continue;
      }
      if (e.type === 'nitro') {
        c.visual.exhaust?.ignite();
        if (c.voice) audio.nitroStart(c.voice);
        const tips = c.visual.exhaustTips.length;
        for (let k = 0; k < 12 && tips; k++) {
          const wp = c.visual.tipWorld(k, TMP);
          const v = TMP2.set((Math.random() - 0.5) * 5, (Math.random() - 0.2) * 4, (Math.random() - 0.5) * 5).addScaledVector(p.vel, 0.8).addScaledVector(p.fwd, -8);
          this.world.particles.emit(wp, v, k % 3 ? NITRO_SPARK : NITRO_WHITE, 1, 0.16, 0.35, 0.4, 2);
        }
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
          for (let k = 0; k < 8; k++) {
            const side = Math.sign(p.lateral);
            const wp = TMP.copy(p.pos).addScaledVector(p.right, side * 1).addScaledVector(p.up, 0.4);
            this.world.particles.emit(wp, TMP2.set((Math.random() - 0.5) * 6, Math.random() * 6, (Math.random() - 0.5) * 6).addScaledVector(p.vel, 0.8), SPARK_HOT, 1, 0.12, 0.4, 0, 1);
          }
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
    const parts = this.world.particles;
    for (const ct of contacts) {
      const hard = Math.min(1, ct.impulse / 14);
      // sparks fly out of the contact, carried along by the cars
      const n = Math.min(14, Math.round(ct.impulse * 0.9 + ct.scrape * 0.15));
      const carry = TMP3.copy(ct.a.vel).add(ct.b.vel).multiplyScalar(0.5);
      for (let k = 0; k < n; k++) {
        const out = Math.random() < 0.5 ? 1 : -1;
        const v = TMP2.set((Math.random() - 0.5) * 7, 1.5 + Math.random() * 5, (Math.random() - 0.5) * 7)
          .addScaledVector(ct.normal, out * (2 + ct.impulse * 0.4))
          .add(carry);
        parts.emit(TMP.copy(ct.point).addScaledVector(ct.a.up, 0.45 + Math.random() * 0.3), v, k % 3 ? SPARK : SPARK_HOT, 1, 0.1 + 0.06 * hard, 0.25 + 0.3 * Math.random(), 0, 1.4);
      }
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
    const ease = 1 - Math.exp(-9 * dt);
    for (const c of this.cars) {
      if (c.gone) continue;
      const p = c.physics;
      const v = c.visual;
      v.root.position.copy(p.draw.pos);
      v.root.quaternion.copy(p.draw.quat);
      if (c.remote) {
        c.netOffset.multiplyScalar(1 - ease);
        c.netQuat.slerp(IDENTITY, ease);
        v.root.position.add(c.netOffset);
        v.root.quaternion.premultiply(c.netQuat);
      }
      v.body.rotation.set(p.pitch, 0, p.roll);
      v.body.position.y = p.heave * 0.5;
      const counter = p.drifting ? p.driftDir * 0.35 : 0;
      v.updateWheels({
        steer: p.steerVisual + counter,
        spin: p.wheelSpin,
        travel: [p.heave * 0.4 - p.roll * 0.6, p.heave * 0.4 + p.roll * 0.6, p.heave * 0.4 - p.roll * 0.6, p.heave * 0.4 + p.roll * 0.6].map((x) => Math.max(-0.08, Math.min(0.08, x))),
      });
      v.materials.setBrake(c.lastInput.brake > 0 && p.forwardSpeed > 1 ? 1 : 0);
      v.exhaust?.update(dt, this.fxTime + c.place * 3.1, Math.max(0, p.boostFx - p.nitroFx), p.nitroFx);
    }
  }

  private updateCockpit(cockpit: Cockpit, car: RaceCar, camera: PerspectiveCamera, dt: number, t: number, racing: boolean) {
    const p = car.physics;
    cockpit.follow(car.visual.body);
    this.chase.updateCockpit(camera, p, car.visual.body, cockpit.eye, dt, t);
    cockpit.update(dt, {
      steer: p.steerVisual + (p.drifting ? p.driftDir * 0.35 : 0),
      rpm: p.rpm,
      gear: p.gear,
      speed: p.forwardSpeed,
      nitro: p.nitro,
      nitroActive: p.nitroActive,
      limiter: p.drivetrain.limiter,
      drifting: p.drifting,
      latAccel: p.yawRate * p.speed,
      parked: racing ? 0 : 1,
      lean: this.chase.headLean,
    });
  }

  setCameraZoom(level: CameraZoom, instant = false) {
    this.chase.setZoom(level, instant);
  }

  private updateAttractCamera(cam: PerspectiveCamera, dt: number, t: number) {
    this.attractCam -= dt;
    if (this.attractCam <= 0) {
      this.attractCam = 7;
      this.attractTarget = (this.attractTarget + 1) % this.cars.length;
      while (this.cars[this.attractTarget].gone && this.live.length) this.attractTarget = (this.attractTarget + 1) % this.cars.length;
      this.chase.snap();
    }
    const physics = this.cars[this.attractTarget].physics;
    const car = physics.draw;
    const phase = Math.floor(t / 7) % 3;
    if (phase === 0) {
      this.chase.update(cam, physics, dt, t);
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
        total: this.live.length,
        lap: this.player.lap,
        laps: LAPS,
        time: this.time,
        lapTime: this.time - this.player.lapStart,
        bestLap: best,
        ghostDelta,
        dots: this.live.map((c) => ({ x: c.physics.pos.x, z: c.physics.pos.z, color: c.color, player: c.isPlayer })),
        wrongWay: this.player.wrongWay > 1.2,
      },
      dt,
    );
  }

  result(): RaceResult {
    const L = this.world.track.length;
    const entries: RaceEntry[] = this.live.map((c) => {
      let time: number | null = c.finished ? c.finishTime : null;
      if (this.net) {
        // online: nobody's time is guessed; who's still out there shows live
        const best = c.remote ? c.netBest : c.lapTimes.length ? Math.min(...c.lapTimes) : null;
        return {
          name: c.name,
          isPlayer: c.isPlayer,
          time,
          bestLap: best,
          place: 0,
          color: c.color,
          human: c.human,
          racing: c.finished ? undefined : `VOLTA ${Math.max(1, Math.min(LAPS, c.lap))}/${LAPS}`,
        };
      }
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
    if (this.net) {
      const prog = new Map(this.live.map((c) => [c.name, this.progress(c)]));
      entries.sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9) || (prog.get(b.name) ?? 0) - (prog.get(a.name) ?? 0));
    } else entries.sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9));
    entries.forEach((e, i) => (e.place = i + 1));
    const lapTimes = this.player?.lapTimes ?? [];
    return {
      mode: this.mode === 'timetrial' ? 'timetrial' : 'race',
      entries,
      lapTimes,
      bestLap: lapTimes.length ? Math.min(...lapTimes) : null,
      newRecord: this.newRecord,
      online: !!this.net,
    };
  }

  dispose() {
    if (this.net && this.net.room.onState) this.net.room.onState = null;
    this.tags?.remove();
    for (const c of this.cars) {
      if (c.voice && !c.isPlayer) audio.stopVoice(c.voice);
      this.world.scene.remove(c.visual.root);
      c.visual.dispose();
    }
    if (this.ghostVisual) {
      this.world.scene.remove(this.ghostVisual.root);
      this.ghostVisual.dispose();
    }
    this.cockpit?.dispose();
    this.cockpit = null;
    if (this.player) audio.stopEngine();
    this.hud?.show(false);
    this.hud?.setCountdown('');
  }
}

const TMP = new Vector3();
const TMP2 = new Vector3();
const TMP3 = new Vector3();
const TQ = new Quaternion();
const TQ2 = new Quaternion();
const IDENTITY = new Quaternion();
const SMOKE = new Color(0.9, 0.9, 0.95);
const SPARK = new Color(1.6, 0.9, 0.3);
const SPARK_HOT = new Color(0.6, 1.6, 3.0);
const EMBER = new Color(0.9, 0.45, 0.15);
const NITRO_SPARK = new Color(0.35, 0.9, 2.6);
const NITRO_WHITE = new Color(2.2, 2.4, 2.8);
const PICK_COLOR = new Color(0.4, 2.2, 3.0);
