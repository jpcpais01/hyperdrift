import type { CarBuild } from '../car/parts';
import { sanitizeBuild } from '../car/parts';
import {
  HOST_ID,
  isMsg,
  MAX_PLAYERS,
  PROTOCOL,
  randomCode,
  TIMEOUT_MS,
  uniqueName,
  type Msg,
  type RejectReason,
  type RoomPlayer,
  type RoomSettings,
  type SessionInfo,
} from './protocol';
import { TransportFailure, type Link, type Transport } from './transport';

export type RoomCloseReason = 'left' | 'host-left' | 'lost' | RejectReason;

interface Guest {
  id: string;
  link: Link;
  lastSeen: number;
}

/**
 * An online room: who is in it, a shared clock and a message hub. It knows
 * nothing about racing: a "session" is any game mode the host starts (a race,
 * a free-roam zone…) with an opaque payload, and players stream per-object
 * state and one-off events that the host relays to everyone else.
 */
export class Room {
  players: RoomPlayer[] = [];
  settings: RoomSettings = { bots: true };
  session: SessionInfo | null = null;
  /** host clock minus local clock, in ms (0 on the host) */
  private offset = 0;
  private bestRtt = Infinity;
  private rtts: number[] = [];
  private guests = new Map<string, Guest>();
  private hostLink: Link | null = null;
  private hostSeen = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private seq = 0;

  onRoster: (() => void) | null = null;
  onSession: ((s: SessionInfo) => void) | null = null;
  onSessionEnd: (() => void) | null = null;
  /** state streamed for object `id` during session `seq` */
  onState: ((id: string, d: unknown, seq: number) => void) | null = null;
  onEvent: ((from: string, d: unknown, seq: number) => void) | null = null;
  onClose: ((reason: RoomCloseReason) => void) | null = null;

  private constructor(
    private transport: Transport,
    readonly isHost: boolean,
    public code: string,
    public myId: string,
    private now: () => number,
  ) {}

  /** Open a new room under a fresh random code. */
  static async create(transport: Transport, name: string, build: CarBuild, opts: { now?: () => number; rnd?: () => number } = {}): Promise<Room> {
    const now = opts.now ?? (() => performance.now());
    for (let tries = 0; ; tries++) {
      const code = randomCode(opts.rnd);
      const room = new Room(transport, true, code, HOST_ID, now);
      try {
        await transport.host(code, (link) => room.accept(link));
      } catch (e) {
        // somebody already has this code: roll again
        if (e instanceof TransportFailure && e.kind === 'taken' && tries < 8) continue;
        transport.destroy();
        throw e;
      }
      room.players = [{ id: HOST_ID, name, build, host: true, ping: 0 }];
      room.startTimer();
      return room;
    }
  }

  /** Join the room with this code. Resolves once the host has said welcome. */
  static async join(transport: Transport, code: string, name: string, build: CarBuild, opts: { now?: () => number } = {}): Promise<Room> {
    const now = opts.now ?? (() => performance.now());
    let link: Link;
    try {
      link = await transport.join(code);
    } catch (e) {
      transport.destroy();
      throw e;
    }
    const room = new Room(transport, false, code, '', now);
    room.hostLink = link;
    room.hostSeen = now();
    return new Promise<Room>((resolve, reject) => {
      const t = setTimeout(() => {
        room.shutdown();
        reject(new TransportFailure('not-found'));
      }, 15000);
      link.onMessage = (m) => {
        if (!isMsg(m)) return;
        if (m.t === 'welcome') {
          clearTimeout(t);
          room.myId = m.id;
          room.code = m.code;
          link.onMessage = (x) => isMsg(x) && room.fromHost(x);
          link.onClose = () => room.shutdown('host-left');
          room.startTimer();
          room.sendPing();
          resolve(room);
        } else if (m.t === 'reject') {
          clearTimeout(t);
          room.shutdown();
          reject(new RoomRejected(m.reason));
        } else if (m.t === 'roster') {
          // can arrive right before the welcome
          room.fromHost(m);
        }
      };
      link.onClose = () => {
        clearTimeout(t);
        room.shutdown();
        reject(new TransportFailure('network'));
      };
      link.send({ t: 'hello', v: PROTOCOL, name, build } satisfies Msg);
    });
  }

  get me(): RoomPlayer | undefined {
    return this.players.find((p) => p.id === this.myId);
  }

  /** The host's clock right now (ms). Sessions start on it, so every screen counts down together. */
  hostNow(): number {
    return this.now() + this.offset;
  }

  /** Convert a host-clock time to this machine's clock. */
  toLocal(hostTime: number): number {
    return hostTime - this.offset;
  }

  /** Latest round trip to the host, ms. */
  get ping(): number {
    return this.isHost ? 0 : this.rtts.length ? this.rtts[this.rtts.length - 1] : 0;
  }

  // ---------------------------------------------------------- host side

  private accept(link: Link) {
    let guest: Guest | null = null;
    link.onMessage = (m) => {
      if (!isMsg(m) || this.closed) return;
      if (!guest) {
        if (m.t !== 'hello') return;
        if (m.v !== PROTOCOL) return this.refuse(link, 'version');
        if (this.players.length >= MAX_PLAYERS) return this.refuse(link, 'full');
        const id = this.freeId();
        guest = { id, link, lastSeen: this.now() };
        this.guests.set(id, guest);
        const name = uniqueName(cleanName(m.name), this.players.map((p) => p.name));
        this.players.push({ id, name, build: sanitizeBuild(m.build), host: false, ping: 0 });
        link.send({ t: 'welcome', id, code: this.code } satisfies Msg);
        this.broadcastRoster();
        return;
      }
      guest.lastSeen = this.now();
      this.fromGuest(guest, m);
    };
    link.onClose = () => guest && this.dropGuest(guest.id);
  }

  private refuse(link: Link, reason: RejectReason) {
    link.send({ t: 'reject', reason } satisfies Msg);
    setTimeout(() => link.close(), 300);
  }

  private freeId(): string {
    for (let i = 1; ; i++) if (!this.guests.has(`p${i}`)) return `p${i}`;
  }

  private fromGuest(g: Guest, m: Msg) {
    switch (m.t) {
      case 'ping':
        g.link.send({ t: 'pong', a: m.a, h: this.now() } satisfies Msg);
        break;
      case 'profile': {
        const p = this.players.find((x) => x.id === g.id);
        if (!p) break;
        p.name = uniqueName(cleanName(m.name), this.players.filter((x) => x !== p).map((x) => x.name));
        p.build = sanitizeBuild(m.build);
        this.broadcastRoster();
        break;
      }
      case 'pong': {
        // guests echo their measured ping back so the lobby can show it
        const p = this.players.find((x) => x.id === g.id);
        if (p && Math.abs(p.ping - m.a) > 8) {
          p.ping = Math.round(m.a);
          this.broadcastRoster();
        }
        break;
      }
      case 's':
        if (!this.session || m.q !== this.session.seq) break;
        // a guest may only speak for itself
        if (m.id !== g.id) break;
        this.onState?.(m.id, m.d, m.q);
        this.relay(m, g.id);
        break;
      case 'e':
        if (!this.session || m.q !== this.session.seq) break;
        this.onEvent?.(g.id, m.d, m.q);
        this.relay({ t: 'e', from: g.id, q: m.q, d: m.d }, g.id);
        break;
      case 'bye':
        this.dropGuest(g.id);
        break;
      default:
        break;
    }
  }

  private relay(m: Msg, except: string) {
    for (const g of this.guests.values()) if (g.id !== except) g.link.send(m);
  }

  private dropGuest(id: string) {
    const g = this.guests.get(id);
    if (!g) return;
    this.guests.delete(id);
    g.link.close();
    this.players = this.players.filter((p) => p.id !== id);
    this.broadcastRoster();
  }

  private broadcastRoster() {
    const m: Msg = { t: 'roster', players: this.players, settings: this.settings, session: this.session };
    for (const g of this.guests.values()) g.link.send(m);
    this.onRoster?.();
  }

  setSettings(s: Partial<RoomSettings>) {
    if (!this.isHost) return;
    this.settings = { ...this.settings, ...s };
    this.broadcastRoster();
  }

  /** Host: start a session for everyone, going live `delayMs` from now. */
  startSession(kind: string, payload: unknown, delayMs = 4000, open = false): SessionInfo | null {
    if (!this.isHost) return null;
    this.seq += 1;
    const session: SessionInfo = { kind, payload, at: this.now() + delayMs, seq: this.seq, ...(open ? { open: true } : {}) };
    this.session = session;
    for (const g of this.guests.values()) g.link.send({ t: 'go', session } satisfies Msg);
    this.broadcastRoster();
    this.onSession?.(session);
    return session;
  }

  /** Host: end the current session; everybody goes back to the lobby. */
  endSession() {
    if (!this.isHost || !this.session) return;
    this.session = null;
    for (const g of this.guests.values()) g.link.send({ t: 'end' } satisfies Msg);
    this.broadcastRoster();
    this.onSessionEnd?.();
  }

  // ---------------------------------------------------------- guest side

  private fromHost(m: Msg) {
    this.hostSeen = this.now();
    switch (m.t) {
      case 'roster': {
        this.players = m.players;
        this.settings = m.settings;
        const had = this.session;
        this.session = m.session;
        // joined mid-session, or missed the go: the roster carries the truth (open sessions take latecomers)
        if (m.session && (!had || had.seq !== m.session.seq) && this.myId && (m.session.open || m.session.at > this.hostNow() - 1000)) this.onSession?.(m.session);
        if (!m.session && had) this.onSessionEnd?.();
        this.onRoster?.();
        break;
      }
      case 'pong': {
        const rtt = this.now() - m.a;
        this.rtts.push(rtt);
        if (this.rtts.length > 8) this.rtts.shift();
        // the fastest round trip has the least queueing in it: trust that one for the clock
        if (rtt <= this.bestRtt * 1.15 || this.rtts.length < 3) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.offset = m.h + rtt / 2 - this.now();
        }
        this.hostLink?.send({ t: 'pong', a: Math.round(rtt), h: 0 } satisfies Msg);
        break;
      }
      case 'go':
        if (this.session?.seq === m.session.seq) break;
        this.session = m.session;
        this.onSession?.(m.session);
        break;
      case 'end':
        if (!this.session) break;
        this.session = null;
        this.onSessionEnd?.();
        break;
      case 's':
        if (this.session && m.q === this.session.seq && m.id !== this.myId) this.onState?.(m.id, m.d, m.q);
        break;
      case 'e':
        if (this.session && m.q === this.session.seq && m.from !== this.myId) this.onEvent?.(m.from, m.d, m.q);
        break;
      case 'bye':
        this.shutdown('host-left');
        break;
      default:
        break;
    }
  }

  private sendPing() {
    this.hostLink?.send({ t: 'ping', a: this.now() } satisfies Msg);
  }

  /** Change my call sign or car. */
  setProfile(name: string, build: CarBuild) {
    const me = this.me;
    if (this.isHost) {
      if (me) {
        me.name = uniqueName(cleanName(name), this.players.filter((p) => p !== me).map((p) => p.name));
        me.build = build;
      }
      this.broadcastRoster();
    } else {
      this.hostLink?.send({ t: 'profile', name, build } satisfies Msg);
    }
  }

  // ---------------------------------------------------------- both

  /** Stream the state of an object I own (my car; the host also owns the AI). */
  sendState(id: string, d: unknown) {
    if (!this.session) return;
    const m: Msg = { t: 's', id, q: this.session.seq, d };
    if (this.isHost) for (const g of this.guests.values()) g.link.send(m);
    else this.hostLink?.send(m);
  }

  /** A one-off event everybody should hear about. */
  sendEvent(d: unknown) {
    if (!this.session) return;
    const m: Msg = { t: 'e', from: this.myId, q: this.session.seq, d };
    if (this.isHost) for (const g of this.guests.values()) g.link.send(m);
    else this.hostLink?.send(m);
  }

  private startTimer() {
    let n = 0;
    this.timer = setInterval(() => {
      if (this.closed) return;
      n++;
      const t = this.now();
      if (this.isHost) {
        for (const g of [...this.guests.values()]) if (t - g.lastSeen > TIMEOUT_MS) this.dropGuest(g.id);
      } else {
        // quick pings at first to lock the clock, then a heartbeat
        if (n < 6 || n % 4 === 0) this.sendPing();
        if (t - this.hostSeen > TIMEOUT_MS) this.shutdown('lost');
      }
    }, 500);
  }

  /** Leave the room (the host closes it for everyone). */
  leave() {
    if (this.closed) return;
    if (this.isHost) for (const g of this.guests.values()) g.link.send({ t: 'bye' } satisfies Msg);
    else this.hostLink?.send({ t: 'bye' } satisfies Msg);
    // give the goodbye a moment to leave before the sockets close
    setTimeout(() => this.shutdown('left'), 150);
    this.closed = true;
  }

  private shutdown(reason?: RoomCloseReason) {
    const wasClosed = this.closed && reason !== 'left';
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const g of this.guests.values()) g.link.close();
    this.guests.clear();
    this.hostLink?.close();
    this.hostLink = null;
    this.transport.destroy();
    if (reason && !wasClosed) {
      const cb = this.onClose;
      this.onClose = null;
      cb?.(reason);
    }
  }

  get isClosed() {
    return this.closed;
  }
}

export class RoomRejected extends Error {
  constructor(readonly reason: RejectReason) {
    super(reason);
  }
}

function cleanName(n: unknown): string {
  const s = String(n ?? '')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .slice(0, 14)
    .toUpperCase();
  return s || 'PILOTO';
}
