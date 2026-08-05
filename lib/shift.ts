// lib/shift.ts — placeholder shift clock.
// TRAVOLA SEAM: the POS has no real notion of service periods yet.
// Until Neon/Travola integration provides live shift state, assume a
// breakfast/lunch house: open 07:00, close 14:00 local. Everything
// ephemeral (server-created add-ons, custom-tab items) expires at the
// NEXT shift close, so a mid-shift creation dies at 14:00 today and a
// late-night test creation dies at 14:00 tomorrow.
export const SHIFT_OPEN_HOUR = 7;
export const SHIFT_CLOSE_HOUR = 14;

/** The next occurrence of shift close (14:00 local server time). */
export function nextShiftClose(now: Date = new Date()): Date {
  const close = new Date(now);
  close.setHours(SHIFT_CLOSE_HOUR, 0, 0, 0);
  if (close <= now) close.setDate(close.getDate() + 1);
  return close;
}

/** Filter clause helper: not-yet-expired ephemeral OR permanent. */
export function unexpiredWhere(now: Date = new Date()) {
  return { OR: [{ ephemeral: false }, { expiresAt: { gt: now } }] };
}
