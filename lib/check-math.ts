// lib/check-math.ts — THE money file. The only place totals are ever
// computed. Pure functions over integer cents; the client renders what
// the server returns and never does arithmetic of its own.
//
// Pipeline: subtotal = Σ line totals (voided lines excluded)
//           tax      = round-half-up(subtotal × taxRateBps / 10000)
//           total    = subtotal + tax + tip

export type ModifierSnapshot = { name: string; priceCents: number };

export type LineLike = {
  priceCents: number;
  quantity: number;
  state: string; // held | fired | bumped | voided
  modifiers: ModifierSnapshot[] | unknown; // Prisma Json comes in loose
};

export type Totals = {
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
};

const asMods = (m: LineLike["modifiers"]): ModifierSnapshot[] =>
  Array.isArray(m) ? (m as ModifierSnapshot[]) : [];

/** One line: (base + Σ modifier prices) × quantity. Voided lines are 0. */
export function lineTotalCents(line: LineLike): number {
  if (line.state === "voided") return 0;
  const mods = asMods(line.modifiers).reduce(
    (s, m) => s + (Number.isFinite(m.priceCents) ? m.priceCents : 0),
    0
  );
  return (line.priceCents + mods) * line.quantity;
}

/** Round half-up on a non-negative value (never banker's rounding on a receipt). */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

export function computeTotals(
  lines: LineLike[],
  taxRateBps: number,
  tipCents: number
): Totals {
  const subtotalCents = lines.reduce((s, l) => s + lineTotalCents(l), 0);
  const taxCents = roundHalfUp((subtotalCents * taxRateBps) / 10000);
  return {
    subtotalCents,
    taxCents,
    tipCents,
    totalCents: subtotalCents + taxCents + tipCents,
  };
}

/** Sum of captured payments (incl. tips paid on those payments). */
export function paidCents(
  payments: { amountCents: number; tipCents: number; status: string }[]
): number {
  return payments
    .filter((p) => p.status === "captured")
    .reduce((s, p) => s + p.amountCents + p.tipCents, 0);
}

/** Remaining balance INCLUDING tip already committed to the check. */
export function balanceDueCents(
  totals: Totals,
  payments: { amountCents: number; tipCents: number; status: string }[]
): number {
  return Math.max(0, totals.totalCents - paidCents(payments));
}

/** Cash tender: change owed. Throws if tendered short (server rejects). */
export function changeDueCents(tenderedCents: number, dueCents: number): number {
  if (tenderedCents < dueCents) throw new Error("insufficient tender");
  return tenderedCents - dueCents;
}
