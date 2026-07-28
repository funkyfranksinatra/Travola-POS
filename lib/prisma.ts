// lib/prisma.ts — the one PrismaClient for the POS app.
// Prisma 7 driver-adapter pattern (same as the floor app); client is
// generated into lib/generated/prisma so shared node_modules stays clean.
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

// Single-restaurant standalone build; every query still scopes by this
// so the multi-tenant + floor-app integration is a constant swap.
export const RESTAURANT_ID = "rest_demo";
