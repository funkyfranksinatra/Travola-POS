// lib/tenant.ts — every POS API route resolves its restaurant HERE.
//
// The tenant used to be a build-time constant (POS_RESTAURANT_ID). It is
// now the signed restaurant session: a restaurant signs in with the same
// name + passcode it uses on the floor app, and every query in the
// request is scoped to that restaurant. No session, no data.
//
// POS_RESTAURANT_ID survives ONLY as a non-production convenience for
// local sandboxes and the seed script; it is ignored in production so a
// stray env var can never silently unlock a tenant.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { POS_SESSION_COOKIE, restaurantIdFromCookieValue } from "./session";

/** The signed-in restaurant, or null. Safe in routes and server components. */
export async function currentRestaurantId(): Promise<string | null> {
  try {
    const raw = (await cookies()).get(POS_SESSION_COOKIE)?.value;
    const fromSession = restaurantIdFromCookieValue(raw);
    if (fromSession) return fromSession;
  } catch {
    // No request scope (build-time prerender): fall through.
  }
  if (process.env.NODE_ENV !== "production" && process.env.POS_RESTAURANT_ID) {
    return process.env.POS_RESTAURANT_ID;
  }
  return null;
}

/** Route guard, mirroring the floor app's requireRestaurantId shape:
 *  `const auth = await requireRestaurant(); if ("response" in auth) …` */
export async function requireRestaurant(): Promise<
  { restaurantId: string } | { response: NextResponse }
> {
  const restaurantId = await currentRestaurantId();
  return restaurantId
    ? { restaurantId }
    : { response: NextResponse.json({ error: "no_restaurant_session" }, { status: 401 }) };
}
