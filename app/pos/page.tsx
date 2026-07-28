"use client";
// /pos — the server terminal. Check list → order screen → tender.
// Square-style layout: ticket on the left, category rail + item grid on
// the right. ALL money comes from the server; this file only renders it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, usd, ageMinutes } from "@/lib/ui";

// ── types (server payload shapes) ───────────────────────────────────
type Mod = { id: string; name: string; priceCents: number };
type ModGroup = { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Mod[] };
type Item = {
  id: string; name: string; priceCents: number; station: string; active: boolean;
  modifierGroups: ModGroup[];
};
type Cat = { id: string; name: string; active: boolean; items: Item[] };
type MenuPayload = { categories: Cat[]; settings: { taxRateBps: number; tipPresets: number[] } };
type Line = {
  id: string; nameSnapshot: string; priceCents: number; quantity: number;
  seat: number | null; course: number; modifiers: { name: string; priceCents: number }[];
  station: string; state: string;
};
type Pay = { id: string; method: string; amountCents: number; tipCents: number };
type CheckFull = {
  id: string; tableLabel: string; serverName: string; guestCount: number;
  status: string; currentCourse: number; openedAt: string;
  subtotalCents: number; taxCents: number; tipCents: number; totalCents: number;
  balanceDueCents: number; items: Line[]; payments: Pay[]; changeCents?: number;
};
type CheckSummary = CheckFull; // list endpoint returns same shape minus balance

export default function PosTerminal() {
  const [menu, setMenu] = useState<MenuPayload | null>(null);
  const [checks, setChecks] = useState<CheckSummary[]>([]);
  const [check, setCheck] = useState<CheckFull | null>(null); // null = list view
  const [catId, setCatId] = useState<string | null>(null);
  const [seat, setSeat] = useState(1);
  const [course, setCourse] = useState(1);
  const [sheet, setSheet] = useState<Item | null>(null); // modifier sheet
  const [tender, setTender] = useState(false);
  const [newCheck, setNewCheck] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const loadList = useCallback(async () => {
    try { setChecks(await api<CheckSummary[]>("/api/pos/checks?status=open")); } catch {}
  }, []);

  useEffect(() => {
    api<MenuPayload>("/api/pos/menu").then((m) => {
      setMenu(m);
      setCatId(m.categories[0]?.id ?? null);
    }).catch(() => flash("menu failed to load"));
  }, [flash]);

  useEffect(() => {
    if (check) return; // only poll on the list view
    loadList();
    const t = setInterval(loadList, 4000);
    return () => clearInterval(t);
  }, [check, loadList]);

  const run = useCallback(
    async (fn: () => Promise<CheckFull>, okMsg?: string) => {
      try {
        const fresh = await fn();
        setCheck(fresh);
        if (okMsg) flash(okMsg);
        return fresh;
      } catch (e) {
        flash(e instanceof Error ? e.message : "request failed");
        return null;
      }
    },
    [flash]
  );

  // ── actions ───────────────────────────────────────────────────────
  const openCheck = (tableLabel: string, guestCount: number, serverName: string) =>
    run(async () => {
      const c = await api<CheckFull>("/api/pos/checks", { json: { tableLabel, guestCount, serverName } });
      setNewCheck(false);
      return api<CheckFull>(`/api/pos/checks/${c.id}`);
    });

  const addLine = (item: Item, modifierIds: string[], quantity: number) =>
    run(
      () =>
        api<CheckFull>(`/api/pos/checks/${check!.id}/items`, {
          json: { lines: [{ menuItemId: item.id, quantity, seat, course, modifierIds }] },
        }),
      `${item.name} added`
    );

  const voidLine = (line: Line) => {
    const reason = window.prompt(`Void ${line.nameSnapshot} — reason:`);
    if (!reason) return;
    run(
      () => api<CheckFull>(`/api/pos/checks/${check!.id}/items/${line.id}`, { json: { action: "void", reason } }),
      "voided"
    );
  };

  const send = () =>
    run(() => api<CheckFull>(`/api/pos/checks/${check!.id}/send`, { json: {} }), "sent to stations");

  const fireCourse = (n: number) =>
    run(() => api<CheckFull>(`/api/pos/checks/${check!.id}/fire`, { json: { course: n } }), `course ${n} fired`);

  // ── derived ───────────────────────────────────────────────────────
  const cat = useMemo(
    () => menu?.categories.find((c) => c.id === catId) ?? null,
    [menu, catId]
  );
  const held = check?.items.filter((i) => i.state === "held") ?? [];
  const maxCourse = Math.max(1, ...(check?.items.map((i) => i.course) ?? [1]));

  // ══ LIST VIEW ═════════════════════════════════════════════════════
  if (!check) {
    return (
      <main className="flex-1 p-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-ink-400 hover:text-ink-50 text-sm">←</Link>
            <h1 className="text-xl font-semibold text-ink-50">Open checks</h1>
          </div>
          <button
            onClick={() => setNewCheck(true)}
            className="rounded-xl bg-ai text-bg font-medium px-4 py-2"
          >
            New check
          </button>
        </header>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {checks.map((c) => (
            <button
              key={c.id}
              onClick={() => run(() => api<CheckFull>(`/api/pos/checks/${c.id}`))}
              className="rounded-2xl bg-panel-card border border-border hover:border-border-hi p-4 text-left"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-semibold text-ink-50">{c.tableLabel}</span>
                <span className="text-xs text-ink-400">{ageMinutes(c.openedAt)}m</span>
              </div>
              <div className="text-sm text-ink-400 mt-1">
                {c.guestCount} guests{c.serverName ? ` · ${c.serverName}` : ""}
              </div>
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-ink-400">
                  {c.items.filter((i) => i.state !== "voided").length} items
                </span>
                <span className="text-ink-50 font-medium">{usd(c.totalCents)}</span>
              </div>
            </button>
          ))}
          {checks.length === 0 && (
            <div className="col-span-full text-ink-400 text-sm py-16 text-center">
              No open checks — start one with “New check”.
            </div>
          )}
        </div>
        {newCheck && <NewCheckDialog onClose={() => setNewCheck(false)} onOpen={openCheck} />}
        {toast && <Toast msg={toast} />}
      </main>
    );
  }

  // ══ ORDER VIEW ════════════════════════════════════════════════════
  return (
    <main className="flex-1 flex flex-col h-screen overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 bg-panel border-b border-border">
        <div className="flex items-center gap-3">
          <button onClick={() => { setCheck(null); loadList(); }} className="text-ink-400 hover:text-ink-50">
            ← Checks
          </button>
          <span className="text-ink-50 font-semibold">Table {check.tableLabel}</span>
          <span className="text-sm text-ink-400">
            {check.guestCount} guests{check.serverName ? ` · ${check.serverName}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink-400">Seat</span>
          <Stepper value={seat} setValue={setSeat} min={1} max={check.guestCount} />
          <span className="text-ink-400 ml-2">Course</span>
          <Stepper value={course} setValue={setCourse} min={1} max={4} />
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* ── ticket ── */}
        <section className="w-[340px] shrink-0 bg-panel border-r border-border flex flex-col">
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {check.items.length === 0 && (
              <p className="text-sm text-ink-400 p-3">Tap items to start the order.</p>
            )}
            {check.items.map((l) => (
              <button
                key={l.id}
                onClick={() => l.state !== "voided" && voidLine(l)}
                className={`w-full text-left rounded-lg px-3 py-2 border ${
                  l.state === "voided"
                    ? "border-border opacity-40 line-through"
                    : l.state === "held"
                    ? "bg-panel-card border-border-hi"
                    : "bg-panel-card border-border"
                }`}
              >
                <div className="flex justify-between text-sm">
                  <span className="text-ink-50">
                    {l.quantity > 1 ? `${l.quantity}× ` : ""}{l.nameSnapshot}
                  </span>
                  <span className="text-ink-200">
                    {usd((l.priceCents + l.modifiers.reduce((s, m) => s + m.priceCents, 0)) * l.quantity)}
                  </span>
                </div>
                <div className="flex justify-between text-xs text-ink-400 mt-0.5">
                  <span>
                    {l.modifiers.map((m) => m.name).join(", ") || " "}
                  </span>
                  <span>
                    {l.seat ? `S${l.seat} ` : ""}C{l.course} ·{" "}
                    <StateBadge state={l.state} />
                  </span>
                </div>
              </button>
            ))}
          </div>

          <footer className="border-t border-border p-3 space-y-1 text-sm">
            <Row label="Subtotal" value={usd(check.subtotalCents)} />
            <Row label="Tax" value={usd(check.taxCents)} />
            {check.tipCents > 0 && <Row label="Tip" value={usd(check.tipCents)} />}
            <Row label="Total" value={usd(check.totalCents)} strong />
            {check.payments.length > 0 && (
              <Row label="Balance due" value={usd(check.balanceDueCents)} strong />
            )}
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                onClick={send}
                disabled={held.length === 0}
                className={`rounded-xl py-2.5 font-medium ${
                  held.length
                    ? "bg-ai text-bg"
                    : "bg-panel-card text-ink-400 cursor-not-allowed"
                }`}
              >
                Send{held.length ? ` (${held.length})` : ""}
              </button>
              <button
                onClick={() => setTender(true)}
                className="rounded-xl py-2.5 font-medium bg-state-availBg text-state-avail border border-border"
              >
                Pay
              </button>
            </div>
            {maxCourse > check.currentCourse && (
              <button
                onClick={() => fireCourse(check.currentCourse + 1)}
                className="w-full rounded-xl py-2 mt-1 text-sm bg-state-diningBg text-state-dining border border-border"
              >
                Fire course {check.currentCourse + 1}
              </button>
            )}
          </footer>
        </section>

        {/* ── menu ── */}
        <section className="flex-1 flex flex-col min-w-0">
          <nav className="flex gap-2 px-4 py-3 overflow-x-auto border-b border-border">
            {menu?.categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setCatId(c.id)}
                className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap ${
                  c.id === catId
                    ? "bg-ai-bg text-ai"
                    : "text-ink-400 hover:text-ink-50 hover:bg-panel-up"
                }`}
              >
                {c.name}
              </button>
            ))}
          </nav>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {cat?.items.map((it) => (
                <button
                  key={it.id}
                  disabled={!it.active}
                  onClick={() =>
                    it.modifierGroups.length ? setSheet(it) : addLine(it, [], 1)
                  }
                  className={`rounded-2xl border p-4 text-left min-h-[92px] ${
                    it.active
                      ? "bg-panel-card border-border hover:border-border-hi"
                      : "bg-panel border-border opacity-40"
                  }`}
                >
                  <div className="text-ink-50 font-medium leading-tight">{it.name}</div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-sm text-ink-400">{usd(it.priceCents)}</span>
                    {!it.active && (
                      <span className="text-xs text-state-seated font-medium">86</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      {sheet && (
        <ModifierSheet
          item={sheet}
          onClose={() => setSheet(null)}
          onAdd={(ids, qty) => { setSheet(null); addLine(sheet, ids, qty); }}
        />
      )}
      {tender && menu && (
        <TenderDialog
          check={check}
          tipPresets={menu.settings.tipPresets as number[]}
          onClose={() => setTender(false)}
          onDone={(fresh, change) => {
            setTender(false);
            if (fresh.status === "closed") {
              flash(change > 0 ? `closed — change ${usd(change)}` : "check closed");
              setCheck(null);
              loadList();
            } else {
              setCheck(fresh);
            }
          }}
          flash={flash}
        />
      )}
      {toast && <Toast msg={toast} />}
    </main>
  );
}

// ── small pieces ────────────────────────────────────────────────────
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={strong ? "text-ink-50 font-medium" : "text-ink-400"}>{label}</span>
      <span className={strong ? "text-ink-50 font-semibold" : "text-ink-200"}>{value}</span>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    held: "text-ink-400",
    fired: "text-state-dining",
    bumped: "text-state-avail",
    voided: "text-state-seated",
  };
  return <span className={map[state] ?? ""}>{state}</span>;
}

function Stepper({
  value, setValue, min, max,
}: { value: number; setValue: (n: number) => void; min: number; max: number }) {
  return (
    <span className="inline-flex items-center rounded-lg bg-panel-card border border-border">
      <button className="px-2 py-0.5 text-ink-400" onClick={() => setValue(Math.max(min, value - 1))}>−</button>
      <span className="px-1 text-ink-50 min-w-[1.5rem] text-center">{value}</span>
      <button className="px-2 py-0.5 text-ink-400" onClick={() => setValue(Math.min(max, value + 1))}>+</button>
    </span>
  );
}

function Toast({ msg }: { msg: string }) {
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-xl bg-panel-up border border-border-hi text-ink-50 text-sm px-4 py-2 shadow-lg z-50">
      {msg}
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-2xl bg-panel-card border border-border-hi p-5 max-h-[85vh] overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function NewCheckDialog({
  onClose, onOpen,
}: { onClose: () => void; onOpen: (t: string, g: number, s: string) => void }) {
  const [table, setTable] = useState("");
  const [guests, setGuests] = useState(2);
  const [server, setServer] = useState("");
  return (
    <Overlay onClose={onClose}>
      <h2 className="text-lg font-semibold text-ink-50 mb-4">New check</h2>
      <label className="block text-sm text-ink-400 mb-1">Table</label>
      <input
        autoFocus value={table} onChange={(e) => setTable(e.target.value)}
        placeholder="12, Bar 3, Patio 2…"
        className="w-full rounded-xl bg-panel border border-border px-3 py-2 text-ink-50 mb-3"
      />
      <label className="block text-sm text-ink-400 mb-1">Guests</label>
      <div className="mb-3"><Stepper value={guests} setValue={setGuests} min={1} max={20} /></div>
      <label className="block text-sm text-ink-400 mb-1">Server</label>
      <input
        value={server} onChange={(e) => setServer(e.target.value)} placeholder="optional"
        className="w-full rounded-xl bg-panel border border-border px-3 py-2 text-ink-50 mb-4"
      />
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
        <button
          disabled={!table.trim()}
          onClick={() => onOpen(table.trim(), guests, server.trim())}
          className={`px-4 py-2 rounded-xl font-medium ${table.trim() ? "bg-ai text-bg" : "bg-panel text-ink-400"}`}
        >
          Open check
        </button>
      </div>
    </Overlay>
  );
}

function ModifierSheet({
  item, onClose, onAdd,
}: { item: Item; onClose: () => void; onAdd: (modifierIds: string[], qty: number) => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState(1);
  const toggle = (g: ModGroup, m: Mod) => {
    const next = new Set(picked);
    if (next.has(m.id)) next.delete(m.id);
    else {
      const inGroup = g.modifiers.filter((x) => next.has(x.id));
      if (inGroup.length >= g.maxSelect && g.maxSelect === 1 && inGroup[0]) next.delete(inGroup[0].id);
      else if (inGroup.length >= g.maxSelect) return;
      next.add(m.id);
    }
    setPicked(next);
  };
  const satisfied = item.modifierGroups.every(
    (g) => g.modifiers.filter((m) => picked.has(m.id)).length >= g.minSelect
  );
  return (
    <Overlay onClose={onClose}>
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-semibold text-ink-50">{item.name}</h2>
        <span className="text-ink-400">{usd(item.priceCents)}</span>
      </div>
      {item.modifierGroups.map((g) => (
        <div key={g.id} className="mt-4">
          <div className="text-sm text-ink-400 mb-2">
            {g.name}
            <span className="ml-2 text-xs">
              {g.minSelect > 0 ? `pick ${g.minSelect}${g.maxSelect > g.minSelect ? `–${g.maxSelect}` : ""}` : `up to ${g.maxSelect}`}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {g.modifiers.map((m) => (
              <button
                key={m.id}
                onClick={() => toggle(g, m)}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  picked.has(m.id)
                    ? "bg-ai-bg text-ai border-ai/40"
                    : "bg-panel border-border text-ink-200 hover:border-border-hi"
                }`}
              >
                {m.name}{m.priceCents ? ` +${usd(m.priceCents)}` : ""}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between mt-5">
        <Stepper value={qty} setValue={setQty} min={1} max={20} />
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
          <button
            disabled={!satisfied}
            onClick={() => onAdd([...picked], qty)}
            className={`px-4 py-2 rounded-xl font-medium ${satisfied ? "bg-ai text-bg" : "bg-panel text-ink-400"}`}
          >
            Add to check
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function TenderDialog({
  check, tipPresets, onClose, onDone, flash,
}: {
  check: CheckFull;
  tipPresets: number[];
  onClose: () => void;
  onDone: (fresh: CheckFull, changeCents: number) => void;
  flash: (m: string) => void;
}) {
  const [tipCents, setTipCents] = useState(0);
  const [tendered, setTendered] = useState("");
  // Display-only preview; the SERVER recomputes and validates everything.
  const duePreview = check.balanceDueCents + tipCents;
  const tenderedCents = Math.round((parseFloat(tendered) || 0) * 100);
  const changePreview = tenderedCents - duePreview;
  const heldCount = check.items.filter((i) => i.state === "held").length;

  const pay = async (method: "cash" | "comp") => {
    try {
      const fresh = await api<CheckFull & { changeCents: number }>(
        `/api/pos/checks/${check.id}/pay`,
        { json: { method, tenderedCents, tipCents } }
      );
      onDone(fresh, fresh.changeCents ?? 0);
    } catch (e) {
      flash(e instanceof Error ? e.message : "payment failed");
    }
  };

  return (
    <Overlay onClose={onClose}>
      <h2 className="text-lg font-semibold text-ink-50 mb-1">
        Close — Table {check.tableLabel}
      </h2>
      {heldCount > 0 && (
        <p className="text-sm text-state-seated mb-2">
          {heldCount} held item{heldCount > 1 ? "s" : ""} — send or void before paying.
        </p>
      )}
      <div className="text-sm space-y-1 mb-4">
        <Row label="Balance" value={usd(check.balanceDueCents)} />
        {tipCents > 0 && <Row label="Tip" value={usd(tipCents)} />}
        <Row label="To collect" value={usd(duePreview)} strong />
      </div>

      <div className="text-sm text-ink-400 mb-1">Tip</div>
      <div className="flex gap-2 mb-4 flex-wrap">
        {tipPresets.map((p) => {
          const cents = Math.round((check.subtotalCents * p) / 100);
          return (
            <button
              key={p}
              onClick={() => setTipCents(cents)}
              className={`px-3 py-1.5 rounded-full text-sm border ${
                tipCents === cents
                  ? "bg-ai-bg text-ai border-ai/40"
                  : "bg-panel border-border text-ink-200"
              }`}
            >
              {p}% · {usd(cents)}
            </button>
          );
        })}
        <button
          onClick={() => setTipCents(0)}
          className={`px-3 py-1.5 rounded-full text-sm border ${
            tipCents === 0 ? "bg-ai-bg text-ai border-ai/40" : "bg-panel border-border text-ink-200"
          }`}
        >
          No tip
        </button>
      </div>

      <div className="text-sm text-ink-400 mb-1">Cash tendered</div>
      <input
        inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)}
        placeholder="0.00"
        className="w-full rounded-xl bg-panel border border-border px-3 py-2 text-ink-50 mb-2"
      />
      <div className="flex gap-2 mb-3">
        {[duePreview, Math.ceil(duePreview / 2000) * 2000, Math.ceil(duePreview / 10000) * 10000]
          .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
          .map((v) => (
            <button
              key={v}
              onClick={() => setTendered((v / 100).toFixed(2))}
              className="px-3 py-1.5 rounded-full text-sm bg-panel border border-border text-ink-200"
            >
              {usd(v)}
            </button>
          ))}
      </div>
      {tenderedCents >= duePreview && duePreview > 0 && (
        <p className="text-sm text-state-avail mb-3">Change due: {usd(changePreview)}</p>
      )}

      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
        <button onClick={() => pay("comp")} className="px-4 py-2 rounded-xl text-state-dining bg-state-diningBg">
          Comp
        </button>
        <button
          disabled={heldCount > 0 || tenderedCents < duePreview || duePreview <= 0}
          onClick={() => pay("cash")}
          className={`px-4 py-2 rounded-xl font-medium ${
            heldCount === 0 && tenderedCents >= duePreview && duePreview > 0
              ? "bg-state-avail text-bg"
              : "bg-panel text-ink-400"
          }`}
        >
          Cash
        </button>
      </div>
    </Overlay>
  );
}
