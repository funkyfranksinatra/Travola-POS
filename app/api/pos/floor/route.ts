// GET /api/pos/floor — the floor view payload: every table with its
// geometry, assignment, state, and (if sat) the open check summary.
// TRAVOLA SEAM: today this reads the static default floorplan; at
// integration it reads live Travola floor state instead — the payload
// shape is designed to survive that swap unchanged.
import { NextResponse } from "next/server";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { currentServer } from "@/lib/auth";
import { err } from "@/lib/pos-api";

export async function GET() {
  const me = await currentServer();
  if (!me) return err(401, "not logged in");

  const [tables, servers, openChecks] = await Promise.all([
    prisma.floorTable.findMany({
      where: { restaurantId: RESTAURANT_ID },
      orderBy: { label: "asc" },
    }),
    prisma.serverUser.findMany({
      where: { restaurantId: RESTAURANT_ID },
      select: { id: true, name: true, color: true },
    }),
    prisma.check.findMany({
      where: { restaurantId: RESTAURANT_ID, status: "open" },
      include: { items: true },
    }),
  ]);

  const byTable = new Map(openChecks.filter((c) => c.tableId).map((c) => [c.tableId!, c]));
  return NextResponse.json({
    me: { id: me.id, name: me.name, color: me.color },
    servers,
    tables: tables.map((t) => {
      const check = byTable.get(t.id);
      return {
        ...t,
        mine: t.serverId === me.id,
        check: check
          ? {
              id: check.id,
              totalCents: check.totalCents,
              guestCount: check.guestCount,
              openedAt: check.openedAt,
              itemCount: check.items.filter((i) => i.state !== "voided").length,
            }
          : null,
      };
    }),
  });
}
