-- ============================================================================
-- 0020_book_closures.sql
-- Closing the books, and proving when it happened.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS AN EVENT LOG AND NOT A STATUS COLUMN
-- ---------------------------------------------------------------------------
-- A rodeo's books are closed, then filed, and sometimes reopened because a
-- judge's sheet turns up with a time that was written down wrong. Modelling
-- that as a mutable status column throws away the only thing that matters in a
-- dispute: WHEN each of those happened, WHO did it, and WHAT the numbers were
-- at the time.
--
-- So this is append-only, in the same spirit as financial_transactions. Each
-- action writes a row carrying a full snapshot of the totals. Reopening does
-- not erase the earlier close; it records that a close was superseded, which
-- is exactly what an association or an auditor needs to see.
--
-- The totals_hash makes a later alteration detectable, the same technique the
-- signed waivers use.
-- ============================================================================

create table book_closures (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete restrict,
    rodeo_id    uuid not null,

    /** Monotonic per rodeo. 1 is the first close. */
    sequence    int not null check (sequence >= 1),

    closure_type text not null check (closure_type in ('closed', 'filed', 'reopened')),

    actor_id    uuid references users (id),
    occurred_at timestamptz not null default now(),

    -- ------------------------------------------------------------------
    -- Snapshot. Integer cents, so the record of what was settled cannot
    -- disagree with the ledger by a rounding step.
    -- ------------------------------------------------------------------
    entries_total   int not null default 0,
    entries_live    int not null default 0,
    fees_charged_cents  bigint not null default 0,
    fees_collected_cents bigint not null default 0,
    added_money_cents   bigint not null default 0,
    gross_purse_cents   bigint not null default 0,
    association_deduction_cents bigint not null default 0,
    net_purse_cents     bigint not null default 0,
    paid_out_cents      bigint not null default 0,
    ground_money_cents  bigint not null default 0,
    day_money_cents     bigint not null default 0,

    -- ------------------------------------------------------------------
    -- Filing
    -- ------------------------------------------------------------------
    association_code text,
    filing_due_at    timestamptz,
    filed_late       boolean,
    late_fee_cents   bigint check (late_fee_cents >= 0),
    filing_reference text,               -- the association's own receipt id

    /**
     * Warnings that were outstanding at the moment of closing. Blockers cannot
     * appear here by construction — the books do not close with a blocker —
     * but a warning that was accepted is part of the record of the decision.
     */
    warnings    jsonb not null default '[]'::jsonb,
    /** Required on a reopen, so a reversal always says why. */
    reason      text,

    /** SHA-256 over the snapshot, computed by the database on insert. */
    totals_hash text not null,

    created_at  timestamptz not null default now(),
    -- deliberately no updated_at

    unique (org_id, id),
    unique (rodeo_id, sequence),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete restrict,
    constraint reopen_needs_a_reason check (closure_type <> 'reopened' or reason is not null),
    constraint purse_reconciles check (
        net_purse_cents + association_deduction_cents = gross_purse_cents
    )
);

create index idx_book_closures on book_closures (org_id, rodeo_id, sequence desc);

-- ----------------------------------------------------------------------------
-- Hash the snapshot on the way in, so the value cannot be supplied by a caller
-- who would like it to match something other than the numbers.
-- ----------------------------------------------------------------------------
create or replace function hash_book_closure()
returns trigger
language plpgsql
as $$
begin
    new.totals_hash := encode(digest(concat_ws('|',
        new.rodeo_id::text, new.sequence::text, new.closure_type,
        new.entries_total::text, new.entries_live::text,
        new.fees_charged_cents::text, new.fees_collected_cents::text,
        new.added_money_cents::text, new.gross_purse_cents::text,
        new.association_deduction_cents::text, new.net_purse_cents::text,
        new.paid_out_cents::text, new.ground_money_cents::text,
        new.day_money_cents::text
    ), 'sha256'), 'hex');
    return new;
end;
$$;

create trigger book_closures_hash
    before insert on book_closures
    for each row execute function hash_book_closure();

-- Append-only. A close that can be edited is not evidence of anything.
create trigger book_closures_immutable
    before update or delete on book_closures
    for each row execute function reject_mutation();

alter table book_closures enable row level security;
alter table book_closures force row level security;

create policy book_closures_read on book_closures
    for select using (app_can_view_financials(org_id));

create policy book_closures_write on book_closures
    for insert with check (app_is_org_staff(org_id));

grant select, insert on book_closures to authenticated;

-- ----------------------------------------------------------------------------
-- Where a rodeo's books currently stand: the latest row wins.
-- ----------------------------------------------------------------------------
create view rodeo_book_state
with (security_invoker = true) as
select distinct on (bc.rodeo_id)
    bc.rodeo_id,
    bc.org_id,
    bc.sequence,
    bc.closure_type as state,
    bc.occurred_at,
    bc.actor_id,
    bc.net_purse_cents,
    bc.paid_out_cents,
    bc.filing_due_at,
    bc.filed_late,
    bc.filing_reference,
    bc.totals_hash
from book_closures bc
order by bc.rodeo_id, bc.sequence desc;

comment on view rodeo_book_state is
    'Current book state per rodeo — the most recent closure event. '
    'security_invoker so the reader''s own RLS still applies.';

grant select on rodeo_book_state to authenticated;

-- ----------------------------------------------------------------------------
-- Close the books.
--
-- One transaction that appends the closure, folds the results into the global
-- career record, and moves the rodeo's status. Doing these three separately
-- from the API would allow a rodeo whose books are closed but whose
-- contestants never got the run on their record.
--
-- The readiness check itself lives in the engine, not here: it is pure
-- arithmetic over data the API already has, it needs to run in the secretary's
-- browser before she commits, and a rule that has to be true in two places is
-- a rule that will disagree with itself. This function trusts that the caller
-- checked, and enforces only the invariants a database can enforce better than
-- application code -- reconciliation, immutability and authorisation.
-- ----------------------------------------------------------------------------
create or replace function close_rodeo_books(
    p_org_id      uuid,
    p_rodeo_id    uuid,
    p_actor_id    uuid,
    p_totals      jsonb,
    p_warnings    jsonb default '[]'::jsonb,
    p_association text default null,
    p_due_at      timestamptz default null
)
returns book_closures
language plpgsql
security definer
set search_path = public
as $$
declare
    v_seq int;
    v_row book_closures;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised to close the books for this organisation'
            using errcode = '42501';
    end if;

    perform 1 from rodeos where id = p_rodeo_id and org_id = p_org_id;
    if not found then
        raise exception 'rodeo not found in this organisation' using errcode = 'P0002';
    end if;

    select coalesce(max(sequence), 0) + 1 into v_seq
      from book_closures where rodeo_id = p_rodeo_id;

    insert into book_closures (
        org_id, rodeo_id, sequence, closure_type, actor_id,
        entries_total, entries_live,
        fees_charged_cents, fees_collected_cents, added_money_cents,
        gross_purse_cents, association_deduction_cents, net_purse_cents,
        paid_out_cents, ground_money_cents, day_money_cents,
        association_code, filing_due_at, warnings, totals_hash
    ) values (
        p_org_id, p_rodeo_id, v_seq, 'closed', p_actor_id,
        coalesce((p_totals ->> 'entries')::int, 0),
        coalesce((p_totals ->> 'live_entries')::int, 0),
        coalesce((p_totals ->> 'fees_charged_cents')::bigint, 0),
        coalesce((p_totals ->> 'fees_collected_cents')::bigint, 0),
        coalesce((p_totals ->> 'added_money_cents')::bigint, 0),
        coalesce((p_totals ->> 'gross_purse_cents')::bigint, 0),
        coalesce((p_totals ->> 'association_deduction_cents')::bigint, 0),
        coalesce((p_totals ->> 'net_purse_cents')::bigint, 0),
        coalesce((p_totals ->> 'paid_out_cents')::bigint, 0),
        coalesce((p_totals ->> 'ground_money_cents')::bigint, 0),
        coalesce((p_totals ->> 'day_money_cents')::bigint, 0),
        p_association, p_due_at, coalesce(p_warnings, '[]'::jsonb), ''
    )
    returning * into v_row;

    -- The contestants' records. A rodeo whose books are closed but whose runs
    -- never reached the people who made them is the fragmentation this whole
    -- platform exists to end, reproduced by our own omission.
    perform record_career_runs(p_org_id, p_rodeo_id);

    update rodeos
       set status = 'results_official', updated_at = now()
     where id = p_rodeo_id
       and org_id = p_org_id
       and status not in ('settled', 'cancelled');

    return v_row;
end;
$$;

comment on function close_rodeo_books is
    'Appends a closure, writes every official result into the global career '
    'record, and marks the rodeo official — in one transaction.';

/** Record that the association has it. */
create or replace function file_rodeo_books(
    p_org_id     uuid,
    p_rodeo_id   uuid,
    p_actor_id   uuid,
    p_reference  text default null,
    p_late       boolean default false,
    p_late_fee_cents bigint default null
)
returns book_closures
language plpgsql
security definer
set search_path = public
as $$
declare
    v_prev book_closures;
    v_row  book_closures;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised' using errcode = '42501';
    end if;

    select * into v_prev from book_closures
     where rodeo_id = p_rodeo_id and org_id = p_org_id
     order by sequence desc limit 1;

    if v_prev is null or v_prev.closure_type = 'reopened' then
        raise exception 'the books have not been closed' using errcode = 'P0002';
    end if;

    insert into book_closures (
        org_id, rodeo_id, sequence, closure_type, actor_id,
        entries_total, entries_live,
        fees_charged_cents, fees_collected_cents, added_money_cents,
        gross_purse_cents, association_deduction_cents, net_purse_cents,
        paid_out_cents, ground_money_cents, day_money_cents,
        association_code, filing_due_at, filed_late, late_fee_cents,
        filing_reference, totals_hash
    ) values (
        p_org_id, p_rodeo_id, v_prev.sequence + 1, 'filed', p_actor_id,
        v_prev.entries_total, v_prev.entries_live,
        v_prev.fees_charged_cents, v_prev.fees_collected_cents,
        v_prev.added_money_cents, v_prev.gross_purse_cents,
        v_prev.association_deduction_cents, v_prev.net_purse_cents,
        v_prev.paid_out_cents, v_prev.ground_money_cents, v_prev.day_money_cents,
        v_prev.association_code, v_prev.filing_due_at, p_late, p_late_fee_cents,
        p_reference, ''
    )
    returning * into v_row;

    update rodeos set status = 'settled', updated_at = now()
     where id = p_rodeo_id and org_id = p_org_id and status <> 'cancelled';

    return v_row;
end;
$$;

/** Reopen after a close, with a reason on the record. */
create or replace function reopen_rodeo_books(
    p_org_id   uuid,
    p_rodeo_id uuid,
    p_actor_id uuid,
    p_reason   text
)
returns book_closures
language plpgsql
security definer
set search_path = public
as $$
declare
    v_prev book_closures;
    v_row  book_closures;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised' using errcode = '42501';
    end if;
    if p_reason is null or length(trim(p_reason)) < 4 then
        raise exception 'reopening the books requires a reason' using errcode = '23514';
    end if;

    select * into v_prev from book_closures
     where rodeo_id = p_rodeo_id and org_id = p_org_id
     order by sequence desc limit 1;

    if v_prev is null then
        raise exception 'the books have never been closed' using errcode = 'P0002';
    end if;

    insert into book_closures (
        org_id, rodeo_id, sequence, closure_type, actor_id, reason,
        entries_total, entries_live,
        fees_charged_cents, fees_collected_cents, added_money_cents,
        gross_purse_cents, association_deduction_cents, net_purse_cents,
        paid_out_cents, ground_money_cents, day_money_cents,
        association_code, totals_hash
    ) values (
        p_org_id, p_rodeo_id, v_prev.sequence + 1, 'reopened', p_actor_id, p_reason,
        v_prev.entries_total, v_prev.entries_live,
        v_prev.fees_charged_cents, v_prev.fees_collected_cents,
        v_prev.added_money_cents, v_prev.gross_purse_cents,
        v_prev.association_deduction_cents, v_prev.net_purse_cents,
        v_prev.paid_out_cents, v_prev.ground_money_cents, v_prev.day_money_cents,
        v_prev.association_code, ''
    )
    returning * into v_row;

    update rodeos set status = 'in_progress', updated_at = now()
     where id = p_rodeo_id and org_id = p_org_id and status <> 'cancelled';

    return v_row;
end;
$$;

comment on table book_closures is
    'Append-only log of closing, filing and reopening a rodeo''s books. Each '
    'row carries a full snapshot of the money and a hash over it.';
