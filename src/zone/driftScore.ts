import type { CarPhysics } from '../game/carPhysics';

export type DriftEvent =
  | { type: 'bank'; score: number; grade: string; best: boolean }
  | { type: 'fail' }
  | { type: 'air'; seconds: number; bonus: number }
  | { type: 'mult'; mult: number };

/** Seconds a chain survives between two drifts. */
export const CHAIN_GRACE = 1.6;
/** Seconds of sliding per multiplier step (×1 → ×5). */
const MULT_STEP = 2.5;
const MAX_MULT = 5;

export function gradeFor(score: number): string {
  if (score >= 40000) return 'LENDÁRIO';
  if (score >= 18000) return 'INSANO';
  if (score >= 8000) return 'INCRÍVEL';
  if (score >= 3000) return 'ÓTIMO';
  if (score >= 800) return 'BOM';
  return '';
}

/**
 * Drift combos for free roam. Sliding scores by speed and slip angle; linking drifts
 * inside the grace window keeps the chain (and its multiplier) alive. Hitting something
 * hard throws the whole chain away. Big airtime pays a bonus too.
 */
export class DriftScore {
  /** raw points in the current chain (shown ×mult) */
  chain = 0;
  mult = 1;
  /** 0..1 left of the grace window while between drifts */
  grace = 0;
  active = false;
  total = 0;
  best: number;
  /** current slip angle, degrees (for the HUD gauge) */
  angle = 0;
  private slideTime = 0;
  private graceLeft = 0;
  private air = 0;
  readonly events: DriftEvent[] = [];

  constructor(best = 0) {
    this.best = best;
  }

  update(dt: number, p: CarPhysics, impact: number) {
    const vf = p.vel.dot(p.fwd);
    const vr = p.vel.dot(p.right);
    const spd = p.speed;
    this.angle = spd > 3 ? (Math.atan2(Math.abs(vr), Math.abs(vf)) * 180) / Math.PI : 0;
    const sliding = p.grounded && spd > 12 && (p.drifting || (this.angle > 12 && Math.abs(vr) > 5));

    if (impact > 7 && this.active) {
      this.reset();
      this.events.push({ type: 'fail' });
    }

    if (sliding) {
      this.active = true;
      this.graceLeft = CHAIN_GRACE;
      this.slideTime += dt;
      const angleK = Math.min(1.6, 0.35 + this.angle / 28);
      this.chain += dt * spd * angleK * 7;
      const m = Math.min(MAX_MULT, 1 + Math.floor(this.slideTime / MULT_STEP));
      if (m > this.mult) {
        this.mult = m;
        this.events.push({ type: 'mult', mult: m });
      }
    } else if (this.active && p.grounded) {
      this.graceLeft -= dt;
      if (this.graceLeft <= 0) this.bank();
    }
    this.grace = this.active ? Math.max(0, this.graceLeft / CHAIN_GRACE) : 0;

    // airtime
    if (!p.grounded) this.air += dt;
    else {
      if (this.air > 0.55) {
        const bonus = Math.round(this.air * 350) * 5;
        this.total += bonus;
        if (this.active) {
          this.chain += bonus * 0.5;
          this.graceLeft = CHAIN_GRACE;
        }
        this.events.push({ type: 'air', seconds: this.air, bonus });
      }
      this.air = 0;
    }
  }

  get score() {
    return Math.round(this.chain * this.mult);
  }

  private bank() {
    const score = this.score;
    const best = score > this.best && score >= 300;
    if (score > this.best) this.best = score;
    this.total += score;
    if (score >= 100) this.events.push({ type: 'bank', score, grade: gradeFor(score), best });
    this.reset();
  }

  /** Banks whatever is running (leaving the zone). */
  flush() {
    if (this.active) this.bank();
  }

  private reset() {
    this.active = false;
    this.chain = 0;
    this.mult = 1;
    this.slideTime = 0;
    this.graceLeft = 0;
    this.grace = 0;
  }
}
