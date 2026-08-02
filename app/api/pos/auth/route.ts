// POST /api/pos/auth {pin} — PIN login; sets the server cookie.
// GET  — who am I. DELETE — log out.
// Pilot-grade auth: cookie carries the ServerUser id; PINs are seeded
// (1111 Priya / 0000 Darko). Hashing + rate limits land with multi-tenant.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err } from "@/lib/pos-api";

const COOKIE = "pos_server";

export async function POST(req: Request) {
  const p = z.object({ pin: z.string().regex(/^\d{4}$/) })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "PIN must be 4 digits");
  const server = await prisma.serverUser.findUnique({
    where: { restaurantId_pin: { restaurantId: RESTAURANT_ID, pin: p.data.pin } },
  });
  if (!server) return err(401, "wrong PIN");
  (await cookies()).set(COOKIE, server.id, { httpOnly: true, sameSite: "lax", path: "/" });
  return NextResponse.json({ id: server.id, name: server.name, color: server.color });
}

export async function GET() {
  const id = (await cookies()).get(COOKIE)?.value;
  if (!id) return err(401, "not logged in");
  const server = await prisma.serverUser.findFirst({
    where: { id, restaurantId: RESTAURANT_ID },
  });
  if (!server) return err(401, "not logged in");
  return NextResponse.json({ id: server.id, name: server.name, color: server.color });
}

export async function DELETE() {
  (await cookies()).delete(COOKIE);
  return NextResponse.json({ ok: true });
}
