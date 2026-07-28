# Travola POS

Point-of-sale for restaurants, built on the Travola platform stack:
order terminal, kitchen display screens, menu management, and
server-authoritative check math. Standalone today; integrates with
[Travola](https://gettravola.com) floor management + Shift Intelligence
as one unified system.

## Screens

- `/` — device launcher (pick this device's role)
- `/pos` — order terminal: open checks, category rail + item grid,
  modifier sheets, seats & courses, SEND to stations, cash/comp tender
  with tip presets and change math
- `/kds/[stationKey]` — full-screen kitchen display per station:
  age-colored tickets (amber 8m, red 12m), BUMP, ALL DAY rollup
- `/menu` — menu builder: categories, items, prices, stations,
  86 toggle, modifier groups, tax rate

## Architecture

- **Server-authoritative state machines.** A check is `open → closed |
  voided`; each line is `held → fired → bumped` (or `voided`). Clients
  send commands; the server validates every transition.
- **All money math in one file** — `lib/check-math.ts`, integer cents,
  unit-tested (`npm test`). Clients render totals; they never compute.
- **Snapshots, not joins.** Ordered items freeze name/price/modifiers
  at order time; menu edits never rewrite history.
- **Tenant-scoped everything**, with a `partyKey` seam reserved for the
  Travola floor-app integration (checks attach to parties, not tables).

## Stack

Next.js (App Router) · React · Prisma 7 + Postgres (driver adapter) ·
Tailwind v4 · Zod. Stripe Connect + Terminal card-present lands in
Phase 2.

## Run

```bash
cp .env.example .env       # point DATABASE_URL at Postgres
npm install
npx prisma db push         # create tables
node --experimental-strip-types prisma/seed.ts   # demo menu (optional)
npm run dev
```

`npm test` runs the check-math unit suite.
