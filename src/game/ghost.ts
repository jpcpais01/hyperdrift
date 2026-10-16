import { Quaternion, Vector3 } from 'three';
import type { CarBuild } from '../car/parts';

/** A recorded lap: position + orientation sampled at a fixed rate. */
export interface GhostLap {
  time: number;
  hz: number;
  frames: number[]; // x, y, z, qx, qy, qz, qw per frame
  build: CarBuild;
}

const HZ = 20;

export class GhostRecorder {
  private frames: number[] = [];
  private t = 0;
  private next = 0;

  start() {
    this.frames = [];
    this.t = 0;
    this.next = 0;
  }

  record(dt: number, pos: Vector3, q: Quaternion) {
    this.t += dt;
    while (this.t >= this.next) {
      const r = (v: number) => Math.round(v * 1000) / 1000;
      this.frames.push(r(pos.x), r(pos.y), r(pos.z), r(q.x), r(q.y), r(q.z), r(q.w));
      this.next += 1 / HZ;
    }
  }

  finish(lapTime: number, build: CarBuild): GhostLap {
    return { time: lapTime, hz: HZ, frames: this.frames.slice(), build };
  }
}

export class GhostPlayer {
  constructor(private lap: GhostLap) {}

  get time() {
    return this.lap.time;
  }

  /** Writes the interpolated pose at time t into pos/quat; returns false once the lap is over. */
  sample(t: number, pos: Vector3, quat: Quaternion): boolean {
    const f = this.lap.frames;
    const n = f.length / 7;
    if (n < 2) return false;
    const x = t * this.lap.hz;
    const i = Math.floor(x);
    if (i >= n - 1) return false;
    const a = Math.max(0, i) * 7;
    const b = a + 7;
    const k = Math.max(0, Math.min(1, x - i));
    pos.set(f[a] + (f[b] - f[a]) * k, f[a + 1] + (f[b + 1] - f[a + 1]) * k, f[a + 2] + (f[b + 2] - f[a + 2]) * k);
    QA.set(f[a + 3], f[a + 4], f[a + 5], f[a + 6]);
    QB.set(f[b + 3], f[b + 4], f[b + 5], f[b + 6]);
    quat.slerpQuaternions(QA, QB, k);
    return true;
  }
}

const QA = new Quaternion();
const QB = new Quaternion();
