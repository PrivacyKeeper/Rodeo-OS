# Build order

Follows Appendix C of the architecture, adjusted for what is already done.

---

## Done

**Schema.** 22 tables across 10 migrations, with RLS bound to `auth.uid()`,
composite tenant foreign keys, append-only triggers on the ledger and on signed
waivers, and system scoring and payout templates for PRCA, PBR, WPRA, NBHA,
IPRA and CPRA.

**Scoring engine.** Judged and timed modes, config-driven validation
(range, increment, judge count, variance cap, mark-out, DQ triggers), standard
competition ranking with tie detection, multi-round aggregation, D-format
division assignment.

**Payout engine.** Fee deduction with destinations, payout ladder selection,
tie combine-and-split, ground money, cowboy rules, escrow, multi-round go-round
plus average, IPRA three-head 2:2:3, day money, stock contractor share, PESI
60/40, and cross-border withholding for CA, AU and BR. Cent-exact throughout.

**API contracts.** Route definitions with JSON Schema validation, JWT auth and
the permission matrix, typed event bus, offline sync authority resolution,
public results and SSE.

---

## Next: wire persistence

Nothing else can be demonstrated until this is done. Every API module declares
its storage needs as named functions that currently throw. They are the
complete list of what the data layer has to provide:

| Function | Module |
|---|---|
| `loadScoringConfig` | scoring |
| `persistScore` | scoring |
| `finalizeScore` | scoring |
| `loadPayoutContext` | payouts |
| `disburse` | payouts |
| `loadServerState` | sync |
| `applyChange` | sync |
| `changesSince` | sync |
| `loadPublicResults` | public |
| `loadStandings` | public |

Also needed:

1. Drizzle schema generated from the migrations, plus a Supabase client factory
   that binds the caller's access token per request so RLS applies.
2. A Supabase Auth custom-access-token hook that writes `user_id` and
   `org_memberships` into the JWT from `org_members`.
3. Stripe Connect onboarding for organisations and for contestants who receive
   payouts.

Deliverable: a rodeo can be created, entered, scored and paid out end to end
through the API.

---

## Phase 1 — Core, events, entries (weeks 1–6)

- Organisation and user management, invitations, role assignment
- Rodeo and rodeo-event CRUD, sanctioning approvals, performances
- Online entry with fee collection via Stripe
- Draw generation, buddy groups, stock draw
- Contestant portal: enter, view entries, view draw

## Phase 2 — Scoring, results, payouts in the UI (weeks 7–12)

- Secretary terminal: manual score entry, correction, DQ, reride
- Results calculation and publication, go-round and average standings
- Payout calculation review screen, then disbursement
- Public results pages with SEO

## Phase 3 — Offline, timer, live (weeks 13–16)

- PWA shell, service worker, IndexedDB via Dexie
- Sync queue against the authority model already implemented
- Timer Bridge (Tauri) for FarmTek Polaris and Daktronics OmniSport 2000
- Live SSE broadcast to spectators, WebSocket to arena terminals

## Phase 4 — Compliance and reporting

- Waiver signing flow with PDF generation
- Insurance certificate tracking and expiry alerts
- 1099 / T4A-NR / PAYG generation
- PROCOM import and export, once the file format is obtained

---

## Blocked on outside information

These cannot be built correctly from what is available. Each is Appendix B of
the architecture; none has moved.

| Needed | Blocks | How to get it |
|---|---|---|
| PRCA rulebook penalty and fee tables | Certified PRCA configs | PRCA member access |
| PBR 2026 full variance provisions | Certified PBR config | PBR membership packet |
| CPRA number-of-monies thresholds | Canadian payout ladders | CPRA rulebook PDF |
| PROCOM file format | Entry import, results export | PRCA IT, sample day sheets |
| Stripe Connect Express in AU | AU contractor payouts | Stripe docs |
| NBHA >12-place approval process | Large NBHA jackpots | NBHA |
| Brazil Nota Fiscal requirements | End-to-end BR withholding | Brazilian tax consultant |
| FarmTek Polaris protocol across 5 versions | Timer Bridge on older units | Hardware for testing |

Until a rulebook is in hand, the matching template carries `"unverified": true`
in its config and must not be used for a sanctioned rodeo.

---

## Three rule conflicts still unresolved

Flagged during the discipline-site build and not settled since. Each needs a
decision from the sanctioning body before the affected config can be marked
verified:

1. **Crossfire standard** — is the violation judged at rope release or at
   contact?
2. **Tie-on eligibility thresholds** — which handicap numbers, under which
   association.
3. **Jerk-down consequence** — no-time, or fine?
