// POST /api/pos/checks/:id/items — add held lines to an open check.
// The SERVER resolves name/price/station snapshots from the live menu;
// the client sends only ids + choices. 86'd items are rejected here.
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err, assertOpen, recomputeCheck } from "@/lib/pos-api";

const Body = z.object({
  lines: z
    .array(
      z.object({
        menuItemId: z.string().min(1),
        quantity: z.number().int().min(1).max(99).default(1),
        seat: z.number().int().min(1).max(99).optional(),
        course: z.number().int().min(1).max(9).default(1),
        modifierIds: z.array(z.string()).default([]),
        addOnIds: z.array(z.string()).default([]),
        note: z.string().max(200).default(""),
      })
    )
    .min(1),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");

  const check = await prisma.check.findFirst({
    where: { id, restaurantId: RESTAURANT_ID },
  });
  const bad = assertOpen(check);
  if (bad) return err(check ? 409 : 404, bad);

  // Resolve snapshots server-side.
  const now = new Date();
  const itemIds = [...new Set(p.data.lines.map((l) => l.menuItemId))];
  const allAddOnIds = [...new Set(p.data.lines.flatMap((l) => l.addOnIds))];
  const [menuItems, addOns] = await Promise.all([
    prisma.menuItem.findMany({
      where: { id: { in: itemIds }, restaurantId: RESTAURANT_ID },
      include: { modifierGroups: { include: { modifiers: true } } },
    }),
    allAddOnIds.length
      ? prisma.addOn.findMany({ where: { id: { in: allAddOnIds }, restaurantId: RESTAURANT_ID } })
      : Promise.resolve([]),
  ]);
  const byId = new Map(menuItems.map((m) => [m.id, m]));
  const addOnById = new Map(addOns.map((a) => [a.id, a]));

  const creates = [];
  for (const line of p.data.lines) {
    const mi = byId.get(line.menuItemId);
    if (!mi) return err(404, `no such menu item: ${line.menuItemId}`);
    if (!mi.active) return err(409, `86'd: ${mi.name}`);
    if (mi.ephemeral && (!mi.expiresAt || mi.expiresAt <= now))
      return err(409, `custom item expired: ${mi.name}`);
    // Only modifiers that belong to this item's groups are legal.
    const legal = new Map(
      mi.modifierGroups.flatMap((g) => g.modifiers.map((m) => [m.id, m] as const))
    );
    const mods = [];
    for (const modId of line.modifierIds) {
      const m = legal.get(modId);
      if (!m) return err(400, `modifier not on item: ${modId}`);
      mods.push({ name: m.name, priceCents: m.priceCents });
    }
    // Add-ons: item-specific or global, must be unexpired. Snapshotted
    // into the same modifiers JSON — identical money path.
    for (const aid of line.addOnIds) {
      const a = addOnById.get(aid);
      if (!a) return err(404, `no such add-on: ${aid}`);
      if (a.menuItemId && a.menuItemId !== mi.id)
        return err(400, `add-on not on item: ${a.name}`);
      if (a.ephemeral && (!a.expiresAt || a.expiresAt <= now))
        return err(409, `add-on expired: ${a.name}`);
      mods.push({ name: a.name, priceCents: a.priceCents });
    }
    creates.push({
      checkId: id,
      menuItemId: mi.id,
      nameSnapshot: mi.name,
      priceCents: mi.priceCents,
      quantity: line.quantity,
      seat: line.seat ?? null,
      course: line.course,
      modifiers: mods,
      note: line.note,
      station: mi.station,
      state: "held",
    });
  }
  await prisma.checkItem.createMany({ data: creates });
  return NextResponse.json(await recomputeCheck(id));
}
