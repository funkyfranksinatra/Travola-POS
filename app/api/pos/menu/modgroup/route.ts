import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";

const Body = z.object({
  name: z.string().min(1),
  minSelect: z.number().int().min(0).default(0),
  maxSelect: z.number().int().min(1).default(1),
  modifiers: z
    .array(z.object({ name: z.string().min(1), priceCents: z.number().int().default(0) }))
    .default([]),
});

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const { modifiers, ...data } = p.data;
  const group = await prisma.modifierGroup.create({
    data: {
      restaurantId: RESTAURANT_ID,
      ...data,
      modifiers: {
        create: modifiers.map((m, i) => ({ ...m, sortOrder: i })),
      },
    },
    include: { modifiers: true },
  });
  return NextResponse.json(group);
}
