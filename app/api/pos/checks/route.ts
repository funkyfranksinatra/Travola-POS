// GET  /api/pos/checks?status=open — check list (order screen home)
// POST /api/pos/checks — open a check
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";

export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status") ?? "open";
  const checks = await prisma.check.findMany({
    where: { restaurantId: RESTAURANT_ID, ...(status === "all" ? {} : { status }) },
    orderBy: { openedAt: "desc" },
    take: 100,
    include: { items: true, payments: true },
  });
  return NextResponse.json(checks);
}

const Body = z.object({
  tableLabel: z.string().min(1),
  guestCount: z.number().int().min(1).max(99).default(1),
  serverName: z.string().default(""),
  partyKey: z.string().optional(), // future floor-app seam
});

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  const check = await prisma.check.create({
    data: { restaurantId: RESTAURANT_ID, ...p.data },
    include: { items: true, payments: true },
  });
  return NextResponse.json(check);
}
