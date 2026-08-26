// lib/restaurant-auth.ts — verify a restaurant's 4-digit passcode.
//
// Byte-for-byte the same scheme the floor app writes at registration
// (`scrypt$<salt>$<derived>`), so a passcode set once in Travola-OS
// signs the restaurant into the POS too. Verification only — the POS
// never creates restaurants or changes passcodes; that stays a floor-app
// (manager) act, and the POS is a consumer of that credential.
import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { prisma } from "./prisma";
// Shared verbatim with Travola-OS (lib/name-key.ts). The two apps MUST
// agree on this function: it is what makes "Volario's" typed on an iPad
// (curly apostrophe) resolve to the same restaurant the manager
// registered from a desktop.
export { nameKey } from "./name-key";
import { nameKey } from "./name-key";

const scrypt = promisify(scryptCallback);

export async function verifyPasscode(passcode: string, stored: string) {
  const [algorithm, salt, encoded] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !encoded) return false;
  const actual = (await scrypt(passcode, salt, 64)) as Buffer;
  const expected = Buffer.from(encoded, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Restaurant matching name + passcode, or null. */
export async function restaurantByCredentials(name: unknown, passcode: string) {
  const key = nameKey(name);
  if (!key || !/^\d{4}$/.test(passcode)) return null;
  const restaurant = await prisma.restaurant.findUnique({ where: { nameKey: key } });
  if (!restaurant) return null;
  return (await verifyPasscode(passcode, restaurant.passcodeHash)) ? restaurant : null;
}

/** Does this 4-digit code match the restaurant's own passcode? Used by the
 *  PIN pad so a manager can always get in with the restaurant code —
 *  including on day one, before any server PINs have been handed out. */
export async function isRestaurantPasscode(restaurantId: string, passcode: string) {
  if (!/^\d{4}$/.test(passcode)) return false;
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { passcodeHash: true },
  });
  return restaurant ? verifyPasscode(passcode, restaurant.passcodeHash) : false;
}

// ── Brute-force throttle (mirrors the floor app's login limiter) ──────
// Per-instance and in-memory: enough to blunt PIN-pad guessing on a
// tablet in the wait alley, which is the threat that exists at pilot
// scale. Durable rate limiting lands with multi-tenant hardening.
const attempts = new Map<string, { count: number; resetAt: number }>();

export function clientKey(req: Request) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function allowAttempt(req: Request, bucket: string, limit = 10) {
  const key = `${bucket}:${clientKey(req)}`;
  const now = Date.now();
  const row = attempts.get(key);
  if (!row || row.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (row.count >= limit) return false;
  row.count += 1;
  return true;
}
