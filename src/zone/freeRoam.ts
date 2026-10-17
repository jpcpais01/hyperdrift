import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { buildCar, type CarVisual } from '../car/carBuilder';
import { Cockpit } from '../car/cockpit';
import { paintById, randomBuild, type CarBuild } from '../car/parts';
import { computeStats, type CarStats } from '../car/stats';
import { engineProfile } from '../audio/engineProfile';
import { audio } from '../core/audio';
import { isTouch } from '../core/fullscreen';
import type { Input } from '../core/input';
import type { Renderer } from '../core/renderer';
import { collideCars, type CarContact } from '../game/carCollision';
import { emitContactFx, emitDriveFx, emitNitroFx, emitPopFx, emitWallFx, poseCar } from '../game/carFx';
import { CarPhysics, type DriveInput } from '../game/carPhysics';
import { CrashSystem, DMG_TAG, netDamageDue, sagBody } from '../game/crash';
import type { CarDamage, ImpactResult } from '../car/damage';
import { ChaseCamera, type CameraZoom } from '../game/chaseCamera';
import { applyCar, packCar, unpackCar, type CarSnapshot } from '../net/carState';
import { HOST_ID } from '../net/protocol';
import type { Room } from '../net/room';
import { formatScore, type Hud } from '../ui/hud';
import { Decor } from '../world/decor';
import { Particles } from '../world/particles';
import type { Sky } from '../world/sky';
import { clockLabel, dayState, newDayState } from '../world/timeOfDay';
import { DriftScore, gradeFor } from './driftScore';
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
  /** headlight beams painted on the ground in front of every car, after dark */
  readonly beams: InstancedMesh;
  readonly beamMat: MeshBasicMaterial;

  constructor(readonly sky: Sky) {
    sky.prepareDayEnvs();
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
    this.beamMat = new MeshBasicMaterial({
      map: beamTexture(),
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      fog: true,
    });
    // a quad with its near edge on the origin, stretching forwards (+z)
    const g = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
    this.beams = new InstancedMesh(g, this.beamMat, 12);
    this.beams.instanceColor = new InstancedBufferAttribute(new Float32Array(12 * 3), 3);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 3;
    this.scene.add(this.view.group, this.decor.group, this.particles.points, this.beams);
  }

  attach() {
    this.sky.addTo(this.scene);
  }
}

/** Two soft headlight lobes that widen and fade down the road. */
function beamTexture(): CanvasTexture {
  const W = 128;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.globalCompositeOperation = 'lighter';
  // canvas y=0 is the far end of the beam (texture v=1 maps to +z)
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const y = H * (1 - 0.06 - t * 0.86);
    const spread = 0.1 + t * 0.32;
    const r = W * (0.07 + t * 0.2);
    const a = 0.11 * Math.pow(1 - t, 1.3) + 0.012;
    for (const side of [-1, 1]) {
      const x = W * (0.5 + side * spread * 0.55);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
    }
  }
  const tex = new CanvasTexture(c);
  return tex;
}

interface ZoneCar {
  id: string;
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
  /** online: driven by somebody else's snapshots */
  remote: boolean;
  human: boolean;
  /** online: left the room */
  gone: boolean;
  lastRt: number;
  lastHeard: number;
  /** what the picture still owes the physics after a snapshot jump (eased away) */
  netOffset: Vector3;
  netQuat: Quaternion;
  tag: HTMLElement | null;
  /** online: the chain they are on right now, their session total */
  live: number;
  liveMult: number;
  total: number;
  damage?: CarDamage;
  netDmgRev: number;
  netDmgRepeat: number;
}

/** What the host's "go" carries for a zone session. */
export interface ZonePayload {
  residents: boolean;
}

export interface ZoneNet {
  room: Room;
  residents: boolean;
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
/** a whole day goes by in 16 minutes */
export const DAY_RATE = 24 / (16 * 60);
/** visits start late in the afternoon, so the sun sets on your first drive */
const START_HOUR = 16.4;
/** a remote car that has said nothing for this long is parked out of sight (its owner is in the garage…) */
const QUIET_MS = 2500;
const IDENTITY = new Quaternion();

/**
 * Free roam in the drift zone: no laps, no clock. The island's residents cruise and
 * drift around (a tandem pair on the plaza circle, a tourer through the meadow, a
 * speedster on the banked rim) while you chain drifts for points.
 */
export class FreeRoam {
  readonly cars: ZoneCar[] = [];
  private activeList: CarPhysics[] = [];
  private contacts: CarContact[] = [];
  private player: ZoneCar;
  private chase = new ChaseCamera();
  private cockpit: Cockpit;
  readonly score: DriftScore;
  private acc = 0;
  private time = 0;
  private fxTime = 0;
  private intro = INTRO;
  private bumpCooldown = 0;
  private scrapeCooldown = 0;
  private introFrom = new Vector3();
  private sendTimer = 0;
  private boardTimer = 0;
  private snap: CarSnapshot | null = null;
  private tags: HTMLElement | null = null;
  private spectate = false;
  private orbit = 0;
  /** time of day (hours) and whether it moves on its own */
  private hour = START_HOUR;
  private clockRuns = true;
  /** online guests: the host's clock as last heard ({h, r, at} on the host clock) */
  private hostClock: { h: number; r: boolean; at: number } | null = null;
  private clockTimer = 0;
  private day = newDayState();
  private shownClock = '';
  /** called when the time of day or its running state changes (for the pause menu) */
  onClock: (() => void) | null = null;
  paused = false;
  /** online pause: the zone goes on, my hands are off the wheel */
  inputLocked = false;
  /** called whenever the best drift improves (to save it) */
  onBest: ((best: number) => void) | null = null;
  /** dents, flying parts, smoke and wrecks */
  readonly crash: CrashSystem;
  private sendCount = 0;

  constructor(
    private world: ZoneWorld,
    playerBuild: CarBuild,
    private input: Input,
    private hud: Hud,
    bestDrift: number,
    readonly net: ZoneNet | null = null,
  ) {
    const L = world.layout;
    this.score = new DriftScore(bestDrift);
    world.particles.clear();
    // debris bounces on the island's ground
    this.crash = new CrashSystem(
      world.scene,
      world.particles,
      (p, _hint, up) => {
        L.normalAt(p.x, p.z, up);
        return (p.y - L.heightAt(p.x, p.z)) * up.y;
      },
      {
        playerHit: (r) => this.onPlayerCrash(r),
        // out here a wreck is put back on its wheels where it stopped
        recover: (c) => {
          c.physics.place(c.physics.pos.clone(), c.physics.fwd.clone());
          if (c.isPlayer) this.hud.message('REPARADO', 1.3);
        },
      },
    );

    const plaza = samplePath(stadiumPoint, 2);
    const rim = samplePath(circlePath(231), 2.5);
    const residents: Resident[] = [
      { name: 'KAI', seed: 21, path: plaza, style: { pace: 0.42, nitro: false }, start: 0 },
      { name: 'MEI', seed: 64, path: plaza, style: { pace: 0.42, nitro: false }, start: Math.floor(plaza.length / 2) },
      { name: 'ROOK', seed: 97, path: L.tour, style: { pace: 0.8, nitro: true }, start: 40 },
      { name: 'VEX', seed: 133, path: rim, style: { pace: 0.95, nitro: true }, start: 200 },
    ];
    // online the host drives the residents and everybody else sees them through its snapshots
    const hostsResidents = !net || net.room.isHost;
    if (!net || net.residents)
      residents.forEach((r, i) => {
        const build = randomBuild(r.seed);
        const car = this.addCar(`z${i}`, r.name, build, false, i + 1);
        const driver = new ZoneDriver(r.path, r.style);
        driver.place(car.physics, r.start);
        if (hostsResidents) car.driver = driver;
        else this.setRemote(car, false);
        car.voice = `zone${i}`;
      });
    const room = net?.room;
    this.player = this.addCar(room?.myId ?? 'me', room?.me?.name ?? 'TU', playerBuild, true, 0);
    this.player.voice = 'player';
    // a starting slot each, so nobody spawns inside a friend
    const slot = room ? Math.max(0, room.players.findIndex((p) => p.id === room.myId)) : 1;
    this.player.physics.spawnSlot = slot;
    this.player.physics.respawn();
    this.player.physics.events.length = 0;
    this.player.physics.nitro = 0.6;

    this.cockpit = new Cockpit(playerBuild, isTouch(), world.sky.envMap);
    if (this.player.visual.damage) this.cockpit.setDamage(this.player.visual.damage.uniforms);
    this.startAudio();
    hud.setZoneMap(L);
    hud.show(true, 'zone');
    hud.setZoneScore(this.score);
    hud.zoneIntro(true);
    this.introFrom.set(-420, ZONE_Y + 150, -520);

    if (net) {
      this.tags = document.createElement('div');
      this.tags.className = 'name-tags';
      hud.el.appendChild(this.tags);
      for (const c of this.cars) if (c.remote) this.addTag(c);
      net.room.onState = (id, d) => this.onNetState(id, d);
      net.room.onEvent = (from, d) => this.onNetEvent(from, d);
      this.syncRoster();
    }
    this.updateBoard();
  }

  private addCar(id: string, name: string, build: CarBuild, isPlayer: boolean, seed: number): ZoneCar {
    const stats = computeStats(build);
    const physics = new CarPhysics(null, stats, seed + 1);
    physics.ground = this.world.layout;
    const visual = buildCar(build, { damage: true });
    physics.hitbox = visual.hitbox;
    this.world.sky.castShadows(visual.root);
    this.world.scene.add(visual.root);
    const car: ZoneCar = {
      id,
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
      remote: false,
      human: isPlayer,
      gone: false,
      lastRt: -Infinity,
      lastHeard: 0,
      netOffset: new Vector3(),
      netQuat: new Quaternion(),
      tag: null,
      live: 0,
      liveMult: 1,
      total: 0,
      netDmgRev: -1,
      netDmgRepeat: 0,
    };
    this.cars.push(car);
    this.crash.add(car, seed + 7);
    return car;
  }

  /** A car somebody else drives: no physics of its own until their first snapshot arrives. */
  private setRemote(c: ZoneCar, human: boolean) {
    c.remote = true;
    c.human = human;
    c.visual.root.visible = false;
  }

  private addTag(c: ZoneCar) {
    if (!this.tags) return;
    c.tag = document.createElement('div');
    c.tag.className = `name-tag${c.human ? ' human' : ''}`;
    c.tag.innerHTML = `<i style="background:${c.color}"></i><span></span><em></em>`;
    c.tag.querySelector('span')!.textContent = c.name;
    this.tags.appendChild(c.tag);
  }

  // ---------------------------------------------------------- online

  /** Online: people come and go as they please. Their cars follow the room's roster. */
  syncRoster() {
    const room = this.net?.room;
    if (!room) return;
    for (const p of room.players) {
      if (p.id === room.myId) continue;
      let c = this.cars.find((x) => x.id === p.id && !x.gone);
      if (c && c.name !== p.name) {
        c.name = p.name;
        const s = c.tag?.querySelector('span');
        if (s) s.textContent = p.name;
      }
      if (c) continue;
      c = this.addCar(p.id, p.name, p.build, false, 300 + this.cars.length);
      this.setRemote(c, true);
      c.voice = `net-${p.id}`;
      this.addTag(c);
      if (audio.ctx && !this.spectate) audio.startVoice(c.voice, engineProfile(c.build), { full: false, spatial: true });
    }
    for (const c of this.cars) {
      if (!c.human || c.isPlayer || c.gone || room.players.some((p) => p.id === c.id)) continue;
      this.dropCar(c);
    }
    this.updateBoard();
  }

  private dropCar(c: ZoneCar) {
    c.gone = true;
    this.crash.remove(c);
    this.world.scene.remove(c.visual.root);
    c.visual.dispose();
    c.tag?.remove();
    if (c.voice) audio.stopVoice(c.voice);
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
    // people in the room but never out here (lobby, garage) come and go unannounced
    if (c.lastHeard > 0 && !this.spectate) this.hud.message(`${c.name} SAIU`, 1.6);
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
    const p = c.physics;
    const fresh = !c.visual.root.visible;
    if (c.human && c.lastHeard === 0 && !this.spectate) this.hud.message(`${c.name} ENTROU NA ZONA`, 1.8);
    c.lastHeard = performance.now();
    c.visual.root.visible = true;
    const seenPos = TMP.copy(p.pos).add(c.netOffset);
    const seenQuat = TQ.copy(c.netQuat).multiply(p.quat);
    applyCar(p, s, 0);
    c.lastInput = s.input;
    // the score rides along after the car, then its damage
    const a = d as number[];
    const at = a.indexOf(DMG_TAG, 27);
    if (at > 0) this.crash.apply(c, a, at + 1);
    c.live = Math.max(0, Number(a[27]) || 0);
    c.liveMult = Math.max(1, Math.min(9, Number(a[28]) || 1));
    c.total = Math.max(0, Number(a[29]) || 0);
    // the snapshot is a few ms old: replay that bit with the inputs it carried
    const lag = Math.max(0, Math.min(0.25, this.net!.room.hostNow() / 1000 - s.rt));
    const steps = Math.round(lag / FIXED);
    for (let k = 0; k < steps; k++) p.step(FIXED, s.input);
    p.events = p.events.filter((e) => e.type === 'nitro' || e.type === 'pop');
    c.netOffset.copy(seenPos).sub(p.pos);
    if (fresh || c.netOffset.lengthSq() > 7 * 7) {
      // first sight, a respawn or a big hiccup: no point sliding across the map
      c.netOffset.set(0, 0, 0);
      c.netQuat.identity();
    } else {
      c.netQuat.copy(seenQuat).multiply(TQ2.copy(p.quat).invert());
    }
  }

  private onNetEvent(from: string, d: unknown) {
    const e = d as { k?: unknown; s?: unknown; h?: unknown; r?: unknown; at?: unknown } | null;
    if (e?.k === 'time') {
      const h = Number(e.h);
      const at = Number(e.at);
      if (from !== HOST_ID || !isFinite(h) || !isFinite(at)) return;
      this.hostClock = { h, r: !!e.r, at };
      return;
    }
    if (!e || e.k !== 'bank') return;
    const score = Math.max(0, Math.floor(Number(e.s) || 0));
    const c = this.cars.find((x) => x.id === from && x.human);
    // only the big ones make the feed: a stream of "BOM"s would bury your own score
    if (!c || score < 3000 || this.spectate) return;
    this.hud.message(`${c.name} · ${gradeFor(score)} ${formatScore(score)}`, 2, 'drift');
  }

  // ---------------------------------------------------------- time of day

  /** Can I change the time here? (online only the host can, and everybody follows) */
  get clockEditable() {
    return !this.net || this.net.room.isHost;
  }

  get clock() {
    return { hour: this.hour, running: this.clockRuns, editable: this.clockEditable };
  }

  /** Pick a time of day (null keeps it) and whether it keeps moving. */
  setClock(hour: number | null, running: boolean) {
    if (!this.clockEditable) return;
    if (hour !== null) this.hour = ((hour % 24) + 24) % 24;
    this.clockRuns = running;
    this.applyDay();
    this.sendClock();
    this.onClock?.();
  }

  private sendClock() {
    const room = this.net?.room;
    if (!room?.isHost) return;
    this.clockTimer = 3;
    room.sendEvent({ k: 'time', h: Math.round(this.hour * 1e4) / 1e4, r: this.clockRuns ? 1 : 0, at: Math.round(room.hostNow()) });
  }

  private updateClock(dt: number) {
    const room = this.net?.room;
    if (room && !room.isHost) {
      // a guest's sky follows the host's clock
      const c = this.hostClock;
      if (c) {
        const was = this.clockRuns;
        this.hour = (((c.h + (c.r ? (DAY_RATE * (room.hostNow() - c.at)) / 1000 : 0)) % 24) + 24) % 24;
        this.clockRuns = c.r;
        if (was !== c.r) this.onClock?.();
      }
    } else {
      if (this.clockRuns) this.hour = (this.hour + dt * DAY_RATE) % 24;
      if (room) {
        // latecomers pick the time up from this heartbeat
        this.clockTimer -= dt;
        if (this.clockTimer <= 0) this.sendClock();
      }
    }
    this.applyDay();
  }

  private applyDay() {
    const s = dayState(this.hour, this.day);
    this.world.sky.setDay(s);
    this.world.view.setDay(s);
    this.world.decor.setLight(s.ambient);
    const label = clockLabel(s.hour);
    if (label !== this.shownClock) {
      this.shownClock = label;
      this.hud.setZoneClock(label, s.sinEl < -0.02);
    }
  }

  /** After dark every car's headlights throw two soft beams down the road. */
  private updateHeadlights() {
    const s = this.day;
    const lit = Math.max(s.night, s.twilight * 0.5);
    const w = this.world;
    w.beamMat.color.setRGB(1.0, 0.93, 0.8).multiplyScalar(1.35 * lit);
    w.beams.visible = lit > 0.01;
    if (!w.beams.visible) return;
    const L = w.layout;
    let n = 0;
    for (const c of this.cars) {
      if (n >= 12 || (c.remote && !c.visual.root.visible)) continue;
      // both headlamps smashed: no beam
      if (c.damage?.lightsOut[0] && c.damage.lightsOut[1]) continue;
      const d = c.physics.draw;
      const front = TMP.copy(d.pos).addScaledVector(d.fwd, 2.0);
      const gy = L.heightAt(front.x, front.z);
      // fades away as the car leaves the ground, so a jump doesn't paint light on nothing
      const k = Math.max(0, 1 - Math.max(0, front.y - gy - 0.4) / 2.5);
      L.normalAt(front.x, front.z, NRM);
      const f = TMP2.copy(d.fwd).addScaledVector(NRM, -d.fwd.dot(NRM)).normalize();
      const r = TMP3.crossVectors(NRM, f).normalize();
      BEAM.makeBasis(r.multiplyScalar(13), NRM, f.multiplyScalar(30));
      BEAM.setPosition(front.x, gy + 0.07, front.z);
      w.beams.setMatrixAt(n, BEAM);
      w.beams.setColorAt(n, BEAMC.setScalar(k));
      n++;
    }
    w.beams.count = n;
    w.beams.instanceMatrix.needsUpdate = true;
    if (w.beams.instanceColor) w.beams.instanceColor.needsUpdate = true;
  }

  /** Online: stream the cars this machine drives, 20 times a second. */
  private netSend(dt: number) {
    const room = this.net!.room;
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer = 0.05;
    this.sendCount++;
    const rt = room.hostNow() / 1000;
    for (const c of this.cars) {
      if (c.remote || c.gone) continue;
      // parked behind the lobby: go quiet, so friends don't have my car in their way
      if (c.isPlayer && this.spectate) continue;
      const d = packCar(c.physics, c.lastInput, { rt, lap: 0, finished: false, finishTime: 0, bestLap: null });
      if (c.isPlayer) d.push(this.score.active ? this.score.score : 0, this.score.mult, this.score.total);
      else d.push(0, 1, 0);
      if (c.damage && netDamageDue(c, this.sendCount)) d.push(DMG_TAG, ...c.damage.pack());
      room.sendState(c.id, d);
    }
  }

  /** The little "who's scored most" list under the zone title. */
  private updateBoard() {
    if (!this.net) return this.hud.setZoneBoard(null);
    const rows = this.cars
      .filter((c) => c.human && !c.gone && (c.isPlayer || c.lastHeard > 0))
      .map((c) => ({ name: c.name, color: c.color, total: c.isPlayer ? this.score.total : c.total, me: c.isPlayer }))
      .sort((a, b) => b.total - a.total);
    this.hud.setZoneBoard(rows.length > 1 ? rows : null);
  }

  /** Online: keep the zone running behind the lobby, the camera drifting around my parked car. */
  setSpectate(v: boolean) {
    if (this.spectate === v) return;
    this.spectate = v;
    this.hud.show(!v, 'zone');
    this.tags?.classList.toggle('hidden', v);
    this.input.clear();
    if (v) {
      this.score.flush();
      this.hud.zoneIntro(false);
      this.intro = Math.min(this.intro, 0);
      audio.stopEngine();
      for (const c of this.cars) if (c.voice && !c.isPlayer) audio.stopVoice(c.voice);
    } else {
      this.hud.setZoneMap(this.world.layout);
      this.hud.setZoneScore(this.score);
      this.updateBoard();
      this.chase.snap();
      this.startAudio();
    }
  }

  get spectating() {
    return this.spectate;
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
    this.updateClock(this.paused ? 0 : dt);
    if (this.paused) {
      this.pose(0);
      return;
    }
    this.time += dt;
    const t = performance.now() / 1000;

    // intro flyover: skipped as soon as the player touches the controls
    let playerInput: DriveInput = { throttle: 0, brake: 0, steer: 0 };
    const locked = this.spectate || this.inputLocked;
    const raw: DriveInput = locked ? { throttle: 0, brake: 0.4, steer: 0 } : this.input.read(dt);
    if (locked) playerInput = raw;
    else if (this.intro > 0) {
      this.intro -= dt;
      if (raw.throttle > 0 || raw.brake > 0 || Math.abs(raw.steer) > 0.5 || (raw.nitro ?? 0) > 0) this.intro = Math.min(this.intro, 0);
      if (this.intro <= 0) {
        this.hud.zoneIntro(false);
        this.chase.snap();
      }
    } else playerInput = raw;

    this.bumpCooldown -= dt;
    this.scrapeCooldown -= dt;
    // remote cars that went quiet are parked out of the way until they speak again
    const now = performance.now();
    this.activeList.length = 0;
    for (const c of this.cars) {
      if (c.remote && c.visual.root.visible && now - c.lastHeard > QUIET_MS) c.visual.root.visible = false;
      if (!c.remote || c.visual.root.visible) this.activeList.push(c.physics);
    }
    for (const c of this.cars) {
      if (c.driver) c.lastInput = c.driver.drive(c.physics, this.activeList, dt);
      else if (c.isPlayer) c.lastInput = playerInput;
    }

    this.acc += Math.min(dt, 0.1);
    while (this.acc >= FIXED) {
      this.acc -= FIXED;
      for (const c of this.cars) if (!c.remote || c.visual.root.visible) c.physics.step(FIXED, c.lastInput);
      this.collide();
    }
    // draw between the last two physics steps (snapshot-driven cars are drawn where they were put)
    const alpha = this.acc / FIXED;
    for (const c of this.cars) c.physics.interpolate(c.remote ? 1 : alpha);
    if (this.net) this.netSend(dt);

    const p = this.player.physics;
    // the tank slowly tops itself up out here: no pickups to hunt
    p.addNitro(dt * 0.018);
    for (const c of this.cars) {
      if (c.driver) c.physics.addNitro(dt * 0.03);
      if (c.remote && !c.visual.root.visible) {
        c.physics.events.length = 0;
        continue;
      }
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
    this.crash.update(dt, this.cars, camera.position);
    this.world.particles.update(dt);

    // camera
    const cockpit = !this.spectate && this.intro <= 0 && this.chase.inCockpit ? this.cockpit : null;
    if (this.spectate) this.updateOrbitCamera(camera, dt);
    else if (this.intro > 0) this.updateIntroCamera(camera, t);
    else if (cockpit) this.updateCockpit(cockpit, camera, dt, t);
    else this.chase.update(camera, p, dt, t);
    renderer.setOverlay(cockpit ? cockpit.scene : null);
    this.world.decor.update(dt, camera.position);
    this.world.view.update(dt, this.time, camera.position, p.pos);
    this.updateHeadlights();
    this.world.sky.update(t, camera.position, 20, p.pos);
    cockpit?.renderMirror(renderer.gl, this.world.scene);

    if (this.spectate) {
      renderer.setSpeedFx(0, 0);
      return;
    }
    if (audio.ctx && !audio.hasVoice('player')) this.startAudio();
    const speedK = Math.max(0, (p.speed - 45) / 50);
    renderer.setSpeedFx(this.intro > 0 ? 0 : Math.min(1.2, speedK * 0.6 + p.boostFx * 0.9), p.boostFx * 0.5);
    this.updateAudio(dt, camera);
    this.updateTags(camera);
    this.boardTimer -= dt;
    if (this.boardTimer <= 0) {
      this.boardTimer = 0.5;
      this.updateBoard();
    }
    this.hud.setDamage(this.player.damage);
    this.hud.updateZone(
      {
        speedKmh: p.speed * 3.6,
        gear: p.gear,
        nitro: p.nitro,
        nitroActive: p.nitroActive,
        drift: p.drifting ? Math.min(1, p.driftTime / 3.2) : 0,
        dots: this.cars.filter((c) => !c.remote || c.visual.root.visible).map((c) => ({ x: c.physics.pos.x, z: c.physics.pos.z, color: c.color, player: c.isPlayer })),
        heading: Math.atan2(p.fwd.x, p.fwd.z),
      },
      this.score,
      dt,
    );
    this.input.setNitro(p.nitro, p.nitroActive);
  }

  private updateCockpit(cockpit: Cockpit, camera: PerspectiveCamera, dt: number, t: number) {
    const p = this.player.physics;
    const body = this.player.visual.body;
    cockpit.follow(body);
    this.chase.updateCockpit(camera, p, body, cockpit.eye, dt, t);
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
      parked: this.spectate || this.inputLocked ? 1 : 0,
    });
  }

  /** Behind the lobby: a slow circle around my parked car. */
  private updateOrbitCamera(cam: PerspectiveCamera, dt: number) {
    this.orbit += dt * 0.12;
    const p = this.player.physics.pos;
    const r = 16;
    const want = TMP.set(p.x + Math.sin(this.orbit) * r, p.y + 5.5, p.z + Math.cos(this.orbit) * r);
    cam.position.lerp(want, 1 - Math.exp(-2 * dt));
    cam.up.set(0, 1, 0);
    cam.lookAt(TMP2.copy(p).setY(p.y + 1));
    if (cam.fov !== 55) {
      cam.fov = 55;
      cam.updateProjectionMatrix();
    }
  }

  private updateTags(camera: PerspectiveCamera) {
    if (!this.tags) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const c of this.cars) {
      if (!c.tag) continue;
      const v = c.visual.root;
      const q = TMP.copy(c.physics.up).multiplyScalar(2.1).add(v.position);
      const dist = q.distanceTo(camera.position);
      q.project(camera);
      const show = v.visible && this.intro <= 0 && q.z < 1 && dist < 180 && Math.abs(q.x) < 1.1 && Math.abs(q.y) < 1.1;
      c.tag.style.opacity = show ? String(Math.max(0, Math.min(1, (180 - dist) / 60))) : '0';
      if (!show) continue;
      // a friend mid-combo shows it over their car
      const live = c.live > 0 ? `×${c.liveMult} ${formatScore(c.live)}` : '';
      const em = c.tag.querySelector('em')!;
      if (em.textContent !== live) em.textContent = live;
      const sc = Math.max(0.6, Math.min(1, 30 / dist + 0.45));
      c.tag.style.zIndex = String(1000 - Math.round(dist));
      c.tag.style.transform = `translate(${((q.x + 1) / 2) * w}px, ${((1 - q.y) / 2) * h}px) translate(-50%, -100%) scale(${sc.toFixed(3)})`;
    }
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
          this.net?.room.sendEvent({ k: 'bank', s: e.score });
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
      if (e.type === 'impact' || e.type === 'respawn') this.crash.event(c, e);
      if (e.type === 'impact') continue;
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

  /** The player's car was totaled: say so on the HUD. */
  private onPlayerCrash(r: ImpactResult) {
    if (r.totaled) this.hud.message('DESTRUÍDO!', 2.4, 'big');
  }

  private collide() {
    const contacts = collideCars(this.activeList, this.contacts);
    this.crash.contacts(contacts, (p) => this.cars.find((c) => c.physics === p));
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
      const gain = dist > 140 || !c.visual.root.visible ? 0 : 0.8 / (1 + (dist / 12) ** 2);
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
    const ease = 1 - Math.exp(-9 * dt);
    this.cars.forEach((c, i) => {
      poseCar(c.physics, c.visual, c.lastInput.brake, dt, this.fxTime + i * 3.1);
      sagBody(c);
      if (!c.remote) return;
      c.netOffset.multiplyScalar(1 - ease);
      c.netQuat.slerp(IDENTITY, ease);
      c.visual.root.position.add(c.netOffset);
      c.visual.root.quaternion.premultiply(c.netQuat);
    });
  }

  dispose() {
    this.score.flush();
    const room = this.net?.room;
    if (room) {
      if (room.onState) room.onState = null;
      if (room.onEvent) room.onEvent = null;
    }
    this.tags?.remove();
    this.crash.dispose();
    this.hud.setZoneBoard(null);
    this.cockpit.dispose();
    this.world.beams.visible = false;
    this.world.sky.resetDay();
    for (const c of this.cars) {
      if (c.voice && !c.isPlayer) audio.stopVoice(c.voice);
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
const TQ = new Quaternion();
const NRM = new Vector3();
const BEAM = new Matrix4();
const BEAMC = new Color();
const TQ2 = new Quaternion();
