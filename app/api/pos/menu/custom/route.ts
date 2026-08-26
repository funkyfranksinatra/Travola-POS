// POST /api/pos/menu/custom — shift-decaying custom dish/drink.
// For chef/bartender specials AND items the manager simply hasn't
// entered yet. Created by any staff, replicated to every terminal via
// the shared menu payload, expires at shift close. Implemented as an
// ephemeral MenuItem so ordering/station-routing/snapshots are the
// exact same battle-tested path as regular items.
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err } from "@/lib/pos-api";
import { currentServer } from "@/lib/auth";
import { nextShiftClose } from "@/lib/shift";

const Body = z.object({
  kind: z.enum(["dish", "drink"]), // dish → kitchen, drink → bar
  name: z.string().min(1).max(80), // "Chef Special" / "Bartender Special" or custom
  description: z.string().max(200).default(""),
  priceCents: z.number().int().min(0).max(100000),
});

export async function POST(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");

  // Ephemeral items live in a hidden "Custom" category (created lazily).
  let cat = await prisma.menuCategory.findFirst({
    where: { restaurantId, name: "__custom__" },
  });
  if (!cat) {
    cat = await prisma.menuCategory.create({
      data: { restaurantId, name: "__custom__", sortOrder: 999, active: false },
    });
  }
  const item = await prisma.menuItem.create({
    data: {
      restaurantId,
      categoryId: cat.id,
      name: p.data.name,
      priceCents: p.data.priceCents,
      station: p.data.kind === "drink" ? "bar" : "kitchen",
      ephemeral: true,
      expiresAt: await nextShiftClose(restaurantId),
      description: p.data.description,
      createdBy: me.name,
    },
  });
  return NextResponse.json(item);
}
