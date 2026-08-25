// POST /api/pos/auth {pin} — PIN login; sets the server cookie.
// GET  — who am I. DELETE — log out.
// SHARED-DB build: PINs live on the floor app's Server table (the
// `pin` column the shared migration added). Pilot-grade: plaintext
// PINs, cookie carries the id; hashing + rate limits land with
// multi-tenant hardening.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { err } from "@/lib/pos-api";
import { currentServer, serverByPin } from "@/lib/auth";

const COOKIE = "pos_server";

export async function POST(req: Request) {
  const p = z.object({ pin: z.string().regex(/^\d{4}$/) })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "PIN must be 4 digits");
  const server = await serverByPin(p.data.pin);
  if (!server) return err(401, "wrong PIN");
  (await cookies()).set(COOKIE, server.id, { httpOnly: true, sameSite: "lax", path: "/" });
  return NextResponse.json(server);
}

export async function GET() {
  const server = await currentServer();
  if (!server) return err(401, "not logged in");
  return NextResponse.json(server);
}

export async function DELETE() {
  (await cookies()).delete(COOKIE);
  return NextResponse.json({ ok: true });
}
