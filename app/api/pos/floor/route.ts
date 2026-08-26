// GET /api/pos/floor — the floor view payload, now reading LIVE
// Travola floor state (shared DB): real tables, real geometry, real
// sections, real seated/bussing status — plus each table's open check.
// The payload shape survives from the standalone build (label/x/y/w/h/
// state/serverId/mine/check) with floors and party info added.
//
// Geometry: the floor app stores pixel coordinates in an unbounded
// canvas; the POS renders percent-based tiles. Each floor's tables are
// normalized into 0–100% space via their bounding box, with tile sizes
// mirrored from the floor app's capacity buckets.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { currentServer } from "@/lib/auth";
import { err } from "@/lib/pos-api";

// Mirrors the floor app's TABLE_DIMS buckets (px).
function tileSizePx(shape: string, capacity: number) {
  if (shape === "rectangle") {
    const w = capacity <= 2 ? 80 : capacity <= 4 ? 112 : capacity <= 6 ? 144 : 176;
    return { w, h: 64 };
  }
  const s = capacity <= 2 ? 64 : capacity <= 4 ? 80 : 96;
  return { w: s, h: s };
}

// Floor status → POS floor-view state.
function posState(status: string) {
  if (status === "seated" || status === "dining") return "sat";
  if (status === "bussing") return "done";
  return "open";
}

export async function GET() {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");

  const [floors, tables, servers, openChecks] = await Promise.all([
    prisma.floor.findMany({
      where: { restaurantId, active: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
    prisma.table.findMany({
      where: { restaurantId, active: true },
      orderBy: { name: "asc" },
    }),
    prisma.server.findMany({
      where: { restaurantId, active: true },
      select: { id: true, name: true, colorHex: true, roles: true },
    }),
    prisma.check.findMany({
      where: { restaurantId, status: "open" },
      include: { items: { select: { state: true } } },
    }),
  ]);

  const byTable = new Map(openChecks.filter((c) => c.tableId).map((c) => [c.tableId!, c]));

  // Per-floor bounding box (in px, tile extents included) → percent.
  const PAD = 40;
  const boxes = new Map<string, { minX: number; minY: number; spanX: number; spanY: number }>();
  for (const f of floors) {
    const own = tables.filter((t) => t.floorId === f.id);
    if (!own.length) continue;
    const minX = Math.min(...own.map((t) => t.x)) - PAD;
    const minY = Math.min(...own.map((t) => t.y)) - PAD;
    const maxX = Math.max(...own.map((t) => t.x + tileSizePx(t.shape, t.capacity).w)) + PAD;
    const maxY = Math.max(...own.map((t) => t.y + tileSizePx(t.shape, t.capacity).h)) + PAD;
    boxes.set(f.id, { minX, minY, spanX: Math.max(1, maxX - minX), spanY: Math.max(1, maxY - minY) });
  }

  return NextResponse.json({
    me,
    servers: servers.map((s) => ({ id: s.id, name: s.name, color: s.colorHex ?? "#6d79e8", role: s.roles.includes("manager") ? "manager" : "server" })),
    floors,
    tables: tables.map((t) => {
      const box = boxes.get(t.floorId);
      const size = tileSizePx(t.shape, t.capacity);
      const check = byTable.get(t.id);
      return {
        id: t.id,
        label: t.name,
        floorId: t.floorId,
        x: box ? ((t.x - box.minX) / box.spanX) * 100 : 0,
        y: box ? ((t.y - box.minY) / box.spanY) * 100 : 0,
        w: box ? (size.w / box.spanX) * 100 : 8,
        h: box ? (size.h / box.spanY) * 100 : 8,
        shape: t.shape === "round" ? "round" : "rect",
        capacity: t.capacity,
        serverId: t.assignedServerId,
        state: posState(t.status),
        party: t.party,
        partySize: t.partySize,
        seatedAt: t.seatedAt ? t.seatedAt.toISOString() : null,
        mine: me.role === "manager" || t.assignedServerId === me.id || t.assignedServerId == null,
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
