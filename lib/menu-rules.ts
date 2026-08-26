// lib/menu-rules.ts — the deterministic half of menu import.
//
// WHY RULES AND NOT JUST THE MODEL: a language model reading a menu is
// excellent at "what are the items and prices" and unreliable at "every
// steak must offer the same five temperatures, spelled the same way".
// Left to itself it invents "Temp", "Temperature", "Cook temp" across
// three pages, and forgets the side choice on the third burger. Those
// are exactly the parts a kitchen cannot tolerate being inconsistent.
//
// So: the model extracts, these rules decide the ticket mods. Rules are
// pure, unit-tested, free, instant, and identical on every run. The
// model's own suggestions are kept only where no rule fired, so it can
// still catch a house speciality the rules never heard of.
//
// Everything here is a default a manager overrides in the review screen.

export type DraftModifier = { name: string; priceCents: number };
export type DraftModifierGroup = {
  /** Stable key used to DEDUPE across items — every steak shares one
   *  "temperature" group rather than each owning a private copy. */
  key: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: DraftModifier[];
  /** "rule" = guaranteed by the pack below; "model" = the LLM proposed
   *  it and no rule covered that ground. Surfaced in review so a manager
   *  can see what was inferred rather than read. */
  source: "rule" | "model";
};

export type DraftItem = {
  name: string;
  description: string;
  priceCents: number | null;
  categoryName: string;
  station: string;
  modifierGroupKeys: string[];
  /** Set when the rules or the model were unsure — sorts to the top of
   *  review so a manager checks these first. */
  needsReview: boolean;
  reviewNote: string;
};

// ── Word matching ────────────────────────────────────────────────────
// Whole-word matching, so "burgundy" is not a "burger" and a
// "chicken-fried steak" is not beef. Menus are short strings written by
// humans; substring matching produces embarrassing tickets.
const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function hasAny(haystack: string[], needles: string[]) {
  const set = new Set(haystack);
  return needles.some((n) =>
    n.includes(" ") ? haystack.join(" ").includes(n) : set.has(n)
  );
}

// ── Shared modifier group templates ──────────────────────────────────
// Named ONCE here; every item that needs one points at the same key.
//
// ⚠ DISPLAY NAMES MUST BE UNIQUE. Commit reuses an existing modifier
// group by NAME (so re-importing a menu shares the one "Temperature"
// group rather than creating a second). Two templates sharing a name
// therefore merge into one group and pool their options — which is how
// a wine briefly came to offer "Add whipped cream". A test enforces it.
const TEMPLATES: Record<string, Omit<DraftModifierGroup, "source">> = {
  temperature: {
    key: "temperature",
    name: "Temperature",
    minSelect: 1, // the kitchen cannot cook a steak without one
    maxSelect: 1,
    modifiers: [
      { name: "Rare", priceCents: 0 },
      { name: "Medium rare", priceCents: 0 },
      { name: "Medium", priceCents: 0 },
      { name: "Medium well", priceCents: 0 },
      { name: "Well done", priceCents: 0 },
    ],
  },
  side_choice: {
    key: "side_choice",
    name: "Choice of side",
    minSelect: 1,
    maxSelect: 1,
    modifiers: [
      { name: "Fries", priceCents: 0 },
      { name: "Side salad", priceCents: 0 },
      { name: "Seasonal vegetable", priceCents: 0 },
      { name: "Mashed potatoes", priceCents: 0 },
    ],
  },
  add_protein: {
    key: "add_protein",
    name: "Add protein",
    minSelect: 0,
    maxSelect: 1,
    modifiers: [
      { name: "Add grilled chicken", priceCents: 700 },
      { name: "Add shrimp", priceCents: 900 },
      { name: "Add salmon", priceCents: 1100 },
      { name: "Add steak", priceCents: 1200 },
    ],
  },
  egg_style: {
    key: "egg_style",
    name: "Egg style",
    minSelect: 1,
    maxSelect: 1,
    modifiers: [
      { name: "Over easy", priceCents: 0 },
      { name: "Over medium", priceCents: 0 },
      { name: "Over hard", priceCents: 0 },
      { name: "Scrambled", priceCents: 0 },
      { name: "Poached", priceCents: 0 },
    ],
  },
  dressing: {
    key: "dressing",
    name: "Dressing",
    minSelect: 0,
    maxSelect: 1,
    modifiers: [
      { name: "On the side", priceCents: 0 },
      { name: "Light dressing", priceCents: 0 },
      { name: "No dressing", priceCents: 0 },
    ],
  },
  pasta_prep: {
    key: "pasta_prep",
    name: "Pasta options",
    minSelect: 0,
    maxSelect: 2,
    modifiers: [
      { name: "Gluten-free pasta", priceCents: 300 },
      { name: "Extra sauce", priceCents: 150 },
      { name: "No cheese", priceCents: 0 },
    ],
  },
  pizza_prep: {
    key: "pizza_prep",
    name: "Pizza options",
    minSelect: 0,
    maxSelect: 3,
    modifiers: [
      { name: "Well done", priceCents: 0 },
      { name: "Light sauce", priceCents: 0 },
      { name: "No cheese", priceCents: 0 },
      { name: "Gluten-free crust", priceCents: 400 },
    ],
  },
  cocktail_prep: {
    key: "cocktail_prep",
    name: "Cocktail style",
    minSelect: 0,
    maxSelect: 2,
    modifiers: [
      { name: "Up", priceCents: 0 },
      { name: "On the rocks", priceCents: 0 },
      { name: "Extra dry", priceCents: 0 },
      { name: "Dirty", priceCents: 0 },
      { name: "Twist", priceCents: 0 },
    ],
  },
  wine_service: {
    key: "wine_service",
    name: "Wine service",
    minSelect: 0,
    maxSelect: 1,
    modifiers: [
      { name: "By the glass", priceCents: 0 },
      { name: "Bottle", priceCents: 0 },
    ],
  },
  coffee_milk: {
    key: "coffee_milk",
    name: "Milk",
    minSelect: 0,
    maxSelect: 1,
    modifiers: [
      { name: "Whole", priceCents: 0 },
      { name: "Oat", priceCents: 75 },
      { name: "Almond", priceCents: 75 },
      { name: "Skim", priceCents: 0 },
      { name: "No milk", priceCents: 0 },
    ],
  },
  ice: {
    key: "ice",
    name: "Ice",
    minSelect: 0,
    maxSelect: 1,
    modifiers: [
      { name: "No ice", priceCents: 0 },
      { name: "Light ice", priceCents: 0 },
      { name: "Extra ice", priceCents: 0 },
    ],
  },
  dessert_service: {
    key: "dessert_service",
    name: "Dessert extras",
    minSelect: 0,
    maxSelect: 2,
    modifiers: [
      { name: "Add vanilla ice cream", priceCents: 300 },
      { name: "Add whipped cream", priceCents: 100 },
      { name: "Extra spoons", priceCents: 0 },
      { name: "Birthday candle", priceCents: 0 },
    ],
  },
};

export function templateFor(key: string) {
  return TEMPLATES[key] ?? null;
}
export const templateKeys = Object.keys(TEMPLATES);

// ── Vocabulary ───────────────────────────────────────────────────────
const BEEF = ["steak", "ribeye", "sirloin", "filet", "mignon", "strip", "porterhouse",
  "tbone", "t-bone", "flatiron", "hanger", "skirt", "tomahawk", "prime rib", "chateaubriand",
  "burger", "cheeseburger", "hamburger", "patty", "beef", "wagyu", "bavette", "picanha"];
/** Preparations with no doneness to ask about. A braise, a grind in a
 *  sauce, or anything breaded and fried arrives one way; asking for a
 *  temperature produces a ticket the kitchen has to come back and
 *  query. */
const BEEF_NO_TEMP = ["braised", "stew", "stewed", "bolognese", "ragu", "ragout", "meatball",
  "meatballs", "brisket", "short rib", "short ribs", "pot roast", "carnitas", "barbacoa",
  "shredded", "ground", "chili", "jerky", "pastrami", "corned", "well-done only", "smash",
  // Breaded/fried preparations are cooked through by definition. A
  // "chicken-fried steak" contains the word steak and is none of it.
  "chicken fried", "chicken-fried", "fried", "breaded", "katsu", "schnitzel", "milanese",
  "confit", "rillette", "terrine", "slow roast", "slow-roasted", "pulled",
  "parmigiana", "parmesan", "tempura", "crispy"];
/** Plant and non-red proteins wearing a red-meat word — almost always
 *  in burger form. An Impossible burger has one doneness, and a kitchen
 *  asked for "medium rare" on one has to stop and check the ticket. */
const NOT_RED_MEAT = ["veggie", "vegetable", "vegetarian", "vegan", "impossible", "beyond",
  "plant", "black bean", "portobello", "portabella", "mushroom", "falafel", "chickpea",
  "lentil", "tofu", "halloumi", "turkey", "chicken", "salmon", "cod", "shrimp", "crab",
  "lobster", "scallop", "quinoa", "cauliflower"];
const LAMB_DUCK = ["lamb", "duck", "venison", "tuna", "ahi"]; // also temperature-cooked
/** Served raw or cured — there is no temperature to ask for, and asking
 *  for one on a tartare makes the kitchen stop and query the ticket. */
const RAW_PREP = ["tartare", "carpaccio", "crudo", "ceviche", "sashimi", "poke",
  "cured", "smoked salmon", "gravlax", "prosciutto", "bresaola"];
const HANDHELD = ["burger", "cheeseburger", "hamburger", "sandwich", "club", "blt", "wrap",
  "panini", "hoagie", "sub", "melt", "reuben", "po boy", "po'boy", "banh mi", "torta", "gyro",
  "grilled cheese", "toastie", "patty melt", "french dip", "muffuletta", "cheesesteak"];
/** Section headings that make an item a handheld even when its name
 *  does not say so ("Grilled Cheese" under SANDWICHES). */
const HANDHELD_CATEGORY = ["sandwich", "sandwiches", "handhelds", "burgers", "paninis", "subs"];
const SALAD_CATEGORY = ["salad", "salads", "greens"];
const PASTA_CATEGORY = ["pasta", "pastas", "primi", "noodles"];
const PIZZA_CATEGORY = ["pizza", "pizze", "pizzas", "flatbreads"];
const SALAD = ["salad", "caesar", "cobb", "nicoise", "wedge", "greens", "chopped"];
const EGGS = ["egg", "eggs", "omelette", "omelet", "benedict", "frittata", "scramble"];
const PASTA = ["pasta", "spaghetti", "linguine", "fettuccine", "penne", "rigatoni", "cavatelli",
  "tagliatelle", "pappardelle", "gnocchi", "carbonara", "cacio", "lasagna", "risotto", "ravioli"];
const PIZZA = ["pizza", "pie", "margherita", "marinara", "pepperoni", "focaccia", "flatbread"];
const COCKTAIL = ["cocktail", "martini", "negroni", "manhattan", "margarita", "daiquiri",
  "old fashioned", "fashioned", "mule", "spritz", "sour", "gimlet", "highball", "julep",
  "sazerac", "boulevardier", "paloma", "mojito", "cosmopolitan", "aperol", "campari"];
// NOTE: no bare colour words ("red", "white", "rosé") — those appear in
// food descriptions constantly ("white anchovy", "red onion") and turned
// a Caesar salad into a wine. Wine is recognised by varietal, by the
// word "wine", or by its section heading.
const WINE = ["wine", "chardonnay", "cabernet", "merlot",
  "pinot", "sauvignon", "riesling", "syrah", "malbec", "tempranillo", "sangiovese", "chianti",
  "prosecco", "champagne", "sparkling", "nebbiolo", "barolo", "grenache", "zinfandel"];
const BEER = ["beer", "lager", "pilsner", "ale", "ipa", "stout", "porter", "hefeweizen",
  "saison", "draft", "draught", "cider"];
const SPIRIT = ["whiskey", "whisky", "bourbon", "rye", "scotch", "vodka", "gin", "rum",
  "tequila", "mezcal", "cognac", "brandy", "amaro", "vermouth", "digestif", "aperitif"];
const COFFEE = ["coffee", "espresso", "latte", "cappuccino", "americano", "macchiato",
  "cortado", "mocha", "flat white", "cold brew", "drip"];
const TEA_SOFT = ["tea", "chai", "matcha", "soda", "cola", "coke", "sprite", "lemonade",
  "juice", "iced tea", "sparkling water", "still water", "san pellegrino", "seltzer",
  "ginger ale", "root beer", "ginger beer", "tonic", "kombucha", "horchata"];
const DESSERT = ["dessert", "cake", "cheesecake", "tiramisu", "gelato", "sorbet", "ice cream",
  "sundae", "brownie", "pie", "tart", "panna cotta", "creme brulee", "crème brûlée", "affogato",
  "cannoli", "profiterole", "mousse", "cobbler", "budino", "semifreddo"];

const DRINK_CATEGORY = ["drink", "drinks", "beverage", "beverages", "cocktail", "cocktails",
  "wine", "wines", "beer", "beers", "bar", "spirits", "aperitif", "digestif", "by the glass",
  "bottles", "cellar", "list", "non alcoholic", "nonalcoholic", "mocktail", "mocktails", "coffee", "tea"];
const DESSERT_CATEGORY = ["dessert", "desserts", "sweets", "dolci", "pastry", "pastries"];

const isDrinkContext = (categoryWords: string[]) => hasAny(categoryWords, DRINK_CATEGORY);

/**
 * WHAT WE MATCH ON, AND WHY NOT THE DESCRIPTION.
 *
 * Dish type is read from the item NAME plus its section heading. The
 * printed description is deliberately NOT keyword-matched: it is a list
 * of ingredients, and ingredients collide violently with dish types.
 * Real examples from one test menu — "Margherita Pizza / fior di latte"
 * became a coffee (latte), "Caesar Salad / white anchovy" became a wine
 * (white), and "Steak Tartare / egg yolk" asked the kitchen for an egg
 * style. A name and a section heading are what a human reads to decide
 * these, and they are far cleaner signals.
 */

/** Which station prints the ticket. Drinks go to the bar; everything
 *  else to the kitchen. Section heading wins over the item name, so
 *  "Espresso Martini" under COCKTAILS is a bar item and an "Affogato"
 *  under DESSERTS stays with the kitchen. */
export function stationFor(itemName: string, categoryName: string, _description = "") {
  const cat = words(categoryName);
  const name = words(itemName);
  if (isDrinkContext(cat)) return "bar";
  // Checked BEFORE the dessert heading: an "Espresso" listed under
  // DESSERTS is still made by the bar, while an "Affogato" — which does
  // not name a drink — stays with the kitchen that plates it.
  if (hasAny(name, [...COCKTAIL, ...WINE, ...BEER, ...SPIRIT, ...COFFEE, ...TEA_SOFT])) return "bar";
  if (hasAny(cat, DESSERT_CATEGORY)) return "kitchen";
  return "kitchen";
}

/** The modifier groups a dish must carry, by rule. */
export function ruleGroupsFor(itemName: string, categoryName: string, _description = ""): string[] {
  const cat = words(categoryName);
  const name = words(itemName);
  const nameText = itemName.toLowerCase();
  const keys = new Set<string>();

  // ── Drinks: one preparation group, by kind, never stacked ──────────
  const drinkSection = isDrinkContext(cat);
  const looksDrink =
    hasAny(name, [...COCKTAIL, ...SPIRIT, ...WINE, ...BEER]) ||
    (drinkSection && !hasAny(cat, DESSERT_CATEGORY));
  if (looksDrink) {
    const isCocktail = hasAny(name, [...COCKTAIL, ...SPIRIT]) || hasAny(cat, ["cocktail", "cocktails", "spirits"]);
    const isWine = hasAny(name, WINE) || hasAny(cat, ["wine", "wines", "cellar", "by the glass", "bottles"]);
    if (isCocktail) keys.add("cocktail_prep");
    else if (isWine) keys.add("wine_service");
    else if (hasAny(name, COFFEE)) keys.add("coffee_milk");
    else if (hasAny(name, TEA_SOFT)) keys.add("ice");
    return [...keys];
  }

  // ── Desserts: return before anything else can add kitchen mods ─────
  // (an Affogato is espresso and gelato, but a Milk group on a dessert
  // is noise on the ticket).
  if (hasAny(cat, DESSERT_CATEGORY) || hasAny(name, DESSERT)) {
    keys.add("dessert_service");
    return [...keys];
  }

  // ── Coffee and soft drinks sold outside a drinks section ───────────
  if (hasAny(name, COFFEE)) {
    keys.add("coffee_milk");
    return [...keys];
  }
  if (hasAny(name, TEA_SOFT)) {
    keys.add("ice");
    return [...keys];
  }

  // ── Food ───────────────────────────────────────────────────────────
  const handheld = hasAny(name, HANDHELD) || hasAny(cat, HANDHELD_CATEGORY);

  // TEMPERATURE is the narrowest rule here and the one that costs most
  // when it is wrong, so it is gated three ways: the dish must name a
  // red meat, must not be a preparation without a doneness (braised,
  // ground, breaded, raw), and must not be a plant or non-red protein
  // wearing a red-meat word — a Veggie Burger, a Turkey Burger and a
  // Tuna Melt all matched "burger"/"tuna" before this guard existed.
  const noDoneness =
    BEEF_NO_TEMP.some((w) => nameText.includes(w)) ||
    RAW_PREP.some((w) => nameText.includes(w)) ||
    NOT_RED_MEAT.some((w) => nameText.includes(w));
  const redMeat = hasAny(name, BEEF) || hasAny(name, LAMB_DUCK);
  // Tuna earns a temperature as a seared steak and never inside bread:
  // a Tuna Melt is cooked through, and a Tuna Salad Sandwich is not even
  // a steak. Same for any fish that reached this point in handheld form.
  const fishInBread = handheld && hasAny(name, ["tuna", "ahi", "salmon"]);
  if (redMeat && !noDoneness && !fishInBread) keys.add("temperature");

  // Handhelds come with a side; that choice belongs on the ticket.
  if (handheld) keys.add("side_choice");

  // A "chicken salad sandwich" is a sandwich, not a salad — offering to
  // add chicken to it is nonsense on a ticket.
  if (!handheld && (hasAny(name, SALAD) || hasAny(cat, SALAD_CATEGORY))) {
    keys.add("add_protein");
    keys.add("dressing");
  }
  if (hasAny(name, EGGS)) keys.add("egg_style");
  if (hasAny(name, PASTA) || hasAny(cat, PASTA_CATEGORY)) keys.add("pasta_prep");
  if (hasAny(name, PIZZA) || hasAny(cat, PIZZA_CATEGORY)) keys.add("pizza_prep");

  return [...keys];
}

// ── Price parsing ────────────────────────────────────────────────────
/** Menu prices are written every possible way: "24", "$24", "24.", "24-",
 *  "MP", "24/38" (glass/bottle). Integer cents out, or null when there
 *  is genuinely no price to read — never a guess. */
export function parsePriceCents(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // A bare number from the model is dollars unless it is already cents
    // (an integer over 1000 with no decimal is almost certainly cents).
    return Math.round(raw * 100);
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  // "market price" / "MP" / "seasonal" — a real menu convention, not a
  // parse failure. Null price flags the item for review.
  if (/^(mp|m\.p\.|market|market price|seasonal|ask|priced daily)$/.test(text)) return null;
  // Take the FIRST money-looking number: "24/38" is glass 24, bottle 38,
  // and the by-the-glass price is what a server rings first.
  //
  // The comma is ambiguous and getting it wrong is expensive in the
  // dangerous direction: a US thousands separator read as a decimal
  // turns a $1,250 bottle into $1.25. So separators are resolved
  // explicitly before any number is taken.
  //   "1,250" / "1,250.00"  → thousands (US)   → 1250
  //   "18,50"               → decimal (Europe) → 18.50
  const match = text.match(
    /(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)/
  );
  if (!match) return null;
  const token = match[1];
  const normalized = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(token)
    ? token.replace(/,/g, "") // thousands separators
    : token.replace(",", "."); // decimal comma
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  // A bare four-digit number in year range is a vintage, not a price —
  // wine lists are full of them ("Barolo 2019"), and no kitchen prices a
  // dish at $2,019. Null flags it for review instead of ringing in a
  // two-thousand-dollar plate.
  if (/^\d{4}$/.test(token) && value >= 1900 && value <= 2100) return null;
  // Absolute sanity cap for anything else that slipped through.
  if (value > 5000) return null;
  return Math.round(value * 100);
}

// ── Assembly ─────────────────────────────────────────────────────────
export type ExtractedItem = {
  name: string;
  description?: string | null;
  price?: string | number | null;
  categoryName?: string | null;
  /** Free-form modifier ideas from the model, used only where no rule
   *  fired on that ground. */
  suggestedModifiers?: { name: string; options: string[] }[] | null;
};

const slug = (text: string) =>
  words(text).join("_").slice(0, 40) || "group";

/**
 * Turn raw extraction into the reviewable draft: rules decide station
 * and ticket mods, model suggestions fill only genuine gaps, and every
 * modifier group is deduped into one shared definition.
 */
export function buildDraft(items: ExtractedItem[], fallbackCategory = "Menu") {
  const groups = new Map<string, DraftModifierGroup>();
  const drafts: DraftItem[] = [];

  for (const raw of items) {
    const name = (raw.name ?? "").trim();
    if (!name) continue;
    const description = (raw.description ?? "").trim();
    const categoryName = (raw.categoryName ?? "").trim() || fallbackCategory;
    const priceCents = parsePriceCents(raw.price ?? null);

    const keys = ruleGroupsFor(name, categoryName, description);
    for (const key of keys) {
      if (groups.has(key)) continue;
      const template = TEMPLATES[key];
      if (template) groups.set(key, { ...template, source: "rule" });
    }

    // Model suggestions are additive only: a rule-covered concept is
    // never duplicated under a second, differently-spelled group.
    for (const suggestion of raw.suggestedModifiers ?? []) {
      const suggestedName = (suggestion?.name ?? "").trim();
      const options = (suggestion?.options ?? []).map((o) => String(o).trim()).filter(Boolean);
      if (!suggestedName || options.length === 0) continue;
      const key = `model_${slug(suggestedName)}`;
      const collidesWithRule = keys.some(
        (k) => TEMPLATES[k] && slug(TEMPLATES[k].name) === slug(suggestedName)
      );
      if (collidesWithRule) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          name: suggestedName,
          minSelect: 0,
          maxSelect: 1,
          modifiers: options.map((o) => ({ name: o, priceCents: 0 })),
          source: "model",
        });
      }
      keys.push(key);
    }

    drafts.push({
      name,
      description,
      priceCents,
      categoryName,
      station: stationFor(name, categoryName, description),
      modifierGroupKeys: [...new Set(keys)],
      needsReview: priceCents == null,
      reviewNote: priceCents == null ? "No price found — set one before saving" : "",
    });
  }

  return { items: drafts, groups: [...groups.values()] };
}
