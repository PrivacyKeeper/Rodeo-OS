-- ============================================================================
-- bootstrap.sql — local development and CI only.
--
-- Supabase provides all of this in a hosted project. Plain PostgreSQL does
-- not, so the migrations cannot be applied or tested locally without it.
-- Never run this against a Supabase project.
--
-- The important piece is auth.uid(). Every RLS policy in 0008 is built on it,
-- and it reads the JWT claims that PostgREST sets on the connection. Defining
-- it the same way locally is what makes the RLS tests real rather than
-- decorative: a test can become a specific user and see exactly what that user
-- would see through the API.
-- ============================================================================

create schema if not exists auth;

-- Matches Supabase's own definition. Reads the verified JWT claims that were
-- placed on the transaction, and returns NULL when there are none — an
-- anonymous request, which every member policy correctly denies.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
    select nullif(
        coalesce(
            nullif(current_setting('request.jwt.claim.sub', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        ),
        ''
    )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
    select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        'anon'
    );
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
$$;

-- ----------------------------------------------------------------------------
-- The three roles Supabase ships. `authenticated` and `anon` are subject to
-- RLS; `service_role` bypasses it and is used only by background jobs that
-- have no user context.
-- ----------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin noinherit bypassrls;
    end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Table grants are deliberately broad; RLS is what actually restricts rows.
-- A policy cannot grant access the role does not have, so without these the
-- policies never get a chance to run.
grant all on all tables in schema public to authenticated, service_role;
grant select on all tables in schema public to anon;
grant all on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

alter default privileges in schema public
    grant all on tables to authenticated, service_role;
alter default privileges in schema public
    grant select on tables to anon;
