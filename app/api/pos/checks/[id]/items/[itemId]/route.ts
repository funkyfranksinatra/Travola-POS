// POST /api/pos/checks/:id/items/:itemId — item-level actions (void).
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err, assertOpen, recomputeCheck } from "@/lib/pos-api";

const Body = z.union([
  z.object({ action: z.literal("void"), reason: z.string().min(1) }),
  // HOLD: push a still-held line back one course so SEND won't fire it.
  z.object({ action: z.literal("hold") }),
]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id, itemId } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body (action: void, reason required)");

  const check = await prisma.check.findFirst({
    where: { id, restaurantId: RESTAURANT_ID },
  });
  const bad = assertOpen(check);
  if (bad) return err(check ? 409 : 404, bad);

  const item = await prisma.checkItem.findFirst({ where: { id: itemId, checkId: id } });
  if (!item) return err(404, "no such line");

  if (p.data.action === "hold") {
    if (item.state !== "held") return err(409, "only held lines can be held back");
    await prisma.checkItem.update({
      where: { id: itemId },
      data: { course: Math.min(9, item.course + 1) },
    });
    return NextResponse.json(await recomputeCheck(id));
  }

  if (item.state === "voided") return err(409, "already voided");
  await prisma.checkItem.update({
    where: { id: itemId },
    data: { state: "voided", voidReason: p.data.reason },
  });
  return NextResponse.json(await recomputeCheck(id));
}
