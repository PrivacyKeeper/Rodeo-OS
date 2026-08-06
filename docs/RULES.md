# Rule provenance

Last reviewed: **8 August 2026**

Every rule this platform enforces is data in `scoring_configs`,
`payout_configs` or `division_templates` — never code. This file records where
each value came from and when it was checked, so the next person to touch a
config knows whether they are editing something confirmed or something
provisional.

Two flags in every config carry this into the database:

- `"verified_against"` / `"verified_on"` — sourced and dated.
- `"unverified": true` with an `"unverified_note"` — **do not run a sanctioned
  rodeo on it.** The values are plausible defaults, nothing more.

---

## Confirmed — roughstock

| Rule | Value | Source |
|---|---|---|
| PRCA qualified ride | 8 seconds, one hand | PRCA 2026 |
| PRCA judges | 2, each marking animal 0–25 and rider 0–25 | PRCA 2026 |
| PRCA score total | Sum of four marks, out of 100 | PRCA 2026 |
| PRCA increment | 0.5 | PRCA 2026 |
| Mark-out | Required in bareback and saddle bronc; feet above the point of the shoulders when the horse's front feet hit the ground. **Not** required in bull riding | PRCA 2026 |

### PBR 2026 — changed this season

PBR moved off half-point marking for the 2026 season, debuting at the
Pendleton Whisky Velocity Tour in St. Louis on 6 December and Unleash The Beast
in Manchester, NH on 12 December.

| Rule | Value |
|---|---|
| Judges | **4** |
| Each judge marks | Rider 0–25, bull 0–25 |
| Official score | All eight marks combined, **divided by two** → out of 100 |
| Increment | **0.1** (was 0.5) |
| Variance cap | A rider's score may not exceed the bull's by more than **3.0**. A rider may be marked **any** amount below the bull score |

The change followed a two-year study of more than 15,500 premier-level outs,
which found bull performance at the top tier exceptionally consistent — the
finer increment exists to separate rides that half-points could not.

> **This corrected a defect.** The config originally seeded here modelled a
> single judge marking 0–50 per side. That validates a one-card ride as
> complete, and once four real cards arrive it records a 90-point ride as 180.
> Fixed in migration `0012`; see SPEC-DELTAS D21.

The variance cap is implemented as a **review flag, not a rejection** — a
breach is surfaced to the secretary and the ride still scores. See SPEC-DELTAS
D11 for why.

---

## Confirmed — timed events

| Event | Rule | Value |
|---|---|---|
| Tie-down roping | Barrier break | 10 s (PRCA) |
| Tie-down roping | Tie must hold after the roper remounts and slackens the rope | 6 s |
| Steer wrestling | Barrier break | 10 s (PRCA) |
| Team roping | Barrier break | 10 s (PRCA) |
| Team roping | Single hind leg | 5 s |
| Barrel racing | Each barrel knocked over | 5 s |
| Breakaway roping | Barrier break | 10 s |

Barrel knockdowns are the only **repeatable** penalty in the seeded configs —
two barrels is 10 seconds, not 5. Everything else applies once however many
times it is submitted. (Migration `0012` fixed the WPRA config, which had not
set the flag.)

### Breakaway equipment (WPRA)

Rope tied at the end with fully intact #18 brightly coloured twisted or braided
mason line, secured with a minimum of three knots to the saddle, plus a bright
solid-colour cloth of at least 12" × 12" attached to the end of the rope.
Recorded here for the compliance module; not yet enforced in code.

---

## Confirmed — numbered (handicap) roping

This is the format most of the platform's ropers actually enter, and it is
absent from Architecture v1.0 entirely. Added in migration `0011`.

| Rule | Value | Association |
|---|---|---|
| Barrier break | **5 s** — *not* the 10 s PRCA assesses | USTRC |
| Single hind leg | 5 s | USTRC |
| Number range | Headers 1–9, heelers 1–10 (TRIAD) | USTRC |
| Division end caps | Real and enforced — e.g. a #7 with a header cap of 4 and a heeler cap of 3 | USTRC |
| #7.5 cap | Capped at a #4 on **both** ends | WSTR |
| #7.5 exclusion | No #4.5 ropers, heading or heeling | WSTR |
| #7 → #7.5 | The #7 became the #7.5 when Global Handicaps added the #3.5 classification, allowing a #3.5 + #4 combination | WSTR |

Classification is managed for WSTR by Global Handicaps.

**Numbers are snapshotted at entry.** `entries.header_number` and
`entries.heeler_number` record what the ropers were when they entered. If a
roper is raised between entering and roping, the team stays eligible for the
division they legally entered — reading the current number at payout time
would retroactively disqualify them and force a clawback through an
append-only ledger.

---

## NOT confirmed — do not rely on these

Every item below ships flagged `"unverified": true`.

| Item | What is missing | Blocks |
|---|---|---|
| **Crossfire standard** | Is the violation judged at rope release, or at contact? | USTRC and WSTR team roping configs |
| **Tie-on eligibility thresholds** | Which handicap numbers may tie on, under which association | Team roping entry validation |
| **Jerk-down consequence** | No-time, or a fine? | Tie-down roping DQ triggers |
| Full USTRC 2026 division ladder | Only the shape is known, not every division's exact caps | `USTRC Standard Ladder 2026` |
| Full WSTR 2026 division ladder | #7.5 confirmed; the rest is illustrative | `WSTR Standard Ladder 2026` |
| Elite rule wording | Which ropers are protected and from which divisions | `elite_excluded` on both ladders |
| CPRA "number of monies" thresholds | Exact purse-size boundaries for the 4/6/8/12/15 splits | `CPRA Canada 2026` payout config |
| PRCA full penalty and fee schedule | Complete per-event fee percentages | Producer fee structures |
| NBHA >12-place approval | District Director approval workflow | Large NBHA jackpots |
| Brazil Nota Fiscal | Technical requirements for electronic invoicing | End-to-end BR withholding |
| Stripe Connect Express in AU | Whether Express accounts are available to AU stock contractors | AU payouts |
| FarmTek Polaris variants | Protocol differences across the five hardware versions | Timer Bridge on older units |

The first three are decisions a sanctioning body has to make, not facts to look
up. They have been open since the discipline sites were built and still need an
answer.

---

## How to update a rule

1. Confirm the value against a primary source — the association's own rulebook
   or announcement, not a rodeo-101 page.
2. Add a **new** config row with a later `effective_date`. Do not edit a config
   that has already scored a rodeo: `scores.scoring_config_id` points at it,
   and historical results have to stay reproducible.
3. Set `verified_against` and `verified_on`; remove `unverified`.
4. Record the source here.

---

## Sources

- [PBR — enhanced scoring system for 2026, tenth-point increments](https://www.pbr.com/news/2025/11/pbr-enhances-scoring-system-for-2026-season-marking-riders-and-bulls-in-tenth-point-increments/)
- [PBR 101](https://www.pbr.com/about/pbr-101/)
- [PRCA — Rodeo Terminology](https://www.prorodeo.com/prorodeo/rodeo/rodeo-terminology)
- [WPRA Rule Book](https://wpra.com/rule-book/)
- [USTRC Rulebook](https://www.ustrc.com/knowledge/Rulebook/USTRCRulebook.pdf)
- [USTRC — FAQ and TRIAD classification](https://www.ustrc.com/Knowledge/faq.asp)
- [World Series of Team Roping — Rules](https://wstroping.com/rules.aspx)
- [National Western Stock Show — Rodeo 101](https://nationalwestern.com/rodeos/rodeo-101/)
