# Pricing

Last modelled: **8 August 2026**

Every number here is produced by `packages/engine/src/pricing/engine.ts` and
held by 18 tests. Change the rate and the tests tell you whether you are still
cheaper than the competition — the business model is executable, not a
spreadsheet somebody has to remember to update.

---

## What the field actually charges

Not an estimate. Published rates:

| Platform | Headline | Card processing | All-in on a $100 entry |
|---|---|---|---|
| **RodeoReady** | 5.5% + $0.35, paid by the contestant | **Included** — they pay ~3% out of it | **$5.85** |
| **Rodeo Producer** | 1% admin fee | **On top** (~2.9% + $0.30) | **$4.23** |
| **RodeoApps** | 2.0%, paid by the contestant | On top | **$5.26** |
| **RodeoApps subscriber** | **0%** | On top | **$3.20** |

Rodeo Producer also charges the producer $25–50 per rodeo when online payment
adoption is under 25%, and nothing when it is above.

**The whole field already gives the software away and taxes the contestant.**
Charging producers a licence fee is not an option — it is a reason to be
ignored.

### The mistake this model caught

The first draft set the rate at 4.9% + $0.30, reasoning that it "undercuts
RodeoReady's 5.5%." Modelled properly that is **$8.55 all-in** — half again
more expensive than the competitor it was meant to beat, because RodeoReady's
5.5% *includes* card processing and ours stacked on top of it.

Comparing headline rates across platforms that treat processing differently is
exactly how a company prices itself out of a market it thinks it is winning.
`compareAllIn()` exists so that cannot happen again, and a test asserts we are
cheaper than RodeoReady at every entry size from $25 to $500.

---

## The recommendation: flat, tiered, and we take nothing on the money

**Revised 8 August 2026.** The first version of this document recommended
taking 2% of every entry. That was modelled from competitor rates and the
Procore pattern, and it optimised for one thing — zero adoption barrier —
while underweighting the thing that actually decides whether a platform gets
adopted at all: **somebody has to sell it.**

A percentage of every entry is a hard conversation with a volunteer committee
secretary. A single monthly number is one sentence. Re-modelled, the flat plan
also wins on three things the percentage model loses outright:

1. **Cash rodeos.** A jackpot run out of a cash box pays a percentage model
   **nothing**. A subscription is independent of how the money moved, and a
   large share of ropings and small rodeos still run on cash.
2. **The contestant price.** Taking zero on the money flow makes this the
   cheapest place in the country to enter a rodeo — **$103.20 on a $100
   entry, card cost only**, for everyone, not just subscribers. That is a
   producer's argument to their own field, not just ours to them.
3. **Predictability.** Producers budget. So do we.

The percentage model bills more in a mature market. It is worse at getting to
one. Both are implemented; the flat ladder is the default.

---

## The ladder

| Plan | Price | Entries/yr | What it adds |
|---|---|---|---|
| **Grassroots** | **Free** | ≤ 100 | Events, entries, contestants, results, waivers |
| **Club** | $9.99/mo · $99.90/yr | ≤ 500 | + scoring, payouts |
| **Starter** | $29.99/mo · $299.90/yr | ≤ 1,500 | + sidepots |
| **Pro** | $99/mo · $990/yr | ≤ 10,000 | + timer, broadcast, stock, analytics, handicap |
| **Association** | $299/mo · $2,990/yr | unlimited | + multi-rodeo series, tax reporting |

**Stripe at cost on top. We add nothing to the money flow.**

Two rungs exist for reasons the model forced, not for tidiness:

- **Grassroots is free** as defence, not generosity. Rodeo Producer is
  effectively free to a producer who takes online payments; a $29.99 floor
  would hand them every playday in the country.
- **Club exists because the flat model has a trap.** A weekly roping doing 200
  entries a year at $50 a head is over the free cap but nowhere near worth
  $29.99 a month — against a 2% cut it would be paying **more** for the flat
  plan. That single outcome collapses the whole pitch, and a test now asserts
  it cannot happen at any size.

Every producer above the free tier pays less than a 2% cut would have taken:

| Producer | Entries/yr | Plan | Pays | 2% would be |
|---|---|---|---|---|
| Playday, 3 a year | 60 | Grassroots | **$0** | $30 |
| Local committee | 300 | Club | **$99.90** | $600 |
| Weekly roping | 1,200 | Starter | **$299.90** | $1,200 |
| Multi-rodeo producer | 2,400 | Pro | **$990** | $6,000 |
| Association | 10,000 | Pro | **$990** | $30,000 |

---

## The old model, kept for comparison

**Three legs. The producer pays for none of them.**

### 1. The OS is free to the producer

Everything needed to run a rodeo: entries, draw, stock draw, scoring, results,
payouts, settlement, day sheets, public results page. No per-rodeo fee, no
seat fee, no setup fee, no minimum.

This is not generosity. Committees are volunteer-run and price-sensitive, the
competition is already at zero, and **the producer is not the customer — they
are the distribution channel.** Every rodeo run on the platform puts its whole
field of contestants into it.

### 2. The contestant pays a platform fee — unless they subscribe

*(Not recommended — see the ladder above. Retained because the engine
implements both and a percentage may be right for a specific channel deal.)*

**2.0% of the entry, capped at $15. Subscribers pay nothing.**

That gap is the product. A contestant who subscribes does not get a discount
on an app; they stop paying convenience fees at every rodeo they enter for the
rest of the year.

| Entry | Non-subscriber pays | Subscriber pays | Saved |
|---|---|---|---|
| $50 | $2.78 | $1.75 | $1.00 |
| $100 | $5.26 | $3.20 | $2.00 |
| $150 | $7.74 | $4.65 | $3.00 |
| $300 | $15.17 | $9.00 | $6.00 |

*(Subscriber still pays card processing; the platform fee is zero.)*

### 3. Producer premium modules and association licences

The tiers already exist in `org_modules`. Core is free forever. Timer
integration, live broadcast, analytics, multi-rodeo series and tax reporting
are for operations big enough to pay, and an association licence covers
circuit standings and member management.

Indicative: **$39/month premium, $2,400/year association.** At 150 premium
producers and 30 associations that is **~$142k/year** on top of transactions —
and it is the leg that scales with the *size* of the operator rather than the
number of entries.

---

## Break-even on the subscription

$49.99/year against the fee saved per entry:

| Average entry | Saved per entry | Entries a year to break even |
|---|---|---|
| $50 | $1.00 | 50 |
| $100 | $2.00 | 25 |
| $150 | $3.00 | 17 |
| $300 | $6.00 | 9 |

**Read this honestly.** A weekend jackpot roper entering twelve times at $50
will not save money on fees, and the subscription must not be sold to them as
if they will. They buy it for the app — the draw in their pocket, their run
history, the standings, the community.

A serious amateur or a professional clears break-even inside a season and then
rides free for the rest of it. That is who the pitch is aimed at, and there is
a test asserting the maths holds for them.

---

## The revenue trade, stated plainly

Converting a heavy user to a subscriber **earns us less money**:

| Profile | As a payer | As a subscriber |
|---|---|---|
| Weekend roper (12 × $60) | $14 | $52 |
| Serious amateur (45 × $100) | $90 | $52 |
| Professional (120 × $150) | $360 | $52 |

At 500 rodeos a year, 150 entries each:

| Subscribed | Transaction | Subscription | Total | vs 0% |
|---|---|---|---|---|
| 0% | $150,000 | $0 | $150,000 | — |
| 25% | $112,500 | $32,494 | $144,994 | −3% |
| 50% | $75,000 | $64,988 | $139,988 | −7% |
| 100% | $0 | $129,975 | $129,975 | **−13%** |

**Full subscription costs 13% of revenue and makes 100% of it recurring.**

At a 2% take rate that trade is close to free, and it is the right one:
recurring revenue is worth a multiple of transactional revenue, it survives a
bad season, and it is what makes nine consumer apps a business rather than a
marketing expense. At the 4.9% rate the first draft proposed, the same trade
would have cost 40% — which is why the rate and the subscription have to be
designed together.

---

## How the OS and the nine apps feed each other

This is the part no competitor can copy quickly, because they have no consumer
subscription and no reason to build one.

### The OS makes the apps worth $4.99

Without it the apps are social apps with nothing in them. With it, every app
holds the things a contestant actually wants:

- **Their draw**, pushed the moment the secretary commits it
- **Live results** as the rodeo runs — already public by policy (D30)
- **Their career record** — every run, every time, every score, every cheque
- **Season standings and earnings**, computed from real results (D29)
- **Fee-free entry** at every rodeo on the platform

None of that is available to a contestant whose rodeos are not on the OS. The
app is only as good as the data behind it, and the OS is the data.

### The apps make producers adopt the OS

A producer switches software for one of two reasons: it is cheaper, or it is
where the contestants are. The apps deliver both.

- **"Your ropers pay less here."** A producer moving off RodeoReady can tell
  their field they will pay $3.20 instead of $5.85, and subscribers pay the
  least of anyone in the sport. That is a switching argument with no software
  features in it at all.
- **Entries arrive.** Contestants already in the app see the rodeo, get the
  reminder, and enter in two taps against a saved profile.
- **Nine front doors.** A bull rider finds the rodeo through bullrider.pro; a
  barrel racer through barrelconnect.pro. The producer lists once.

### The loop

```
  Producer runs a rodeo free on the OS
            │
            ▼
  Their whole field lands in the apps (draw, results, earnings)
            │
            ▼
  Contestants subscribe — fee-free entry plus their career record
            │
            ▼
  Subscribers concentrate on rodeos that are ON the platform
            │
            ▼
  Producers adopt the OS to reach them  ──┐
            ▲                              │
            └──────────────────────────────┘
```

Procore ran the same loop: free for subcontractors, paid for the GC, and the
subs became the reason every GC needed it. The rodeo version inverts who pays
— the producer is free and the contestant subscribes — because in rodeo the
contestants outnumber the producers by three orders of magnitude and they are
the ones already being charged.

---

## What to do about the free-rider

A producer could take entries on the platform and never pay a cent, and their
contestants could all decline to subscribe. That is fine, and it is priced:
2% on every entry, which is under what they pay elsewhere. The platform earns
either way. **There is no configuration in which running a rodeo here is worse
for the producer than running it somewhere else.**

---

## What the $4.99 contestant subscription is for, now

Under the flat model there is **no fee to avoid**, so the subscription has to
stand on its own — and it should. Sold honestly it is: nine apps for one price,
the draw in your pocket, live results, your whole career record, season
earnings and standings, and the community for your event.

That is a consumer product at Spotify money. It is a **better** proposition
than "avoid a $2 fee", because it does not depend on the contestant entering
enough rodeos for the arithmetic to work — the weekend roper who would never
have cleared the fee break-even is now a legitimate customer rather than
somebody being sold a discount they will not use.

The two products stay separate, aimed at two different people:

- **Producers** pay for the OS, by plan.
- **Contestants** pay $4.99/mo or $49.99/yr for the apps.

Neither subsidises the other on paper, and both make the other worth having.

---

## Should we add anything on top?

**No — not yet, and probably not on the money flow.** Stacking a per-entry fee
on a subscription is the worst of both: it loses the "we don't touch your
contestants' money" pitch, which is the sharpest differentiator available, and
it still leaves a subscription to sell.

Three add-ons are clean because they are sold to the same buyer and explain
themselves:

1. **Higher plan rungs** — already the ladder.
2. **Sponsorship and ticketing** — producer revenue tools, a natural upsell.
3. **Association channel deals** — bulk contestant subscriptions sold through
   a state association, which makes the association the salesforce.

One worth watching: at zero take on the money flow, the platform still carries
the **operational cost and risk of being in the payment path** — chargebacks,
disputes, connected-account onboarding, and reporting obligations as the
facilitator. If that proves expensive, a small **flat** per-transaction fee
(cents, not a percentage) preserves the "no percentage" position while covering
it. Worth confirming with an accountant before launch rather than assuming.

---

## Open questions worth deciding before launch

1. ~~**Cash and check entries.**~~ **Solved by the flat model** — the
   subscription does not care how the money moved. This was the strongest
   single argument against taking a percentage, and it only became obvious
   once both models were run side by side.
2. **Association bulk subscriptions.** A state association buying subscriptions
   for its whole membership is worth more than the same conversions one at a
   time, and it makes the association the seller. Needs a channel price.
3. **Whether the producer may absorb the platform fee** for their contestants
   as a premium feature. The engine already supports `card_fees: 'producer'`;
   the platform fee equivalent is a one-line config.
4. **Stripe Connect pricing tier.** 2.9% + $0.30 is the standard rate. At
   volume this is negotiable, and every basis point comes straight off what a
   contestant pays.
