import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";

export async function GET() {
  const stations = await prisma.station.findMany({
    where: { restaurantId: RESTAURANT_ID },
    orderBy: { key: "asc" },
  });
  return NextResponse.json(stations);
}

const Body = z.object({
  key: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
});

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body (key: lowercase slug)");
  const station = await prisma.station.upsert({
    where: { restaurantId_key: { restaurantId: RESTAURANT_ID, key: p.data.key } },
    create: { restaurantId: RESTAURANT_ID, ...p.data },
    update: { name: p.data.name },
  });
  return NextResponse.json(station);
}
