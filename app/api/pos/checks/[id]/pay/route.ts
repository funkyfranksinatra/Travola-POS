// POST /api/pos/checks/:id/pay — tender. Cash (with change math) or comp.
// ALL money math happens server-side in check-math; the client sends the
// tendered amount and tip only. When the balance hits zero the check closes.
// Card (Stripe Terminal) lands here in Phase 2 as method:"card".
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err, assertOpen, recomputeCheck } from "@/lib/pos-api";
import { changeDueCents } from "@/lib/check-math";

const Body = z.object({
  // card_external: charged on the restaurant's existing card machine —
  // the transition tender that lets paper-and-old-POS restaurants adopt
  // Travola before Stripe onboarding. Stripe "card" lands in Phase 2.
  method: z.enum(["cash", "comp", "card_external"]),
  tenderedCents: z.number().int().min(0).default(0), // cash only
  tipCents: z.number().int().min(0).default(0),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");

  const existing = await prisma.check.findFirst({
    where: { id, restaurantId: RESTAURANT_ID },
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
  const fresh = await recomputeCheck(id);
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
      restaurantId: RESTAURANT_ID,
      checkId: id,
      method: p.data.method,
      amountCents,
      tipCents: p.data.tipCents,
      status: "captured",
    },
  });

  const settled = await recomputeCheck(id);
  let closed = false;
  if (settled && settled.balanceDueCents <= 0) {
    await prisma.check.update({
      where: { id },
      data: { status: "closed", closedAt: new Date() },
    });
    closed = true;
    // Floor seam: closing the check marks the table "done" (post-
    // integration this notifies the Travola floor manager instead).
    if (existing!.tableId) {
      await prisma.floorTable.update({
        where: { id: existing!.tableId },
        data: { state: "done" },
      });
    }
  }
  return NextResponse.json({ ...settled, status: closed ? "closed" : "open", changeCents });
}
