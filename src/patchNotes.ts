/**
 * Player-facing patch notes, shown from the main menu.
 * Every merge to main adds one short sentence here. Groups are per UTC hour,
 * newest first, at most 5 entries each; start a new group for a new hour.
 */
export interface PatchNoteGroup {
  hour: string; // 'YYYY-MM-DD HH:00 UTC'
  entries: string[];
}

export const PATCH_NOTES: PatchNoteGroup[] = [
  {
    hour: '2026-10-16 17:00 UTC',
    entries: [
      'Added a small FPS counter at the bottom of the screen.',
      'Hyperdrift demo launch: build your car part by part, race 3 rivals or chase your ghost in time trial on a track in the sky.',
    ],
  },
];
