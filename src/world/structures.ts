import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_WIDTH, type Track } from '../track/track';
import { CLOUD_Y } from './atmosphere';
import type { TrackLayout } from './trackLayout';

const OUTER = HALF_WIDTH + 0.7;
const KEEL = 3.0;
const KEEL_HALF = HALF_WIDTH * 0.45;
/** structures reach down into the cloud sea and dissolve in its haze */
const ROOT_Y = CLOUD_Y - 30;

type Kind = 'white' | 'metal' | 'dark' | 'warm' | 'cyan' | 'amber' | 'magenta';

/**
 * Collects transformed primitives per material and merges them into one mesh
 * each, so every pylon, tower, cable saddle and gate costs a handful of draws in total.
 * Vertex colours carry a cheap baked AO (darker low down, towards the clouds).
 */
class Pieces {
  private parts = new Map<Kind, BufferGeometry[]>();
  add(g: BufferGeometry, kind: Kind, m: Matrix4, aoLow = 1, aoHigh = 1) {
    const geo = g.clone();
    if (geo.getAttribute('uv') === undefined) geo.setAttribute('uv', new Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
    geo.applyMatrix4(m);
    const pos = geo.getAttribute('position');
    geo.computeBoundingBox();
    const y0 = geo.boundingBox!.min.y;
    const y1 = geo.boundingBox!.max.y;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = y1 > y0 ? (pos.getY(i) - y0) / (y1 - y0) : 1;
      const ao = aoLow + (aoHigh - aoLow) * t;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
    }
    geo.setAttribute('color', new Float32BufferAttribute(col, 3));
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) geo.deleteAttribute(k);
    const list = this.parts.get(kind) ?? [];
    list.push(geo.index ? geo.toNonIndexed() : geo);
    this.parts.set(kind, list);
  }
  build(mats: Record<Kind, Material>, group: Group) {
    for (const [kind, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, mats[kind]);
      mesh.receiveShadow = kind === 'white' || kind === 'metal' || kind === 'dark';
      group.add(mesh);
    }
  }
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  return g ? [c, g] : null;
}

/** Corner board: glowing amber chevrons on black, pointing right (flipped for left-handers). */
function chevronBoard(): Texture | null {
  const cv = canvas(256, 128);
  if (!cv) return null;
  const [c, g] = cv;
  g.fillStyle = '#0c0d12';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  g.strokeRect(4, 4, 248, 120);
  g.fillStyle = '#ffb02e';
  for (let k = 0; k < 3; k++) {
    const x = 34 + k * 70;
    g.beginPath();
    g.moveTo(x, 18);
    g.lineTo(x + 40, 64);
    g.lineTo(x, 110);
    g.lineTo(x + 22, 110);
    g.lineTo(x + 62, 64);
    g.lineTo(x + 22, 18);
    g.closePath();
    g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** The start gantry's big screen. */
function bannerTexture(): Texture | null {
  const cv = canvas(1024, 160);
  if (!cv) return null;
  const [c, g] = cv;
  const grd = g.createLinearGradient(0, 0, 1024, 0);
  grd.addColorStop(0, '#0b1830');
  grd.addColorStop(0.5, '#1a0f33');
  grd.addColorStop(1, '#0b1830');
  g.fillStyle = grd;
  g.fillRect(0, 0, 1024, 160);
  // LED pixel grid
  g.fillStyle = 'rgba(255,255,255,0.04)';
  for (let x = 0; x < 1024; x += 4) g.fillRect(x, 0, 1, 160);
  for (let y = 0; y < 160; y += 4) g.fillRect(0, y, 1024, 1);
  g.font = 'italic 900 92px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = '#4fd8ff';
  g.shadowBlur = 24;
  g.fillStyle = '#ffffff';
  g.fillText('SKYWAY PRIME', 512, 84);
  g.shadowBlur = 0;
  g.fillStyle = '#ff4fd8';
  g.fillRect(40, 140, 944, 6);
  g.fillStyle = '#4fd8ff';
  g.fillRect(40, 14, 944, 6);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const tmpQ = new Quaternion();
const tmpS = new Vector3(1, 1, 1);
const Y = new Vector3(0, 1, 0);

/** Matrix for a unit cylinder (height 1 along Y, centred) stretched between two points. */
function between(a: Vector3, b: Vector3, r: number, out = new Matrix4()): Matrix4 {
  const d = b.clone().sub(a);
  const len = d.length();
  tmpQ.setFromUnitVectors(Y, d.divideScalar(len || 1));
  return out.compose(a.clone().add(b).multiplyScalar(0.5), tmpQ, tmpS.set(r, len, r));
}

/**
 * Everything built around the deck: lamp masts, corner boards, the pylons that
 * plunge into the cloud sea, the suspension bridge's towers and cables, the
 * start gantry and the jump gates.
 */
export class TrackStructures {
  readonly group = new Group();
  private materials: Material[] = [];
  private textures: Texture[] = [];
  private halos: Mesh[] = [];
  private startLights: MeshBasicMaterial | null = null;

  constructor(track: Track, layout: TrackLayout) {
    const mats: Record<Kind, Material> = {
      white: new MeshStandardMaterial({ color: 0xe9e7e2, roughness: 0.55, metalness: 0.1, vertexColors: true }),
      metal: new MeshStandardMaterial({ color: 0xc7ccd5, roughness: 0.3, metalness: 0.8, vertexColors: true }),
      dark: new MeshStandardMaterial({ color: 0x2a2e37, roughness: 0.35, metalness: 0.75, vertexColors: true }),
      warm: new MeshBasicMaterial({ color: new Color(3.2, 2.6, 1.9), vertexColors: true }),
      cyan: new MeshBasicMaterial({ color: new Color(0.5, 2.2, 3.4), vertexColors: true }),
      amber: new MeshBasicMaterial({ color: new Color(3.4, 1.5, 0.25), vertexColors: true }),
      magenta: new MeshBasicMaterial({ color: new Color(2.6, 0.5, 2.2), vertexColors: true }),
    };
    this.materials.push(...Object.values(mats));
    const P = new Pieces();
    const box = new BoxGeometry(1, 1, 1);
    const cyl = new CylinderGeometry(1, 1, 1, 10, 1);
    const cyl6 = new CylinderGeometry(1, 1, 1, 6, 1);
    const m = new Matrix4();
    const n = track.samples.length;

    // --- lamp masts: a slim arm rising behind the glass and arching out over the road
    {
      const pts = [
        new Vector3(0, 0, 0),
        new Vector3(0, 5.5, 0),
        new Vector3(-0.4, 7.6, 0),
        new Vector3(-1.8, 8.5, 0),
        new Vector3(-3.6, 8.6, 0),
      ];
      const mast = new TubeGeometry(new CatmullRomCurve3(pts), 14, 0.13, 5, false);
      const head = new BoxGeometry(0.42, 0.16, 2.0).translate(-3.8, 8.6, 0);
      const led = new BoxGeometry(0.3, 0.04, 1.8).translate(-3.8, 8.5, 0);
      const foot = new CylinderGeometry(0.22, 0.3, 0.5, 8).translate(0, 0.25, 0);
      for (const l of layout.lamps) {
        const f = track.frameAt(l.s);
        // right-handed basis (x = outwards, z = -forward on the right side), so the tube isn't mirrored inside out
        const basis = new Matrix4().makeBasis(f.right.clone().multiplyScalar(l.side), f.up, f.fwd.clone().multiplyScalar(-l.side));
        basis.setPosition(f.pos.clone().addScaledVector(f.right, l.side * (OUTER - 0.12)).addScaledVector(f.up, 0.42));
        P.add(mast, 'dark', basis);
        P.add(head, 'dark', basis);
        P.add(foot, 'dark', basis);
        P.add(led, 'warm', basis);
      }
      mast.dispose();
      head.dispose();
      led.dispose();
      foot.dispose();
    }

    // --- corner boards on the outside of the tight bends
    {
      const tex = chevronBoard();
      if (tex) {
        const texL = tex.clone();
        texL.repeat.x = -1;
        texL.offset.x = 1;
        texL.needsUpdate = true;
        this.textures.push(tex, texL);
        const plane = new PlaneGeometry(3.4, 1.7);
        for (const [dirRight, t] of [
          [true, tex],
          [false, texL],
        ] as [boolean, Texture][]) {
          const list = layout.signs.filter((sg) => sg.side < 0 === dirRight);
          if (!list.length) continue;
          const mat = new MeshBasicMaterial({ map: t, color: new Color(1.7, 1.7, 1.7), side: DoubleSide });
          this.materials.push(mat);
          const inst = new InstancedMesh(plane, mat, list.length);
          list.forEach((sg, k) => {
            const f = track.frameAt(sg.s);
            // face the oncoming cars, standing just behind the barrier
            // facing the oncoming cars: +x is their right, so the chevrons read the right way round
            const bm = new Matrix4().makeBasis(f.right, f.up, f.fwd.clone().negate());
            bm.setPosition(f.pos.clone().addScaledVector(f.right, sg.side * (OUTER + 0.9)).addScaledVector(f.up, 2.5));
            inst.setMatrixAt(k, bm);
            for (const dl of [-1.3, 1.3]) {
              const a = f.pos.clone().addScaledVector(f.right, sg.side * (OUTER + 0.9) + dl).addScaledVector(f.up, -0.2);
              const b = a.clone().addScaledVector(f.up, 2.0);
              P.add(cyl, 'dark', between(a, b, 0.07, m));
            }
          });
          inst.computeBoundingSphere();
          this.group.add(inst);
        }
      }
    }

    // --- pylons: a tapered trunk that forks to cradle the keel, banded with light, rooted in the clouds
    for (const py of layout.pylons) {
      const smp = track.samples[py.i];
      const top = smp.pos.clone().addScaledVector(smp.up, -KEEL - 0.3);
      const fork = top.clone().add(new Vector3(0, -16, 0));
      const bottom = new Vector3(top.x, ROOT_Y, top.z);
      const height = fork.y - bottom.y;
      if (height < 20) continue;
      // trunk in three tapering drums
      const drums = 3;
      for (let k = 0; k < drums; k++) {
        const y0 = bottom.y + (height * k) / drums;
        const y1 = bottom.y + (height * (k + 1)) / drums;
        const r0 = 5.2 - k * 0.9;
        const r1 = r0 - 0.7;
        const g = new CylinderGeometry(r1, r0, y1 - y0, 8, 1);
        m.makeRotationY((py.i * 0.37) % Math.PI).setPosition(top.x, (y0 + y1) / 2, top.z);
        P.add(g, 'white', m, 0.35 + k * 0.2, 0.55 + k * 0.2);
        g.dispose();
        // light band at each drum joint
        if (k > 0) {
          m.makeRotationX(Math.PI / 2).setPosition(top.x, y0, top.z);
          const ring = new TorusGeometry(r0 + 0.12, 0.16, 4, 16);
          P.add(ring, 'cyan', m);
          ring.dispose();
        }
      }
      // the fork: two arms up to the keel's edges, and a saddle under the keel
      const side = smp.right.clone().setY(0).normalize();
      for (const sgn of [-1, 1]) {
        const end = top.clone().addScaledVector(side, sgn * KEEL_HALF * 0.85);
        P.add(cyl6, 'white', between(fork, end, 1.25, m), 0.7, 1);
      }
      const saddle = new Matrix4().makeBasis(smp.right, smp.up, smp.fwd.clone().negate());
      saddle.scale(new Vector3(KEEL_HALF * 2.1, 0.8, 3.2));
      saddle.setPosition(top.clone().addScaledVector(smp.up, -0.2));
      P.add(box, 'dark', saddle);
      // a beacon on the fork
      m.makeRotationX(Math.PI / 2).setPosition(fork.x, fork.y - 1.5, fork.z);
      const crown = new TorusGeometry(2.85, 0.22, 4, 16);
      P.add(crown, 'cyan', m);
      crown.dispose();
    }

    // --- suspension bridge
    const br = track.marks.bridge;
    if (br) {
      const towersS = [br.s0 + 62, br.s1 - 62];
      const sides = [-1, 1];
      const cableLat = OUTER + 1.8;
      const towerTop = (s: number, side: number) => {
        const f = track.frameAt(s);
        const base = f.pos.clone().addScaledVector(f.right, side * cableLat);
        return new Vector3(base.x, f.pos.y + 46, base.z);
      };
      for (const s of towersS) {
        const f = track.frameAt(s);
        const tops = sides.map((sd) => towerTop(s, sd));
        for (const t of tops) {
          const b = new Vector3(t.x, ROOT_Y, t.z);
          // slender tapering legs, slightly A-framed towards the top
          const mid = new Vector3(t.x, f.pos.y - 4, t.z);
          P.add(new CylinderGeometry(1.5, 2.4, 1, 8), 'white', between(b, mid, 1, m), 0.35, 0.85);
          P.add(new CylinderGeometry(1.0, 1.5, 1, 8), 'white', between(mid, t, 1, m), 0.85, 1);
          // saddle cap and aircraft beacon
          m.makeScale(1.4, 2.4, 1.4).setPosition(t.x, t.y + 1.2, t.z);
          P.add(box, 'dark', m);
          m.makeScale(0.5, 0.5, 0.5).setPosition(t.x, t.y + 2.8, t.z);
          P.add(cyl6, 'magenta', m);
        }
        // cross beams: under the deck, mid height and at the top
        const under = tops.map((t) => new Vector3(t.x, f.pos.y - KEEL - 1.2, t.z));
        P.add(box, 'white', beamBetween(under[0], under[1], 2.2, 1.6, m));
        const midY = f.pos.y + 26;
        P.add(box, 'white', beamBetween(new Vector3(tops[0].x, midY, tops[0].z), new Vector3(tops[1].x, midY, tops[1].z), 1.6, 1.4, m));
        P.add(box, 'white', beamBetween(new Vector3(tops[0].x, tops[0].y - 1, tops[0].z), new Vector3(tops[1].x, tops[1].y - 1, tops[1].z), 2, 1.6, m));
        P.add(box, 'cyan', beamBetween(new Vector3(tops[0].x, midY - 0.85, tops[0].z), new Vector3(tops[1].x, midY - 0.85, tops[1].z), 0.25, 1.45, m));
      }
      // main cables: anchor -> tower -> sag -> tower -> anchor, with hangers every 6 m
      for (const sd of sides) {
        const anchorA = track.pointAt(br.s0 + 4, sd * cableLat, 0.6);
        const anchorB = track.pointAt(br.s1 - 4, sd * cableLat, 0.6);
        const t1 = towerTop(towersS[0], sd);
        const t2 = towerTop(towersS[1], sd);
        const cableAt = (s: number): Vector3 => {
          const deck = track.pointAt(s, sd * cableLat, 0);
          if (s <= towersS[0]) {
            const u = (s - br.s0 - 4) / (towersS[0] - br.s0 - 4);
            return anchorA.clone().lerp(t1, u).add(new Vector3(0, -Math.sin(Math.PI * u) * 3, 0));
          }
          if (s >= towersS[1]) {
            const u = (s - towersS[1]) / (br.s1 - 4 - towersS[1]);
            return t2.clone().lerp(anchorB, u).add(new Vector3(0, -Math.sin(Math.PI * u) * 3, 0));
          }
          const u = (s - towersS[0]) / (towersS[1] - towersS[0]);
          const straight = t1.clone().lerp(t2, u);
          const lowest = deck.y + 5;
          const sag = (straight.y - lowest) * 4 * u * (1 - u);
          return straight.add(new Vector3(0, -sag, 0));
        };
        let prev = anchorA;
        for (let s = br.s0 + 4 + 4; s <= br.s1 - 4 + 0.01; s += 4) {
          const c = cableAt(Math.min(s, br.s1 - 4));
          P.add(cyl6, 'dark', between(prev, c, 0.32, m));
          prev = c;
        }
        for (let s = br.s0 + 10; s < br.s1 - 8; s += 6) {
          if (Math.abs(s - towersS[0]) < 3 || Math.abs(s - towersS[1]) < 3) continue;
          const top = cableAt(s);
          const foot = track.pointAt(s, sd * (OUTER + 0.3), 0.4);
          if (top.y - foot.y < 1.5) continue;
          P.add(cyl6, 'metal', between(foot, top, 0.07, m));
        }
      }
    }

    // --- start / finish gantry: a portal around the deck carrying the screen and the start lights
    {
      const s = 2;
      const f = track.frameAt(s);
      const at = (lat: number, h: number) => f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, h);
      const L = OUTER + 1.6;
      for (const sd of [-1, 1]) {
        P.add(box, 'dark', beamFramed(at(sd * L, -KEEL - 2), at(sd * L, 10.5), 1.4, 1.8, f.fwd, m));
        P.add(box, 'cyan', beamFramed(at(sd * (L - 0.72), -KEEL - 1), at(sd * (L - 0.72), 10), 0.08, 0.5, f.fwd, m));
      }
      P.add(box, 'dark', beamFramed(at(-L - 0.7, 10.6), at(L + 0.7, 10.6), 2.2, 2.4, f.fwd, m));
      P.add(box, 'dark', beamFramed(at(-L - 0.7, -KEEL - 2.2), at(L + 0.7, -KEEL - 2.2), 1.2, 1.8, f.fwd, m));
      P.add(box, 'magenta', beamFramed(at(-L, 9.45), at(L, 9.45), 0.1, 2.3, f.fwd, m));

      const tex = bannerTexture();
      if (tex) {
        this.textures.push(tex);
        const mat = new MeshBasicMaterial({ map: tex, color: new Color(1.5, 1.5, 1.5), side: DoubleSide });
        this.materials.push(mat);
        const screen = new Mesh(new PlaneGeometry(2 * L - 2, (2 * L - 2) * (160 / 1024)), mat);
        // the front face reads left to right for the cars coming up to the line, the back for anyone looking back
        const back = screen.clone();
        screen.applyMatrix4(new Matrix4().makeBasis(f.right, f.up, f.fwd.clone().negate()));
        screen.position.copy(at(0, 13.2)).addScaledVector(f.fwd, -1.25);
        back.applyMatrix4(new Matrix4().makeBasis(f.right.clone().negate(), f.up, f.fwd));
        back.position.copy(at(0, 13.2)).addScaledVector(f.fwd, 1.25);
        P.add(box, 'dark', beamFramed(at(-L + 0.5, 13.2), at(L - 0.5, 13.2), 3.6, 2.3, f.fwd, m));
        this.group.add(screen, back);
      }
      // five start-light pods under the beam
      this.startLights = new MeshBasicMaterial({ color: new Color(3, 0.25, 0.2) });
      this.materials.push(this.startLights);
      const pod = new CylinderGeometry(0.42, 0.42, 0.25, 16);
      pod.rotateX(Math.PI / 2);
      for (let k = 0; k < 5; k++) {
        const lat = (k - 2) * 1.6;
        const mesh = new Mesh(pod, this.startLights);
        mesh.position.copy(at(lat, 9.1)).addScaledVector(f.fwd, -1.3);
        mesh.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(f.right, f.up, f.fwd.clone().negate()));
        this.group.add(mesh);
        P.add(box, 'dark', beamFramed(at(lat, 9.1), at(lat, 9.9), 0.9, 1.2, f.fwd, m));
      }
    }

    // --- jump gates: an amber portal at each takeoff, a glowing halo hanging where the cars fly,
    // and a row of amber studs where they come down
    {
      const gate = (s: number) => {
        const f = track.frameAt(s);
        const at = (lat: number, h: number) => f.pos.clone().addScaledVector(f.right, lat).addScaledVector(f.up, h);
        const L = OUTER + 0.9;
        for (const sd of [-1, 1]) {
          P.add(box, 'dark', beamFramed(at(sd * L, -0.5), at(sd * L, 8), 0.8, 1, f.fwd, m));
          P.add(box, 'amber', beamFramed(at(sd * (L - 0.42), 0.4), at(sd * (L - 0.42), 7.6), 0.06, 0.6, f.fwd, m));
        }
        P.add(box, 'dark', beamFramed(at(-L - 0.4, 8.2), at(L + 0.4, 8.2), 1.0, 1.2, f.fwd, m));
        P.add(box, 'amber', beamFramed(at(-L + 0.4, 7.62), at(L - 0.4, 7.62), 0.06, 1.0, f.fwd, m));
      };
      const halo = (s: number, h: number, radius = 11) => {
        const hm = new MeshBasicMaterial({ color: new Color(3.0, 1.4, 0.3), transparent: true, blending: AdditiveBlending, depthWrite: false });
        this.materials.push(hm);
        const mesh = new Mesh(new TorusGeometry(radius, 0.35, 6, 64), hm);
        const fm = track.frameAt(s);
        mesh.position.copy(fm.pos).addScaledVector(fm.up, h);
        mesh.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(fm.right, fm.up, fm.fwd.clone().negate()));
        this.halos.push(mesh);
        this.group.add(mesh);
      };
      const studs = (s: number) => {
        const lf = track.frameAt(s);
        for (let k = -4; k <= 4; k++) {
          const p = lf.pos.clone().addScaledVector(lf.right, k * 2).addScaledVector(lf.up, 0.03);
          m.makeBasis(lf.right, lf.up, lf.fwd.clone().negate()).scale(new Vector3(0.9, 0.05, 0.3)).setPosition(p);
          P.add(box, 'amber', m);
        }
      };
      for (let i = 0; i < n; i++) {
        const a = track.samples[i];
        const b = track.samples[(i + 1) % n];
        if (a.gap || !b.gap) continue;
        let j = i + 1;
        while (track.samples[j % n].gap) j++;
        gate(i - 1);
        // midway, a few metres over the virtual deck (where the cars fly)
        halo(Math.round((i + j) / 2), 6);
        studs(j + 1);
        i = j;
      }
      // the sky dive: a gate on the crest, two halos down the flight and studs where most cars land
      const dive = track.marks.dive;
      if (dive) {
        gate(dive.s0 - 24);
        halo(dive.s0 + 15, 5.5, 12);
        halo(dive.s0 + 60, 6.5, 12);
        studs(dive.s0 + 110);
      }
    }

    P.build(mats, this.group);
    box.dispose();
    cyl.dispose();
    cyl6.dispose();
  }

  /** Start lights: count 0..5 lit red, or all green (go). */
  setStartLights(state: 'off' | 'red' | 'go') {
    if (!this.startLights) return;
    if (state === 'go') this.startLights.color.setRGB(0.3, 3.2, 0.6);
    else if (state === 'red') this.startLights.color.setRGB(3.2, 0.25, 0.2);
    else this.startLights.color.setRGB(0.12, 0.05, 0.05);
  }

  update(time: number) {
    for (let k = 0; k < this.halos.length; k++) {
      const h = this.halos[k];
      const mat = h.material as MeshBasicMaterial;
      const pulse = 0.75 + 0.25 * Math.sin(time * 3 + k);
      mat.color.setRGB(3.0 * pulse, 1.4 * pulse, 0.3 * pulse);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if ((o as Mesh).geometry) (o as Mesh).geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

/** Box (unit) stretched from a to b with the given thickness, its depth axis along `depthDir`. */
function beamFramed(a: Vector3, b: Vector3, thick: number, depth: number, depthDir: Vector3, out: Matrix4): Matrix4 {
  const len = a.distanceTo(b);
  const y = b.clone().sub(a).normalize();
  const z = depthDir.clone().addScaledVector(y, -depthDir.dot(y)).normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  out.makeBasis(x, y, z);
  out.scale(new Vector3(thick, len, depth));
  return out.setPosition(a.clone().add(b).multiplyScalar(0.5));
}

/** Horizontal-ish beam between two points (depth along the horizontal perpendicular). */
function beamBetween(a: Vector3, b: Vector3, thick: number, depth: number, out: Matrix4): Matrix4 {
  const dir = b.clone().sub(a).normalize();
  const perp = new Vector3(-dir.z, 0, dir.x).normalize();
  return beamFramed(a, b, thick, depth, perp.lengthSq() > 0 ? perp : new Vector3(0, 0, 1), out);
}
