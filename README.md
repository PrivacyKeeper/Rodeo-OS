# RodeoApps.pro OS

The operating system for producing a rodeo. Entries, draw, scoring, results,
payouts, waivers and settlement — for the producer, the secretary, the judge,
the timer operator, the stock contractor and the contestant, on one platform.

Built from *RodeoApps.pro OS — Complete Technical Architecture v1.0*
(17 June 2026). Where this repository departs from that document it does so on
purpose, and every departure is written down in
[`docs/SPEC-DELTAS.md`](docs/SPEC-DELTAS.md) with the reason. **Read that file
before assuming the code is wrong.** Twenty defects were found in v1.0; several
of them lose money or leak data.

---

## What is here

```
supabase/migrations/     Full schema: 22 tables, RLS, immutability triggers,
                         system scoring and payout templates
packages/engine/         Scoring and payout engines. Zero dependencies,
                         no I/O, 80 tests
apps/api/                Fastify API: auth, typed event bus, offline sync,
                         scoring, payouts, public results
docs/                    Architecture deltas, security model, roadmap
```

### The engine is the important part

`packages/engine` is where a bug costs somebody real money, so it is isolated:
pure functions over configuration data, no database, no network, no clock, no
randomness. That makes it exhaustively testable, and it means the same code
runs on the server, in the secretary's browser, and offline in an arena with no
signal.

Two properties it holds:

- **Every rule is data.** Increments, variance caps, penalty tables, payout
  ladders, ground-money behaviour, division splits — all loaded from
  `scoring_configs` and `payout_configs`. A sanctioning body changing a rule
  mid-season is a new config row, never a deploy.
- **Money reconciles exactly.** All amounts are integer cents and every split
  is a largest-remainder allocation over the whole pool. The sum of the payout
  lines equals the net purse, to the cent, always. The API refuses to serve a
  calculation that does not balance.

```
$ cd packages/engine && node --test "test/*.test.ts"
# tests 80
# pass 80
# fail 0
```

No `npm install` needed to run them — that is deliberate.

---

## Stack

| Layer | Choice |
|---|---|
| API | Fastify 5 on Node 22 LTS, TypeScript strict |
| Database | PostgreSQL on Supabase, row-level security |
| Auth | Supabase Auth (JWT), roles via `org_members` |
| Payments | Stripe Connect |
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

# API
npm install
npm run dev --workspace @rodeo-os/api
```

Requires Node 22.18 or later (native TypeScript type stripping).

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
| Database schema | Complete — 22 tables, RLS, triggers, seed configs |
| Scoring engine | Complete and tested — judged, timed, ranking, aggregate, D-format |
| Payout engine | Complete and tested — fees, ties, ground money, multi-round, IPRA, day money, stock contractor, PESI, withholding |
| API contracts | Routes, validation schemas, auth, event bus, sync resolution |
| API persistence | **Not implemented.** Storage functions throw; see below |
| Web app (PWA) | Not started |
| Timer Bridge | Not started |

The API modules define their storage needs as explicit named functions that
currently throw `not implemented: wire to core/database`. That is the seam
where Drizzle goes. It is marked rather than faked so nothing looks finished
that is not.

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
