"use client";
// /login — two steps, in the order a restaurant actually opens up:
//
//   1. RESTAURANT — name + the same 4-digit passcode the manager set in
//      Travola-OS. Done once per device; the signed session persists.
//   2. STAFF PIN  — who is holding this terminal right now. A staff PIN
//      from the floor app's roster, or the restaurant passcode for
//      manager access (which is how a brand-new restaurant gets in
//      before any server PINs exist).
//
// Step 1's form is intentionally the floor app's login, field for field,
// so a manager who has signed into Travola already knows this screen.
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/ui";

type Restaurant = { id: string; name: string };

export default function Login() {
  const router = useRouter();
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [checking, setChecking] = useState(true);

  // Step 1 state
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Step 2 state
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(false);

  // Already signed in to a restaurant on this device? Skip to the PIN pad.
  useEffect(() => {
    api<{ restaurant: Restaurant }>("/api/pos/restaurant")
      .then((r) => setRestaurant(r.restaurant))
      .catch(() => setRestaurant(null))
      .finally(() => setChecking(false));
  }, []);

  async function signInRestaurant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await api<{ restaurant: Restaurant }>("/api/pos/restaurant", {
        json: { name, passcode },
      });
      setRestaurant(r.restaurant);
      setPasscode("");
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setError(
        message === "too_many_attempts"
          ? "TRY AGAIN IN ONE MINUTE"
          : "NAME OR PASSCODE NOT RECOGNIZED"
      );
    } finally {
      setBusy(false);
    }
  }

  const press = useCallback(
    async (d: string) => {
      if (d === "⌫") return setPin((p) => p.slice(0, -1));
      const next = (pin + d).slice(0, 4);
      setPin(next);
      if (next.length === 4) {
        try {
          await api("/api/pos/auth", { json: { pin: next } });
          router.push("/pos");
        } catch {
          setShake(true);
          setTimeout(() => {
            setPin("");
            setShake(false);
          }, 450);
        }
      }
    },
    [pin, router]
  );

  const switchRestaurant = async () => {
    await api("/api/pos/restaurant", { method: "DELETE" }).catch(() => {});
    setRestaurant(null);
    setPin("");
    setName("");
    setPasscode("");
  };

  if (checking) return <main className="flex-1 min-h-screen" />;

  // ── Step 1: restaurant ──────────────────────────────────────────────
  if (!restaurant) {
    return (
      <main className="flex-1 flex items-center justify-center min-h-screen p-5">
        <section className="w-full max-w-sm rounded-2xl border border-border bg-panel p-7">
          <div className="mb-8 flex items-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-ai-bg flex items-center justify-center">
              <span className="text-ai font-semibold text-xl">T</span>
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-[0.24em] text-ink-50">TRAVOLA POS</h1>
              <p className="mt-1 text-[10px] tracking-[0.16em] text-ink-400">RESTAURANT SIGN-IN</p>
            </div>
          </div>
          <form onSubmit={signInRestaurant} className="space-y-4">
            <label className="block text-[10px] tracking-[0.12em] text-ink-400">
              RESTAURANT NAME
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="organization"
                className="mt-2 w-full rounded-md border border-border bg-panel-card px-3 py-3 text-sm text-ink-50 outline-none focus:border-ai"
              />
            </label>
            <label className="block text-[10px] tracking-[0.12em] text-ink-400">
              4-DIGIT PASSCODE
              <input
                value={passcode}
                onChange={(e) => setPasscode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                required
                inputMode="numeric"
                autoComplete="current-password"
                type="password"
                className="mt-2 w-full rounded-md border border-border bg-panel-card px-3 py-3 text-sm tracking-[0.35em] text-ink-50 outline-none focus:border-ai"
              />
            </label>
            {error && <p className="text-[10px] tracking-[0.08em] text-rose-300">{error}</p>}
            <button
              disabled={busy}
              className="w-full rounded-md bg-ai py-3 text-xs font-bold tracking-[0.14em] text-bg disabled:opacity-50"
            >
              {busy ? "WORKING…" : "SIGN IN"}
            </button>
          </form>
          <p className="mt-6 text-[10px] leading-relaxed tracking-[0.08em] text-ink-400">
            Use the same restaurant name and passcode as your Travola floor
            manager. New restaurants are created there.
          </p>
        </section>
      </main>
    );
  }

  // ── Step 2: staff PIN ───────────────────────────────────────────────
  return (
    <main className="flex-1 flex items-center justify-center min-h-screen">
      <div className="w-[300px] text-center">
        <div className="h-11 w-11 mx-auto rounded-xl bg-ai-bg flex items-center justify-center mb-3">
          <span className="text-ai font-semibold text-xl">T</span>
        </div>
        <h1 className="text-lg font-semibold text-ink-50">{restaurant.name}</h1>
        <p className="text-sm text-ink-400 mb-6">Enter your PIN</p>
        <div
          className={`flex justify-center gap-3 mb-7 ${shake ? "animate-pulse" : ""}`}
          style={shake ? { filter: "drop-shadow(0 0 6px rgba(236,126,126,.6))" } : {}}
        >
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-3.5 w-3.5 rounded-full border ${
                i < pin.length ? "bg-ai border-ai" : "border-border-hi"
              }`}
            />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((d, i) =>
            d === "" ? (
              <span key={i} />
            ) : (
              <button
                key={i}
                onClick={() => press(d)}
                className="h-16 rounded-2xl bg-panel-card border border-border text-xl text-ink-50 hover:border-border-hi active:bg-panel-up"
              >
                {d}
              </button>
            )
          )}
        </div>
        <button
          onClick={switchRestaurant}
          className="mt-8 text-xs text-ink-400 hover:text-ink-50"
        >
          Not {restaurant.name}? Switch restaurant
        </button>
      </div>
    </main>
  );
}
