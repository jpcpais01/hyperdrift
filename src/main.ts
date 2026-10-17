import '@fontsource-variable/saira/standard.css';
import '@fontsource-variable/saira/standard-italic.css';
import '@fontsource-variable/inter/wght.css';
import './style.css';
import { randomBuild, sanitizeBuild, type CarBuild } from './car/parts';
import { audio, type MixChannel } from './core/audio';
import { canLockLandscape, installFirstTouch, isIOS, isPhone, isPortrait, isStandalone, isTouch } from './core/fullscreen';
import { Input } from './core/input';
import { cameraOrbit } from './game/cameraOrbit';
import { tiltSupported } from './core/tilt';
import { RENDER_SCALES, Renderer, renderScaleLabel } from './core/renderer';
import { applyPendingUpdate, initUpdater } from './core/updater';
import { CAMERA_ZOOM_LABELS, type CameraZoom } from './game/chaseCamera';
import { Race, RaceWorld, type NetGridEntry, type RaceMode, type RacePayload } from './game/race';
import { codeFromUrl, MAX_PLAYERS, randomCallSign, type SessionInfo } from './net/protocol';
import { Room, RoomRejected, type RoomCloseReason } from './net/room';
import { BroadcastTransport, PeerTransport, TransportFailure, type Transport } from './net/transport';
import { MultiplayerScreen } from './ui/multiplayer';
import { storage } from './storage';
import { FpsCounter } from './ui/fps';
import { Hud } from './ui/hud';
import { ControlsPanel, GarageScreen, MenuScreen, PauseScreen, ResultsScreen } from './ui/screens';
import { nav } from './ui/nav';
import { computeStats, displayStats } from './car/stats';
import { GarageScene } from './world/garageScene';
import { Sky } from './world/sky';
import { FreeRoam, ZoneWorld, type ZonePayload } from './zone/freeRoam';
import { CrashSystem } from './game/crash';
import { DAMAGE_MODES } from './car/damage';

type State = 'menu' | 'garage' | 'race' | 'results' | 'mp' | 'zone';

const CLOSE_MESSAGES: Record<RoomCloseReason, string> = {
  left: '',
  'host-left': 'O anfitrião fechou a sala.',
  lost: 'Perdeu-se a ligação à sala.',
  full: 'Essa sala já está cheia (4 pilotos).',
  version: 'Essa sala usa outra versão do jogo. Atualiza com ↻ no menu.',
};

/** ?lan: rooms between tabs of this browser instead of over the internet */
const LAN = new URLSearchParams(location.search).has('lan');
const transport = (): Transport => (LAN ? new BroadcastTransport() : new PeerTransport());

const AI_GRID = [
  { name: 'VEX', seed: 11, skill: 0.93 },
  { name: 'NOVA', seed: 42, skill: 0.96 },
  { name: 'ROOK', seed: 97, skill: 0.985 },
];

class App {
  private renderer: Renderer;
  private sky = new Sky();
  private world: RaceWorld;
  private garageScene: GarageScene;
  private input: Input;
  private hud: Hud;
  private menu: MenuScreen;
  private garage: GarageScreen;
  private results: ResultsScreen;
  private pause: PauseScreen;
  private controls: ControlsPanel | null = null;
  private rotate: HTMLElement;
  private state: State = 'menu';
  private race: Race | null = null;
  private raceMode: RaceMode = 'race';
  /** the drift zone: built on the first visit, then kept */
  private zoneWorld: ZoneWorld | null = null;
  private zone: FreeRoam | null = null;
  private zoneSeq = -1;
  private build: CarBuild;
  private settings = storage.loadSettings();
  private last = performance.now();
  private time = 0;
  private fps = new FpsCounter();
  private mp: MultiplayerScreen;
  private room: Room | null = null;
  private callSign = storage.loadCallSign() ?? randomCallSign();
  private resultsTimer = 0;
  private resultsKey = '';

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const ui = document.getElementById('ui')!;
    this.renderer = new Renderer(canvas);
    this.renderer.setRenderScale(this.settings.resolution);
    this.sky.bakeEnvironment(this.renderer.gl);
    this.sky.enableShadows(this.renderer.gl);
    this.world = new RaceWorld(this.sky);
    this.garageScene = new GarageScene(this.sky);
    this.build = storage.loadBuild();
    this.garageScene.setBuild(this.build);
    this.garageScene.bindDrag(canvas);
    cameraOrbit.bind(canvas);

    this.hud = new Hud(ui);
    this.input = new Input(ui);
    // gyroscope steering is a phone thing: only offered on touch devices with the sensor API
    const canTilt = isTouch() && tiltSupported();
    const controlsLabel = () => (this.settings.controls === 'tilt' ? 'CONTROLOS: INCLINAÇÃO' : 'CONTROLOS: BOTÕES');
    const resLabel = () => `RESOLUÇÃO: ${renderScaleLabel(this.settings.resolution)}`;
    const damageLabel = () => `DANOS: ${{ full: 'REALISTAS', visual: 'SÓ VISUAIS', off: 'DESLIGADOS' }[this.settings.damage]}`;
    CrashSystem.mode = this.settings.damage;
    audio.setMix(this.settings.volume);
    this.menu = new MenuScreen(ui, this.settings.muted, canTilt ? controlsLabel() : null, resLabel(), damageLabel());
    this.menu.onDamage = () => {
      const i = DAMAGE_MODES.indexOf(this.settings.damage);
      this.settings.damage = DAMAGE_MODES[(i + 1) % DAMAGE_MODES.length];
      CrashSystem.mode = this.settings.damage;
      storage.saveSettings(this.settings);
      return damageLabel();
    };
    this.garage = new GarageScreen(ui);
    this.results = new ResultsScreen(ui);
    this.pause = new PauseScreen(ui, canTilt, resLabel(), this.settings.muted);
    this.mp = new MultiplayerScreen(ui, this.callSign);
    storage.saveCallSign(this.callSign);
    const cycleResolution = () => {
      const i = RENDER_SCALES.indexOf(this.settings.resolution);
      this.settings.resolution = RENDER_SCALES[(i + 1) % RENDER_SCALES.length];
      storage.saveSettings(this.settings);
      this.renderer.setRenderScale(this.settings.resolution);
      this.menu.setResolutionLabel(resLabel());
      this.pause.setResolutionLabel(resLabel());
      return resLabel();
    };
    this.menu.onResolution = cycleResolution;
    this.pause.onResolution = cycleResolution;
    if (canTilt) {
      const tilt = this.input.tilt;
      tilt.sens = this.settings.tiltSens;
      tilt.center = this.settings.tiltCenter;
      this.input.onRecenter = (c) => {
        this.settings.tiltCenter = c;
        storage.saveSettings(this.settings);
      };
      const panel = new ControlsPanel(ui, this.input, this.settings);
      panel.onChange = () => {
        storage.saveSettings(this.settings);
        this.menu.setControlsLabel(controlsLabel());
      };
      panel.onClose = () => {
        if ((this.state === 'race' && this.race?.paused) || (this.state === 'zone' && this.zone && (this.zone.paused || this.zone.inputLocked))) this.pause.show(true);
      };
      this.menu.onControls = () => panel.show(true);
      this.pause.onControls = () => {
        this.pause.show(false);
        panel.show(true);
      };
      this.controls = panel;
      if (this.settings.controls === 'tilt') {
        this.input.setMode('tilt');
        // iOS forgets sensor permission between visits: ask again on the first tap
        if (tilt.needsGesture) {
          const ask = () => {
            window.removeEventListener('click', ask, true);
            void tilt.request().then((ok) => {
              if (!ok) {
                this.settings.controls = 'buttons';
                this.input.setMode('buttons');
                storage.saveSettings(this.settings);
                this.menu.setControlsLabel(controlsLabel());
              }
            });
          };
          window.addEventListener('click', ask, true);
        }
      }
    }
    this.rotate = document.createElement('div');
    this.rotate.className = 'rotate-hint hidden';
    // iPhone Safari can't go fullscreen from a web page: point to the home-screen app instead
    const iosTip =
      isIOS() && !isStandalone()
        ? '<p class="rh-tip">Para ecrã inteiro: toca em <b>Partilhar</b> e depois <b>Adicionar ao ecrã principal</b>.</p>'
        : canLockLandscape()
          ? '<p class="rh-tap">Toca no ecrã para rodar e jogar em ecrã inteiro</p>'
          : '';
    this.rotate.innerHTML =
      '<div class="rh-card"><div class="rh-phone"><div class="rh-screen"><span></span></div></div>' +
      '<h3>RODA O TELEMÓVEL</h3><p>O Hyperdrift joga-se na horizontal.</p>' +
      iosTip +
      '</div>';
    ui.appendChild(this.rotate);

    audio.setMuted(this.settings.muted);
    installFirstTouch(() => audio.unlock());
    window.addEventListener('pointerdown', () => audio.unlock());

    this.menu.onRace = () => this.startRace('race');
    this.menu.onTimeTrial = () => this.startRace('timetrial');
    this.menu.onGarage = () => this.go('garage');
    this.menu.onZone = () => this.startZone();
    this.menu.onOnline = () => this.go('mp');
    this.bindMultiplayer();
    const toggleSound = () => {
      this.settings.muted = !this.settings.muted;
      audio.setMuted(this.settings.muted);
      storage.saveSettings(this.settings);
      this.menu.setMuted(this.settings.muted);
      this.pause.setMuted(this.settings.muted);
      return this.settings.muted;
    };
    this.menu.onToggleSound = toggleSound;
    this.pause.onToggleSound = toggleSound;
    let volSave = 0;
    const setVolume = (ch: MixChannel, v: number) => {
      this.settings.volume[ch] = v;
      audio.setMix({ [ch]: v });
      this.menu.volume.set(audio.mix);
      this.pause.volume.set(audio.mix);
      // dragging a bar fires a lot: write once it settles
      clearTimeout(volSave);
      volSave = window.setTimeout(() => storage.saveSettings(this.settings), 250);
    };
    this.menu.onVolume = setVolume;
    this.pause.onVolume = setVolume;
    // paused races are silent; with the sound panel up the engines idle so the bars can be heard
    this.pause.onSoundPanel = (open) => {
      const live = this.state === 'zone' ? this.zone : this.race;
      if (!audio.ctx || !live || !live.paused) return;
      if (open) void audio.ctx.resume();
      else void audio.ctx.suspend();
    };
    this.garage.onChange = (b, slot) => {
      this.build = b;
      storage.saveBuild(b);
      this.room?.setProfile(this.callSign, b);
      this.garageScene.setBuild(b);
      this.garageScene.preview(b, slot);
    };
    this.garage.onView = (interior, slot) => this.garageScene.setView(interior, slot);
    this.garage.onBack = () => this.go(this.room ? 'mp' : 'menu');
    this.garage.onRace = () => (this.room ? this.go('mp') : this.startRace(this.raceMode === 'attract' ? 'race' : this.raceMode));
    this.results.onAgain = () => (this.room ? this.go('mp') : this.startRace(this.raceMode));
    this.results.onGarage = () => this.go('garage');
    this.results.onMenu = () => (this.room ? this.leaveRoom() : this.go('menu'));
    const togglePause = () => {
      if (this.state === 'zone' && this.zone) return this.setPaused(!(this.zone.paused || this.zone.inputLocked));
      if (this.state !== 'race' || !this.race) return;
      this.setPaused(!this.race.paused);
    };
    this.input.onPause = togglePause;
    nav.onStart = togglePause;
    const cycleCamera = () => {
      const live = this.state === 'zone' ? this.zone : this.state === 'race' ? this.race : null;
      if (!live || live.paused) return;
      this.settings.camZoom = ((this.settings.camZoom + 1) % 4) as CameraZoom;
      storage.saveSettings(this.settings);
      live.setCameraZoom(this.settings.camZoom);
      this.hud.setCameraZoom(this.settings.camZoom, `CÂMARA · ${CAMERA_ZOOM_LABELS[this.settings.camZoom]}`);
    };
    this.input.onCamera = cycleCamera;
    this.hud.onCamera = cycleCamera;
    this.hud.onPause = togglePause;
    this.pause.onResume = () => this.setPaused(false);
    this.pause.onTime = (h, run) => {
      this.zone?.setClock(h, run);
      if (this.zone) this.pause.setTime(this.zone.clock);
    };
    this.pause.onRestart = () => {
      if (this.state !== 'zone' || !this.zone) return this.startRace(this.raceMode);
      this.zone.restart();
      this.setPaused(false);
    };
    this.pause.onQuit = () => (this.race?.net || this.zone?.net ? this.go('mp') : this.go('menu'));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      if (this.state === 'race' && this.race && !this.race.paused) this.setPaused(true);
      if (this.state === 'zone' && this.zone && !this.zone.paused && !this.zone.inputLocked) this.setPaused(true);
    });

    nav.init();
    this.go('menu');
    // invite links: /?sala=1234 opens the room straight away
    const invite = codeFromUrl(location.search);
    if (invite) {
      history.replaceState(null, '', location.pathname + (LAN ? '?lan' : ''));
      this.menu.skipTitle();
      this.go('mp');
      this.mp.prefill(invite);
      void this.joinRoom(invite);
    }
    document.body.classList.add('ready');
    requestAnimationFrame(this.frame);
  }

  private setPaused(p: boolean) {
    const live = this.state === 'zone' ? this.zone : this.race;
    if (!live) return;
    if (live.net) {
      // online the game goes on: the menu just takes my hands off the wheel
      live.inputLocked = p;
      this.pause.show(p);
      if (!p) this.controls?.show(false);
      this.input.clear();
      return;
    }
    live.paused = p;
    this.pause.show(p);
    if (!p) this.controls?.show(false);
    this.input.clear();
    if (audio.ctx) {
      if (p) void audio.ctx.suspend();
      else void audio.ctx.resume();
    }
  }

  private endRace() {
    if (this.race) {
      this.race.dispose();
      this.race = null;
    }
    if (this.zone) {
      this.zone.dispose();
      this.zone = null;
      this.zoneSeq = -1;
    }
    if (audio.ctx && audio.ctx.state === 'suspended') void audio.ctx.resume();
  }

  /** true when reloading the page would not interrupt a race */
  atRest() {
    return this.state === 'menu' || this.state === 'garage';
  }

  private go(state: State) {
    this.renderer.setOverlay(null);
    // the menu and the lobby share a live backdrop; an online race keeps running behind the lobby
    const keepZone = !!this.zone?.net && state === 'mp' && !!this.room;
    const keep =
      keepZone ||
      (this.race && ((state === 'menu' && this.race.mode === 'attract') || (state === 'mp' && (this.race.mode === 'attract' || (!!this.race.net && !!this.room)))));
    if (keepZone) this.zone!.setSpectate(true);
    else if (keep) this.race!.setSpectate(true);
    else this.endRace();
    this.garageScene.stopPreview();
    this.state = state;
    if (state === 'menu') this.menu.setInfo(storage.loadRecords().bestLap, displayStats(computeStats(this.build)), storage.loadBestDrift());
    this.menu.show(state === 'menu');
    this.mp.show(state === 'mp');
    if (state === 'mp') this.mp.renderLobby(this.liveOnline());
    if (this.atRest()) applyPendingUpdate();
    this.garage.show(state === 'garage', this.build);
    this.garageScene.setActive(state === 'garage');
    this.results.show(null);
    this.pause.show(false);
    this.controls?.show(false);
    this.input.setTouchVisible(false);
    if ((state === 'menu' || state === 'mp') && !keep) {
      // the menu backdrop is a live AI race
      this.world.attach();
      this.renderer.setScene(this.world.scene);
      this.race = new Race(this.world, 'attract', null, null, null);
    } else if (state === 'garage') {
      this.sky.addTo(this.garageScene.scene);
      this.garageScene.scene.fog = null;
      this.renderer.setScene(this.garageScene.scene);
      this.renderer.setSpeedFx(0, 0);
    }
  }

  /** What of mine is still going on behind the lobby. */
  private liveOnline(): 'race' | 'zone' | null {
    return this.race?.net ? 'race' : this.zone?.net ? 'zone' : null;
  }

  private hideScreens() {
    this.garageScene.stopPreview();
    this.menu.show(false);
    this.mp.show(false);
    this.garage.show(false);
    this.garageScene.setActive(false);
    this.results.show(null);
    this.pause.show(false);
    this.controls?.show(false);
    this.input.clear();
    this.input.setTouchVisible(isTouch());
  }

  /** The drift zone: on my own, or the room's (session) with everybody in it. */
  private startZone(session: SessionInfo | null = null) {
    this.endRace();
    this.renderer.setOverlay(null);
    this.hideScreens();
    this.state = 'zone';
    if (!this.zoneWorld) this.zoneWorld = new ZoneWorld(this.sky);
    this.zoneWorld.attach();
    this.renderer.setScene(this.zoneWorld.scene);
    const net = session && this.room ? { room: this.room, residents: !!(session.payload as ZonePayload | null)?.residents } : null;
    this.pause.setOnline(!!net, true);
    const zone = new FreeRoam(this.zoneWorld, this.build, this.input, this.hud, storage.loadBestDrift(), net);
    zone.onBest = (b) => storage.saveBestDrift(b);
    this.pause.setTime(zone.clock);
    zone.setCameraZoom(this.settings.camZoom, true);
    this.hud.setCameraZoom(this.settings.camZoom);
    this.zone = zone;
    this.zoneSeq = session?.seq ?? -1;
  }

  private startRace(mode: RaceMode, session: SessionInfo | null = null) {
    this.endRace();
    this.renderer.setOverlay(null);
    this.garageScene.stopPreview();
    this.raceMode = mode;
    this.state = 'race';
    this.menu.show(false);
    this.mp.show(false);
    this.garage.show(false);
    this.garageScene.setActive(false);
    this.results.show(null);
    this.pause.show(false);
    this.controls?.show(false);
    this.input.clear();
    this.input.setTouchVisible(isTouch());
    this.world.attach();
    this.renderer.setScene(this.world.scene);
    const ghost = mode === 'timetrial' ? storage.loadGhost() : null;
    const net = session && this.room ? { room: this.room, grid: (session.payload as RacePayload).grid, startAt: this.room.toLocal(session.at) } : null;
    this.pause.setOnline(!!net);
    this.pause.setTime(null);
    const race = new Race(this.world, mode, this.build, this.input, this.hud, ghost, net);
    race.setCameraZoom(this.settings.camZoom, true);
    this.hud.setCameraZoom(this.settings.camZoom);
    race.onFinish = (r) => {
      if (race.net) {
        this.input.setTouchVisible(false);
        this.resultsKey = '';
        this.showResults();
        this.state = 'results';
        return;
      }
      const g = race.bestGhost;
      if (g) storage.saveGhost(g);
      const rec = storage.loadRecords();
      if (r.bestLap !== null && (rec.bestLap === null || r.bestLap < rec.bestLap)) rec.bestLap = r.bestLap;
      storage.saveRecords(rec);
      this.input.setTouchVisible(false);
      this.results.show(r);
      this.state = 'results';
    };
    this.race = race;
  }

  // ---------------------------------------------------------- online

  private bindMultiplayer() {
    const mp = this.mp;
    mp.onBack = () => this.go('menu');
    mp.onReroll = () => {
      this.callSign = randomCallSign(this.callSign);
      storage.saveCallSign(this.callSign);
      mp.setName(this.callSign);
    };
    mp.onCreate = () => void this.createRoom();
    mp.onJoin = (code) => void this.joinRoom(code);
    mp.onLeave = () => this.leaveRoom();
    mp.onGarage = () => this.go('garage');
    mp.onBots = (v) => this.room?.setSettings({ bots: v });
    mp.onResume = () => {
      if (this.zone?.net) {
        this.mp.show(false);
        this.zone.setSpectate(false);
        this.zone.inputLocked = false;
        this.state = 'zone';
        this.input.setTouchVisible(isTouch());
        return;
      }
      if (!this.race?.net) return;
      this.mp.show(false);
      this.race.setSpectate(false);
      this.race.inputLocked = false;
      this.state = this.race.playerCar?.finished ? 'results' : 'race';
      if (this.state === 'results') {
        this.resultsKey = '';
        this.showResults();
      } else this.input.setTouchVisible(isTouch());
    };
    mp.onStart = () => this.hostStart();
    mp.onZone = () => {
      const room = this.room;
      // a drop-in session: whoever joins the room later lands straight in the zone
      if (room?.isHost) room.startSession('zone', { residents: room.settings.bots } satisfies ZonePayload, 600, true);
    };
    mp.onEnterZone = () => {
      const s = this.room?.session;
      if (s?.kind === 'zone') this.startZone(s);
    };
  }

  private async createRoom() {
    this.mp.setBusy('A criar sala…');
    try {
      this.attachRoom(await Room.create(transport(), this.callSign, this.build));
    } catch (e) {
      this.mp.notice(this.failMessage(e));
    } finally {
      this.mp.setBusy(null);
    }
  }

  private async joinRoom(code: string) {
    if (this.room) return;
    this.mp.setBusy(`A entrar na sala ${code}…`);
    try {
      this.attachRoom(await Room.join(transport(), code, this.callSign, this.build));
    } catch (e) {
      this.mp.error(this.failMessage(e));
    } finally {
      this.mp.setBusy(null);
    }
  }

  private failMessage(e: unknown): string {
    if (e instanceof RoomRejected) return CLOSE_MESSAGES[e.reason];
    if (e instanceof TransportFailure) {
      if (e.kind === 'not-found') return 'Não há nenhuma sala com esse código.';
      if (e.kind === 'unsupported') return 'Este browser não suporta jogo online.';
      if (e.kind === 'taken') return 'Não foi possível criar a sala. Tenta outra vez.';
    }
    return 'Sem ligação ao servidor de salas. Verifica a internet.';
  }

  private attachRoom(room: Room) {
    this.room = room;
    room.onRoster = () => {
      if (this.state === 'mp') this.mp.renderLobby(this.liveOnline());
      this.zone?.syncRoster();
      const race = this.race;
      if (race?.net) for (const c of race.cars) if (!c.isPlayer && c.human && !room.players.some((p) => p.id === c.id)) race.dropCar(c.id);
      // my name may have been made unique by the host
      const me = room.me;
      if (me && me.name !== this.callSign && !room.isHost) this.mp.setName(me.name);
    };
    room.onSession = (s) => {
      if (s.kind === 'zone') {
        if (this.zone?.net && this.zoneSeq === s.seq) return;
        this.startZone(s);
        return;
      }
      if (s.kind !== 'race') return;
      const grid = this.validGrid(s.payload);
      if (!grid || !grid.some((g) => g.id === room.myId)) return;
      s.payload = { grid } satisfies RacePayload;
      this.startRace('race', s);
    };
    room.onClose = (reason) => {
      this.room = null;
      this.mp.setRoom(null);
      this.mp.setName(this.callSign);
      if (this.race?.net || this.zone?.net) this.endRace();
      if (reason !== 'left') {
        this.go('mp');
        this.mp.setView('home');
        this.mp.notice(CLOSE_MESSAGES[reason]);
      }
    };
    this.mp.setRoom(room);
    // joined while the room is out in the drift zone: straight in
    if (room.session?.open && room.session.kind === 'zone') this.startZone(room.session);
  }

  private validGrid(payload: unknown): NetGridEntry[] | null {
    const g = (payload as RacePayload | null)?.grid;
    if (!Array.isArray(g) || g.length < 1 || g.length > MAX_PLAYERS) return null;
    return g.map((e, i) => ({
      id: String(e.id),
      name: String(e.name ?? '').slice(0, 16),
      build: sanitizeBuild(e.build),
      ai: !!e.ai,
      skill: Math.max(0.8, Math.min(1, Number(e.skill) || 0.95)),
      seed: Number(e.seed) || i + 1,
    }));
  }

  /** Host: AI rivals at the front (if wanted), the people behind them, then everybody gets the countdown. */
  private hostStart() {
    const room = this.room;
    if (!room?.isHost) return;
    const humans: NetGridEntry[] = room.players.map((p, i) => ({ id: p.id, name: p.name, build: p.build, ai: false, skill: 1, seed: 200 + i }));
    const bots: NetGridEntry[] = [];
    if (room.settings.bots) {
      const n = MAX_PLAYERS - humans.length;
      for (let i = 0; i < n; i++) {
        const a = AI_GRID[i];
        // a fresh car for every race keeps the field interesting
        const seed = a.seed + Math.floor(Math.random() * 1000);
        bots.push({ id: `ai${i}`, name: a.name, build: randomBuild(seed), ai: true, skill: a.skill, seed: a.seed });
      }
    }
    room.startSession('race', { grid: [...bots, ...humans] } satisfies RacePayload, 4200);
  }

  private leaveRoom() {
    const room = this.room;
    this.room = null;
    this.mp.setRoom(null);
    this.mp.setName(this.callSign);
    room?.leave();
    this.go('menu');
  }

  private showResults() {
    if (!this.race) return;
    const r = this.race.result();
    const key = JSON.stringify(r.entries);
    if (key === this.resultsKey) return;
    this.resultsKey = key;
    this.results.show(r);
  }

  private frame = (now: number) => {
    nav.inRace = this.state === 'race';
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;

    // phones always play sideways; tablets only need it for the race itself
    const needRotate = isTouch() && isPortrait() && (isPhone() || this.state === 'race' || this.state === 'results' || this.state === 'zone');
    this.rotate.classList.toggle('hidden', !needRotate);

    if (this.state === 'garage') {
      const panel = window.innerWidth > 900 ? 1.7 : 2.0;
      this.garageScene.update(dt, this.time, this.renderer.camera, this.sky, isPortrait() ? 0 : panel);
      this.renderer.setOverlay(this.garageScene.overlay);
      this.garageScene.renderMirror(this.renderer.gl);
    } else if (this.zone) {
      this.zone.update(needRotate && !this.zone.net ? 0 : dt, this.renderer);
      // the time of day keeps moving (and the host can move it) while the pause menu is up
      if (!this.pause.el.classList.contains('hidden')) this.pause.setTime(this.zone.clock);
    } else if (this.race) {
      // an online race can't wait for anybody to turn their phone
      this.race.update(needRotate && !this.race.net ? 0 : dt, this.renderer);
      if (this.state === 'results' && this.race.net) {
        this.resultsTimer -= dt;
        if (this.resultsTimer <= 0) {
          this.resultsTimer = 0.4;
          this.showResults();
        }
      }
    }
    this.renderer.render(dt);
    this.fps.tick(now);
    requestAnimationFrame(this.frame);
  };
}

const app = new App();
if (import.meta.env.DEV || LAN) (window as unknown as { app: App }).app = app;
initUpdater({ canReload: () => app.atRest() });
