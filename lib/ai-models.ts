// lib/ai-models.ts — model tiers, centralized so no route picks an
// ad-hoc one. Mirrors the floor app's lib/ai-models.ts convention.
//
// Menu import runs at most a handful of times per restaurant, at
// onboarding — accuracy is worth far more than the cost delta, so it
// defaults to the full model exactly as the floor app's document
// importer does. Override with MENU_IMPORT_MODEL if that changes.
export const MENU_IMPORT_MODEL =
  process.env.MENU_IMPORT_MODEL || process.env.IMPORT_MODEL || "gpt-5.6";
