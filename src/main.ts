import './style.css';
import type { CarBuild } from './car/parts';
import { audio } from './core/audio';
import { canLockLandscape, installFirstTouch, isIOS, isPhone, isPortrait, isStandalone, isTouch } from './core/fullscreen';
import { Input } from './core/input';
import { tiltSupported } from './core/tilt';
import { Renderer } from './core/renderer';
import { applyPendingUpdate, initUpdater } from './core/updater';
import { CAMERA_ZOOM_LABELS, type CameraZoom } from './game/chaseCamera';
import { Race, RaceWorld, type RaceMode } from './game/race';
import { storage } from './storage';
import { FpsCounter } from './ui/fps';
import { Hud } from './ui/hud';
import { ControlsPanel, GarageScreen, MenuScreen, PauseScreen, ResultsScreen } from './ui/screens';
import { GarageScene } from './world/garageScene';
import { Sky } from './world/sky';
import { FreeRoam, ZoneWorld } from './zone/freeRoam';

type State = 'menu' | 'garage' | 'race' | 'results' | 'zone';
/** what the garage's "Correr" button and "again" start */
type PlayMode = RaceMode | 'zone';

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
  private raceMode: PlayMode = 'race';
  /** the drift zone: built on the first visit, then kept */
  private zoneWorld: ZoneWorld | null = null;
  private zone: FreeRoam | null = null;
  private build: CarBuild;
  private settings = storage.loadSettings();
  private last = performance.now();
  private time = 0;
  private fps = new FpsCounter();

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const ui = document.getElementById('ui')!;
    this.renderer = new Renderer(canvas);
    this.sky.bakeEnvironment(this.renderer.gl);
    this.sky.enableShadows(this.renderer.gl);
    this.world = new RaceWorld(this.sky);
    this.garageScene = new GarageScene(this.sky);
    this.build = storage.loadBuild();
    this.garageScene.setBuild(this.build);
    this.garageScene.bindDrag(canvas);

    this.hud = new Hud(ui);
    this.input = new Input(ui);
    // gyroscope steering is a phone thing: only offered on touch devices with the sensor API
    const canTilt = isTouch() && tiltSupported();
    const controlsLabel = () => (this.settings.controls === 'tilt' ? 'CONTROLOS: INCLINAÇÃO' : 'CONTROLOS: BOTÕES');
    this.menu = new MenuScreen(ui, this.settings.muted, canTilt ? controlsLabel() : null);
    this.garage = new GarageScreen(ui);
    this.results = new ResultsScreen(ui);
    this.pause = new PauseScreen(ui, canTilt);
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
        if (this.session?.paused) this.pause.show(true);
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
    this.menu.onToggleSound = () => {
      this.settings.muted = !this.settings.muted;
      audio.setMuted(this.settings.muted);
      storage.saveSettings(this.settings);
      return this.settings.muted;
    };
    this.garage.onChange = (b, slot) => {
      this.build = b;
      storage.saveBuild(b);
      this.garageScene.setBuild(b);
      this.garageScene.preview(b, slot);
    };
    this.garage.onBack = () => this.go('menu');
    this.garage.onRace = () => this.play(this.raceMode === 'attract' ? 'race' : this.raceMode);
    this.results.onAgain = () => this.play(this.raceMode);
    this.results.onGarage = () => this.go('garage');
    this.results.onMenu = () => this.go('menu');
    const togglePause = () => {
      const s = this.session;
      if (s) this.setPaused(!s.paused);
    };
    this.input.onPause = togglePause;
    const cycleCamera = () => {
      const s = this.session;
      if (!s || s.paused) return;
      this.settings.camZoom = ((this.settings.camZoom + 1) % 3) as CameraZoom;
      storage.saveSettings(this.settings);
      s.setCameraZoom(this.settings.camZoom);
      this.hud.setCameraZoom(this.settings.camZoom, `CÂMARA · ${CAMERA_ZOOM_LABELS[this.settings.camZoom]}`);
    };
    this.input.onCamera = cycleCamera;
    this.hud.onCamera = cycleCamera;
    this.hud.onPause = togglePause;
    this.pause.onResume = () => this.setPaused(false);
    this.pause.onRestart = () => {
      if (this.state === 'zone' && this.zone) {
        // in free roam, "restart" just drops you back at the start
        this.zone.restart();
        this.setPaused(false);
      } else this.play(this.raceMode);
    };
    this.pause.onQuit = () => this.go('menu');
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.session && !this.session.paused) this.setPaused(true);
    });

    this.go('menu');
    document.body.classList.add('ready');
    requestAnimationFrame(this.frame);
  }

  /** The race or free roam the player is driving in right now (not the menu's attract race). */
  private get session(): Race | FreeRoam | null {
    if (this.state === 'race' && this.race) return this.race;
    if (this.state === 'zone' && this.zone) return this.zone;
    return null;
  }

  private play(mode: PlayMode) {
    if (mode === 'zone') this.startZone();
    else this.startRace(mode);
  }

  private setPaused(p: boolean) {
    const s = this.session;
    if (!s) return;
    s.paused = p;
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
    }
    if (audio.ctx && audio.ctx.state === 'suspended') void audio.ctx.resume();
  }

  /** true when reloading the page would not interrupt a race */
  atRest() {
    return this.state === 'menu' || this.state === 'garage';
  }

  private go(state: State) {
    this.endRace();
    this.garageScene.stopPreview();
    this.state = state;
    this.menu.show(state === 'menu');
    if (this.atRest()) applyPendingUpdate();
    this.garage.show(state === 'garage', this.build);
    this.garageScene.setActive(state === 'garage');
    this.results.show(null);
    this.pause.show(false);
    this.controls?.show(false);
    this.input.setTouchVisible(false);
    if (state === 'menu') {
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

  private startRace(mode: RaceMode) {
    this.endRace();
    this.garageScene.stopPreview();
    this.raceMode = mode;
    this.state = 'race';
    this.menu.show(false);
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
    const race = new Race(this.world, mode, this.build, this.input, this.hud, ghost);
    race.setCameraZoom(this.settings.camZoom, true);
    this.hud.setCameraZoom(this.settings.camZoom);
    race.onFinish = (r) => {
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

  private startZone() {
    this.endRace();
    this.garageScene.stopPreview();
    this.raceMode = 'zone';
    this.state = 'zone';
    this.menu.show(false);
    this.garage.show(false);
    this.garageScene.setActive(false);
    this.results.show(null);
    this.pause.show(false);
    this.controls?.show(false);
    this.input.clear();
    this.input.setTouchVisible(isTouch());
    if (!this.zoneWorld) this.zoneWorld = new ZoneWorld(this.sky);
    this.zoneWorld.attach();
    this.renderer.setScene(this.zoneWorld.scene);
    const zone = new FreeRoam(this.zoneWorld, this.build, this.input, this.hud, storage.loadBestDrift());
    zone.setCameraZoom(this.settings.camZoom, true);
    this.hud.setCameraZoom(this.settings.camZoom);
    zone.onBest = (best) => storage.saveBestDrift(best);
    this.zone = zone;
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;

    // phones always play sideways; tablets only need it for the race itself
    const needRotate = isTouch() && isPortrait() && (isPhone() || this.state === 'race' || this.state === 'results' || this.state === 'zone');
    this.rotate.classList.toggle('hidden', !needRotate);

    if (this.state === 'garage') {
      const panel = window.innerWidth > 900 ? 1.7 : 2.0;
      this.garageScene.update(dt, this.time, this.renderer.camera, this.sky, isPortrait() ? 0 : panel);
    } else if (this.zone) {
      this.zone.update(needRotate ? 0 : dt, this.renderer);
    } else if (this.race) {
      this.race.update(needRotate ? 0 : dt, this.renderer);
    }
    this.renderer.render(dt);
    this.fps.tick(now);
    requestAnimationFrame(this.frame);
  };
}

const app = new App();
initUpdater({ canReload: () => app.atRest() });
