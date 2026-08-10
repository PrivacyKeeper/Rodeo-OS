# Build order

Follows Appendix C of the architecture, adjusted for what is already done.

---

## Done

**Schema.** 40 tables across 20 migrations, with RLS bound to `auth.uid()`,
composite tenant foreign keys, append-only triggers on the ledger and on signed
waivers, and system scoring and payout templates for PRCA, PBR, WPRA, NBHA,
IPRA and CPRA.

**Scoring engine.** Judged and timed modes, config-driven validation
(range, increment, judge count, score divisor, variance cap, mark-out, DQ
triggers), standard competition ranking with tie detection, multi-round
aggregation, D-format division assignment, and USTRC/WSTR handicap division
eligibility.

**Payout engine.** Fee deduction with destinations, payout ladder selection,
tie combine-and-split, ground money, cowboy rules, escrow, multi-round go-round
plus average, IPRA three-head 2:2:3, day money, stock contractor share, PESI
60/40, and cross-border withholding for CA, AU and BR. Cent-exact throughout.

**Options layer.** 287 seeded options across 16 domains, producer-extensible
and tenant-scoped, replacing the hardcoded CHECK constraints. Sidepots and
incentives, rodeo templates, and module entitlement per §3.2.

**API contracts.** Route definitions with JSON Schema validation, JWT auth and
the permission matrix, typed event bus, offline sync authority resolution,
options CRUD, public results and SSE.

---

## Done — entries, draw and settlement

The three things that stood between this and a rodeo running on it.

**Take an entry.** `quoteEntryFees()` itemises what a contestant owes — entry
fee, stock charge, office fee, late fee, sidepot buy-ins — with a destination
on every line, because the office fee and the purse go to different people.
Team roping collects both ends. `checkEntryEligibility()` reports every reason
somebody cannot enter at once rather than one at a time, and distinguishes a
contestant entering online from a secretary taking a day-of entry at the desk.
`classifyTurnout()` applies the 30-hour rule, excuses documented medical and
veterinary releases however late, and decides whether fees come back.

Routes: `GET .../entry-quote` (read-only, for the entry screen),
`POST .../entries` (entry, fees and sidepot buy-ins in one transaction, so
nobody is left entered-but-unpaid), `POST .../entries/:id/turnout`.

**Make a draw.** Seeded and reproducible: same seed, same draw, so "the draw
was witnessed" is a checkable claim rather than a promise. Fisher-Yates over a
mulberry32 PRNG — the naive `sort(() => rng() - 0.5)` shuffle is biased and
would hand out favourable positions unevenly. Entries are sorted before
shuffling so the draw cannot depend on the order rows came back from the
database. Balances across performances, overflows into slack, keeps buddy
groups together, and never draws one contestant twice in the same performance.
Stock draw excludes injured and retired animals and gives no animal two outs in
a round. Re-draw for turnouts and rerides cannot hand back an animal already
going.

Routes: `POST .../draw` (preview by default, `commit: true` to write and record
the seed in the audit log), `POST .../draw/stock`, `POST .../entries/:id/redraw`.

**Move money.** A state machine over the ledger, not a Stripe wrapper — a
platform that can only pay by card cannot run a jackpot. Cash, check, card,
ACH and account credit all move a row through the same states and leave the
same audit trail. Cash and check settle on the spot; card and ACH sit pending
until confirmed. A completed payment cannot be walked back to pending, only
refunded, and refunds are new rows rather than edits.

Routes: `POST .../payouts/settle`. Entry money is recorded by the entry route.

Still to wire:

1. Supabase Auth custom-access-token hook writing `user_id` and
   `org_memberships` into the JWT from `org_members`.
2. Stripe Connect: onboarding for producers and for contestants who receive
   payouts, plus the webhook that moves a pending row to completed.
3. A results writer — `results` is read by standings and payouts but nothing
   populates it from `scores` yet.

---

## Done — day sheets, the books, associations, the record and the interface

**Day sheets.** Run order by the draw, back numbers, drawn stock, the
contestant's own horse, partners, turnout and re-ride flags, and arena drags
counted over live runs rather than entered ones. Rendered as JSON for a screen
and as fixed-width text for the cheap printer in the arena office, because a
rodeo that loses its network still runs if somebody printed the sheet.

**Closing the books.** `checkBooks()` names every blocker and its fix, computes
the filing deadline as a wall clock in the association's own timezone (which is
two passes through the zone offset, not a fixed −0700), reconciles the purse to
the cent, and refuses to close on anything that is genuinely wrong while never
blocking on paperwork. Closing appends to `book_closures` — hashed, append-only,
reversible only by a further row with a reason on it — and writes every official
result into the contestants' global career records in the same transaction.

**Associations as data.** Ten seeded profiles carrying rules, event lists,
membership classes, required credentials, fee basis, standings formula and
filing deadline, each stamped with what it was sourced from and whether it has
been verified. A tenant can override any of them for their own use. Adding an
association is a row.

**The sanction layer.** Compliance requirements per association, instantiated
per rodeo with real dates; a credential registry for carded judges, secretaries
and timers with `personnel_shortfall()` reporting who is missing before the
rodeo rather than after; append-only livestock-welfare records; and conduct and
discipline records the subject can always read.

**The record layer.** A global animal registry, a global `career_runs` ledger
spanning organisations, and public views over both. Imported and self-reported
runs are first-class and clearly labelled, because being the place the record
LANDS does not require running every rodeo in the country.

**Secretary interface.** `apps/web` — setup in five questions, day sheet,
scoring, closing the books, and the sanctioning checklist. No bundler, no
dependencies, no build step.

---

## Done — the grounds, releases, notices and the year-end numbers

The four things a producer does that are not the rodeo. None of it is
competition, all of it is the business, and all of it was on a clipboard.

**The grounds.** Stalls, RV spots, camping, pens, arena time, vendor space and
clinic seats — bookable, priced by the producer per night or per stay, with
availability that counts bookings OVERLAPPING the requested dates rather than
bookings that happen to start on the first day. Stays are half-open date
ranges, so a stall is free the morning the last horse leaves. A single stall is
protected by a GiST exclusion constraint; a fifty-space field is counted under
an advisory lock, because an exclusion constraint can forbid but cannot count
(delta D44). Entry fees are the contestants' money passing through; this is the
producer's own income, and until now the books said nothing about it.

**Releases.** The document is shown on screen, in full, above the button — a
system that hashes text the signer was never shown has built an audit trail for
a fiction. Both hashes are computed by the database from the stored template,
never accepted from a client. Paper releases collected at the gate can be
recorded by the secretary holding them, permanently attributed to her.
`verify_signed_waiver()` recomputes the evidence and distinguishes a reissued
version from a document edited under a signature (deltas D42, D43).

**Notices.** An outbox, not a mailer. Rows are written in the same transaction
as the thing being announced, so the draw and "the draw is posted" either both
happen or neither does — a flaky arena hotspot cannot lose one without losing
the other. `notify_draw_posted()` is idempotent: run it after a re-draw and
nobody is told twice. Nothing here sends anything yet; a delivery worker is the
remaining piece.

**Year-end.** Everybody a producer paid in a calendar year, against the
threshold actually in force for that year and country — data, not a constant,
because the US figure moved to $2,000 for 2026 and is indexed from here on
(delta D45). Reports the gross where tax was withheld, not the net. Flags the
people who crossed the threshold and never handed in a W-9, which is the
January phone call this exists to generate. It files nothing and cannot: this
database holds four digits of a tax identifier and no more, deliberately.

---

## Phase 1 — Core, events, entries (weeks 1–6)

- Organisation and user management, invitations, role assignment
- ~~Rodeo and rodeo-event CRUD~~ — done; sanctioning approvals workflow still open
- Online entry with fee collection via Stripe — the desk takes entries and
  cash today; the card path waits on Stripe Connect
- ~~Draw generation, stock draw~~ — done, with a published seed. Buddy groups
  work in the engine and have no screen
- Contestant portal: enter, view entries, view draw

## Phase 2 — Scoring, results, payouts in the UI (weeks 7–12)

- ~~Secretary terminal: manual score entry, correction, DQ, reride~~ — done
- ~~Results calculation and publication~~ — done; season standings have public
  pages but no producer-side screen
- ~~Payout calculation review screen, then disbursement~~ — done
- ~~Public results pages with SEO~~ — done: server-rendered, JSON-LD,
  sitemap, robots.txt, no client JavaScript

## Phase 3 — Offline, timer, live (weeks 13–16)

- PWA shell, service worker, IndexedDB via Dexie
- Sync queue against the authority model already implemented
- Timer Bridge (Tauri) for FarmTek Polaris and Daktronics OmniSport 2000
- Live SSE broadcast to spectators, WebSocket to arena terminals

## Phase 4 — Compliance and reporting

- ~~Waiver signing flow~~ — done. PDF generation still open: the signature and
  its evidence are recorded, but there is no rendered document to hand back
- ~~Compliance calendar~~ — done
- Insurance certificate tracking and expiry alerts (schema done, no alerts yet)
- ~~1099 / T4A-NR reporting~~ — done as a report against the ledger. Generating
  and transmitting the forms themselves is out of scope while this database
  deliberately holds no full tax identifiers
- PAYG summary for AU — the withholding is computed, the summary is not
- PROCOM import and export, once the file format is obtained

## Phase 5 — What is left

- **Notice delivery.** The outbox is written and nothing drains it. Needs a
  worker, a provider per channel, retry with backoff, and an unsubscribe that
  respects the difference between "the draw is up" and marketing. `GET
  /notices` returns the sent log and no screen shows it yet
- **Supabase Auth in the UI.** A token is pasted into Settings today, which the
  screen says plainly rather than faking a login
- **Stripe Connect.** Parked deliberately: producers attach their own account
  so nobody can say we charged them for anything
- **Contestant portal.** Enter, view entries, view the draw, sign a release,
  read the inbox that `notices` already fills
- **Buddy groups** work in the engine and have no screen
- **Hold expiry** is a manual sweep from the Grounds screen; it wants a
  schedule
- **Insurance expiry alerts** — the schema and the notice type both exist; the
  job that connects them does not
- **Tournament advancement** — Cheyenne-style brackets

---

## Blocked on outside information

These cannot be built correctly from what is available. Most are Appendix B of
the architecture. Two moved on 8 August 2026 — see [`RULES.md`](RULES.md).

**Resolved since the last review:**

- PBR's 2026 judge structure, tenth-point increment and 3.0 variance cap are
  sourced from PBR's own announcement. The config was wrong (one judge at 0–50
  rather than four at 0–25) and is fixed.
- PRCA and WPRA scoring and timed-event penalties are confirmed and the
  templates are no longer flagged unverified.

**Still blocked:**

| Needed | Blocks | How to get it |
|---|---|---|
| PRCA full fee schedule | Producer fee structures | PRCA member access |
| CPRA number-of-monies thresholds | Canadian payout ladders | CPRA rulebook PDF |
| USTRC 2026 division ladder | `USTRC Standard Ladder 2026` | USTRC rulebook |
| WSTR 2026 division ladder beyond the #7.5 | `WSTR Standard Ladder 2026` | WSTR rulebook |
| Elite rule wording | `elite_excluded` on both ladders | USTRC / WSTR |
| PROCOM file format | Entry import, results export | PRCA IT, sample day sheets |
| Stripe Connect Express in AU | AU contractor payouts | Stripe docs |
| NBHA >12-place approval process | Large NBHA jackpots | NBHA |
| Brazil Nota Fiscal requirements | End-to-end BR withholding | Brazilian tax consultant |
| FarmTek Polaris protocol across 5 versions | Timer Bridge on older units | Hardware for testing |

Until a rulebook is in hand, the matching template carries `"unverified": true`
in its config and must not be used for a sanctioned rodeo.

---

## Three rule conflicts still unresolved

Flagged during the discipline-site build and still open as of 8 August 2026.
Each needs a decision from the sanctioning body before the affected config can
be marked verified — they are judgement calls, not facts to look up:

1. **Crossfire standard** — is the violation judged at rope release or at
   contact?
2. **Tie-on eligibility thresholds** — which handicap numbers, under which
   association.
3. **Jerk-down consequence** — no-time, or fine?
