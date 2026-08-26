// lib/pos-api.ts — shared server helpers for the POS API routes.
// Server-authoritative: every mutation recomputes + persists totals here;
// clients never send computed money.
import { NextResponse } from "next/server";
import { prisma } from "./prisma";
import { computeTotals, balanceDueCents } from "./check-math";

export const err = (status: number, message: string) =>
  NextResponse.json({ error: message }, { status });

export async function getSettings(restaurantId: string) {
  return (
    (await prisma.posSettings.findUnique({
      where: { restaurantId },
    })) ??
    (await prisma.posSettings.create({ data: { restaurantId } }))
  );
}

const CHECK_INCLUDE = {
  items: { orderBy: [{ course: "asc" as const }, { id: "asc" as const }] },
  payments: { orderBy: { createdAt: "asc" as const } },
};

/** Load a check, recompute + persist totals, return the fresh payload. */
export async function recomputeCheck(restaurantId: string, checkId: string) {
  const check = await prisma.check.findFirst({
    where: { id: checkId, restaurantId },
    include: CHECK_INCLUDE,
  });
  if (!check) return null;
  const settings = await getSettings(restaurantId);
  const totals = computeTotals(
    check.items as never,
    settings.taxRateBps,
    check.tipCents
  );
  const updated = await prisma.check.update({
    where: { id: check.id },
    data: {
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
    },
    include: CHECK_INCLUDE,
  });
  return {
    ...updated,
    balanceDueCents: balanceDueCents(totals, updated.payments),
    taxRateBps: settings.taxRateBps,
  };
}

export type CheckPayload = NonNullable<Awaited<ReturnType<typeof recomputeCheck>>>;

/** Guard: mutations only on open checks. */
export function assertOpen(check: { status: string } | null) {
  if (!check) return "no such check";
  if (check.status !== "open") return `check is ${check.status}`;
  return null;
}
