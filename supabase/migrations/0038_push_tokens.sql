-- ============================================================================
-- 0038_push_tokens.sql
-- Somewhere to send the notification to.
--
-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
-- `notify_draw_posted()` (0025) writes a row per contestant with
-- `channel: 'push'`, and the whole argument for the outbox is that a draw
-- committed in an arena office reaches people without an inline network call.
--
-- Nothing ever recorded a device to push to. The outbox has been filling with
-- push-channel rows addressed to nobody since it was written.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT A COLUMN ON `users`
-- ---------------------------------------------------------------------------
-- One person, several handsets, and the sport is full of shared phones and
-- borrowed tablets at an entry desk. A single `push_token` column silently
-- drops every device but the last one to sign in, which is how a contestant
-- with an iPad in the trailer stops getting the draw on the phone in their
-- pocket.
--
-- Tokens also rotate and expire. Expo returns DeviceNotRegistered for a dead
-- one, and the sender marks it inactive rather than deleting it, so a token
-- that comes back after a reinstall is a row to revive rather than a mystery.
-- ============================================================================

create table push_tokens (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references users (id) on delete cascade,

    /** Expo push token: ExponentPushToken[...]. Unique across the platform. */
    token       text not null,
    platform    text not null check (platform in ('ios', 'android', 'web')),

    /** Which app registered it. One person may hold several in the portfolio. */
    app_slug    text not null,

    /** Set false when the push service says the device is gone. */
    is_active   boolean not null default true,
    last_error  text,

    created_at  timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),

    -- A handset that signs into a different account must move to that account
    -- rather than deliver one person's draw to another.
    unique (token)
);

create index idx_push_tokens_user on push_tokens (user_id) where is_active;

alter table push_tokens enable row level security;
alter table push_tokens force row level security;

create policy push_tokens_own on push_tokens
    for select using (user_id = app_current_user_id());

create policy push_tokens_own_write on push_tokens
    for insert with check (user_id = app_current_user_id());

create policy push_tokens_own_update on push_tokens
    for update
    using (user_id = app_current_user_id())
    with check (user_id = app_current_user_id());

-- Signing out on a shared phone has to be able to remove the token, or the
-- next person's draw goes to the previous person's device.
create policy push_tokens_own_delete on push_tokens
    for delete using (user_id = app_current_user_id());

grant select, insert, update, delete on push_tokens to authenticated;

comment on table push_tokens is
    'Devices to deliver a notice to. A table and not a column on users because '
    'one person has several handsets and a single column silently drops every '
    'device but the most recent sign-in.';

/**
 * Register or re-register a device.
 *
 * Upserts on the token, which is the part that matters: the same handset
 * signing into a different account must MOVE, not duplicate. Without the
 * user_id reassignment on conflict, a shared phone at an entry desk would keep
 * delivering the previous contestant's draw.
 */
create or replace function register_push_token(
    p_token text,
    p_platform text,
    p_app_slug text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user uuid := app_current_user_id();
begin
    if v_user is null then
        raise exception 'not signed in' using errcode = '42501';
    end if;

    insert into push_tokens (user_id, token, platform, app_slug)
    values (v_user, p_token, p_platform, p_app_slug)
    on conflict (token) do update
        set user_id = v_user,
            platform = excluded.platform,
            app_slug = excluded.app_slug,
            is_active = true,
            last_error = null,
            last_seen_at = now();
end;
$$;

revoke all on function register_push_token(text, text, text) from public, anon;
grant execute on function register_push_token(text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The worker's view of the queue.
--
-- Pairs each undelivered push notice with every live device for that person.
-- A notice with no device is left pending rather than marked sent: the person
-- may install the app tomorrow, and the in-app inbox shows it regardless.
-- ----------------------------------------------------------------------------
create or replace function pending_push_notices(p_limit int default 100)
returns table (
    notice_id bigint,
    token text,
    subject text,
    body text,
    payload jsonb
)
language sql
security definer
set search_path = public
as $$
    select n.id, t.token, n.subject, n.body, n.payload
      from notices n
      join push_tokens t on t.user_id = n.user_id and t.is_active
     where n.channel = 'push'
       and n.status in ('pending', 'failed')
       and n.send_after <= now()
       and n.attempts < 5
     order by n.send_after
     limit greatest(1, least(p_limit, 500));
$$;

-- Service role only. This returns other people's notices by construction, so
-- it must never be reachable from a handset.
revoke all on function pending_push_notices(int) from public, anon, authenticated;

comment on function pending_push_notices is
    'The push queue, joined to live devices. Service role only -- it returns '
    'notices addressed to other people by design.';
