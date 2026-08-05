// POST /api/pos/addons — create an add-on tag.
// Servers create EPHEMERAL add-ons (decay at shift close, distinct color
// in the UI). Managers create permanent ones (or ephemeral if they ask).
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";
import { currentServer } from "@/lib/auth";
import { nextShiftClose } from "@/lib/shift";

const Body = z.object({
  name: z.string().min(1).max(60),
  priceCents: z.number().int().min(0).max(50000).default(0),
  menuItemId: z.string().optional(), // omit = global add-on
  permanent: z.boolean().default(false), // manager-only privilege
});

export async function POST(req: Request) {
  const me = await currentServer();
  if (!me) return err(401, "not logged in");
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  if (p.data.permanent && me.role !== "manager")
    return err(403, "only a manager can create permanent add-ons");
  if (p.data.menuItemId) {
    const item = await prisma.menuItem.findFirst({
      where: { id: p.data.menuItemId, restaurantId: RESTAURANT_ID },
    });
    if (!item) return err(404, "no such menu item");
  }
  const ephemeral = !p.data.permanent;
  const addOn = await prisma.addOn.create({
    data: {
      restaurantId: RESTAURANT_ID,
      menuItemId: p.data.menuItemId ?? null,
      name: p.data.name,
      priceCents: p.data.priceCents,
      ephemeral,
      expiresAt: ephemeral ? nextShiftClose() : null,
      createdBy: me.name,
    },
  });
  return NextResponse.json(addOn);
}
