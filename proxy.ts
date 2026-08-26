// proxy.ts — page-level boundary (Next 16's middleware).
//
// Every screen except the login page requires a signed restaurant
// session. Without this, a cookie-less tablet lands on a shell that
// spins forever while its API calls 401 in the background. Each API
// route still validates the session for its own reads and writes —
// this is a redirect, not the security boundary.
import { NextResponse, type NextRequest } from "next/server";
import { getRestaurantId } from "@/lib/session";

export function proxy(request: NextRequest) {
  if (getRestaurantId(request)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

// Pages only: the API routes answer 401 (which clients handle) rather
// than redirecting, and /login must stay reachable while signed out.
export const config = { matcher: ["/", "/pos", "/menu", "/kds/:path*"] };
