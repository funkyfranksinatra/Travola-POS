// POST /api/pos/checks/:id/fire {course} — advance the check's course
// and fire any held lines now due. "Fire course 2."
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err, assertOpen, recomputeCheck } from "@/lib/pos-api";

const Body = z.object({ course: z.number().int().min(1).max(9) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");

  const check = await prisma.check.findFirst({
    where: { id, restaurantId: RESTAURANT_ID },
  });
  const bad = assertOpen(check);
  if (bad) return err(check ? 409 : 404, bad);
  if (p.data.course < check!.currentCourse)
    return err(409, `course ${check!.currentCourse} already fired`);

  await prisma.check.update({
    where: { id },
    data: { currentCourse: p.data.course },
  });
  const { count } = await prisma.checkItem.updateMany({
    where: { checkId: id, state: "held", course: { lte: p.data.course } },
    data: { state: "fired", firedAt: new Date() },
  });
  const payload = await recomputeCheck(id);
  return NextResponse.json({ ...payload, firedCount: count });
}
