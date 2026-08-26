import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err, getSettings } from "@/lib/pos-api";

export async function GET() {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  return NextResponse.json(await getSettings(restaurantId));
}

const Body = z.object({
  taxRateBps: z.number().int().min(0).max(3000).optional(),
  tipPresets: z.array(z.number().int().min(0).max(100)).optional(),
  receiptFooter: z.string().optional(),
});

export async function PATCH(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  await getSettings(restaurantId); // ensure row exists
  const updated = await prisma.posSettings.update({
    where: { restaurantId },
    data: p.data,
  });
  return NextResponse.json(updated);
}
