import { audio, MIX_CHANNELS, type Mix, type MixChannel } from '../core/audio';

/** Mixer channel names and what each one covers. */
const LABELS: Record<MixChannel, [string, string]> = {
  master: ['Geral', 'Tudo de uma vez'],
  engine: ['Motores', 'O teu carro e os rivais'],
  sfx: ['Efeitos', 'Pneus, vento, embates e boost'],
  ui: ['Interface', 'Menus, contagem e voltas'],
};
const STEPS = 10;

const pct = (v: number) => `${Math.round(v * 100)}`;

/**
 * Segmented volume bars, one row per mixer channel. Drag or tap the bars,
 * or focus a row and push left / right (keys, d-pad, stick).
 */
export function volumeRows(mix: Mix) {
  return MIX_CHANNELS.map((ch) => {
    const [name, sub] = LABELS[ch];
    return `<button class="vol-row" data-vol="${ch}" data-adjust role="slider" aria-label="Volume: ${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct(mix[ch])}">
      <span class="vol-name"><b>${name}</b><small>${sub}</small></span>
      <span class="vol-bars">${Array.from({ length: STEPS }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</span>
      <em class="vol-pct">${pct(mix[ch])}</em>
    </button>`;
  }).join('');
}

/** Wires up the rows `volumeRows` drew inside `root`. */
export class VolumeBars {
  private lastPreview = 0;

  constructor(
    private root: HTMLElement,
    private onChange: (ch: MixChannel, v: number) => void,
  ) {
    for (const row of root.querySelectorAll<HTMLElement>('.vol-row')) {
      const ch = row.dataset.vol as MixChannel;
      row.addEventListener('nav-adjust', (e) => this.change(ch, audio.mix[ch] + (e as CustomEvent<number>).detail / STEPS));
      const bars = row.querySelector<HTMLElement>('.vol-bars')!;
      const fromX = (x: number) => {
        const r = bars.getBoundingClientRect();
        // a little dead zone at the left end makes zero easy to hit
        const f = (x - r.left) / r.width;
        return f < 0.04 ? 0 : Math.ceil(Math.min(1, f) * STEPS) / STEPS;
      };
      bars.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        bars.setPointerCapture(e.pointerId);
        row.classList.add('drag');
        this.change(ch, fromX(e.clientX));
      });
      bars.addEventListener('pointermove', (e) => {
        if (bars.hasPointerCapture(e.pointerId)) this.change(ch, fromX(e.clientX));
      });
      const end = () => row.classList.remove('drag');
      bars.addEventListener('pointerup', end);
      bars.addEventListener('pointercancel', end);
    }
    this.set(audio.mix);
  }

  private change(ch: MixChannel, v: number) {
    v = Math.round(Math.max(0, Math.min(1, v)) * STEPS) / STEPS;
    if (v === audio.mix[ch]) return;
    this.onChange(ch, v);
    const now = performance.now();
    if (v > 0 && now - this.lastPreview > 110) {
      this.lastPreview = now;
      audio.preview(ch);
    }
  }

  /** Redraws the bars (call after the mix changed anywhere). */
  set(mix: Mix) {
    for (const row of this.root.querySelectorAll<HTMLElement>('.vol-row')) {
      const v = mix[row.dataset.vol as MixChannel];
      const lit = Math.round(v * STEPS);
      row.querySelectorAll('.vol-bars i').forEach((b, i) => b.classList.toggle('on', i < lit));
      row.querySelector('.vol-pct')!.textContent = pct(v);
      row.setAttribute('aria-valuenow', pct(v));
      row.classList.toggle('zero', lit === 0);
    }
  }

  setMuted(m: boolean) {
    this.root.classList.toggle('muted', m);
  }
}
