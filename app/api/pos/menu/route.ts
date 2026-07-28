// GET /api/pos/menu — the full catalog tree in one read (order screen boot).
import { NextResponse } from "next/server";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { getSettings } from "@/lib/pos-api";

export async function GET() {
  const [categories, modifierGroups, stations, settings] = await Promise.all([
    prisma.menuCategory.findMany({
      where: { restaurantId: RESTAURANT_ID },
      orderBy: { sortOrder: "asc" },
      include: {
        items: {
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
  ]);
  return NextResponse.json({ categories, modifierGroups, stations, settings });
}
