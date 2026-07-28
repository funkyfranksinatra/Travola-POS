import { NextResponse } from "next/server";
import { recomputeCheck, err } from "@/lib/pos-api";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const check = await recomputeCheck(id);
  if (!check) return err(404, "no such check");
  return NextResponse.json(check);
}
