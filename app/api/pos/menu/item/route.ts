import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
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
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const cat = await prisma.menuCategory.findFirst({
    where: { id: p.data.categoryId, restaurantId: RESTAURANT_ID },
  });
  if (!cat) return err(404, "no such category");
  const { modifierGroupIds, ...data } = p.data;
  const item = await prisma.menuItem.create({
    data: {
      restaurantId: RESTAURANT_ID,
      ...data,
      ...(modifierGroupIds?.length
        ? { modifierGroups: { connect: modifierGroupIds.map((id) => ({ id })) } }
        : {}),
    },
    include: { modifierGroups: { include: { modifiers: true } } },
  });
  return NextResponse.json(item);
}
