// lib/auth.ts — who is at this terminal, within the signed-in restaurant.
//
// Two layers, mirroring how a restaurant actually works:
//   1. RESTAURANT session (lib/session.ts) — the venue signs in once per
//      device with the same name + passcode as the floor app.
//   2. SERVER identity (this file) — each staff member taps their PIN so
//      checks, tips, and section rules attach to a person.
//
// The restaurant's own passcode also works at the PIN pad and grants
// manager access. That is what makes day one work: a restaurant that has
// just signed up has no server PINs yet, and the code they already know
// gets them into the terminal.
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { isRestaurantPasscode } from "./restaurant-auth";

const COOKIE = "pos_server";
/** Cookie value for a manager authenticated by the restaurant passcode. */
const MANAGER_SENTINEL = "restaurant-manager";

export type PosServer = {
  id: string;
  name: string;
  color: string;
  role: "server" | "manager";
  /** True when this identity came from the restaurant passcode rather
   *  than a Server row — no per-server stats attach to it. */
  synthetic?: boolean;
};

function toPosServer(row: {
  id: string;
  name: string;
  colorHex: string | null;
  roles: string[];
}): PosServer {
  return {
    id: row.id,
    name: row.name,
    color: row.colorHex ?? "#6d79e8",
    role: row.roles.includes("manager") ? "manager" : "server",
  };
}

const SYNTHETIC_MANAGER: PosServer = {
  id: MANAGER_SENTINEL,
  name: "Manager",
  color: "#52c794",
  role: "manager",
  synthetic: true,
};

/** The staff member at this terminal, scoped to the signed-in restaurant. */
export async function currentServer(restaurantId: string): Promise<PosServer | null> {
  const id = (await cookies()).get(COOKIE)?.value;
  if (!id) return null;
  if (id === MANAGER_SENTINEL) return SYNTHETIC_MANAGER;
  const row = await prisma.server.findFirst({
    where: { id, restaurantId, active: true },
    select: { id: true, name: true, colorHex: true, roles: true },
  });
  return row ? toPosServer(row) : null;
}

/** Resolve a 4-digit code at the PIN pad: a staff PIN, else the
 *  restaurant passcode (manager). Returns the identity and the cookie
 *  value that should be persisted for it. */
export async function identifyByCode(
  restaurantId: string,
  code: string
): Promise<{ server: PosServer; cookieValue: string } | null> {
  const row = await prisma.server.findFirst({
    where: { restaurantId, pin: code, active: true },
    select: { id: true, name: true, colorHex: true, roles: true },
  });
  if (row) return { server: toPosServer(row), cookieValue: row.id };

  if (await isRestaurantPasscode(restaurantId, code)) {
    // Prefer a real manager Server row when the restaurant has one, so
    // the manager's actions still attribute to a person on reports.
    const manager = await prisma.server.findFirst({
      where: { restaurantId, active: true, roles: { has: "manager" } },
      select: { id: true, name: true, colorHex: true, roles: true },
      orderBy: { createdAt: "asc" },
    });
    return manager
      ? { server: toPosServer(manager), cookieValue: manager.id }
      : { server: SYNTHETIC_MANAGER, cookieValue: MANAGER_SENTINEL };
  }
  return null;
}

/** Manager check for a PIN typed into a confirmation dialog (voids,
 *  add-on administration): a manager's own PIN, or the restaurant code. */
export async function isManagerCode(restaurantId: string, code: string) {
  const resolved = await identifyByCode(restaurantId, code);
  return resolved?.server.role === "manager";
}

/** Server id safe to persist on a Check — null for the synthetic
 *  manager, which has no Server row to point at. */
export function persistableServerId(me: PosServer) {
  return me.synthetic ? null : me.id;
}

export const POS_SERVER_COOKIE = COOKIE;
