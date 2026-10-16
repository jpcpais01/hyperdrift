import { audio } from '../core/audio';
import { PATCH_NOTES } from '../patchNotes';

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export class PatchNotesScreen {
  readonly el: HTMLElement;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'screen pause hidden';
    const groups = PATCH_NOTES.map(
      (g) => `
        <h3 style="margin:14px 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase">${esc(g.hour)}</h3>
        <ul style="margin:0;padding-left:18px;line-height:1.5">${g.entries.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`,
    ).join('');
    this.el.innerHTML = `
      <div class="results-card">
        <h2>Patch notes</h2>
        ${groups}
        <div class="row"><button class="btn primary" data-a="close">Fechar</button></div>
      </div>`;
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.el || t.closest('[data-a="close"]')) {
        audio.click();
        this.show(false);
      }
    });
  }

  show(v: boolean) {
    this.el.classList.toggle('hidden', !v);
  }
}
