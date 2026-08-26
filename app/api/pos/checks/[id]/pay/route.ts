// POST /api/pos/checks/:id/pay — tender. Cash (with change math) or comp.
// ALL money math happens server-side in check-math; the client sends the
// tendered amount and tip only. When the balance hits zero the check closes.
// Card (Stripe Terminal) lands here in Phase 2 as method:"card".
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err, assertOpen, recomputeCheck } from "@/lib/pos-api";
import { changeDueCents } from "@/lib/check-math";
import { emitServiceEvents, recordPaid } from "@/lib/service-events";

const Body = z.object({
  // card_external: charged on the restaurant's existing card machine —
  // the transition tender that lets paper-and-old-POS restaurants adopt
  // Travola before Stripe onboarding. Stripe "card" lands in Phase 2.
  method: z.enum(["cash", "comp", "card_external"]),
  tenderedCents: z.number().int().min(0).default(0), // cash only
  tipCents: z.number().int().min(0).default(0),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const { id } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");

  const existing = await prisma.check.findFirst({
    where: { id, restaurantId },
    include: { items: true },
  });
  const bad = assertOpen(existing);
  if (bad) return err(existing ? 409 : 404, bad);
  if (existing!.items.some((i) => i.state === "held"))
    return err(409, "held items on check — send or void them before payment");

  // Commit the tip to the check FIRST so totals include it, then recompute.
  if (p.data.tipCents) {
    await prisma.check.update({
      where: { id },
      data: { tipCents: { increment: p.data.tipCents } },
    });
  }
  const fresh = await recomputeCheck(restaurantId, id);
  if (!fresh) return err(404, "no such check");
  const due = fresh.balanceDueCents;
  if (due <= 0) return err(409, "check already settled");

  let amountCents: number;
  let changeCents = 0;
  if (p.data.method === "cash") {
    try {
      changeCents = changeDueCents(p.data.tenderedCents, due);
    } catch {
      return err(400, `insufficient tender: due ${due}`);
    }
    amountCents = due - p.data.tipCents; // tip rides on the same payment row
  } else {
    // comp and card_external settle the balance in full
    amountCents = due - p.data.tipCents;
  }

  await prisma.payment.create({
    data: {
      restaurantId,
      checkId: id,
      method: p.data.method,
      amountCents,
      tipCents: p.data.tipCents,
      status: "captured",
    },
  });

  const settled = await recomputeCheck(restaurantId, id);
  let closed = false;
  if (settled && settled.balanceDueCents <= 0) {
    await prisma.check.update({
      where: { id },
      data: { status: "closed", closedAt: new Date() },
    });
    closed = true;
    // Shared-DB link: money + paid-time onto the party's TableSession,
    // CHECK_PAID/CHECK_CLOSED onto the bus. The floor app surfaces
    // "PAID" on the tile and prompts the host to clear — advisory, not
    // autopilot, so the table's live status is NOT changed here (the
    // party may still be seated enjoying the evening).
    await recordPaid(restaurantId, {
      id,
      subtotalCents: settled.subtotalCents,
      totalCents: settled.totalCents,
      tipCents: settled.tipCents,
      guestCount: settled.guestCount,
    });
    await emitServiceEvents(restaurantId, [
      {
        type: "CHECK_PAID",
        partyKey: existing!.partyKey,
        tableIds: existing!.tableId ? [existing!.tableId] : [],
        serverId: existing!.serverId,
        checkId: id,
        payload: {
          tableLabel: existing!.tableLabel,
          method: p.data.method,
          totalCents: settled.totalCents,
          tipCents: settled.tipCents,
          guestCount: settled.guestCount,
          perGuestCents: Math.round(settled.totalCents / Math.max(1, settled.guestCount)),
        },
      },
      {
        type: "CHECK_CLOSED",
        partyKey: existing!.partyKey,
        tableIds: existing!.tableId ? [existing!.tableId] : [],
        serverId: existing!.serverId,
        checkId: id,
        payload: { tableLabel: existing!.tableLabel },
      },
    ]);
  }
  return NextResponse.json({ ...settled, status: closed ? "closed" : "open", changeCents });
}
