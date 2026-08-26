"use client";
// /pos — Travola POS terminal. Design B (Toast command bar) + Floor View
// tab. Every item-add opens the ItemSheet: seat, course (tableside
// memory), modifiers, add-on tags (shift-decaying for server-created),
// and a note to the kitchen. Manager role (PIN 1412) unlocks all tables,
// all checks, menu builder, and add-on administration.
// ALL money comes from the server; this file only renders it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, usd, ageMinutes } from "@/lib/ui";

// ── server payload types ────────────────────────────────────────────
type Me = { id: string; name: string; color: string; role: string };
type Mod = { id: string; name: string; priceCents: number };
type ModGroup = { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Mod[] };
type Item = {
  id: string; name: string; priceCents: number; station: string; active: boolean;
  ephemeral?: boolean; description?: string; createdBy?: string;
  modifierGroups: ModGroup[];
};
type Cat = { id: string; name: string; items: Item[] };
type AddOn = {
  id: string; menuItemId: string | null; name: string; priceCents: number;
  ephemeral: boolean; createdBy: string;
};
type MenuPayload = {
  categories: Cat[]; settings: { taxRateBps: number; tipPresets: number[] };
  addOns: AddOn[]; customItems: Item[];
};
type Line = {
  id: string; nameSnapshot: string; priceCents: number; quantity: number;
  seat: number | null; course: number; modifiers: { name: string; priceCents: number }[];
  note: string; station: string; state: string;
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
  id: string; label: string; floorId: string; x: number; y: number; w: number; h: number;
  shape: string; capacity: number; serverId: string | null; state: string; mine: boolean;
  party: string | null; partySize: number | null; seatedAt: string | null;
  check: { id: string; totalCents: number; guestCount: number; openedAt: string; itemCount: number } | null;
};
type FloorPayload = { me: Me; servers: { id: string; name: string; color: string; role: string }[]; floors: { id: string; name: string }[]; tables: FloorTable[] };

const CAT_COLORS = ["var(--color-state-avail)", "var(--color-ai)", "var(--color-state-dining)", "var(--color-state-reserved)", "var(--color-state-seated)"];
const CUSTOM_COLOR = "var(--color-state-reserved)";
const CUSTOM_TAB = "__custom__";

export default function PosTerminal() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [menu, setMenu] = useState<MenuPayload | null>(null);
  const [tab, setTab] = useState<"checks" | "floor">("floor");
  const [checks, setChecks] = useState<CheckFull[]>([]);
  const [floor, setFloor] = useState<FloorPayload | null>(null);
  const [floorId, setFloorId] = useState<string | null>(null); // live Travola floor tab
  const [check, setCheck] = useState<CheckFull | null>(null); // null = home
  const [catId, setCatId] = useState<string | null>(null);
  const [selLine, setSelLine] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Item | null>(null); // the ItemSheet
  const [customDialog, setCustomDialog] = useState<"dish" | "drink" | null>(null);
  const [tender, setTender] = useState(false);
  const [seatTable, setSeatTable] = useState<FloorTable | null>(null);
  const [confirmOut, setConfirmOut] = useState(false);
  const [pinTarget, setPinTarget] = useState<AddOn | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const loadMenu = useCallback(
    () =>
      api<MenuPayload>("/api/pos/menu").then((m) => {
        setMenu(m);
        setCatId((c) => c ?? m.categories[0]?.id ?? null);
        return m;
      }),
    []
  );

  useEffect(() => {
    api<Me>("/api/pos/auth").then(setMe).catch(() => router.push("/login"));
    loadMenu().catch(() => flash("menu failed to load"));
  }, [router, flash, loadMenu]);

  const loadHome = useCallback(async () => {
    try {
      const [c, f] = await Promise.all([
        api<CheckFull[]>("/api/pos/checks?status=open"),
        api<FloorPayload>("/api/pos/floor"),
      ]);
      setChecks(c); setFloor(f);
      setFloorId((cur) => cur ?? f.floors?.[0]?.id ?? null);
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

  // ── actions ───────────────────────────────────────────────────────
  const openTable = (t: FloorTable) => {
    if (!t.mine) return;
    if (t.check) run(() => api<CheckFull>(`/api/pos/checks/${t.check!.id}`));
    else setSeatTable(t); // host-seated party prefills guests from partySize
  };
  const createCheck = (t: FloorTable, guests: number) =>
    run(async () => {
      const c = await api<CheckFull>("/api/pos/checks", { json: { tableId: t.id, guestCount: guests } });
      setSeatTable(null);
      return api<CheckFull>(`/api/pos/checks/${c.id}`);
    }, `Table ${t.label} sat`);

  const addLine = (item: Item, sel: SheetResult) =>
    run(() => api<CheckFull>(`/api/pos/checks/${check!.id}/items`, {
      json: { lines: [{
        menuItemId: item.id, quantity: sel.qty, seat: sel.seat ?? undefined,
        course: sel.course, modifierIds: sel.modifierIds, addOnIds: sel.addOnIds,
        note: sel.note,
      }] },
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
  const logout = async () => {
    await api("/api/pos/auth", { method: "DELETE", json: {} });
    router.push("/login");
  };

  // Sign the DEVICE out of the restaurant (not just the person). The
  // next user must re-enter the restaurant name + passcode — for when a
  // terminal leaves the building, or a demo tablet changes venue.
  const signOutDevice = async () => {
    await api("/api/pos/restaurant", { method: "DELETE", json: {} }).catch(() => {});
    await api("/api/pos/auth", { method: "DELETE", json: {} }).catch(() => {});
    router.push("/login");
  };

  // Add-on admin (shared with the sheet)
  const createAddOn = async (item: Item, name: string, priceCents: number, permanent: boolean) => {
    try {
      await api("/api/pos/addons", { json: { name, priceCents, menuItemId: item.id, permanent } });
      await loadMenu();
      flash(`add-on "${name}" created${permanent ? " (permanent)" : " — decays at shift close"}`);
    } catch (e) { flash(e instanceof Error ? e.message : "failed"); }
  };
  const doDeleteAddOn = async (a: AddOn, managerPin?: string) => {
    try {
      await api(`/api/pos/addons/${a.id}`, { method: "DELETE", json: { managerPin } });
      await loadMenu();
      flash(`"${a.name}" deleted`);
      return true;
    } catch (e) { flash(e instanceof Error ? e.message : "failed"); return false; }
  };
  const deleteAddOn = (a: AddOn) => {
    if (me?.role === "manager") void doDeleteAddOn(a);
    else setPinTarget(a); // styled manager-PIN modal
  };

  // ── derived ───────────────────────────────────────────────────────
  const held = check?.items.filter((i) => i.state === "held" && i.course <= (check?.currentCourse ?? 1)) ?? [];
  const maxCourse = Math.max(1, ...(check?.items.map((i) => i.course) ?? [1]));
  // Tableside course memory: everything up to the highest fired course is
  // on the pass — new items default to the NEXT course.
  const tablesideCourse = useMemo(() => {
    const firedMax = Math.max(
      0,
      ...(check?.items.filter((i) => i.state === "fired" || i.state === "bumped").map((i) => i.course) ?? [0])
    );
    return Math.min(firedMax + 1, 9);
  }, [check]);
  const isCustomTab = catId === CUSTOM_TAB;
  const cat = useMemo(() => menu?.categories.find((c) => c.id === catId) ?? null, [menu, catId]);
  const catColor = (id: string) =>
    id === CUSTOM_TAB ? CUSTOM_COLOR : CAT_COLORS[(menu?.categories.findIndex((c) => c.id === id) ?? 0) % CAT_COLORS.length];
  const qtyOnCheck = (itemName: string) =>
    check?.items.filter((l) => l.state !== "voided" && l.nameSnapshot === itemName)
      .reduce((s, l) => s + l.quantity, 0) ?? 0;
  const addOnsFor = (item: Item) =>
    menu?.addOns.filter((a) => a.menuItemId === null || a.menuItemId === item.id) ?? [];

  if (!me) return <main className="flex-1 min-h-screen" />;

  // ══ HOME: Floor view | My checks ══════════════════════════════════
  if (!check) {
    return (
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="flex items-center gap-3 px-4 h-[52px] bg-panel border-b border-border">
          <span className="h-7 w-7 rounded-lg flex items-center justify-center text-sm font-bold"
            style={{ background: `${me.color}22`, color: me.color }}>
            {me.name[0]}
          </span>
          <span className="text-ink-50 font-semibold">{me.name}</span>
          {me.role === "manager" && <span className="text-xs text-state-avail border border-border rounded-full px-2 py-0.5">manager</span>}
          <nav className="ml-4 flex gap-1 bg-panel-card rounded-xl p-1 border border-border">
            <button onClick={() => setTab("floor")}
              className={`px-4 py-1.5 rounded-lg text-sm ${tab === "floor" ? "bg-ai-bg text-ai font-medium" : "text-ink-400"}`}>
              Floor view
            </button>
            <button onClick={() => setTab("checks")}
              className={`px-4 py-1.5 rounded-lg text-sm ${tab === "checks" ? "bg-ai-bg text-ai font-medium" : "text-ink-400"}`}>
              {me.role === "manager" ? "All checks" : "My checks"}
            </button>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-ink-400">
            <span>{checks.length} open · {usd(checks.reduce((s, c) => s + c.totalCents, 0))}</span>
            {me.role === "manager" && (
              <a href="/menu" className="text-ai hover:underline">Menu builder</a>
            )}
            <button onClick={() => setConfirmOut(true)} className="rounded-lg px-3 py-1.5 bg-state-seatedBg text-state-seated border border-border hover:border-border-hi text-[13px] font-medium">
              Log out
            </button>
          </div>
        </header>

        {tab === "floor" && floor && (
          <div className="flex-1 relative m-4 rounded-2xl border border-border bg-panel overflow-hidden">
            {(floor.floors?.length ?? 0) > 1 && (
              <div className="absolute top-3 left-4 z-10 flex gap-2">
                {floor.floors.map((f) => (
                  <button key={f.id} onClick={() => setFloorId(f.id)}
                    className={`rounded-lg px-3 py-1 text-[12px] font-medium border ${floorId === f.id ? "bg-ai/15 text-ai border-ai/50" : "bg-panel-card text-ink-400 border-border hover:border-border-hi"}`}>
                    {f.name}
                  </button>
                ))}
              </div>
            )}
            {floor.tables.filter((t) => floorId == null || t.floorId === floorId).map((t) => {
              const owner = floor.servers.find((s) => s.id === t.serverId);
              const accent = me.role === "manager" ? owner?.color ?? me.color : me.color;
              const sat = t.state === "sat" || !!t.check;
              const done = t.state === "done" && !t.check;
              const base: React.CSSProperties = {
                left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%`,
                borderRadius: t.shape === "round" ? "999px" : "14px",
              };
              const style: React.CSSProperties = t.mine
                ? sat
                  ? { ...base, border: `2px solid ${accent}`, background: `${accent}1f`, boxShadow: `0 0 0 3px ${accent}22` }
                  : done
                  ? { ...base, border: "2px solid var(--color-state-avail)", background: "var(--color-state-availBg)" }
                  : { ...base, border: `2px solid ${accent}66`, background: "var(--color-panel-card)" }
                : { ...base, border: "2px solid var(--color-border)", background: "var(--color-panel-card)", opacity: 0.32 };
              return (
                <button key={t.id} onClick={() => openTable(t)} disabled={!t.mine}
                  className="absolute flex flex-col items-center justify-center gap-0.5" style={style}>
                  <span className="font-bold text-ink-50 text-[15px]">{t.label}</span>
                  <span className="text-[11px]" style={{ color: t.mine ? (sat ? accent : done ? "var(--color-state-avail)" : "var(--color-ink-400)") : "var(--color-ink-400)" }}>
                    {t.check ? `${usd(t.check.totalCents)} · ${t.check.guestCount} · ${ageMinutes(t.check.openedAt)}m`
                      : sat ? `${t.party ?? "seated"}${t.partySize ? ` · ${t.partySize}` : ""}${t.seatedAt ? ` · ${ageMinutes(t.seatedAt)}m` : ""}`
                      : done ? "done" : "—"}
                  </span>
                </button>
              );
            })}
            <div className="absolute bottom-3 left-4 flex gap-4 text-xs text-ink-400">
              {me.role === "manager" ? (
                floor.servers.filter((s) => s.role !== "manager").map((s) => (
                  <span key={s.id}><i className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style={{ background: s.color }} />{s.name}</span>
                ))
              ) : (
                <span><i className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style={{ background: me.color }} />your section</span>
              )}
              <span><i className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle bg-state-avail" />done</span>
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
                <div className="text-sm text-ink-400 mt-1">
                  {c.guestCount} guests{me.role === "manager" ? ` · ${c.serverName}` : ""}
                </div>
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
          <SeatDialog table={seatTable} onClose={() => setSeatTable(null)} onSeat={createCheck}
            color={me.color} />
        )}
        {confirmOut && (
          <Overlay onClose={() => setConfirmOut(false)}>
            <h2 className="text-lg font-semibold text-ink-50 mb-2">Log out?</h2>
            <p className="text-sm text-ink-400 mb-5">The next server signs in with their PIN. This device stays signed in to the restaurant.</p>
            <div className="flex items-center gap-2 justify-end">
              <button onClick={signOutDevice} className="mr-auto text-xs text-ink-400 hover:text-ink-50 underline">Sign device out of restaurant</button>
              <button onClick={() => setConfirmOut(false)} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
              <button onClick={logout} className="px-4 py-2 rounded-xl font-medium bg-state-seatedBg text-state-seated">Log out</button>
            </div>
          </Overlay>
        )}
        {toast && <Toast msg={toast} />}
      </main>
    );
  }

  // ══ ORDER SCREEN ══════════════════════════════════════════════════
  return (
    <main className="h-screen grid overflow-hidden"
      style={{ gridTemplateColumns: "88px 1fr 320px", gridTemplateRows: "48px 1fr 74px" }}>
      <header className="col-span-3 flex items-center gap-3 px-4 bg-panel border-b border-border text-sm">
        <button onClick={() => { setCheck(null); loadHome(); }}
          className="rounded-lg px-3 py-1.5 bg-panel-card border border-border text-ink-200 hover:border-border-hi text-[13px] font-medium">
          Floor
        </button>
        <span className="font-bold text-[15px] text-ink-50">Tbl {check.tableLabel}</span>
        <span className="text-ink-400">{check.serverName} · {check.guestCount} guests · next items → C{tablesideCourse}</span>
        <span className="rounded-full px-3 py-1 text-[12.5px] border"
          style={{ background: "var(--color-ai-bg)", color: "var(--color-ai)", borderColor: "rgba(129,140,248,.35)" }}>
          {ageMinutes(check.openedAt)}m open
        </span>
        <button onClick={() => setConfirmOut(true)}
          className="ml-auto rounded-lg px-3 py-1.5 bg-state-seatedBg text-state-seated border border-border hover:border-border-hi text-[13px] font-medium">
          Log out
        </button>
      </header>

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
        <button onClick={() => setCatId(CUSTOM_TAB)}
          className={`rounded-xl px-1 py-2.5 text-center text-[11.5px] border ${
            isCustomTab ? "bg-panel-card border-border-hi text-ink-50" : "border-transparent text-ink-400"
          }`}>
          <span className="block mx-auto mb-1.5 h-1 w-[22px] rounded" style={{ background: CUSTOM_COLOR }} />
          Custom
        </button>
      </nav>

      <div className="p-3.5 grid grid-cols-3 xl:grid-cols-4 gap-2.5 content-start overflow-y-auto">
        {!isCustomTab && cat?.items.map((it) => {
          const q = qtyOnCheck(it.name);
          return (
            <button key={it.id} disabled={!it.active} onClick={() => setSheet(it)}
              className={`relative h-[86px] rounded-xl border text-left px-3 py-2.5 ${
                it.active ? "bg-panel-card border-border hover:border-border-hi" : "bg-panel border-border opacity-40"
              }`}>
              <span className="absolute inset-y-0 left-0 w-1 rounded-l-xl opacity-80" style={{ background: catColor(cat.id) }} />
              <div className="font-semibold text-sm text-ink-50 leading-tight">{it.name}</div>
              <div className="absolute bottom-2 left-3 text-ink-400 text-[12.5px]">
                {usd(it.priceCents)}{!it.active && " · 86"}
              </div>
              {q > 0 && <span className="absolute top-2 right-2.5 rounded-lg bg-ai-bg text-ai px-2 text-xs font-bold py-px">{q}</span>}
            </button>
          );
        })}
        {isCustomTab && (
          <>
            {menu?.customItems.map((it) => {
              const q = qtyOnCheck(it.name);
              return (
                <button key={it.id} onClick={() => setSheet(it)}
                  className="relative h-[86px] rounded-xl border text-left px-3 py-2.5 bg-panel-card hover:border-border-hi"
                  style={{ borderColor: "rgba(168,150,224,.45)" }}>
                  <span className="absolute inset-y-0 left-0 w-1 rounded-l-xl opacity-80" style={{ background: CUSTOM_COLOR }} />
                  <div className="font-semibold text-sm text-ink-50 leading-tight">{it.name}</div>
                  {it.description ? (
                    <div className="text-[11px] text-ink-400 leading-tight mt-0.5 line-clamp-2">{it.description}</div>
                  ) : null}
                  <div className="absolute bottom-2 left-3 text-[12.5px]" style={{ color: CUSTOM_COLOR }}>
                    {usd(it.priceCents)} · {it.station} · by {it.createdBy}
                  </div>
                  {q > 0 && <span className="absolute top-2 right-2.5 rounded-lg bg-ai-bg text-ai px-2 text-xs font-bold py-px">{q}</span>}
                </button>
              );
            })}
            <button onClick={() => setCustomDialog("dish")}
              className="h-[86px] rounded-xl border border-dashed border-border-hi text-ink-400 hover:text-ink-50 text-sm">
              + Add custom dish
            </button>
            <button onClick={() => setCustomDialog("drink")}
              className="h-[86px] rounded-xl border border-dashed border-border-hi text-ink-400 hover:text-ink-50 text-sm">
              + Add custom drink
            </button>
            {menu && menu.customItems.length === 0 && (
              <div className="col-span-full text-xs text-ink-400 px-1">
                Shift specials & not-yet-entered items live here. Everything on this tab decays at
                shift close (2:00 PM) — the manager makes keepers permanent in the menu builder.
              </div>
            )}
          </>
        )}
      </div>

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
              {l.note && <div className="text-[11.5px] italic text-state-reserved">“{l.note}”</div>}
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

      <div className="col-span-3 bg-panel border-t border-border grid gap-2.5 px-4 py-3"
        style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1.4fr" }}>
        <Cmd label={`SEND${held.length ? ` (${held.length})` : ""}`} kind="send" disabled={!held.length} onClick={send} />
        <Cmd label={`FIRE C${Math.min(check.currentCourse + 1, 9)}`} kind="fire"
          disabled={maxCourse <= check.currentCourse} onClick={() => fire(check.currentCourse + 1)} />
        <Cmd label="HOLD" disabled={!selLine} onClick={holdSel} />
        <Cmd label="VOID" disabled={!selLine} onClick={voidSel} />
        <Cmd label={`PAY ${usd(check.totalCents)}`} kind="pay"
          disabled={check.items.some((i) => i.state === "held")} onClick={() => setTender(true)} />
      </div>

      {sheet && me && (
        <ItemSheet
          item={sheet}
          guests={check.guestCount}
          defaultCourse={Math.min(tablesideCourse, 4)}
          addOns={addOnsFor(sheet)}
          role={me.role}
          onClose={() => setSheet(null)}
          onAdd={(sel) => { setSheet(null); addLine(sheet, sel); }}
          onCreateAddOn={(name, cents, permanent) => createAddOn(sheet, name, cents, permanent)}
          onDeleteAddOn={deleteAddOn}
        />
      )}
      {customDialog && (
        <CustomDialog kind={customDialog} onClose={() => setCustomDialog(null)}
          onCreate={async (payload) => {
            try {
              await api("/api/pos/menu/custom", { json: payload });
              setCustomDialog(null);
              await loadMenu();
              flash(`"${payload.name}" added to Custom — decays at shift close`);
            } catch (e) { flash(e instanceof Error ? e.message : "failed"); }
          }} />
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
      {confirmOut && (
        <Overlay onClose={() => setConfirmOut(false)}>
          <h2 className="text-lg font-semibold text-ink-50 mb-2">Log out?</h2>
          <p className="text-sm text-ink-400 mb-5">The next server signs in with their PIN. This device stays signed in to the restaurant.</p>
          <div className="flex items-center gap-2 justify-end">
            <button onClick={signOutDevice} className="mr-auto text-xs text-ink-400 hover:text-ink-50 underline">Sign device out of restaurant</button>
            <button onClick={() => setConfirmOut(false)} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
            <button onClick={logout} className="px-4 py-2 rounded-xl font-medium bg-state-seatedBg text-state-seated">Log out</button>
          </div>
        </Overlay>
      )}
      {pinTarget && (
        <ManagerPinModal
          title={`Delete “${pinTarget.name}”`}
          subtitle="Manager PIN required"
          onClose={() => setPinTarget(null)}
          onSubmit={async (pin) => {
            const ok = await doDeleteAddOn(pinTarget, pin);
            if (ok) setPinTarget(null);
            return ok;
          }}
        />
      )}
      {toast && <Toast msg={toast} />}
    </main>
  );
}

// ── Manager PIN modal (replaces browser prompt) ─────────────────────
function ManagerPinModal({ title, subtitle, onClose, onSubmit }: {
  title: string; subtitle: string; onClose: () => void;
  onSubmit: (pin: string) => Promise<boolean>;
}) {
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(false);
  const press = async (d: string) => {
    if (d === "⌫") return setPin((p) => p.slice(0, -1));
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      const ok = await onSubmit(next);
      if (!ok) {
        setShake(true);
        setTimeout(() => { setPin(""); setShake(false); }, 450);
      }
    }
  };
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-[280px] rounded-2xl bg-panel-card border border-border-hi p-5 text-center">
        <h2 className="text-[15px] font-semibold text-ink-50">{title}</h2>
        <p className="text-xs text-ink-400 mt-0.5 mb-4">{subtitle}</p>
        <div className={`flex justify-center gap-3 mb-5 ${shake ? "animate-pulse" : ""}`}
          style={shake ? { filter: "drop-shadow(0 0 6px rgba(236,126,126,.6))" } : {}}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-3 w-3 rounded-full border ${i < pin.length ? "bg-ai border-ai" : "border-border-hi"}`} />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d, i) =>
            d === "" ? <span key={i} /> : (
              <button key={i} onClick={() => press(d)}
                className="h-12 rounded-xl bg-panel border border-border text-lg text-ink-50 hover:border-border-hi active:bg-panel-up">
                {d}
              </button>
            )
          )}
        </div>
        <button onClick={onClose} className="mt-4 text-sm text-ink-400 hover:text-ink-50">Cancel</button>
      </div>
    </div>
  );
}

// ── ItemSheet: the interim menu on every item add ───────────────────
type SheetResult = {
  seat: number | null; course: number; qty: number;
  modifierIds: string[]; addOnIds: string[]; note: string;
};

function ItemSheet({ item, guests, defaultCourse, addOns, role, onClose, onAdd, onCreateAddOn, onDeleteAddOn }: {
  item: Item; guests: number; defaultCourse: number; addOns: AddOn[]; role: string;
  onClose: () => void; onAdd: (sel: SheetResult) => void;
  onCreateAddOn: (name: string, priceCents: number, permanent: boolean) => Promise<void> | void;
  onDeleteAddOn: (a: AddOn) => void;
}) {
  const [seat, setSeat] = useState<number | null>(null);
  const [course, setCourse] = useState(defaultCourse);
  const [qty, setQty] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedAddOns, setPickedAddOns] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newPermanent, setNewPermanent] = useState(false);

  const toggleMod = (g: ModGroup, m: Mod) => {
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
  const toggleAddOn = (a: AddOn) => {
    const next = new Set(pickedAddOns);
    if (next.has(a.id)) next.delete(a.id); else next.add(a.id);
    setPickedAddOns(next);
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

      {/* Seat */}
      <div className="mt-3">
        <div className="text-sm text-ink-400 mb-2">Seat</div>
        <div className="flex flex-wrap gap-2">
          <Chip on={seat === null} onClick={() => setSeat(null)} label="Whole table" />
          {Array.from({ length: guests }, (_, i) => (
            <Chip key={i} on={seat === i + 1} onClick={() => setSeat(i + 1)} label={`Seat ${i + 1}`} />
          ))}
        </div>
      </div>

      {/* Course (tableside memory sets the default) */}
      <div className="mt-4">
        <div className="text-sm text-ink-400 mb-2">Course <span className="text-xs">(auto: C{defaultCourse})</span></div>
        <div className="flex gap-2">
          {[1, 2, 3, 4].map((n) => (
            <Chip key={n} on={course === n} onClick={() => setCourse(n)} label={`C${n}`} />
          ))}
        </div>
      </div>

      {/* Modifier groups */}
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
              <button key={m.id} onClick={() => toggleMod(g, m)}
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

      {/* Add-ons */}
      <div className="mt-4">
        <div className="text-sm text-ink-400 mb-2">Add-ons <span className="text-xs">+</span></div>
        <div className="max-h-40 overflow-y-auto flex flex-wrap gap-2 pr-1">
          {addOns.map((a) => (
            <span key={a.id} className="inline-flex items-center">
              <button onClick={() => toggleAddOn(a)}
                className={`pl-3 pr-2 py-1.5 rounded-l-full text-sm border border-r-0 ${
                  pickedAddOns.has(a.id)
                    ? a.ephemeral ? "text-state-reserved" : "bg-ai-bg text-ai"
                    : "bg-panel text-ink-200 hover:border-border-hi"
                }`}
                style={{
                  borderColor: a.ephemeral ? "rgba(168,150,224,.5)" : pickedAddOns.has(a.id) ? "rgba(129,140,248,.4)" : "var(--color-border)",
                  background: pickedAddOns.has(a.id) && a.ephemeral ? "var(--color-state-reservedBg)" : undefined,
                }}>
                {a.name}{a.priceCents ? ` +${usd(a.priceCents)}` : ""}
                {a.ephemeral && <span className="ml-1 text-[10px] opacity-70">shift</span>}
              </button>
              <button onClick={() => onDeleteAddOn(a)}
                className="pr-2.5 pl-1 py-1.5 rounded-r-full text-sm border border-l-0 text-ink-400 hover:text-state-seated"
                style={{ borderColor: a.ephemeral ? "rgba(168,150,224,.5)" : "var(--color-border)", background: "var(--color-panel)" }}
                title="Delete (manager)">
                ×
              </button>
            </span>
          ))}
          {!creating ? (
            <button onClick={() => setCreating(true)}
              className="px-3 py-1.5 rounded-full text-sm border border-dashed border-border-hi text-ink-400 hover:text-ink-50">
              + Create add-on
            </button>
          ) : (
            <div className="w-full flex flex-wrap items-center gap-2 mt-1">
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="apricot preserves…" className="flex-1 min-w-[140px] rounded-xl bg-panel border border-border px-3 py-1.5 text-sm text-ink-50" />
              <input value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="+$"
                inputMode="decimal" className="w-16 rounded-xl bg-panel border border-border px-2 py-1.5 text-sm text-ink-50" />
              {role === "manager" && (
                <label className="text-xs text-ink-400 flex items-center gap-1">
                  <input type="checkbox" checked={newPermanent} onChange={(e) => setNewPermanent(e.target.checked)} />
                  permanent
                </label>
              )}
              <button
                disabled={!newName.trim()}
                onClick={async () => {
                  await onCreateAddOn(newName.trim(), Math.round((parseFloat(newPrice) || 0) * 100), newPermanent);
                  setCreating(false); setNewName(""); setNewPrice(""); setNewPermanent(false);
                }}
                className={`px-3 py-1.5 rounded-xl text-sm font-medium ${newName.trim() ? "bg-ai text-bg" : "bg-panel text-ink-400"}`}>
                Save
              </button>
            </div>
          )}
        </div>
        <p className="text-[11px] text-ink-400 mt-1.5">
          Purple “shift” tags were created by servers and disappear at shift close — managers can make them permanent or delete them.
        </p>
      </div>

      {/* Note to kitchen */}
      <div className="mt-4">
        <div className="text-sm text-ink-400 mb-2">Note to kitchen/bar</div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} rows={2}
          placeholder="gluten free for seat 2 · sauce on the side…"
          className="w-full rounded-xl bg-panel border border-border px-3 py-2 text-sm text-ink-50 resize-none" />
      </div>

      <div className="flex items-center justify-between mt-5">
        <span className="inline-flex items-center rounded-lg bg-panel border border-border">
          <button className="px-3 py-1 text-ink-400" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
          <span className="px-1 text-ink-50 min-w-[1.5rem] text-center">{qty}</span>
          <button className="px-3 py-1 text-ink-400" onClick={() => setQty(Math.min(20, qty + 1))}>+</button>
        </span>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
          <button disabled={!satisfied}
            onClick={() => onAdd({ seat, course, qty, modifierIds: [...picked], addOnIds: [...pickedAddOns], note: note.trim() })}
            className={`px-4 py-2 rounded-xl font-medium ${satisfied ? "bg-ai text-bg" : "bg-panel text-ink-400"}`}>
            Add to check
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Custom dish/drink creation ──────────────────────────────────────
function CustomDialog({ kind, onClose, onCreate }: {
  kind: "dish" | "drink"; onClose: () => void;
  onCreate: (p: { kind: "dish" | "drink"; name: string; description: string; priceCents: number }) => void;
}) {
  const special = kind === "dish" ? "Chef Special" : "Bartender Special";
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [price, setPrice] = useState("");
  const priceCents = Math.round((parseFloat(price) || 0) * 100);
  const ok = name.trim().length > 0 && priceCents > 0;
  return (
    <Overlay onClose={onClose}>
      <h2 className="text-lg font-semibold text-ink-50 mb-1">Add custom {kind}</h2>
      <p className="text-sm text-ink-400 mb-4">
        Appears on every terminal’s Custom tab, routes to the {kind === "dish" ? "kitchen" : "bar"}, decays at shift close.
      </p>
      <div className="flex gap-2 mb-3">
        <Chip on={name === special} onClick={() => setName(special)} label={special} />
        <input value={name === special ? "" : name} onChange={(e) => setName(e.target.value)}
          placeholder="or type a name…" className="flex-1 rounded-xl bg-panel border border-border px-3 py-1.5 text-sm text-ink-50" />
      </div>
      <input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200}
        placeholder="optional short description (elk ragu over pappardelle…)"
        className="w-full rounded-xl bg-panel border border-border px-3 py-2 text-sm text-ink-50 mb-3" />
      <div className="flex items-center gap-2 mb-5">
        <span className="text-sm text-ink-400">Price $</span>
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.00"
          className="w-24 rounded-xl bg-panel border border-border px-3 py-1.5 text-sm text-ink-50" />
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-4 py-2 rounded-xl text-ink-400 hover:bg-panel-up">Cancel</button>
        <button disabled={!ok}
          onClick={() => onCreate({ kind, name: name.trim(), description: desc.trim(), priceCents })}
          className={`px-4 py-2 rounded-xl font-medium ${ok ? "bg-ai text-bg" : "bg-panel text-ink-400"}`}>
          Add to Custom tab
        </button>
      </div>
    </Overlay>
  );
}

// ── shared pieces ───────────────────────────────────────────────────
function Chip({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm border ${on ? "bg-ai-bg text-ai font-medium" : "bg-panel border-border text-ink-200 hover:border-border-hi"}`}
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
  const [guests, setGuests] = useState(table.partySize ?? 2);
  return (
    <Overlay onClose={onClose}>
      <h2 className="text-lg font-semibold text-ink-50 mb-1">
        Seat <span style={{ color }}>Table {table.label}</span>
      </h2>
      <p className="text-sm text-ink-400 mb-4">Opens a check and marks the table sat.</p>
      <div className="grid grid-cols-4 gap-2 mb-5">
        {[1,2,3,4,5,6,7,8].map((n) => (
          <button key={n} onClick={() => setGuests(n)}
            className={`h-12 rounded-xl border text-[15px] ${guests === n ? "bg-ai-bg text-ai font-bold" : "bg-panel text-ink-200 border-border"}`}
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

function TenderDialog({ check, tipPresets, onClose, onDone, flash }: {
  check: CheckFull; tipPresets: number[]; onClose: () => void;
  onDone: (fresh: CheckFull, changeCents: number) => void; flash: (m: string) => void;
}) {
  const [tipCents, setTipCents] = useState(0);
  const [customTip, setCustomTip] = useState(""); // dollars, any amount
  const [tendered, setTendered] = useState("");
  // Display-only preview — the SERVER recomputes and validates everything.
  const duePreview = check.balanceDueCents + tipCents;
  const tenderedCents = Math.round((parseFloat(tendered) || 0) * 100);
  const heldCount = check.items.filter((i) => i.state === "held").length;

  const useCustomTip = (v: string) => {
    setCustomTip(v);
    const cents = Math.round((parseFloat(v) || 0) * 100);
    setTipCents(Math.max(0, cents));
  };
  const usePreset = (cents: number) => { setCustomTip(""); setTipCents(cents); };

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
      <div className="flex gap-2 mb-2 flex-wrap items-center">
        {tipPresets.map((p) => {
          const cents = Math.round((check.subtotalCents * p) / 100);
          return (
            <button key={p} onClick={() => usePreset(cents)}
              className={`px-3 py-1.5 rounded-full text-sm border ${tipCents === cents && !customTip ? "bg-ai-bg text-ai" : "bg-panel border-border text-ink-200"}`}>
              {p}% · {usd(cents)}
            </button>
          );
        })}
        <button onClick={() => usePreset(0)}
          className={`px-3 py-1.5 rounded-full text-sm border ${tipCents === 0 && !customTip ? "bg-ai-bg text-ai" : "bg-panel border-border text-ink-200"}`}>
          No tip
        </button>
        <span className="inline-flex items-center gap-1 text-sm text-ink-400">
          <span>Custom $</span>
          <input value={customTip} onChange={(e) => useCustomTip(e.target.value)} inputMode="decimal" placeholder="0.00"
            className={`w-20 rounded-xl bg-panel border px-2 py-1.5 text-sm text-ink-50 ${customTip ? "border-ai" : "border-border"}`} />
        </span>
      </div>

      <div className="text-sm text-ink-400 mb-1 mt-3">Cash tendered</div>
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
