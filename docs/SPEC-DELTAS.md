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
