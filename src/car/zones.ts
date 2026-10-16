/**
 * Paint zones. Every painted vertex carries one of these ids in its `zone`
 * attribute; the paint shader looks the zone's colour and finish up in a small
 * uniform table, so per-part paint costs no extra draw calls.
 */
export const ZONE = {
  body: 0,
  front: 1,
  rear: 2,
  hood: 3,
  roof: 4,
  skirts: 5,
  spoiler: 6,
  well: 7,
  /** the one-piece body shell: the shader splits it into body/front/rear/hood by position */
  auto: 8,
} as const;

export const ZONE_COUNT = 8;
