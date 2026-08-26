import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err } from "@/lib/pos-api";

const Body = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1),
  priceCents: z.number().int().min(0),
  station: z.string().min(1),
  sortOrder: z.number().int().optional(),
  modifierGroupIds: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const cat = await prisma.menuCategory.findFirst({
    where: { id: p.data.categoryId, restaurantId },
  });
  if (!cat) return err(404, "no such category");
  const { modifierGroupIds, ...data } = p.data;
  const item = await prisma.menuItem.create({
    data: {
      restaurantId,
      ...data,
      ...(modifierGroupIds?.length
        ? { modifierGroups: { connect: modifierGroupIds.map((id) => ({ id })) } }
        : {}),
    },
    include: { modifierGroups: { include: { modifiers: true } } },
  });
  return NextResponse.json(item);
}
