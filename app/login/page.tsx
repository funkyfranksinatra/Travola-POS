"use client";
// /login — server PIN pad. Seeded pilot PINs: 1111 (Priya) · 0000 (Darko).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/ui";

export default function Login() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(false);

  const press = async (d: string) => {
    if (d === "⌫") return setPin((p) => p.slice(0, -1));
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      try {
        await api("/api/pos/auth", { json: { pin: next } });
        router.push("/pos");
      } catch {
        setShake(true);
        setTimeout(() => { setPin(""); setShake(false); }, 450);
      }
    }
  };

  return (
    <main className="flex-1 flex items-center justify-center min-h-screen">
      <div className="w-[300px] text-center">
        <div className="h-11 w-11 mx-auto rounded-xl bg-ai-bg flex items-center justify-center mb-3">
          <span className="text-ai font-semibold text-xl">T</span>
        </div>
        <h1 className="text-lg font-semibold text-ink-50">Travola POS</h1>
        <p className="text-sm text-ink-400 mb-6">Enter your server PIN</p>
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
          {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d, i) =>
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
        {/* TEMPORARY dev escape hatch — remove before go-live. Lets the
            dev reach the launcher (menu builder, KDS links) without a PIN. */}
        <button
          onClick={() => router.push("/")}
          className="mt-8 text-xs text-ink-400 hover:text-ink-50 border border-dashed border-border rounded-lg px-3 py-1.5"
        >
          dev
        </button>
      </div>
    </main>
  );
}
