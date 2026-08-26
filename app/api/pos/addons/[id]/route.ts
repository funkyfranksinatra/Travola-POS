// DELETE /api/pos/addons/:id — remove an add-on (kitchen said no).
// PATCH  /api/pos/addons/:id {permanent:true} — manager promotes a
//        server-created add-on to a permanent button.
// Manager-gated: either the session is a manager, or a valid manager
// PIN rides in the body (server hands the terminal to the manager).
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { err } from "@/lib/pos-api";
import { currentServer, isManagerCode } from "@/lib/auth";

async function managerOk(restaurantId: string, pin?: string) {
  const me = await currentServer(restaurantId);
  if (me?.role === "manager") return true;
  if (!pin) return false;
  // A manager's own PIN, or the restaurant passcode.
  return isManagerCode(restaurantId, pin);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  if (!(await managerOk(restaurantId, (body as { managerPin?: string }).managerPin)))
    return err(403, "manager PIN required");
  const { count } = await prisma.addOn.deleteMany({
    where: { id, restaurantId },
  });
  if (!count) return err(404, "no such add-on");
  return NextResponse.json({ ok: true });
}

const Patch = z.object({ permanent: z.literal(true), managerPin: z.string().optional() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;

  const { id } = await ctx.params;
  const p = Patch.safeParse(await req.json().catch(() => null));
  if (!p.success) return err(400, "invalid body");
  if (!(await managerOk(restaurantId, p.data.managerPin))) return err(403, "manager PIN required");
  const existing = await prisma.addOn.findFirst({ where: { id, restaurantId } });
  if (!existing) return err(404, "no such add-on");
  const addOn = await prisma.addOn.update({
    where: { id },
    data: { ephemeral: false, expiresAt: null },
  });
  return NextResponse.json(addOn);
}
