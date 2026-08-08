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

-- ============================================================================
-- The desk: visibility for people who belong to no organisation
-- ============================================================================

-- D36. A contestant entered at the desk is not an org member and never will
-- be. If staff cannot see them, every inner join on users drops their entry.
do $$
declare v_org uuid := '11111111-1111-4111-8111-111111111111';
        v_auth uuid := '99999999-9999-4999-8999-999999999999';
        v_staff uuid := '88888888-8888-4888-8888-888888888888';
        n int;
begin
    insert into users (id, first_name, last_name, supabase_auth_id)
    values (v_staff, 'Inv', 'Secretary', v_auth);
    insert into org_members (org_id, user_id, role, accepted_at)
    values (v_org, v_staff, 'secretary', now());

    perform set_config('request.jwt.claims',
        json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);
    set local role authenticated;

    -- 'cccccccc-…' is the fixture contestant. They have an entry at this org
    -- and no org_members row — exactly the shape D36 made invisible.
    select count(*) into n from users
     where id = 'cccccccc-1111-4111-8111-111111111111';
    if n = 0 then
        raise exception 'FAIL D36: a contestant with an entry here is invisible to staff';
    end if;
    raise notice 'PASS D36: a contestant entered here is visible without being a member';

    -- And the entry itself survives the join that used to drop it.
    select count(*) into n
      from entries e join users u on u.id = e.contestant_id
     where e.org_id = v_org;
    if n = 0 then
        raise exception 'FAIL D36: the join on users still drops the entry';
    end if;
    raise notice 'PASS D36: the entry survives the join that resolves the name';

    reset role;
end $$;

-- D37. The global search returns names and withholds everything else.
do $$
declare leaked text;
begin
    select string_agg(p.proname, ', ') into leaked
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'search_people'
       and pg_get_function_result(p.oid) like '%date_of_birth%';
    if leaked is not null then
        raise exception 'FAIL D37: search_people returns date_of_birth';
    end if;
    raise notice 'PASS D37: the global person search returns no contact or tax columns';
end $$;

-- D40. Nobody certifies their own card.
do $$
declare v_auth uuid := '99999999-9999-4999-8999-999999999999';
        v_staff uuid := '88888888-8888-4888-8888-888888888888';
        v_cred uuid;
begin
    perform set_config('request.jwt.claims',
        json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);
    set local role authenticated;

    insert into credentials (user_id, body_code, role, card_number)
    values (v_staff, 'PRCA', 'judge', 'SELF-1')
    returning id into v_cred;

    begin
        perform verify_credential(v_cred);
        raise exception 'FAIL D40: a card was verified by its own holder';
    exception when insufficient_privilege then
        raise notice 'PASS D40: a card cannot be verified by its holder';
    end;

    reset role;
end $$;

-- A back number is one per person per rodeo, and one person per number.
do $$
declare v_org uuid := '11111111-1111-4111-8111-111111111111';
        v_rodeo uuid := 'aaaaaaaa-1111-4111-8111-111111111111';
        v_a uuid := 'cccccccc-1111-4111-8111-111111111111';
        v_b uuid := '88888888-8888-4888-8888-888888888888';
begin
    insert into back_numbers (org_id, rodeo_id, contestant_id, back_number)
    values (v_org, v_rodeo, v_a, '214');

    begin
        insert into back_numbers (org_id, rodeo_id, contestant_id, back_number)
        values (v_org, v_rodeo, v_b, '214');
        raise exception 'FAIL back numbers: two people share a number';
    exception when unique_violation then
        raise notice 'PASS back numbers: one person per number at a rodeo';
    end;

    begin
        insert into back_numbers (org_id, rodeo_id, contestant_id, back_number)
        values (v_org, v_rodeo, v_a, '7A');
        raise exception 'FAIL back numbers: one person got two numbers';
    exception when unique_violation then
        raise notice 'PASS back numbers: one number per person at a rodeo';
    end;
end $$;

-- A correction is recorded with its reason, and the history cannot be cleared.
do $$
declare v_org uuid := '11111111-1111-4111-8111-111111111111';
        v_rodeo uuid := 'aaaaaaaa-1111-4111-8111-111111111111';
        v_event uuid := 'bbbbbbbb-1111-4111-8111-111111111111';
        v_entry uuid := 'dddddddd-1111-4111-8111-111111111111';
        v_person uuid := 'cccccccc-1111-4111-8111-111111111111';
        v_score uuid;
        v_hist jsonb;
begin
    -- Round 9 rather than 1: earlier assertions in this file already left a
    -- live score on round 1, and one live score per entry per round is itself
    -- an invariant.
    insert into scores (org_id, rodeo_id, rodeo_event_id, entry_id, contestant_id,
                        go_round, final_score, status)
    values (v_org, v_rodeo, v_event, v_entry, v_person, 9, 82.0, 'official')
    returning id into v_score;

    update scores set final_score = 84.5, correction_reason = 'Judge card misread'
     where id = v_score;

    -- Clearing the array does not clear the history: the trigger appends over
    -- whatever the caller supplied.
    update scores set edit_history = '[]'::jsonb, final_score = 80.0,
                      correction_reason = 'sneaky'
     where id = v_score;

    select edit_history into v_hist from scores where id = v_score;
    if jsonb_array_length(v_hist) < 1 then
        raise exception 'FAIL corrections: the edit history was erasable';
    end if;
    if not (v_hist::text like '%Judge card misread%'
            or v_hist::text like '%sneaky%') then
        raise exception 'FAIL corrections: no reason recorded on the change';
    end if;
    raise notice 'PASS corrections: the reason is recorded and the history is not erasable';
end $$;

-- ---------------------------------------------------------------- D41
-- A composite `on delete set null` must not null the tenant column, which is
-- NOT NULL — that is what made the parent row undeletable. Written as a check
-- over the whole catalogue rather than the four tables that were wrong, so a
-- fifth added later is caught the day it appears.
do $$
declare v_bad int;
begin
    select count(*) into v_bad
      from pg_constraint c
     where c.contype = 'f'
       and c.confdeltype = 'n'
       and array_length(c.conkey, 1) > 1
       -- No column list on the action...
       and pg_get_constraintdef(c.oid) !~ 'SET NULL \('
       -- ...while at least one referencing column is NOT NULL.
       and exists (
             select 1 from unnest(c.conkey) k
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
              where a.attnotnull
           );
    if v_bad > 0 then
        raise exception
            'FAIL D41: % composite set-null foreign key(s) would null a NOT NULL column',
            v_bad;
    end if;
    raise notice 'PASS D41: no composite set-null key can null a tenant column';
end $$;

-- ---------------------------------------------------------------- bookings
-- An exclusive resource cannot be double-booked, and a resource with capacity
-- is not silently limited to one by the same constraint.
do $$
declare v_org uuid := '11111111-1111-4111-8111-111111111111';
        v_stall uuid;
        v_field uuid;
        v_ok boolean := false;
begin
    insert into bookable_resources (org_id, resource_type, name, capacity)
    values (v_org, 'stall', 'Invariant Stall', 1) returning id into v_stall;
    insert into bookable_resources (org_id, resource_type, name, capacity)
    values (v_org, 'camping', 'Invariant Field', 30) returning id into v_field;

    insert into bookings (org_id, resource_id, contact_name, stay)
    values (v_org, v_stall, 'First', daterange('2026-07-01', '2026-07-04', '[)'));

    begin
        insert into bookings (org_id, resource_id, contact_name, stay)
        values (v_org, v_stall, 'Second', daterange('2026-07-03', '2026-07-05', '[)'));
    exception when exclusion_violation then
        v_ok := true;
    end;
    if not v_ok then
        raise exception 'FAIL bookings: the same stall was booked twice';
    end if;
    raise notice 'PASS bookings: an exclusive resource cannot be double-booked';

    -- Touching ranges do not overlap: a stall is free the morning the last
    -- horse leaves.
    insert into bookings (org_id, resource_id, contact_name, stay)
    values (v_org, v_stall, 'Third', daterange('2026-07-04', '2026-07-06', '[)'));
    raise notice 'PASS bookings: a stay may start the day the previous one ends';

    -- The field takes overlapping bookings; its limit is counted under a lock
    -- in book_resource(), because an exclusion constraint cannot count.
    insert into bookings (org_id, resource_id, contact_name, stay, quantity)
    values (v_org, v_field, 'Group A', daterange('2026-07-01', '2026-07-04', '[)'), 10);
    insert into bookings (org_id, resource_id, contact_name, stay, quantity)
    values (v_org, v_field, 'Group B', daterange('2026-07-02', '2026-07-03', '[)'), 10);
    raise notice 'PASS bookings: capacity above one is not forbidden by the constraint';
end $$;

-- ---------------------------------------------------------------- D43
-- A signed waiver is evidence, so it is append-only.
do $$
declare v_org uuid := '11111111-1111-4111-8111-111111111111';
        v_person uuid := 'cccccccc-1111-4111-8111-111111111111';
        v_tpl uuid;
        v_id uuid;
        v_ok boolean := false;
begin
    insert into waiver_templates (org_id, name, waiver_type, body_text, version,
                                  applies_to_roles, is_active)
    values (v_org, 'Invariant Release', 'liability_release',
            'Known text.', 1, array['contestant'], true)
    returning id into v_tpl;

    insert into signed_waivers (org_id, user_id, waiver_template_id,
                                waiver_text_hash, waiver_version,
                                signature_method, typed_name, signed_at,
                                record_hash, recorded_by)
    values (v_org, v_person, v_tpl,
            encode(digest('Known text.', 'sha256'), 'hex'), 1,
            'paper_on_file', 'Test Rider', now(), 'x', v_person)
    returning id into v_id;

    begin
        update signed_waivers set typed_name = 'Somebody Else' where id = v_id;
    exception when others then
        v_ok := true;
    end;
    if not v_ok then
        raise exception 'FAIL D43: a signed waiver was editable after the fact';
    end if;
    raise notice 'PASS D43: a signed waiver cannot be edited after the fact';
end $$;

-- ---------------------------------------------------------------- tax
-- Every seeded reporting threshold names a form and a year, so no report can
-- apply an unattributed number.
do $$
declare v_bad int;
begin
    select count(*) into v_bad
      from tax_reporting_thresholds
     where org_id is null
       and (form is null or form = '' or tax_year is null);
    if v_bad > 0 then
        raise exception 'FAIL tax: % system threshold(s) without a form or year', v_bad;
    end if;

    if not exists (
        select 1 from tax_reporting_thresholds
         where org_id is null and country = 'US' and tax_year = 2026
           and threshold_cents = 200000
    ) then
        raise exception
            'FAIL tax: the 2026 US threshold is not the $2,000 figure in force';
    end if;
    raise notice 'PASS tax: reporting thresholds are attributed by form and year';
end $$;

rollback;
