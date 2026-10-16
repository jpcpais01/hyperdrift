/** Player-facing changelog shown on the menu. Newest hour first, at most 5 entries per hour. */
export interface PatchNoteGroup {
  hour: string;
  entries: string[];
}

export const PATCH_NOTES: PatchNoteGroup[] = [
  {
    hour: '2026-10-16 20:00 UTC',
    entries: [
      "Cockpit view: the driver now sits lower in the seat, for a more natural, sporty eye line that still keeps the road in full view over the dashboard.",
      "Three new car bodies with their own proportions: the compact Hot Hatch (short wheelbase, tall boxy cabin, rear wiper), the lifted Rally Raid (high ride, chunky tall-sidewall tyres, black arch cladding and roof rails) and the long, wide Protótipo (low tub between tall wheel pods, bubble canopy and a shark fin). Every body now sets its own wheelbase, track, wheel size, ride height, overhangs and roof line, so they look and sit very differently, and any mix of parts still fits.",
      'New parts in the garage: Tubarão and Rally fronts (with a spot-lamp pod), Quadrada and Jato rears, Persianas and Bossas hoods, mud flaps, a roof spoiler and the option to run without skirts or a wing, Prato fundo, Rally and Lâminas rims, Matriz LED and pop-up headlights, and Trapezoidal and Séxtupla exhausts.',
      'Underglow! A new NÉON category in the garage puts LED tubes under your car that pour coloured light onto the road, with 5 effects: steady Néon, a heartbeat Pulsar, Cometas that chase each other round the car, a flowing Arco-íris, and Reativo, which brightens and speeds up with your speed, flickers in drifts and burns white-hot on nitro. Pick from 10 colours (or your paint colour); the glow fades softly at the edges, lifts off the road on jumps, and shows on AI rivals and online cars too.',
    ],
  },
  {
    hour: '2026-10-16 20:00 UTC',
    entries: [
      'Nitro is alive now: every pipe surges on its own, flaring into huge, white-hot bursts, then choking down to sputtering puffs of violet gas before roaring back. Lighting it blows a big flare, shutting it off throws a last cloud off the pipes followed by a few crackles, the glow on the road breathes with each surge, and the engine note, camera shake, field of view and blue screen edge all kick with the big bursts.',
    ],
  },
  {
    hour: '2026-10-16 20:00 UTC',
    entries: [
      'Look around while you drive: swipe anywhere on the open screen (or drag with the mouse) to swing the camera around your car, even all the way to the front to watch the pack behind you. In the cockpit the same swipe turns your head to look over a shoulder or out the side window. Let go and the camera glides back behind the car; double-tap to snap it back straight away. The touch buttons are never affected.',
      "Cockpit view, round two: the dashboard, gauges and steering wheel now sit below the windscreen line, so the road ahead is always in full view, and the camera sits a touch lower with a wider field of view. The rear-view mirror now really shows what's behind you, flipped like a real mirror.",
      "All-new driver hands and arms: fully articulated gloves with knuckles, a thumb that wraps the rim and stitched cuffs, on smooth sleeves that bend at the elbow. Hands shuffle along the rim on tight turns, follow your head as you lean, and reach naturally for the gear lever and handbrake.",
      "Interiors rebuilt in detail: grained leather, perforated seat inserts with contrast stitching, suede headliner, brushed metal trim, stitched door cards with armrests, speakers and map pockets, padded sun visors, an overhead console, a starter button and drive-mode dial, and in the racer a window net, fire pull and riveted carbon. Gauge dials now show clean numbers.",
      'The garage has been rebuilt to be much clearer. Pick a section (Exterior, Interior or Desempenho), then a category from a list that shows what is fitted on each part, with an icon and a line on what it changes. Opening a category lists its parts with a description, an EQUIPADO tag on the one you have, and for performance parts the exact stat changes (for example ▲ Aderência +2.8) before you even try them. Paints are a grid of colour chips, the camera swings to whatever category you highlight, and a new class rating (D to S, with a score) sums up your car and shows how much each part would raise or lower it.',
    ],
  },
  {
    hour: '2026-10-16 19:00 UTC',
    entries: [
      'Nitro and boost glow on the road now fades out softly instead of ending in a hard line, and the jets thin out gently where they meet the road.',
      'Brand-new menus with a console feel. The game opens on a title screen, then the home shows your modes as big tiles over the live race: the selected one grows, glows and fills the screen with its name, details, your best lap and a big play button. Settings (sound, controls, resolution, updates, keyboard map) and patch notes now slide in as side panels, pause is a sleek side menu, and the results board counts in driver by driver with a gold finish for wins. Plug in a gamepad or use the arrows: every menu can be driven with the d-pad, A/✕ to pick, B/○ to go back and LB/RB (Q/E) to flip garage tabs, with button hints on screen.',
    ],
  },
  {
    hour: '2026-10-16 19:00 UTC',
    entries: [
      'Nitro jets are now real volumetric fire: each exhaust shoots a turbulent stream of gas that pours out of the nozzle, with a white-hot core, glowing shock diamonds and a blue-to-violet plume that tears apart at the tail, and it looks solid from any angle. Plain boosts burn orange and lift-off pops spit fireballs.',
      'Online multiplayer! Tap MULTIJOGADOR, create a room and share its 4-digit code (or the Convidar invite link) with up to 3 friends, who punch it in on the built-in number pad, no phone keyboard needed. Empty seats can be filled with AI rivals, everyone starts on the same countdown, rivals carry floating name tags, and the results board updates live as each driver crosses the line.',
      "Car bodies redesigned from the ground up: each body now has its own silhouette, with fenders rising above a sunken hood, muscular rear haunches, a waist along the doors and a stance that sits lower and wider. The GT gets fender gills, the Hyper Cunha deep flank intakes and engine-cover louvres. Every lamp, grille, intake and vent is now moulded onto the curve of the body instead of sitting on top of it, with new LED, projector and hooked headlight designs, wrap-around and C-shaped tail lights, mesh intakes, chrome bezels, dark arch liners, bigger wheels and a smooth power-dome hood. Any mix of parts still fits.",
      "Cockpit view: press C (or the camera button) until you're in the driver's seat. Your gloved hands steer the wheel, reach for the gear lever on every shift and yank the handbrake when you start a drift, the gauges are live, the rear-view mirror really shows who's behind you, and sunlight falls in through the glass. Build the interior in the garage's new INTERIOR tab: cabin style (GT leather, stripped racer with a roll cage in your paint colour, or futuristic with light strips) and leather colour, dashboard, steering wheel, mirror, gear lever and handbrake, 3 of each, and the camera sits you inside to show each part working.",
      'Chase camera raised and tilted further down at all three distances (near, medium, far), so you see more of the track ahead and around your car.',
      "Driving is now silky smooth: cars are drawn between physics steps instead of jumping from one to the next, and your car no longer digs into and pops out of the deck, so the little stutter against the ground is gone. The track no longer magically holds you on: only speed keeps you on a loop or upside down, so stop at the top and you fall. The light-tunnel corkscrew now spirals round the inside of its rings like a real coaster corkscrew, so a fast run carries you through.",
    ],
  },
  {
    hour: '2026-10-16 18:00 UTC',
    entries: [
      'Phones and tablets now get the full PC graphics: real-time sun shadows, anti-aliasing, the detailed cloud layer and sharper resolution. New RESOLUÇÃO option on the menu (and in pause): AUTO keeps the frame rate smooth by adjusting sharpness on the fly, or lock it to 50%, 75% or 100%. Your choice is remembered.',
    ],
  },
  {
    hour: '2026-10-16 18:00 UTC',
    entries: [
      'Garage camera: drag anywhere on your car to orbit all the way around it and look from above or down low, flick to let it glide, pinch (or use the mouse wheel / trackpad) to zoom in on the details, and double-tap to glide back. Leave it alone for a few seconds and the turntable starts spinning again.',
      'Fixed a big dark block that could cover most of the screen on PC when driving towards the sun. The sun now renders cleanly, and the bloom can no longer smear a single glitched pixel across the view.',
      'New ↻ ATUALIZAR button on the menu: tap it to check for the newest version of the game, install it and reload straight into it. Updates found in the background also no longer reload the game mid-race; they wait until you are back on the menu or in the garage.',
      "Phones now go fullscreen and sideways on your first tap, and snap back to it if you swipe out of fullscreen or switch apps. On iPhone, where browsers can't rotate the screen for you, a new animated hint asks you to turn your phone (and shows how to add Hyperdrift to your home screen for true fullscreen).",
      'Tilt steering on phones: open CONTROLOS on the menu (or Controlos in pause) and pick Inclinação to steer by turning your phone like a wheel. A live wheel preview, three sensitivity levels and one-tap calibration; mid-race, tap the tilt bar to recentre. Brake moves under your left thumb, gas stays on the right, and your choice is remembered.',
    ],
  },
  {
    hour: '2026-10-16 18:00 UTC',
    entries: [
      'Engines sound real now: every cylinder fires through tuned exhaust pipes, so the V6 howls, the rotary braaaps and the V12 screams. Turbos spool, whistle and pssh on lift-off, gear shifts cut and bang, the rev limiter bounces, and lifting off at high revs crackles and pops flames. Your engine, turbo, exhaust and weight all change the sound; pick one in the garage to hear it rev.',
      'Nitro: collect crystals and drift to fill your N₂O tank, then hold Space (or the new N₂O touch button) to burn it. Blue-violet jets with shock diamonds roar out of your exhaust tips. Rivals use it too.',
      'Cars got a big visual upgrade: real wheel arches (no more wheels poking through the body), flared fenders, door and hood shut lines, painted roof pillars, mirrors, wipers, door handles, tyre tread, lug nuts and drilled brake discs, plus far more detail on every bumper, hood, skirt, wing, light and exhaust.',
      'Paint shop: paint the hood, roof, front, rear, skirts and spoiler separately, pick a vinyl colour and a rim colour, and try 8 new vinyls (checkers, flames, camo, tiger, halftone, race livery with a number, pinstripes, honeycomb) and new finishes like exposed carbon and colour-shift paint.',
      'Realistic lighting overhaul: a deep golden-hour sky with a real sun, haze that glows warm towards the sun, a sea of clouds lit with silver linings, and sculpted floating islands. Cars cast sun shadows on PC, the road has a grainy asphalt sheen, and the sun flares when it peeks out.',
    ],
  },
  {
    hour: '2026-10-16 17:00 UTC',
    entries: [
      'Real car collisions: every car now has a solid hitbox matching its actual parts, so no more ghosting through rivals. Hits bounce, shove, spin you on off-centre taps, and throw sparks with a proper crunch.',
      'Added a small FPS counter at the bottom of the screen.',
      'New app icon: a red supercar racing along a glowing sky track at sunset.',
      'Three chase camera distances: near, medium and far. Press C on keyboard or tap the camera button under pause; your choice is remembered.',
      'Hyperdrift demo launch: build your car part by part, race 3 rivals or chase your ghost in time trial on a track in the sky.',
    ],
  },
];
