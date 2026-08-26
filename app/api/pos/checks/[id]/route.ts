import { NextResponse } from "next/server";
import { recomputeCheck, err } from "@/lib/pos-api";
import { requireRestaurant } from "@/lib/tenant";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;
  const { id } = await ctx.params;
  const check = await recomputeCheck(restaurantId, id);
  if (!check) return err(404, "no such check");
  return NextResponse.json(check);
}
