import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err, getSettings } from "@/lib/pos-api";

export async function GET() {
  return NextResponse.json(await getSettings());
}

const Body = z.object({
  taxRateBps: z.number().int().min(0).max(3000).optional(),
  tipPresets: z.array(z.number().int().min(0).max(100)).optional(),
  receiptFooter: z.string().optional(),
});

export async function PATCH(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  await getSettings(); // ensure row exists
  const updated = await prisma.posSettings.update({
    where: { restaurantId: RESTAURANT_ID },
    data: p.data,
  });
  return NextResponse.json(updated);
}
