// POST /api/pos/menu/import/commit — the reviewed draft becomes the
// live catalog. This is the only place in the import flow that writes
// to the menu, and it takes what the MANAGER approved, not what the
// model produced: the client posts back the edited draft.
//
// Two modes, chosen per import:
//   merge   — add these items; an existing item with the same name in
//             the same category has its price/station/description
//             updated. Nothing is removed.
//   replace — this import becomes the menu. Old items are DEACTIVATED,
//             never deleted: CheckItem snapshots name and price at
//             order time, but a deleted MenuItem would still orphan
//             reporting and the 86 board. Deactivation keeps history
//             whole and is reversible.
//
// Modifier groups are matched by NAME within the restaurant, so a
// re-import reuses the existing "Temperature" group rather than
// creating a second one that splits the same choice across two tickets.
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { currentServer } from "@/lib/auth";
import { err } from "@/lib/pos-api";

export const maxDuration = 120;

const modifierSchema = z.object({
  name: z.string().min(1),
  priceCents: z.number().int().min(0).max(100_000).default(0),
});

const groupSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1).max(80),
  minSelect: z.number().int().min(0).max(10).default(0),
  maxSelect: z.number().int().min(1).max(20).default(1),
  modifiers: z.array(modifierSchema).min(1).max(40),
});

const itemSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  // Null is rejected here on purpose: an item with no price cannot be
  // rung up, so review must resolve it before saving.
  priceCents: z.number().int().min(0).max(1_000_000),
  categoryName: z.string().min(1).max(80),
  station: z.string().min(1).max(40),
  modifierGroupKeys: z.array(z.string()).default([]),
});

const bodySchema = z.object({
  importId: z.string().optional(),
  mode: z.enum(["merge", "replace"]),
  items: z.array(itemSchema).min(1).max(1000),
  groups: z.array(groupSchema).max(100).default([]),
});

export async function POST(req: Request) {
  const auth = await requireRestaurant();
  if ("response" in auth) return auth.response;
  const { restaurantId } = auth;
  const me = await currentServer(restaurantId);
  if (!me) return err(401, "not logged in");
  if (me.role !== "manager") return err(403, "manager access required");

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(400, `invalid draft: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim());
  }
  const { importId, mode, items, groups } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // ── Stations referenced by the draft must exist, or a ticket has
      //    nowhere to print.
      const stationKeys = [...new Set(items.map((i) => i.station))];
      const existingStations = await tx.station.findMany({
        where: { restaurantId, key: { in: stationKeys } },
        select: { key: true },
      });
      const haveStation = new Set(existingStations.map((s) => s.key));
      for (const key of stationKeys) {
        if (haveStation.has(key)) continue;
        await tx.station.create({
          data: {
            restaurantId,
            key,
            name: key.charAt(0).toUpperCase() + key.slice(1),
          },
        });
      }

      // ── Modifier groups: reuse by name, create what is missing ──────
      const existingGroups = await tx.modifierGroup.findMany({
        where: { restaurantId },
        include: { modifiers: true },
      });
      const groupByName = new Map(existingGroups.map((g) => [g.name.toLowerCase(), g]));
      const groupIdByKey = new Map<string, string>();

      for (const group of groups) {
        const found = groupByName.get(group.name.toLowerCase());
        if (found) {
          groupIdByKey.set(group.key, found.id);
          // Only ADD options the group is missing. Editing or removing
          // an existing modifier would silently change how every dish
          // already using this group behaves.
          const have = new Set(found.modifiers.map((m) => m.name.toLowerCase()));
          const missing = group.modifiers.filter((m) => !have.has(m.name.toLowerCase()));
          if (missing.length) {
            await tx.modifier.createMany({
              data: missing.map((m, index) => ({
                groupId: found.id,
                name: m.name,
                priceCents: m.priceCents,
                sortOrder: found.modifiers.length + index,
              })),
            });
          }
          continue;
        }
        const created = await tx.modifierGroup.create({
          data: {
            restaurantId,
            name: group.name,
            minSelect: group.minSelect,
            maxSelect: Math.max(group.minSelect, group.maxSelect),
            modifiers: {
              create: group.modifiers.map((m, index) => ({
                name: m.name,
                priceCents: m.priceCents,
                sortOrder: index,
              })),
            },
          },
        });
        groupIdByKey.set(group.key, created.id);
      }

      // ── Categories: reuse by name, create what is missing ───────────
      const categoryNames = [...new Set(items.map((i) => i.categoryName))];
      const existingCategories = await tx.menuCategory.findMany({ where: { restaurantId } });
      const categoryByName = new Map(existingCategories.map((c) => [c.name.toLowerCase(), c]));
      const categoryIdByName = new Map<string, string>();
      for (const [index, name] of categoryNames.entries()) {
        const found = categoryByName.get(name.toLowerCase());
        if (found) {
          categoryIdByName.set(name, found.id);
          // A category deactivated by an earlier replace comes back when
          // a new import uses it again.
          if (!found.active) {
            await tx.menuCategory.update({ where: { id: found.id }, data: { active: true } });
          }
          continue;
        }
        const created = await tx.menuCategory.create({
          data: {
            restaurantId,
            name,
            sortOrder: existingCategories.length + index,
            active: true,
          },
        });
        categoryIdByName.set(name, created.id);
      }

      // ── Items ──────────────────────────────────────────────────────
      const existingItems = await tx.menuItem.findMany({
        where: { restaurantId, ephemeral: false },
        select: { id: true, name: true, categoryId: true },
      });
      const itemKey = (name: string, categoryId: string) =>
        `${name.trim().toLowerCase()}|${categoryId}`;
      const itemByKey = new Map(existingItems.map((i) => [itemKey(i.name, i.categoryId), i]));

      let created = 0;
      let updated = 0;
      const touched = new Set<string>();

      for (const [index, item] of items.entries()) {
        const categoryId = categoryIdByName.get(item.categoryName)!;
        const groupIds = item.modifierGroupKeys
          .map((key) => groupIdByKey.get(key))
          .filter((id): id is string => !!id);
        const existing = itemByKey.get(itemKey(item.name, categoryId));

        if (existing) {
          await tx.menuItem.update({
            where: { id: existing.id },
            data: {
              priceCents: item.priceCents,
              station: item.station,
              description: item.description,
              active: true,
              sortOrder: index,
              // `set` so a re-import removes groups the manager deleted
              // in review, rather than accumulating stale ones.
              modifierGroups: { set: groupIds.map((id) => ({ id })) },
            },
          });
          touched.add(existing.id);
          updated += 1;
          continue;
        }

        const row = await tx.menuItem.create({
          data: {
            restaurantId,
            categoryId,
            name: item.name,
            priceCents: item.priceCents,
            station: item.station,
            description: item.description,
            sortOrder: index,
            active: true,
            ephemeral: false,
            createdBy: me.name,
            modifierGroups: { connect: groupIds.map((id) => ({ id })) },
          },
        });
        touched.add(row.id);
        created += 1;
      }

      // ── Replace: deactivate what this import did not include ────────
      let deactivated = 0;
      if (mode === "replace") {
        const stale = existingItems.filter((i) => !touched.has(i.id)).map((i) => i.id);
        if (stale.length) {
          const res = await tx.menuItem.updateMany({
            where: { id: { in: stale }, restaurantId },
            data: { active: false },
          });
          deactivated = res.count;
        }
      }

      if (importId) {
        await tx.menuImport.updateMany({
          where: { id: importId, restaurantId },
          data: { status: "committed", commitMode: mode, committedAt: new Date() },
        });
      } else {
        await tx.menuImport.updateMany({
          where: { restaurantId, status: "draft" },
          data: { status: "committed", commitMode: mode, committedAt: new Date() },
        });
      }

      return { created, updated, deactivated, categories: categoryNames.length, groups: groups.length };
    }, { timeout: 60_000 });

    return NextResponse.json({ ok: true, mode, ...result });
  } catch (error) {
    console.error("[api/pos/menu/import/commit]", error);
    return err(500, "could not save the menu — nothing was changed");
  }
}
