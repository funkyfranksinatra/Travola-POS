// GET  /api/pos/kds/:stationKey — live tickets: fired lines for this
//      station grouped by check (a "ticket" = one check's fired items here).
// POST /api/pos/kds/:stationKey — bump {checkId} (whole ticket) or {itemId}.
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";

export async function GET(_req: Request, ctx: { params: Promise<{ stationKey: string }> }) {
  const { stationKey } = await ctx.params;
  const lines = await prisma.checkItem.findMany({
    where: {
      station: stationKey,
      state: "fired",
      check: { restaurantId: RESTAURANT_ID, status: "open" },
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
  const { stationKey } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const where =
    "checkId" in p.data
      ? { checkId: p.data.checkId, station: stationKey, state: "fired" }
      : { id: p.data.itemId, station: stationKey, state: "fired" };
  const { count } = await prisma.checkItem.updateMany({
    where,
    data: { state: "bumped", bumpedAt: new Date() },
  });
  if (!count) return err(404, "nothing to bump");
  return NextResponse.json({ bumped: count });
}
