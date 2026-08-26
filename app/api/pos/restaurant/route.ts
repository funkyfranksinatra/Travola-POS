// POST   /api/pos/restaurant {name, passcode} — sign this DEVICE in to a
//        restaurant, using the SAME name + 4-digit passcode the manager
//        set in Travola-OS. Sets the signed restaurant-session cookie.
// GET    — which restaurant is this device signed in to?
// DELETE — sign the device out (also drops the server identity).
//
// This is the POS's counterpart to the floor app's /api/auth/login: same
// credential, same scrypt verification, same signed-cookie scheme. The
// POS deliberately has NO register endpoint — a restaurant is created
// (and its passcode chosen or changed) on the floor app.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setSession, clearSession } from "@/lib/session";
import { currentRestaurantId } from "@/lib/tenant";
import { restaurantByCredentials, allowAttempt } from "@/lib/restaurant-auth";
import { POS_SERVER_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  if (!allowAttempt(req, "restaurant"))
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  try {
    const body = await req.json().catch(() => ({}));
    const restaurant = await restaurantByCredentials(
      (body as { name?: unknown }).name,
      String((body as { passcode?: unknown }).passcode ?? "")
    );
    if (!restaurant)
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });

    const response = NextResponse.json({
      ok: true,
      restaurant: { id: restaurant.id, name: restaurant.name },
    });
    // A device switching restaurants must not keep the old venue's
    // server identity.
    response.cookies.set(POS_SERVER_COOKIE, "", { path: "/", maxAge: 0 });
    return setSession(response, restaurant.id);
  } catch (error) {
    console.error("[api/pos/restaurant POST]", error);
    return NextResponse.json({ error: "login_failed" }, { status: 400 });
  }
}

export async function GET() {
  const restaurantId = await currentRestaurantId();
  if (!restaurantId) return NextResponse.json({ error: "no_restaurant_session" }, { status: 401 });
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, name: true },
  });
  // A session pointing at a deleted restaurant is not a session.
  if (!restaurant)
    return clearSession(NextResponse.json({ error: "no_restaurant_session" }, { status: 401 }));
  return NextResponse.json({ restaurant });
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(POS_SERVER_COOKIE, "", { path: "/", maxAge: 0 });
  return clearSession(response);
}
