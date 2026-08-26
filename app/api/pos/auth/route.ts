// POST /api/pos/auth {pin} — staff sign-in at the PIN pad, WITHIN the
//      restaurant this device is signed in to. Accepts a staff PIN from
//      the shared Server table, or the restaurant's own 4-digit passcode
//      (manager) — which is what makes day one work, before any server
//      PINs have been handed out.
// GET  — who am I. DELETE — clock this person out of the terminal
//      (the device stays signed in to the restaurant).
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { err } from "@/lib/pos-api";
import { currentServer, identifyByCode, POS_SERVER_COOKIE } from "@/lib/auth";
import { requireRestaurant } from "@/lib/tenant";
import { allowAttempt } from "@/lib/restaurant-auth";

export async function POST(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  if (!allowAttempt(req, "pin", 20)) return err(429, "too many attempts — wait a minute");
  const p = z.object({ pin: z.string().regex(/^\d{4}$/) })
    .safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "PIN must be 4 digits");

  const resolved = await identifyByCode(restaurantId, p.data.pin);
  if (!resolved) return err(401, "wrong PIN");
  (await cookies()).set(POS_SERVER_COOKIE, resolved.cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return NextResponse.json(resolved.server);
}

export async function GET() {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const server = await currentServer(auth.restaurantId);
  if (!server) return err(401, "not logged in");
  return NextResponse.json(server);
}

export async function DELETE() {
  (await cookies()).delete(POS_SERVER_COOKIE);
  return NextResponse.json({ ok: true });
}
