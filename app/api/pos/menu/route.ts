// GET /api/pos/menu — the full catalog tree in one read (order screen boot).
// Includes: regular categories (expired customs filtered), the Custom tab
// payload (unexpired ephemeral items), and add-on tags (global + per-item,
// unexpired). Everything the ItemSheet needs in one round trip.
import { NextResponse } from "next/server";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { getSettings } from "@/lib/pos-api";

export async function GET() {
  const now = new Date();
  const [categories, modifierGroups, stations, settings, addOns, customItems] =
    await Promise.all([
      prisma.menuCategory.findMany({
        where: { restaurantId: RESTAURANT_ID, active: true },
        orderBy: { sortOrder: "asc" },
        include: {
          items: {
            where: { ephemeral: false },
            orderBy: { sortOrder: "asc" },
            include: {
              modifierGroups: {
                include: { modifiers: { orderBy: { sortOrder: "asc" } } },
              },
            },
          },
        },
      }),
      prisma.modifierGroup.findMany({
        where: { restaurantId: RESTAURANT_ID },
        include: { modifiers: { orderBy: { sortOrder: "asc" } } },
      }),
      prisma.station.findMany({ where: { restaurantId: RESTAURANT_ID } }),
      getSettings(),
      prisma.addOn.findMany({
        where: {
          restaurantId: RESTAURANT_ID,
          OR: [{ ephemeral: false }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ ephemeral: "asc" }, { createdAt: "asc" }],
      }),
      prisma.menuItem.findMany({
        where: { restaurantId: RESTAURANT_ID, ephemeral: true, expiresAt: { gt: now } },
        orderBy: { id: "asc" },
        include: { modifierGroups: { include: { modifiers: true } } },
      }),
    ]);
  return NextResponse.json({ categories, modifierGroups, stations, settings, addOns, customItems });
}
