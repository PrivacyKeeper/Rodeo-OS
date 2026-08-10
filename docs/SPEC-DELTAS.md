# Deltas from Architecture v1.0

Last reviewed: **8 August 2026**

This repository implements *RodeoApps.pro OS — Complete Technical Architecture*,
Version 1.0, 17 June 2026.

Everything below is a place where this build **deliberately departs from that
document**. Each entry says what the spec asks for, why it does not hold up,
and what was built instead. Nothing here is a matter of taste — these are
defects that would have shipped.

Read this before assuming the code disagrees with the blueprint by accident.

Severity key: **S1** loses money or leaks data · **S2** produces wrong results
· **S3** breaks at build or run time · **S4** gap that has to be filled.

---

## D1 — Tenant isolation is asserted by the app, not proven by the token · S1

**Spec** (§2.1, §4.2):

```sql
CREATE POLICY tenant_isolation ON <table>
    USING (org_id = current_setting('app.current_org_id')::UUID);
```

```ts
await req.db.raw(`SET LOCAL app.current_org_id = '${orgId}'`);
```

**Problems**, in descending order of severity:

1. `orgId` is `req.params.org_id` — a URL path segment — concatenated into SQL.
   This is a SQL injection site in the middleware that *every authenticated
   request* passes through.
2. Even parameterised, the isolation predicate is a claim the application makes
   about itself. Anything with a database connection can `SET` the variable to
   another tenant's id. RLS exists so the database does not have to trust the
   application; this design makes RLS depend on the application being correct,
   which is the thing it was adopted to stop depending on.
3. No Supabase client executes that `SET`. PostgREST, Realtime, the JS SDK, and
   every discipline app in §3.3.3 connect directly. Under these policies they
   see zero rows, while the Fastify server — which uses the service role — is
   `BYPASSRLS` and sees everything. The policy is simultaneously too strict to
   use and doing no work.

**Built instead:** policies derive the tenant from `auth.uid()`, which Supabase
Auth signs into the JWT and the client cannot set, joined through `org_members`.
Helper functions `app_is_org_member()`, `app_is_org_staff()`, `app_can_score()`
and `app_can_view_financials()` are `SECURITY DEFINER STABLE` so the membership
lookup runs once per statement without recursing into RLS. Request handlers
forward the caller's own access token so the same policies apply to every path
into the data — API, SDK, Realtime, or discipline app.

`supabase/migrations/0008_rls.sql`, `apps/api/src/core/auth.ts`

---

## D2 — Place numbering is wrong after a tie · S1

**Spec** (§5.4):

```ts
ranked.push({ ...score, place: currentPlace, is_tied: false });
currentPlace = i + 1 + 1;
```

On the tie branch `currentPlace` is never updated. After a two-way tie for
first, the next contestant is placed **2nd**, not 3rd — and the payout engine
pays them the 2nd-place split out of a purse whose 1st and 2nd money has
already gone to the tied pair. The event overpays.

**Built instead:** standard competition ranking (1, 2, 2, 4), where a group of
*N* tied contestants occupies places *P*…*P+N-1* and the next distinct value
starts at its own sorted index + 1. The payout engine sums the splits for every
place a tie group occupies and divides the total equally, which is the
"combine and split" rule §5.7 specifies.

`packages/engine/src/scoring/rank.ts`, test `places the runner-up after a tie for first in THIRD`

---

## D3 — Ties are ignored when the field is short, and places are re-derived from array order · S1

**Spec** (§6.2, `calculateStandardPayout`): when `qualified.length <
payoutRule.places_paid`, the function pays `qualified[i]` at `place: i + 1`.

Two problems in one branch. It ignores the `place` the ranker already assigned
and re-derives it from position in an array, and it never calls
`detectTieGroups` — so two contestants who tied for first in a short field are
paid *different* amounts, one at the 1st-place split and one at the 2nd.

**Built instead:** one code path. `payOnePurse()` groups by place first, then
allocates, so ties and short fields compose correctly regardless of which
happens.

`packages/engine/src/payouts/engine.ts`

---

## D4 — A contestant who missed a round can still take the average · S2

**Spec** (§5.5) counts entries present in the score map and compares the count
to `numRounds`. A run that was a no-time is filtered out rather than
disqualifying the aggregate, so whether the contestant is excluded depends on
whether a row exists at all — which differs between a turnout (no row) and a
missed catch (a row with `status='no_time'`).

**Built instead:** every round from 1 to `numRounds` must be present *and*
`official`. Anything else returns `complete: false` and the contestant does not
place in the average. That is how the average works in the arena: you have to
catch all of them.

`packages/engine/src/scoring/aggregate.ts`

---

## D5 — D-format silently mis-assigns when splits and divisions disagree · S2

**Spec** (§5.6) loops `d < dConfig.time_splits.length - 1` and defaults
everything else to `dConfig.divisions`. That is correct only when the splits
array has exactly one entry per division. Nothing in the schema enforces it, so
a 4D config with three splits drops every run slower than the last split into
4D instead of 3D — quietly, with no error.

**Built instead:** the two lengths are validated against each other and a
mismatch is a hard error. Assignment walks the splits from the slowest down, so
the last division is genuinely open-ended.

`packages/engine/src/scoring/aggregate.ts`

---

## D6 — `rankResults()` returns an empty field for every input · S1

**Spec** (§5.4):

```ts
const qualified = scores.filter(s =>
  s.status === 'official' &&
  s.final_score !== null &&
  s.final_time  !== null);
```

A judged run has `final_time === null`. A timed run has `final_score === null`.
No record can satisfy both clauses, so this filter returns `[]` for every event
in the system, and the payout engine downstream of it pays nobody.

**Built instead:** the qualifying value is selected by `config.mode` before
filtering.

`packages/engine/src/scoring/rank.ts`, test `ranks a timed field at all`

---

## D7 — The schema does not build in document order · S3

`rodeo_sanctioning` (§2.2.3) and `rodeo_events` (§2.2.4) both declare
`REFERENCES scoring_configs(id)`, but `scoring_configs` is not defined until
§2.2.7. Run top to bottom, the DDL fails.

**Built instead:** configs are migration `0002`, ahead of everything that
references them.

---

## D8 — "Compound foreign keys include `org_id`" is stated but not implemented · S1

**Spec** (§2.4 #5): *"Every FK relationship includes the tenant ID to prevent
cross-tenant data references at the database level, not just the application
level."*

No table in §2.2 declares a composite foreign key. Every one is single-column
(`REFERENCES rodeos(id)`). The database will happily accept a `scores` row
whose `org_id` is tenant A and whose `rodeo_id` belongs to tenant B — exactly
the reference the paragraph claims is impossible.

**Built instead:** tenant-scoped tables carry `unique (org_id, id)` and children
declare `foreign key (org_id, parent_id) references parent (org_id, id)`. Now
the claim is true.

`supabase/migrations/0003`–`0007`

---

## D9 — Append-only enforced by RLS protects everyone except the writer · S1

**Spec** (§2.2.8): *"Append-only: no UPDATE or DELETE allowed via RLS policy."*

The Fastify server connects with the Supabase service role, which is
`BYPASSRLS`. An RLS-only rule constrains every client *except the one process
that actually writes to the ledger*.

**Built instead:** `BEFORE UPDATE OR DELETE` triggers that raise. Triggers apply
to every role, service role included. Status — the one thing that legitimately
changes — moved to a separate `transaction_status_events` table so the ledger
row itself never has to be touched.

`supabase/migrations/0009_immutability.sql`

---

## D10 — The entries unique index forbids entering twice · S2

**Spec** (§2.2.5):

```sql
CREATE UNIQUE INDEX idx_entries_unique ON entries(rodeo_event_id, contestant_id)
    WHERE status NOT IN ('scratched', 'turned_out');
```

Ropers routinely enter the same event more than once — different partner,
different horse. Team roping in particular: the same person may head for one
partner and heel for another. This index rejects the second entry.

**Built instead:** an `entry_slot` column, with uniqueness on
`(rodeo_event_id, contestant_id, entry_slot, go_round_number)`. Producers cap
slots per event through `max_entries_per_event`.

`supabase/migrations/0004_entries_and_stock.sql`

---

## D11 — The variance cap rejects the score it is supposed to flag · S2

§5.7 says the PBR variance cap is a *"Warning flag, not hard rejection. Judges
can override."* §5.3 returns `{ valid: false, errors: [{ severity: 'warning' }]
}` — a rejection carrying a warning severity. A legal 88.5-point ride does not
get recorded.

**Built instead:** advisory by default. The score is stored, and the breach is
returned as a warning the secretary terminal surfaces for review.
`variance_cap_is_advisory: false` opts a config into hard enforcement.

`packages/engine/src/scoring/judged.ts`

---

## D12 — Money has no currency · S4

`financial_transactions.currency` exists per row, but nothing else in the
system carries one: the payout engine has no currency parameter, `escrow_records`
has none, and organisations declare a currency that never reaches a
calculation. A Canadian rodeo paying a US contestant produces CAD and USD rows
with nothing marking the boundary and no conversion anywhere.

**Built instead:** `escrow_records.currency` added, defaulting to CAD (the only
jurisdiction §6.5 escrows in). The engine is explicitly single-currency per
calculation and documented as such; the org's currency is the unit. **Multi-
currency settlement is not solved** and should not be attempted before Phase 3
(§7.2), when multi-region deployment forces the question.

---

## D13 — Contestants cannot be paid · S1

Users have `stripe_customer_id` (§2.2.2) — that is how somebody *pays*. Nothing
in the schema lets them *receive*. Payouts flow producer → contestant through
Stripe Connect, which needs a connected account per recipient.

**Built instead:** `users.stripe_account_id` and `users.stripe_payouts_enabled`.

`supabase/migrations/0001_core_identity.sql`

---

## D14 — The payout code reads fields the schema never defines · S3

§6.4 and §6.5 reference `rodeoEvent.is_roughstock`,
`rodeoEvent.additional_entry_fee`, `rodeoEvent.paid_performance_entries`, and
`rodeoEvent.sanctioning.find(...)`. None exists on `rodeo_events`, and
sanctioning is a separate table keyed to `rodeo_id`, not an array on the event.

**Built instead:** `is_roughstock` and `additional_entry_fee` are real columns;
`paid_performance_entries` is passed in as a computed argument rather than
pretended to be stored; sanctioning is looked up through `rodeo_sanctioning`.

---

## D15 — The results unique constraint does not constrain · S2

**Spec** (§2.2.7): `UNIQUE(rodeo_event_id, contestant_id, result_type,
go_round, d_division)`.

`go_round` and `d_division` are nullable, and in SQL two NULLs never collide.
The average row — the one where both are NULL — is duplicable without limit,
which means a contestant can end up with two average placings and be paid
twice.

**Built instead:** a unique index with `NULLS NOT DISTINCT`.

`supabase/migrations/0005_scores_and_results.sql`

---

## D16 — Per-line rounding does not reconcile · S1

**Spec** (§6.2): `Math.round(amount * 100) / 100`, applied to each payout line
independently.

Rounding shares one at a time does not preserve the total. A $100 purse split
three ways disburses $99.99. §7.4 lists *"Payout reconciliation (sum of payouts
= net purse)"* as a tracked metric with a target of zero errors — the reference
implementation cannot hit it.

**Built instead:** all money is integer cents, and every division is a
largest-remainder allocation over the whole pool: floor each share, then hand
the leftover cents to the largest discarded fractions. The result sums to the
input by construction, and `assertReconciles()` proves it before the engine
returns. The API refuses to serve a payout that does not balance.

`packages/engine/src/money.ts`, test `never drops a cent across a thousand awkward purses`

---

## D17 — The increment check rejects legal scores · S2

**Spec** (§5.3):

```ts
const remainder = (component.value * 10) % (config.scoring.increment * 10);
if (Math.abs(remainder) > 0.001) { /* reject */ }
```

`24.3 * 10` is `242.99999999999997` in IEEE 754. `% 1` gives
`0.9999999999999716`, which exceeds the tolerance, so a perfectly legal PBR
score in 0.1 increments is rejected as off-increment. The check fails on
exactly the increment it was written for.

**Built instead:** comparison in scaled integers.

`packages/engine/src/scoring/judged.ts`, test `accepts 0.1 increments that trip naive float modulo`

---

## D18 — A half-scored ride validates · S2

Nothing in §5.3 checks that the required number of judges actually marked each
component. `ScoringComponent.judges` is defined in the config schema and never
read. One judge's card on a two-judge event produces a "valid" score at roughly
half the correct total, which then ranks against complete scores.

**Built instead:** the judge count per component is verified, and duplicate
judge positions are rejected.

`packages/engine/src/scoring/judged.ts`

---

## D19 — Barrel knockdowns can be charged twice · S2

§5.3 applies `input.penalties` in a loop and then applies `barrels_knocked`
separately. A caller that sends both — which the shape of the input invites —
is charged 5 seconds twice for one barrel.

**Built instead:** both routes fold into a single penalty tally before any
arithmetic; the larger count wins, not the sum.

`packages/engine/src/scoring/timed.ts`

---

## D20 — Ties are detected with float equality · S2

**Spec** (§5.4): `if (compareValue === prevValue)`.

Two 13.7-second runs that arrive as `13.7` and `13.700000000000001` — entirely
normal after adding a penalty in floating point — are not tied under `===`. One
of them takes the place, and the money, alone.

**Built instead:** comparison on the value quantised to the event's own
precision (`time_precision` for timed events, hundredths for judged).

`packages/engine/src/scoring/rank.ts`

---

## D21 — PBR is scored by four judges, not one · S1

**Seeded wrongly here, not in the architecture.** The architecture leaves PBR's
judge structure unspecified; the config first seeded in this repository modelled
a single judge marking the rider 0–50 and the bull 0–50.

PBR runs **four** judges. Each marks the rider 0–25 and the bull 0–25, and the
eight marks are combined and divided by two for the official score out of 100.
The wrong model has two consequences: a single judge's card validates as a
complete ride, and once four real cards arrive a 90-point ride records as 180.

**Built instead:** a `score_divisor` on the scoring config, applied to the rider
total, the animal total and the final score. PRCA sums two judges straight to
100 with a divisor of 1; PBR divides eight marks by 2. The variance cap is
evaluated on the post-divisor scores, which is the scale the published 3.0 cap
refers to.

`supabase/migrations/0012_rules_2026_corrections.sql`,
`packages/engine/src/scoring/judged.ts`, test `combines eight marks and divides by two`

---

## D22 — Barrel knockdowns were charged once however many fell · S2

The engine defaults a penalty to non-repeatable, which is correct for a barrier
break and wrong for barrels. The seeded WPRA barrel racing config never set
`repeatable`, so a two-barrel run was charged 5 seconds instead of 10.

**Built instead:** `repeatable: true` on every barrel-knockdown rule, set for
barrel racing, junior barrel racing and pole bending.

`supabase/migrations/0012_rules_2026_corrections.sql`

---

## D23 — Numbered roping divisions did not exist · S4

Architecture v1.0 models open competition only. USTRC and WSTR run classified
divisions: every roper carries a handicap number, a team's numbers must total
no more than the division, and most divisions cap each end separately so a
high-numbered header cannot carry a beginner heeler into a soft field. That is
the format the majority of this platform's ropers enter — the schema could not
represent its own core audience.

A team that ropes an ineligible division is disqualified after the fact and the
money re-paid, which through an append-only ledger means a clawback. The check
belongs at the entry desk.

**Built instead:** `roper_classifications` (numbers per association, per end,
with history rather than overwrite), `rodeo_events.division_config`,
`division_templates`, and number columns on `entries` **snapshotted at entry
time** so a mid-season raise cannot retroactively disqualify a team. Eligibility
logic in the engine reports every violation at once rather than the first.

Note that USTRC's barrier is **5 seconds**, not the 10 that PRCA assesses — the
same event, a materially different rule.

`supabase/migrations/0011_handicap_roping.sql`,
`packages/engine/src/scoring/divisions.ts`

---

## D24 — A multi-round test asserted against the wrong rounding · S3

Internal, not a shipped defect: the multi-round payout test compared the
go-round pool against `Math.round(net * 0.4)` while the engine allocates by
largest remainder. The two can legitimately differ by a cent, so the test would
have failed on some purses for the right reason. It now asserts against the
engine's own allocation and against the exact sum.

`packages/engine/test/payouts.test.ts`

---

## D25 — Drizzle replaced by postgres.js · S4

**Spec** (Appendix A) selects Drizzle ORM for "type-safe SQL queries, zero
runtime overhead."

The reason for changing it is RLS. Isolation here depends on running each
request inside a transaction that carries the caller's verified JWT claims and
`set local role authenticated`. That is transaction-scoped session state, which
is a driver concern, not an ORM one — and every repository query is hand-written
SQL with joins and aggregation, so the query-builder half of Drizzle's value
never applies. Adding an ORM on top of the driver would have meant maintaining a
29-table schema definition purely to be bypassed by `sql\`...\`` at every call
site.

postgres.js gives the transaction control directly, and its tagged templates
bind every interpolation as a parameter — so the "no string-built SQL" property
is enforced by the API rather than by discipline.

`apps/api/src/core/database/client.ts`

---

## D26 — `JSON.stringify(x)::jsonb` stores a string, not an object · S1

Not in the architecture — introduced in this repository and caught by the
integration tests before it reached anything.

Writing JSONB as:

```ts
await tx`insert into scoring_configs (config) values (${JSON.stringify(cfg)}::jsonb)`
```

binds a **text** parameter, so the cast produces a jsonb *string scalar*.
`jsonb_typeof()` returns `'string'`, and reading it back yields a JS string
rather than an object. Spreading that string produces an object with numeric
keys, which is truthy — so `loadScoringConfig()` returned something that looked
like a config and had no `mode`, no `increment`, no penalties. Every rule in it
silently vanished, and the scoring engine fell back to rejecting the run.

The same pattern was on `judge_scores`, `time_penalties` and transaction
metadata: judge cards and penalty records would have round-tripped as unusable
text.

**Fixed:** `tx.json(value)`, which binds a genuine JSON parameter. A regression
test asserts `jsonb_typeof(config) = 'object'` and that the loaded config still
carries its rules.

This is the class of bug that unit tests cannot reach and a schema review does
not show. It is the reason the integration suite exists.

`apps/api/src/core/database/repositories.ts`, test `a stored config round-trips as an object, not a jsonb string`

---

## D27 — Team events had no model; team roping paid half the team · S1

Not in the architecture, and not in this repository until an NFR walkthrough
went looking for it. §2.2.5 gives `entries.partner_id` and §2.2.4 lists
`team_roping_header` and `team_roping_heeler` as event types, but nothing
downstream ever reads either. The scoring engine ranks by `contestant_id`, the
payout engine pays by `contestant_id`, and `loadPayoutContext` selected from
`scores` without joining `entries` — so a team roping payout named the header
and the heeler simply did not exist.

Team roping is at the NFR, at every jackpot in the country, and is one of the
nine discipline apps this platform is built around.

Fixing the *amount* was the harder half. Both obvious answers are wrong:

- Pay the team its place money and give each roper that amount → **twice the
  purse leaves the account.**
- Halve it → every roper is credited half what PRCA publishes, and the world
  standings are wrong all season.

The rule is that both ropers pay an entry fee — so the purse is built from two
fees per team — and each end is credited the FULL amount. PRCA publishes these
as "$X-a-Man" and headers and heelers carry separate world standings; one
partner can make the NFR while the other does not.

**Built instead:** `Rankable.team_members` plus
`PayoutConfig.team_payout`. `payTeamPurse()` splits the purse into one equal
pool per end and pays the identical team ranking out of each, so both ropers
receive the same amount and the total disbursed equals the purse exactly.
`split_between` covers ranch rodeo, where a crew enters once and divides its
money. The payout ladder is now selected by team count rather than roper count,
and `loadPayoutContext` joins `entries` so `partner_id` reaches the engine.

Parity check, now a test: ten teams at $50 a man raises $1,000 and pays its
winner $500; ten individuals at $50 raises $500 and pays its winner $500.

`packages/engine/src/payouts/engine.ts`,
`apps/api/src/core/database/repositories.ts`, `docs/AUDIT.md`

---

## D28 — `SELECT ... FOR UPDATE` returns nothing on an append-only RLS table · S2

Found while building settlement. `settleTransaction()` locked the ledger row
the obvious way:

```sql
select id, amount, status from financial_transactions
 where id = $1 and org_id = $2
 for update
```

Postgres applies the **UPDATE** policy to a locking read, and
`financial_transactions` deliberately has no UPDATE policy at all — the ledger
is append-only (D9). So the lock matched **zero rows for every caller**, and
settlement reported every payment in the system as missing.

The two guarantees were correct individually and broke each other in
combination, which is exactly the kind of interaction no unit test reaches.

**Built instead:** `pg_advisory_xact_lock(hashtextextended(id, 0))`. It
serialises concurrent settlements of the same payment, takes no row
privileges, and releases when the transaction ends either way.

`apps/api/src/core/settlement.ts`

---

## D29 — Nothing wrote the `results` table · S1

Three call sites read `results`. Zero wrote it.

`loadPayoutContext()` reads it for `average_results`, `loadPublicResults()`
reads it for the scoreboard, `loadStandings()` reads it for the season. All
three got an empty table, which means: **the average payout paid nobody**, the
public results page was blank, and standings returned nothing.

The multi-round payout tests passed throughout, because they fed the engine
results directly. Nothing exercised the path from a stored score to a stored
placing — the join between two correct halves.

**Built instead:** `computeResults()` derives go-round placings, the average
and D-divisions from the scores, with season points on either a money basis
(the PRCA convention of a dollar being a point) or an association placing
table. `writeResults()` replaces an event's results rather than upserting,
because a correction can REMOVE a placing — a contestant disqualified drops out
of the average entirely, and an upsert would leave the stale row behind.
Results are derived data, so rebuilding is always safe; the ledger is
append-only precisely because it is not.

A team places once but the standings track individuals, so `expandTeamResults()`
fans a team placing out to both ends before writing.

`packages/engine/src/results/engine.ts`,
`apps/api/src/modules/results/routes.ts`, test `the average payout paid NOBODY before results were written`

---

## D30 — Results were less public than the scores behind them · S2

`scores_public_read` exposes an official score once the rodeo is
`in_progress` — that is the live results page. `results_public_read` required
`completed` or later.

So during a rodeo a spectator could see every raw time and none of the placings
computed from them. The leaderboard was hidden while the numbers behind it were
on the screen, and at a multi-day rodeo that means no live average and no
standings until it is all over.

**Built instead:** the results policy now matches the scores policy.
`is_official` still gates provisional placings out, and nothing is disclosed
that the scores did not already disclose.

`supabase/migrations/0015_live_results_visibility.sql`

---

## D31 — The public scoreboard could not name anybody · S1

`loadPublicResults()` joined `users` to put a name next to a placing.
Anonymous callers have no policy on `users`, so the join matched nothing and
**every public results page returned empty** — across all nine .pro sites,
which is also the entire SEO surface.

The tempting fix is a public read policy on `users`, and it is dangerous. RLS
is ROW level, not column level: opening the row to satisfy a name lookup also
opens email, phone, date of birth, home address and `tax_id_last4` to anonymous
callers. A scoreboard needs a name, not a contestant's file.

**Built instead:** a `public_results` view exposing exactly two columns from
`users` — first and last name — and only for official placings at a rodeo
already under way, with `public_standings` aggregated over the same surface so
there is one auditable place where a name leaves the private tables. Three
invariants now hold the line: the scoreboard resolves a name anonymously, the
`users` table stays closed anonymously, and the view carries no contact or tax
column even if one is later added to `users`.

`supabase/migrations/0016_public_results_view.sql`

---

## Carried forward unchanged

These are noted in the architecture and remain open. They are **not** defects —
they are known gaps that block specific features.

| Item | Blocks | Source |
|---|---|---|
| PRCA rulebook exact penalty and fee tables | Certified PRCA scoring configs | Appendix B |
| PBR 2026 full variance provisions | Certified PBR config | Appendix B |
| CPRA "number of monies" thresholds | Canadian payout tables | Appendix B |
| PROCOM file format | Entry import / results export | Appendix B |
| Stripe Connect Express availability in AU | AU stock contractor payouts | Appendix B |
| NBHA >12-place approval workflow | Large NBHA jackpots | Appendix B |
| Brazil Nota Fiscal technical requirements | End-to-end BR withholding | Appendix B |
| FarmTek Polaris protocol variation across 5 versions | Timer Bridge on older hardware | Appendix B |

Every system scoring or payout template whose rulebook has not been obtained
carries `"unverified": true` and a note in its config JSON. Do not run a
sanctioned rodeo on an unverified template.

What each rule is sourced from, and when it was last checked, is in
[`RULES.md`](RULES.md). As of 8 August 2026 the PRCA, WPRA and PBR templates
are sourced and dated; USTRC, WSTR and CPRA remain unverified.

## D32 — A filing requirement that blocks the close is a deadlock · S1

Seeding the PRCA compliance calendar, "Results filed with the association" was
marked `blocks_close`. It is the requirement with the deadline and the fine on
it, so it looked like the obvious one to gate on.

It cannot be satisfied. Filing happens **after** closing: the books close, then
the results go to the association. Gating the close on the filing means the
books can never close, so the results can never be filed, so the requirement is
never satisfied. Every sanctioned rodeo would have been permanently stuck one
step from done, and the failure would have shown up in an arena office at
11:40pm rather than in review.

Found by the integration tests — `checkBooks` returned
`COMPLIANCE_BLOCKER@Results filed with the association` on a rodeo whose money
and scores were all correct.

**Built instead:** the seed no longer marks it blocking, and `checkBooks`
refuses to treat *any* requirement of type `filing` as a blocker whatever the
row says, so a producer writing their own requirement cannot rebuild the trap.
An invariant asserts no filing requirement anywhere is marked `blocks_close`.

The wider lesson is the design rule this violated, which was written down in the
same commit that broke it: **a secretary who cannot file at 11:40pm because the
software wants paperwork will not use the software again.** Only money that does
not reconcile, runs nobody scored and scores still provisional may block. In the
seeded profiles nothing else does.

`supabase/migrations/0019_sanction_layer.sql`, `packages/engine/src/books/engine.ts`

---

## D33 — The compliance calendar was withheld until it was pointless · S2

`generate_compliance_items()` only picked up sanctioning rows with status
`approved` or `conditional`.

A committee that has just decided to run PRCA this year is `pending` — approval
comes later, and **filing the approval application is item one on the very list
being withheld.** The checklist that exists to get a rodeo approved was only
issued once the rodeo was already approved.

**Built instead:** `pending` generates the calendar too. The asymmetry with the
books is deliberate and documented in the migration: the *money* rules (the
association's percentage) and the *filing deadline* still apply only once a body
has actually approved the rodeo, because owing an association 6% before it has
agreed to sanction you is a different kind of wrong. Personnel shortfall follows
the calendar, not the money — carded judges have to be lined up before approval,
not after.

`supabase/migrations/0019_sanction_layer.sql`

---

## D34 — A rodeo the wizard created could not be scored · S1

The setup screen asks five questions and none of them is "which scoring
configuration". The score route requires `scoring_config_id`. So every rodeo
created through the interface produced events with a null config, and the first
score submitted against any of them was rejected.

A rodeo you can create but cannot score is worse than no setup screen at all:
the failure lands after the entries are in, on the day.

**Built instead:** `createRodeo()` resolves a default per event — the tenant's
own config for this body and event first, then the system config for this body
and event, then any config for the event. It will not cross event types under
any circumstances, because a bareback configuration applied to barrel racing
scores every run wrong and looks like it worked. An integration test asserts
each event's resolved config matches its own event type.

`apps/api/src/core/database/operations-repo.ts`

---

## D35 — The books chased fees that were never owed · S3

`checkBooks` raised `UNPAID_ENTRY` for any entry whose collected amount was
below the charged amount and whose status was not a scratch. That caught entries
still sitting at `pending` — people who filled in a form, never confirmed, and
never ran.

Blocking a close at eleven at night over money from somebody who was never in
the pot is exactly the noise this screen exists to avoid.

**Built instead:** the unpaid check applies only to live entries — confirmed,
drawn or competed. Caught by a unit test written before the behaviour was.

`packages/engine/src/books/engine.ts`

---

## D36 — A contestant entered at the desk vanished from the day sheet · S1

`users_staff_read` showed a person to org staff only when that person had an
`org_members` row in the staff member's organisation.

But `users` is deliberately global and login-less — 0001 says so in a comment:
*"secretaries create contestant records for people who have never signed in."*
Nothing in the entry flow creates an `org_members` row for a contestant, and
nothing should: a roper who enters your jackpot is not a member of your staff.

So the contestant was invisible to the very organisation that had just taken
their entry. And because the day sheet, the entry list and the books all
resolve a name with `join users`, an INNER JOIN against an invisible row
**dropped the entry entirely**:

- missing from the day sheet, so nobody calls them up
- missing from the entry list, so nobody takes their money
- missing from `checkBooks()`, so the books close without them

Silently. No error anywhere. Every earlier integration test passed only because
its fixtures made each contestant an org member, which a real desk never does —
the bug was invisible until a test created a contestant the way the product
actually creates one.

**Built instead:** staff may see a person their organisation has a relationship
with — a member, an entrant, a partner named on an entry, or somebody working
the rodeo. Still not the global table.

`supabase/migrations/0022_desk_visibility.sql`

---

## D37 — The desk could not find anybody it had not already met · S2

The same policy made the anti-duplicate search impossible. A secretary typing
"Roper" could not see a Casey Roper who had only ever competed at other
producers' rodeos, so she creates a second Casey Roper — and every duplicate
splits a career record in half. The record layer defeated at the moment the
record is created.

Opening `users` globally is not the answer, for the reason D31 already
established: RLS is ROW level, so exposing the row to satisfy a name lookup
also exposes email, phone, date of birth, address and `tax_id_last4`.

**Built instead:** `search_people()`, SECURITY DEFINER with a deliberately
narrow projection — id, name, city, state, and how many times they have entered
here. Contact details only for somebody already entered at the calling
organisation. Three limits on enumeration: the caller must be staff of the org
they name, the query must be at least three characters, and the result is
capped at 25. Same shape of fix as the `public_results` view, and the same
property: one auditable place where a name crosses.

`supabase/migrations/0022_desk_visibility.sql`

---

## D38 — Merging two duplicate people was impossible · S2

`person_merges` was given a SELECT policy, an append-only trigger and an INSERT
grant — and no INSERT policy. Under `force row level security` the absence of a
policy is a denial, so every merge failed on its last statement, after the
entries, scores, results and career runs had already been moved. The
transaction rolled back so nothing corrupted, but merging simply did not work
and the error said only *"new row violates row-level security policy"*.

The grant without the policy is the tell: somebody wrote half of it.

**Built instead:** an insert policy requiring the caller to record themselves as
`merged_by` and to be staff of an organisation that deals with the surviving
record — checked against the KEPT id, because by the time the row is written
the entries have already moved and a check on the merged id would always be
false.

`supabase/migrations/0022_desk_visibility.sql`

---

## D39 — A merge collided with the constraints it had to satisfy · S2

The first version of `mergePeople()` moved dependent rows with blanket UPDATEs.
Three of them cannot work that way:

- **`idx_entries_unique`** allows one live entry per (event, contestant, slot,
  round). Both duplicates are normally entered in the SAME event — that is how
  the duplicate gets noticed — so the update makes two identical keys and the
  merge dies on a unique violation. `entry_slot` exists for exactly this case
  (delta D10): a person accidentally entered twice genuinely has two entries,
  so the moved one takes the next free slot.
- **`partner_is_not_self`** rejects an entry whose partner is its own
  contestant, which is what a team-roping entry naming the duplicate as partner
  becomes after the merge. The partner is nulled rather than the merge failing:
  the run happened, and a secretary can name the right partner afterwards.
- **`idx_results_unique`** and the career-run equivalent collide the same way.
  Both are DERIVED, so the merged record's colliding rows are dropped and the
  event is re-finalised — the scores have all moved correctly, so every placing
  recomputes.

**Built instead:** entries move one at a time with a computed slot; the
self-partner case is nulled; derived rows are superseded rather than merged;
and the counts of each are returned so the operation reports what it actually
did.

`apps/api/src/core/database/desk-repo.ts`

---

## D40 — A secretary could not record the card of a judge she had just booked · S2

The same mistake as D36, in a second place. `credentials_org_write` allowed
staff to write a credential only for somebody with an `org_members` row in
their organisation.

A contract judge is not on your staff roster. He works four rodeos for four
different producers in a season and is a member of none of them. So the
committee that hires him could not record his card, `credential_is_current()`
returned false because there was nothing to check, and `personnel_shortfall()`
reported the rodeo one carded judge short forever — with the judge standing in
the arena, card in his pocket.

**The pattern, stated once:** any policy that treats `org_members` as the only
way a person relates to an organisation is wrong in this schema, because the
schema deliberately supports people with no login and no membership anywhere.
That is now true of `users`, of `credentials`, and it is worth checking before
writing the next policy.

Three further faults surfaced underneath it:

- **The read side broke the write.** `INSERT ... RETURNING` applies the SELECT
  policy to the new row, so the insert failed with a row-level security error
  even though its WITH CHECK passed. The write looked broken; the fault was the
  read. Fixed with a `created_by` column so whoever wrote a card down can read
  back the card they wrote down.
- **An ordering trap.** Verifying required a relationship, the relationship was
  created by assigning somebody to a rodeo, and assigning resolved the
  credential — so a card had to be verified before the assignment that made
  verification possible. The real workflow has no such circle: the judge hands
  over the card and the person who writes it down is the person who saw it. The
  recorder may now verify, and the rule that carries the weight is unchanged —
  nobody verifies their own.
- **The card was snapshotted at assignment.** `rodeo_personnel.credential_id`
  was resolved once, when somebody was put on the rodeo, so a card verified
  afterwards never appeared and the rodeo stayed "short" with a carded judge in
  the arena. Now resolved live at read time, the same way
  `personnel_shortfall()` already did it.

**Built instead:** recording and verifying are separated. Recording is
harmless — an unverified card counts for nothing anywhere — so any staff member
may record one for anybody. Verifying is the act that satisfies a sanctioning
requirement, and it stays restricted.

`supabase/migrations/0024_credential_visibility.sql`

---

## D41 — A composite `on delete set null` made the parent row undeletable

Tenant-scoped child rows use a composite foreign key so a row in org A cannot
point at a parent in org B:

```sql
foreign key (org_id, buddy_group_id)
    references buddy_groups (org_id, id) on delete set null
```

The shape is right. The action was wrong. `on delete set null` with no column
list nulls **every** referencing column, and `org_id` is `NOT NULL`, so the
cascade wrote a null into a NOT NULL column and the delete failed outright:

```
ERROR:  null value in column "org_id" violates not-null constraint
CONTEXT:  UPDATE ONLY "entries" SET "org_id" = NULL, "buddy_group_id" = NULL
```

Four tables carried it. A buddy group could never be deleted once anybody had
joined it; an animal with a welfare record on file was permanent; a rodeo where
anybody had been fined could not be removed, including one created by mistake;
and a rodeo with bookings against it could not be deleted at all.

It survived this long because every test in the repository builds rows and
asserts on them, and almost none of them delete a parent. Nothing was wrong
until somebody tried to clean up.

**Fixed with** the column list PostgreSQL 15 added to the referential action —
`on delete set null (buddy_group_id)` — which nulls the pointer and leaves the
tenant column alone. `career_runs` is deliberately left alone: both of its
referencing columns are nullable, because a career run outlives the
organisation that recorded it, and nulling both is correct there.

The invariant is written as a check over the whole catalogue rather than over
the four tables that were wrong, so a fifth added later fails the day it
appears.

`supabase/migrations/0026_composite_fk_set_null.sql`

---

## D42 — The signer could not read the release they were signing

`waiver_templates_read` was `org_id is null or app_is_org_member(org_id)`.

A contestant entering a rodeo is not a member of the producer's organisation.
So the person being asked to sign the liability release **could not read it** —
the one document in this schema whose entire legal weight rests on the signer
having seen the text, and the signer was the only party denied the text.

This is D36 and D40 for the third time. The pattern stated at D40 held again:
any policy treating `org_members` as the only relationship a person can have
with an organisation is wrong in a schema built for people who have no
membership anywhere.

**Built instead:** a template is readable when it is a system template, when
you are a member, when it is active and you have an entry with that producer,
when it is active and you are working one of their rodeos, or when you have
already signed it and want to read back what you signed. Reading your own
producer's release is not a key to everybody else's.

`supabase/migrations/0027_waiver_signing.sql`

---

## D43 — The waiver flow could not record the waivers rodeos actually collect

`signed_waivers_self_insert` required `user_id = app_current_user_id()`, with
two consequences.

A contestant created at the desk has no login at all, so that person could
never have a release on file — and they are precisely the person a jackpot
producer most needs one from. And a paper waiver signed at the gate, which is
how the overwhelming majority are collected, could not be recorded by the
secretary holding it.

**Built instead:** `sign_waiver()`, plus a `recorded_by` column and a
`paper_on_file` signature method.

Two decisions inside it are worth stating.

- **The hashes are computed by the database, from the stored template.**
  `waiver_text_hash` is supposed to prove what the signer saw. If the client
  computes it and sends it, it proves nothing whatsoever — it is a number the
  signer's own browser made up. The client is never asked for a hash. That is
  the difference between evidence and decoration, and it is the whole reason
  0007 bothered with the columns.
- **`recorded_by` is not optional.** Staff may record a signature for somebody
  who cannot sign for themselves, and the row says permanently who put it
  there. An unattributed waiver recorded by staff is worth less than no waiver
  at all, because it looks like evidence.

Two rules carry the weight: staff may never `click_to_sign` on somebody else's
behalf — a recorded release needs a name or a signature — and a template
belonging to another producer cannot be borrowed.

`verify_signed_waiver()` recomputes both hashes, because a hash nothing ever
checks is decoration. It distinguishes the two cases a mismatch can mean: a
producer reissuing a new version, and a document edited under a signature that
was already given.

`supabase/migrations/0027_waiver_signing.sql`

---

## D44 — An exclusion constraint cannot count, and was not told what to forbid

`bookings` prevents double-booking with a GiST exclusion constraint:

```sql
exclude using gist (resource_id with =, stay with &&)
    where (status in ('held', 'confirmed', 'completed'))
```

Correct for a stall. Wrong for everything else, because it applied to **every**
resource. A twenty-space camping field accepted exactly one booking, and the
careful capacity counting in `book_resource()` — advisory lock and all — never
ran, because the constraint fired first. The migration's own comment claimed
capacity above one was "handled separately"; it was not handled at all.

A test caught it. Nothing in the schema would have.

**Fixed with** a denormalised `exclusive` column on `bookings`, stamped by a
trigger from `bookable_resources.capacity = 1`, and added to the constraint's
WHERE clause. The exclusion constraint's WHERE clause can only see the row it
is checking, so the fact has to be on the row; it cannot join out to the
resource.

One consequence, taken deliberately: direct `INSERT` on `bookings` is revoked
from `authenticated`. A resource with capacity above one is protected **only**
by the counting inside `book_resource()`, so a caller who could insert straight
into the table could oversell a camping field without ever touching the check
that stops it. The function is `SECURITY DEFINER` and unaffected. Updates stay
open — confirming, cancelling and expiring a hold cannot create an overlap.

`supabase/migrations/0025_bookings_and_notices.sql`

---

## D45 — The 1099 threshold is data, because it moved

The US information-reporting threshold was $600 for four decades. The One Big
Beautiful Bill Act, signed July 2025, raised the 1099-NEC and 1099-MISC
threshold to **$2,000 for payments made on or after 1 January 2026**, and from
2026 it is indexed for inflation — so it will move again, quietly, most years.

A constant compiled into the payout engine would have been wrong within twelve
months, and nobody would have noticed until a producer under-reported.

**Built instead:** `tax_reporting_thresholds`, keyed by country and tax year,
seeded with the system values and overridable per producer. Every report states
which threshold it applied and which form it belongs to, rather than leaving
the reader to assume. Canada is seeded at zero deliberately: Regulation 105
requires a T4A-NR for the payment, not for the payment being large.

**What this does not do, and cannot:** file anything. `users` stores
`tax_id_last4` and nothing else — there is no SSN in this database, by a
decision made in 0001 that is worth keeping. A rodeo entry system holding tens
of thousands of Social Security numbers is a breach waiting to be named after
somebody. So the deliverable is the number the producer's accountant needs in
January, including the list of people who crossed the threshold and never
handed in a W-9.

One subtlety in the query: the report sums `coalesce(gross_amount, amount)`,
not `amount`. Where tax was withheld, `amount` is the net actually paid, and
reporting on it would understate a non-resident's earnings by exactly the tax
withheld from them — which is the one number a T4A-NR exists to state.

`supabase/migrations/0028_tax_reporting.sql`

---

## D46 — Three faults found by auditing the work rather than reading it

Written down because all three were invisible to the checks that were already
passing, and the pattern is worth keeping.

**The CI job that verified migrations had not verified one since 0016.** The
`migrations` job stubbed `auth.uid()` by hand and stopped there, but the part
that matters is that `anon`, `authenticated` and `service_role` are Supabase
roles that plain Postgres does not have — and only `bootstrap.sql` creates
them. Migration 0016 is the first to `grant ... to anon`, and a grant to a role
that does not exist is a hard error. On a clean runner the job died at 0016.

It hid because Postgres roles are cluster-wide, not per-database: any cluster
that had been bootstrapped once kept the roles forever, so every local check
passed. Proving it required a genuinely fresh cluster. The job now runs
`bootstrap.sql`, the same file the integration job already used.

**Every deliberate database error reached the client as HTTP 500.** The rules
in the grounds module live in `SECURITY DEFINER` functions and `raise exception
... using errcode`, with messages written for the person at the desk. Nothing
mapped those SQLSTATEs to a status, so Fastify treated them as 500 and the
error handler replaced the message with "An unexpected error occurred." A
secretary told she may not click-to-sign on somebody else's behalf fixes it in
three seconds; a secretary told the server broke rings somebody.

Only the codes those functions raise on purpose are mapped — 42501, P0002,
23514, 22007, 23P01. Anything else stays a 500, because an unexpected `23505`
is a bug and its message may name a constraint the caller has no business
seeing.

**The web client never sees `meta`.** `api.request()` returns `payload.data`,
not the envelope, so three new screens read counts off a `meta` object that was
always `{}` — live bookings, amount outstanding, contestants missing a release,
the reporting threshold, all silently blank or zero. Typecheck cannot catch it
(the web app is untyped JavaScript by design) and no test rendered a view.

Fixed by deriving every count from the rows, which is the existing house
pattern and means the number on screen cannot disagree with the table under it.
The threshold and form were already on every row because `tax_year_summary()`
returns them there — the right place for them, since they are part of the
answer rather than commentary about it.

**What the three have in common:** each sat behind a green check. The
migrations were verified against a dirty cluster, the routes were verified by
typecheck rather than by being called, and the views were verified by
`node --check` rather than by being rendered. A passing check on the wrong
thing is worse than no check, because it stops anybody looking.
