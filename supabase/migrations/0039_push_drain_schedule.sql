-- 0039_push_drain_schedule.sql
--
-- Drain the notice outbox from inside the database.
--
-- `notices` is written in the same transaction as the thing it announces, so a
-- draw posted on a bad connection in an arena office is never lost to a failed
-- network call. `send-push` delivers those rows. What has been missing is the
-- thing that CALLS `send-push` — without it the outbox fills and nothing ever
-- drains it, which is worse than having no notifications at all, because the
-- app tells people they will be told.
--
-- The obvious answer is an external cron, which means another service to stand
-- up, another place to put the secret, and another thing to notice has died.
-- Postgres can do it: pg_cron for the schedule, pg_net for the call.
--
-- INERT UNTIL CONFIGURED. The job runs every minute but does nothing at all
-- until the worker secret exists in Vault. No secret means no request — not a
-- failed request every minute for the rest of the project's life. The same is
-- true when the queue is empty, which it is almost always: the function checks
-- before it calls, so the steady-state cost is one cheap count.
--
-- TO TURN IT ON, once PUSH_WORKER_SECRET is set under Edge Functions → Secrets,
-- store the SAME value in Vault so the caller can present it:
--
--   select vault.create_secret('<the same value>', 'push_worker_secret',
--                              'Shared secret for the send-push worker');
--
-- Check it with `select * from public.push_worker_status();`.
--
-- TO TURN IT OFF:  select cron.unschedule('drain-push-outbox');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- The caller
-- ---------------------------------------------------------------------------

create or replace function public.drain_push_outbox()
returns void
language plpgsql
security definer
-- `vault` is needed for the secret and `extensions` for net.http_post. Pinned
-- rather than inherited: a definer function that resolves its own function
-- names through the caller's search_path is how privilege escalation starts.
set search_path = public, extensions, vault
as $$
declare
  v_secret  text;
  v_pending integer;
begin
  -- Nothing to send is the normal case, so it is the cheapest branch and it
  -- comes first. This runs every minute forever.
  select count(*)
    into v_pending
    from public.notices
   where channel = 'push'
     and status in ('pending', 'failed')
     and (send_after is null or send_after <= now());

  if v_pending = 0 then
    return;
  end if;

  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = 'push_worker_secret';

  -- Not configured yet. Do nothing, quietly and forever, rather than hammer a
  -- function that will answer 401 every time.
  if v_secret is null or v_secret = '' then
    return;
  end if;

  -- Fire and forget: pg_net queues the request and returns an id immediately.
  -- The worker records what happened in `notices` itself, which is the state
  -- that matters and is visible without digging through net._http_response.
  --
  -- The URL is this project's own. A restore into a different project has to
  -- change this line.
  perform net.http_post(
    url := 'https://rybrgovkqxiwsozcygor.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$$;

comment on function public.drain_push_outbox() is
  'Calls the send-push worker when the outbox has something in it. Scheduled by pg_cron; inert until push_worker_secret is in Vault.';

-- This is a worker, not an API. It reads a secret out of Vault, so exposing it
-- over PostgREST would let any signed-in contestant trigger a send.
revoke execute on function public.drain_push_outbox() from public;
revoke execute on function public.drain_push_outbox() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Somewhere to look when notifications are not arriving
-- ---------------------------------------------------------------------------

create or replace function public.push_worker_status()
returns table (
  secret_configured boolean,
  pending_notices   bigint,
  stuck_sending     bigint,
  failed_notices    bigint,
  active_tokens     bigint,
  schedule_active   boolean,
  last_run          timestamptz
)
language sql
security definer
set search_path = public, extensions, vault, cron
as $$
  select
    exists (select 1 from vault.decrypted_secrets where name = 'push_worker_secret'),
    (select count(*) from public.notices
      where channel = 'push' and status in ('pending', 'failed')
        and (send_after is null or send_after <= now())),
    -- A row claimed by a worker that then died. Not retried automatically,
    -- because a duplicate draw notification is worse than a late one — so it
    -- is surfaced here instead of being silently re-fired.
    (select count(*) from public.notices where channel = 'push' and status = 'sending'),
    (select count(*) from public.notices where channel = 'push' and status = 'failed'),
    (select count(*) from public.push_tokens where is_active),
    (select coalesce(bool_or(active), false) from cron.job where jobname = 'drain-push-outbox'),
    (select max(start_time) from cron.job_run_details d
       join cron.job j on j.jobid = d.jobid
      where j.jobname = 'drain-push-outbox');
$$;

comment on function public.push_worker_status() is
  'One query answering "why has nobody been notified?": is the secret set, is the schedule running, and what is stuck.';

revoke execute on function public.push_worker_status() from public;
revoke execute on function public.push_worker_status() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------

-- Every minute. A draw goes up and people are refreshing a Facebook page at
-- eleven at night; a minute is the difference between the app being the way
-- you find out and being the slower way you find out.
select cron.schedule(
  'drain-push-outbox',
  '* * * * *',
  $cron$ select public.drain_push_outbox(); $cron$
);
