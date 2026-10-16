/**
 * Interior part catalogue. The cockpit is assembled from parts exactly like
 * the outside of the car: a cabin base fitted to whatever body was chosen,
 * plus dashboard, steering wheel, mirror, gear lever and handbrake that all
 * mount on standard points of that base (see interior.ts).
 */
import type { ColorOption, PartOption } from './parts';

export type InteriorSlot = 'cockpit' | 'cabinColor' | 'dash' | 'wheel' | 'mirror' | 'shifter' | 'handbrake';
export type InteriorPartSlot = Exclude<InteriorSlot, 'cabinColor'>;

export const INTERIOR_SLOTS: { slot: InteriorSlot; label: string }[] = [
  { slot: 'cockpit', label: 'Habitáculo' },
  { slot: 'dash', label: 'Tablier' },
  { slot: 'wheel', label: 'Volante' },
  { slot: 'mirror', label: 'Retrovisor' },
  { slot: 'shifter', label: 'Alavanca' },
  { slot: 'handbrake', label: 'Travão de mão' },
];

export const INTERIOR_SUB_SLOTS: Partial<Record<InteriorSlot, { slot: InteriorSlot; label: string }[]>> = {
  cockpit: [
    { slot: 'cockpit', label: 'Forma' },
    { slot: 'cabinColor', label: 'Cor' },
  ],
};

export const INTERIOR_PARTS: Record<InteriorPartSlot, PartOption[]> = {
  cockpit: [
    { id: 'gt', name: 'Grande Turismo', desc: 'Couro macio, tablier curvo e friso de alumínio.' },
    { id: 'race', name: 'Pista', desc: 'Despido: roll-cage, carbono e bacquets.' },
    { id: 'future', name: 'Futuro', desc: 'Tablier flutuante e luz ambiente.' },
  ],
  dash: [
    { id: 'analog', name: 'Analógico', desc: 'Dois mostradores com ponteiros e relógio.' },
    { id: 'digital', name: 'Digital', desc: 'Ecrãs flutuantes e medidor de forças G.' },
    { id: 'race', name: 'Corrida', desc: 'Display de pista, luzes de mudança e interruptores.' },
  ],
  wheel: [
    { id: 'sport', name: 'Desportivo', desc: 'Três braços, couro e marca ao centro.' },
    { id: 'classic', name: 'Clássico', desc: 'Aro de madeira e braços furados.' },
    { id: 'yoke', name: 'Yoke', desc: 'Volante de corrida com ecrã e botões.' },
  ],
  mirror: [
    { id: 'classic', name: 'Clássico', desc: 'Retrovisor arredondado.' },
    { id: 'wide', name: 'Panorâmico', desc: 'Largo, vê a pista toda atrás.' },
    { id: 'race', name: 'Carbono', desc: 'Moldura de carbono, estilo pista.' },
  ],
  shifter: [
    { id: 'manual', name: 'Manual em H', desc: 'Pomo em couro e fole.' },
    { id: 'sequential', name: 'Sequencial', desc: 'Puxa para subir, empurra para descer.' },
    { id: 'gated', name: 'Grelha cromada', desc: 'Grelha aberta de metal, clique a clique.' },
  ],
  handbrake: [
    { id: 'lever', name: 'Alavanca', desc: 'Clássica, entre os bancos.' },
    { id: 'hydro', name: 'Hidráulico', desc: 'Alavanca vertical de drift.' },
    { id: 'button', name: 'Elétrico', desc: 'Interruptor com luz.' },
  ],
};

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const color = (id: string, name: string, c: number, desc = ''): ColorOption => ({ id, name, desc, color: c, swatch: hex(c) });

export const CABIN_COLORS: ColorOption[] = [
  color('black', 'Preto', 0x1b1c1f, 'Couro preto.'),
  color('red', 'Vermelho', 0x8c1118, 'Couro vermelho.'),
  color('tan', 'Caramelo', 0x94552a, 'Couro caramelo.'),
  color('ivory', 'Marfim', 0xd9d0c0, 'Couro claro.'),
  color('navy', 'Azul-marinho', 0x1b2847, 'Couro azul.'),
  color('grey', 'Cinza', 0x5b5f67, 'Alcântara cinza.'),
];

export const DEFAULT_INTERIOR: Record<InteriorSlot, string> = {
  cockpit: 'gt',
  cabinColor: 'tan',
  dash: 'digital',
  wheel: 'sport',
  mirror: 'classic',
  shifter: 'manual',
  handbrake: 'hydro',
};

export const ALL_INTERIOR_SLOTS = Object.keys(DEFAULT_INTERIOR) as InteriorSlot[];

export function interiorOptionsFor(slot: InteriorSlot): PartOption[] {
  return slot === 'cabinColor' ? CABIN_COLORS : INTERIOR_PARTS[slot];
}

export function isInteriorSlot(slot: string): slot is InteriorSlot {
  return slot in DEFAULT_INTERIOR;
}

export function cabinColor(id: string): number {
  return (CABIN_COLORS.find((c) => c.id === id) ?? CABIN_COLORS[0]).color;
}
