import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";

const Body = z.object({
  name: z.string().min(1).optional(),
  priceCents: z.number().int().min(0).optional(),
  station: z.string().min(1).optional(),
  active: z.boolean().optional(), // the 86 switch
  sortOrder: z.number().int().optional(),
  categoryId: z.string().optional(),
  modifierGroupIds: z.array(z.string()).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const existing = await prisma.menuItem.findFirst({
    where: { id, restaurantId: RESTAURANT_ID },
  });
  if (!existing) return err(404, "no such item");
  const { modifierGroupIds, ...data } = p.data;
  const item = await prisma.menuItem.update({
    where: { id },
    data: {
      ...data,
      ...(modifierGroupIds
        ? { modifierGroups: { set: modifierGroupIds.map((id) => ({ id })) } }
        : {}),
    },
    include: { modifierGroups: { include: { modifiers: true } } },
  });
  return NextResponse.json(item);
}
