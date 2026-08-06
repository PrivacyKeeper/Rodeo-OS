-- ============================================================================
-- 0011_handicap_roping.sql
-- Numbered (handicap) roping divisions.
--
-- Not in Architecture v1.0, which models open competition only. USTRC and WSTR
-- run classified divisions where every roper carries a number, a team's
-- numbers must total no more than the division, and most divisions cap each
-- end separately. That is the format most amateur ropers enter, so the
-- platform cannot represent its own core audience without it.
--
-- See docs/RULES.md for what is confirmed and what is not.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A roper's classification numbers, per association and discipline.
--
-- Kept separate from users.memberships because a number changes on its own
-- schedule -- a roper gets raised mid-season after a big win without their
-- membership changing at all -- and because the entry desk queries it on every
-- team entry.
-- ----------------------------------------------------------------------------
create table roper_classifications (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references users (id) on delete cascade,

    system      text not null,              -- 'USTRC', 'WSTR', 'NTR', 'CUSTOM'
    discipline  text not null default 'team_roping'
                check (discipline in ('team_roping', 'breakaway_roping', 'tie_down_roping')),
    /** 'header' | 'heeler' | 'both' -- USTRC TRIAD numbers the ends separately. */
    end_position text not null check (end_position in ('header', 'heeler', 'both')),

    -- Numbers come in halves. USTRC TRIAD: headers 1-9, heelers 1-10.
    number      numeric(3, 1) not null check (number >= 0 and number <= 20),

    /** Association-designated elite/protected roper, barred from low divisions. */
    is_elite    boolean not null default false,

    effective_date date not null default current_date,
    /** Null = current. A raise closes the old row rather than overwriting it. */
    expires_date   date,

    source      text,                       -- 'global_handicaps', 'association', 'producer'
    verified    boolean not null default false,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint classification_dates
        check (expires_date is null or expires_date > effective_date)
);

-- One live number per roper, per system, per end.
create unique index idx_classification_current
    on roper_classifications (user_id, system, discipline, end_position)
    where expires_date is null;

create index idx_classification_user on roper_classifications (user_id);

-- ----------------------------------------------------------------------------
-- Division structure for a roping. Shape is documented in
-- packages/engine/src/scoring/divisions.ts (DivisionConfig).
-- ----------------------------------------------------------------------------
alter table rodeo_events
    add column division_config jsonb;

comment on column rodeo_events.division_config is
    'Numbered-roping divisions. Null for open competition. See DivisionConfig.';

-- ----------------------------------------------------------------------------
-- The numbers a team actually entered on, captured AT ENTRY TIME.
--
-- Snapshotting matters: if a roper is raised between entering and roping, the
-- team stays eligible for the division they legally entered. Reading the
-- current number at payout time would retroactively disqualify them.
-- ----------------------------------------------------------------------------
alter table entries
    add column division_name   text,
    add column header_number   numeric(3, 1) check (header_number >= 0),
    add column heeler_number   numeric(3, 1) check (heeler_number >= 0),
    add column combined_number numeric(4, 1)
        generated always as (coalesce(header_number, 0) + coalesce(heeler_number, 0)) stored;

create index idx_entries_division on entries (rodeo_event_id, division_name)
    where division_name is not null;

-- ============================================================================
-- Seed: USTRC and WSTR templates.
--
-- The 5-second barrier and the 5-second one-leg catch are confirmed for 2026
-- and differ from PRCA, which assesses 10 seconds on the barrier. The division
-- ladders are illustrative and flagged unverified -- do not run a sanctioned
-- USTRC or WSTR roping on them without checking the current rulebook.
-- ============================================================================

insert into scoring_configs
    (name, sanctioning_body, event_type, season, effective_date, is_system, config)
values
('USTRC Team Roping 2026', 'USTRC', 'team_roping_header', '2026', '2026-01-01', true, '{
    "mode": "timed",
    "time_precision": 2,
    "timed_penalties": [
        {"type": "barrier_break", "seconds": 5.0},
        {"type": "one_leg_catch", "seconds": 5.0}
    ],
    "legal_head_catches": ["around_both_horns", "half_head", "around_neck"],
    "dq_triggers": ["illegal_head_catch", "crossfire", "no_catch"],
    "reride_conditions": [],
    "tie_resolution": "combine_and_split",
    "notes": "Barrier is 5 seconds under USTRC, not the 10 seconds PRCA assesses.",
    "unverified": true,
    "unverified_note": "Crossfire standard (release vs contact) unresolved. See docs/RULES.md."
}'::jsonb),

('WSTR Team Roping 2026', 'WSTR', 'team_roping_header', '2026', '2026-01-01', true, '{
    "mode": "timed",
    "time_precision": 2,
    "timed_penalties": [
        {"type": "barrier_break", "seconds": 5.0},
        {"type": "one_leg_catch", "seconds": 5.0}
    ],
    "legal_head_catches": ["around_both_horns", "half_head", "around_neck"],
    "dq_triggers": ["illegal_head_catch", "crossfire", "no_catch"],
    "reride_conditions": [],
    "tie_resolution": "combine_and_split",
    "unverified": true,
    "unverified_note": "Crossfire standard unresolved. See docs/RULES.md."
}'::jsonb);

-- ----------------------------------------------------------------------------
-- Division ladder templates, attached to a roping via
-- rodeo_events.division_config.
-- ----------------------------------------------------------------------------
create table division_templates (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid references organizations (id) on delete cascade,

    name        text not null,
    system      text not null,
    season      text,
    config      jsonb not null,
    is_system   boolean not null default false,

    created_at  timestamptz not null default now(),

    constraint division_template_ownership check (
        (is_system and org_id is null) or (not is_system and org_id is not null)
    )
);

alter table division_templates enable row level security;
alter table division_templates force row level security;

create policy division_templates_read on division_templates
    for select using (is_system or app_is_org_member(org_id));

create policy division_templates_write on division_templates
    for all
    using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

insert into division_templates (name, system, season, is_system, config) values
('USTRC Standard Ladder 2026', 'USTRC', '2026', true, '{
    "system": "USTRC",
    "season": "2026",
    "heeler_at_least_header": false,
    "divisions": [
        {"name": "#7",    "max_combined": 7,    "header_cap": 4, "heeler_cap": 3, "elite_excluded": true},
        {"name": "#9",    "max_combined": 9,    "header_cap": 5, "heeler_cap": 5, "elite_excluded": true},
        {"name": "#10",   "max_combined": 10,   "header_cap": 6, "heeler_cap": 6},
        {"name": "#11",   "max_combined": 11,   "header_cap": 7, "heeler_cap": 7},
        {"name": "#12",   "max_combined": 12,   "header_cap": 8, "heeler_cap": 8},
        {"name": "#13",   "max_combined": 13,   "header_cap": null, "heeler_cap": null},
        {"name": "Open",  "max_combined": null, "header_cap": null, "heeler_cap": null}
    ],
    "unverified": true,
    "unverified_note": "Illustrative ladder. Confirm against the current USTRC rulebook before running a sanctioned roping."
}'::jsonb),

('WSTR Standard Ladder 2026', 'WSTR', '2026', true, '{
    "system": "WSTR",
    "season": "2026",
    "heeler_at_least_header": false,
    "divisions": [
        {"name": "#7.5",  "max_combined": 7.5,  "header_cap": 4, "heeler_cap": 4, "excluded_numbers": [4.5], "elite_excluded": true},
        {"name": "#8.5",  "max_combined": 8.5,  "header_cap": 5, "heeler_cap": 5, "elite_excluded": true},
        {"name": "#9.5",  "max_combined": 9.5,  "header_cap": 6, "heeler_cap": 6},
        {"name": "#10.5", "max_combined": 10.5, "header_cap": 7, "heeler_cap": 7},
        {"name": "#11.5", "max_combined": 11.5, "header_cap": 8, "heeler_cap": 8},
        {"name": "#12.5", "max_combined": 12.5, "header_cap": null, "heeler_cap": null},
        {"name": "#13.5", "max_combined": 13.5, "header_cap": null, "heeler_cap": null},
        {"name": "Open",  "max_combined": null, "header_cap": null, "heeler_cap": null}
    ],
    "unverified": true,
    "unverified_note": "The #7.5 cap of #4 on both ends and the #4.5 exclusion are confirmed for 2026; the rest of the ladder is illustrative."
}'::jsonb);

create trigger roper_classifications_touch
    before update on roper_classifications
    for each row execute function touch_updated_at();

-- RLS for classifications: a roper sees their own numbers; entry-desk staff
-- see the numbers of anyone entered with them; the numbers themselves are not
-- secret within an org, but they are not world-readable either.
alter table roper_classifications enable row level security;
alter table roper_classifications force row level security;

create policy classifications_self_read on roper_classifications
    for select using (user_id = app_current_user_id());

create policy classifications_staff_read on roper_classifications
    for select using (
        exists (
            select 1 from org_members m
            where m.user_id = roper_classifications.user_id
              and app_is_org_staff(m.org_id)
        )
    );

-- Only association-verified numbers should be written by staff; a roper
-- cannot raise or lower their own.
create policy classifications_staff_write on roper_classifications
    for all
    using (
        exists (
            select 1 from org_members m
            where m.user_id = roper_classifications.user_id
              and app_is_org_staff(m.org_id)
        )
    )
    with check (
        exists (
            select 1 from org_members m
            where m.user_id = roper_classifications.user_id
              and app_is_org_staff(m.org_id)
        )
    );
