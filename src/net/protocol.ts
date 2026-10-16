import type { CarBuild } from '../car/parts';

/**
 * Online rooms: wire format and helpers. Rooms are peer-to-peer (WebRTC data
 * channels); the host's browser is the hub that every guest talks to, and the
 * room code is all a friend needs to find it.
 */

/** Bump when the messages change shape, so old and new versions refuse each other politely. */
export const PROTOCOL = 1;
export const CODE_LENGTH = 4;
export const MAX_PLAYERS = 4;
/** Peers that say nothing for this long are gone (mobile browsers rarely send a clean close). */
export const TIMEOUT_MS = 9000;
export const HOST_ID = 'h';

export function isValidCode(code: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code);
}

/** A random room code. Never starts with 0, so it reads like a number when spoken. */
export function randomCode(rnd: () => number = Math.random): string {
  let s = String(1 + Math.floor(rnd() * 9));
  while (s.length < CODE_LENGTH) s += String(Math.floor(rnd() * 10));
  return s;
}

/** The public signalling id a room is registered under. Game-prefixed so codes never collide with other apps. */
export function peerIdFor(code: string): string {
  return `hyperdrift-v${PROTOCOL}-room-${code}`;
}

/** Pick ids from a URL like /?sala=1234 (invite links). */
export function codeFromUrl(search: string): string | null {
  const p = new URLSearchParams(search);
  const c = (p.get('sala') ?? p.get('room') ?? '').trim();
  return isValidCode(c) ? c : null;
}

// ------------------------------------------------------------ players

export interface RoomPlayer {
  id: string;
  name: string;
  build: CarBuild;
  host: boolean;
  /** round trip to the host in ms (host: 0) */
  ping: number;
}

/** What a session (a race, a free-roam zone, …) was started with. Opaque to the room. */
export interface SessionInfo {
  kind: string;
  payload: unknown;
  /** host clock (ms) when the session goes live */
  at: number;
  /** increases with every session, so stale state from the last one is ignored */
  seq: number;
  /** drop-in session (the free-roam zone): people who join the room later go straight in */
  open?: boolean;
}

export interface RoomSettings {
  /** fill empty grid slots with AI rivals */
  bots: boolean;
}

// ------------------------------------------------------------ messages

export type Msg =
  | { t: 'hello'; v: number; name: string; build: CarBuild }
  | { t: 'welcome'; id: string; code: string }
  | { t: 'reject'; reason: RejectReason }
  | { t: 'roster'; players: RoomPlayer[]; settings: RoomSettings; session: SessionInfo | null }
  | { t: 'profile'; name: string; build: CarBuild }
  | { t: 'ping'; a: number }
  | { t: 'pong'; a: number; h: number }
  | { t: 'go'; session: SessionInfo }
  | { t: 'end' }
  /** per-object state stream (cars), relayed by the host; `q` = session seq */
  | { t: 's'; id: string; q: number; d: unknown }
  /** one-off session event (someone finished, …), relayed by the host */
  | { t: 'e'; from: string; q: number; d: unknown }
  | { t: 'bye' };

export type RejectReason = 'full' | 'version';

export function isMsg(x: unknown): x is Msg {
  return typeof x === 'object' && x !== null && typeof (x as { t?: unknown }).t === 'string';
}

// ------------------------------------------------------------ call signs

/** Players get a call sign instead of typing a name (no keyboard on phones). Tap the dice for another. */
export const CALL_SIGNS = [
  'FALCÃO', 'COMETA', 'RAIO', 'TUFÃO', 'ÓRBITA', 'ZÉNITE', 'NÉVOA', 'FAÍSCA',
  'TROVÃO', 'PULSAR', 'NEBULA', 'VÓRTICE', 'ÁGUIA', 'CICLONE', 'ASTRO', 'LINCE',
  'METEORO', 'AURORA', 'QUASAR', 'BRISA', 'RELÂMPAGO', 'CONDOR', 'VULCÃO', 'ECLIPSE',
];

export function randomCallSign(not?: string, rnd: () => number = Math.random): string {
  for (;;) {
    const n = CALL_SIGNS[Math.floor(rnd() * CALL_SIGNS.length)];
    if (n !== not) return n;
  }
}

/** Two players with the same call sign get a number so the board stays readable. */
export function uniqueName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let i = 2; ; i++) if (!taken.includes(`${name} ${i}`)) return `${name} ${i}`;
}
