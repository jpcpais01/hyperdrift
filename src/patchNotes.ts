/** Player-facing changelog shown on the menu. Newest hour first, at most 5 entries per hour. */
export interface PatchNoteGroup {
  hour: string;
  entries: string[];
}

export const PATCH_NOTES: PatchNoteGroup[] = [
  {
    hour: '2026-10-16 17:00 UTC',
    entries: [
      'Three chase camera distances: near, medium and far. Press C on keyboard or tap the camera button under pause; your choice is remembered.',
    ],
  },
];
