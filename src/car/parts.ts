/**
 * Part catalogue. A car is nothing but a set of chosen parts: the visual ones
 * are generated geometry that snaps onto the common skeleton (see skeleton.ts),
 * the technical ones change the driving stats (see stats.ts).
 */

export type VisualSlot =
  | 'body'
  | 'front'
  | 'rear'
  | 'hood'
  | 'skirts'
  | 'spoiler'
  | 'rims'
  | 'headlights'
  | 'exhaust'
  | 'paint'
  | 'vinyl';

export type TechSlot = 'engine' | 'turbo' | 'nitro' | 'tires' | 'suspension' | 'weight';

export type Slot = VisualSlot | TechSlot;

export interface PartOption {
  id: string;
  name: string;
  desc: string;
}

export interface PaintOption extends PartOption {
  color: number;
  metalness: number;
  roughness: number;
  clearcoat: number;
  accent: number;
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

export const VISUAL_PARTS: Record<Exclude<VisualSlot, 'paint'>, PartOption[]> = {
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
  ],
};

export const PAINTS: PaintOption[] = [
  { id: 'ruby', name: 'Vermelho Rubi', desc: 'Metalizado', color: 0xa3101a, metalness: 0.55, roughness: 0.32, clearcoat: 1, accent: 0xf2f2f2 },
  { id: 'volt', name: 'Azul Elétrico', desc: 'Metalizado', color: 0x0a4fd8, metalness: 0.6, roughness: 0.3, clearcoat: 1, accent: 0xffffff },
  { id: 'pearl', name: 'Branco Pérola', desc: 'Pérola', color: 0xe9ecef, metalness: 0.25, roughness: 0.25, clearcoat: 1, accent: 0x0b0d12 },
  { id: 'matte', name: 'Preto Mate', desc: 'Mate', color: 0x15171b, metalness: 0.1, roughness: 0.62, clearcoat: 0, accent: 0xff2f6d },
  { id: 'lava', name: 'Laranja Vulcão', desc: 'Metalizado', color: 0xe2560a, metalness: 0.5, roughness: 0.3, clearcoat: 1, accent: 0x111111 },
  { id: 'acid', name: 'Verde Ácido', desc: 'Brilhante', color: 0x63c60e, metalness: 0.3, roughness: 0.28, clearcoat: 1, accent: 0x111111 },
  { id: 'chrome', name: 'Prata Líquida', desc: 'Metal', color: 0xb9c0c8, metalness: 0.95, roughness: 0.18, clearcoat: 0.6, accent: 0x0a0a0a },
  { id: 'neon', name: 'Roxo Neon', desc: 'Pérola', color: 0x6b1fd1, metalness: 0.45, roughness: 0.28, clearcoat: 1, accent: 0x18f0ff },
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
  engine: 'v6',
  turbo: 'twin',
  nitro: 'long',
  tires: 'street',
  suspension: 'sport',
  weight: 'std',
};

export function optionsFor(slot: Slot): PartOption[] {
  if (slot === 'paint') return PAINTS;
  if (slot in TECH_PARTS) return TECH_PARTS[slot as TechSlot];
  return VISUAL_PARTS[slot as Exclude<VisualSlot, 'paint'>];
}

export function paintById(id: string): PaintOption {
  return PAINTS.find((p) => p.id === id) ?? PAINTS[0];
}

export function techById(slot: TechSlot, id: string): TechOption {
  return TECH_PARTS[slot].find((o) => o.id === id) ?? TECH_PARTS[slot][0];
}

export const ALL_SLOTS: Slot[] = [...VISUAL_SLOTS.map((s) => s.slot), ...TECH_SLOTS.map((s) => s.slot)];

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
    out[slot] = opts[Math.floor(rnd() * opts.length)].id;
  }
  return out;
}
