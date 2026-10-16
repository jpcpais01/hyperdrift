import { describe, expect, it } from 'vitest';
import { ATM, SUN_DIR, setAtmosphere } from '../src/world/atmosphere';
import { clockLabel, dayState, GOLDEN_HOUR, GOLDEN_SUN } from '../src/world/timeOfDay';

describe('time of day', () => {
  it('passes exactly through the golden hour the races are lit for', () => {
    const s = dayState(GOLDEN_HOUR);
    expect(s.sun.distanceTo(GOLDEN_SUN)).toBeLessThan(1e-6);
    expect(s.day).toBe(1);
    expect(s.golden).toBe(1);
    expect(s.night).toBe(0);
    expect(s.lightIntensity).toBeCloseTo(4.6, 5);
    expect(s.hemiIntensity).toBeCloseTo(0.22, 5);
    expect(s.env).toBe('golden');
    // and the sun keeps moving either side of it
    const later = dayState(GOLDEN_HOUR + 0.5);
    expect(later.sun.y).toBeLessThan(s.sun.y);
  });

  it('rises in the morning, peaks at noon and is gone at midnight', () => {
    expect(dayState(6).sinEl).toBeCloseTo(0, 6);
    expect(dayState(18).sinEl).toBeCloseTo(0, 6);
    const noon = dayState(12);
    expect(noon.sinEl).toBeGreaterThan(0.9);
    expect(noon.golden).toBe(0);
    expect(noon.env).toBe('day');
    const night = dayState(0);
    expect(night.night).toBe(1);
    expect(night.day).toBe(0);
    expect(night.env).toBe('night');
    // the moon lights the night, from high up
    expect(night.lightDir.distanceTo(night.moon)).toBeLessThan(1e-9);
    expect(night.moon.y).toBeGreaterThan(0.8);
    expect(night.ambient.b).toBeLessThan(0.5);
  });

  it('wraps the clock and labels it', () => {
    expect(dayState(25).hour).toBeCloseTo(1, 9);
    expect(dayState(-1).hour).toBeCloseTo(23, 9);
    expect(clockLabel(18.75)).toBe('18:45');
    expect(clockLabel(24)).toBe('00:00');
  });

  it('shares one live atmosphere with every material', () => {
    const sun = ATM.uAtmSun.value;
    setAtmosphere(dayState(12));
    expect(ATM.uAtmSun.value).toBe(sun);
    expect(sun.y).toBeGreaterThan(0.9);
    expect(SUN_DIR.y).toBeGreaterThan(0.9);
    setAtmosphere(dayState(GOLDEN_HOUR));
    expect(SUN_DIR.distanceTo(GOLDEN_SUN)).toBeLessThan(1e-6);
    expect(ATM.uAtmSunCol.value.y).toBeCloseTo(0.72, 5);
    expect(ATM.uAtmSunCol.value.z).toBeCloseTo(0.46, 5);
  });
});
