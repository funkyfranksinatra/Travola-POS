# Travola POS

Point-of-sale for restaurants, built on the Travola platform stack:
order terminal, kitchen display screens, menu management, and
server-authoritative check math. Runs on the same database as
[Travola](https://gettravola.com) floor management — live floor state,
PIN logins, and the Shift Intelligence layer are shared, one unified
system.

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
cp .env.example .env       # DATABASE_URL = the SHARED Travola Neon DB
                           # POS_RESTAURANT_ID = the Restaurant.id to serve
npm install
npx prisma generate        # client only — NEVER migrate/db push from here
node --experimental-strip-types prisma/seed.ts   # demo menu (optional)
npm run dev
```

**Shared database:** the POS and Travola-OS point at the same Postgres
database. The Travola-OS repo owns every migration; this repo only runs
`prisma generate`. Staff (PIN logins) and the floorplan live in the
floor app's tables. The two apps talk through the append-only
`ServiceEvent` bus and enrich the same `TableSession` analytics rows.

## Signing in

Two layers, matching how a restaurant actually opens up:

1. **Restaurant** — a device signs in once with the restaurant name and
   the **same 4-digit passcode the manager set in Travola-OS**. Same
   credential, same scrypt verification, same signed-cookie scheme as
   the floor app's `/api/auth/login`. The session cookie
   (`travola_pos_session`) scopes every query in every request; there is
   no build-time tenant constant. The POS has no register endpoint —
   restaurants and passcodes are created and changed on the floor app.
2. **Staff PIN** — whoever is holding the terminal taps a 4-digit PIN
   from the floor app's roster (`Server.pin`), so checks, tips, and
   section rules attach to a person. The restaurant passcode also works
   here and grants manager access — which is how a brand-new restaurant
   gets in on day one, before any server PINs have been handed out.

Signing a person out returns to the PIN pad; "Sign device out of
restaurant" clears the venue session too.

`npm test` runs the check-math unit suite.
