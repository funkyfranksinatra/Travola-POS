// lib/prisma.ts — the one PrismaClient for the POS app.
// SHARED-DB build: DATABASE_URL points at the SAME Neon database as
// Travola-OS. The client still generates into lib/generated/prisma and
// mirrors only the tables the POS touches (see prisma/schema.prisma —
// this repo never migrates).
import { PrismaClient } from "./generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prismaPos?: PrismaClient };

function makeClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prismaPos ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaPos = prisma;
}

// The restaurant this POS deployment serves. One deployment = one
// restaurant at pilot scale; POS_RESTAURANT_ID is the Restaurant.id
// from the shared database (Vercel env / .env). The rest_demo fallback
// keeps local sandboxes bootable against a scratch database.
export const RESTAURANT_ID = process.env.POS_RESTAURANT_ID ?? "rest_demo";

if (process.env.NODE_ENV === "production" && !process.env.POS_RESTAURANT_ID) {
  console.warn(
    "[pos] POS_RESTAURANT_ID is not set — running against the rest_demo " +
      "tenant. Set it to the shared database's Restaurant.id."
  );
}
