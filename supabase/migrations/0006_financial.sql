-- ============================================================================
-- 0006_financial.sql
-- Append-only money ledger and escrow carryover.
--
-- Architecture ref: §2.2.8
--
-- Nothing in this file is ever updated or deleted. A correction is a new
-- 'adjustment' row (§2.4 #3). Enforcement is by TRIGGER, not by RLS: the API
-- server connects with the service role, which bypasses RLS entirely, so an
-- RLS-only rule would protect against everything except the one process that
-- actually writes here. See docs/SPEC-DELTAS.md D9.
-- ============================================================================

create table financial_transactions (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete restrict,
    rodeo_id    uuid,

    from_user_id uuid references users (id),
    to_user_id   uuid references users (id),

    transaction_type text not null check (transaction_type in (
                    'entry_fee', 'added_money', 'payout_prize',
                    'payout_ground_money', 'payout_day_money',
                    'payout_bonus', 'payout_stock_contractor',
                    'fee_office', 'fee_facility', 'fee_admin',
                    'fee_cres', 'fee_sports_medicine', 'fee_circuit',
                    'fee_insurance', 'fee_platform',
                    'withholding_tax', 'refund', 'escrow_hold',
                    'escrow_release', 'adjustment'
                )),

    -- Signed amounts are disallowed. Direction is carried by from/to and by
    -- transaction_type; a reversal is a new row, not a negative one.
    amount      decimal(12, 2) not null check (amount >= 0),
    currency    text not null default 'USD',

    stripe_payment_intent_id text,
    stripe_transfer_id       text,
    stripe_refund_id         text,

    -- Cross-border withholding (§6.6)
    withholding_rule   text check (withholding_rule in ('reg_105', 'payg_no_abn', 'irrf')),
    withholding_rate   decimal(5, 4) check (withholding_rate between 0 and 1),
    withholding_amount decimal(12, 2) check (withholding_amount >= 0),
    gross_amount       decimal(12, 2) check (gross_amount >= 0),
    exemption_applied  text,

    rodeo_event_id uuid,
    entry_id       uuid,
    result_id      uuid,

    status      text not null default 'pending' check (status in (
                    'pending', 'completed', 'failed', 'refunded',
                    'held', 'released'
                )),

    description text,
    metadata    jsonb not null default '{}'::jsonb,

    -- Idempotency. The payout engine is deterministic and re-runnable (§6.1);
    -- this key is what stops a re-run from double-paying.
    idempotency_key text,

    created_at  timestamptz not null default now(),

    foreign key (org_id, rodeo_id) references rodeos (org_id, id),
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id),
    foreign key (org_id, entry_id) references entries (org_id, id),
    foreign key (org_id, result_id) references results (org_id, id)
);

create unique index idx_txn_idempotency
    on financial_transactions (org_id, idempotency_key)
    where idempotency_key is not null;

create index idx_txn_rodeo on financial_transactions (org_id, rodeo_id);
create index idx_txn_user on financial_transactions (org_id, to_user_id);
create index idx_txn_stripe on financial_transactions (stripe_payment_intent_id);
create index idx_txn_type on financial_transactions (org_id, transaction_type, created_at);

-- ----------------------------------------------------------------------------
-- Status is the one thing that legitimately changes (pending -> completed),
-- so the ledger row itself stays immutable and status lives beside it.
-- ----------------------------------------------------------------------------
create table transaction_status_events (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete restrict,
    transaction_id uuid not null references financial_transactions (id),

    from_status text,
    to_status   text not null,
    reason      text,
    actor_id    uuid references users (id),

    created_at  timestamptz not null default now()
);

create index idx_txn_status_events on transaction_status_events (transaction_id, created_at);

-- ----------------------------------------------------------------------------
-- Escrow carryover (CPRA Canada: no qualified contestant -> purse holds over)
-- ----------------------------------------------------------------------------
create table escrow_records (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete restrict,

    source_rodeo_id uuid not null,
    source_event_id uuid not null,

    amount      decimal(12, 2) not null check (amount > 0),
    currency    text not null default 'CAD',
    reason      text not null,              -- 'no_qualified_contestants'

    target_rodeo_id uuid,                   -- next year's rodeo, once it exists
    target_year     int not null,

    status      text not null default 'held' check (status in (
                    'held', 'released', 'expired', 'transferred'
                )),
    released_at timestamptz,

    created_at  timestamptz not null default now(),

    foreign key (org_id, source_rodeo_id) references rodeos (org_id, id),
    foreign key (org_id, source_event_id) references rodeo_events (org_id, id),
    foreign key (org_id, target_rodeo_id) references rodeos (org_id, id)
);

create index idx_escrow_target on escrow_records (org_id, target_year, status);
