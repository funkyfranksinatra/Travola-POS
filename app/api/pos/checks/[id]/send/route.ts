// POST /api/pos/checks/:id/send — SEND: held lines with course <=
// currentCourse flip to fired (tickets appear on the KDS instantly).
// Higher courses stay held until FIRE COURSE N.
import { NextResponse } from "next/server";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";
import { err, assertOpen, recomputeCheck } from "@/lib/pos-api";
import { emitServiceEvents, recordFire } from "@/lib/service-events";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const check = await prisma.check.findFirst({
    where: { id, restaurantId: RESTAURANT_ID },
  });
  const bad = assertOpen(check);
  if (bad) return err(check ? 409 : 404, bad);

  const { count } = await prisma.checkItem.updateMany({
    where: { checkId: id, state: "held", course: { lte: check!.currentCourse } },
    data: { state: "fired", firedAt: new Date() },
  });
  if (count > 0) {
    // Shared-DB link: pacing onto the session + the event bus (the
    // floor's sentry reads "entrées fired Xm ago" from this).
    await recordFire(id, check!.currentCourse, count);
    await emitServiceEvents([{
      type: "COURSE_FIRED",
      partyKey: check!.partyKey,
      tableIds: check!.tableId ? [check!.tableId] : [],
      serverId: check!.serverId,
      checkId: id,
      payload: { course: check!.currentCourse, items: count, tableLabel: check!.tableLabel },
    }]);
  }
  const payload = await recomputeCheck(id);
  return NextResponse.json({ ...payload, firedCount: count });
}
