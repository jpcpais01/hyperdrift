/**
 * Fullscreen + landscape on touch devices.
 *
 * The manifest does not force an orientation; instead, the first tap asks for
 * fullscreen and locks the screen to landscape. Two details make this work:
 *  - Browsers only grant the "user activation" both APIs need on the END of a
 *    touch (pointerup / touchend / click). A touch pointerdown carries none, so
 *    requests made there are silently rejected on Android Chrome.
 *  - Leaving fullscreen (back gesture, app switch) also drops the orientation
 *    lock, so we re-arm and ask again on the next tap instead of giving up.
 * Where the APIs don't exist (iPhone Safari), the game shows a rotate hint.
 */
type FsElement = HTMLElement & { webkitRequestFullscreen?: (opts?: unknown) => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null };
type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void> };

const doc = document as FsDocument;
const root = document.documentElement as FsElement;

export const isTouch = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
export const isPortrait = () => window.innerHeight > window.innerWidth;
/** A phone (rather than a tablet): its short side is small. */
export const isPhone = () => isTouch() && Math.min(screen.width, screen.height) < 600;
export const isStandalone = () =>
  matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const fsSupported = () => !!(root.requestFullscreen || root.webkitRequestFullscreen) && document.fullscreenEnabled !== false;
const inFullscreen = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);

let lockWorks = true; // flips off once the browser says it can't lock at all
let locked = false;

/** True when this device can be put in landscape for us (so no rotate hint is needed). */
export const canLockLandscape = () => lockWorks && typeof (screen.orientation as LockableOrientation)?.lock === 'function';

async function enterFullscreen() {
  if (!fsSupported() || inFullscreen()) return;
  try {
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else await root.webkitRequestFullscreen?.();
  } catch {
    /* refused (no activation, iframe, user setting): try again on the next tap */
  }
}

async function lockLandscape() {
  const o = screen.orientation as LockableOrientation | undefined;
  if (!o?.lock || !lockWorks) return;
  try {
    await o.lock('landscape');
    locked = true;
  } catch (err) {
    locked = false;
    // NotSupportedError: this browser/device never locks (desktop, some tablets).
    // SecurityError / AbortError just mean "not now" (e.g. not fullscreen yet).
    if ((err as DOMException)?.name === 'NotSupportedError') lockWorks = false;
  }
}

/**
 * Calls `onFirst` on the very first interaction (audio unlock) and, on touch
 * devices, keeps the game fullscreen and landscape: every tap that ends while
 * we're not fullscreen/locked asks again.
 */
export function installFirstTouch(onFirst: () => void) {
  let first = true;
  let busy = false;

  const needsWork = () => (fsSupported() && !inFullscreen()) || (canLockLandscape() && !locked);

  const kick = (e: Event) => {
    if (first) {
      first = false;
      onFirst();
    }
    if (e.type === 'keydown' || busy) return;
    if (e.type === 'pointerup' && (e as PointerEvent).pointerType === 'mouse') return;
    if (!isTouch() || !needsWork()) return;
    busy = true;
    // fullscreen first: Chrome only allows the orientation lock while fullscreen
    // (or in an installed app), and the lock must follow in the same activation
    void enterFullscreen()
      .then(lockLandscape)
      .finally(() => {
        busy = false;
      });
  };

  // pointerup is where touch activation lands; touchend covers older WebKit
  for (const t of ['pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(t, kick, true);

  const onFsChange = () => {
    if (!inFullscreen()) locked = false; // exiting fullscreen releases the lock
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  // coming back from another app: the OS may have reset orientation
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !inFullscreen()) locked = false;
  });
}
