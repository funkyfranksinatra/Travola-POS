// POST /api/pos/checks/:id/fire {course} — advance the check's course
// and fire any held lines now due. "Fire course 2."
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err, assertOpen, recomputeCheck } from "@/lib/pos-api";
import { emitServiceEvents, recordFire } from "@/lib/service-events";

const Body = z.object({ course: z.number().int().min(1).max(9) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const { id } = await ctx.params;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");

  const check = await prisma.check.findFirst({
    where: { id, restaurantId },
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
  if (count > 0) {
    await recordFire(restaurantId, id, p.data.course, count);
    await emitServiceEvents(restaurantId, [{
      type: "COURSE_FIRED",
      partyKey: check!.partyKey,
      tableIds: check!.tableId ? [check!.tableId] : [],
      serverId: check!.serverId,
      checkId: id,
      payload: { course: p.data.course, items: count, tableLabel: check!.tableLabel },
    }]);
  }
  const payload = await recomputeCheck(restaurantId, id);
  return NextResponse.json({ ...payload, firedCount: count });
}
