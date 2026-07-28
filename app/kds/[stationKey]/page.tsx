"use client";
// /kds/[stationKey] — full-screen kitchen display for one station.
// 3s poll (boring on purpose — SSE only if measurement demands it).
// Age thresholds: <8m calm, 8–12m amber, >12m red — matches the pass
// rhythm of a ~90min-turn dinner house.
import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { api, ageMinutes } from "@/lib/ui";

type KdsLine = {
  id: string; nameSnapshot: string; quantity: number; seat: number | null;
  course: number; modifiers: { name: string; priceCents: number }[];
};
type Ticket = {
  checkId: string; tableLabel: string; serverName: string; guestCount: number;
  firedAt: string; items: KdsLine[];
};
type Payload = { tickets: Ticket[]; allDay: Record<string, number> };

export default function Kds({ params }: { params: Promise<{ stationKey: string }> }) {
  const { stationKey } = use(params);
  const [data, setData] = useState<Payload>({ tickets: [], allDay: {} });
  const [allDayOpen, setAllDayOpen] = useState(false);
  const [, forceTick] = useState(0);

  const load = useCallback(async () => {
    try { setData(await api<Payload>(`/api/pos/kds/${stationKey}`)); } catch {}
  }, [stationKey]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 3000);
    const tick = setInterval(() => forceTick((n) => n + 1), 15000); // age timers
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [load]);

  const bump = async (t: Ticket) => {
    setData((d) => ({ ...d, tickets: d.tickets.filter((x) => x.checkId !== t.checkId) })); // optimistic
    try { await api(`/api/pos/kds/${stationKey}`, { json: { checkId: t.checkId } }); } catch {}
    load();
  };

  const ageClass = (m: number) =>
    m >= 12
      ? "border-state-seated bg-state-seatedBg"
      : m >= 8
      ? "border-state-dining bg-state-diningBg"
      : "border-border bg-panel-card";

  return (
    <main className="flex-1 flex flex-col h-screen overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2.5 bg-panel border-b border-border">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-ink-400 hover:text-ink-50 text-sm">←</Link>
          <h1 className="text-lg font-semibold text-ink-50 uppercase tracking-wide">
            {stationKey}
          </h1>
          <span className="text-sm text-ink-400">{data.tickets.length} tickets</span>
        </div>
        <button
          onClick={() => setAllDayOpen((v) => !v)}
          className={`px-3 py-1.5 rounded-lg text-sm ${
            allDayOpen ? "bg-ai-bg text-ai" : "text-ink-400 hover:bg-panel-up"
          }`}
        >
          All day
        </button>
      </header>

      {allDayOpen && (
        <div className="px-4 py-3 bg-panel border-b border-border flex flex-wrap gap-x-6 gap-y-1">
          {Object.entries(data.allDay).sort((a, b) => b[1] - a[1]).map(([name, qty]) => (
            <span key={name} className="text-sm">
              <span className="text-ai font-semibold">{qty}</span>{" "}
              <span className="text-ink-200">{name}</span>
            </span>
          ))}
          {Object.keys(data.allDay).length === 0 && (
            <span className="text-sm text-ink-400">Nothing live.</span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-x-auto p-4">
        <div className="flex gap-4 h-full items-start">
          {data.tickets.map((t) => {
            const m = ageMinutes(t.firedAt);
            return (
              <div
                key={t.checkId}
                className={`w-64 shrink-0 rounded-2xl border-2 flex flex-col max-h-full ${ageClass(m)}`}
              >
                <div className="flex items-baseline justify-between px-3 py-2 border-b border-border">
                  <span className="font-semibold text-ink-50">Tbl {t.tableLabel}</span>
                  <span className={`text-sm font-mono ${m >= 8 ? "text-ink-50 font-semibold" : "text-ink-400"}`}>
                    {m}m
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                  {t.items.map((l) => (
                    <div key={l.id}>
                      <div className="text-ink-50 font-medium leading-tight">
                        {l.quantity > 1 ? `${l.quantity}× ` : ""}{l.nameSnapshot}
                        {l.seat ? <span className="text-ink-400 text-sm"> · S{l.seat}</span> : null}
                      </div>
                      {l.modifiers.length > 0 && (
                        <div className="text-sm text-state-dining leading-tight">
                          {l.modifiers.map((mm) => mm.name).join(" · ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => bump(t)}
                  className="m-2 rounded-xl py-2.5 bg-state-availBg text-state-avail font-semibold border border-border hover:border-border-hi"
                >
                  BUMP
                </button>
              </div>
            );
          })}
          {data.tickets.length === 0 && (
            <div className="flex-1 h-full flex items-center justify-center text-ink-400">
              No live tickets — all caught up.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
