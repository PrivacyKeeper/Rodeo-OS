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

## The model

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

## Open questions worth deciding before launch

1. **Cash and check entries.** Money taken at the desk never crosses a card,
   so no platform fee is collected. A jackpot could run entirely on cash and
   pay nothing. Options: a small flat per-entry fee on cash entries, or accept
   it as the price of getting the software into the arena. **Recommendation:
   accept it.** Chasing $1 on a cash entry is how you lose the producer.
2. **Association bulk subscriptions.** A state association buying subscriptions
   for its whole membership is worth more than the same conversions one at a
   time, and it makes the association the seller. Needs a channel price.
3. **Whether the producer may absorb the platform fee** for their contestants
   as a premium feature. The engine already supports `card_fees: 'producer'`;
   the platform fee equivalent is a one-line config.
4. **Stripe Connect pricing tier.** 2.9% + $0.30 is the standard rate. At
   volume this is negotiable, and every basis point comes straight off what a
   contestant pays.
