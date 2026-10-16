/**
 * Part catalogue. A car is nothing but a set of chosen parts: the visual ones
 * are generated geometry that snaps onto the common skeleton (see skeleton.ts),
 * the technical ones change the driving stats (see stats.ts).
 */
import { ALL_INTERIOR_SLOTS, DEFAULT_INTERIOR, interiorOptionsFor, isInteriorSlot, type InteriorSlot } from './interiorParts';

export type GeoSlot = 'body' | 'front' | 'rear' | 'hood' | 'skirts' | 'spoiler' | 'rims' | 'headlights' | 'exhaust';

/** Per-part paint: each one is 'same' (follow the body colour) or a paint id. */
export type PaintZoneSlot = 'paintHood' | 'paintRoof' | 'paintFront' | 'paintRear' | 'paintSkirts' | 'paintSpoiler';

export type VisualSlot = GeoSlot | 'paint' | 'vinyl' | 'vinylColor' | 'rimColor' | PaintZoneSlot;

export type TechSlot = 'engine' | 'turbo' | 'nitro' | 'tires' | 'suspension' | 'weight';

export type Slot = VisualSlot | TechSlot | InteriorSlot;

export interface PartOption {
  id: string;
  name: string;
  desc: string;
  /** CSS background for a colour chip in the garage */
  swatch?: string;
}

export interface PaintOption extends PartOption {
  color: number;
  metalness: number;
  roughness: number;
  clearcoat: number;
  /** default vinyl colour for this paint */
  accent: number;
  /** special finishes: woven carbon, or a colour-shift that turns to color2 at grazing angles */
  finish?: 'carbon' | 'flip';
  color2?: number;
}

export interface ColorOption extends PartOption {
  color: number;
}

export interface TechMods {
  topSpeed?: number;
  accel?: number;
  accelMul?: number;
  topMul?: number;
  turboLow?: number;
  turboHigh?: number;
  boostPower?: number;
  boostDuration?: number;
  driftCharge?: number;
  grip?: number;
  gripMul?: number;
  driftGrip?: number;
  turn?: number;
  driftThreshold?: number;
  yawResponse?: number;
  airControl?: number;
  landingLoss?: number;
  mass?: number;
  rollAmount?: number;
  voice?: 'v6' | 'rotary' | 'v12';
  whistle?: number;
}

export interface TechOption extends PartOption {
  mods: TechMods;
}

export const VISUAL_SLOTS: { slot: VisualSlot; label: string }[] = [
  { slot: 'body', label: 'Carroçaria' },
  { slot: 'front', label: 'Frente' },
  { slot: 'rear', label: 'Traseira' },
  { slot: 'hood', label: 'Capô' },
  { slot: 'skirts', label: 'Saias' },
  { slot: 'spoiler', label: 'Spoiler' },
  { slot: 'rims', label: 'Jantes' },
  { slot: 'headlights', label: 'Faróis' },
  { slot: 'exhaust', label: 'Escape' },
  { slot: 'paint', label: 'Pintura' },
  { slot: 'vinyl', label: 'Vinil' },
];

export const TECH_SLOTS: { slot: TechSlot; label: string }[] = [
  { slot: 'engine', label: 'Motor' },
  { slot: 'turbo', label: 'Turbo' },
  { slot: 'nitro', label: 'Nitro' },
  { slot: 'tires', label: 'Pneus' },
  { slot: 'suspension', label: 'Suspensão' },
  { slot: 'weight', label: 'Peso' },
];

/**
 * Some garage entries open a row of sub-choices: the paint has one per body
 * zone, vinyls and rims have their own colour.
 */
export const SUB_SLOTS: Partial<Record<VisualSlot, { slot: VisualSlot; label: string }[]>> = {
  paint: [
    { slot: 'paint', label: 'Carroçaria' },
    { slot: 'paintHood', label: 'Capô' },
    { slot: 'paintRoof', label: 'Tejadilho' },
    { slot: 'paintFront', label: 'Frente' },
    { slot: 'paintRear', label: 'Traseira' },
    { slot: 'paintSkirts', label: 'Saias' },
    { slot: 'paintSpoiler', label: 'Spoiler' },
  ],
  vinyl: [
    { slot: 'vinyl', label: 'Padrão' },
    { slot: 'vinylColor', label: 'Cor' },
  ],
  rims: [
    { slot: 'rims', label: 'Modelo' },
    { slot: 'rimColor', label: 'Cor' },
  ],
};

export const PAINT_ZONE_SLOTS: PaintZoneSlot[] = ['paintHood', 'paintRoof', 'paintFront', 'paintRear', 'paintSkirts', 'paintSpoiler'];

export const VISUAL_PARTS: Record<GeoSlot | 'vinyl', PartOption[]> = {
  body: [
    { id: 'gt', name: 'Coupé GT', desc: 'Cabine clássica de grande turismo.' },
    { id: 'fastback', name: 'Fastback', desc: 'Tejadilho longo que desce até à traseira.' },
    { id: 'wedge', name: 'Hyper Cunha', desc: 'Cabine baixa e avançada, ombros largos.' },
  ],
  front: [
    { id: 'classic', name: 'Clássica', desc: 'Nariz arredondado e grelha discreta.' },
    { id: 'aggressive', name: 'Agressiva', desc: 'Nariz em cunha com splitter de carbono.' },
    { id: 'muscle', name: 'Muscle', desc: 'Frente alta, grelha larga e barra cromada.' },
  ],
  rear: [
    { id: 'tapered', name: 'Afunilada', desc: 'Traseira suave com barra de luz.' },
    { id: 'kamm', name: 'Corte Kamm', desc: 'Traseira cortada com lábio pato.' },
    { id: 'diffuser', name: 'Difusor', desc: 'Traseira de pista com difusor grande.' },
  ],
  hood: [
    { id: 'smooth', name: 'Liso', desc: 'Capô limpo com vinco central.' },
    { id: 'vented', name: 'Ventilado', desc: 'Duas saídas de ar de carbono.' },
    { id: 'scoop', name: 'Entrada de ar', desc: 'Tomada de ar elevada.' },
  ],
  skirts: [
    { id: 'slim', name: 'Finas', desc: 'Embaladeiras discretas.' },
    { id: 'blade', name: 'Lâmina aero', desc: 'Lâmina de carbono saliente.' },
    { id: 'wide', name: 'Largas', desc: 'Volumosas, com entradas de ar.' },
  ],
  spoiler: [
    { id: 'lip', name: 'Lábio', desc: 'Pequeno lábio na tampa.' },
    { id: 'mid', name: 'Asa média', desc: 'Asa sobre dois suportes.' },
    { id: 'gt', name: 'Asa GT', desc: 'Asa alta de carbono com placas.' },
  ],
  rims: [
    { id: 'five', name: '5 raios', desc: 'Jante clássica prateada.' },
    { id: 'mesh', name: 'Malha', desc: 'Multi-raios em grafite.' },
    { id: 'turbine', name: 'Turbina', desc: 'Disco tipo turbina, branco e preto.' },
  ],
  headlights: [
    { id: 'round', name: 'Projetores', desc: 'Dois projetores redondos por lado.' },
    { id: 'bar', name: 'Barra LED', desc: 'Faixa LED fina.' },
    { id: 'slit', name: 'Rasgados', desc: 'Faróis angulares em fenda.' },
  ],
  exhaust: [
    { id: 'twin', name: 'Duplo', desc: 'Uma saída de cada lado.' },
    { id: 'quad', name: 'Quádruplo', desc: 'Quatro saídas.' },
    { id: 'center', name: 'Central', desc: 'Saída central grande.' },
  ],
  vinyl: [
    { id: 'none', name: 'Sem vinil', desc: 'Só pintura.' },
    { id: 'stripes', name: 'Faixas', desc: 'Faixas duplas de corrida.' },
    { id: 'side', name: 'Lateral', desc: 'Faixa lateral em flecha.' },
    { id: 'shards', name: 'Estilhaços', desc: 'Padrão geométrico nas laterais.' },
    { id: 'checker', name: 'Xadrez', desc: 'Bandeira de xadrez a desfazer-se para trás.' },
    { id: 'flames', name: 'Chamas', desc: 'Chamas hot-rod a sair da frente.' },
    { id: 'camo', name: 'Camuflado', desc: 'Camuflado digital em três tons.' },
    { id: 'tiger', name: 'Tigre', desc: 'Riscas de tigre por todo o carro.' },
    { id: 'halftone', name: 'Pontilhado', desc: 'Degradê de pontos da traseira para a frente.' },
    { id: 'livery', name: 'Competição', desc: 'Faixa diagonal e número de corrida.' },
    { id: 'pinstripe', name: 'Filetes', desc: 'Filetes finos ao longo das linhas.' },
    { id: 'hex', name: 'Favo', desc: 'Favo hexagonal nas partes de baixo.' },
  ],
};

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

export const PAINTS: PaintOption[] = [
  { id: 'ruby', name: 'Vermelho Rubi', desc: 'Metalizado', color: 0xa3101a, metalness: 0.55, roughness: 0.32, clearcoat: 1, accent: 0xf2f2f2 },
  { id: 'volt', name: 'Azul Elétrico', desc: 'Metalizado', color: 0x0a4fd8, metalness: 0.6, roughness: 0.3, clearcoat: 1, accent: 0xffffff },
  { id: 'pearl', name: 'Branco Pérola', desc: 'Pérola', color: 0xe9ecef, metalness: 0.25, roughness: 0.25, clearcoat: 1, accent: 0x0b0d12 },
  { id: 'matte', name: 'Preto Mate', desc: 'Mate', color: 0x15171b, metalness: 0.1, roughness: 0.62, clearcoat: 0, accent: 0xff2f6d },
  { id: 'lava', name: 'Laranja Vulcão', desc: 'Metalizado', color: 0xe2560a, metalness: 0.5, roughness: 0.3, clearcoat: 1, accent: 0x111111 },
  { id: 'acid', name: 'Verde Ácido', desc: 'Brilhante', color: 0x63c60e, metalness: 0.3, roughness: 0.28, clearcoat: 1, accent: 0x111111 },
  { id: 'chrome', name: 'Prata Líquida', desc: 'Metal', color: 0xb9c0c8, metalness: 0.95, roughness: 0.18, clearcoat: 0.6, accent: 0x0a0a0a },
  { id: 'neon', name: 'Roxo Neon', desc: 'Pérola', color: 0x6b1fd1, metalness: 0.45, roughness: 0.28, clearcoat: 1, accent: 0x18f0ff },
  { id: 'yellow', name: 'Amarelo Corrida', desc: 'Brilhante', color: 0xf2c00c, metalness: 0.2, roughness: 0.3, clearcoat: 1, accent: 0x111111 },
  { id: 'teal', name: 'Turquesa', desc: 'Metalizado', color: 0x0c9a98, metalness: 0.55, roughness: 0.3, clearcoat: 1, accent: 0xffffff },
  { id: 'candy', name: 'Rosa Doce', desc: 'Candy', color: 0xd0125f, metalness: 0.6, roughness: 0.24, clearcoat: 1, accent: 0xffffff },
  { id: 'gold', name: 'Ouro', desc: 'Metal', color: 0xc8952c, metalness: 0.92, roughness: 0.22, clearcoat: 0.8, accent: 0x111111 },
  { id: 'gunmetal', name: 'Grafite', desc: 'Acetinado', color: 0x3a4047, metalness: 0.7, roughness: 0.45, clearcoat: 0.3, accent: 0xff6a00 },
  { id: 'flip', name: 'Camaleão', desc: 'Muda de roxo para verde', color: 0x5a1ad6, color2: 0x10d690, metalness: 0.6, roughness: 0.25, clearcoat: 1, accent: 0xffffff, finish: 'flip' },
  { id: 'sunset', name: 'Pôr-do-Sol', desc: 'Muda de laranja para magenta', color: 0xff5a1f, color2: 0xb0127a, metalness: 0.6, roughness: 0.25, clearcoat: 1, accent: 0x111111, finish: 'flip' },
  { id: 'carbon', name: 'Carbono', desc: 'Fibra de carbono à vista', color: 0x16181c, metalness: 0.3, roughness: 0.3, clearcoat: 1, accent: 0xff2f3f, finish: 'carbon' },
];
for (const p of PAINTS) {
  p.swatch =
    p.finish === 'carbon'
      ? 'repeating-linear-gradient(45deg,#111317 0 4px,#2c3036 4px 8px)'
      : p.finish === 'flip'
        ? `linear-gradient(135deg,${hex(p.color)},${hex(p.color2 ?? p.color)})`
        : hex(p.color);
}

const SAME_PAINT: PartOption = { id: 'same', name: 'Igual à carroçaria', desc: 'Segue a cor principal.' };

const color = (id: string, name: string, c: number, desc = ''): ColorOption => ({ id, name, desc, color: c, swatch: hex(c) });

export const VINYL_COLORS: ColorOption[] = [
  { id: 'auto', name: 'Automática', desc: 'Combina com a pintura.', color: -1, swatch: 'linear-gradient(135deg,#fff 50%,#111 50%)' },
  color('white', 'Branco', 0xf4f4f4),
  color('black', 'Preto', 0x0e0f12),
  color('red', 'Vermelho', 0xe0141e),
  color('yellow', 'Amarelo', 0xffcc12),
  color('orange', 'Laranja', 0xff6a12),
  color('lime', 'Lima', 0x7be014),
  color('cyan', 'Ciano', 0x18e0ff),
  color('magenta', 'Magenta', 0xff2fb4),
  color('gold', 'Dourado', 0xd6a43a),
];

export const RIM_COLORS: ColorOption[] = [
  { id: 'auto', name: 'De série', desc: 'A cor original da jante.', color: -1, swatch: 'linear-gradient(135deg,#d5dae0 50%,#3a3e44 50%)' },
  color('silver', 'Prata', 0xd5dae0),
  color('black', 'Preto brilhante', 0x111215),
  color('gunmetal', 'Grafite', 0x4a4f57),
  color('gold', 'Dourado', 0xc9a04a),
  color('bronze', 'Bronze', 0x8a5a2b),
  color('white', 'Branco', 0xf2f2f2),
  { id: 'body', name: 'Cor do carro', desc: 'Pintadas como a carroçaria.', color: -1, swatch: 'linear-gradient(135deg,#888 0,#ccc 100%)' },
];

export const TECH_PARTS: Record<TechSlot, TechOption[]> = {
  engine: [
    { id: 'v6', name: 'V6 Atmosférico', desc: 'Equilibrado e linear.', mods: { topSpeed: 71, accel: 15.5, voice: 'v6' } },
    { id: 'rotary', name: 'Rotativo', desc: 'Sobe de rotação num instante.', mods: { topSpeed: 68, accel: 18, voice: 'rotary' } },
    { id: 'v12', name: 'V12 Hyper', desc: 'Velocidade de ponta brutal.', mods: { topSpeed: 79, accel: 13.5, voice: 'v12' } },
  ],
  turbo: [
    { id: 'none', name: 'Sem turbo', desc: 'Resposta imediata em baixo.', mods: { turboLow: 1.5 } },
    { id: 'single', name: 'Turbo grande', desc: 'Empurra muito em alta.', mods: { turboHigh: 4, whistle: 1 } },
    { id: 'twin', name: 'Biturbo', desc: 'Força em toda a gama.', mods: { turboLow: 0.8, turboHigh: 2, topSpeed: 2, whistle: 0.6 } },
  ],
  nitro: [
    { id: 'burst', name: 'Explosivo', desc: 'Boost curto e muito forte.', mods: { boostPower: 1.4, boostDuration: 0.75 } },
    { id: 'long', name: 'Longo', desc: 'Boost suave que dura muito.', mods: { boostPower: 1.0, boostDuration: 1.7 } },
    { id: 'drift', name: 'Drift', desc: 'Drifts carregam muito mais boost.', mods: { boostPower: 1.1, boostDuration: 1.05, driftCharge: 1.7 } },
  ],
  tires: [
    { id: 'street', name: 'Desportivos', desc: 'Aderência e drift equilibrados.', mods: { grip: 10, driftGrip: 2.4, turn: 1.0, driftThreshold: 0.72 } },
    { id: 'slick', name: 'Slicks', desc: 'Colados ao chão, difíceis de soltar.', mods: { grip: 14, driftGrip: 3.2, turn: 1.08, driftThreshold: 0.86 } },
    { id: 'drift', name: 'Drift', desc: 'Soltam a traseira com facilidade.', mods: { grip: 8, driftGrip: 1.7, turn: 1.12, driftThreshold: 0.55, driftCharge: 1.25 } },
  ],
  suspension: [
    { id: 'sport', name: 'Desportiva', desc: 'Para tudo.', mods: { yawResponse: 8, airControl: 1, landingLoss: 0.12, rollAmount: 1 } },
    { id: 'race', name: 'Pista', desc: 'Rígida e muito precisa.', mods: { yawResponse: 11, airControl: 0.75, landingLoss: 0.22, gripMul: 1.08, rollAmount: 0.5 } },
    { id: 'rally', name: 'Rally', desc: 'Aterragens suaves e controlo no ar.', mods: { yawResponse: 6.5, airControl: 1.6, landingLoss: 0.03, rollAmount: 1.6 } },
  ],
  weight: [
    { id: 'light', name: 'Leve', desc: 'Carbono: acelera mais, mais nervoso.', mods: { mass: 1000, accelMul: 1.12, topMul: 0.985, gripMul: 0.95 } },
    { id: 'std', name: 'Normal', desc: 'Equilíbrio de série.', mods: { mass: 1300 } },
    { id: 'heavy', name: 'Pesado', desc: 'Estável, empurra os outros.', mods: { mass: 1650, accelMul: 0.88, topMul: 1.03, gripMul: 1.07 } },
  ],
};

export type CarBuild = Record<Slot, string>;

export const DEFAULT_BUILD: CarBuild = {
  body: 'gt',
  front: 'aggressive',
  rear: 'diffuser',
  hood: 'vented',
  skirts: 'blade',
  spoiler: 'mid',
  rims: 'five',
  headlights: 'bar',
  exhaust: 'quad',
  paint: 'volt',
  vinyl: 'stripes',
  vinylColor: 'auto',
  rimColor: 'auto',
  paintHood: 'same',
  paintRoof: 'matte',
  paintFront: 'same',
  paintRear: 'same',
  paintSkirts: 'same',
  paintSpoiler: 'same',
  engine: 'v6',
  turbo: 'twin',
  nitro: 'long',
  tires: 'street',
  suspension: 'sport',
  weight: 'std',
  ...DEFAULT_INTERIOR,
};

export function optionsFor(slot: Slot): PartOption[] {
  if (isInteriorSlot(slot)) return interiorOptionsFor(slot);
  if (slot === 'paint') return PAINTS;
  if ((PAINT_ZONE_SLOTS as string[]).includes(slot)) return [SAME_PAINT, ...PAINTS];
  if (slot === 'vinylColor') return VINYL_COLORS;
  if (slot === 'rimColor') return RIM_COLORS;
  if (slot in TECH_PARTS) return TECH_PARTS[slot as TechSlot];
  return VISUAL_PARTS[slot as GeoSlot | 'vinyl'];
}

/** Every slot that has its own garage entry or sub-entry. */
const ALL_VISUAL: Slot[] = [
  ...VISUAL_SLOTS.map((s) => s.slot),
  ...Object.values(SUB_SLOTS).flatMap((l) => l!.map((s) => s.slot)),
].filter((s, i, a) => a.indexOf(s) === i);

export function paintById(id: string): PaintOption {
  return PAINTS.find((p) => p.id === id) ?? PAINTS[0];
}

export function techById(slot: TechSlot, id: string): TechOption {
  return TECH_PARTS[slot].find((o) => o.id === id) ?? TECH_PARTS[slot][0];
}

export const ALL_SLOTS: Slot[] = [...ALL_VISUAL, ...TECH_SLOTS.map((s) => s.slot), ...ALL_INTERIOR_SLOTS];

/** Makes sure a stored build only references parts that exist. */
export function sanitizeBuild(b: Partial<CarBuild> | null | undefined): CarBuild {
  const out = { ...DEFAULT_BUILD };
  if (!b) return out;
  for (const slot of ALL_SLOTS) {
    const id = b[slot];
    if (id && optionsFor(slot).some((o) => o.id === id)) out[slot] = id;
  }
  return out;
}

/** Deterministic random build (used for the AI cars). */
export function randomBuild(seed: number): CarBuild {
  let x = seed * 9301 + 49297;
  const rnd = () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
  const out = { ...DEFAULT_BUILD };
  for (const slot of ALL_SLOTS) {
    const opts = optionsFor(slot);
    const pick = opts[Math.floor(rnd() * opts.length)].id;
    // keep AI cars mostly one colour: a contrasting part here and there looks deliberate, all of them looks random
    const keepDefault = (PAINT_ZONE_SLOTS as string[]).includes(slot) ? rnd() < 0.8 : slot === 'vinylColor' || slot === 'rimColor' ? rnd() < 0.5 : false;
    out[slot] = keepDefault ? opts[0].id : pick;
  }
  return out;
}
