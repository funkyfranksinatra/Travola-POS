// lib/floor-geometry.ts — pure translation from the floor app's world
// into the terminal's. No I/O, no Next imports: this is the part that
// has to be exactly right, so it must be unit-testable on its own.
//
// The floor app paints tables on an unbounded pixel canvas with a
// capacity-driven tile size and an optional rotation. The POS paints
// percent-positioned tiles inside a fixed panel. Everything needed to
// get from one to the other lives here.

/** Mirrors the floor app's TABLE_DIMS capacity buckets (px). */
export function tileSizePx(shape: string, capacity: number) {
  if (shape === "rectangle") {
    const w = capacity <= 2 ? 80 : capacity <= 4 ? 112 : capacity <= 6 ? 144 : 176;
    return { w, h: 64 };
  }
  const s = capacity <= 2 ? 64 : capacity <= 4 ? 80 : 96;
  return { w: s, h: s };
}

/** Axis-aligned footprint of a tile rotated `rotation` degrees about its
 *  centre — the extent the floor app actually paints. Using the
 *  unrotated size here lets a rotated communal table push the room's
 *  bounding box off and drift every tile on that floor. */
export function rotatedSizePx(shape: string, capacity: number, rotation: number) {
  const { w, h } = tileSizePx(shape, capacity);
  const rad = (((rotation % 360) + 360) % 360) * (Math.PI / 180);
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  // Rounded: trigonometric noise (a 180° turn yields h = 64.0000000000003)
  // would otherwise leak sub-pixel jitter into the bounding box and make
  // the function awkward to assert on.
  const round = (n: number) => Math.round(n * 100) / 100;
  return { w: round(w * cos + h * sin), h: round(w * sin + h * cos) };
}

/** Floor status → POS floor-view state. `bussing` is kept DISTINCT from
 *  `done`: one means "guests gone, needs a busser", the other means
 *  "check settled". Collapsing them hides work from the floor. */
export function posState(status: string) {
  if (status === "seated" || status === "dining") return "sat";
  if (status === "bussing") return "bussing";
  if (status === "reserved") return "reserved";
  return "open";
}

/** Sort order for the tables of a merged party: natural (numeric-aware)
 *  by table name, so "7 + 8 + 10" never reads "10 + 7 + 8" and the
 *  primary (first member) is stable across both apps. */
export const tableCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Group members → the merge's display facts. */
export function describeGroup<T extends { id: string; name: string; capacity: number }>(members: T[]) {
  const sorted = [...members].sort((a, b) => tableCollator.compare(a.name, b.name));
  return {
    memberIds: sorted.map((m) => m.id),
    label: sorted.map((m) => m.name).join(" + "),
    primaryId: sorted[0].id,
    capacity: sorted.reduce((sum, m) => sum + m.capacity, 0),
  };
}

/** The MOST RECENT reset tick at or before `now` — the floor app's
 *  latestServiceResetBoundary, mirrored exactly. Live table state older
 *  than this belongs to a previous service day and must read as clean.
 *  Keep in sync with Travola-OS lib/service-events.ts. */
export function latestServiceResetBoundary(
  now: Date,
  openMinutes: number | null,
  closeMinutes: number | null
): Date {
  let resetMin: number;
  if (closeMinutes == null) {
    resetMin = openMinutes == null ? 4 * 60 : (openMinutes - 60 + 1440) % 1440;
  } else {
    const overnight = openMinutes != null && closeMinutes <= openMinutes;
    resetMin = ((closeMinutes + (overnight ? 1440 : 0)) + 90) % 1440;
  }
  const tick = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(resetMin / 60), resetMin % 60);
  if (tick.getTime() > now.getTime()) tick.setDate(tick.getDate() - 1);
  return tick;
}
