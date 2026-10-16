/** Player-facing changelog shown on the menu. Newest hour first, at most 5 entries per hour. */
export interface PatchNoteGroup {
  hour: string;
  entries: string[];
}

export const PATCH_NOTES: PatchNoteGroup[] = [
  {
    hour: '2026-10-16 17:00 UTC',
    entries: [
      'Added a small FPS counter at the bottom of the screen.',
      'New app icon: a red supercar racing along a glowing sky track at sunset.',
      'Three chase camera distances: near, medium and far. Press C on keyboard or tap the camera button under pause; your choice is remembered.',
      'Hyperdrift demo launch: build your car part by part, race 3 rivals or chase your ghost in time trial on a track in the sky.',
    ],
  },
];
