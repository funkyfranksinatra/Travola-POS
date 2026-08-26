// lib/name-key.ts — the ONE way a restaurant name becomes its lookup key.
//
// Why this exists: iPads (and Word, and iOS Mail) apply "smart
// punctuation", so a server typing Volario's produces U+2019 (') while
// the desktop that registered the account typed U+0027 ('). Those are
// different strings, so they used to be different restaurants — and a
// duplicate empty tenant is indistinguishable from the real one at the
// login screen until someone notices the floor is blank.
//
// Normalization here is deliberately conservative: it folds the
// punctuation and spacing a keyboard decides for you, and nothing else.
// Two restaurants that genuinely want distinct names still get them.
//
// Shared verbatim with Travola-POS (lib/name-key.ts) — the two apps MUST
// agree on this function or a restaurant signs into one and not the other.

/** Curly quotes/apostrophes → their ASCII equivalents. */
const SMART_PUNCTUATION: Record<string, string> = {
  "‘": "'", // ' left single quote
  "’": "'", // ' right single quote (the iOS apostrophe)
  "‚": "'", // ‚ single low quote
  "‛": "'", // ‛ reversed single quote
  "′": "'", // ′ prime
  "“": '"', // " left double quote
  "”": '"', // " right double quote
  "„": '"', // „ double low quote
  "″": '"', // ″ double prime
  "‐": "-", // ‐ hyphen
  "‑": "-", // ‑ non-breaking hyphen
  "‒": "-", // ‒ figure dash
  "–": "-", // – en dash
  "—": "-", // — em dash
  "−": "-", // − minus sign
};

/**
 * Canonical lookup key for a restaurant name.
 *
 * NFKC first so composed and decomposed accents agree (café typed on a
 * Mac vs. Windows), then smart punctuation folded, whitespace collapsed,
 * and lowercased. Accents themselves are PRESERVED — stripping them
 * would collide genuinely different names.
 */
export function nameKey(name: unknown): string {
  const raw = String(name ?? "").normalize("NFKC");
  let out = "";
  for (const char of raw) out += SMART_PUNCTUATION[char] ?? char;
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}
