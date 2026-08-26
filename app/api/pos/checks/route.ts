// GET  /api/pos/checks?status=open&mine=1 — check list (server-scoped by default)
// POST /api/pos/checks — open a check, from a floor table (tableId) or ad hoc.
//
// SHARED-DB build: tableId is the LIVE Travola Table.id. Opening a
// check resolves the party seam (partyKey = the seated reservation /
// walk-in the floor already tracks), attaches the check to the party's
// TableSession, and emits CHECK_OPENED on the event bus. Opening a
// check on an AVAILABLE table seats it (a walk-in sat by their server
// without the host stand) — the floor app sees the party appear live.
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err } from "@/lib/pos-api";
import { currentServer, persistableServerId } from "@/lib/auth";
import { attachCheckToSession, emitServiceEvents, todayServiceDate } from "@/lib/service-events";

export async function GET(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "open";
  const mine = url.searchParams.get("mine") !== "0";
  const checks = await prisma.check.findMany({
    where: {
      restaurantId,
      ...(status === "all" ? {} : { status }),
      ...(mine && me.role !== "manager" ? { serverId: me.id } : {}),
    },
    orderBy: { openedAt: "desc" },
    take: 100,
    include: { items: true, payments: true },
  });
  return NextResponse.json(checks);
}

/** Best-effort party-seam resolution: the SEATED reservation attached
 *  to this table today, else the SEATED walk-in matching the party
 *  label. Raw SQL because Reservation/WaitlistEntry aren't mirrored in
 *  the POS client — read-only, indexed, and guarded. */
async function resolvePartyKey(restaurantId: string, tableId: string, partyName: string | null) {
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT r."id" FROM "Reservation" r
      JOIN "ReservationTable" rt ON rt."reservationId" = r."id"
      WHERE r."restaurantId" = ${restaurantId}
        AND r."serviceDate" = ${todayServiceDate()}::date
        AND r."status" = 'SEATED'
        AND rt."tableId" = ${tableId}
      ORDER BY r."seatedTime" DESC NULLS LAST
      LIMIT 1`;
    if (rows.length) return rows[0].id;
    if (partyName) {
      const walkIns = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT w."id" FROM "WaitlistEntry" w
        WHERE w."restaurantId" = ${restaurantId}
          AND w."serviceDate" = ${todayServiceDate()}::date
          AND w."status" = 'SEATED'
          AND w."name" = ${partyName}
        ORDER BY w."seatedTime" DESC NULLS LAST
        LIMIT 1`;
      if (walkIns.length) return walkIns[0].id;
    }
  } catch (e) {
    console.warn("[pos/checks] party seam lookup failed:", e);
  }
  return null;
}

const Body = z.object({
  tableId: z.string().optional(),   // floor-view path
  tableLabel: z.string().optional(), // ad hoc path (bar tab etc.)
  guestCount: z.number().int().min(1).max(99).default(1),
  partyKey: z.string().optional(), // explicit seam override
});

export async function POST(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");

  let tableLabel = p.data.tableLabel?.trim() ?? "";
  let tableId: string | null = null;
  let partyKey: string | null = p.data.partyKey ?? null;
  let partyName: string | null = null;
  let seatedByPos = false;

  if (p.data.tableId) {
    const table = await prisma.table.findFirst({
      where: { id: p.data.tableId, restaurantId, active: true },
    });
    if (!table) return err(404, "no such table");
    if (me.role !== "manager" && table.assignedServerId != null && table.assignedServerId !== me.id)
      return err(403, "not your section");
    const existing = await prisma.check.findFirst({
      where: { restaurantId, tableId: table.id, status: "open" },
    });
    if (existing) return err(409, "table already has an open check");
    tableId = table.id;
    tableLabel = table.name;
    partyName = table.party;

    if (table.status === "available") {
      // POS-side seat: the server sat a walk-in at their table without
      // the host stand. Write live floor state so the host sees it.
      seatedByPos = true;
      await prisma.table.update({
        where: { id: table.id },
        data: {
          status: "seated",
          party: `Walk-in (${me.name})`,
          partySize: p.data.guestCount,
          seatedAt: new Date(),
          liveUpdatedAt: new Date(),
        },
      });
      partyName = `Walk-in (${me.name})`;
    }
    if (!partyKey) partyKey = await resolvePartyKey(restaurantId, table.id, table.party);
  }
  if (!tableLabel) return err(400, "tableId or tableLabel required");

  const check = await prisma.check.create({
    data: {
      restaurantId,
      tableLabel,
      tableId,
      serverId: persistableServerId(me),
      serverName: me.name,
      guestCount: p.data.guestCount,
      partyKey,
    },
    include: { items: true, payments: true },
  });

  if (tableId) {
    await attachCheckToSession({
      restaurantId,
      tableId,
      checkId: check.id,
      partyKey,
      partyName,
      serverId: persistableServerId(me),
      guestCount: p.data.guestCount,
    });
  }
  await emitServiceEvents(restaurantId, [
    ...(seatedByPos && tableId
      ? [{
          type: "TABLE_SEATED",
          partyKey,
          tableIds: [tableId],
          serverId: persistableServerId(me),
          payload: { party: partyName, partySize: p.data.guestCount, origin: "pos_walk_in" },
        }]
      : []),
    {
      type: "CHECK_OPENED",
      partyKey,
      tableIds: tableId ? [tableId] : [],
      serverId: persistableServerId(me),
      checkId: check.id,
      payload: { tableLabel, guestCount: p.data.guestCount, serverName: me.name },
    },
  ]);

  return NextResponse.json(check);
}
