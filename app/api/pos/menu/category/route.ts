import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err } from "@/lib/pos-api";

const Body = z.object({ name: z.string().min(1), sortOrder: z.number().int().optional() });

export async function POST(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const cat = await prisma.menuCategory.create({
    data: { restaurantId, ...p.data },
  });
  return NextResponse.json(cat);
}
