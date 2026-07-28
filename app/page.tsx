// Launcher — where a device picks its role (server terminal, KDS, menu).
import Link from "next/link";
import { prisma, RESTAURANT_ID } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function Home() {
  const stations = await prisma.station.findMany({
    where: { restaurantId: RESTAURANT_ID },
    orderBy: { key: "asc" },
  });
  return (
    <main className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3 mb-8">
          <div className="h-10 w-10 rounded-xl bg-ai-bg flex items-center justify-center">
            <span className="text-ai font-semibold text-lg">T</span>
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-ink-50">Travola POS</h1>
            <p className="text-sm text-ink-400">Pick this device&apos;s role</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Link
            href="/pos"
            className="rounded-2xl bg-panel-card border border-border hover:border-border-hi p-6 block"
          >
            <div className="text-ink-50 font-medium text-lg">Order terminal</div>
            <p className="text-sm text-ink-400 mt-1">
              Open checks, take orders, send to kitchen, close out.
            </p>
          </Link>
          <Link
            href="/menu"
            className="rounded-2xl bg-panel-card border border-border hover:border-border-hi p-6 block"
          >
            <div className="text-ink-50 font-medium text-lg">Menu builder</div>
            <p className="text-sm text-ink-400 mt-1">
              Categories, items, prices, modifiers, stations, 86 board.
            </p>
          </Link>
          {stations.map((s) => (
            <Link
              key={s.id}
              href={`/kds/${s.key}`}
              className="rounded-2xl bg-panel-card border border-border hover:border-border-hi p-6 block"
            >
              <div className="text-ink-50 font-medium text-lg">
                KDS — {s.name}
              </div>
              <p className="text-sm text-ink-400 mt-1">
                Full-screen ticket display for the {s.name.toLowerCase()} station.
              </p>
            </Link>
          ))}
          {stations.length === 0 && (
            <div className="rounded-2xl bg-panel border border-border p-6">
              <div className="text-ink-200 font-medium">No stations yet</div>
              <p className="text-sm text-ink-400 mt-1">
                Add kitchen/bar stations in the menu builder to get KDS screens.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
