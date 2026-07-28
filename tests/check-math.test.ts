// tests/check-math.test.ts — run: npm test
// (node --experimental-strip-types --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineTotalCents,
  computeTotals,
  paidCents,
  balanceDueCents,
  changeDueCents,
  roundHalfUp,
} from "../lib/check-math.ts";

const line = (over: Partial<Parameters<typeof lineTotalCents>[0]> = {}) => ({
  priceCents: 1400,
  quantity: 1,
  state: "fired",
  modifiers: [] as { name: string; priceCents: number }[],
  ...over,
});

test("plain line", () => {
  assert.equal(lineTotalCents(line()), 1400);
});

test("modifiers add per unit and multiply by quantity", () => {
  assert.equal(
    lineTotalCents(
      line({
        quantity: 3,
        modifiers: [
          { name: "Add bacon", priceCents: 200 },
          { name: "No onions", priceCents: 0 },
        ],
      })
    ),
    (1400 + 200) * 3
  );
});

test("voided line contributes zero", () => {
  assert.equal(lineTotalCents(line({ state: "voided" })), 0);
});

test("garbage modifiers json is treated as empty", () => {
  assert.equal(lineTotalCents(line({ modifiers: { junk: true } })), 1400);
  assert.equal(
    lineTotalCents(line({ modifiers: [{ name: "x", priceCents: NaN }] })),
    1400
  );
});

test("round half-up behaves on the boundary", () => {
  assert.equal(roundHalfUp(2.5), 3);
  assert.equal(roundHalfUp(2.49999), 2);
});

test("totals pipeline: subtotal, 8.40% tax, tip", () => {
  const t = computeTotals(
    [line(), line({ priceCents: 950, quantity: 2 })], // 1400 + 1900 = 3300
    840,
    500
  );
  assert.equal(t.subtotalCents, 3300);
  assert.equal(t.taxCents, 277); // 3300*0.084 = 277.2 -> 277
  assert.equal(t.totalCents, 3300 + 277 + 500);
});

test("tax rounding boundary: half a cent rounds up", () => {
  // subtotal 1250 at 8.20% = 102.5 -> 103
  const t = computeTotals([line({ priceCents: 1250 })], 820, 0);
  assert.equal(t.taxCents, 103);
});

test("zero-subtotal check (everything voided) owes nothing", () => {
  const t = computeTotals([line({ state: "voided" })], 840, 0);
  assert.equal(t.totalCents, 0);
});

test("payments: only captured count; balance floors at zero", () => {
  const totals = computeTotals([line()], 840, 0); // 1400 + 118 = 1518
  assert.equal(totals.totalCents, 1518);
  const pays = [
    { amountCents: 1000, tipCents: 0, status: "captured" },
    { amountCents: 9999, tipCents: 0, status: "failed" },
  ];
  assert.equal(paidCents(pays), 1000);
  assert.equal(balanceDueCents(totals, pays), 518);
  pays.push({ amountCents: 518, tipCents: 200, status: "captured" });
  assert.equal(balanceDueCents(totals, pays), 0); // overpay via tip floors at 0
});

test("cash change math; short tender throws", () => {
  assert.equal(changeDueCents(2000, 1518), 482);
  assert.throws(() => changeDueCents(1500, 1518));
});
