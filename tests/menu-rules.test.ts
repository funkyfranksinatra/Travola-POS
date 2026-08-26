// tests/menu-rules.test.ts — the ticket-mod contract.
//
// These decide what a kitchen sees on a ticket. The cases that matter
// are the ones where a naive keyword match gets it WRONG: a braised
// short rib has no temperature, a chicken-fried steak is not beef, and
// an espresso martini belongs to the bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraft, parsePriceCents, ruleGroupsFor, stationFor, templateFor, templateKeys } from "../lib/menu-rules.ts";

const groups = (name: string, cat = "", desc = "") => ruleGroupsFor(name, cat, desc).sort();

test("cooked-to-order red meat gets a temperature", () => {
  assert.ok(groups("Ribeye").includes("temperature"));
  assert.ok(groups("Filet Mignon").includes("temperature"));
  assert.ok(groups("Wagyu Burger").includes("temperature"));
  assert.ok(groups("Duck Breast").includes("temperature"));
  assert.ok(groups("Seared Ahi Tuna").includes("temperature"));
});

test("beef that is NOT cooked to order gets no temperature", () => {
  // The kitchen cannot cook a braise medium-rare; asking makes the
  // ticket unactionable.
  assert.ok(!groups("Braised Short Ribs").includes("temperature"));
  assert.ok(!groups("Beef Bolognese").includes("temperature"));
  assert.ok(!groups("Meatballs").includes("temperature"));
  assert.ok(!groups("Brisket Sandwich").includes("temperature"));
  assert.ok(!groups("Beef Chili").includes("temperature"));
});

test("poultry and fish are not treated as red meat", () => {
  assert.ok(!groups("Roast Chicken").includes("temperature"));
  assert.ok(!groups("Grilled Salmon").includes("temperature"));
  // "Chicken Fried Steak" contains the word steak and is breaded and
  // fried — it arrives one way.
  assert.ok(!groups("Chicken Fried Steak").includes("temperature"));
});

test("handhelds carry a side choice", () => {
  assert.ok(groups("Classic Cheeseburger").includes("side_choice"));
  assert.ok(groups("Turkey Club").includes("side_choice"));
  assert.ok(groups("Reuben").includes("side_choice"));
  assert.ok(!groups("Ribeye").includes("side_choice"));
});

test("a burger gets BOTH temperature and a side", () => {
  const g = groups("Bacon Cheeseburger");
  assert.ok(g.includes("temperature"), "burgers are cooked to order");
  assert.ok(g.includes("side_choice"), "and come with a side");
});

test("salads offer added protein and dressing", () => {
  const caesar = groups("Caesar Salad");
  assert.ok(caesar.includes("add_protein"), "add chicken to the caesar");
  assert.ok(caesar.includes("dressing"));
  assert.ok(groups("Cobb Salad").includes("add_protein"));
});

test("eggs, pasta and pizza get their own preparations", () => {
  assert.ok(groups("Eggs Benedict").includes("egg_style"));
  assert.ok(groups("Cacio e Pepe").includes("pasta_prep"));
  assert.ok(groups("Margherita Pizza").includes("pizza_prep"));
});

test("drinks get bar mods, not kitchen mods", () => {
  assert.ok(groups("Negroni", "Cocktails").includes("cocktail_prep"));
  assert.ok(groups("Chianti Classico", "Wine by the Glass").includes("wine_service"));
  assert.ok(groups("Cappuccino", "Coffee").includes("coffee_milk"));
  assert.ok(groups("Iced Tea", "Non-Alcoholic").includes("ice"));
  // A cocktail must never pick up a food side choice.
  assert.ok(!groups("Old Fashioned", "Cocktails").includes("side_choice"));
});

test("desserts get dessert service", () => {
  assert.ok(groups("Tiramisu", "Desserts").includes("dessert_service"));
  assert.ok(groups("Chocolate Cake", "Dolci").includes("dessert_service"));
  // A dessert "pie" must not be treated as a pizza pie.
  assert.ok(!groups("Apple Pie", "Desserts").includes("pizza_prep"));
});

test("station routing follows category context first", () => {
  assert.equal(stationFor("Ribeye", "Mains"), "kitchen");
  assert.equal(stationFor("Negroni", "Cocktails"), "bar");
  assert.equal(stationFor("Espresso Martini", "Cocktails"), "bar");
  assert.equal(stationFor("Chardonnay", "Wine"), "bar");
  assert.equal(stationFor("Tiramisu", "Desserts"), "kitchen");
  // No category at all — fall back to the item name.
  assert.equal(stationFor("IPA", ""), "bar");
  assert.equal(stationFor("Caesar Salad", ""), "kitchen");
});

test("prices parse from every way a menu writes them", () => {
  assert.equal(parsePriceCents("$24"), 2400);
  assert.equal(parsePriceCents("24"), 2400);
  assert.equal(parsePriceCents("24."), 2400);
  assert.equal(parsePriceCents("$18.50"), 1850);
  assert.equal(parsePriceCents("18,50"), 1850);
  assert.equal(parsePriceCents(21), 2100);
  assert.equal(parsePriceCents(16.5), 1650);
  // Glass/bottle: the by-the-glass price is what a server rings first.
  assert.equal(parsePriceCents("14/52"), 1400);
  // Market price is a menu convention, not a parse failure.
  assert.equal(parsePriceCents("MP"), null);
  assert.equal(parsePriceCents("Market Price"), null);
  assert.equal(parsePriceCents(""), null);
  assert.equal(parsePriceCents(null), null);
  assert.equal(parsePriceCents("delicious"), null);
  // A vintage year is not a price — wine lists are full of them.
  assert.equal(parsePriceCents("2019"), null);
  assert.equal(parsePriceCents("1998"), null);
  // But a real four-figure bottle price still parses.
  assert.equal(parsePriceCents("$1,250"), 125000);
  assert.equal(parsePriceCents("2019 — 68"), null); // vintage first; flagged for review
  // The comma is ambiguous, and reading a US thousands separator as a
  // decimal would ring a $1,250 bottle at $1.25.
  assert.equal(parsePriceCents("$1,250.00"), 125000);
  assert.equal(parsePriceCents("1,250"), 125000);
  assert.equal(parsePriceCents("18,50"), 1850); // European decimal comma
});

test("modifier groups are shared, not duplicated per item", () => {
  const { items, groups: g } = buildDraft([
    { name: "Ribeye", categoryName: "Steaks", price: "58" },
    { name: "Filet Mignon", categoryName: "Steaks", price: "64" },
    { name: "Sirloin", categoryName: "Steaks", price: "44" },
  ]);
  const temps = g.filter((x) => x.key === "temperature");
  assert.equal(temps.length, 1, "one Temperature group serves every steak");
  assert.equal(temps[0].minSelect, 1, "temperature is required");
  for (const item of items) assert.ok(item.modifierGroupKeys.includes("temperature"));
});

test("model suggestions fill gaps but never duplicate a rule", () => {
  const { groups: g } = buildDraft([
    {
      name: "Ribeye",
      categoryName: "Steaks",
      price: "58",
      // The model proposing its own doneness group must NOT create a
      // second, differently-spelled temperature group.
      suggestedModifiers: [
        { name: "Temperature", options: ["Rare", "Well"] },
        { name: "Sauce", options: ["Peppercorn", "Béarnaise"] },
      ],
    },
  ]);
  assert.equal(g.filter((x) => x.name.toLowerCase() === "temperature").length, 1);
  const sauce = g.find((x) => x.name === "Sauce");
  assert.ok(sauce, "a genuinely new suggestion is kept");
  assert.equal(sauce?.source, "model", "and is labelled as inferred");
});

test("items with no price are flagged for review, not guessed", () => {
  const { items } = buildDraft([
    { name: "Whole Branzino", categoryName: "Mains", price: "MP" },
    { name: "Ribeye", categoryName: "Mains", price: "58" },
  ]);
  const branzino = items.find((i) => i.name === "Whole Branzino")!;
  assert.equal(branzino.priceCents, null);
  assert.equal(branzino.needsReview, true);
  assert.equal(items.find((i) => i.name === "Ribeye")!.needsReview, false);
});

test("a whole mixed menu routes and mods coherently", () => {
  const { items } = buildDraft([
    { name: "Caesar Salad", categoryName: "Starters", price: "16" },
    { name: "Bacon Cheeseburger", categoryName: "Mains", price: "22" },
    { name: "Braised Short Rib", categoryName: "Mains", price: "38" },
    { name: "Negroni", categoryName: "Cocktails", price: "16" },
    { name: "Tiramisu", categoryName: "Desserts", price: "12" },
  ]);
  const by = (n: string) => items.find((i) => i.name === n)!;
  assert.equal(by("Negroni").station, "bar");
  assert.equal(by("Tiramisu").station, "kitchen");
  assert.ok(by("Caesar Salad").modifierGroupKeys.includes("add_protein"));
  assert.ok(by("Bacon Cheeseburger").modifierGroupKeys.includes("side_choice"));
  assert.ok(!by("Braised Short Rib").modifierGroupKeys.includes("temperature"));
  assert.ok(by("Negroni").modifierGroupKeys.includes("cocktail_prep"));
  assert.ok(by("Tiramisu").modifierGroupKeys.includes("dessert_service"));
});

test("blank and malformed rows are dropped, not imported", () => {
  const { items } = buildDraft([
    { name: "", price: "12" },
    { name: "   ", price: "12" },
    { name: "Real Item", price: "12" },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Real Item");
});

// ── Regressions found by running a real menu through the pipeline ────
// Every case below shipped wrong in the first pass. They share one
// cause: matching dish type against the printed DESCRIPTION, where
// ingredient words collide with dish types.

test("ingredient words in a description never decide the dish type", () => {
  // "fior di latte" is mozzarella, not a latte.
  assert.equal(stationFor("Margherita Pizza", "Mains", "San Marzano, fior di latte, basil"), "kitchen");
  assert.ok(!groups("Margherita Pizza", "Mains", "fior di latte").includes("coffee_milk"));
  // "white anchovy" is not a white wine.
  assert.equal(stationFor("Caesar Salad", "Starters", "Little gem, parmesan, white anchovy"), "kitchen");
  assert.ok(!groups("Caesar Salad", "Starters", "white anchovy").includes("wine_service"));
  // "egg yolk" in a tartare is an ingredient, not an egg cooked to order.
  assert.ok(!groups("Steak Tartare", "Starters", "egg yolk, capers").includes("egg_style"));
});

test("raw and cured preparations get no temperature", () => {
  // A tartare is raw; asking for a doneness stops the ticket.
  assert.ok(!groups("Steak Tartare", "Starters").includes("temperature"));
  assert.ok(!groups("Beef Carpaccio", "Starters").includes("temperature"));
  assert.ok(!groups("Tuna Crudo", "Starters").includes("temperature"));
  assert.ok(!groups("Hamachi Sashimi", "Starters").includes("temperature"));
  // But the cooked version still does.
  assert.ok(groups("Bavette Steak", "Mains").includes("temperature"));
});

test("a drink gets exactly one preparation group, never a stack", () => {
  // An espresso martini is a cocktail; offering milk options is wrong.
  const em = groups("Espresso Martini", "Cocktails");
  assert.deepEqual(em, ["cocktail_prep"]);
  const wine = groups("Chianti Classico", "Wine by the Glass");
  assert.deepEqual(wine, ["wine_service"]);
});

test("a section heading does not leak across its items", () => {
  // Under "COFFEE & TEA" the heading contains both words; each item must
  // still get its own treatment.
  assert.deepEqual(groups("Cappuccino", "Coffee & Tea"), ["coffee_milk"]);
  assert.deepEqual(groups("Iced Tea", "Coffee & Tea"), ["ice"]);
});

test("desserts stay clean of kitchen and bar mods", () => {
  // An affogato is espresso over gelato — still just a dessert.
  assert.deepEqual(groups("Affogato", "Desserts"), ["dessert_service"]);
  assert.deepEqual(groups("Tiramisu", "Desserts", "mascarpone, espresso, cocoa"), ["dessert_service"]);
});

test("every modifier template has a UNIQUE display name", () => {
  // Commit reuses modifier groups by name. When two templates shared the
  // name "Service", a wine's "By the glass / Bottle" pooled with a
  // dessert's "Add whipped cream" into one group and both dishes offered
  // all six. This invariant is what keeps that from coming back.
  const names = templateKeys.map((k) => templateFor(k)!.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, `duplicate template names: ${names.join(", ")}`);
});

test("a real mixed menu produces one group per distinct concept", () => {
  const { groups } = buildDraft([
    { name: "Chianti Classico", categoryName: "Wine by the Glass", price: "14/52" },
    { name: "Tiramisu", categoryName: "Desserts", price: "13" },
    { name: "Cacio e Pepe", categoryName: "Mains", price: "26" },
    { name: "Margherita Pizza", categoryName: "Mains", price: "19" },
    { name: "Negroni", categoryName: "Cocktails", price: "17" },
  ]);
  const names = groups.map((g) => g.name);
  assert.equal(new Set(names).size, names.length, "no two groups share a name");
  // And the wine's options never include a dessert's.
  const wine = groups.find((g) => g.key === "wine_service")!;
  assert.ok(!wine.modifiers.some((m) => /whipped|ice cream|candle/i.test(m.name)));
});

// ── Second pass: found by probing names a real menu would contain ────
// Every case below asked a kitchen for a doneness it cannot cook.

test("plant and poultry burgers get no temperature", () => {
  for (const name of ["Veggie Burger", "Impossible Burger", "Beyond Burger",
                      "Black Bean Burger", "Portobello Burger", "Turkey Burger"]) {
    const g = groups(name, "Mains");
    assert.ok(!g.includes("temperature"), `${name} should not ask a doneness`);
    assert.ok(g.includes("side_choice"), `${name} still comes with a side`);
  }
});

test("fish in bread is cooked through; fish as a steak is not", () => {
  assert.ok(!groups("Tuna Melt", "Sandwiches").includes("temperature"));
  assert.ok(!groups("Tuna Salad Sandwich", "Sandwiches").includes("temperature"));
  assert.ok(!groups("Salmon Burger", "Mains").includes("temperature"));
  // The seared steak still earns one.
  assert.ok(groups("Seared Ahi Tuna", "Mains").includes("temperature"));
});

test("breaded, fried and slow-cooked preparations get no temperature", () => {
  assert.ok(!groups("Chicken Fried Steak", "Mains").includes("temperature"));
  assert.ok(!groups("Veal Milanese", "Mains").includes("temperature"));
  assert.ok(!groups("Duck Confit", "Mains").includes("temperature"));
  assert.ok(!groups("Pulled Beef", "Mains").includes("temperature"));
  // Cooked-to-order versions are unaffected.
  assert.ok(groups("Beef Wellington", "Mains").includes("temperature"));
  assert.ok(groups("Prime Rib", "Mains").includes("temperature"));
  assert.ok(groups("Duck Breast", "Mains").includes("temperature"));
});

test("a sandwich with salad in its name is a sandwich", () => {
  // Offering "add grilled chicken" to a chicken salad sandwich is
  // nonsense on a ticket.
  const g = groups("Tuna Salad Sandwich", "Sandwiches");
  assert.ok(g.includes("side_choice"));
  assert.ok(!g.includes("add_protein"));
  // A real salad still gets it.
  assert.ok(groups("Chopped Salad", "Salads").includes("add_protein"));
});

test("a section heading supplies what an item name omits", () => {
  // "Grilled Cheese" names no handheld word but sits under SANDWICHES.
  assert.ok(groups("Grilled Cheese", "Sandwiches").includes("side_choice"));
  // "Lamb Ragu" names no pasta word but sits under PASTA.
  assert.ok(groups("Lamb Ragu", "Pasta").includes("pasta_prep"));
  assert.ok(!groups("Lamb Ragu", "Pasta").includes("temperature"), "a ragu has no doneness");
});

test("a drink under a dessert heading is still made by the bar", () => {
  assert.equal(stationFor("Espresso", "Desserts"), "bar");
  // But a plated dessert that merely contains espresso is not.
  assert.equal(stationFor("Affogato", "Desserts"), "kitchen");
  assert.equal(stationFor("Tiramisu", "Desserts"), "kitchen");
});

test("root beer is a soft drink, not a beer", () => {
  assert.equal(stationFor("Root Beer", "Soft Drinks"), "bar");
  assert.ok(groups("Root Beer", "Soft Drinks").includes("ice"));
});
