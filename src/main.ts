import './style.css';
import { registerSW } from 'virtual:pwa-register';
import type { CarBuild } from './car/parts';
import { audio } from './core/audio';
import { installFirstTouch, isPortrait, isTouch } from './core/fullscreen';
import { Input } from './core/input';
import { Renderer } from './core/renderer';
import { Race, RaceWorld, type RaceMode } from './game/race';
import { storage } from './storage';
import { Hud } from './ui/hud';
import { GarageScreen, MenuScreen, PauseScreen, ResultsScreen } from './ui/screens';
import { GarageScene } from './world/garageScene';
import { Sky } from './world/sky';

type State = 'menu' | 'garage' | 'race' | 'results';

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
  private rotate: HTMLElement;
  private state: State = 'menu';
  private race: Race | null = null;
  private raceMode: RaceMode = 'race';
  private build: CarBuild;
  private settings = storage.loadSettings();
  private last = performance.now();
  private time = 0;

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const ui = document.getElementById('ui')!;
    this.renderer = new Renderer(canvas);
    this.sky.bakeEnvironment(this.renderer.gl);
    this.world = new RaceWorld(this.sky);
    this.garageScene = new GarageScene(this.sky);
    this.build = storage.loadBuild();
    this.garageScene.setBuild(this.build);
    this.garageScene.bindDrag(canvas);

    this.hud = new Hud(ui);
    this.input = new Input(ui);
    this.menu = new MenuScreen(ui, this.settings.muted);
    this.garage = new GarageScreen(ui);
    this.results = new ResultsScreen(ui);
    this.pause = new PauseScreen(ui);
    this.rotate = document.createElement('div');
    this.rotate.className = 'rotate-hint hidden';
    this.rotate.innerHTML = '<div><div class="phone"></div><p>Roda o telemóvel para jogar na horizontal</p></div>';
    ui.appendChild(this.rotate);

    audio.setMuted(this.settings.muted);
    installFirstTouch(() => audio.unlock());
    window.addEventListener('pointerdown', () => audio.unlock());

    this.menu.onRace = () => this.startRace('race');
    this.menu.onTimeTrial = () => this.startRace('timetrial');
    this.menu.onGarage = () => this.go('garage');
    this.menu.onToggleSound = () => {
      this.settings.muted = !this.settings.muted;
      audio.setMuted(this.settings.muted);
      storage.saveSettings(this.settings);
      return this.settings.muted;
    };
    this.garage.onChange = (b) => {
      this.build = b;
      storage.saveBuild(b);
      this.garageScene.setBuild(b);
    };
    this.garage.onBack = () => this.go('menu');
    this.garage.onRace = () => this.startRace(this.raceMode === 'attract' ? 'race' : this.raceMode);
    this.results.onAgain = () => this.startRace(this.raceMode);
    this.results.onGarage = () => this.go('garage');
    this.results.onMenu = () => this.go('menu');
    const togglePause = () => {
      if (this.state !== 'race' || !this.race) return;
      this.setPaused(!this.race.paused);
    };
    this.input.onPause = togglePause;
    this.hud.onPause = togglePause;
    this.pause.onResume = () => this.setPaused(false);
    this.pause.onRestart = () => this.startRace(this.raceMode);
    this.pause.onQuit = () => this.go('menu');
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'race' && this.race && !this.race.paused) this.setPaused(true);
    });

    this.go('menu');
    document.body.classList.add('ready');
    requestAnimationFrame(this.frame);
  }

  private setPaused(p: boolean) {
    if (!this.race) return;
    this.race.paused = p;
    this.pause.show(p);
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
    if (audio.ctx && audio.ctx.state === 'suspended') void audio.ctx.resume();
  }

  private go(state: State) {
    this.endRace();
    this.state = state;
    this.menu.show(state === 'menu');
    this.garage.show(state === 'garage', this.build);
    this.results.show(null);
    this.pause.show(false);
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
    this.raceMode = mode;
    this.state = 'race';
    this.menu.show(false);
    this.garage.show(false);
    this.results.show(null);
    this.pause.show(false);
    this.input.clear();
    this.input.setTouchVisible(isTouch());
    this.world.attach();
    this.renderer.setScene(this.world.scene);
    const ghost = mode === 'timetrial' ? storage.loadGhost() : null;
    const race = new Race(this.world, mode, this.build, this.input, this.hud, ghost);
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

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;

    const needRotate = isTouch() && isPortrait() && (this.state === 'race' || this.state === 'results');
    this.rotate.classList.toggle('hidden', !needRotate);

    if (this.state === 'garage') {
      const panel = window.innerWidth > 900 ? 1.7 : 2.0;
      this.garageScene.update(dt, this.time, this.renderer.camera, this.sky, isPortrait() ? 0 : panel);
    } else if (this.race) {
      this.race.update(needRotate ? 0 : dt, this.renderer);
    }
    this.renderer.render(dt);
    requestAnimationFrame(this.frame);
  };
}

registerSW({ immediate: true });
new App();
