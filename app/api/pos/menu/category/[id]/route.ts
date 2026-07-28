import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";

const Body = z.object({
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const { count } = await prisma.menuCategory.updateMany({
    where: { id, restaurantId: RESTAURANT_ID },
    data: p.data,
  });
  if (!count) return err(404, "no such category");
  return NextResponse.json({ ok: true });
}
