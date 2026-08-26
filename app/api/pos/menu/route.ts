// GET /api/pos/menu — the full catalog tree in one read (order screen boot).
// Includes: regular categories (expired customs filtered), the Custom tab
// payload (unexpired ephemeral items), and add-on tags (global + per-item,
// unexpired). Everything the ItemSheet needs in one round trip.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { getSettings } from "@/lib/pos-api";

export async function GET() {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const now = new Date();
  const [categories, modifierGroups, stations, settings, addOns, customItems] =
    await Promise.all([
      prisma.menuCategory.findMany({
        where: { restaurantId, active: true },
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
        where: { restaurantId },
        include: { modifiers: { orderBy: { sortOrder: "asc" } } },
      }),
      prisma.station.findMany({ where: { restaurantId } }),
      getSettings(restaurantId),
      prisma.addOn.findMany({
        where: {
          restaurantId,
          OR: [{ ephemeral: false }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ ephemeral: "asc" }, { createdAt: "asc" }],
      }),
      prisma.menuItem.findMany({
        where: { restaurantId, ephemeral: true, expiresAt: { gt: now } },
        orderBy: { id: "asc" },
        include: { modifierGroups: { include: { modifiers: true } } },
      }),
    ]);
  return NextResponse.json({ categories, modifierGroups, stations, settings, addOns, customItems });
}
