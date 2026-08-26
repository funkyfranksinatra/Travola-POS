import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err } from "@/lib/pos-api";

export async function GET() {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const stations = await prisma.station.findMany({
    where: { restaurantId },
    orderBy: { key: "asc" },
  });
  return NextResponse.json(stations);
}

const Body = z.object({
  key: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
});

export async function POST(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body (key: lowercase slug)");
  const station = await prisma.station.upsert({
    where: { restaurantId_key: { restaurantId, key: p.data.key } },
    create: { restaurantId, ...p.data },
    update: { name: p.data.name },
  });
  return NextResponse.json(station);
}
