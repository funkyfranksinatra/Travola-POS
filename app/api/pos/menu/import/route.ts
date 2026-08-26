// POST /api/pos/menu/import — extract a menu into a reviewable draft.
// GET  — the current draft for this restaurant (survives refresh).
// DELETE ?id= — discard a draft.
//
// HYBRID BY DESIGN. Two things are hard here and they are hard in
// different ways:
//
//   READING the menu — "what are the items, what do they cost" — is a
//   language problem. Menus are two-column, decorative, use leader dots,
//   put prices in a margin, and mix languages. A parser cannot do this;
//   a model does it well.
//
//   DECIDING THE TICKET MODS — "every steak offers the same five
//   temperatures, spelled identically" — is a consistency problem, and
//   a model is exactly the wrong tool: left alone it produces "Temp",
//   "Temperature" and "Cook temp" across three pages and forgets the
//   side choice on the third burger. That work belongs to the
//   deterministic rules in lib/menu-rules.ts.
//
// So the model reads and the rules decide. The client also picks the
// CHEAPER input where it can: a PDF with a real text layer is sent as
// text (no OCR error, a fraction of the tokens); only scans and photos
// are rasterised and sent to vision.
//
// Nothing here touches the live catalog. The draft goes to MenuImport
// and waits for a human.
import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { currentServer } from "@/lib/auth";
import { err } from "@/lib/pos-api";
import { buildDraft, type ExtractedItem } from "@/lib/menu-rules";
import { MENU_IMPORT_MODEL } from "@/lib/ai-models";

// 60s is the Hobby-plan ceiling; the client sends pages in small
// batches so no single request needs longer, and a Pro upgrade later
// changes nothing here.
export const maxDuration = 60;

/** Pages per REQUEST. The client chunks a long menu into several calls
 *  and passes the draft id back, which keeps every request inside both
 *  the function time limit and the 4.5MB body limit — a scanned page is
 *  ~300KB of base64 and twelve of them in one POST would exceed it. */
const MAX_PAGES = 4;
const MAX_TEXT_CHARS = 120_000;

const itemSchema = z.object({
  name: z.string().describe("The dish or drink name exactly as printed, without the price."),
  description: z.string().describe("The printed description/ingredients, or an empty string. Never invent one."),
  price: z.string().describe("The price exactly as printed ('24', '$18.50', '14/52', 'MP'). Empty string if none is printed."),
  categoryName: z.string().describe("The section heading this item sits under, as printed: 'Starters', 'Cocktails', 'Dolci'. If the menu has no headings, infer a sensible one."),
  suggestedModifiers: z
    .array(
      z.object({
        name: z.string().describe("A choice a server must ask about, e.g. 'Sauce', 'Spice level'."),
        options: z.array(z.string()).describe("The choices."),
      })
    )
    .describe(
      "ONLY house-specific choices the menu text itself implies (a listed choice of sauce, a spice level, a bread choice). Do NOT suggest temperature, side choice, add-protein, dressing, egg style, milk or ice — those are applied automatically and duplicating them creates conflicting groups. Empty array is the normal answer."
    ),
});

const pageSchema = z.object({
  items: z.array(itemSchema).describe("Every orderable item found. Skip headings, prose, allergen notes, hours and page furniture."),
});

const INSTRUCTION = `You are transcribing a restaurant menu into a point-of-sale catalog.

Rules:
- Transcribe what is printed. Never invent an item, a description or a price.
- Include EVERYTHING orderable: food, sides, drinks, wine, beer, cocktails, coffee, desserts.
- Keep the menu's own section headings as categoryName.
- A wine listed as "Chianti Classico, Tuscany 2019 ... 14/52" is one item named "Chianti Classico" with price "14/52". The year is a vintage, not a price.
- "MP" or "Market Price" is a price of "MP", not a guess.
- If an item's price is genuinely absent, use an empty string.
- Ignore hours, addresses, allergen disclaimers, and "consuming raw" notices.`;

type PageInput = { text?: string; image?: string };
type DraftLike = { name?: string; categoryName?: string };
type GroupLike = { key: string };

export async function POST(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;
  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");
  if (me.role !== "manager") return err(403, "manager access required");

  if (!process.env.OPENAI_API_KEY)
    return err(503, "menu import is unavailable — OPENAI_API_KEY is not configured");

  const body = await req.json().catch(() => null);
  const parsed = z
    .object({
      sourceName: z.string().default(""),
      /** Append to an in-progress draft instead of starting a new one. */
      importId: z.string().optional(),
      pages: z
        .array(z.object({ text: z.string().optional(), image: z.string().optional() }))
        .min(1)
        .max(MAX_PAGES),
    })
    .safeParse(body);
  if (!parsed.success)
    return err(400, `send 1–${MAX_PAGES} pages per request, each with text or an image`);

  const pages: PageInput[] = parsed.data.pages;
  const usesVision = pages.some((p) => p.image);

  try {
    // Pages are extracted CONCURRENTLY but capped: a 12-page wine list
    // fired all at once trips provider rate limits, and one failed page
    // should not lose the other eleven.
    const settled = await Promise.allSettled(
      pages.map(async (page) => {
          const content: Array<
            { type: "text"; text: string } | { type: "image"; image: string }
          > = [{ type: "text", text: INSTRUCTION }];
          if (page.image) {
            content.push({ type: "image", image: page.image });
          } else {
            content.push({
              type: "text",
              text: `MENU PAGE TEXT:\n${(page.text ?? "").slice(0, MAX_TEXT_CHARS)}`,
            });
          }
        const { object } = await generateObject({
          model: openai(MENU_IMPORT_MODEL),
          schema: pageSchema,
          messages: [{ role: "user", content }],
        });
        return object.items as ExtractedItem[];
      })
    );
    // One bad page must not lose the others in the batch.
    const extracted = settled.flatMap((outcome) => {
      if (outcome.status === "fulfilled") return outcome.value;
      console.warn("[menu-import] page failed:", outcome.reason);
      return [];
    });
    if (!extracted.length)
      return err(422, "no menu items could be read from that file — try a clearer scan");

    // Same dish printed on a lunch AND dinner page: keep one.
    const seen = new Set<string>();
    const unique = extracted.filter((item) => {
      const key = `${(item.name ?? "").trim().toLowerCase()}|${(item.categoryName ?? "").trim().toLowerCase()}`;
      if (!item.name?.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Rules decide stations and ticket mods.
    const draft = buildDraft(unique);

    // ── Continuing a chunked upload ────────────────────────────────
    const existing = parsed.data.importId
      ? await prisma.menuImport.findFirst({
          where: { id: parsed.data.importId, restaurantId, status: "draft" },
        })
      : null;

    if (existing) {
      const prior = existing.payload as { items?: DraftLike[]; groups?: GroupLike[] };
      const priorItems = prior?.items ?? [];
      const priorGroups = prior?.groups ?? [];
      const known = new Set(
        priorItems.map((i) => `${i.name?.trim().toLowerCase()}|${i.categoryName?.trim().toLowerCase()}`)
      );
      const freshItems = draft.items.filter(
        (i) => !known.has(`${i.name.trim().toLowerCase()}|${i.categoryName.trim().toLowerCase()}`)
      );
      const groupKeys = new Set(priorGroups.map((g) => g.key));
      const mergedGroups = [...priorGroups, ...draft.groups.filter((g) => !groupKeys.has(g.key))];
      const mergedItems = [...priorItems, ...freshItems];
      const record = await prisma.menuImport.update({
        where: { id: existing.id },
        data: {
          pageCount: existing.pageCount + pages.length,
          itemCount: mergedItems.length,
          sourceKind: usesVision ? "vision" : existing.sourceKind,
          payload: { items: mergedItems, groups: mergedGroups } as never,
        },
      });
      return NextResponse.json({
        id: record.id,
        sourceName: record.sourceName,
        sourceKind: record.sourceKind,
        pageCount: record.pageCount,
        itemCount: record.itemCount,
        items: mergedItems,
        groups: mergedGroups,
      });
    }

    // One draft at a time per restaurant: a second upload supersedes the
    // first rather than leaving two competing reviews open.
    await prisma.menuImport.updateMany({
      where: { restaurantId, status: "draft" },
      data: { status: "discarded" },
    });
    const record = await prisma.menuImport.create({
      data: {
        restaurantId,
        status: "draft",
        sourceName: parsed.data.sourceName.slice(0, 200),
        sourceKind: usesVision ? "vision" : "text",
        pageCount: pages.length,
        itemCount: draft.items.length,
        createdBy: me.name,
        payload: draft as never,
      },
    });

    return NextResponse.json({
      id: record.id,
      sourceName: record.sourceName,
      sourceKind: record.sourceKind,
      pageCount: record.pageCount,
      itemCount: record.itemCount,
      ...draft,
    });
  } catch (error) {
    console.error("[api/pos/menu/import]", error);
    return err(502, "extraction failed — check the file and try again");
  }
}

export async function GET() {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;
  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");

  const record = await prisma.menuImport.findFirst({
    where: { restaurantId, status: "draft" },
    orderBy: { createdAt: "desc" },
  });
  if (!record) return NextResponse.json({ draft: null });
  const payload = record.payload as { items?: unknown[]; groups?: unknown[] };
  return NextResponse.json({
    draft: {
      id: record.id,
      sourceName: record.sourceName,
      sourceKind: record.sourceKind,
      pageCount: record.pageCount,
      itemCount: record.itemCount,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      items: payload?.items ?? [],
      groups: payload?.groups ?? [],
    },
  });
}

export async function DELETE(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;
  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");
  if (me.role !== "manager") return err(403, "manager access required");

  const id = new URL(req.url).searchParams.get("id");
  await prisma.menuImport.updateMany({
    where: { restaurantId, status: "draft", ...(id ? { id } : {}) },
    data: { status: "discarded" },
  });
  return NextResponse.json({ ok: true });
}
