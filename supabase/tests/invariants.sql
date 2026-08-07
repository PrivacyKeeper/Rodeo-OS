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

-- ---------------------------------------------------------------- options
-- The reference layer must be extensible per tenant without becoming a hole
-- through which one tenant reads another's configuration.

-- A system option is usable by anybody.
do $$ begin
  insert into rodeo_events (org_id, rodeo_id, event_type, scoring_mode)
  values ('11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-1111-4111-8111-111111111111', 'wild_cow_milking', 'timed');
  raise notice 'PASS options: a system option outside the old CHECK list is accepted';
exception when others then
  raise exception 'FAIL options: system option rejected -- %', sqlerrm;
end $$;

-- A producer's own option is usable by that producer.
insert into reference_options (domain, code, label, org_id, is_system, category)
values ('event_type', 'mounted_shooting', 'Cowboy Mounted Shooting',
        '11111111-1111-4111-8111-111111111111', false, 'Other');

do $$ begin
  insert into rodeo_events (org_id, rodeo_id, event_type, scoring_mode)
  values ('11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-1111-4111-8111-111111111111', 'mounted_shooting', 'timed');
  raise notice 'PASS options: a producer custom option is accepted';
exception when others then
  raise exception 'FAIL options: custom option rejected -- %', sqlerrm;
end $$;

-- and by nobody else.
insert into rodeos (id, org_id, name, slug, start_date, end_date, rodeo_type)
values ('bbbbbbbb-2222-4222-8222-222222222222',
        '22222222-2222-4222-8222-222222222222',
        'B Rodeo', 'br', '2026-09-01', '2026-09-02', 'jackpot');

do $$ begin
  insert into rodeo_events (org_id, rodeo_id, event_type, scoring_mode)
  values ('22222222-2222-4222-8222-222222222222',
          'bbbbbbbb-2222-4222-8222-222222222222', 'mounted_shooting', 'timed');
  raise exception 'FAIL options: one tenant used another tenant custom option';
exception when foreign_key_violation then
  raise notice 'PASS options: cross-tenant custom option rejected';
end $$;

-- An unknown value is still an error, not a free-text field.
do $$ begin
  insert into rodeo_events (org_id, rodeo_id, event_type, scoring_mode)
  values ('11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-1111-4111-8111-111111111111', 'not_a_real_event', 'timed');
  raise exception 'FAIL options: an unknown event type was accepted';
exception when foreign_key_violation then
  raise notice 'PASS options: unknown event type rejected';
end $$;

-- ---------------------------------------------------------------- modules
insert into org_modules (org_id, module, tier)
values ('11111111-1111-4111-8111-111111111111', 'sidepots', 'premium');

do $$ begin
  if org_has_module('11111111-1111-4111-8111-111111111111', 'sidepots')
     and not org_has_module('22222222-2222-4222-8222-222222222222', 'sidepots')
  then raise notice 'PASS modules: entitlement is per tenant';
  else raise exception 'FAIL modules: entitlement leaked across tenants';
  end if;
end $$;

update org_modules set expires_at = now() - interval '1 day'
 where module = 'sidepots';

do $$ begin
  if not org_has_module('11111111-1111-4111-8111-111111111111', 'sidepots')
  then raise notice 'PASS modules: an expired subscription reads as off';
  else raise exception 'FAIL modules: expired subscription still entitled';
  end if;
end $$;

-- ---------------------------------------------------------------- public PII
-- A public scoreboard needs a NAME. It must never be a route to a contestant's
-- contact details, date of birth, address or tax identifiers.

insert into results (org_id, rodeo_id, rodeo_event_id, contestant_id,
                     result_type, place, is_official)
values ('11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111',
        'bbbbbbbb-1111-4111-8111-111111111111',
        'cccccccc-1111-4111-8111-111111111111', 'go_round', 1, true);

update users
   set email = 'private@example.com', phone = '555-0100',
       date_of_birth = '1990-01-01', address_line1 = '1 Private Road',
       tax_id_last4 = '6789'
 where id = 'cccccccc-1111-4111-8111-111111111111';

update rodeos set status = 'in_progress'
 where id = 'aaaaaaaa-1111-4111-8111-111111111111';

do $$
declare n int;
begin
    set local role anon;

    select count(*) into n from public_results
     where contestant_id = 'cccccccc-1111-4111-8111-111111111111';
    if n = 0 then
        raise exception 'FAIL public: the scoreboard is empty; a name cannot be resolved';
    end if;
    raise notice 'PASS public: an official placing is readable anonymously, with a name';

    select count(*) into n from users;
    if n > 0 then
        raise exception 'FAIL public: anonymous callers can read the users table';
    end if;
    raise notice 'PASS public: the users table itself stays closed to anonymous callers';

    reset role;
end $$;

-- The view must not carry a column that could leak contact or tax data, even
-- if somebody later adds one to `users`.
do $$
declare leaked text;
begin
    select string_agg(column_name, ', ') into leaked
      from information_schema.columns
     where table_name = 'public_results'
       and column_name in ('email', 'phone', 'date_of_birth', 'address_line1',
                           'address_line2', 'postal_code', 'tax_id_last4',
                           'tax_id_type', 'stripe_customer_id',
                           'stripe_account_id', 'supabase_auth_id',
                           'memberships');
    if leaked is not null then
        raise exception 'FAIL public: public_results exposes %', leaked;
    end if;
    raise notice 'PASS public: the scoreboard view carries no contact or tax columns';
end $$;

-- ============================================================================
-- Associations, the sanction layer, the record layer and the books
-- ============================================================================

-- A tenant's own profile for a code must beat the system one, or a producer
-- cannot correct an association's rules for their own use.
do $$
declare v_name text; v_org uuid := '11111111-1111-4111-8111-111111111111';
begin
    insert into associations (org_id, is_system, code, name, association_type)
    values (v_org, false, 'PRCA', 'Our corrected PRCA profile', 'rodeo');

    select (association_for(v_org, 'PRCA')).name into v_name;
    if v_name <> 'Our corrected PRCA profile' then
        raise exception 'FAIL associations: tenant override lost to the system profile (got %)', v_name;
    end if;

    select (association_for(gen_random_uuid(), 'PRCA')).name into v_name;
    if v_name <> 'Professional Rodeo Cowboys Association' then
        raise exception 'FAIL associations: one tenant''s override leaked to another';
    end if;
    raise notice 'PASS associations: a tenant override wins for that tenant and nobody else';
end $$;

-- The deadlock the integration tests found. Filing happens after closing, so a
-- filing requirement that blocks the close can never be satisfied.
do $$
declare n int;
begin
    select count(*) into n
      from association_requirements
     where requirement_type = 'filing' and blocks_close;
    if n > 0 then
        raise exception 'FAIL sanction: % filing requirement(s) block the close — that deadlocks', n;
    end if;
    raise notice 'PASS sanction: no filing requirement blocks closing the books';
end $$;

-- An unsanctioned rodeo must be asked nothing at all.
do $$
declare n int;
begin
    select count(*) into n
      from associations a
      left join association_requirements r on r.association_id = a.id
     where a.code = 'OPEN' and a.org_id is null and r.id is not null;
    if n > 0 then
        raise exception 'FAIL sanction: the open profile carries % requirement(s)', n;
    end if;
    raise notice 'PASS sanction: an unsanctioned rodeo is asked nothing';
end $$;

-- An unverified card is worth nothing. Anybody can type a number into a box.
do $$
declare v_user uuid := 'cccccccc-1111-4111-8111-111111111111';
begin
    insert into credentials (user_id, body_code, role, card_number, verified,
                             issued_on, expires_on)
    values (v_user, 'PRCA', 'judge', 'INV-1', false, '2026-01-01', '2026-12-31');

    if credential_is_current(v_user, 'PRCA', 'judge', date '2026-06-01') then
        raise exception 'FAIL credentials: an unverified card counted as current';
    end if;

    update credentials set verified = true where card_number = 'INV-1';
    if not credential_is_current(v_user, 'PRCA', 'judge', date '2026-06-01') then
        raise exception 'FAIL credentials: a verified, in-date card did not count';
    end if;
    if credential_is_current(v_user, 'PRCA', 'judge', date '2027-06-01') then
        raise exception 'FAIL credentials: an expired card counted as current';
    end if;
    raise notice 'PASS credentials: only a verified, in-date card counts';
end $$;

-- A platform career run must point at a real rodeo. An imported one need not.
do $$
declare v_user uuid := 'cccccccc-1111-4111-8111-111111111111';
begin
    begin
        insert into career_runs (contestant_id, rodeo_name, event_code, run_date, source)
        values (v_user, 'Nowhere', 'barrel_racing', '2026-01-01', 'platform');
        raise exception 'FAIL record: a platform run with no rodeo was accepted';
    exception when check_violation then
        raise notice 'PASS record: a platform run must reference a real rodeo';
    end;

    insert into career_runs (contestant_id, rodeo_name, event_code, run_date, source)
    values (v_user, 'Somebody Else''s Rodeo', 'barrel_racing', '2026-01-01', 'imported');
    raise notice 'PASS record: an off-platform run is first-class';
end $$;

-- Self-reported runs never reach the public record.
do $$
declare n int; v_user uuid := 'cccccccc-1111-4111-8111-111111111111';
begin
    insert into career_runs (contestant_id, rodeo_name, event_code, run_date, source)
    values (v_user, 'I Definitely Won This', 'barrel_racing', '2026-02-01', 'self_reported');

    select count(*) into n from public_career
     where rodeo_name = 'I Definitely Won This';
    if n > 0 then
        raise exception 'FAIL record: a self-reported run is showing publicly';
    end if;
    raise notice 'PASS record: self-reported runs stay out of the public record';
end $$;

-- The public career view must not carry contact or tax columns either.
do $$
declare leaked text;
begin
    select string_agg(column_name, ', ') into leaked
      from information_schema.columns
     where table_name = 'public_career'
       and column_name in ('email', 'phone', 'date_of_birth', 'address_line1',
                           'postal_code', 'tax_id_last4', 'tax_id_type',
                           'stripe_customer_id', 'stripe_account_id',
                           'supabase_auth_id', 'memberships');
    if leaked is not null then
        raise exception 'FAIL record: public_career exposes %', leaked;
    end if;
    raise notice 'PASS record: the public career view carries no contact or tax columns';
end $$;

-- A set of books that does not balance is not a set of books.
do $$
declare v_org uuid := '11111111-1111-4111-8111-111111111111';
        v_rodeo uuid;
begin
    select id into v_rodeo from rodeos where org_id = v_org limit 1;

    begin
        insert into book_closures (org_id, rodeo_id, sequence, closure_type,
                                   gross_purse_cents, association_deduction_cents,
                                   net_purse_cents, totals_hash)
        values (v_org, v_rodeo, 900, 'closed', 100000, 6000, 80000, '');
        raise exception 'FAIL books: an unbalanced closure was accepted';
    exception when check_violation then
        raise notice 'PASS books: a closure that does not reconcile is rejected';
    end;

    insert into book_closures (org_id, rodeo_id, sequence, closure_type,
                               gross_purse_cents, association_deduction_cents,
                               net_purse_cents, totals_hash)
    values (v_org, v_rodeo, 901, 'closed', 100000, 6000, 94000, 'supplied-by-caller');

    -- The hash is computed by the database, never accepted from the caller.
    if exists (select 1 from book_closures
                where rodeo_id = v_rodeo and sequence = 901
                  and totals_hash = 'supplied-by-caller') then
        raise exception 'FAIL books: the caller''s hash was stored verbatim';
    end if;
    raise notice 'PASS books: the totals hash is computed, not accepted';

    begin
        update book_closures set paid_out_cents = 1
         where rodeo_id = v_rodeo and sequence = 901;
        raise exception 'FAIL books: a closure was edited';
    exception when others then
        if sqlerrm like 'FAIL%' then raise; end if;
        raise notice 'PASS books: a closure is append-only';
    end;
end $$;

-- A welfare record is evidence. Evidence is not editable.
do $$
declare v_org uuid := '11111111-1111-4111-8111-111111111111';
begin
    insert into welfare_records (org_id, record_type, occurred_at, description)
    values (v_org, 'vet_on_site', now(), 'Dr Ames on the grounds from 6pm');

    begin
        update welfare_records set description = 'Nobody was here'
         where org_id = v_org;
        raise exception 'FAIL welfare: a welfare record was rewritten';
    exception when others then
        if sqlerrm like 'FAIL%' then raise; end if;
        raise notice 'PASS welfare: a welfare record cannot be rewritten';
    end;
end $$;

rollback;
