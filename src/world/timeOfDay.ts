import { Color, Vector3 } from 'three';

/**
 * Time of day: where the sun (or the moon) is and what that does to the light.
 * The races always sit at GOLDEN_HOUR, the look the game was built around; the
 * drift zone lets the clock run.
 */

/** The golden-hour sun the tracks were lit for (towards the sun, world space). */
export const GOLDEN_SUN = new Vector3(0.55, 0.25, -0.8).normalize();

/** highest the sun climbs (sine of the elevation at noon) */
const SIN_MAX = 0.92;
const GOLDEN_SIN = GOLDEN_SUN.y;
/** the hour at which the sun path passes exactly through GOLDEN_SUN */
export const GOLDEN_HOUR = 6 + 12 * (1 - Math.asin(GOLDEN_SIN / SIN_MAX) / Math.PI);
const GOLDEN_AZ = Math.atan2(GOLDEN_SUN.x, GOLDEN_SUN.z);

export interface DayState {
  hour: number;
  /** sine of the sun's elevation (negative at night) */
  sinEl: number;
  /** towards the sun, even below the horizon */
  sun: Vector3;
  /** towards the moon */
  moon: Vector3;
  /** 0 night … 1 day, with twilight in between */
  day: number;
  /** golden-hour warmth (sun low in the sky) */
  golden: number;
  /** 0 … 1 deep night */
  night: number;
  /** after-glow on the horizon once the sun has set (or before it rises) */
  twilight: number;
  /** how much of the sun disc/light is up */
  sunVis: number;
  moonVis: number;
  /** the key light: sun by day, moon by night */
  lightDir: Vector3;
  lightColor: Color;
  lightIntensity: number;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  /** scale for unlit (baked) materials: 1 by day, dim and blue at night */
  ambient: Color;
  env: 'golden' | 'day' | 'night';
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const SUN_DAY = new Color(0xfff2e2);
const SUN_GOLD = new Color(0xffd6ae);
const MOON = new Color(0x8ea8ff);
const HEMI_SKY = { day: new Color(0x9fb8ff), gold: new Color(0x8fa4ff), night: new Color(0x34428a) };
const HEMI_GROUND = { day: new Color(0x6a6474), gold: new Color(0x6a5068), night: new Color(0x16142a) };
const AMB_NIGHT = new Color(0.16, 0.19, 0.32);

function pal(out: Color, day: Color, gold: Color, night: Color, s: DayState) {
  return out.copy(day).lerp(gold, s.golden).lerp(night, 1 - s.day);
}

export function newDayState(): DayState {
  return {
    hour: GOLDEN_HOUR,
    sinEl: 0,
    sun: new Vector3(),
    moon: new Vector3(),
    day: 1,
    golden: 1,
    night: 0,
    twilight: 0,
    sunVis: 1,
    moonVis: 0,
    lightDir: new Vector3(),
    lightColor: new Color(),
    lightIntensity: 0,
    hemiSky: new Color(),
    hemiGround: new Color(),
    hemiIntensity: 0,
    ambient: new Color(1, 1, 1),
    env: 'golden',
  };
}

/** Everything about the light at `hour` (0 … 24). */
export function dayState(hour: number, out: DayState = newDayState()): DayState {
  const h = ((hour % 24) + 24) % 24;
  out.hour = h;
  const sinEl = SIN_MAX * Math.sin((Math.PI * (h - 6)) / 12);
  out.sinEl = sinEl;
  const cosEl = Math.sqrt(1 - sinEl * sinEl);
  // the sun swings round the sky 15° an hour
  const az = GOLDEN_AZ + ((h - GOLDEN_HOUR) * Math.PI) / 12;
  out.sun.set(Math.sin(az) * cosEl, sinEl, Math.cos(az) * cosEl);
  if (Math.abs(h - GOLDEN_HOUR) < 1e-6) out.sun.copy(GOLDEN_SUN);
  // the moon rides opposite the sun, a little higher, so it's up all night
  out.moon.copy(out.sun).negate().add(TMP.set(0, 0.35, 0)).normalize();

  out.day = smooth(-0.2, 0.06, sinEl);
  out.golden = 1 - smooth(0.3, 0.75, sinEl);
  out.night = 1 - smooth(-0.22, -0.02, sinEl);
  out.twilight = smooth(-0.24, -0.04, sinEl) * (1 - smooth(-0.04, 0.12, sinEl));
  out.sunVis = smooth(-0.03, 0.08, sinEl);
  out.moonVis = 1 - smooth(-0.12, 0.02, sinEl);

  if (sinEl > -0.01) {
    out.lightDir.copy(out.sun);
    out.lightColor.copy(SUN_DAY).lerp(SUN_GOLD, out.golden);
    out.lightIntensity = 4.6 * smooth(-0.01, 0.12, sinEl);
  } else {
    out.lightDir.copy(out.moon);
    out.lightColor.copy(MOON);
    out.lightIntensity = 0.7 * out.moonVis;
  }
  pal(out.hemiSky, HEMI_SKY.day, HEMI_SKY.gold, HEMI_SKY.night, out);
  pal(out.hemiGround, HEMI_GROUND.day, HEMI_GROUND.gold, HEMI_GROUND.night, out);
  out.hemiIntensity = 0.22 + 0.04 * (1 - out.golden) * out.day + 0.5 * out.night;
  out.ambient.setRGB(1, 1, 1).lerp(AMB_NIGHT, 1 - out.day);
  out.env = out.day < 0.4 ? 'night' : out.golden > 0.5 ? 'golden' : 'day';
  return out;
}

/** "18:42" */
export function clockLabel(hour: number): string {
  const m = Math.floor((((hour % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const TMP = new Vector3();
