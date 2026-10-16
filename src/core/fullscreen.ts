/**
 * The manifest does not force an orientation; instead, on the first touch we
 * ask for fullscreen and try to lock to landscape (supported on Android/Chrome;
 * iOS ignores it, so the game also works in a rotated browser window).
 */
export function installFirstTouch(onFirst: () => void) {
  let done = false;
  const handler = async (e: Event) => {
    if (done) return;
    done = true;
    window.removeEventListener('pointerdown', handler, true);
    window.removeEventListener('keydown', handler, true);
    onFirst();
    const touch = e.type === 'pointerdown' && (e as PointerEvent).pointerType === 'touch';
    if (!touch) return;
    try {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (!document.fullscreenElement) {
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      }
    } catch {
      /* not allowed: fine */
    }
    try {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      await o.lock?.('landscape');
    } catch {
      /* lock unsupported (iOS / desktop) */
    }
  };
  window.addEventListener('pointerdown', handler, true);
  window.addEventListener('keydown', handler, true);
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
export const isPortrait = () => window.innerHeight > window.innerWidth;
