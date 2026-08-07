# Audit: can this actually run a rodeo?

Date: **8 August 2026**

Not a code review. Four real rodeos, modelled with their real formats and real
money, run end to end through the engine and the database. Where something
broke it is written down here; where a format cannot be expressed it says so.

Every claim below is backed by an executable test in
`packages/engine/test/scenarios.test.ts`,
`packages/engine/test/hardcases.test.ts` or
`apps/api/test/persistence.test.ts`.

**Result: 189 automated tests pass. One severity-1 defect was found and fixed
— team roping paid only half the team.**

| | |
|---|---|
| Migrations | 14/14 apply clean |
| Schema invariants | 15/15 |
| Tables with RLS | 29/29 |
| Typecheck | clean, both packages |
| Engine tests | 155 pass |
| Integration tests (real Postgres, real RLS) | 34 pass |

---

## The defect: team roping paid one roper, not two

**Severity 1. Found in the NFR walkthrough. Fixed.**

The engine ranked by `contestant_id` and had no concept of a team. A team
roping run is one time on the clock and **two** ropers, and the database made
it worse: `loadPayoutContext` read `scores` without joining `entries`, so
`partner_id` was never seen. A team roping payout named the header and the
heeler did not exist.

Getting this right also meant getting the *amount* right, and the two obvious
answers are both wrong:

- Pay the team the full place money and hand each roper that amount → **twice
  the purse goes out the door.**
- Split the place money in half → every roper is credited half what PRCA
  publishes, and the world standings are wrong all season.

The actual rule: both ropers pay an entry fee, so the purse is built from two
fees per team, and each end is credited the **full** amount — PRCA publishes
these as "$X-a-Man" and headers and heelers carry separate world standings.

Implemented as `payTeamPurse()`: split the purse into one equal pool per end,
then pay the identical team ranking out of each. Header and heeler receive the
same amount, that amount is what goes to the standings, and the total disbursed
equals the purse exactly.

The parity check, which is now a test: ten teams at $50 a man raises $1,000 and
pays its winner $500. Ten individuals at $50 raises $500 and pays its winner
$500. Same money per person for the same field size and fee — the equal-money
position the ropers put to the PRCA board.

Ranch rodeo works the other way (`split_between`): the team enters once and
divides its place money among its members. Both modes are supported and tested.

Also fixed: the payout ladder is now selected by **team count**, not roper
count. Six teams is a six-entry roping even though twelve fees came in.

---

## 1. Wrangler NFR — Las Vegas

10 rounds, 15 contestants, 7 events, no entry fees, fixed round pools.

| Check | Result |
|---|---|
| 10 go-rounds plus an average, ~$1.13m in one event | Reconciles to the cent |
| No entry fees, purse is added money only | Correct — gross = added |
| Six places paid per round, PRCA ladder | Correct |
| Two-way tie for a round win | Combined and split; next roper takes **third** |
| Bucked off in a round | Places in rounds, excluded from the average |
| Team roping, both ends paid | **Fixed** — see above |
| $17.5m purse | No precision loss; safely inside integer-cent range |

Round money at the NFR is a fixed dollar pool, not a percentage of entry fees.
The engine expresses this as added money with a go-round/average percentage
split, and it lands on the published figures.

**One honest note.** Tied contestants can differ by **one cent** when the
combined money is odd — it cannot divide exactly in half, and the alternative
is losing the cent. Which one receives it is deterministic, so a re-run pays
identically. A secretary should know this rather than be surprised by it.

---

## 2. Cheyenne Frontier Days — Wyoming

Tournament format: quarterfinals across six performances, semifinals, then
Championship Sunday.

| Check | Result |
|---|---|
| Top finishers per performance advance | Correct |
| Each stage pays its own pool | Correct, reconciles |
| **Clean slate in the final** | Correct — the final stands alone |
| Guard against running it as an average | Test proves the two differ |

**This is the format gap.** Championship Sunday starts from a clean slate:
scores from earlier rounds do **not** carry forward. Run through the average
engine, Cheyenne would crown the aggregate leader — the wrong champion. There
is a test that demonstrates exactly this divergence so nobody wires it up by
mistake.

The format *works* today by modelling each stage as its own event with its own
purse, which is what a secretary would do anyway. What does not exist is a
first-class tournament type that automates advancement. **Listed as missing
below rather than papered over.**

---

## 3. Local Texas rodeo

One go-round, small field, cash on the barrel head.

| Check | Result |
|---|---|
| 9 entered, 3 places paid, all caught | $705 gross → $617.70 net, exact |
| 9 entered, only **one** caught | The one roper takes the whole purse |
| 9 entered, **nobody** caught | Flagged for a human; nothing invented |
| Scratched and turned-out entries | Excluded from the purse |
| Bareback ride scored and ranked beside timed events | Correct |
| Missed mark-out | Disqualified, no score |

This is where most software quietly loses money — a short field means ground
money, and the architecture's own code re-derived places from array order and
ignored ties. Both are fixed and tested.

---

## 4. Oklahoma team roping jackpot

Handicap divisions, ropers entered more than once, sidepots, 100% payback.

| Check | Result |
|---|---|
| #4 heading for a #5 makes the #9 | Correct |
| #6 header barred from the #9 even at a #9 total | Correct — end caps enforced |
| USTRC **5-second** barrier, not PRCA's 10 | Correct |
| One roper on three teams | Each run ranks and pays separately |
| Same person placing twice | Paid twice, correctly |
| $20 sidepot, 100% payback | Exact, nothing held back |
| 13 teams × $37 = $481 split three ways | Every cent out |

---

## 5. Georgia / Florida 4D barrel race

| Check | Result |
|---|---|
| One barrel = 5s, two = 10s | Correct (repeatable penalty) |
| Off pattern | No-time, not a slow time |
| All four divisions paid from one purse | Reconciles; shares match config |
| Only the 1D fills | Empty divisions redistributed, nothing stranded |

---

## Hard cases

22 further tests covering the situations that go wrong on paper:

- Tie for the **last** paid place — splits only that place
- Tie spanning **past** the paid places — pulls in nothing extra
- **Everybody** ties — whole purse still goes out
- Two ties in one field (1st and 3rd)
- Tie inside a team event — every end paid
- $17.5m, $12, and **one cent** purses
- **10,000 consecutive purse sizes** — not one cent lost
- **Every field size from 1 to 60** — all reconcile
- Broken ladders, greedy fees, missing rungs — all refused, nothing paid
- Negative times, wrong-mode configs — refused
- Turnout mid-average, three-head average
- Day money rollover and odd splits
- Determinism: the same rodeo calculated twice is byte-identical

---

## Two of my own test expectations were wrong

Worth recording, because both were the engine being right:

1. A tie expectation used `Math.round(pool × (s0 + s1))` — naive per-group
   rounding. That is exactly the D16 bug removed from the engine, reintroduced
   in a test. The engine's largest-remainder allocation was correct.
2. A team parity expectation had the arithmetic wrong ($250 vs $500). Working
   it through confirmed the engine matches published PRCA results.

---

## Still missing — a secretary would notice these

Honest list. None of it is hidden behind a passing test.

| Gap | Impact | State |
|---|---|---|
| **Stripe Connect** | Ledger rows are written `pending`; no money actually moves | Not started |
| **Entry and draw endpoints** | Schema is complete, routes are not — entries must be loaded another way | Not started |
| **Sidepot routes** | Schema and the payout maths both work; no repository or API route yet | Schema only |
| **Tournament format** | Cheyenne works stage-by-stage; no automated advancement | By hand |
| **Auth hook** | `org_memberships` must be written into the JWT by a Supabase hook | Not written |
| **Web app / PWA** | No UI at all | Not started |
| **Timer Bridge** | No hardware integration | Not started |
| Results/standings writer | `results` table is read but nothing populates it from scores | Not started |

And unchanged from `RULES.md`: the **crossfire standard**, **tie-on
thresholds** and **jerk-down consequence** are still open, and the CPRA and
USTRC/WSTR division ladders remain `unverified`. Those are decisions a
sanctioning body has to make — no amount of testing settles them.

---

## What I would tell a producer today

The **money is trustworthy**. Scoring, ranking, ties, ground money, handicap
divisions, team roping, D-format and multi-round averages are correct against
real formats and real published figures, and the reconciliation guarantee holds
across 10,000 purse sizes. Tenant isolation is enforced by the database and
proved by tests that run as real users.

What it cannot do yet is **take an entry, make a draw, or move money.** Those
are the three things between this and a rodeo actually being run on it.
