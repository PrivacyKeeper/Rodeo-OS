-- ============================================================================
-- 0018_record_layer.sql
-- One person, one animal, one lifetime record — across every organisation.
--
-- ---------------------------------------------------------------------------
-- THE PROBLEM THIS SOLVES
-- ---------------------------------------------------------------------------
-- Nobody in this sport can see everything they have won this year in one
-- place. A contestant's earnings sit in an association's standings, a barrel
-- series spreadsheet, a jackpot's Facebook post and a shoebox. A horse has a
-- career and a real dollar value and no canonical record of either.
--
-- That is the fragmentation. It is not inside a rodeo — nobody is fragmented
-- on Saturday afternoon — it is between rodeos and across associations, and no
-- event-shaped product can fix it, however good it is.
--
-- Three tables here:
--
--   animal_registry   A horse or a bull as itself, once, globally. Org stock
--                     rows point at it. Bucking stock is in here too: a bull's
--                     record matters to a contractor exactly as a barrel
--                     horse's matters to a racer.
--
--   career_runs       Every competitive run by a person, with the animal they
--                     were on, wherever it happened. INCLUDING rodeos that did
--                     not run on this platform — see the note on `source`.
--
--   person_merges     Secretaries create contestant records for people who
--                     have never signed in, so the same person accumulates
--                     duplicates. Merging them is a real operation and it is
--                     recorded, not silently applied.
--
-- ---------------------------------------------------------------------------
-- WHY OFF-PLATFORM RUNS ARE FIRST-CLASS
-- ---------------------------------------------------------------------------
-- We do not need to run every rodeo in America to end the fragmentation. We
-- need to be the place the record LANDS. A run at a rodeo on somebody else's
-- software can be imported or claimed, kept clearly labelled as unverified,
-- and still make the contestant's record complete.
--
-- A complete record beats a perfect one — but only if the difference is
-- visible, which is what `source` and `is_verified` are for, and why the
-- public view refuses to show self-reported runs at all.
--
-- ---------------------------------------------------------------------------
-- THE TENANT-ISOLATION TENSION, STATED BEFORE IT IS SOLVED
-- ---------------------------------------------------------------------------
-- Every other table in this schema is tenant-scoped and its RLS derives from
-- org_members. These are deliberately not, and that is exactly where a leak
-- would come from: a global career table read by the wrong person exposes one
-- producer's entry list to another.
--
-- The resolution is that the grants are person-shaped, not org-shaped:
--
--   * A person may read their OWN runs, everywhere, always.
--   * Org staff may read runs recorded AT THEIR OWN org, and no others.
--   * Everyone else reads the public view, which is gated on exactly the same
--     condition as public_results — official placings at a rodeo that is
--     already under way — so this table can never make anything public that
--     the scoreboard was not already publishing.
--
-- No policy anywhere grants "read all career runs".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The animal registry — global
-- ----------------------------------------------------------------------------
create table animal_registry (
    id          uuid primary key default gen_random_uuid(),

    /** Papered name where there is one. */
    registered_name text,
    /** What everybody actually calls it. */
    barn_name   text not null,

    animal_type text not null check (animal_type in (
                    'bull', 'saddle_bronc', 'bareback_bronc',
                    'calf', 'steer', 'horse', 'goat'
                )),
    breed       text,
    color       text,
    sex         text check (sex in ('male', 'female', 'gelding', 'steer')),
    foaled_year int check (foaled_year between 1950 and 2100),

    /** AQHA, APHA, ABBI and so on. [{"body":"AQHA","number":"1234567"}] */
    registrations jsonb not null default '[]'::jsonb,

    /** Lineage inside the registry. Used by WPRA PESI sire incentives. */
    sire_id     uuid references animal_registry (id),
    dam_id      uuid references animal_registry (id),

    /**
     * The person who owns it, when known. Null for stock whose owner is an
     * organisation rather than a person, or simply unknown.
     */
    owner_user_id uuid references users (id) on delete set null,

    /** Who first entered it. Provenance, not ownership. */
    created_by_org uuid references organizations (id) on delete set null,

    /**
     * Claimed by its owner, or asserted by whoever typed it in. An unclaimed
     * registry row is a lead, not a fact.
     */
    is_claimed  boolean not null default false,
    claimed_at  timestamptz,

    retired_at  date,
    deceased_at date,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint no_self_parent check (
        (sire_id is null or sire_id <> id) and (dam_id is null or dam_id <> id)
    )
);

create index idx_registry_barn_name on animal_registry (lower(barn_name));
create index idx_registry_owner on animal_registry (owner_user_id);
create index idx_registry_type on animal_registry (animal_type);

-- ----------------------------------------------------------------------------
-- Org stock points at the registry. Nullable: a contractor with a pen of
-- unregistered practice steers is not obliged to register them.
-- ----------------------------------------------------------------------------
alter table animals
    add column registry_id uuid references animal_registry (id) on delete set null;

create index idx_animals_registry on animals (registry_id);

comment on column animals.registry_id is
    'The global animal this org row represents. Null when the stock has no '
    'life outside this tenant.';

-- ----------------------------------------------------------------------------
-- The horse a contestant is competing on.
--
-- Barrel racing, breakaway and roping all turn on which horse ran, and until
-- now an entry could not say. It points at the REGISTRY, not at `animals`,
-- because a contestant's horse is theirs and travels with them — it is not the
-- producer's stock.
-- ----------------------------------------------------------------------------
alter table entries
    add column horse_id uuid references animal_registry (id) on delete set null;

create index idx_entries_horse on entries (horse_id);

-- ----------------------------------------------------------------------------
-- Career runs — global
-- ----------------------------------------------------------------------------
create table career_runs (
    id          uuid primary key default gen_random_uuid(),

    contestant_id uuid not null references users (id) on delete cascade,
    animal_id     uuid references animal_registry (id) on delete set null,

    /**
     * Where it happened. NULL for a run at a rodeo that was not on this
     * platform — which is the whole point of importing.
     *
     * The composite foreign key below is MATCH SIMPLE (the default), so it is
     * enforced when both columns are present and skipped when either is null.
     * That is the behaviour wanted: an off-platform run references no rodeo,
     * and an on-platform run cannot reference another tenant's.
     */
    org_id      uuid references organizations (id) on delete set null,
    rodeo_id    uuid,
    rodeo_event_id uuid,

    /** Denormalised so an imported run needs no rodeo row at all. */
    rodeo_name  text not null,
    event_code  text not null,
    run_date    date not null,
    venue_city  text,
    venue_state text,
    association_code text,

    go_round    int,
    result_type text not null default 'go_round' check (result_type in (
                    'go_round', 'average', 'aggregate', 'd_division',
                    'day_money', 'overall'
                )),
    d_division  int,

    /** One of these, matching the event's scoring mode. */
    final_time  decimal(10, 3) check (final_time >= 0),
    final_score decimal(10, 3),

    place       int check (place >= 1),
    /** Integer cents. Decimal money is how a ledger stops reconciling. */
    earnings_cents bigint not null default 0 check (earnings_cents >= 0),
    points      decimal(10, 2) not null default 0,

    /**
     * Where this row came from. It decides what the record is worth.
     *
     *   platform      Written from our own official results. True by
     *                 construction.
     *   imported      Loaded from an association feed or a producer's export.
     *                 As good as its source.
     *   self_reported The contestant typed it in. Never shown publicly.
     */
    source      text not null check (source in ('platform', 'imported', 'self_reported')),
    source_note text,
    is_verified boolean not null default false,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete set null,
    constraint platform_run_has_a_rodeo check (
        source <> 'platform' or (org_id is not null and rodeo_id is not null)
    ),
    constraint career_run_is_timed_xor_judged check (
        final_time is null or final_score is null
    )
);

create index idx_career_person on career_runs (contestant_id, run_date desc);
create index idx_career_animal on career_runs (animal_id, run_date desc)
    where animal_id is not null;
create index idx_career_org on career_runs (org_id, rodeo_id)
    where org_id is not null;
create index idx_career_event on career_runs (event_code, run_date desc);

-- A platform run is written once per contestant, event, round and result type.
-- Re-running the writer after a correction updates rather than duplicates.
create unique index idx_career_platform_unique
    on career_runs (rodeo_event_id, contestant_id, result_type, go_round, d_division)
    nulls not distinct
    where source = 'platform';

-- ----------------------------------------------------------------------------
-- Duplicate people
-- ----------------------------------------------------------------------------
create table person_merges (
    id          bigserial primary key,

    /** The record that survives. */
    kept_user_id   uuid not null references users (id) on delete cascade,
    /** The record that was folded in. Kept as a tombstone, never deleted. */
    merged_user_id uuid not null references users (id) on delete cascade,

    merged_by   uuid references users (id),
    reason      text not null,
    /** Everything the merged record held, so the merge can be reasoned about. */
    snapshot    jsonb not null default '{}'::jsonb,

    created_at  timestamptz not null default now(),

    constraint no_self_merge check (kept_user_id <> merged_user_id)
);

create index idx_person_merges_kept on person_merges (kept_user_id);
create unique index idx_person_merges_once on person_merges (merged_user_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table animal_registry enable row level security;
alter table animal_registry force row level security;

-- A registry row is a public fact about an animal, the way a horse's papers
-- are. It carries no contact details and no money.
create policy animal_registry_read on animal_registry
    for select using (true);

-- Anyone signed in may add an animal — a secretary typing an entry has to be
-- able to. Editing is restricted to the owner or whoever entered it.
create policy animal_registry_insert on animal_registry
    for insert with check (app_current_user_id() is not null);

create policy animal_registry_update on animal_registry
    for update
    using (
        owner_user_id = app_current_user_id()
        or (created_by_org is not null and app_is_org_staff(created_by_org))
    )
    with check (
        owner_user_id = app_current_user_id()
        or (created_by_org is not null and app_is_org_staff(created_by_org))
    );

alter table career_runs enable row level security;
alter table career_runs force row level security;

-- Your own record, everywhere. This is the one that makes the apps worth
-- paying for, and it is scoped to the person and nobody else.
create policy career_runs_own on career_runs
    for select using (contestant_id = app_current_user_id());

-- Staff see what happened at their own rodeos. Not at anybody else's.
create policy career_runs_org on career_runs
    for select using (org_id is not null and app_is_org_member(org_id));

create policy career_runs_org_write on career_runs
    for all
    using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

-- A contestant may add and correct their OWN off-platform history, and can
-- never touch a platform row — those are written from official results.
create policy career_runs_self_report on career_runs
    for insert
    with check (
        contestant_id = app_current_user_id()
        and source = 'self_reported'
        and org_id is null
        and not is_verified
    );

create policy career_runs_self_edit on career_runs
    for update
    using (contestant_id = app_current_user_id() and source = 'self_reported')
    with check (
        contestant_id = app_current_user_id()
        and source = 'self_reported'
        and not is_verified
    );

alter table person_merges enable row level security;
alter table person_merges force row level security;

create policy person_merges_read on person_merges
    for select using (
        kept_user_id = app_current_user_id()
        or merged_user_id = app_current_user_id()
    );

create trigger animal_registry_touch
    before update on animal_registry
    for each row execute function touch_updated_at();

create trigger career_runs_touch
    before update on career_runs
    for each row execute function touch_updated_at();

-- A merge is evidence of what was done to somebody's identity. It is not
-- editable after the fact.
create trigger person_merges_no_update
    before update or delete on person_merges
    for each row execute function reject_mutation();

grant select on animal_registry to anon, authenticated;
grant insert, update on animal_registry to authenticated;
grant select, insert, update, delete on career_runs to authenticated;
grant select on person_merges to authenticated;
grant insert on person_merges to authenticated;
grant usage, select on sequence person_merges_id_seq to authenticated;

-- ============================================================================
-- Writing the record
-- ============================================================================

/**
 * Fold this rodeo's official results into the global career record.
 *
 * Called when the books are closed, which is the moment the results become the
 * association's version of the truth as well as ours. Idempotent: running it
 * twice updates in place rather than duplicating, so a correction filed after
 * the fact flows through.
 *
 * SECURITY DEFINER because it writes rows keyed to contestants who are not the
 * caller. It is safe to define that way for one reason and it is worth stating
 * explicitly: the function reads nothing the caller could not already read —
 * the membership check on the first line refuses anyone who is not staff at
 * the org owning the rodeo — and it writes only rows derived from that org's
 * own official results.
 */
create or replace function record_career_runs(p_org_id uuid, p_rodeo_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    v_written int;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised to record career runs for this organisation'
            using errcode = '42501';
    end if;

    insert into career_runs (
        contestant_id, animal_id, org_id, rodeo_id, rodeo_event_id,
        rodeo_name, event_code, run_date, venue_city, venue_state,
        association_code, go_round, result_type, d_division,
        place, earnings_cents, points, source, is_verified
    )
    select
        r.contestant_id,
        en.horse_id,
        r.org_id,
        r.rodeo_id,
        r.rodeo_event_id,
        ro.name,
        ev.event_type,
        ro.start_date,
        ro.venue_city,
        ro.venue_state,
        (select rs.sanctioning_body
           from rodeo_sanctioning rs
          where rs.rodeo_id = ro.id and rs.approval_status = 'approved'
          order by rs.created_at
          limit 1),
        r.go_round,
        r.result_type,
        r.d_division,
        r.place,
        -- Money crosses into the record as integer cents and never returns to
        -- a float. results.payout_amount is the only decimal in the path.
        round((r.payout_amount + r.ground_money + r.day_money) * 100)::bigint,
        r.points_earned,
        'platform',
        true
    from results r
    join rodeos ro      on ro.id = r.rodeo_id
    join rodeo_events ev on ev.id = r.rodeo_event_id
    left join lateral (
        select e.horse_id
          from entries e
         where e.rodeo_event_id = r.rodeo_event_id
           and e.contestant_id = r.contestant_id
           and e.horse_id is not null
         order by e.entered_at
         limit 1
    ) en on true
    where r.org_id = p_org_id
      and r.rodeo_id = p_rodeo_id
      and r.is_official
    on conflict (rodeo_event_id, contestant_id, result_type, go_round, d_division)
        where source = 'platform'
    do update set
        place          = excluded.place,
        earnings_cents = excluded.earnings_cents,
        points         = excluded.points,
        animal_id      = coalesce(excluded.animal_id, career_runs.animal_id),
        updated_at     = now();

    get diagnostics v_written = row_count;
    return v_written;
end;
$$;

comment on function record_career_runs is
    'Folds a rodeo''s official results into the global career record. '
    'Idempotent. Refuses anyone who is not staff at the owning organisation.';

-- ============================================================================
-- Public surface
-- ============================================================================

/**
 * A contestant's public career.
 *
 * Gated on exactly the same condition as public_results — official placings at
 * a rodeo already under way — so this view cannot make anything public that
 * the scoreboard was not already publishing. Self-reported runs are excluded
 * outright: an unverified claim shown next to official results damages the
 * credibility of the whole record, which is the only asset here.
 */
create view public_career
with (security_invoker = false) as
select
    cr.contestant_id,
    u.first_name,
    u.last_name,
    cr.animal_id,
    ar.barn_name        as animal_name,
    cr.rodeo_name,
    cr.event_code,
    cr.run_date,
    cr.venue_city,
    cr.venue_state,
    cr.association_code,
    cr.result_type,
    cr.go_round,
    cr.d_division,
    cr.place,
    cr.earnings_cents,
    cr.points,
    cr.source,
    cr.is_verified
from career_runs cr
join users u on u.id = cr.contestant_id
left join animal_registry ar on ar.id = cr.animal_id
left join rodeos ro on ro.id = cr.rodeo_id
where cr.source <> 'self_reported'
  and (
        cr.rodeo_id is null                       -- imported, no rodeo row
     or ro.status in ('in_progress', 'completed', 'results_official', 'settled')
  );

comment on view public_career is
    'Public career record. Name only from `users` — never contact details, '
    'date of birth, address or tax identifiers. Self-reported runs are never '
    'included.';

grant select on public_career to anon, authenticated;

/** What an animal has done and won. The thing a horse is actually worth. */
create view public_animal_career
with (security_invoker = false) as
select
    ar.id                       as animal_id,
    ar.barn_name,
    ar.registered_name,
    ar.animal_type,
    count(*)                    as runs,
    count(*) filter (where pc.place = 1)  as wins,
    min(pc.place)               as best_place,
    sum(pc.earnings_cents)      as earnings_cents,
    min(pc.run_date)            as first_run,
    max(pc.run_date)            as last_run
from animal_registry ar
join public_career pc on pc.animal_id = ar.id
group by ar.id, ar.barn_name, ar.registered_name, ar.animal_type;

comment on view public_animal_career is
    'A horse or bull''s competitive record, aggregated over the same public '
    'surface as public_career. Nobody else in the sport keeps this.';

grant select on public_animal_career to anon, authenticated;
