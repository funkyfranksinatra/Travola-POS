// lib/auth.ts — server-side session helper for API routes.
// SHARED-DB build: PIN login authenticates against the floor app's
// Server table (the `pin` column the shared migration added). The
// cookie still carries the server id; role derives from roles[].
import { cookies } from "next/headers";
import { prisma, RESTAURANT_ID } from "./prisma";

export type PosServer = {
  id: string;
  name: string;
  color: string;
  role: "server" | "manager";
};

function toPosServer(row: { id: string; name: string; colorHex: string | null; roles: string[] }): PosServer {
  return {
    id: row.id,
    name: row.name,
    color: row.colorHex ?? "#6d79e8",
    role: row.roles.includes("manager") ? "manager" : "server",
  };
}

export async function currentServer(): Promise<PosServer | null> {
  const id = (await cookies()).get("pos_server")?.value;
  if (!id) return null;
  const row = await prisma.server.findFirst({
    where: { id, restaurantId: RESTAURANT_ID, active: true },
    select: { id: true, name: true, colorHex: true, roles: true },
  });
  return row ? toPosServer(row) : null;
}

export async function serverByPin(pin: string): Promise<PosServer | null> {
  const row = await prisma.server.findFirst({
    where: { restaurantId: RESTAURANT_ID, pin, active: true },
    select: { id: true, name: true, colorHex: true, roles: true },
  });
  return row ? toPosServer(row) : null;
}
