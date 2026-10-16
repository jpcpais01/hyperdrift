/** Tiny always-on FPS readout, updated twice a second. */
export class FpsCounter {
  private el = document.createElement('div');
  private frames = 0;
  private since = performance.now();

  constructor(parent: HTMLElement = document.body) {
    Object.assign(this.el.style, {
      position: 'fixed',
      left: '50%',
      bottom: 'calc(4px + env(safe-area-inset-bottom, 0px))',
      transform: 'translateX(-50%)',
      padding: '2px 6px',
      borderRadius: '4px',
      background: 'rgba(0, 0, 0, 0.45)',
      color: '#fff',
      font: '600 11px/1.2 ui-monospace, monospace',
      pointerEvents: 'none',
      zIndex: '9999',
    });
    this.el.textContent = '-- FPS';
    parent.appendChild(this.el);
  }

  tick(now: number) {
    this.frames++;
    const elapsed = now - this.since;
    if (elapsed >= 500) {
      this.el.textContent = `${Math.round((this.frames * 1000) / elapsed)} FPS`;
      this.frames = 0;
      this.since = now;
    }
  }
}
