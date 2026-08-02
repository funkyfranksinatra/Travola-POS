// lib/auth.ts — server-side session helper for API routes.
import { cookies } from "next/headers";
import { prisma, RESTAURANT_ID } from "./prisma";

export async function currentServer() {
  const id = (await cookies()).get("pos_server")?.value;
  if (!id) return null;
  return prisma.serverUser.findFirst({ where: { id, restaurantId: RESTAURANT_ID } });
}
