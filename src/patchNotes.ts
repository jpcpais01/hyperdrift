/** Player-facing changelog shown on the menu. Newest hour first, at most 5 entries per hour. */
export interface PatchNoteGroup {
  hour: string;
  entries: string[];
}

export const PATCH_NOTES: PatchNoteGroup[] = [
  {
    hour: '2026-10-16 18:00 UTC',
    entries: [
      'Tilt steering on phones: open CONTROLOS on the menu (or Controlos in pause) and pick Inclinação to steer by turning your phone like a wheel. A live wheel preview, three sensitivity levels and one-tap calibration; mid-race, tap the tilt bar to recentre. Brake moves under your left thumb, gas stays on the right, and your choice is remembered.',
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
