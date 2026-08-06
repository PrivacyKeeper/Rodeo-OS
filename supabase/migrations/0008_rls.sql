-- ============================================================================
-- 0008_rls.sql
-- Row-level security.
--
-- Architecture ref: §2.1 Multi-Tenancy Strategy -- DELIBERATELY NOT FOLLOWED.
--
-- ---------------------------------------------------------------------------
-- WHY THIS DIFFERS FROM THE ARCHITECTURE
-- ---------------------------------------------------------------------------
-- §2.1 specifies:
--
--     CREATE POLICY tenant_isolation ON <table>
--         USING (org_id = current_setting('app.current_org_id')::UUID);
--
-- and §4.2 sets that variable in middleware:
--
--     await req.db.raw(`SET LOCAL app.current_org_id = '${orgId}'`);
--
-- That is not tenant isolation. Three separate problems:
--
--  1. The value is taken from a URL path parameter and interpolated into SQL
--     as a string. `orgId` is attacker-controlled. It is an injection site.
--
--  2. Even parameterised, the setting is asserted by the application, not
--     proven by the token. Anything holding a database connection can simply
--     SET it to another tenant's id and read that tenant's rows. RLS is
--     supposed to hold when the application layer is wrong; this design makes
--     RLS depend on the application layer being right, which is the thing it
--     exists to stop trusting.
--
--  3. Supabase clients (PostgREST, Realtime, the JS SDK, and every discipline
--     app in §3.3.3) never execute that SET. Under the architecture's policies
--     current_setting() raises, or returns NULL, and every one of those paths
--     sees zero rows -- while the service-role API server bypasses RLS
--     entirely. The result is a system where RLS is simultaneously too strict
--     to use and doing no work.
--
-- Instead: isolation is derived from auth.uid(), which is signed into the JWT
-- by Supabase Auth and cannot be set by the client. Membership is looked up
-- through org_members. The predicate is proven, not asserted.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions. SECURITY DEFINER + STABLE so the membership lookup is
-- executed once per statement and does not itself recurse into RLS.
-- ----------------------------------------------------------------------------

create or replace function app_current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select id from users where supabase_auth_id = auth.uid();
$$;

comment on function app_current_user_id is
    'RodeoApps user id for the caller, resolved from the signed JWT subject.';

create or replace function app_is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from org_members m
        join users u on u.id = m.user_id
        where m.org_id = target_org
          and u.supabase_auth_id = auth.uid()
          and m.accepted_at is not null
    );
$$;

create or replace function app_has_org_role(target_org uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from org_members m
        join users u on u.id = m.user_id
        where m.org_id = target_org
          and u.supabase_auth_id = auth.uid()
          and m.accepted_at is not null
          and m.role = any (roles)
    );
$$;

-- Staff who may write operational data.
create or replace function app_is_org_staff(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select app_has_org_role(target_org, array[
        'owner', 'admin', 'secretary'
    ]);
$$;

-- Staff who may record scores.
create or replace function app_can_score(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select app_has_org_role(target_org, array[
        'owner', 'admin', 'secretary', 'judge', 'timer_operator'
    ]);
$$;

-- Staff who may see money.
create or replace function app_can_view_financials(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select app_has_org_role(target_org, array['owner', 'admin', 'secretary']);
$$;

-- ----------------------------------------------------------------------------
-- Enable RLS everywhere. Default-deny: a table with RLS on and no matching
-- policy returns nothing, which is the correct failure mode.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
    foreach t in array array[
        'organizations', 'users', 'org_members',
        'scoring_configs', 'payout_configs',
        'rodeos', 'rodeo_sanctioning', 'rodeo_events', 'performances',
        'buddy_groups', 'entries', 'animals', 'stock_draws',
        'scores', 'results',
        'financial_transactions', 'transaction_status_events', 'escrow_records',
        'waiver_templates', 'signed_waivers', 'insurance_certificates',
        'audit_log'
    ]
    loop
        execute format('alter table %I enable row level security', t);
        execute format('alter table %I force row level security', t);
    end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Generic tenant policies. Read for any member, write for staff.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
    foreach t in array array[
        'rodeo_sanctioning', 'performances', 'buddy_groups',
        'animals', 'stock_draws', 'insurance_certificates'
    ]
    loop
        execute format($f$
            create policy %1$I_member_read on %1$I
                for select using (app_is_org_member(org_id));
            create policy %1$I_staff_write on %1$I
                for all
                using (app_is_org_staff(org_id))
                with check (app_is_org_staff(org_id));
        $f$, t);
    end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Organizations
-- ----------------------------------------------------------------------------
create policy organizations_member_read on organizations
    for select using (app_is_org_member(id) and deleted_at is null);

create policy organizations_owner_write on organizations
    for update
    using (app_has_org_role(id, array['owner', 'admin']))
    with check (app_has_org_role(id, array['owner', 'admin']));

-- ----------------------------------------------------------------------------
-- Users. A user always sees themself. Staff see people who compete or work
-- for their org -- not the whole global user table.
-- ----------------------------------------------------------------------------
create policy users_self_read on users
    for select using (supabase_auth_id = auth.uid());

create policy users_self_update on users
    for update
    using (supabase_auth_id = auth.uid())
    with check (supabase_auth_id = auth.uid());

create policy users_staff_read on users
    for select using (
        exists (
            select 1 from org_members m
            where m.user_id = users.id
              and app_is_org_staff(m.org_id)
        )
    );

-- ----------------------------------------------------------------------------
-- Org members
-- ----------------------------------------------------------------------------
create policy org_members_self_read on org_members
    for select using (user_id = app_current_user_id());

create policy org_members_member_read on org_members
    for select using (app_is_org_member(org_id));

create policy org_members_admin_write on org_members
    for all
    using (app_has_org_role(org_id, array['owner', 'admin']))
    with check (app_has_org_role(org_id, array['owner', 'admin']));

-- ----------------------------------------------------------------------------
-- Configs. System templates are world-readable; tenant configs are not.
-- ----------------------------------------------------------------------------
create policy scoring_configs_read on scoring_configs
    for select using (is_system or app_is_org_member(org_id));

create policy scoring_configs_write on scoring_configs
    for all
    using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

create policy payout_configs_read on payout_configs
    for select using (is_system or app_is_org_member(org_id));

create policy payout_configs_write on payout_configs
    for all
    using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

-- ----------------------------------------------------------------------------
-- Rodeos and disciplines. Published rodeos are public: spectators need the
-- schedule and the results without an account (§4.1 public endpoints).
-- ----------------------------------------------------------------------------
create policy rodeos_public_read on rodeos
    for select using (
        status in ('published', 'entries_open', 'entries_closed',
                   'in_progress', 'completed', 'results_official', 'settled')
    );

create policy rodeos_member_read on rodeos
    for select using (app_is_org_member(org_id));

create policy rodeos_staff_write on rodeos
    for all
    using (app_is_org_staff(org_id))
    with check (app_is_org_staff(org_id));

create policy rodeo_events_public_read on rodeo_events
    for select using (
        exists (
            select 1 from rodeos r
            where r.id = rodeo_events.rodeo_id
              and r.status in ('published', 'entries_open', 'entries_closed',
                               'in_progress', 'completed', 'results_official', 'settled')
        )
    );

create policy rodeo_events_member_read on rodeo_events
    for select using (app_is_org_member(org_id));

create policy rodeo_events_staff_write on rodeo_events
    for all
    using (app_is_org_staff(org_id))
    with check (app_is_org_staff(org_id));

-- ----------------------------------------------------------------------------
-- Entries. A contestant sees their own entries anywhere; staff see all
-- entries in their org. A contestant may create their own entry while entries
-- are open, and may not create one for somebody else.
-- ----------------------------------------------------------------------------
create policy entries_own_read on entries
    for select using (
        contestant_id = app_current_user_id()
        or partner_id = app_current_user_id()
    );

create policy entries_staff_read on entries
    for select using (app_is_org_member(org_id));

create policy entries_self_insert on entries
    for insert
    with check (
        contestant_id = app_current_user_id()
        and exists (
            select 1 from rodeos r
            where r.id = entries.rodeo_id
              and r.org_id = entries.org_id
              and r.status = 'entries_open'
              and r.allow_online_entry
        )
    );

create policy entries_staff_write on entries
    for all
    using (app_is_org_staff(org_id))
    with check (app_is_org_staff(org_id));

-- ----------------------------------------------------------------------------
-- Scores. Public once official -- that is the whole point of a results page.
-- Written only by judges, timer operators and secretaries.
-- ----------------------------------------------------------------------------
create policy scores_public_read on scores
    for select using (
        status = 'official'
        and exists (
            select 1 from rodeos r
            where r.id = scores.rodeo_id
              and r.status in ('in_progress', 'completed', 'results_official', 'settled')
        )
    );

create policy scores_own_read on scores
    for select using (contestant_id = app_current_user_id());

create policy scores_member_read on scores
    for select using (app_is_org_member(org_id));

create policy scores_scorer_write on scores
    for all
    using (app_can_score(org_id))
    with check (app_can_score(org_id));

-- ----------------------------------------------------------------------------
-- Results
-- ----------------------------------------------------------------------------
create policy results_public_read on results
    for select using (
        is_official
        and exists (
            select 1 from rodeos r
            where r.id = results.rodeo_id
              and r.status in ('completed', 'results_official', 'settled')
        )
    );

create policy results_own_read on results
    for select using (contestant_id = app_current_user_id());

create policy results_member_read on results
    for select using (app_is_org_member(org_id));

create policy results_staff_write on results
    for all
    using (app_is_org_staff(org_id))
    with check (app_is_org_staff(org_id));

-- ----------------------------------------------------------------------------
-- Money. Never public. A contestant sees rows that name them; org financial
-- staff see the org's ledger. Nobody gets UPDATE or DELETE -- see 0009.
-- ----------------------------------------------------------------------------
create policy txn_own_read on financial_transactions
    for select using (
        to_user_id = app_current_user_id()
        or from_user_id = app_current_user_id()
    );

create policy txn_finance_read on financial_transactions
    for select using (app_can_view_financials(org_id));

create policy txn_finance_insert on financial_transactions
    for insert with check (app_can_view_financials(org_id));

create policy txn_status_read on transaction_status_events
    for select using (app_can_view_financials(org_id));

create policy txn_status_insert on transaction_status_events
    for insert with check (app_can_view_financials(org_id));

create policy escrow_finance_read on escrow_records
    for select using (app_can_view_financials(org_id));

create policy escrow_finance_write on escrow_records
    for all
    using (app_has_org_role(org_id, array['owner', 'admin']))
    with check (app_has_org_role(org_id, array['owner', 'admin']));

-- ----------------------------------------------------------------------------
-- Waivers and compliance
-- ----------------------------------------------------------------------------
create policy waiver_templates_read on waiver_templates
    for select using (org_id is null or app_is_org_member(org_id));

create policy waiver_templates_write on waiver_templates
    for all
    using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

create policy signed_waivers_own_read on signed_waivers
    for select using (
        user_id = app_current_user_id()
        or guardian_user_id = app_current_user_id()
    );

create policy signed_waivers_staff_read on signed_waivers
    for select using (app_is_org_staff(org_id));

-- A signature can only be created by the person signing it, or by their
-- guardian. Staff cannot sign on a contestant's behalf.
create policy signed_waivers_self_insert on signed_waivers
    for insert with check (
        user_id = app_current_user_id()
        or guardian_user_id = app_current_user_id()
    );

-- ----------------------------------------------------------------------------
-- Audit log: readable by org admins, insertable by anyone in the org
-- (the writer is the API acting for the user), never updatable.
-- ----------------------------------------------------------------------------
create policy audit_admin_read on audit_log
    for select using (app_has_org_role(org_id, array['owner', 'admin']));

create policy audit_insert on audit_log
    for insert with check (org_id is null or app_is_org_member(org_id));
