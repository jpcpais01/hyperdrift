import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { ChaseCamera } from '../src/game/chaseCamera';
import { cameraOrbit } from '../src/game/cameraOrbit';
import type { CarPhysics } from '../src/game/carPhysics';

const car = {
  speed: 0,
  forwardSpeed: 0,
  lateralSpeed: 0,
  boostFx: 0,
  nitroFx: 0,
  drifting: false,
  driftDir: 0,
  grounded: true,
  stats: { topSpeed: 80 },
  draw: { pos: new Vector3(0, 0, 0), fwd: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0), right: new Vector3(-1, 0, 0) },
} as unknown as CarPhysics;

function shot(yaw: number, pitch: number) {
  const cam = new PerspectiveCamera();
  const chase = new ChaseCamera();
  cameraOrbit.yaw = yaw;
  cameraOrbit.pitch = pitch;
  chase.update(cam, car, 1e-5, 0);
  const aim = cam.getWorldDirection(new Vector3());
  return { pos: cam.position.clone(), aim };
}

describe('swipe orbit', () => {
  it('rests behind the car looking forward', () => {
    const { pos, aim } = shot(0, 0);
    expect(pos.z).toBeLessThan(-3);
    expect(aim.z).toBeGreaterThan(0.8);
  });
  it('swings to the front at half a lap and keeps the car framed', () => {
    const { pos, aim } = shot(Math.PI, 0);
    expect(pos.z).toBeGreaterThan(3);
    expect(aim.z).toBeLessThan(-0.8);
  });
  it('a right swipe (negative yaw) moves the camera to its own left', () => {
    const { pos } = shot(-0.6, 0);
    // camera behind looks along +z, its left is the car's left (+x)
    expect(pos.x).toBeGreaterThan(1);
  });
  it('positive pitch raises the camera and keeps the distance', () => {
    const a = shot(0, 0).pos;
    const b = shot(0, 0.8).pos;
    expect(b.y).toBeGreaterThan(a.y + 2);
    expect(b.length()).toBeCloseTo(a.length(), 3);
  });
});
