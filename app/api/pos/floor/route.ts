// GET /api/pos/floor — the floor view payload, read from LIVE Travola
// floor state (shared DB): real tables, real geometry, real sections,
// real seated/bussing status, real MERGES — plus each table's open check.
//
// Three things here are easy to get wrong and were, before this route
// was hardened:
//
//  1. MERGES. A merged party ("7 + 8") is one party on many tables. The
//     floor app models that with Table.groupId. If the POS ignores it,
//     the terminal shows two unrelated tables and a server can open two
//     checks on one party — the money then splits across two checks.
//     Every member of a group therefore reports its group, its members,
//     the group's primary table, and the group's single open check.
//
//  2. STALE LIVE STATE. Live table state is per-service-day and expires
//     at the service-reset boundary; the floor app applies that rule
//     lazily on read. The POS must apply the SAME rule or it shows last
//     night's parties as still seated while the host stand shows a clean
//     room.
//
//  3. ROTATION. The floor app rotates tables; a rotated long table's
//     footprint is not its unrotated footprint, so the bounding box that
//     normalizes pixels into percent has to use the rotated extents or
//     the room drifts.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { currentServer } from "@/lib/auth";
import { err } from "@/lib/pos-api";
import { latestServiceResetBoundary } from "@/lib/shift";
import { describeGroup, posState, rotatedSizePx, tileSizePx } from "@/lib/floor-geometry";

export async function GET() {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");

  const [floors, allTables, servers, openChecks, settings] = await Promise.all([
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
    prisma.restaurantSettings.findUnique({
      where: { restaurantId },
      select: { openMinutes: true, closeMinutes: true },
    }),
  ]);

  // A table whose floor was soft-deleted has no tab to live on and no
  // bounding box; rendering it would stack it in the corner of whatever
  // floor is showing. Drop it, exactly as the floor app does.
  const floorIds = new Set(floors.map((f) => f.id));
  const tables = allTables.filter((t) => floorIds.has(t.floorId));

  // Same daily-reset rule the floor app applies on read: live state from
  // a previous service day is served CLEAN.
  const boundary = latestServiceResetBoundary(
    new Date(),
    settings?.openMinutes ?? null,
    settings?.closeMinutes ?? null
  );
  const live = (t: (typeof tables)[number]) => {
    const fresh = t.liveUpdatedAt != null && t.liveUpdatedAt >= boundary;
    return {
      status: fresh ? t.status : "available",
      party: fresh ? t.party : null,
      partySize: fresh ? t.partySize : null,
      seatedAt: fresh ? t.seatedAt : null,
      groupId: fresh ? t.groupId : null,
      assignedServerId: fresh ? t.assignedServerId : null,
    };
  };
  const liveById = new Map(tables.map((t) => [t.id, live(t)]));

  // ── Merge groups ────────────────────────────────────────────────────
  // Members sorted by table name so "7 + 8" reads the same everywhere,
  // and the FIRST member is the group's primary — the table a merged
  // party's single check attaches to.
  const groups = new Map<string, typeof tables>();
  for (const t of tables) {
    const g = liveById.get(t.id)!.groupId;
    if (!g) continue;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const groupInfo = new Map<string, ReturnType<typeof describeGroup>>();
  for (const [g, members] of groups) {
    // A "group" of one is a stale flag, not a merge — ignore it.
    if (members.length < 2) continue;
    groupInfo.set(g, describeGroup(members));
  }

  // ── Open checks, propagated across a merged party ───────────────────
  const checkByTable = new Map<string, (typeof openChecks)[number]>();
  for (const c of openChecks) if (c.tableId) checkByTable.set(c.tableId, c);
  for (const info of groupInfo.values()) {
    const found = info.memberIds
      .map((id) => checkByTable.get(id))
      .filter((c): c is (typeof openChecks)[number] => !!c);
    const distinct = new Set(found.map((c) => c.id));
    // Exactly one check across the group → it belongs to the whole party,
    // so show it on every member. TWO checks means the tables were merged
    // after each already had one open; propagating would hide one of them
    // (and its money) behind the other. Leave those on their own tables
    // so the floor can see both and the manager can resolve it.
    if (distinct.size === 1) for (const id of info.memberIds) checkByTable.set(id, found[0]);
  }

  // ── Per-floor bounding box (rotated extents) → percent ──────────────
  const PAD = 40;
  const boxes = new Map<string, { minX: number; minY: number; spanX: number; spanY: number }>();
  for (const f of floors) {
    const own = tables.filter((t) => t.floorId === f.id);
    if (!own.length) continue;
    const minX = Math.min(...own.map((t) => t.x)) - PAD;
    const minY = Math.min(...own.map((t) => t.y)) - PAD;
    const maxX = Math.max(...own.map((t) => t.x + rotatedSizePx(t.shape, t.capacity, t.rotation).w)) + PAD;
    const maxY = Math.max(...own.map((t) => t.y + rotatedSizePx(t.shape, t.capacity, t.rotation).h)) + PAD;
    boxes.set(f.id, { minX, minY, spanX: Math.max(1, maxX - minX), spanY: Math.max(1, maxY - minY) });
  }

  return NextResponse.json({
    me,
    servers: servers.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.colorHex ?? "#6d79e8",
      role: s.roles.includes("manager") ? "manager" : "server",
    })),
    floors,
    tables: tables.map((t) => {
      const box = boxes.get(t.floorId);
      const size = tileSizePx(t.shape, t.capacity);
      const l = liveById.get(t.id)!;
      const check = checkByTable.get(t.id);
      const group = l.groupId ? groupInfo.get(l.groupId) ?? null : null;
      return {
        id: t.id,
        label: t.name,
        floorId: t.floorId,
        area: t.area,
        x: box ? ((t.x - box.minX) / box.spanX) * 100 : 0,
        y: box ? ((t.y - box.minY) / box.spanY) * 100 : 0,
        w: box ? (size.w / box.spanX) * 100 : 8,
        h: box ? (size.h / box.spanY) * 100 : 8,
        shape: t.shape === "round" ? "round" : "rect",
        rotation: t.rotation,
        capacity: t.capacity,
        serverId: l.assignedServerId,
        state: posState(l.status),
        party: l.party,
        partySize: l.partySize,
        seatedAt: l.seatedAt ? l.seatedAt.toISOString() : null,
        // Merge context — null when this table stands alone.
        groupId: group ? l.groupId : null,
        groupLabel: group?.label ?? null,
        groupMemberIds: group?.memberIds ?? null,
        groupPrimaryId: group?.primaryId ?? null,
        groupCapacity: group?.capacity ?? null,
        mine: me.role === "manager" || l.assignedServerId === me.id || l.assignedServerId == null,
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
