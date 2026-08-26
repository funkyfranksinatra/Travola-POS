"use client";
// components/MenuImporter.tsx — upload a menu, review what was read,
// then save it.
//
// The review gate is the whole point. Extraction is allowed to be
// imperfect: what makes this safe to hand a restaurant on day one is
// that a human sees every item, price and ticket mod before anything
// reaches a terminal. Items the pipeline was unsure about (usually a
// missing price) sort to the top and block saving until resolved.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/ui";
import { readMenuFiles, isSupported, MAX_PAGES } from "@/lib/menu-file";

/** Pages per request — matches the server's per-request cap. */
const UPLOAD_BATCH = 4;

type DraftModifier = { name: string; priceCents: number };
type DraftGroup = {
  key: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: DraftModifier[];
  source: "rule" | "model";
};
type DraftItem = {
  name: string;
  description: string;
  priceCents: number | null;
  categoryName: string;
  station: string;
  modifierGroupKeys: string[];
  needsReview: boolean;
  reviewNote: string;
};
type Draft = {
  id: string;
  sourceName: string;
  sourceKind: string;
  pageCount: number;
  itemCount: number;
  items: DraftItem[];
  groups: DraftGroup[];
};

const money = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2));

export default function MenuImporter({
  stationKeys,
  onCommitted,
}: {
  stationKeys: string[];
  onCommitted: (summary: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [groups, setGroups] = useState<DraftGroup[]>([]);
  const [dropping, setDropping] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [replaceTyped, setReplaceTyped] = useState("");

  const hydrate = useCallback((d: Draft | null) => {
    setDraft(d);
    setItems(d?.items ?? []);
    setGroups(d?.groups ?? []);
  }, []);

  // A draft in progress is restored on load — the review can span a
  // refresh, a closed tablet, or a shift change.
  useEffect(() => {
    api<{ draft: Draft | null }>("/api/pos/menu/import")
      .then((r) => hydrate(r.draft))
      .catch(() => {});
  }, [hydrate]);

  const unpriced = items.filter((i) => i.priceCents == null).length;
  const categories = useMemo(() => [...new Set(items.map((i) => i.categoryName))], [items]);

  const handleFiles = async (files: File[]) => {
    setError("");
    const usable = files.filter(isSupported);
    if (!usable.length) {
      setError("Choose a PDF, JPEG, PNG or other image of your menu.");
      return;
    }
    setBusy(true);
    try {
      setProgress("Opening file…");
      const { pages, kind } = await readMenuFiles(usable, setProgress);
      if (kind !== "text") setProgress("Scanned pages — this takes a little longer…");
      // Pages go up in small batches: it keeps each request inside the
      // function time limit and the body-size limit, and it lets the
      // manager watch a long menu arrive instead of staring at a spinner.
      const sourceName = usable.map((f) => f.name).join(", ");
      let importId: string | undefined;
      for (let i = 0; i < pages.length; i += UPLOAD_BATCH) {
        const batch = pages.slice(i, i + UPLOAD_BATCH);
        const upto = Math.min(i + batch.length, pages.length);
        setProgress(`Reading the menu — page ${upto} of ${pages.length}…`);
        const result = await api<Draft>("/api/pos/menu/import", {
          json: { sourceName, importId, pages: batch },
        });
        importId = result.id;
        // Show what has arrived so far rather than waiting for the end.
        hydrate(result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not read that file");
    } finally {
      setBusy(false);
      setProgress("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const patchItem = (index: number, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const removeItem = (index: number) => setItems((prev) => prev.filter((_, i) => i !== index));

  const toggleGroup = (index: number, key: string) =>
    setItems((prev) =>
      prev.map((item, i) =>
        i === index
          ? {
              ...item,
              modifierGroupKeys: item.modifierGroupKeys.includes(key)
                ? item.modifierGroupKeys.filter((k) => k !== key)
                : [...item.modifierGroupKeys, key],
            }
          : item
      )
    );

  const discard = async () => {
    if (!window.confirm("Discard this import? The menu is unchanged.")) return;
    await api(`/api/pos/menu/import?id=${draft?.id ?? ""}`, { method: "DELETE", json: {} }).catch(() => {});
    hydrate(null);
  };

  const commit = async (mode: "merge" | "replace") => {
    if (unpriced > 0) {
      setError(`${unpriced} item${unpriced === 1 ? "" : "s"} still need a price.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Only groups still referenced by an item are sent, so a group the
      // manager removed from every dish is never created.
      const used = new Set(items.flatMap((i) => i.modifierGroupKeys));
      const summary = await api<{ created: number; updated: number; deactivated: number }>(
        "/api/pos/menu/import/commit",
        {
          json: {
            importId: draft?.id,
            mode,
            items: items.map((i) => ({ ...i, priceCents: i.priceCents ?? 0 })),
            groups: groups.filter((g) => used.has(g.key)),
          },
        }
      );
      hydrate(null);
      setConfirmReplace(false);
      setReplaceTyped("");
      onCommitted(
        `${summary.created} added${summary.updated ? `, ${summary.updated} updated` : ""}${
          summary.deactivated ? `, ${summary.deactivated} removed` : ""
        }`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save the menu");
    } finally {
      setBusy(false);
    }
  };

  // ── Upload ─────────────────────────────────────────────────────────
  if (!draft) {
    return (
      <section className="rounded-2xl bg-panel-card border border-border p-4 mb-6">
        <div className="flex flex-wrap items-baseline gap-x-3 mb-3">
          <h2 className="text-ink-50 font-medium">Import a menu</h2>
          <span className="text-xs text-ink-400">
            PDF or photo · up to {MAX_PAGES} pages · you review everything before it goes live
          </span>
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDropping(false);
            handleFiles([...e.dataTransfer.files]);
          }}
          className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
            dropping ? "border-ai bg-ai-bg" : "border-border hover:border-border-hi"
          }`}
        >
          {busy ? (
            <div className="text-sm text-ink-200">
              <span className="inline-block h-4 w-4 mr-2 align-middle rounded-full border-2 border-ai border-t-transparent animate-spin" />
              {progress || "Working…"}
            </div>
          ) : (
            <>
              <p className="text-sm text-ink-200 mb-1">Drop your menu here</p>
              <p className="text-xs text-ink-400 mb-3">
                Food, drinks and desserts together is fine — the menu&apos;s own sections are kept.
              </p>
              <button
                onClick={() => fileRef.current?.click()}
                className="px-4 py-2 rounded-xl bg-ai text-bg text-sm font-medium"
              >
                Choose file
              </button>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="application/pdf,image/*,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif"
            className="hidden"
            onChange={(e) => handleFiles([...(e.target.files ?? [])])}
          />
        </div>
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
      </section>
    );
  }

  // ── Review ─────────────────────────────────────────────────────────
  const ordered = [...items.entries()].sort(([, a], [, b]) => {
    if ((a.priceCents == null) !== (b.priceCents == null)) return a.priceCents == null ? -1 : 1;
    return a.categoryName.localeCompare(b.categoryName) || a.name.localeCompare(b.name);
  });
  const inferred = groups.filter((g) => g.source === "model").map((g) => g.name);

  return (
    <section className="rounded-2xl bg-panel-card border border-border p-4 mb-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
        <h2 className="text-ink-50 font-medium">Review imported menu</h2>
        <span className="text-xs text-ink-400">
          {draft.sourceName || "upload"} · {items.length} items · {categories.length} sections ·{" "}
          {draft.sourceKind === "vision" ? "read from a scan" : "read from the PDF text"}
        </span>
        <button onClick={discard} className="ml-auto text-xs text-ink-400 hover:text-ink-50 underline">
          Discard
        </button>
      </div>
      <p className="text-xs text-ink-400 mb-3">
        Nothing is live yet. Ticket mods were applied automatically — check them, then save.
      </p>

      {unpriced > 0 && (
        <p className="mb-3 text-sm text-state-reserved">
          {unpriced} item{unpriced === 1 ? "" : "s"} had no price on the menu (shown first). Set a
          price or remove them before saving.
        </p>
      )}

      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-sm min-w-[52rem]">
          <thead>
            <tr className="text-ink-400 text-[11px] uppercase tracking-wider">
              <th className="text-left font-medium py-1.5 pr-2">Item</th>
              <th className="text-left font-medium py-1.5 px-2">Section</th>
              <th className="text-right font-medium py-1.5 px-2">Price</th>
              <th className="text-left font-medium py-1.5 px-2">Station</th>
              <th className="text-left font-medium py-1.5 px-2">Ticket mods</th>
              <th className="py-1.5 pl-2"></th>
            </tr>
          </thead>
          <tbody>
            {ordered.map(([index, item]) => (
              <tr
                key={`${item.name}-${index}`}
                className={`border-t border-border align-top ${
                  item.priceCents == null ? "bg-state-reservedBg" : ""
                }`}
              >
                <td className="py-2 pr-2">
                  <input
                    value={item.name}
                    onChange={(e) => patchItem(index, { name: e.target.value })}
                    className="w-full bg-transparent text-ink-50 outline-none focus:bg-panel rounded px-1 py-0.5"
                  />
                  {item.description && (
                    <div className="text-[11px] text-ink-400 px-1">{item.description}</div>
                  )}
                </td>
                <td className="py-2 px-2">
                  <input
                    list="menu-import-categories"
                    value={item.categoryName}
                    onChange={(e) => patchItem(index, { categoryName: e.target.value })}
                    className="w-32 bg-transparent text-ink-200 outline-none focus:bg-panel rounded px-1 py-0.5"
                  />
                </td>
                <td className="py-2 px-2 text-right whitespace-nowrap">
                  <span className="text-ink-400 mr-0.5">$</span>
                  <input
                    inputMode="decimal"
                    value={money(item.priceCents)}
                    placeholder="—"
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      const value = Number.parseFloat(raw);
                      patchItem(index, {
                        priceCents:
                          raw === "" || !Number.isFinite(value) ? null : Math.round(value * 100),
                      });
                    }}
                    className="w-16 bg-transparent text-ink-50 text-right outline-none focus:bg-panel rounded px-1 py-0.5"
                  />
                </td>
                <td className="py-2 px-2">
                  <select
                    value={item.station}
                    onChange={(e) => patchItem(index, { station: e.target.value })}
                    className="bg-panel text-ink-200 rounded px-1.5 py-0.5 border border-border outline-none"
                  >
                    {[...new Set([...stationKeys, item.station, "kitchen", "bar"])].map((key) => (
                      <option key={key} value={key}>
                        {key}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 px-2">
                  <div className="flex flex-wrap gap-1">
                    {groups.map((group) => {
                      const on = item.modifierGroupKeys.includes(group.key);
                      return (
                        <button
                          key={group.key}
                          onClick={() => toggleGroup(index, group.key)}
                          title={group.modifiers.map((m) => m.name).join(", ")}
                          className={`px-1.5 py-0.5 rounded text-[11px] border ${
                            on
                              ? "bg-ai-bg text-ai border-ai/40"
                              : "bg-panel text-ink-400 border-border hover:border-border-hi"
                          }`}
                        >
                          {group.name}
                          {group.minSelect > 0 && on ? " *" : ""}
                        </button>
                      );
                    })}
                  </div>
                </td>
                <td className="py-2 pl-2 text-right">
                  <button
                    onClick={() => removeItem(index)}
                    title="Remove this item from the import"
                    className="text-ink-400 hover:text-rose-300 px-1"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="menu-import-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <p className="mt-3 text-[11px] text-ink-400">
        * required choice — a server must pick one before the item can be sent. Mods proposed by the
        reader rather than a standard rule: {inferred.length ? inferred.join(", ") : "none"}.
      </p>

      {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          disabled={busy || items.length === 0}
          onClick={() => commit("merge")}
          className="px-4 py-2 rounded-xl bg-ai text-bg text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Saving…" : `Add ${items.length} items to menu`}
        </button>
        <button
          disabled={busy || items.length === 0}
          onClick={() => setConfirmReplace(true)}
          className="px-4 py-2 rounded-xl bg-panel text-ink-200 border border-border hover:border-border-hi text-sm disabled:opacity-50"
        >
          Replace entire menu…
        </button>
        <span className="text-xs text-ink-400">Adding keeps everything already on the menu.</span>
      </div>

      {confirmReplace && (
        <div className="mt-3 rounded-xl border border-state-reserved/40 bg-state-reservedBg p-3">
          <p className="text-sm text-ink-50 mb-1">Replace the entire menu?</p>
          <p className="text-xs text-ink-400 mb-3">
            Every current item not in this import is removed from the terminals. Past checks and
            reports are unaffected — items are deactivated, not deleted, so this can be undone.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={replaceTyped}
              onChange={(e) => setReplaceTyped(e.target.value)}
              placeholder="Type REPLACE to confirm"
              className="bg-panel text-ink-50 rounded-lg px-2.5 py-1.5 text-sm border border-border outline-none focus:border-ai w-52"
            />
            <button
              disabled={replaceTyped.trim().toUpperCase() !== "REPLACE" || busy}
              onClick={() => commit("replace")}
              className="px-3 py-1.5 rounded-lg bg-state-reserved text-bg text-sm font-medium disabled:opacity-40"
            >
              Replace menu
            </button>
            <button
              onClick={() => {
                setConfirmReplace(false);
                setReplaceTyped("");
              }}
              className="px-3 py-1.5 rounded-lg text-ink-400 hover:text-ink-50 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
