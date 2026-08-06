# The model: Procore and Toast, for rodeo

The architecture already names one of these — §3.1 says the module structure
"follows the Toast model." This document makes the whole comparison explicit,
because it is the thing that decides a hundred smaller design questions.

---

## What Toast actually is

Toast is not a point-of-sale system that grew features. It is the operating
system of a restaurant. Orders, payments, the menu, staff scheduling, payroll,
online ordering, delivery dispatch, kiosks, gift cards, loyalty, inventory,
and the hardware it all runs on.

Two things make it stick, and neither is the POS:

1. **A core platform plus modules you switch on.** Everybody gets orders and
   payments. A restaurant with no delivery does not pay for delivery. Toast
   grows with the restaurant instead of being replaced by it.

2. **A configuration surface deep enough to describe any restaurant.** Toast
   ships a *menu builder*, not a menu. Items, modifier groups, option sets,
   prep stations, price tiers by time of day. A taco truck and a steakhouse
   both fit, and neither called support to get their menu added.

## What Procore actually is

Procore is the operating system of a construction project. Preconstruction and
bidding, drawings, RFIs, submittals, daily logs, punch lists, budgets, change
orders, prime contracts, invoicing, safety inspections, incidents.

Three things make it stick:

1. **One project, every party, one record.** Owner, general contractor,
   subcontractor, architect and inspector are all in the same system looking at
   the same drawing set, with different permissions. There is no "send me the
   latest version" because there is only one version.

2. **The people who pay are not the people who mostly use it.** The GC buys
   Procore. Subcontractors are invited in free. That is how it reached
   everybody on the job site instead of just the office.

3. **Templates and configurable fields.** A builder who does the same kind of
   project repeatedly configures it once and clones it.

---

## The mapping

| Construction | Restaurant | Rodeo |
|---|---|---|
| General contractor | Restaurant owner | **Producer** — buys the platform |
| Project | Location | **Rodeo / jackpot** |
| Subcontractor (free, invited) | — | **Contestant** — free, invited |
| Trades and crew | Servers, kitchen | Secretary, judges, timer operator, chute boss, pickup men, bullfighters |
| Supplier | Food distributor | **Stock contractor** |
| Building inspector / code | Health department | **Sanctioning body** — PRCA, WPRA, USTRC |
| Budget and change orders | Daily sales, tips | **Purse, fees, payouts** |
| Drawings and RFIs | The menu | **Ground rules, draw, day sheet** |
| Daily log | Shift report | **Performance results** |
| Punch list | — | **Corrections and rerides** |
| Safety incident | — | **Injury, medical release, vet check** |
| Project template | Menu template | **Rodeo template** |

The producer pays. The contestant is free and comes in through the entry, the
draw and the results. That is Procore's distribution model, and it is the right
one here: there are far more contestants than producers, and the contestants
are the ones who make it the default.

---

## What that model demanded of the schema

Three things followed directly, and none of them were in Architecture v1.0.

### 1. Options are data, not a CHECK constraint

The architecture pins its lists in the schema:

```sql
event_type text not null check (event_type in ('bareback', ...19 values))
role       text not null check (role in (...14 values))
```

Nineteen event types is the ceiling on "you will never need another app." A
ranch rodeo runs wild cow milking, trailer loading and a wild horse race. A
playday runs a keyhole race and a boot scramble. A producer in one county runs
something nobody else runs. Under a CHECK constraint every one of those is a
support ticket, a migration and a deploy.

Toast does not ship a menu. It ships a menu builder.

`reference_options` now backs every dropdown — **287 options across 16
domains**, seeded from real rodeo practice, and a producer adds their own
alongside them. What is seeded:

| Domain | Options | Covers |
|---|---:|---|
| `event_type` | 48 | Rough stock, roping, timed, speed, ranch rodeo, cow horse, youth |
| `org_role` | 34 | Management, officials, arena crew, production, stock and care, participants |
| `fee_type` | 25 | Contestant, producer, venue, officials, association, platform |
| `sanctioning_body` | 24 | Professional, international, roping, barrels, youth, amateur |
| `rodeo_type` | 23 | Jackpot, sanctioned, youth, special |
| `dq_reason` | 23 | Per discipline |
| `payout_structure` | 12 | Standard, multi-round, divisional, special |
| `animal_type` | 11 | With PRCA weight ranges in metadata |
| `payment_method` | 9 | Electronic, in person, internal |
| `penalty_type` | 9 | With default seconds and repeatability |
| `catch_type` | 8 | Legal head, heel, illegal |
| `draw_method` | 8 | Automatic, seeded, sequential, manual |
| `entry_method` | 8 | Self-service, assisted, day-of, import |
| `release_reason` | 7 | Released vs turnout, with the PRCA 30-hour rule noted |
| `timer_system` | 7 | Manual and electronic, with authority ranking |
| `module` | 31 | The catalogue below |

**The line that was drawn.** Not everything became editable:

- A value the **code branches on** stays a CHECK constraint. `scoring_mode`
  ('judged' | 'timed') selects a calculation path. `transaction_type` drives
  ledger semantics. Status fields drive state machines. If a producer could
  invent a new one, the engine would not know what to do with it.
- A value that is a **label for a human** became reference data. The code
  stores it, shows it, and totals money against it — it never switches on it.

Custom options are tenant-scoped and enforced as such: one producer's custom
event type is invisible and unusable to every other producer. That is in the
committed invariants, not just the intent.

### 2. Sidepots

Every jackpot has them. A roper enters the #10, then puts $20 in the incentive
and $20 in the sidepot. Three purses off **one run**, paid to three different
lists of people. Architecture v1.0 has no table for this, which means the
secretary runs the sidepots on paper next to the software — the exact failure
that makes "the only app you need" untrue on day one.

`sidepots` and `sidepot_entries` model a purse attached to an event rather than
a second event, because the contestant does not run again. The payout engine
treats it as another pool over the same ranked field, so ties, ground money and
cent-exact rounding all apply unchanged. Eight kinds are supported: sidepot,
incentive, option, rookie, senior, youth, novice, and a separate jackpot off
the same run.

### 3. Templates and module entitlement

`rodeo_templates` — a producer runs the same rodeo every year. Clone it, do not
rebuild it. Stored as a JSON snapshot rather than shadow tables, so editing the
template cannot alter a rodeo already built from it.

`org_modules` — §3.2 sells Core, Premium and Discipline modules and the schema
had nowhere to record who bought what. Platform modules are always on; premium
modules are entitlements with an expiry; discipline apps are the nine
`.pro` sites as vertical extensions. `org_has_module()` is the gate, and an
expired subscription reads as off without deleting anything.

---

## Does the whole idea hold up?

Yes, with one condition worth stating plainly.

**What is genuinely right about it.** Rodeo has the same shape as construction
and restaurants: a small operator running a complex, recurring, multi-party
event on spreadsheets, paper and phone calls, with money and compliance
attached. Nobody has consolidated it. The producer-pays / contestant-free split
is proven distribution. And the discipline apps give something Toast and
Procore never had — a consumer-side community app per event that feeds the
professional side.

**The condition.** "The one and only OS all of rodeo will need" cannot mean a
closed system. It has to mean the system of record everyone else integrates
*with*. Procore did not win by refusing to talk to accounting software; it won
by being the place the data lived and having an API. Rodeo has PROCOM, existing
timing hardware, association membership databases and state-association
spreadsheets that are not going away on our schedule. The import and export
paths, and the ability for a producer to express their own operation without
asking permission, are what make "the only one you need" true rather than
aspirational.

That is why the options layer came before more features. A platform that
requires a deploy to add an event type is not an operating system. It is an
application with opinions.

---

## Still missing for the full model

| Gap | Why it matters | Status |
|---|---|---|
| Persistence layer | Nothing runs end to end without it | Next, and blocking |
| Onboarding wizard | Toast and Procore both live or die on setup | Not started |
| Sponsors and ticketing | Producer revenue beyond entry fees | Not modelled |
| Ground/day sheets and printable reports | What the arena actually runs on | Not modelled |
| Season standings and points | Series and circuits | Table exists, engine does not |
| PROCOM import/export | Sanctioned producers cannot leave their current flow | Blocked on file format |
| Public API and webhooks | The integration story above | Not started |
