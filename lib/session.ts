// lib/session.ts — restaurant session for the POS.
//
// Deliberately IDENTICAL in scheme to the floor app's lib/session.ts:
// an HMAC-signed cookie carrying the restaurant id, verified with the
// shared SESSION_SECRET. Restaurants sign in to the POS with the SAME
// restaurant name + 4-digit passcode they set in Travola-OS — one
// credential, both products.
//
// The cookie NAME differs (travola_pos_session) so a shared device can
// hold a floor session and a POS session at once, and signing out of
// one never signs the other out. The signature is interchangeable, so
// deploying both apps on one domain later is a rename, not a rewrite.
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

const SESSION_COOKIE = "travola_pos_session";
const encoder = new TextEncoder();
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type Session = { restaurantId: string; iat: number };

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required to use restaurant sessions.");
  return value;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function encode(session: Session) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decode(value?: string | null): Session | null {
  if (!value) return null;
  const [payload, received] = value.split(".");
  if (!payload || !received) return null;
  const expected = sign(payload);
  const a = encoder.encode(received);
  const b = encoder.encode(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.restaurantId !== "string" || typeof parsed.iat !== "number") return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

function cookieValue(req: Request) {
  const header = req.headers.get("cookie") || "";
  return header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

/** Read the restaurant id from a Request (API routes, proxy). */
export function getRestaurantId(req: Request) {
  return decode(cookieValue(req))?.restaurantId ?? null;
}

/** Read the restaurant id from a cookie string (server components). */
export function restaurantIdFromCookieValue(value?: string | null) {
  return decode(value)?.restaurantId ?? null;
}

export function setSession(response: NextResponse, restaurantId: string) {
  response.cookies.set(SESSION_COOKIE, encode({ restaurantId, iat: Date.now() }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return response;
}

export function clearSession(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export const POS_SESSION_COOKIE = SESSION_COOKIE;
