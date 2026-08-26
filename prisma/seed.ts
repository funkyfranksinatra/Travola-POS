// prisma/seed.ts — Volario's-style demo MENU (menu, stations, settings).
// Run: node --experimental-strip-types prisma/seed.ts
//
// SHARED-DB build: staff and floor live in the Travola-OS tables and
// are NEVER seeded from here — the floor app owns them. Set
// POS_RESTAURANT_ID to the Restaurant.id you want the menu seeded into
// (default rest_demo for scratch databases). This CLI binding is the
// only place that env var is authoritative — the running app always
// takes its tenant from the signed-in restaurant session instead.
import "dotenv/config";
import { PrismaClient } from "../lib/generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const R = process.env.POS_RESTAURANT_ID ?? "rest_demo";

async function main() {
  // idempotent: wipe demo tenant first (order matters for FKs)
  await prisma.payment.deleteMany({ where: { restaurantId: R } });
  await prisma.checkItem.deleteMany({ where: { check: { restaurantId: R } } });
  await prisma.check.deleteMany({ where: { restaurantId: R } });
  await prisma.modifier.deleteMany({ where: { group: { restaurantId: R } } });
  await prisma.modifierGroup.deleteMany({ where: { restaurantId: R } });
  await prisma.menuItem.deleteMany({ where: { restaurantId: R } });
  await prisma.menuCategory.deleteMany({ where: { restaurantId: R } });
  await prisma.station.deleteMany({ where: { restaurantId: R } });
  await prisma.posSettings.deleteMany({ where: { restaurantId: R } });

  await prisma.addOn.deleteMany({ where: { restaurantId: R } });

  await prisma.station.createMany({
    data: [
      { restaurantId: R, key: "kitchen", name: "Kitchen" },
      { restaurantId: R, key: "bar", name: "Bar" },
    ],
  });

  // Staff + floorplan: OWNED BY THE FLOOR APP (shared DB). Nothing to
  // seed here — log in with a Server PIN set in Travola-OS.

  await prisma.posSettings.create({
    data: { restaurantId: R, taxRateBps: 840, tipPresets: [18, 20, 25] },
  });

  const temp = await prisma.modifierGroup.create({
    data: {
      restaurantId: R, name: "Temperature", minSelect: 1, maxSelect: 1,
      modifiers: { create: ["Rare", "Medium rare", "Medium", "Medium well", "Well"].map((n, i) => ({ name: n, sortOrder: i })) },
    },
  });
  const addons = await prisma.modifierGroup.create({
    data: {
      restaurantId: R, name: "Add-ons", minSelect: 0, maxSelect: 3,
      modifiers: {
        create: [
          { name: "Add bacon", priceCents: 250, sortOrder: 0 },
          { name: "Add egg", priceCents: 150, sortOrder: 1 },
          { name: "Truffle fries upgrade", priceCents: 400, sortOrder: 2 },
        ],
      },
    },
  });
  const dressing = await prisma.modifierGroup.create({
    data: {
      restaurantId: R, name: "Dressing", minSelect: 1, maxSelect: 1,
      modifiers: { create: ["Ranch", "Balsamic", "Caesar", "Oil & vinegar"].map((n, i) => ({ name: n, sortOrder: i })) },
    },
  });
  const spirits = await prisma.modifierGroup.create({
    data: {
      restaurantId: R, name: "Spirit", minSelect: 0, maxSelect: 1,
      modifiers: {
        create: [
          { name: "Well", priceCents: 0, sortOrder: 0 },
          { name: "Tito's", priceCents: 200, sortOrder: 1 },
          { name: "Grey Goose", priceCents: 400, sortOrder: 2 },
        ],
      },
    },
  });

  const cats: [string, [string, number, string, string[]?][]][] = [
    ["Starters", [
      ["Elk Meatballs", 1600, "kitchen"],
      ["Burrata & Peach", 1500, "kitchen"],
      ["Green Chile Queso", 1200, "kitchen"],
      ["House Salad", 1100, "kitchen", [dressing.id]],
      ["Crispy Brussels", 1300, "kitchen"],
    ]],
    ["Mains", [
      ["Ribeye 14oz", 4800, "kitchen", [temp.id, addons.id]],
      ["Travola Burger", 1900, "kitchen", [temp.id, addons.id]],
      ["Pan-Roasted Trout", 3200, "kitchen"],
      ["Mushroom Risotto", 2600, "kitchen"],
      ["Half Roast Chicken", 2900, "kitchen"],
      ["Winter Park Pasta", 2400, "kitchen"],
    ]],
    ["Desserts", [
      ["Basque Cheesecake", 1200, "kitchen"],
      ["Chocolate Torte", 1300, "kitchen"],
      ["Affogato", 900, "bar"],
    ]],
    ["Cocktails", [
      ["Old Fashioned", 1500, "bar"],
      ["Espresso Martini", 1600, "bar", [spirits.id]],
      ["Moscow Mule", 1400, "bar", [spirits.id]],
      ["Margarita", 1400, "bar"],
    ]],
    ["Wine & Beer", [
      ["House Red (glass)", 1200, "bar"],
      ["House White (glass)", 1100, "bar"],
      ["Local IPA", 800, "bar"],
      ["Pilsner", 700, "bar"],
    ]],
  ];

  let catOrder = 0;
  for (const [catName, items] of cats) {
    const cat = await prisma.menuCategory.create({
      data: { restaurantId: R, name: catName, sortOrder: catOrder++ },
    });
    let i = 0;
    for (const [name, priceCents, station, groups] of items) {
      await prisma.menuItem.create({
        data: {
          restaurantId: R, categoryId: cat.id, name, priceCents, station, sortOrder: i++,
          ...(groups?.length ? { modifierGroups: { connect: groups.map((id) => ({ id })) } } : {}),
        },
      });
    }
  }
  // Permanent (manager) add-on tags: a couple global + one dish-specific.
  const salad = await prisma.menuItem.findFirst({ where: { restaurantId: R, name: "House Salad" } });
  await prisma.addOn.createMany({
    data: [
      { restaurantId: R, name: "Gluten free", priceCents: 0, createdBy: "Manager" },
      { restaurantId: R, name: "On the side", priceCents: 0, createdBy: "Manager" },
      { restaurantId: R, name: "Extra sauce", priceCents: 100, createdBy: "Manager" },
      { restaurantId: R, menuItemId: salad!.id, name: "Add chicken", priceCents: 600, createdBy: "Manager" },
    ],
  });

  console.log("seeded: menu into tenant " + R + " — staff/floor live in Travola-OS (shared DB)");
}

main().finally(() => prisma.$disconnect());
