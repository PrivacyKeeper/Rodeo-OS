-- ============================================================================
-- 0032_auth_user_provisioning.sql
-- Signing up produced an account that could not read anything.
--
-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
-- Every RLS policy in this schema resolves the caller through one function:
--
--     app_current_user_id() -> select id from users where supabase_auth_id = auth.uid()
--
-- `auth.users` and `public.users` are separate tables, and nothing connected
-- them. Supabase creates the auth row on sign-up; the `public.users` row was
-- expected to be created by "somebody", and no migration, trigger or API path
-- ever did it.
--
-- So a brand-new account authenticates perfectly -- a valid JWT, `auth.uid()`
-- returns a uuid -- and then `app_current_user_id()` returns NULL, every policy
-- that compares against it is false, and the app shows an empty screen with no
-- error. The user is signed in and owns nothing. Worse, it is silent: there is
-- no failed query to look at, just rows that do not match.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER RATHER THAN A CLIENT-SIDE INSERT
-- ---------------------------------------------------------------------------
-- The obvious alternative is for the app to insert its own `users` row right
-- after sign-up. That has a failure mode with no recovery: the auth row is
-- created by the server and the profile insert is a second, independent call
-- from a handset that may be on one bar of signal. When it fails the account
-- exists, cannot be signed up again -- the email is taken -- and cannot read
-- anything. Support has to fix it by hand.
--
-- A trigger on `auth.users` runs inside the same transaction that creates the
-- auth row. Either both exist or neither does.
--
-- ---------------------------------------------------------------------------
-- ON THE NAME COLUMNS
-- ---------------------------------------------------------------------------
-- `first_name` and `last_name` are NOT NULL, and an OAuth or magic-link sign-up
-- carries neither. Failing the trigger would fail the sign-up, so the fallback
-- derives something usable from the email local part and the profile screen
-- asks for the real thing. A placeholder name is recoverable; a rejected
-- sign-up is a lost user.
-- ============================================================================

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_first text;
    v_last  text;
    v_local text;
begin
    -- Set by the client at sign-up via `options.data`. Absent for OAuth,
    -- magic links, and anybody invited from the dashboard.
    v_first := nullif(trim(new.raw_user_meta_data ->> 'first_name'), '');
    v_last  := nullif(trim(new.raw_user_meta_data ->> 'last_name'), '');

    if v_first is null or v_last is null then
        v_local := split_part(coalesce(new.email, ''), '@', 1);
        v_first := coalesce(v_first, nullif(v_local, ''), 'New');
        v_last  := coalesce(v_last, 'Contestant');
    end if;

    -- A secretary may already have created this person at an entry desk, with
    -- their email and no login. Claiming that row rather than inserting a
    -- second one is the whole point of the record layer: a duplicate splits a
    -- career record in half at the moment the person finally signs up.
    update users
       set supabase_auth_id = new.id,
           first_name = case when first_name = '' then v_first else first_name end,
           last_name  = case when last_name  = '' then v_last  else last_name  end,
           updated_at = now()
     where supabase_auth_id is null
       and email is not null
       and email = new.email::citext;

    if not found then
        insert into users (supabase_auth_id, email, first_name, last_name)
        values (new.id, new.email::citext, v_first, v_last);
    end if;

    return new;
end;
$$;

comment on function handle_new_auth_user is
    'Creates the public.users row for a new auth user, or claims the row a '
    'secretary already created for that email. Without it a new account '
    'authenticates and then matches no RLS policy, because '
    'app_current_user_id() resolves through users.supabase_auth_id.';

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function handle_new_auth_user();

-- ----------------------------------------------------------------------------
-- One row per auth user, enforced rather than assumed.
--
-- Two `public.users` rows pointing at the same login would make
-- app_current_user_id() non-deterministic -- `select id from users where
-- supabase_auth_id = auth.uid()` returns whichever the planner reaches first,
-- so a contestant's own entries would appear and disappear between refreshes.
-- Partial, because the column is null for everybody a secretary created who
-- has never signed in, and those are the majority.
-- ----------------------------------------------------------------------------
create unique index if not exists idx_users_one_row_per_login
    on users (supabase_auth_id)
    where supabase_auth_id is not null;

-- ----------------------------------------------------------------------------
-- A user cannot verify their own tax identifier.
--
-- `users_self_read` and `users_self_update` already existed from 0001, so this
-- migration does not create them. But the existing WITH CHECK is only
-- `supabase_auth_id = auth.uid()`, which lets somebody editing their own
-- profile set `tax_id_verified = true` on the way past. That flag decides
-- whether they appear on the producer's year-end chase list in
-- `tax_year_summary()`: self-verifying quietly removes yourself from the list
-- of people the producer still needs a W-9 from.
--
-- This is a trigger and not a tightened policy, for the same reason 0009 puts
-- the append-only guarantees in triggers: a WITH CHECK clause sees only the
-- NEW row, so it can say "must be false" but cannot say "must not change".
-- The first version of this migration wrote `tax_id_verified = false` into the
-- policy, which would have locked every already-verified contestant out of
-- editing their own mailing address -- the failure being invisible until
-- somebody who had been paid tried to correct a typo.
--
-- Staff paths are unaffected: the trigger only fires on a self-edit, which is
-- what `auth.uid() = old.supabase_auth_id` establishes.
-- ----------------------------------------------------------------------------
create or replace function guard_self_profile_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if old.supabase_auth_id is null or auth.uid() is distinct from old.supabase_auth_id then
        return new;   -- not a self-edit; staff and service-role paths pass through
    end if;

    if new.tax_id_verified is distinct from old.tax_id_verified then
        raise exception
            'A tax identifier is verified by the producer paying you, not by you.'
            using errcode = '42501';
    end if;

    if new.supabase_auth_id is distinct from old.supabase_auth_id then
        raise exception 'A profile cannot be repointed at a different login.'
            using errcode = '42501';
    end if;

    return new;
end;
$$;

create trigger users_guard_self_edit
    before update on users
    for each row execute function guard_self_profile_edit();

comment on function guard_self_profile_edit is
    'Stops a person editing their own profile from self-certifying their tax '
    'identifier or moving the row to another login. A trigger rather than a '
    'policy because WITH CHECK cannot compare against the old row.';
