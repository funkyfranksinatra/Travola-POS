// lib/service-events.ts — the OS ↔ POS communication layer (POS side).
//
// Both apps share one database and one append-only ServiceEvent bus.
// The POS emits check-lifecycle events (opened, courses fired/bumped,
// paid, closed) and enriches the party's TableSession row with money
// and course pacing — the floor app surfaces the events live and shift
// intelligence trains on the sessions. Every helper here is
// best-effort: a bus failure must never fail the order or the payment.
import { prisma, RESTAURANT_ID } from "./prisma";

export type ServiceEventInput = {
  type: string;
  partyKey?: string | null;
  tableIds?: string[];
  serverId?: string | null;
  checkId?: string | null;
  payload?: unknown;
};

/** Date-only value for today's service day (UTC-midnight convention,
 *  matching the floor app's serviceDate columns). */
export function todayServiceDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export async function emitServiceEvents(events: ServiceEventInput[]) {
  if (!events.length) return;
  try {
    const serviceDate = todayServiceDate();
    await prisma.serviceEvent.createMany({
      data: events.map((e) => ({
        restaurantId: RESTAURANT_ID,
        source: "pos",
        type: e.type,
        partyKey: e.partyKey ?? null,
        tableIds: e.tableIds ?? [],
        serverId: e.serverId ?? null,
        checkId: e.checkId ?? null,
        serviceDate,
        payload: (e.payload ?? undefined) as never,
      })),
    });
  } catch (err) {
    console.warn("[service-events] emit failed:", err);
  }
}

/** The open TableSession for a table (clearedAt null), if any. */
export async function openSessionForTable(tableId: string) {
  try {
    return await prisma.tableSession.findFirst({
      where: { restaurantId: RESTAURANT_ID, clearedAt: null, tableIds: { has: tableId } },
      orderBy: { seatedAt: "desc" },
    });
  } catch {
    return null;
  }
}

/** Attach a freshly opened check to the party's session — or create the
 *  session when the POS itself seated the party (walk-in at the table,
 *  no host stand involved). */
export async function attachCheckToSession(opts: {
  tableId: string;
  checkId: string;
  partyKey?: string | null;
  partyName?: string | null;
  serverId?: string | null;
  guestCount: number;
}) {
  try {
    const existing = await openSessionForTable(opts.tableId);
    if (existing) {
      await prisma.tableSession.update({
        where: { id: existing.id },
        data: {
          checkId: opts.checkId,
          serverId: existing.serverId ?? opts.serverId ?? null,
          guestCount: existing.guestCount ?? opts.guestCount,
        },
      });
      return existing.id;
    }
    const created = await prisma.tableSession.create({
      data: {
        restaurantId: RESTAURANT_ID,
        serviceDate: todayServiceDate(),
        partyKey: opts.partyKey ?? null,
        partyName: opts.partyName ?? null,
        tableIds: [opts.tableId],
        primaryTableId: opts.tableId,
        serverId: opts.serverId ?? null,
        guestCount: opts.guestCount,
        seatedAt: new Date(),
        checkId: opts.checkId,
        origin: "pos",
      },
    });
    return created.id;
  } catch (err) {
    console.warn("[service-events] session attach failed:", err);
    return null;
  }
}

/** Stamp order/course pacing on the check's session. Records
 *  firstOrderAt once, lastFireAt always, and appends courseTimings. */
export async function recordFire(checkId: string, course: number, firedCount: number) {
  if (!firedCount) return;
  try {
    const session = await prisma.tableSession.findFirst({
      where: { restaurantId: RESTAURANT_ID, checkId, clearedAt: null },
    });
    if (!session) return;
    const now = new Date();
    const timings = Array.isArray(session.courseTimings) ? (session.courseTimings as unknown[]) : [];
    await prisma.tableSession.update({
      where: { id: session.id },
      data: {
        firstOrderAt: session.firstOrderAt ?? now,
        lastFireAt: now,
        courseTimings: [...timings, { course, firedAt: now.toISOString(), items: firedCount }] as never,
      },
    });
  } catch (err) {
    console.warn("[service-events] fire record failed:", err);
  }
}

/** Stamp bump pacing on the check's session. */
export async function recordBump(checkId: string) {
  try {
    await prisma.tableSession.updateMany({
      where: { restaurantId: RESTAURANT_ID, checkId, clearedAt: null },
      data: { lastBumpAt: new Date() },
    });
  } catch (err) {
    console.warn("[service-events] bump record failed:", err);
  }
}

/** Stamp the money + paid time when the check settles. */
export async function recordPaid(check: {
  id: string;
  subtotalCents: number;
  totalCents: number;
  tipCents: number;
  guestCount: number;
}) {
  try {
    const session = await prisma.tableSession.findFirst({
      where: { restaurantId: RESTAURANT_ID, checkId: check.id, clearedAt: null },
    });
    if (!session) return;
    await prisma.tableSession.update({
      where: { id: session.id },
      data: {
        checkPaidAt: new Date(),
        subtotalCents: check.subtotalCents,
        totalCents: check.totalCents,
        tipCents: check.tipCents,
        ppaCents: Math.round(check.totalCents / Math.max(1, session.guestCount ?? check.guestCount)),
      },
    });
  } catch (err) {
    console.warn("[service-events] paid record failed:", err);
  }
}
