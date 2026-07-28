"use client";
// /menu — menu builder: categories, items (price/station/86), modifier
// groups, stations, tax rate. Settings-style single page.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, usd } from "@/lib/ui";

type Mod = { id: string; name: string; priceCents: number };
type ModGroup = { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Mod[] };
type Item = {
  id: string; categoryId: string; name: string; priceCents: number; station: string;
  active: boolean; modifierGroups: ModGroup[];
};
type Cat = { id: string; name: string; active: boolean; items: Item[] };
type Station = { id: string; key: string; name: string };
type Settings = { taxRateBps: number };
type MenuPayload = { categories: Cat[]; modifierGroups: ModGroup[]; stations: Station[]; settings: Settings };

export default function MenuBuilder() {
  const [menu, setMenu] = useState<MenuPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500); };

  const load = useCallback(
    () => api<MenuPayload>("/api/pos/menu").then(setMenu).catch(() => flash("load failed")),
    []
  );
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try { await fn(); await load(); if (msg) flash(msg); }
    catch (e) { flash(e instanceof Error ? e.message : "failed"); }
  };

  if (!menu) return <main className="flex-1 p-8 text-ink-400">Loading…</main>;

  return (
    <main className="flex-1 p-6 max-w-5xl mx-auto w-full">
      <header className="flex items-center gap-3 mb-6">
        <Link href="/" className="text-ink-400 hover:text-ink-50 text-sm">←</Link>
        <h1 className="text-xl font-semibold text-ink-50">Menu builder</h1>
      </header>

      {/* stations + tax */}
      <section className="rounded-2xl bg-panel-card border border-border p-4 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-ink-400">Stations:</span>
          {menu.stations.map((s) => (
            <span key={s.id} className="px-3 py-1 rounded-full bg-panel text-ink-200 text-sm border border-border">
              {s.name} <span className="text-ink-400">({s.key})</span>
            </span>
          ))}
          <button
            onClick={() => {
              const name = window.prompt("Station name (e.g. Kitchen):");
              if (!name) return;
              const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              act(() => api("/api/pos/stations", { json: { key, name } }), `station ${name}`);
            }}
            className="px-3 py-1 rounded-full text-sm text-ai bg-ai-bg"
          >
            + station
          </button>
          <span className="ml-auto text-sm text-ink-400">
            Tax:{" "}
            <button
              onClick={() => {
                const v = window.prompt("Tax rate % (e.g. 8.4):", (menu.settings.taxRateBps / 100).toString());
                if (!v) return;
                const bps = Math.round(parseFloat(v) * 100);
                if (!Number.isFinite(bps) || bps < 0) return;
                act(() => api("/api/pos/settings", { method: "PATCH", json: { taxRateBps: bps } }), "tax updated");
              }}
              className="text-ink-50 underline decoration-border-hi underline-offset-4"
            >
              {(menu.settings.taxRateBps / 100).toFixed(2)}%
            </button>
          </span>
        </div>
      </section>

      {/* categories + items */}
      {menu.categories.map((cat) => (
        <section key={cat.id} className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-ink-50 font-medium">{cat.name}</h2>
            <button
              onClick={() => {
                const name = window.prompt(`Item name (in ${cat.name}):`);
                if (!name) return;
                const price = window.prompt("Price (e.g. 14.00):");
                if (!price) return;
                const priceCents = Math.round(parseFloat(price) * 100);
                if (!Number.isFinite(priceCents) || priceCents < 0) return;
                const station = window.prompt(
                  `Station key (${menu.stations.map((s) => s.key).join(", ") || "create a station first"}):`,
                  menu.stations[0]?.key ?? ""
                );
                if (!station) return;
                act(
                  () => api("/api/pos/menu/item", { json: { categoryId: cat.id, name, priceCents, station } }),
                  `${name} added`
                );
              }}
              className="text-sm text-ai bg-ai-bg px-2.5 py-0.5 rounded-full"
            >
              + item
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {cat.items.map((it) => (
              <div
                key={it.id}
                className={`rounded-xl border p-3 ${
                  it.active ? "bg-panel-card border-border" : "bg-panel border-border opacity-60"
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-ink-50 font-medium">{it.name}</span>
                  <span className="text-sm text-ink-400">{usd(it.priceCents)}</span>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-ink-400">
                    {it.station}
                    {it.modifierGroups.length > 0 && ` · ${it.modifierGroups.map((g) => g.name).join(", ")}`}
                  </span>
                  <span className="flex gap-2">
                    <button
                      onClick={() => {
                        const ids = menu.modifierGroups
                          .map((g, i) => `${i + 1}. ${g.name}`)
                          .join("\n");
                        const pick = window.prompt(
                          `Attach modifier groups (comma-separated numbers):\n${ids}`,
                          it.modifierGroups
                            .map((g) => menu.modifierGroups.findIndex((x) => x.id === g.id) + 1)
                            .join(",")
                        );
                        if (pick === null) return;
                        const groupIds = pick
                          .split(",")
                          .map((n) => menu.modifierGroups[parseInt(n.trim()) - 1]?.id)
                          .filter(Boolean) as string[];
                        act(
                          () => api(`/api/pos/menu/item/${it.id}`, { method: "PATCH", json: { modifierGroupIds: groupIds } }),
                          "modifiers set"
                        );
                      }}
                      className="text-xs text-ink-400 hover:text-ink-50"
                    >
                      mods
                    </button>
                    <button
                      onClick={() =>
                        act(
                          () => api(`/api/pos/menu/item/${it.id}`, { method: "PATCH", json: { active: !it.active } }),
                          it.active ? `${it.name} 86'd` : `${it.name} back on`
                        )
                      }
                      className={`text-xs font-semibold ${it.active ? "text-state-seated" : "text-state-avail"}`}
                    >
                      {it.active ? "86" : "un-86"}
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <div className="flex gap-3 mb-8">
        <button
          onClick={() => {
            const name = window.prompt("Category name:");
            if (name)
              act(
                () => api("/api/pos/menu/category", { json: { name, sortOrder: menu.categories.length } }),
                `${name} added`
              );
          }}
          className="rounded-xl bg-ai-bg text-ai px-4 py-2 text-sm font-medium"
        >
          + Category
        </button>
        <button
          onClick={() => {
            const name = window.prompt("Modifier group name (e.g. Temperature):");
            if (!name) return;
            const mods = window.prompt(
              "Modifiers, comma-separated. Price in parens if any:\nMedium rare, Add bacon (2.00), No onions"
            );
            if (mods === null) return;
            const modifiers = mods
              .split(",")
              .map((raw) => {
                const m = raw.trim().match(/^(.*?)(?:\(([\d.]+)\))?$/);
                return { name: (m?.[1] ?? raw).trim(), priceCents: Math.round(parseFloat(m?.[2] ?? "0") * 100) || 0 };
              })
              .filter((x) => x.name);
            const req = window.confirm("Required? (OK = guest must pick one)");
            act(
              () =>
                api("/api/pos/menu/modgroup", {
                  json: { name, minSelect: req ? 1 : 0, maxSelect: req ? 1 : Math.max(1, modifiers.length), modifiers },
                }),
              `${name} created`
            );
          }}
          className="rounded-xl bg-panel-card border border-border text-ink-200 px-4 py-2 text-sm"
        >
          + Modifier group
        </button>
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-xl bg-panel-up border border-border-hi text-ink-50 text-sm px-4 py-2 z-50">
          {toast}
        </div>
      )}
    </main>
  );
}
