// GET  /api/pos/kds/:stationKey — live tickets: fired lines for this
//      station grouped by check (a "ticket" = one check's fired items here).
// POST /api/pos/kds/:stationKey — bump {checkId} (whole ticket) or {itemId}.
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err } from "@/lib/pos-api";
import { emitServiceEvents, recordBump } from "@/lib/service-events";

export async function GET(_req: Request, ctx: { params: Promise<{ stationKey: string }> }) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const { stationKey } = await ctx.params;
  const lines = await prisma.checkItem.findMany({
    where: {
      station: stationKey,
      state: "fired",
      check: { restaurantId, status: "open" },
    },
    orderBy: { firedAt: "asc" },
    include: { check: { select: { id: true, tableLabel: true, serverName: true, guestCount: true } } },
  });
  // Group into tickets by check, oldest first.
  const tickets = new Map<string, {
    checkId: string; tableLabel: string; serverName: string; guestCount: number;
    firedAt: string; items: typeof lines;
  }>();
  for (const l of lines) {
    const t = tickets.get(l.checkId);
    if (t) t.items.push(l);
    else
      tickets.set(l.checkId, {
        checkId: l.checkId,
        tableLabel: l.check.tableLabel,
        serverName: l.check.serverName,
        guestCount: l.check.guestCount,
        firedAt: l.firedAt!.toISOString(),
        items: [l],
      });
  }
  // ALL DAY rollup: totals per item name across every live ticket.
  const allDay: Record<string, number> = {};
  for (const l of lines) allDay[l.nameSnapshot] = (allDay[l.nameSnapshot] ?? 0) + l.quantity;
  return NextResponse.json({ tickets: [...tickets.values()], allDay });
}

const Body = z.union([
  z.object({ checkId: z.string().min(1) }),
  z.object({ itemId: z.string().min(1) }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ stationKey: string }> }) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const { stationKey } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const where =
    "checkId" in p.data
      ? { checkId: p.data.checkId, station: stationKey, state: "fired" }
      : { id: p.data.itemId, station: stationKey, state: "fired" };
  // Resolve the check id + course before the flip so the bus event can
  // carry pacing context (bump-by-itemId only has the item id in hand).
  const target = await prisma.checkItem.findFirst({
    where,
    select: { checkId: true, course: true, firedAt: true, check: { select: { restaurantId: true, partyKey: true, tableId: true, tableLabel: true, serverId: true } } },
  });
  if (!target || target.check.restaurantId !== restaurantId) return err(404, "nothing to bump");
  const { count } = await prisma.checkItem.updateMany({
    where,
    data: { state: "bumped", bumpedAt: new Date() },
  });
  if (!count) return err(404, "nothing to bump");
  // Shared-DB link: course pacing to the session + the bus ("entrées
  // bumped 4m ago" is the sentry's favorite fact).
  await recordBump(restaurantId, target.checkId);
  await emitServiceEvents(restaurantId, [{
    type: "COURSE_BUMPED",
    partyKey: target.check.partyKey,
    tableIds: target.check.tableId ? [target.check.tableId] : [],
    serverId: target.check.serverId,
    checkId: target.checkId,
    payload: {
      station: stationKey,
      course: target.course,
      items: count,
      tableLabel: target.check.tableLabel,
      minutesSinceFire: target.firedAt ? Math.round((Date.now() - target.firedAt.getTime()) / 60000) : null,
    },
  }]);
  return NextResponse.json({ bumped: count });
}
