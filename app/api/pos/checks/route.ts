// GET  /api/pos/checks?status=open&mine=1 — check list (server-scoped by default)
// POST /api/pos/checks — open a check, from a floor table (tableId) or ad hoc.
// Opening a check on a floor table flips it to "sat" — the placeholder for
// the Travola party seam ("seated" in the floor manager post-integration).
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";
import { currentServer } from "@/lib/auth";

export async function GET(req: Request) {
  const me = await currentServer();
  if (!me) return err(401, "not logged in");
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "open";
  const mine = url.searchParams.get("mine") !== "0";
  const checks = await prisma.check.findMany({
    where: {
      restaurantId: RESTAURANT_ID,
      ...(status === "all" ? {} : { status }),
      ...(mine && me.role !== "manager" ? { serverId: me.id } : {}),
    },
    orderBy: { openedAt: "desc" },
    take: 100,
    include: { items: true, payments: true },
  });
  return NextResponse.json(checks);
}

const Body = z.object({
  tableId: z.string().optional(),   // floor-view path
  tableLabel: z.string().optional(), // ad hoc path (bar tab etc.)
  guestCount: z.number().int().min(1).max(99).default(1),
  partyKey: z.string().optional(), // future Travola seam
});

export async function POST(req: Request) {
  const me = await currentServer();
  if (!me) return err(401, "not logged in");
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");

  let tableLabel = p.data.tableLabel?.trim() ?? "";
  let tableId: string | null = null;

  if (p.data.tableId) {
    const table = await prisma.floorTable.findFirst({
      where: { id: p.data.tableId, restaurantId: RESTAURANT_ID },
    });
    if (!table) return err(404, "no such table");
    if (me.role !== "manager" && table.serverId !== me.id) return err(403, "not your section");
    const existing = await prisma.check.findFirst({
      where: { restaurantId: RESTAURANT_ID, tableId: table.id, status: "open" },
    });
    if (existing) return err(409, "table already has an open check");
    tableId = table.id;
    tableLabel = table.label;
    await prisma.floorTable.update({ where: { id: table.id }, data: { state: "sat" } });
  }
  if (!tableLabel) return err(400, "tableId or tableLabel required");

  const check = await prisma.check.create({
    data: {
      restaurantId: RESTAURANT_ID,
      tableLabel,
      tableId,
      serverId: me.id,
      serverName: me.name,
      guestCount: p.data.guestCount,
      partyKey: p.data.partyKey,
    },
    include: { items: true, payments: true },
  });
  return NextResponse.json(check);
}
