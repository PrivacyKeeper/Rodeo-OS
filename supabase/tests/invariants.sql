-- ============================================================================
-- Schema invariants.
--
-- These are the guarantees the deltas in docs/SPEC-DELTAS.md exist to create.
-- Run against a freshly migrated database; any FAIL is a regression.
--
--   psql -d rodeo -f supabase/tests/invariants.sql
-- ============================================================================

\set ON_ERROR_STOP on
begin;

insert into organizations (id, name, slug, type) values
  ('11111111-1111-4111-8111-111111111111', 'Tenant A', 'a', 'producer'),
  ('22222222-2222-4222-8222-222222222222', 'Tenant B', 'b', 'producer');

insert into rodeos (id, org_id, name, slug, start_date, end_date, rodeo_type)
values ('aaaaaaaa-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111',
        'A Rodeo', 'ar', '2026-07-01', '2026-07-02', 'jackpot');

insert into rodeo_events (id, org_id, rodeo_id, event_type, scoring_mode)
values ('bbbbbbbb-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111', 'bull_riding', 'judged');

insert into users (id, first_name, last_name)
values ('cccccccc-1111-4111-8111-111111111111', 'Test', 'Rider');

insert into entries (id, org_id, rodeo_id, rodeo_event_id, contestant_id)
values ('dddddddd-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111',
        'bbbbbbbb-1111-4111-8111-111111111111',
        'cccccccc-1111-4111-8111-111111111111');

-- ---------------------------------------------------------------- D8
-- A child row may not reference a parent belonging to another tenant.
do $$ begin
  insert into rodeo_events (org_id, rodeo_id, event_type, scoring_mode)
  values ('22222222-2222-4222-8222-222222222222',
          'aaaaaaaa-1111-4111-8111-111111111111', 'bareback', 'judged');
  raise exception 'FAIL D8: cross-tenant foreign key was accepted';
exception when foreign_key_violation then
  raise notice 'PASS D8: cross-tenant foreign key rejected';
end $$;

-- ---------------------------------------------------------------- D9
-- The ledger is append-only for EVERY role, superuser included.
insert into financial_transactions (id, org_id, transaction_type, amount)
values ('ffffffff-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111', 'entry_fee', 100.00);

do $$ begin
  update financial_transactions set amount = 1
   where id = 'ffffffff-1111-4111-8111-111111111111';
  raise exception 'FAIL D9: ledger UPDATE was accepted';
exception when restrict_violation then
  raise notice 'PASS D9: ledger UPDATE rejected';
end $$;

do $$ begin
  delete from financial_transactions
   where id = 'ffffffff-1111-4111-8111-111111111111';
  raise exception 'FAIL D9: ledger DELETE was accepted';
exception when restrict_violation then
  raise notice 'PASS D9: ledger DELETE rejected';
end $$;

-- ---------------------------------------------------------------- D15
-- The average row (go_round and d_division both NULL) is not duplicable.
insert into results (org_id, rodeo_id, rodeo_event_id, contestant_id, result_type)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111',
        'bbbbbbbb-1111-4111-8111-111111111111',
        'cccccccc-1111-4111-8111-111111111111', 'average');

do $$ begin
  insert into results (org_id, rodeo_id, rodeo_event_id, contestant_id, result_type)
  values ('11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-1111-4111-8111-111111111111',
          'bbbbbbbb-1111-4111-8111-111111111111',
          'cccccccc-1111-4111-8111-111111111111', 'average');
  raise exception 'FAIL D15: duplicate average row was accepted';
exception when unique_violation then
  raise notice 'PASS D15: duplicate average row rejected';
end $$;

-- ---------------------------------------------------------------- audit
-- A score edit is recorded even when the caller tries to clear the history.
insert into scores (id, org_id, rodeo_id, rodeo_event_id, entry_id,
                    contestant_id, final_score, status)
values ('eeeeeeee-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111',
        'bbbbbbbb-1111-4111-8111-111111111111',
        'dddddddd-1111-4111-8111-111111111111',
        'cccccccc-1111-4111-8111-111111111111', 85.0, 'official');

update scores
   set final_score = 88.0, edit_history = '[]'::jsonb
 where id = 'eeeeeeee-1111-4111-8111-111111111111';

do $$ declare n int; begin
  select jsonb_array_length(edit_history) into n
    from scores where id = 'eeeeeeee-1111-4111-8111-111111111111';
  if n = 1 then
    raise notice 'PASS audit: score edit recorded despite history being cleared';
  else
    raise exception 'FAIL audit: edit_history has % entries, expected 1', n;
  end if;
end $$;

do $$ begin
  delete from scores where id = 'eeeeeeee-1111-4111-8111-111111111111';
  raise exception 'FAIL audit: an official score was deleted';
exception when restrict_violation then
  raise notice 'PASS audit: deleting an official score rejected';
end $$;

-- ---------------------------------------------------------------- shape
-- A run is timed or judged, never both.
do $$ begin
  insert into scores (org_id, rodeo_id, rodeo_event_id, entry_id, contestant_id,
                      final_score, final_time, raw_time)
  values ('11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-1111-4111-8111-111111111111',
          'bbbbbbbb-1111-4111-8111-111111111111',
          'dddddddd-1111-4111-8111-111111111111',
          'cccccccc-1111-4111-8111-111111111111', 85.0, 9.1, 9.1);
  raise exception 'FAIL: a score was recorded as both timed and judged';
exception when check_violation then
  raise notice 'PASS: timed-xor-judged enforced';
end $$;

-- A disqualification has to say why.
do $$ begin
  insert into scores (org_id, rodeo_id, rodeo_event_id, entry_id, contestant_id, status)
  values ('11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-1111-4111-8111-111111111111',
          'bbbbbbbb-1111-4111-8111-111111111111',
          'dddddddd-1111-4111-8111-111111111111',
          'cccccccc-1111-4111-8111-111111111111', 'dq');
  raise exception 'FAIL: a DQ was recorded with no reason';
exception when check_violation then
  raise notice 'PASS: a DQ requires a reason';
end $$;

-- ---------------------------------------------------------------- coverage
do $$ declare n int; begin
  select count(*) into n from pg_tables
   where schemaname = 'public' and not rowsecurity;
  if n = 0 then raise notice 'PASS rls: every public table has RLS enabled';
  else raise exception 'FAIL rls: % table(s) without RLS', n; end if;
end $$;

rollback;
