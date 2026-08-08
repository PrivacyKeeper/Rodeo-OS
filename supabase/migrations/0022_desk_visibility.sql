-- ============================================================================
-- 0022_desk_visibility.sql
-- Two defects the entry-desk integration tests found. The first is severity 1.
--
-- ---------------------------------------------------------------------------
-- D36 — A CONTESTANT ENTERED AT THE DESK VANISHED FROM THE DAY SHEET
-- ---------------------------------------------------------------------------
-- `users_staff_read` (0008) shows a person to org staff only when that person
-- has an `org_members` row in the staff member's organisation:
--
--     exists (select 1 from org_members m
--              where m.user_id = users.id and app_is_org_staff(m.org_id))
--
-- But `users` is deliberately global and login-less: 0001 says in a comment
-- that "secretaries create contestant records for people who have never signed
-- in", and nothing in the entry flow creates an org_members row for them. Why
-- would it? A roper who enters your jackpot is not a member of your staff.
--
-- So the contestant is invisible to the very organisation that just took their
-- entry. And because the day sheet, the entry list and the books all resolve
-- the name with `join users`, an INNER JOIN against an invisible row drops the
-- entry entirely:
--
--     * the contestant is missing from the day sheet, so nobody calls them up
--     * they are missing from the entry list, so nobody takes their money
--     * they are missing from checkBooks(), so the books close without them
--
-- Silently. No error anywhere. The only reason the earlier integration tests
-- passed is that their fixtures made every contestant an org member, which a
-- real desk never does.
--
-- The fix is to say what was actually meant: staff may see a person their
-- organisation has a relationship with — a member, an entrant, or somebody
-- working the rodeo. Not the global table.
--
-- ---------------------------------------------------------------------------
-- D37 — THE DESK COULD NOT FIND ANYBODY IT HAD NOT ALREADY MET
-- ---------------------------------------------------------------------------
-- The same policy makes the anti-duplicate search impossible. A secretary
-- typing "Roper" cannot see a Casey Roper who has only ever competed at other
-- producers' rodeos, so she creates a second Casey Roper — and every duplicate
-- splits a career record in half, which is the exact thing the record layer
-- exists to prevent, defeated at the moment the record is created.
--
-- Opening `users` globally is not the answer, for the same reason it was not
-- the answer for the public scoreboard (delta D31): RLS is ROW level, so
-- exposing the row to satisfy a name lookup also exposes email, phone, date of
-- birth, home address and tax_id_last4.
--
-- So: a SECURITY DEFINER function with a deliberately narrow projection, the
-- same shape of fix as the public_results view. The base table stays closed
-- and there is exactly one auditable place where a name crosses.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- D36. Staff see people their organisation actually deals with.
-- ----------------------------------------------------------------------------
drop policy users_staff_read on users;

create policy users_staff_read on users
    for select using (
        -- Somebody on the staff or roster.
        exists (
            select 1 from org_members m
             where m.user_id = users.id
               and app_is_org_staff(m.org_id)
        )
        -- Somebody who entered one of our rodeos. This is the case that was
        -- missing, and it is the ordinary case at a jackpot.
        or exists (
            select 1 from entries e
             where (e.contestant_id = users.id or e.partner_id = users.id)
               and app_is_org_staff(e.org_id)
        )
        -- Somebody working one of our rodeos: a judge, a timer, a pickup man.
        or exists (
            select 1 from rodeo_personnel p
             where p.user_id = users.id
               and app_is_org_staff(p.org_id)
        )
    );

comment on policy users_staff_read on users is
    'Staff see people their organisation has a relationship with — a member, '
    'an entrant, a partner on an entry, or somebody working the rodeo. Never '
    'the global user table. See delta D36: without the entrant clause a '
    'contestant created at the desk was invisible to the org that entered '
    'them, and every inner join on users silently dropped their entry.';

-- ----------------------------------------------------------------------------
-- D37. Finding somebody the organisation has never met.
-- ----------------------------------------------------------------------------

/**
 * Search every person on the platform, return almost nothing about them.
 *
 * What crosses the boundary:
 *
 *   id, first name, last name   — to identify and select them
 *   city, state                 — to tell two Casey Ropers apart
 *   entries_here                — to sort people you know to the top
 *
 * What never crosses for somebody this organisation has not entered:
 *
 *   email, phone, date of birth, address, tax identifiers, memberships,
 *   Stripe identifiers, the Supabase auth id
 *
 * Contact details are returned ONLY for a person who has already entered a
 * rodeo at the calling organisation — at which point the organisation
 * demonstrably has them anyway.
 *
 * Three limits on enumeration: the caller must be staff somewhere and must
 * name the org they are acting for, the query must be at least three
 * characters, and the result is capped. This is a search box, not an export.
 */
create or replace function search_people(
    p_org_id uuid,
    p_query  text,
    p_limit  int default 20
)
returns table (
    id uuid,
    first_name text,
    last_name text,
    email text,
    phone text,
    city text,
    state_province text,
    memberships jsonb,
    known_here boolean,
    entries_here int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_like text;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised to search from this organisation'
            using errcode = '42501';
    end if;

    -- Three characters, so the box cannot be walked through the alphabet.
    if p_query is null or length(trim(p_query)) < 3 then
        return;
    end if;

    v_like := '%' || lower(trim(p_query)) || '%';

    return query
    select u.id,
           u.first_name,
           u.last_name,
           case when k.n > 0 then u.email::text else null end,
           case when k.n > 0 then u.phone else null end,
           u.city,
           u.state_province,
           case when k.n > 0 then u.memberships else '[]'::jsonb end,
           (k.n > 0),
           k.n
      from users u
      cross join lateral (
        select count(*)::int as n
          from entries e
         where e.contestant_id = u.id and e.org_id = p_org_id
      ) k
     where lower(u.first_name || ' ' || u.last_name) like v_like
        or lower(u.last_name || ' ' || u.first_name) like v_like
        or (u.phone is not null and u.phone like v_like)
     order by k.n desc, u.last_name, u.first_name
     limit least(greatest(p_limit, 1), 25);
end;
$$;

comment on function search_people is
    'Global contestant search with a deliberately narrow projection. Matching '
    'an existing person instead of creating a duplicate is what keeps a career '
    'record in one piece; exposing the whole user row to achieve it would be '
    'the mistake delta D31 already caught once.';

revoke all on function search_people(uuid, text, int) from public;
grant execute on function search_people(uuid, text, int) to authenticated;

-- ----------------------------------------------------------------------------
-- D38 — person_merges could be read but never written
--
-- 0018 gave the table a SELECT policy, an append-only trigger and an INSERT
-- grant, and no INSERT policy. Under `force row level security` the absence of
-- a policy is a denial, so every merge failed at the last statement — after
-- the entries, scores, results and career runs had already been moved. The
-- transaction rolled back, so nothing was corrupted, but merging was simply
-- impossible and the failure said only "new row violates row-level security".
--
-- The grant without the policy is the tell: somebody meant to allow this and
-- wrote half of it.
-- ----------------------------------------------------------------------------
create policy person_merges_write on person_merges
    for insert with check (
        -- You record yourself as the person who did it.
        merged_by = app_current_user_id()
        -- And you are staff of an organisation that deals with the surviving
        -- record. Checked against the KEPT id rather than the merged one
        -- because by the time this row is written the entries have already
        -- moved across — a check on the merged id would always be false.
        and (
            exists (
                select 1 from entries e
                 where e.contestant_id = person_merges.kept_user_id
                   and app_is_org_staff(e.org_id)
            )
            or exists (
                select 1 from org_members m
                 where m.user_id = person_merges.kept_user_id
                   and app_is_org_staff(m.org_id)
            )
        )
    );

comment on policy person_merges_write on person_merges is
    'A merge is recorded by the person who performed it, at an organisation '
    'that deals with the surviving record. See delta D38.';
