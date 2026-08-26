// tests/name-key.test.ts — the restaurant-name normalization contract.
//
// This function decides which restaurant a sign-in resolves to, and it
// is duplicated in Travola-OS (lib/name-key.ts). If the two ever drift,
// a restaurant signs into one product and not the other — so these
// cases are the contract, not just a smoke test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameKey } from "../lib/name-key.ts";

test("smart punctuation folds to ASCII", () => {
  // The bug this prevents: iPads substitute U+2019 for a typed
  // apostrophe, which used to create a second, empty restaurant.
  assert.equal(nameKey("Volario's"), "volario's");
  assert.equal(nameKey("Volario’s"), "volario's"); // ' iOS
  assert.equal(nameKey("Volario‘s"), "volario's"); // ' left quote
  assert.equal(nameKey("Volario′s"), "volario's"); // ′ prime
});

test("dashes fold to a plain hyphen", () => {
  assert.equal(nameKey("Smith—Jones"), "smith-jones"); // em
  assert.equal(nameKey("Smith–Jones"), "smith-jones"); // en
  assert.equal(nameKey("Smith-Jones"), "smith-jones");
});

test("case and whitespace are normalized", () => {
  assert.equal(nameKey("  VOLARIO’S  "), "volario's");
  assert.equal(nameKey("The   Blue   Door"), "the blue door");
  assert.equal(nameKey("\tTabbed\tName\n"), "tabbed name");
});

test("composed and decomposed accents agree", () => {
  // "Café" typed on macOS vs. Windows produces different byte
  // sequences; NFKC makes them the same key.
  assert.equal(nameKey("Café Roma"), nameKey("Café Roma"));
});

test("accents are preserved, not stripped", () => {
  // Folding these would collide genuinely different restaurants.
  assert.notEqual(nameKey("Café Roma"), nameKey("Cafe Roma"));
});

test("empty and nullish input never throws", () => {
  assert.equal(nameKey(""), "");
  assert.equal(nameKey(null), "");
  assert.equal(nameKey(undefined), "");
  assert.equal(nameKey("   "), "");
});
