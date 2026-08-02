"use client";
// /pos — Travola POS terminal, design B (Toast-style command bar) with
// the design-C Floor View as a tab. PIN-scoped: every list and floor
// interaction is filtered to the logged-in server's section.
// ALL money comes from the server; this file only renders it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, usd, ageMinutes } from "@/lib/ui";

// ── server payload types ────────────────────────────────────────────
type Me = { id: string; name: string; color: string };
type Mod = { id: string; name: string; priceCents: number };
type ModGroup = { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Mod[] };
type Item = { id: string; name: string; priceCents: number; station: string; active: boolean; modifierGroups: ModGroup[] };
type Cat = { id: string; name: string; items: Item[] };
type MenuPayload = { categories: Cat[]; settings: { taxRateBps: number; tipPresets: number[] } };
type Line = {
  id: string; nameSnapshot: string; priceCents: number; quantity: number;
  seat: number | null; course: number; modifiers: { name: string; priceCents: number }[];
  station: string; state: string;
};
type CheckFull = {
  id: string; tableLabel: string; serverName: string; guestCount: number;
  status: string; currentCourse: number; openedAt: string;
  subtotalCents: number; taxCents: number; tipCents: number; totalCents: number;
  balanceDueCents: number; items: Line[];
  payments: { id: string; method: string; amountCents: number; tipCents: number }[];
  changeCents?: number;
};
type FloorTable = {
  id: string; label: string; x: number; y: number; w: number; h: number;
  shape: string; serverId: string | null; state: string; mine: boolean;
  check: { id: string; totalCents: number; guestCount: number; openedAt: string; itemCount: number } | null;
};
type FloorPayload = { me: Me; servers: Me[]; tables: FloorTable[] };

const CAT_COLORS = ["var(--color-state-avail)", "var(--color-ai)", "var(--color-state-dining)", "var(--color-state-reserved)", "var(--color-state-seated)"];

export default function PosTerminal() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [menu, setMenu] = useState<MenuPayload | null>(null);
  const [tab, setTab] = useState<"checks" | "floor">("floor");
  const [checks, setChecks] = useState<CheckFull[]>([]);
  const [floor, setFloor] = useState<FloorPayload | null>(null);
  const [check, setCheck] = useState<CheckFull | null>(null); // null = home
  const [catId, setCatId] = useState<string | null>(null);
  const [seat, setSeat] = useState<number | null>(null); // null = whole table
  const [course, setCourse] = useState(1);
  const [selLine, setSelLine] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Item | null>(null);
  const [tender, setTender] = useState(false);
  const [seatTable, setSeatTable] = useState<FloorTable | null>(null); // guest-count dialog
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // ── boot: auth gate + menu ──
  useEffect(() => {
    api<Me>("/api/pos/auth")
      .then(setMe)
      .catch(() => router.push("/login"));
    api<MenuPayload>("/api/pos/menu").then((m) => {
      setMenu(m);
      setCatId(m.categories[0]?.id ?? null);
    }).catch(() => flash("menu failed to load"));
  }, [router, flash]);

  // ── home polling ──
  const loadHome = useCallback(async () => {
    try {
      const [c, f] = await Promise.all([
        api<CheckFull[]>("/api/pos/checks?status=open"),
        api<FloorPayload>("/api/pos/floor"),
      ]);
      setChecks(c); setFloor(f);
    } catch {}
  }, []);
  useEffect(() => {
    if (check) return;
    loadHome();
    const t = setInterval(loadHome, 4000);
    return () => clearInterval(t);
  }, [check, loadHome]);

  const run = useCallback(async (fn: () => Promise<CheckFull>, okMsg?: string) => {
    try {
      const fresh = await fn();
      setCheck(fresh); setSelLine(null);
      if (okMsg) flash(okMsg);
      return fresh;
    } catch (e) {
      flash(e instanceof Error ? e.message : "request failed");
      return null;
    }
  }, [flash]);

  // ── actions ──
  const openTable = (t: FloorTable) => {
    if (!t.mine) return;
    if (t.check) run(() => api<CheckFull>(`/api/pos/checks/${t.check!.id}`));
    else setSeatTable(t);
  };
  const createCheck = (t: FloorTable, guests: number) =>
    run(async () => {
      const c = await api<CheckFull>("/api/pos/checks", { json: { tableId: t.id, guestCount: guests } });
      setSeatTable(null); setSeat(null); setCourse(1);
      return api<CheckFull>(`/api/pos/checks/${c.id}`);
    }, `Table ${t.label} sat`);

  const addLine = (item: Item, modifierIds: string[], quantity: number) =>
    run(() => api<CheckFull>(`/api/pos/checks/${check!.id}/items`, {
      json: { lines: [{ menuItemId: item.id, quantity, seat: seat ?? undefined, course, modifierIds }] },
    }), `${item.name} added`);

  const send = () => run(() => api<CheckFull>(`/api/pos/checks/${check!.id}/send`, { json: {} }), "sent");
  const fire = (n: number) => run(() => api<CheckFull>(`/api/pos/checks/${check!.id}/fire`, { json: { course: n } }), `course ${n} fired`);
  const holdSel = () => {
    const l = check?.items.find((i) => i.id === selLine);
    if (!l) return flash("select a held line first");
    run(() => api<CheckFull>(`/api/pos/checks/${check!.id}/items/${l.id}`, { json: { action: "hold" } }), `held to C${l.course + 1}`);
  };
  const voidSel = () => {
    const l = check?.items.find((i) => i.id === selLine);
    if (!l) return flash("select a line first");
    const reason = window.prompt(`Void ${l.nameSnapshot} — reason:`);
    if (!reason) return;
    run(() => api<CheckFull>(`/api/pos/checks/${check!.id}/items/${l.id}`, { json: { action: "void", reason } }), "voided");
  };

  const held = check?.items.filter((i) => i.state === "held" && i.course <= (check?.currentCourse ?? 1)) ?? [];
  const heldAll = check?.items.filter((i) => i.state === "held") ?? [];
  const maxCourse = Math.max(1, ...(check?.items.map((i) => i.course) ?? [1]));
  const cat = useMemo(() => menu?.categories.find((c) => c.id === catId) ?? null, [menu, catId]);
  const catColor = (id: string) => CAT_COLORS[(menu?.categories.findIndex((c) => c.id === id) ?? 0) % CAT_COLORS.length];
  const qtyOnCheck = (itemName: string) =>
    check?.items.filter((l) => l.state !== "voided" && l.nameSnapshot === itemName)
      .reduce((s, l) => s + l.quantity, 0) ?? 0;

  if (!me) return <main className="flex-1 min-h-screen" />;

  // ══ HOME: tabs — My checks | Floor view ═══════════════════════════
  if (!check) {
    return (
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="flex items-center gap-3 px-4 h-[52px] bg-panel border-b border-border">
          <span className="h-7 w-7 rounded-lg flex items-center justify-center text-sm font-bold"
            style={{ background: `${me.color}22`, color: me.color }}>
            {me.name[0]}
          </span>
          <span className="text-ink-50 font-semibold">{me.name}</span>
          <nav className="ml-4 flex gap-1 bg-panel-card rounded-xl p-1 border border-border">
            <button onClick={() => setTab("floor")}
              className={`px-4 py-1.5 rounded-lg text-sm ${tab === "floor" ? "bg-ai-bg text-ai font-medium" : "text-ink-400"}`}>
              Floor view
            </button>
            <button onClick={() => setTab("checks")}
              className={`px-4 py-1.5 rounded-lg text-sm ${tab === "checks" ? "bg-ai-bg text-ai font-medium" : "text-ink-400"}`}>
              My checks
            </button>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-ink-400">
            <span>{checks.length} open · {usd(checks.reduce((s, c) => s + c.totalCents, 0))}</span>
            <button onClick={async () => { await api("/api/pos/auth", { method: "DELETE", json: {} }); router.push("/login"); }}
              className="text-ink-400 hover:text-ink-50">
              Log out
            </button>
          </div>
        </header>

        {tab === "floor" && floor && (
          <div className="flex-1 relative m-4 rounded-2xl border border-border bg-panel overflow-hidden">
            {floor.tables.map((t) => {
              const sat = !!t.check;
              const done = t.state === "done" && !t.check;
              const base: React.CSSProperties = {
                left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%`,
                borderRadius: t.shape === "round" ? "999px" : "14px",
              };
              const style: React.CSSProperties = t.mine
                ? sat
                  ? { ...base, border: `2px solid ${me.color}`, background: `${me.color}1f`, boxShadow: `0 0 0 3px ${me.color}22` }
                  : done
                  ? { ...base, border: "2px solid var(--color-state-avail)", background: "var(--color-state-availBg)" }
                  : { ...base, border: `2px solid ${me.color}66`, background: "var(--color-panel-card)" }
                : { ...base, border: "2px solid var(--color-border)", background: "var(--color-panel-card)", opacity: 0.32 };
              return (
                <button key={t.id} onClick={() => openTable(t)} disabled={!t.mine}
                  className="absolute flex flex-col items-center justify-center gap-0.5"
                  style={style}>
                  <span className="font-bold text-ink-50 text-[15px]">{t.label}</span>
                  <span className="text-[11px]" style={{ color: t.mine ? (sat ? me.color : done ? "var(--color-state-avail)" : "var(--color-ink-400)") : "var(--color-ink-400)" }}>
                    {sat ? `${usd(t.check!.totalCents)} · ${t.check!.guestCount} · ${ageMinutes(t.check!.openedAt)}m`
                      : done ? "done" : "—"}
                  </span>
                </button>
              );
            })}
            <div className="absolute bottom-3 left-4 flex gap-4 text-xs text-ink-400">
              <span><i className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style={{ background: me.color }} />your section</span>
              <span><i className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle bg-state-avail" />done</span>
              <span><i className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle bg-panel-up" />other sections</span>
            </div>
            <div className="absolute bottom-3 right-4 text-xs text-ink-400">
              Default floorplan — live Travola floor connects at integration
            </div>
          </div>
        )}

        {tab === "checks" && (
          <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 content-start">
            {checks.map((c) => (
              <button key={c.id} onClick={() => run(() => api<CheckFull>(`/api/pos/checks/${c.id}`))}
                className="rounded-2xl bg-panel-card border border-border hover:border-border-hi p-4 text-left">
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-semibold text-ink-50">{c.tableLabel}</span>
                  <span className="text-xs text-ink-400">{ageMinutes(c.openedAt)}m</span>
                </div>
                <div className="text-sm text-ink-400 mt-1">{c.guestCount} guests</div>
                <div className="flex items-center justify-between mt-3">
                  <span className="text-xs text-ink-400">{c.items.filter((i) => i.state !== "voided").length} items</span>
                  <span className="text-ink-50 font-medium">{usd(c.totalCents)}</span>
                </div>
              </button>
            ))}
            {checks.length === 0 && (
              <div className="col-span-full text-ink-400 text-sm py-16 text-center">
                No open checks — seat a table from the Floor view.
              </div>
            )}
          </div>
        )}

        {seatTable && (
          <SeatDialog table={seatTable} onClose={() => setSeatTable(null)} onSeat={createCheck} color={me.color} />
        )}
        {toast && <Toast msg={toast} />}
      </main>
    );
  }

  // ══ ORDER SCREEN (design B) ═══════════════════════════════════════
  return (
    <main className="h-screen grid overflow-hidden"
      style={{ gridTemplateColumns: "88px 1fr 320px", gridTemplateRows: "48px 1fr 74px" }}>
      {/* header */}
      <header className="col-span-3 flex items-center gap-3 px-4 bg-panel border-b border-border text-sm">
        <button onClick={() => { setCheck(null); loadHome(); }} className="text-ink-400 hover:text-ink-50">←</button>
        <span className="font-bold text-[15px] text-ink-50">Tbl {check.tableLabel}</span>
        <span className="text-ink-400">{me.name} · {check.guestCount} guests · C{check.currentCourse}</span>
        <span className="chip rounded-full px-3 py-1 text-[12.5px] border"
          style={{ background: "var(--color-ai-bg)", color: "var(--color-ai)", borderColor: "rgba(129,140,248,.35)" }}>
          {ageMinutes(check.openedAt)}m open
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-ink-400 mr-1 text-xs">Seat</span>
          <SeatBtn label="T" on={seat === null} onClick={() => setSeat(null)} />
          {Array.from({ length: check.guestCount }, (_, i) => (
            <SeatBtn key={i} label={`${i + 1}`} on={seat === i + 1} onClick={() => setSeat(i + 1)} />
          ))}
          <span className="text-ink-400 mx-1 text-xs">Course</span>
          {[1, 2, 3, 4].map((n) => (
            <SeatBtn key={n} label={`C${n}`} on={course === n} onClick={() => setCourse(n)} />
          ))}
        </div>
      </header>

      {/* category rail */}
      <nav className="bg-panel border-r border-border py-2.5 px-2 flex flex-col gap-2 overflow-y-auto">
        {menu?.categories.map((c, i) => (
          <button key={c.id} onClick={() => setCatId(c.id)}
            className={`rounded-xl px-1 py-2.5 text-center text-[11.5px] border ${
              c.id === catId ? "bg-panel-card border-border-hi text-ink-50" : "border-transparent text-ink-400"
            }`}>
            <span className="block mx-auto mb-1.5 h-1 w-[22px] rounded"
              style={{ background: CAT_COLORS[i % CAT_COLORS.length] }} />
            {c.name.split(" ")[0]}
          </button>
        ))}
      </nav>

      {/* item grid */}
      <div className="p-3.5 grid grid-cols-3 xl:grid-cols-4 gap-2.5 content-start overflow-y-auto">
        {cat?.items.map((it) => {
          const q = qtyOnCheck(it.name);
          return (
            <button key={it.id} disabled={!it.active}
              onClick={() => (it.modifierGroups.length ? setSheet(it) : addLine(it, [], 1))}
              className={`relative h-[86px] rounded-xl border text-left px-3 py-2.5 ${
                it.active ? "bg-panel-card border-border hover:border-border-hi" : "bg-panel border-border opacity-40"
              }`}>
              <span className="absolute inset-y-0 left-0 w-1 rounded-l-xl opacity-80"
                style={{ background: catColor(cat.id) }} />
              <div className="font-semibold text-sm text-ink-50 leading-tight">{it.name}</div>
              <div className="absolute bottom-2 left-3 text-ink-400 text-[12.5px]">
                {usd(it.priceCents)}{!it.active && " · 86"}
              </div>
              {q > 0 && (
                <span className="absolute top-2 right-2.5 rounded-lg bg-ai-bg text-ai px-2 text-xs font-bold py-px">{q}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* check panel */}
      <aside className="bg-panel border-l border-border flex flex-col min-h-0">
        <h3 className="text-[12px] text-ink-400 uppercase tracking-widest px-3.5 pt-3 pb-1.5">
          Check · {usd(check.totalCents)}
        </h3>
        <div className="flex-1 overflow-y-auto px-2.5 flex flex-col gap-1.5">
          {check.items.map((l) => (
            <button key={l.id} onClick={() => setSelLine(selLine === l.id ? null : l.id)}
              className={`text-left rounded-lg px-2.5 py-1.5 text-[13.5px] border ${
                selLine === l.id ? "border-ai bg-ai-muted" :
                l.state === "voided" ? "border-border opacity-40 line-through" :
                l.state === "held" ? "bg-panel-card border-border-hi" : "bg-panel-card border-border"
              }`}>
              <div className="flex justify-between text-ink-50">
                <span>{l.quantity > 1 ? `${l.quantity}× ` : ""}{l.nameSnapshot}</span>
                <span className="text-ink-200">
                  {usd((l.priceCents + l.modifiers.reduce((s, m) => s + m.priceCents, 0)) * l.quantity)}
                </span>
              </div>
              {l.modifiers.length > 0 && (
                <div className="text-[11.5px] text-state-dining">{l.modifiers.map((m) => m.name).join(" · ")}</div>
              )}
              <div className="text-[11px] text-ink-400">
                {l.seat ? `S${l.seat} · ` : ""}C{l.course} · <StateWord s={l.state} />
              </div>
            </button>
          ))}
          {check.items.length === 0 && <p className="text-sm text-ink-400 p-3">Tap items to start the order.</p>}
        </div>
        <div className="flex justify-between border-t border-border px-3.5 py-2.5 text-[13px] text-ink-400">
          <span>Sub {usd(check.subtotalCents)} · Tax {usd(check.taxCents)}</span>
          <b className="text-ink-50">{usd(check.totalCents)}</b>
        </div>
      </aside>

      {/* command bar */}
      <div className="col-span-3 bg-panel border-t border-border grid gap-2.5 px-4 py-3"
        style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1.4fr" }}>
        <Cmd label={`SEND${held.length ? ` (${held.length})` : ""}`} kind="send" disabled={!held.length} onClick={send} />
        <Cmd label={`FIRE C${Math.min(check.currentCourse + 1, 9)}`} kind="fire"
          disabled={maxCourse <= check.currentCourse} onClick={() => fire(check.currentCourse + 1)} />
        <Cmd label="HOLD" disabled={!selLine} onClick={holdSel} />
        <Cmd label="VOID" disabled={!selLine} onClick={voidSel} />
        <Cmd label={`PAY ${usd(check.totalCents)}`} kind="pay" disabled={heldAll.length > 0 && held.length > 0} onClick={() => setTender(true)} />
      </div>

      {sheet && (
        <ModifierSheet item={sheet} onClose={() => setSheet(null)}
          onAdd={(ids, qty) => { setSheet(null); addLine(sheet, ids, qty); }} />
      )}
      {tender && menu && (
        <TenderDialog check={check} tipPresets={menu.settings.tipPresets as number[]}
          onClose={() => setTender(false)} flash={flash}
          onDone={(fresh, change) => {
            setTender(false);
            if (fresh.status === "closed") {
              flash(change > 0 ? `closed — change ${usd(change)}` : "check closed");
              setCheck(null); loadHome();
            } else setCheck(fresh);
          }} />
      )}
      {toast && <Toast msg={toast} />}
    </main>
  );
}

// ── pieces ──────────────────────────────────────────────────────────
function SeatBtn({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`h-[30px] min-w-[30px] px-1.5 rounded-lg border text-[12.5px] ${
        on ? "bg-ai-bg text-ai font-bold" : "bg-panel-card text-ink-400 border-border"
      }`}
      style={on ? { borderColor: "rgba(129,140,248,.4)" } : {}}>
      {label}
    </button>
  );
}

function Cmd({ label, kind, disabled, onClick }: { label: string; kind?: string; disabled?: boolean; onClick: () => void }) {
  const styles: Record<string, string> = {
    send: "bg-ai text-bg border-transparent",
    fire: "bg-state-diningBg text-state-dining border-border",
    pay: "bg-state-availBg text-state-avail border-border",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`rounded-xl border text-[15px] font-bold py-3 ${styles[kind ?? ""] ?? "bg-panel-card text-ink-200 border-border"} ${disabled ? "opacity-35 cursor-not-allowed" : ""}`}>
      {label}
    </button>
  );
}

function StateWord({ s }: { s: string }) {
  const map: Record<string, string> = {
    held: "text-ink-400", fired: "text-state-dining", bumped: "text-state-avail", voided: "text-state-seated",
  };
  return <span className={map[s] ?? ""}>{s}</span>;
}

function Toast({ msg }: { msg: string }) {
  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 rounded-xl bg-panel-up border border-border-hi text-ink-50 text-sm px-4 py-2 shadow-lg z-50">
      {msg}
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-md rounded-2xl bg-panel-card border border-border-hi p-5 max-h-[85vh] overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function SeatDialog({ table, color, onClose, onSeat }: {
  table: FloorTable; color: string; onClose: () => void;
  onSeat: (t: FloorTable, guests: number) => void;
}) {
  const [guests, setGuests] = useState(2);
  return (
    <Overlay onClose={onClose}>
      <h2 className="text-lg font-semibold text-ink-50 mb-1">
        Seat <span style={{ color }}>Table {table.label}</span>
      </h2>
      <p className="text-sm text-ink-400 mb-4">Opens a check and marks the table sat.</p>
      <div className="grid grid-cols-4 gap-2 mb-5">
        {[1,2,3,4,5,6,7,8].map((n) => (
          <button key={n} onClick={() => setGuests(n)}
            className={`h-12 rounded-xl border text-[15px] ${
              guests === n ? "bg-ai-bg text-ai font-bold" : "bg-panel text-ink-200 border-border"
            }`}
            style={guests === n ? { borderColor: "rgba(129,140,248,.4)" } : {}}>
            {n}
          </button>
        ))}
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
        <button onClick={() => onSeat(table, guests)} className="px-4 py-2 rounded-xl font-medium bg-ai text-bg">
          Seat {guests} →
        </button>
      </div>
    </Overlay>
  );
}

function ModifierSheet({ item, onClose, onAdd }: {
  item: Item; onClose: () => void; onAdd: (modifierIds: string[], qty: number) => void;
}) {
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
              <button key={m.id} onClick={() => toggle(g, m)}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  picked.has(m.id) ? "bg-ai-bg text-ai" : "bg-panel border-border text-ink-200 hover:border-border-hi"
                }`}
                style={picked.has(m.id) ? { borderColor: "rgba(129,140,248,.4)" } : {}}>
                {m.name}{m.priceCents ? ` +${usd(m.priceCents)}` : ""}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between mt-5">
        <span className="inline-flex items-center rounded-lg bg-panel border border-border">
          <button className="px-3 py-1 text-ink-400" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
          <span className="px-1 text-ink-50 min-w-[1.5rem] text-center">{qty}</span>
          <button className="px-3 py-1 text-ink-400" onClick={() => setQty(Math.min(20, qty + 1))}>+</button>
        </span>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
          <button disabled={!satisfied} onClick={() => onAdd([...picked], qty)}
            className={`px-4 py-2 rounded-xl font-medium ${satisfied ? "bg-ai text-bg" : "bg-panel text-ink-400"}`}>
            Add to check
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function TenderDialog({ check, tipPresets, onClose, onDone, flash }: {
  check: CheckFull; tipPresets: number[]; onClose: () => void;
  onDone: (fresh: CheckFull, changeCents: number) => void; flash: (m: string) => void;
}) {
  const [tipCents, setTipCents] = useState(0);
  const [tendered, setTendered] = useState("");
  // Display-only preview — the SERVER recomputes and validates everything.
  const duePreview = check.balanceDueCents + tipCents;
  const tenderedCents = Math.round((parseFloat(tendered) || 0) * 100);
  const heldCount = check.items.filter((i) => i.state === "held").length;

  const pay = async (method: "cash" | "comp" | "card_external") => {
    try {
      const fresh = await api<CheckFull & { changeCents: number }>(
        `/api/pos/checks/${check.id}/pay`, { json: { method, tenderedCents, tipCents } });
      onDone(fresh, fresh.changeCents ?? 0);
    } catch (e) {
      flash(e instanceof Error ? e.message : "payment failed");
    }
  };

  return (
    <Overlay onClose={onClose}>
      <h2 className="text-lg font-semibold text-ink-50 mb-1">Close — Table {check.tableLabel}</h2>
      {heldCount > 0 && (
        <p className="text-sm text-state-seated mb-2">{heldCount} held item{heldCount > 1 ? "s" : ""} — send or void before paying.</p>
      )}
      <div className="text-sm space-y-1 mb-4">
        <div className="flex justify-between text-ink-400"><span>Balance</span><span className="text-ink-200">{usd(check.balanceDueCents)}</span></div>
        {tipCents > 0 && <div className="flex justify-between text-ink-400"><span>Tip</span><span className="text-ink-200">{usd(tipCents)}</span></div>}
        <div className="flex justify-between text-ink-50 font-semibold"><span>To collect</span><span>{usd(duePreview)}</span></div>
      </div>

      <div className="text-sm text-ink-400 mb-1">Tip</div>
      <div className="flex gap-2 mb-4 flex-wrap">
        {tipPresets.map((p) => {
          const cents = Math.round((check.subtotalCents * p) / 100);
          return (
            <button key={p} onClick={() => setTipCents(cents)}
              className={`px-3 py-1.5 rounded-full text-sm border ${tipCents === cents ? "bg-ai-bg text-ai" : "bg-panel border-border text-ink-200"}`}>
              {p}% · {usd(cents)}
            </button>
          );
        })}
        <button onClick={() => setTipCents(0)}
          className={`px-3 py-1.5 rounded-full text-sm border ${tipCents === 0 ? "bg-ai-bg text-ai" : "bg-panel border-border text-ink-200"}`}>
          No tip
        </button>
      </div>

      <div className="text-sm text-ink-400 mb-1">Cash tendered</div>
      <input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="0.00"
        className="w-full rounded-xl bg-panel border border-border px-3 py-2 text-ink-50 mb-2" />
      <div className="flex gap-2 mb-3">
        {[duePreview, Math.ceil(duePreview / 2000) * 2000, Math.ceil(duePreview / 10000) * 10000]
          .filter((v, i, a) => v > 0 && a.indexOf(v) === i)
          .map((v) => (
            <button key={v} onClick={() => setTendered((v / 100).toFixed(2))}
              className="px-3 py-1.5 rounded-full text-sm bg-panel border border-border text-ink-200">
              {usd(v)}
            </button>
          ))}
      </div>
      {tenderedCents >= duePreview && duePreview > 0 && (
        <p className="text-sm text-state-avail mb-3">Change due: {usd(tenderedCents - duePreview)}</p>
      )}

      <div className="flex gap-2 justify-end flex-wrap">
        <button onClick={onClose} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
        <button onClick={() => pay("comp")} className="px-4 py-2 rounded-xl text-state-dining bg-state-diningBg">Comp</button>
        <button onClick={() => pay("card_external")} disabled={heldCount > 0 || duePreview <= 0}
          className={`px-4 py-2 rounded-xl border ${heldCount === 0 && duePreview > 0 ? "text-ai bg-ai-bg border-transparent" : "bg-panel text-ink-400 border-border"}`}>
          Card (external)
        </button>
        <button disabled={heldCount > 0 || tenderedCents < duePreview || duePreview <= 0} onClick={() => pay("cash")}
          className={`px-4 py-2 rounded-xl font-medium ${heldCount === 0 && tenderedCents >= duePreview && duePreview > 0 ? "bg-state-avail text-bg" : "bg-panel text-ink-400"}`}>
          Cash
        </button>
      </div>
    </Overlay>
  );
}
