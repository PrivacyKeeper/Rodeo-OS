-- ============================================================================
-- 0016_public_results_view.sql
--
-- The public results page returned nothing, and the reason is worth stating
-- plainly because the obvious fix is dangerous.
--
-- `loadPublicResults` joins `users` to put a name next to a placing. Under RLS
-- an anonymous reader has no policy on `users` at all, so the join matched
-- zero rows and every public results page came back empty — for all nine .pro
-- sites, which is also the entire SEO surface.
--
-- The tempting fix is a public read policy on `users`. That is wrong. RLS is
-- ROW level, not column level: exposing the row to satisfy a name lookup would
-- also expose email, phone, date of birth, home address and tax_id_last4 to
-- anonymous callers. A results page needs a name, not a contestant's file.
--
-- So: a view that exposes ONLY the columns that belong on a scoreboard, and
-- only for placings that are already public. It runs as its owner, so it can
-- read `users` — but it can never return anything except a first and last name
-- attached to an official placing at a rodeo that is already under way.
--
-- See docs/SPEC-DELTAS.md D31.
-- ============================================================================

create view public_results
with (security_invoker = false) as
select
    r.rodeo_id,
    ro.org_id,
    ro.name              as rodeo_name,
    ro.slug              as rodeo_slug,
    ro.start_date,
    ro.end_date,
    ro.venue_city,
    ro.venue_state,
    r.rodeo_event_id,
    e.event_type,
    e.sort_order         as event_sort_order,
    r.result_type,
    r.go_round,
    r.d_division,
    r.place,
    r.tied_with,
    r.aggregate_score,
    r.payout_amount,
    r.points_earned,
    r.contestant_id,
    -- The only two columns from `users` that cross this boundary.
    u.first_name,
    u.last_name
from results r
join rodeos ro       on ro.id = r.rodeo_id
join rodeo_events e  on e.id = r.rodeo_event_id
join users u         on u.id = r.contestant_id
where r.is_official
  and ro.status in ('in_progress', 'completed', 'results_official', 'settled');

comment on view public_results is
    'Scoreboard data. Exposes a contestant''s NAME ONLY — never their contact '
    'details, date of birth, address or tax identifiers — and only for '
    'official placings at a rodeo that is already under way. Read by the '
    'public results pages and by season standings.';

grant select on public_results to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Season standings, aggregated over the same safe surface.
--
-- Built on public_results rather than on `results` + `users` directly, so
-- there is exactly one place where a contestant's name leaves the private
-- tables and exactly one thing to audit.
-- ----------------------------------------------------------------------------
create view public_standings
with (security_invoker = false) as
select
    s.sanctioning_body,
    extract(year from pr.start_date)::text as season,
    pr.event_type,
    pr.contestant_id,
    pr.first_name,
    pr.last_name,
    sum(pr.points_earned)         as total_points,
    sum(pr.payout_amount)         as total_earnings,
    count(distinct pr.rodeo_id)   as rodeos_entered
from public_results pr
join rodeo_sanctioning s on s.rodeo_id = pr.rodeo_id
where s.approval_status = 'approved'
group by s.sanctioning_body, season, pr.event_type,
         pr.contestant_id, pr.first_name, pr.last_name;

comment on view public_standings is
    'Season standings over public_results. Money-based points follow the PRCA '
    'world-standings convention of a dollar being a point; placing-based '
    'points come from the association table on the event.';

grant select on public_standings to anon, authenticated;
