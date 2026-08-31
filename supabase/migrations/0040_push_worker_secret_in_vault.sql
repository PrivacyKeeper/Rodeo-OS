-- 0040_push_worker_secret_in_vault.sql
--
-- The worker secret belongs to the machines, not to a person.
--
-- 0039 built the schedule that calls `send-push`, and left one manual step:
-- paste PUSH_WORKER_SECRET into the dashboard, then paste the same value into
-- Vault so the caller could present it. Two copies of one internal handshake,
-- either of which could be forgotten, typed wrong, or rotated without the
-- other — and a mismatch there is a 401 every minute forever with both halves
-- looking correct.
--
-- Nobody reads this value and nobody needs to. It exists so the cron can prove
-- it is the cron. So it is generated in the database, kept in Vault, and never
-- leaves the server.
--
-- THE FUNCTION VERIFIES RATHER THAN FETCHES. `send-push` sends back the header
-- it was given and asks Postgres whether it is right, so the secret is never
-- on the wire in either direction. A leak of this RPC is an oracle at worst,
-- and it is revoked from everything but the service role.
--
-- TO ROTATE: delete the row and re-run the DO block below. No redeploy — the
-- function reads nothing but the verdict.
--
--   delete from vault.secrets where name = 'push_worker_secret';

create or replace function public.check_push_worker_secret(p_secret text)
returns text
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_stored text;
begin
  select decrypted_secret
    into v_stored
    from vault.decrypted_secrets
   where name = 'push_worker_secret';

  -- Distinguished from a wrong secret on purpose: "not configured" is a
  -- deployment problem and "unauthorized" is a caller problem, and a worker
  -- that cannot tell them apart wastes somebody's evening.
  if v_stored is null or v_stored = '' then
    return 'not_configured';
  end if;

  if p_secret is null or p_secret <> v_stored then
    return 'unauthorized';
  end if;

  return 'ok';
end;
$$;

comment on function public.check_push_worker_secret(text) is
  'Answers whether a presented worker secret matches the one in Vault. Service role only.';

revoke execute on function public.check_push_worker_secret(text) from public;
revoke execute on function public.check_push_worker_secret(text) from anon, authenticated;
grant execute on function public.check_push_worker_secret(text) to service_role;

-- Generate it if it is not already there. 256 bits of randomness, created and
-- stored without ever being returned to a caller.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_worker_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'push_worker_secret',
      'Shared secret between the drain-push-outbox schedule and the send-push function. Generated in the database; nobody needs to read it.'
    );
  end if;
end;
$$;
