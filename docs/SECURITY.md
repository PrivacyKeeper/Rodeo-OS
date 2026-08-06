# Security model

Architecture ref: §7.7, §2.1, §4.2.

Three things in this system are worth attacking: one producer's data from
another producer's account, the money ledger, and signed waivers. Everything
below is organised around those.

---

## 1. Tenant isolation

**The rule:** a request can only see rows belonging to an organisation the
authenticated user is an accepted member of, and the database — not the
application — is what enforces it.

The tenant is derived from `auth.uid()`, the subject Supabase Auth signs into
the JWT. A client cannot set it, forge it, or talk the database out of it.
Membership is resolved through `org_members`:

```sql
create policy rodeos_member_read on rodeos
    for select using (app_is_org_member(org_id));
```

`app_is_org_member()` and its siblings are `SECURITY DEFINER STABLE` so the
membership join runs once per statement and does not recurse into RLS.

**What was rejected, and why it matters.** Architecture §2.1 specifies
`current_setting('app.current_org_id')`, set by middleware from a URL path
parameter via string interpolation. That is an injection site, it is an
assertion by the application rather than a proof from the token, and no
Supabase client executes the `SET` at all. Delta D1 has the full argument.

**Composite foreign keys.** `unique (org_id, id)` on every tenant-scoped
parent, and `foreign key (org_id, parent_id) references parent (org_id, id)` on
every child. A `scores` row in tenant A physically cannot point at a
`rodeo_events` row in tenant B. §2.4 of the architecture claims this; it is
actually implemented here.

**Service role.** `SUPABASE_SERVICE_ROLE_KEY` is `BYPASSRLS`. It is used only
by background jobs with no user context — nightly exports, Stripe webhook
handlers. Request handling forwards the caller's own access token so RLS
applies. Any new code path reaching for the service role during a request is a
bug.

---

## 2. Money

**Append-only, enforced by triggers.** `financial_transactions`,
`transaction_status_events`, `signed_waivers` and `audit_log` reject `UPDATE`
and `DELETE` from a `BEFORE` trigger. Triggers bind every role including the
service role; RLS policies do not, which is why the architecture's RLS-based
approach would have left the ledger open to precisely the process that writes
to it (delta D9). A correction is an `adjustment` row.

**Reconciliation is a hard invariant, not a metric.** The payout engine
allocates in integer cents by largest remainder and asserts that the lines sum
to the pool before returning. The API re-checks
`payouts + unpaid + escrow == net_purse` and returns `500
PAYOUT_DOES_NOT_RECONCILE` rather than serve numbers that do not balance.
Nothing is written on that path.

**Idempotency.** `financial_transactions.idempotency_key` is uniquely indexed
per org. Disbursement requires an explicit key and `confirm: true`. A retried
request after a network timeout cannot pay twice.

**Separation of duties.** `payout.calculate` is available to secretaries;
`payout.disburse` is owner and admin only. Calculation is side-effect free and
re-runnable, so a producer can look at the numbers as many times as they like
before money moves.

**Withholding is never silent.** Every cross-border deduction returns the rule
name, the form, the rate and an advisory string that the UI is required to
display. The engine computes an amount; it does not give tax advice, and it
never nets a deduction off without saying so.

---

## 3. Evidence

Signed waivers store a SHA-256 of the exact text the signer saw at signing
time, plus a hash over the whole record, plus IP and user agent. They are
insertable only by the signer or their guardian — a policy, not a convention:
staff cannot sign on a contestant's behalf. They are never updatable or
deletable.

Score edits are allowed but not erasable. A trigger appends every change to
`final_score`, `final_time` or `status` onto `scores.edit_history`, so an edit
made by going around the API is still recorded. Deleting an official or
disqualified score is refused outright.

---

## 4. Input handling

- Every route declares a JSON Schema. Fastify rejects unknown properties before
  a handler runs.
- No SQL is built by string concatenation anywhere. Path parameters that reach
  a query are UUID-validated first, which turns a malformed request into a 400
  rather than a database error.
- Sync batches are capped at 500 changes per request.
- Rate limits per §4.3, keyed by org for authenticated routes and by IP for
  public ones.

---

## 5. Roles

`org_members.role` is one of fourteen arena roles. The permission matrix in
`apps/api/src/core/auth.ts` maps actions to roles, and route guards check it.

That guard is a fast rejection at the edge, **not the security boundary**. The
boundary is RLS, running on the caller's own token. If the guard were removed
entirely, a judge still could not disburse a payout, because
`app_can_view_financials()` does not include `judge`.

---

## 6. Open items

| Item | Status |
|---|---|
| Penetration test | Not done |
| SOC 2 | Phase 4 per §7.2 |
| Supabase Auth custom-access-token hook that writes `org_memberships` into the JWT | Required before deploy; the API reads the claim but the database re-derives membership independently, so a stale claim cannot widen access |
| Secret rotation runbook | Not written |
| Storage-bucket policies for waiver PDFs and insurance certificates | Not written — must match the table policies in `0008_rls.sql` |

### Note for the wider portfolio

`barrelconnect-mobile-app` has an Android signing keystore committed to source
control at `src/assets/keystore/barrel-connect.keystore`. A signing key cannot
be rotated without breaking upgrades for every installed user, so removing it
from history does not undo the exposure. That is outside this repository, but
it is the highest-severity item across the portfolio and it should be triaged
before this platform ships alongside those apps.
