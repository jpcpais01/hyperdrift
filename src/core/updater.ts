import { registerSW } from 'virtual:pwa-register';

/**
 * App updates. The service worker auto-updates (skipWaiting + clientsClaim), but we decide
 * when the page reloads onto the new version: never mid-race, and on demand from the menu's
 * refresh button, which forces a check so the latest deploy actually loads.
 */
export type UpdatePhase = 'idle' | 'checking' | 'installing' | 'reloading';

let registration: ServiceWorkerRegistration | undefined;
let reloadPending = false;
let manual = false;
let canReload: () => boolean = () => true;
const listeners = new Set<(p: UpdatePhase) => void>();

const CHECK_EVERY_MS = 10 * 60 * 1000;

function emit(p: UpdatePhase) {
  for (const l of listeners) l(p);
}

function reload() {
  emit('reloading');
  window.location.reload();
}

export function initUpdater(opts: { canReload: () => boolean }) {
  canReload = opts.canReload;
  registerSW({
    immediate: true,
    onRegisteredSW(_url, r) {
      registration = r;
      if (!r) return;
      setInterval(() => void r.update().catch(() => {}), CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void r.update().catch(() => {});
      });
    },
    // a new version just took control of this page
    onNeedReload() {
      if (manual || canReload()) reload();
      else reloadPending = true;
    },
  });
}

/** Call when the app reaches a safe spot (menu/garage) to apply an update that arrived mid-race. */
export function applyPendingUpdate() {
  if (reloadPending && canReload()) reload();
}

export function onUpdatePhase(fn: (p: UpdatePhase) => void) {
  listeners.add(fn);
}

/** Refresh button: look for a new deploy, install it if there is one, then reload. */
export async function checkAndReload() {
  if (manual) return;
  manual = true;
  if (reloadPending) return reload();
  const r = registration;
  if (!r || !navigator.onLine) return reload();
  emit('checking');
  try {
    await Promise.race([r.update(), new Promise((res) => setTimeout(res, 6000))]);
  } catch {
    return reload();
  }
  const incoming = r.installing ?? r.waiting;
  if (!incoming) return reload();
  emit('installing');
  // workbox activates it (skipWaiting) and onNeedReload reloads us; this is the safety net
  incoming.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(reload, 15000);
}
