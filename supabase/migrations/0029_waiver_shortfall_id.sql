-- ============================================================================
-- 0029_waiver_shortfall_id.sql
-- `waiver_shortfall()` said whether a release was on file but not which one.
--
-- ---------------------------------------------------------------------------
-- 0027 built `verify_signed_waiver()` on the argument that a hash nothing ever
-- recomputes is decoration rather than evidence. Then the only screen that
-- lists signed releases returned `signed boolean` and no identifier, so there
-- was nothing to pass to it — the check existed and could not be reached from
-- the one place a producer would look for it.
--
-- Returning the id costs nothing: the `exists (...)` subquery becomes a
-- lateral join over the same predicate. It is null when nothing is on file,
-- which is also what `signed` reports, so the two cannot disagree.
--
-- `order by ... limit 1` because a person may legitimately have signed the
-- same release more than once — once at the org level and again for a specific
-- rodeo, or twice across two years. The most recent one is the one a producer
-- is asking about.
-- ============================================================================

drop function if exists waiver_shortfall(uuid, uuid);

create or replace function waiver_shortfall(p_org_id uuid, p_rodeo_id uuid)
returns table (
    contestant_id uuid,
    first_name  text,
    last_name   text,
    template_id uuid,
    template_name text,
    waiver_type text,
    signed      boolean,
    signed_waiver_id uuid,
    signed_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised' using errcode = '42501';
    end if;

    return query
    with people as (
        select distinct e.contestant_id as person_id
          from entries e
         where e.org_id = p_org_id and e.rodeo_id = p_rodeo_id
           and e.status not in ('scratched', 'turned_out', 'cancelled')
        union
        select distinct e.partner_id
          from entries e
         where e.org_id = p_org_id and e.rodeo_id = p_rodeo_id
           and e.partner_id is not null
           and e.status not in ('scratched', 'turned_out', 'cancelled')
    ),
    required as (
        select t.id, t.name, t.waiver_type
          from waiver_templates t
         where t.org_id = p_org_id
           and t.is_active
           and ('contestant' = any (t.applies_to_roles)
                or cardinality(t.applies_to_roles) = 0)
    )
    select p.person_id, u.first_name, u.last_name,
           r.id, r.name, r.waiver_type,
           s.id is not null,
           s.id,
           s.signed_at
      from people p
      join users u on u.id = p.person_id
     cross join required r
      left join lateral (
            select sw.id, sw.signed_at
              from signed_waivers sw
             where sw.org_id = p_org_id
               and sw.user_id = p.person_id
               and sw.waiver_template_id = r.id
               -- An org-level release covers every rodeo; a rodeo-specific one
               -- only covers its own.
               and (sw.rodeo_id is null or sw.rodeo_id = p_rodeo_id)
             order by sw.signed_at desc
             limit 1
           ) s on true
     order by u.last_name, u.first_name, r.name;
end;
$$;

comment on function waiver_shortfall is
    'Every person with a live entry crossed with every active contestant '
    'release, whether it is on file, and which row it is — so the evidence '
    'can actually be checked. The morning-of question.';

revoke all on function waiver_shortfall(uuid, uuid) from public;
grant execute on function waiver_shortfall(uuid, uuid) to authenticated;
