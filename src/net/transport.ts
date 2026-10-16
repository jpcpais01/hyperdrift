import { peerIdFor } from './protocol';

/** One live connection to another player. */
export interface Link {
  send(msg: unknown): void;
  close(): void;
  onMessage: ((msg: unknown) => void) | null;
  onClose: (() => void) | null;
}

export type TransportError = 'taken' | 'not-found' | 'network' | 'unsupported';

export class TransportFailure extends Error {
  constructor(readonly kind: TransportError) {
    super(kind);
  }
}

/**
 * How players find each other. The game only needs "open a room under this
 * code" and "connect to the room with this code"; tests swap in a memory one.
 */
export interface Transport {
  /** Register as the host of `code`. Rejects with 'taken' if someone else has it. */
  host(code: string, onLink: (link: Link) => void): Promise<void>;
  join(code: string): Promise<Link>;
  destroy(): void;
}

const JOIN_TIMEOUT = 15000;

/**
 * WebRTC through PeerJS: its free public broker introduces the two browsers
 * (no account, no keys), then everything flows directly between them, falling
 * back to PeerJS's public TURN relay on strict networks. Loaded on demand so
 * single player never pays for it.
 */
export class PeerTransport implements Transport {
  private peer: import('peerjs').Peer | null = null;
  private dead = false;

  private async make(id?: string): Promise<import('peerjs').Peer> {
    if (typeof RTCPeerConnection === 'undefined') throw new TransportFailure('unsupported');
    const { Peer } = await import('peerjs');
    const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
    this.peer = peer;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new TransportFailure('network')), JOIN_TIMEOUT);
      peer.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      peer.once('error', (e) => {
        clearTimeout(t);
        reject(new TransportFailure(e.type === 'unavailable-id' ? 'taken' : e.type === 'browser-incompatible' ? 'unsupported' : 'network'));
      });
    });
    // the broker drops idle sockets; reconnect so the code stays joinable (open links are unaffected)
    peer.on('disconnected', () => {
      if (!this.dead && !peer.destroyed) setTimeout(() => !this.dead && !peer.destroyed && peer.reconnect(), 1000);
    });
    return peer;
  }

  async host(code: string, onLink: (link: Link) => void) {
    const peer = await this.make(peerIdFor(code));
    peer.on('connection', (conn) => {
      conn.on('open', () => onLink(wrap(conn)));
    });
  }

  async join(code: string): Promise<Link> {
    const peer = await this.make();
    // unordered: car states are newest-wins anyway, and a lost packet never stalls the rest
    const conn = peer.connect(peerIdFor(code), { reliable: false, serialization: 'json' });
    return new Promise<Link>((resolve, reject) => {
      const t = setTimeout(() => reject(new TransportFailure('not-found')), JOIN_TIMEOUT);
      conn.once('open', () => {
        clearTimeout(t);
        resolve(wrap(conn));
      });
      peer.once('error', (e) => {
        clearTimeout(t);
        reject(new TransportFailure(e.type === 'peer-unavailable' ? 'not-found' : 'network'));
      });
    });
  }

  destroy() {
    this.dead = true;
    this.peer?.destroy();
    this.peer = null;
  }
}

function wrap(conn: import('peerjs').DataConnection): Link {
  const link: Link = {
    send: (m) => {
      if (conn.open) void conn.send(m);
    },
    close: () => conn.close(),
    onMessage: null,
    onClose: null,
  };
  conn.on('data', (d) => link.onMessage?.(d));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    link.onClose?.();
  };
  conn.on('close', close);
  conn.on('error', close);
  return link;
}

// ------------------------------------------------------------ in-memory (tests)

/** A shared "internet" for MemoryTransport instances. */
export class MemoryNet {
  rooms = new Map<string, (link: Link) => void>();
  /** delivery delay in ms (0 = synchronous via microtask) */
  latency = 0;
}

export class MemoryTransport implements Transport {
  private code: string | null = null;
  constructor(private net: MemoryNet) {}

  async host(code: string, onLink: (link: Link) => void) {
    if (this.net.rooms.has(code)) throw new TransportFailure('taken');
    this.net.rooms.set(code, onLink);
    this.code = code;
  }

  async join(code: string): Promise<Link> {
    const accept = this.net.rooms.get(code);
    if (!accept) throw new TransportFailure('not-found');
    const [a, b] = memoryPair(this.net);
    accept(b);
    return a;
  }

  destroy() {
    if (this.code) this.net.rooms.delete(this.code);
  }
}

function memoryPair(net: MemoryNet): [Link, Link] {
  let open = true;
  const mk = (): Link => ({ send: () => {}, close: () => {}, onMessage: null, onClose: null });
  const a = mk();
  const b = mk();
  const deliver = (to: Link, m: unknown) => {
    if (!open) return;
    const copy = JSON.parse(JSON.stringify(m));
    const go = () => open && to.onMessage?.(copy);
    if (net.latency > 0) setTimeout(go, net.latency);
    else queueMicrotask(go);
  };
  const close = () => {
    if (!open) return;
    open = false;
    queueMicrotask(() => {
      a.onClose?.();
      b.onClose?.();
    });
  };
  a.send = (m) => deliver(b, m);
  b.send = (m) => deliver(a, m);
  a.close = close;
  b.close = close;
  return [a, b];
}

// ------------------------------------------------------------ same-device (dev / tests)

type BcMsg =
  | { k: 'who'; code: string; ask: string }
  | { k: 'here'; code: string; ask: string }
  | { k: 'conn'; code: string; link: string }
  | { k: 'acc'; link: string }
  | { k: 'm'; to: string; d: unknown }
  | { k: 'x'; to: string };

/**
 * Rooms between tabs of the same browser (open the game with ?lan). No
 * network at all: handy for trying online play on one machine.
 */
export class BroadcastTransport implements Transport {
  private ch = new BroadcastChannel('hyperdrift-lan');
  private links = new Map<string, Link>();
  private code: string | null = null;
  private onLink: ((l: Link) => void) | null = null;
  private waiters = new Map<string, (m: BcMsg) => void>();

  constructor() {
    this.ch.onmessage = (e) => this.handle(e.data as BcMsg);
  }

  private handle(m: BcMsg) {
    switch (m.k) {
      case 'who':
        if (m.code === this.code) this.ch.postMessage({ k: 'here', code: m.code, ask: m.ask } satisfies BcMsg);
        break;
      case 'here':
      case 'acc':
        this.waiters.get(m.k === 'here' ? m.ask : m.link)?.(m);
        break;
      case 'conn':
        if (m.code === this.code && this.onLink) {
          const l = this.makeLink(m.link + 'h', m.link + 'g');
          this.ch.postMessage({ k: 'acc', link: m.link } satisfies BcMsg);
          this.onLink(l);
        }
        break;
      case 'm':
        this.links.get(m.to)?.onMessage?.(m.d);
        break;
      case 'x': {
        const l = this.links.get(m.to);
        this.links.delete(m.to);
        l?.onClose?.();
        break;
      }
    }
  }

  private makeLink(me: string, peer: string): Link {
    const link: Link = {
      send: (d) => this.ch.postMessage({ k: 'm', to: peer, d } satisfies BcMsg),
      close: () => {
        if (!this.links.delete(me)) return;
        this.ch.postMessage({ k: 'x', to: peer } satisfies BcMsg);
        queueMicrotask(() => link.onClose?.());
      },
      onMessage: null,
      onClose: null,
    };
    this.links.set(me, link);
    return link;
  }

  private wait(key: string, ms: number): Promise<BcMsg | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(key);
        resolve(null);
      }, ms);
      this.waiters.set(key, (m) => {
        clearTimeout(t);
        this.waiters.delete(key);
        resolve(m);
      });
    });
  }

  async host(code: string, onLink: (link: Link) => void) {
    const ask = Math.random().toString(36).slice(2);
    this.ch.postMessage({ k: 'who', code, ask } satisfies BcMsg);
    if (await this.wait(ask, 200)) throw new TransportFailure('taken');
    this.code = code;
    this.onLink = onLink;
  }

  async join(code: string): Promise<Link> {
    const id = Math.random().toString(36).slice(2);
    const p = this.wait(id, 2000);
    this.ch.postMessage({ k: 'conn', code, link: id } satisfies BcMsg);
    if (!(await p)) throw new TransportFailure('not-found');
    return this.makeLink(id + 'g', id + 'h');
  }

  destroy() {
    for (const l of [...this.links.values()]) l.close();
    this.code = null;
    this.onLink = null;
    this.ch.close();
  }
}
