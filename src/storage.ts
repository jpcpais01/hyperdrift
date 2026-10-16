import { sanitizeBuild, type CarBuild } from './car/parts';
import type { GhostLap } from './game/ghost';

const KEY_BUILD = 'hyperdrift.build.v1';
const KEY_GHOST = 'hyperdrift.ghost.v1';
const KEY_SETTINGS = 'hyperdrift.settings.v1';
const KEY_RECORDS = 'hyperdrift.records.v1';

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
  loadSettings: () => ({ muted: false, ...(get<{ muted: boolean }>(KEY_SETTINGS) ?? {}) }),
  saveSettings: (s: { muted: boolean }) => set(KEY_SETTINGS, s),
  loadRecords: () => ({ bestLap: null as number | null, bestRace: null as number | null, ...(get<{ bestLap: number | null; bestRace: number | null }>(KEY_RECORDS) ?? {}) }),
  saveRecords: (r: { bestLap: number | null; bestRace: number | null }) => set(KEY_RECORDS, r),
};
