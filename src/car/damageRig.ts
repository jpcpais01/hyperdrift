import { Box3, BufferGeometry, Group, Matrix4, Mesh, Quaternion, Vector3, type Material, type MeshDepthMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CarDamage, LOOSE_PARTS, MAX_DENTS, PART, PART_COUNT, PartState } from './damage';
import { createDamageUniforms, damageDepthMaterial, type DamageUniforms } from './damageShader';
import { withPart } from './damageParts';
import type { Surface } from './surface';

/** One material's worth of a part's geometry (car space, normalised). */
export interface PartPiece {
  mat: Material;
  geos: BufferGeometry[];
}

/** A part thrown off the car: meshes in car space under `inner`, centred on `center`. */
export interface DebrisPiece {
  root: Group;
  /** car-space centre of the part (the root's pivot) */
  center: Vector3;
  /** half extents, for bouncing */
  half: Vector3;
  /** the part's own transform on the car when it let go */
  partMatrix: Matrix4;
  dispose(): void;
}

interface Swing {
  ang: number;
  vel: number;
}

const UNDER_OF: Record<number, number> = { [PART.front]: PART.underFront, [PART.rear]: PART.underRear, [PART.hood]: PART.underHood };
const ZERO = new Matrix4().makeScale(0, 0, 0);
const M1 = new Matrix4();
const M2 = new Matrix4();
const Q = new Quaternion();
const AX = new Vector3();
const O = new Vector3();
const D = new Vector3();

/**
 * The visual side of a car's damage: feeds the dents to the shaders, swings
 * loose panels on soft springs (they flap at speed and jump on every knock),
 * hides parts that came off and builds their debris.
 */
export class DamageRig {
  readonly uniforms: DamageUniforms = createDamageUniforms();
  readonly depthMaterial: MeshDepthMaterial;
  private swing: Swing[] = Array.from({ length: PART_COUNT }, () => ({ ang: 0, vel: 0 }));
  private rev = -1;
  /** wheels, for the visual: extra camber / toe / gone */
  readonly wheels = [0, 1, 2, 3].map(() => ({ camber: 0, toe: 0, gone: false }));

  constructor(
    private readonly boxes: Map<number, Box3>,
    private readonly pieces: Map<number, PartPiece[]>,
    readonly surface: Surface | null,
  ) {
    this.depthMaterial = damageDepthMaterial(this.uniforms);
    this.writeParts(null, 0, 0);
  }

  /** A knock: loose panels jump. */
  kick(amount: number) {
    for (const p of LOOSE_PARTS) this.swing[p].vel += (Math.random() - 0.3) * amount * 6;
  }

  /**
   * Where a hit lands on the skin: casts from outside the car along the push.
   * Falls back to the given point when the ray misses (a wing, a gap).
   */
  resolve(point: Vector3, dir: Vector3, out: Vector3): Vector3 {
    out.copy(point);
    const s = this.surface;
    if (!s) return out;
    O.copy(point).addScaledVector(dir, -1.6);
    const hit = s.hit(O, dir);
    if (hit && hit.distanceTo(point) < 1.4) out.copy(hit);
    return out;
  }

  /** Push the model's state to the shaders and the part transforms (every frame). */
  sync(d: CarDamage, dt: number, speed: number, t: number) {
    const u = this.uniforms;
    const n = Math.min(MAX_DENTS, d.dents.length);
    for (let i = 0; i < n; i++) {
      const dn = d.dents[i];
      u.uDentA.value[i].set(dn.c.x, dn.c.y, dn.c.z, dn.r);
      u.uDentB.value[i].set(dn.dir.x, dn.dir.y, dn.dir.z, Math.max(0, dn.shown));
      u.uDentC.value[i].set(dn.scuff, dn.seed, 0, 0);
    }
    u.uDentN.value = n;
    const burn = d.totaled ? Math.min(1, 0.35 + d.wreckTime * 0.25) : d.health < 0.2 ? (0.2 - d.health) * 1.5 : 0;
    u.uWreck.value.set(burn, d.glass, d.lightsOut[0] ? 1 : 0, d.lightsOut[1] ? 1 : 0);
    d.wheels.forEach((w, i) => Object.assign(this.wheels[i], w));
    if (d.rev !== this.rev) {
      this.rev = d.rev;
      // a repaired car: panels snap back
      if (!d.damaged) for (const s of this.swing) s.ang = s.vel = 0;
    }
    this.writeParts(d, dt, speed, t);
  }

  private writeParts(d: CarDamage | null, dt: number, speed: number, t = 0) {
    const M = this.uniforms.uPartM.value;
    for (let p = 0; p < PART_COUNT; p++) M[p].identity();
    for (const p of [PART.underFront, PART.underRear, PART.underHood]) M[p].copy(ZERO);
    if (!d) return;
    const fast = Math.min(1, Math.abs(speed) / 60);
    LOOSE_PARTS.forEach((part, i) => {
      const st = d.parts[i];
      const box = this.boxes.get(part);
      const under = UNDER_OF[part];
      if (st === PartState.Gone || !box) {
        M[part].copy(ZERO);
        if (under !== undefined) M[under].identity();
        return;
      }
      if (st !== PartState.Loose) return;
      if (under !== undefined) M[under].identity();
      const side = d.partSide[i];
      const z = d.zone;
      // how far it hangs, and the flutter the wind gives it
      let target = 0;
      let flutter = 0;
      if (part === PART.front || part === PART.rear) {
        target = 0.09 + 0.22 * Math.min(1, Math.max(0, (part === PART.front ? z[0] : z[1]) - 0.3) * 2);
        flutter = Math.sin(t * 19 + part) * 0.025 * fast;
      } else if (part === PART.hood) {
        target = 0.07 + 0.32 * Math.min(1, Math.max(0, z[0] - 0.4) * 1.8);
        flutter = (Math.sin(t * 23) * 0.6 + Math.sin(t * 37) * 0.4) * 0.05 * fast;
      } else if (part === PART.spoiler) {
        target = 0.14 + 0.1 * Math.min(1, z[1]);
        flutter = Math.sin(t * 27) * 0.06 * fast;
      } else if (part === PART.skirts) {
        target = 0.035;
        flutter = Math.sin(t * 31) * 0.008 * fast;
      } else {
        target = 0.13;
        flutter = Math.sin(t * 29) * 0.03 * fast;
      }
      const s = this.swing[part];
      const h = Math.min(dt, 1 / 30);
      s.vel += ((target + flutter - s.ang) * 90 - s.vel * 7) * h;
      s.ang += s.vel * h;
      const a = Math.max(-0.2, Math.min(0.7, s.ang));
      this.partMatrix(part, box, side, a, M[part]);
    });
  }

  /** The transform of a loose part hanging at angle `a`. */
  private partMatrix(part: number, b: Box3, side: number, a: number, out: Matrix4) {
    const hx = Math.max(Math.abs(b.min.x), Math.abs(b.max.x));
    if (part === PART.front || part === PART.rear) {
      // one corner tore free: it drops and drags back, hinged on the other corner
      const end = part === PART.front ? b.min.z : b.max.z;
      O.set(-side * hx, b.max.y, end);
      Q.setFromAxisAngle(AX.set(0, 0, 1), -side * a);
      M1.makeRotationFromQuaternion(Q);
      Q.setFromAxisAngle(AX.set(0, 1, 0), side * a * (part === PART.front ? 0.35 : -0.35));
      M1.premultiply(M2.makeRotationFromQuaternion(Q));
      D.set(0, -a * 0.06, 0);
    } else if (part === PART.hood) {
      // popped and bent up from the latch, hinged at the windscreen
      O.set(0, b.max.y, b.min.z);
      M1.makeRotationAxis(AX.set(1, 0, 0), -a);
      D.set(0, 0, 0);
    } else if (part === PART.spoiler) {
      // one upright gave: the wing leans over and tips back
      O.set(side * hx * 0.6, b.min.y, (b.min.z + b.max.z) / 2);
      M1.makeRotationAxis(AX.set(0, 0, 1), side * a * 0.8);
      M1.premultiply(M2.makeRotationAxis(AX.set(1, 0, 0), a * 0.5));
      D.set(0, 0, 0);
    } else if (part === PART.skirts) {
      // the front fixings went: the sills sag at the front
      O.set(0, b.max.y, b.min.z);
      M1.makeRotationAxis(AX.set(1, 0, 0), a);
      D.set(0, -a * 0.6, 0);
    } else {
      // the hangers broke: the pipes hang down at the back
      O.set(0, b.max.y, b.max.z);
      M1.makeRotationAxis(AX.set(1, 0, 0), -a);
      D.set(0, -a * 0.12, 0);
    }
    out.makeTranslation(-O.x, -O.y, -O.z).premultiply(M1).premultiply(M2.makeTranslation(O.x + D.x, O.y + D.y, O.z + D.z));
  }

  /** The car-space point a loose part drags on the road (sparks), or null. */
  dragPoint(d: CarDamage, part: number, out: Vector3): Vector3 | null {
    const i = CarDamage.slot(part);
    const box = this.boxes.get(part);
    if (i < 0 || d.parts[i] !== PartState.Loose || !box) return null;
    const side = d.partSide[i];
    const hx = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
    if (part === PART.front) out.set(side * hx, box.min.y, box.max.z);
    else if (part === PART.rear) out.set(side * hx, box.min.y, box.min.z);
    else if (part === PART.exhaust) out.set(0, box.min.y, box.min.z);
    else return null;
    return out.applyMatrix4(this.uniforms.uPartM.value[part]);
  }

  /**
   * Builds the debris for a part that just came off, from the part's own
   * geometry and this car's materials (so it keeps its paint and dents).
   * Call before the next sync, while the part matrix still holds its pose.
   */
  debris(part: number): DebrisPiece | null {
    const pieces = this.pieces.get(part);
    const box = this.boxes.get(part);
    if (!pieces || !box || box.isEmpty()) return null;
    const root = new Group();
    const inner = new Group();
    const center = box.getCenter(new Vector3());
    const half = box.getSize(new Vector3()).multiplyScalar(0.5);
    inner.position.copy(center).negate();
    root.add(inner);
    const owned: BufferGeometry[] = [];
    for (const p of pieces) {
      if (!p.geos.length) continue;
      const geo = mergeGeometries(p.geos.map((g) => withPart(g, PART.debris)), false);
      if (!geo) continue;
      owned.push(geo);
      const mesh = new Mesh(geo, p.mat);
      mesh.frustumCulled = false;
      inner.add(mesh);
    }
    if (!owned.length) return null;
    const partMatrix = this.uniforms.uPartM.value[part].clone();
    // a part already hidden (synced as gone before we saw it loose): start from its fitted pose
    if (partMatrix.determinant() === 0) partMatrix.identity();
    return {
      root,
      center,
      half,
      partMatrix,
      dispose: () => {
        for (const g of owned) g.dispose();
      },
    };
  }

  dispose() {
    this.depthMaterial.dispose();
  }
}
