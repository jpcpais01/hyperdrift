/** Player-facing changelog shown on the menu. Newest hour first, at most 5 entries per hour. */
export interface PatchNoteGroup {
  hour: string;
  entries: string[];
}

export const PATCH_NOTES: PatchNoteGroup[] = [
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
