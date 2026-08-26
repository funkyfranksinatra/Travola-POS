// lib/shift.ts — service-day clock.
// SHARED-DB build: the real service hours live in the floor app's
// RestaurantSettings (openMinutes/closeMinutes). Ephemeral things
// (server-created add-ons, custom-tab items) expire at the NEXT
// service-reset boundary — the same tick the floor app uses to wipe
// live table state (close + 90min, or open − 60min, or 4:00 AM when
// hours are unset), so "decays at shift end" now means the REAL shift.
import { prisma } from "./prisma";
// The reset rule itself is pure and lives with the other floor
// translation logic so it can be unit-tested without a database.
export { latestServiceResetBoundary } from "./floor-geometry";

// Fallbacks when the settings row is missing (scratch databases).
export const SHIFT_OPEN_HOUR = 7;
export const SHIFT_CLOSE_HOUR = 14;

/** Mirror of the floor app's latestServiceResetBoundary, projected
 *  FORWARD: the next reset tick after `now`. */
function nextResetTick(now: Date, openMinutes: number | null, closeMinutes: number | null): Date {
  let resetMin: number;
  if (closeMinutes == null) {
    resetMin = openMinutes == null ? 4 * 60 : (openMinutes - 60 + 1440) % 1440;
  } else {
    const overnight = openMinutes != null && closeMinutes <= openMinutes;
    resetMin = ((closeMinutes + (overnight ? 1440 : 0)) + 90) % 1440;
  }
  const tick = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(resetMin / 60), resetMin % 60);
  if (tick.getTime() <= now.getTime()) tick.setDate(tick.getDate() + 1);
  return tick;
}

/** The next shift-end boundary — reads the shared settings; falls back
 *  to the legacy 14:00 close on scratch databases. */
export async function nextShiftClose(restaurantId: string, now: Date = new Date()): Promise<Date> {
  try {
    const settings = await prisma.restaurantSettings.findUnique({
      where: { restaurantId },
      select: { openMinutes: true, closeMinutes: true },
    });
    if (settings) return nextResetTick(now, settings.openMinutes, settings.closeMinutes);
  } catch { /* fall through to legacy clock */ }
  const close = new Date(now);
  close.setHours(SHIFT_CLOSE_HOUR, 0, 0, 0);
  if (close <= now) close.setDate(close.getDate() + 1);
  return close;
}

/** Filter clause helper: not-yet-expired ephemeral OR permanent. */
export function unexpiredWhere(now: Date = new Date()) {
  return { OR: [{ ephemeral: false }, { expiresAt: { gt: now } }] };
}
