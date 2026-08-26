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

// NOTE: there is no RESTAURANT_ID constant any more. The tenant comes
// from the signed restaurant session on every request — see lib/tenant.ts
// (`requireRestaurant`). POS_RESTAURANT_ID remains only as a
// non-production convenience for local sandboxes and the seed script.
