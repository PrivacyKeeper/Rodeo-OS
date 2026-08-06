# RodeoApps.pro OS

The operating system for producing a rodeo. Entries, draw, scoring, results,
payouts, waivers and settlement — for the producer, the secretary, the judge,
the timer operator, the stock contractor and the contestant, on one platform.

Built from *RodeoApps.pro OS — Complete Technical Architecture v1.0*
(17 June 2026). Where this repository departs from that document it does so on
purpose, and every departure is written down in
[`docs/SPEC-DELTAS.md`](docs/SPEC-DELTAS.md) with the reason. **Read that file
before assuming the code is wrong.** Twenty-six defects are recorded; several
of them lose money or leak data.

Rules were last reviewed against published sources on **8 August 2026** —
what is sourced, what is not, and where each value came from is in
[`docs/RULES.md`](docs/RULES.md).

The product model — Procore for construction, Toast for restaurants, applied
to rodeo — and what it demanded of the schema is in
[`docs/MODEL.md`](docs/MODEL.md).

---

## What is here

```
supabase/migrations/     Full schema: 29 tables, RLS, immutability triggers,
                         287 seeded options, scoring/payout/division templates
supabase/tests/          Schema invariants, run in CI
packages/engine/         Scoring and payout engines. Zero dependencies,
                         no I/O, 104 tests
apps/api/                Fastify API: auth, RLS-bound persistence, typed event
                         bus, offline sync, scoring, payouts, options, public
docs/                    The model, architecture deltas, rule provenance,
                         security, roadmap
```

### The engine is the important part

`packages/engine` is where a bug costs somebody real money, so it is isolated:
pure functions over configuration data, no database, no network, no clock, no
randomness. That makes it exhaustively testable, and it means the same code
runs on the server, in the secretary's browser, and offline in an arena with no
signal.

Two properties it holds:

- **Every rule is data.** Increments, variance caps, judge counts, penalty
  tables, payout ladders, ground-money behaviour, handicap division caps — all
  loaded from `scoring_configs`, `payout_configs` and `division_templates`. A
  sanctioning body changing a rule mid-season is a new config row, never a
  deploy. PBR moving to tenth-point marking for 2026 was a data change.
- **Every option is data too.** 48 event types, 34 arena roles, 25 fee types,
  24 sanctioning bodies and eleven more domains live in `reference_options`,
  and a producer adds their own without a migration. A ranch rodeo running
  wild cow milking, or a playday running a keyhole race, does not need us.
- **Money reconciles exactly.** All amounts are integer cents and every split
  is a largest-remainder allocation over the whole pool. The sum of the payout
  lines equals the net purse, to the cent, always. The API refuses to serve a
  calculation that does not balance.

```
$ cd packages/engine && node --test "test/*.test.ts"
# tests 104
# pass 104
# fail 0

$ cd apps/api && TEST_DATABASE_URL=... node --test "test/*.test.ts"
# tests 32
# pass 32
# fail 0
```

No `npm install` needed to run them — that is deliberate.

---

## Stack

| Layer | Choice |
|---|---|
| API | Fastify 5.11 on Node 24 LTS, TypeScript 6 strict |
| Database | PostgreSQL 16 on Supabase, row-level security |
| Auth | Supabase Auth (JWT), roles via `org_members` |
| Payments | Stripe Connect |
| Data access | postgres.js, RLS-bound per request (see delta D25) |
| Realtime | WebSockets for arena terminals, SSE for spectators |
| Offline | PWA + IndexedDB, authority-based sync reconciliation |
| Hosting | Vercel (web), Fly.io (API), Supabase (data) |

Per Appendix A of the architecture. The one substantive change is how tenant
isolation is enforced — see delta D1.

---

## Running it

```bash
git clone https://github.com/PrivacyKeeper/Rodeo-OS
cd Rodeo-OS
cp .env.example .env      # fill in Supabase and Stripe keys

# engines — no install required
cd packages/engine && node --test "test/*.test.ts"

# schema
supabase db push          # or: psql -f supabase/migrations/*.sql in order

# local Postgres instead of Supabase? add the auth primitives first
psql -f supabase/local/bootstrap.sql
for f in supabase/migrations/*.sql; do psql -f "$f"; done
psql -f supabase/local/bootstrap.sql   # again, for grants on new tables

# API
npm install
npm run dev --workspace @rodeo-os/api

# integration tests against a real database with RLS on
cd apps/api
TEST_DATABASE_URL=postgres://... node --test "test/*.test.ts"
```

Requires Node 24 LTS (Active LTS until 20 October 2026). Native TypeScript
type stripping means the engine runs without a build step.

---

## Multi-tenancy in one paragraph

Every tenant-scoped table carries `org_id`. RLS policies derive the caller's
tenant from `auth.uid()` — signed into the JWT by Supabase Auth and not
settable by a client — joined through `org_members`. Child tables declare
*composite* foreign keys on `(org_id, parent_id)` so a row in one tenant
physically cannot reference a row in another. The financial ledger and signed
waivers are append-only, enforced by triggers rather than policies, because
triggers bind the service role too. Full reasoning in
[`docs/SECURITY.md`](docs/SECURITY.md).

---

## Status

| Area | State |
|---|---|
| Database schema | Complete — 29 tables, RLS, triggers, 287 seeded options |
| Options layer | Complete — every dropdown is producer-extensible data |
| Sidepots, templates, modules | Schema complete |
| Scoring engine | Complete and tested — judged, timed, ranking, aggregate, D-format, handicap divisions |
| Payout engine | Complete and tested — fees, ties, ground money, multi-round, IPRA, day money, stock contractor, PESI, withholding |
| API contracts | Routes, validation schemas, auth, event bus, sync resolution |
| API persistence | Complete — repositories, RLS-bound connections, 32 integration tests |
| Stripe Connect | Not started — ledger rows are written `pending` |
| Web app (PWA) | Not started |
| Timer Bridge | Not started |

Every request opens a transaction carrying the caller's verified JWT claims and
`set local role authenticated`, so RLS — not application code — decides what
each request can see. The integration suite proves it by running **as real
users**: a superuser bypasses RLS, so a test that passes as `postgres` proves
nothing about whether one producer can read another's entries.

Build order and what comes next: [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Relationship to the discipline apps

RodeoApps.pro OS is the platform. The discipline apps —
[barrelconnect.pro](https://barrelconnect.pro),
[bullrider.pro](https://bullrider.pro),
[breakawayroping.pro](https://breakawayroping.pro),
[teamrope.pro](https://teamrope.pro),
[tiedown.pro](https://tiedown.pro),
[saddlebronc.pro](https://saddlebronc.pro),
[barebackbronc.pro](https://barebackbronc.pro),
[bulldogging.pro](https://bulldogging.pro),
[ranchrodeo.pro](https://ranchrodeo.pro) — are vertical extensions on top of it
(§3.2, §3.3.3). They deploy separately and share the database, reading the
rodeos, entries and scores for their own event type through the same RLS
policies. A contestant's profile, memberships and winnings exist once, across
all of them.
