import { sanitizeBuild, type CarBuild } from './car/parts';
import type { ControlMode } from './core/input';
import type { TiltSens } from './core/tilt';
import type { CameraZoom } from './game/chaseCamera';
import type { GhostLap } from './game/ghost';

export interface Settings {
  muted: boolean;
  camZoom: CameraZoom;
  /** Mobile steering: on-screen buttons or tilting the phone. */
  controls: ControlMode;
  tiltSens: TiltSens;
  /** Calibrated straight-ahead wheel angle, radians. */
  tiltCenter: number;
}

const KEY_BUILD = 'hyperdrift.build.v1';
const KEY_GHOST = 'hyperdrift.ghost.v1';
const KEY_SETTINGS = 'hyperdrift.settings.v1';
const KEY_RECORDS = 'hyperdrift.records.v1';
const KEY_ZONE = 'hyperdrift.zone.v1';

function get<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function set(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the game still works, it just forgets */
  }
}

export const storage = {
  loadBuild: (): CarBuild => sanitizeBuild(get<Partial<CarBuild>>(KEY_BUILD)),
  saveBuild: (b: CarBuild) => set(KEY_BUILD, b),
  loadGhost: (): GhostLap | null => {
    const g = get<GhostLap>(KEY_GHOST);
    if (!g || !Array.isArray(g.frames) || typeof g.time !== 'number') return null;
    return { ...g, build: sanitizeBuild(g.build) };
  },
  saveGhost: (g: GhostLap) => set(KEY_GHOST, g),
  loadSettings: (): Settings => {
    const s: Settings = {
      muted: false,
      camZoom: 1,
      controls: 'buttons',
      tiltSens: 1,
      tiltCenter: 0,
      ...(get<Partial<Settings>>(KEY_SETTINGS) ?? {}),
    };
    if (s.camZoom !== 0 && s.camZoom !== 1 && s.camZoom !== 2) s.camZoom = 1;
    if (s.controls !== 'buttons' && s.controls !== 'tilt') s.controls = 'buttons';
    if (s.tiltSens !== 0 && s.tiltSens !== 1 && s.tiltSens !== 2) s.tiltSens = 1;
    if (typeof s.tiltCenter !== 'number' || !isFinite(s.tiltCenter) || Math.abs(s.tiltCenter) > 1.2) s.tiltCenter = 0;
    return s;
  },
  saveSettings: (s: Settings) => set(KEY_SETTINGS, s),
  loadRecords: () => ({ bestLap: null as number | null, bestRace: null as number | null, ...(get<{ bestLap: number | null; bestRace: number | null }>(KEY_RECORDS) ?? {}) }),
  saveRecords: (r: { bestLap: number | null; bestRace: number | null }) => set(KEY_RECORDS, r),
  /** Best drift chain ever banked in the drift zone. */
  loadBestDrift: (): number => {
    const z = get<{ bestDrift?: number }>(KEY_ZONE);
    return z && typeof z.bestDrift === 'number' && isFinite(z.bestDrift) ? Math.max(0, z.bestDrift) : 0;
  },
  saveBestDrift: (bestDrift: number) => set(KEY_ZONE, { bestDrift }),
};
