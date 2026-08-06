-- ============================================================================
-- 0009_immutability.sql
-- Triggers that make the append-only tables actually append-only.
--
-- Architecture ref: §2.2.8 ("no UPDATE or DELETE allowed via RLS policy"),
--                   §2.2.9 (signed waivers "IMMUTABLE"), §7.7 (financial
--                   tampering mitigation).
--
-- RLS cannot deliver this. The Fastify API server connects with the Supabase
-- service role, which is BYPASSRLS -- so an RLS-only rule leaves the ledger
-- open to precisely the process that writes to it, while blocking everyone
-- who was never going to write to it anyway. Triggers apply to every role
-- including the service role, so that is where the guarantee belongs.
-- See docs/SPEC-DELTAS.md D9.
-- ============================================================================

create or replace function reject_mutation()
returns trigger
language plpgsql
as $$
begin
    raise exception
        'Table % is append-only; % is not permitted. Record a correcting row instead.',
        tg_table_name, tg_op
        using errcode = 'restrict_violation';
end;
$$;

create trigger financial_transactions_no_update
    before update on financial_transactions
    for each row execute function reject_mutation();

create trigger financial_transactions_no_delete
    before delete on financial_transactions
    for each row execute function reject_mutation();

create trigger transaction_status_events_no_update
    before update on transaction_status_events
    for each row execute function reject_mutation();

create trigger transaction_status_events_no_delete
    before delete on transaction_status_events
    for each row execute function reject_mutation();

create trigger signed_waivers_no_update
    before update on signed_waivers
    for each row execute function reject_mutation();

create trigger signed_waivers_no_delete
    before delete on signed_waivers
    for each row execute function reject_mutation();

create trigger audit_log_no_update
    before update on audit_log
    for each row execute function reject_mutation();

create trigger audit_log_no_delete
    before delete on audit_log
    for each row execute function reject_mutation();

-- ----------------------------------------------------------------------------
-- Score edits are allowed, but the history of them is not erasable. Every
-- change to a finalised value appends to edit_history automatically, so an
-- edit made by bypassing the API is still recorded.
-- ----------------------------------------------------------------------------
create or replace function record_score_edit()
returns trigger
language plpgsql
as $$
declare
    entry jsonb;
    edits jsonb := '[]'::jsonb;
begin
    if new.final_score is distinct from old.final_score then
        edits := edits || jsonb_build_object(
            'at', now(), 'by', new.last_edited_by,
            'field', 'final_score', 'from', old.final_score, 'to', new.final_score
        );
    end if;

    if new.final_time is distinct from old.final_time then
        edits := edits || jsonb_build_object(
            'at', now(), 'by', new.last_edited_by,
            'field', 'final_time', 'from', old.final_time, 'to', new.final_time
        );
    end if;

    if new.status is distinct from old.status then
        edits := edits || jsonb_build_object(
            'at', now(), 'by', new.last_edited_by,
            'field', 'status', 'from', old.status, 'to', new.status
        );
    end if;

    if jsonb_array_length(edits) > 0 then
        -- History is append-only even if the caller supplied a shorter array.
        new.edit_history := old.edit_history || edits;
    else
        new.edit_history := old.edit_history;
    end if;

    new.updated_at := now();
    return new;
end;
$$;

create trigger scores_record_edits
    before update on scores
    for each row execute function record_score_edit();

-- A finalised score is never deleted; it is superseded by a reride or
-- corrected in place with the history above.
create trigger scores_no_delete_official
    before delete on scores
    for each row
    when (old.status in ('official', 'dq'))
    execute function reject_mutation();

-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

do $$
declare t text;
begin
    foreach t in array array[
        'organizations', 'users', 'scoring_configs', 'payout_configs',
        'rodeos', 'rodeo_events', 'entries', 'animals', 'results',
        'insurance_certificates'
    ]
    loop
        execute format(
            'create trigger %1$I_touch before update on %1$I
             for each row execute function touch_updated_at()', t);
    end loop;
end $$;
