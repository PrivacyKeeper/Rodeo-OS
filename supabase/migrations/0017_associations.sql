-- ============================================================================
-- 0017_associations.sql
-- Sanctioning bodies as configuration, not as code.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
-- ---------------------------------------------------------------------------
-- Up to now a sanctioning body was a string on `rodeo_sanctioning` plus an
-- option row for the dropdown. That is enough to LABEL a rodeo "PRCA" and
-- nothing more: it carries no rules, no event list, no filing deadline, no
-- statement of who has to be carded, no fee basis.
--
-- The consequence is that every association-specific behaviour has to live
-- somewhere in code, and the number of associations in this sport is large and
-- growing: PRCA, WPRA, IPRA, CPRA, NPRA, PCA, USTRC, WSTR, NBHA, NHSRA, NLBRA,
-- plus every state and regional association and every ranch-rodeo circuit.
-- Hard-coding them is the fragmentation, reproduced inside our own product.
--
-- The failure mode is documented and recent. When breakaway roping was added
-- to professional rodeo, PROCOM had immediate problems because the system was
-- not built to take another event. Adding an event broke it.
--
-- Here, an association is a row. Its rules, its events, its money basis, its
-- filing deadline and its credential requirements are columns and JSONB on
-- that row. A producer's own local association is the same shape as PRCA, with
-- org_id set instead of null. Nobody deploys anything to add one.
--
-- ---------------------------------------------------------------------------
-- ON THE SEEDED VALUES
-- ---------------------------------------------------------------------------
-- Every seeded row carries verified_against and verified_on, the same
-- discipline as docs/RULES.md. Where a value came from a secondary source it
-- says so in those columns and the value is NOT to be relied on for a real
-- sanctioned rodeo until somebody checks it against the rule book. An
-- association profile that is quietly wrong about a filing deadline is worse
-- than one that is obviously empty.
-- ============================================================================

create table associations (
    id          uuid primary key default gen_random_uuid(),

    /** Null = system profile, visible to every tenant. */
    org_id      uuid references organizations (id) on delete cascade,
    is_system   boolean not null default false,

    /** Stable machine code. Matches rodeo_sanctioning.sanctioning_body. */
    code        text not null,
    name        text not null,
    short_name  text,

    country     text not null default 'US',
    website     text,

    /**
     * What kind of body this is. Drives nothing in the engine -- it is a label
     * for grouping in the dropdown -- so it is deliberately loose.
     */
    association_type text not null default 'rodeo' check (association_type in (
        'rodeo', 'roping', 'barrel_racing', 'bull_riding', 'ranch_rodeo',
        'youth', 'collegiate', 'high_school', 'breakaway', 'other'
    )),

    -- ------------------------------------------------------------------
    -- Rules
    -- ------------------------------------------------------------------
    default_scoring_config_id uuid references scoring_configs (id),
    default_payout_config_id  uuid references payout_configs (id),

    /**
     * Event codes this body sanctions, from reference_options domain
     * 'event_type'. Empty array means "no opinion" -- the producer picks from
     * the full list.
     */
    event_codes text[] not null default '{}',

    /**
     * Membership classes a contestant can hold.
     * [{"code":"card","label":"Card Holder"},{"code":"permit","label":"Permit"}]
     */
    membership_classes jsonb not null default '[]'::jsonb,

    /**
     * Contract personnel this body requires, and whether the card matters.
     * [{"role":"judge","min_count":2,"must_be_carded":true}]
     *
     * This is what lets the OS tell a committee it is not compliant before the
     * rodeo rather than after. Without it, a credential registry is a filing
     * cabinet.
     */
    required_credentials jsonb not null default '[]'::jsonb,

    -- ------------------------------------------------------------------
    -- Money
    -- ------------------------------------------------------------------
    /**
     * {"association_pct": 0.06,
     *  "basis": "added_plus_entries",
     *  "deducted_before_payoff": true,
     *  "remitted_with_results": true}
     *
     * Read by the payout engine as data. No association's percentage appears
     * anywhere in TypeScript.
     */
    fee_schedule jsonb not null default '{}'::jsonb,

    /**
     * {"basis":"earnings","period":"season","qualifies":"top_15",
     *  "counts_events":["..."]}
     */
    standings_config jsonb not null default '{}'::jsonb,

    -- ------------------------------------------------------------------
    -- Filing. The reason close-the-books exists.
    -- ------------------------------------------------------------------
    /**
     * A completed rodeo has to reach the association by a wall-clock deadline
     * after the final performance, and being late costs money. Expressed as a
     * local time plus a timezone rather than a duration, because that is how
     * the rules are actually written: "11:59 p.m. Mountain Time".
     */
    results_due_local_time text,               -- '23:59'
    results_due_timezone   text,               -- 'America/Denver'
    /** Days after the final performance the deadline falls on. 0 = same night. */
    results_due_day_offset int not null default 0 check (results_due_day_offset >= 0),
    late_filing_fine_cents int check (late_filing_fine_cents >= 0),

    /**
     * Some bodies mandate their own software. PRCA requires the PRCA Secretary
     * System "except when the particular rodeo requires another system" -- so
     * this is recorded as a fact about the association, with the carve-out
     * captured, rather than assumed one way or the other.
     */
    mandates_own_system boolean not null default false,
    system_carve_out    text,

    -- ------------------------------------------------------------------
    -- Provenance. Same discipline as docs/RULES.md.
    -- ------------------------------------------------------------------
    verified_against text,
    verified_on      date,
    /** False when a value came from a secondary source and needs checking. */
    is_verified      boolean not null default false,

    notes       text,
    is_active   boolean not null default true,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint association_ownership check (
        (is_system and org_id is null) or (not is_system and org_id is not null)
    ),
    constraint results_due_needs_zone check (
        results_due_local_time is null or results_due_timezone is not null
    ),
    unique (org_id, id)                        -- composite-FK target
);

create unique index idx_assoc_system_code
    on associations (code) where org_id is null;
create unique index idx_assoc_org_code
    on associations (code, org_id) where org_id is not null;
create index idx_assoc_active on associations (association_type, code)
    where is_active;

alter table associations enable row level security;
alter table associations force row level security;

-- System profiles are reference data: everybody signed in can read them, and
-- the public scoreboard needs the name to render "PRCA-approved".
create policy associations_read on associations
    for select using (org_id is null or app_is_org_member(org_id));

create policy associations_write on associations
    for all
    using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

create trigger associations_touch
    before update on associations
    for each row execute function touch_updated_at();

grant select on associations to anon, authenticated;
grant insert, update, delete on associations to authenticated;

-- ----------------------------------------------------------------------------
-- Bind the existing sanctioning rows to a profile.
--
-- Nullable and not backfilled by a guess: a rodeo whose sanctioning_body
-- string does not match a known code keeps working exactly as before with a
-- null association_id. Silently attaching the wrong association's rules to a
-- sanctioned rodeo would be a worse outcome than attaching none.
-- ----------------------------------------------------------------------------
alter table rodeo_sanctioning
    add column association_id uuid references associations (id);

create index idx_rodeo_sanc_assoc on rodeo_sanctioning (association_id);

comment on column rodeo_sanctioning.association_id is
    'Resolved association profile. Null when the body string matches no profile.';

-- ----------------------------------------------------------------------------
-- Resolve the profile that applies to a rodeo, preferring the tenant''s own
-- override of a system code.
-- ----------------------------------------------------------------------------
create or replace function association_for(p_org_id uuid, p_code text)
returns associations
language sql
stable
as $$
    select *
      from associations
     where code = p_code
       and is_active
       and (org_id = p_org_id or org_id is null)
     order by (org_id is not null) desc      -- tenant override wins
     limit 1;
$$;

comment on function association_for is
    'The association profile in force for a tenant: their own override if they have one, otherwise the system profile.';

-- ============================================================================
-- Seed. System profiles.
--
-- Read the provenance columns before trusting any of this in an arena.
-- ============================================================================

insert into associations (
    org_id, is_system, code, name, short_name, association_type, country,
    event_codes, membership_classes, required_credentials,
    fee_schedule, standings_config,
    results_due_local_time, results_due_timezone, results_due_day_offset,
    late_filing_fine_cents, mandates_own_system, system_carve_out,
    verified_against, verified_on, is_verified, notes
) values

-- ---------------------------------------------------------------------------
(null, true, 'PRCA', 'Professional Rodeo Cowboys Association', 'PRCA', 'rodeo', 'US',
 array['bareback','saddle_bronc','bull_riding','tie_down_roping','steer_wrestling',
       'team_roping_header','team_roping_heeler','steer_roping','breakaway_roping'],
 '[{"code":"card","label":"Card Holder"},{"code":"permit","label":"Permit Holder"}]'::jsonb,
 '[{"role":"judge","min_count":2,"must_be_carded":true},
   {"role":"secretary","min_count":1,"must_be_carded":true},
   {"role":"timer_operator","min_count":2,"must_be_carded":true},
   {"role":"pickup_rider","min_count":2,"must_be_carded":false},
   {"role":"bullfighter","min_count":2,"must_be_carded":false}]'::jsonb,
 '{"association_pct":0.06,"basis":"added_plus_entries","deducted_before_payoff":true,"remitted_with_results":true}'::jsonb,
 '{"basis":"earnings","period":"season","qualifies":"top_15","final":"NFR"}'::jsonb,
 '23:59', 'America/Denver', 0,
 10000, true,
 'Rule provides for use of another system when the particular rodeo requires one.',
 'Secondary sources only (association summaries and trade press, Aug 2026). NOT checked against the PRCA rule book.',
 '2026-08-07', false,
 'The 6% deduction, the 11:59pm Mountain filing deadline, the $100 late fine and the Secretary System carve-out all come from secondary sources. Every one of them needs the rule number and the rule text before a sanctioned rodeo relies on it.'),

-- ---------------------------------------------------------------------------
(null, true, 'WPRA', 'Women''s Professional Rodeo Association', 'WPRA', 'barrel_racing', 'US',
 array['barrel_racing','breakaway_roping','team_roping_header','team_roping_heeler'],
 '[{"code":"card","label":"Card Holder"},{"code":"permit","label":"Permit Holder"}]'::jsonb,
 '[{"role":"judge","min_count":1,"must_be_carded":true},
   {"role":"secretary","min_count":1,"must_be_carded":false},
   {"role":"timer_operator","min_count":2,"must_be_carded":false}]'::jsonb,
 '{}'::jsonb,
 '{"basis":"earnings","period":"season","qualifies":"top_15","final":"NFR"}'::jsonb,
 null, null, 0, null, false, null,
 'WPRA rule book, reviewed 8 Aug 2026 for arena and drag rules (see docs/RULES.md).',
 '2026-08-07', false,
 'Entries for WPRA rodeos held with PRCA rodeos are taken through the same central entry office. Filing deadline not established.'),

-- ---------------------------------------------------------------------------
(null, true, 'IPRA', 'International Professional Rodeo Association', 'IPRA', 'rodeo', 'US',
 array['bareback','saddle_bronc','bull_riding','tie_down_roping','steer_wrestling',
       'team_roping_header','team_roping_heeler','barrel_racing','breakaway_roping'],
 '[{"code":"card","label":"Card Holder"}]'::jsonb,
 '[{"role":"judge","min_count":2,"must_be_carded":true},
   {"role":"secretary","min_count":1,"must_be_carded":true}]'::jsonb,
 '{}'::jsonb,
 '{"basis":"earnings","period":"season","final":"IFR"}'::jsonb,
 null, null, 0, null, false, null,
 'Three-head average format implemented in the payout engine; association-level rules unverified.',
 '2026-08-07', false, null),

-- ---------------------------------------------------------------------------
(null, true, 'USTRC', 'United States Team Roping Championships', 'USTRC', 'roping', 'US',
 array['team_roping_header','team_roping_heeler'],
 '[{"code":"member","label":"Member"}]'::jsonb,
 '[{"role":"judge","min_count":1,"must_be_carded":false}]'::jsonb,
 '{}'::jsonb,
 '{"basis":"earnings","period":"season"}'::jsonb,
 null, null, 0, null, false, null,
 'UNVERIFIED. Numbered-roping division ladders remain flagged in docs/RULES.md.',
 '2026-08-07', false,
 'Division ladders and number classifications are not sourced. Do not run a USTRC-sanctioned roping off these defaults without checking.'),

-- ---------------------------------------------------------------------------
(null, true, 'WSTR', 'World Series of Team Roping', 'WSTR', 'roping', 'US',
 array['team_roping_header','team_roping_heeler'],
 '[{"code":"member","label":"Member"}]'::jsonb,
 '[]'::jsonb, '{}'::jsonb,
 '{"basis":"earnings","period":"season"}'::jsonb,
 null, null, 0, null, false, null,
 'UNVERIFIED. Same caveat as USTRC.',
 '2026-08-07', false, null),

-- ---------------------------------------------------------------------------
(null, true, 'NBHA', 'National Barrel Horse Association', 'NBHA', 'barrel_racing', 'US',
 array['barrel_racing'],
 '[{"code":"member","label":"Member"},{"code":"youth","label":"Youth"},{"code":"senior","label":"Senior"}]'::jsonb,
 '[{"role":"timer_operator","min_count":1,"must_be_carded":false}]'::jsonb,
 '{}'::jsonb,
 '{"basis":"points","period":"season","format":"divisional"}'::jsonb,
 null, null, 0, null, false, null,
 'D-format division logic implemented and tested. Association-level rules unverified.',
 '2026-08-07', false,
 'The 4D split logic is engine-verified; what NBHA itself requires of a show is not.'),

-- ---------------------------------------------------------------------------
(null, true, 'NHSRA', 'National High School Rodeo Association', 'NHSRA', 'high_school', 'US',
 array['bareback','saddle_bronc','bull_riding','tie_down_roping','steer_wrestling',
       'team_roping_header','team_roping_heeler','barrel_racing','breakaway_roping',
       'goat_tying','pole_bending'],
 '[{"code":"student","label":"Student Member"}]'::jsonb,
 '[{"role":"judge","min_count":2,"must_be_carded":false},
   {"role":"secretary","min_count":1,"must_be_carded":false}]'::jsonb,
 '{}'::jsonb,
 '{"basis":"points","period":"season","qualifies":"state_finals"}'::jsonb,
 null, null, 0, null, false, null,
 'UNVERIFIED. Event list is the common NHSRA slate; state associations vary.',
 '2026-08-07', false,
 'Minors: signed guardian consent is required and the waiver templates already model it.'),

-- ---------------------------------------------------------------------------
(null, true, 'CPRA_CA', 'Canadian Professional Rodeo Association', 'CPRA', 'rodeo', 'CA',
 array['bareback','saddle_bronc','bull_riding','tie_down_roping','steer_wrestling',
       'team_roping_header','team_roping_heeler','barrel_racing','breakaway_roping'],
 '[{"code":"card","label":"Card Holder"},{"code":"permit","label":"Permit"}]'::jsonb,
 '[]'::jsonb, '{}'::jsonb,
 '{"basis":"earnings","period":"season","currency":"CAD","final":"CFR"}'::jsonb,
 null, null, 0, null, false, null,
 'UNVERIFIED. Number-of-monies thresholds still flagged in docs/RULES.md.',
 '2026-08-07', false,
 'Canadian withholding applies to non-resident winnings; the withholding engine already carries the rule and its advisory.'),

-- ---------------------------------------------------------------------------
(null, true, 'PBR', 'Professional Bull Riders', 'PBR', 'bull_riding', 'US',
 array['bull_riding'],
 '[{"code":"member","label":"Member"}]'::jsonb,
 '[{"role":"judge","min_count":4,"must_be_carded":true}]'::jsonb,
 '{}'::jsonb,
 '{"basis":"points","period":"season","final":"World Finals"}'::jsonb,
 null, null, 0, null, false, null,
 'Four judges at 0-25 each, combined and divided by two, tenth-point marking for 2026. Sourced and dated in docs/RULES.md.',
 '2026-08-07', true,
 'The judge count here is load-bearing: seeding it as one judge at 0-50 recorded a 90-point ride as 180. See delta D21.'),

-- ---------------------------------------------------------------------------
(null, true, 'OPEN', 'Open / Unsanctioned', 'Open', 'other', 'US',
 '{}',
 '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
 null, null, 0, null, false, null,
 'Not an association. The default for a jackpot, playday or open roping.',
 '2026-08-07', true,
 'Selecting this asks the producer nothing about compliance, credentials or filing. It is what most rodeos in the country are, and it must stay the path of least resistance.');

-- ----------------------------------------------------------------------------
-- Backfill, after the seed so the codes exist to match against.
--
-- Exact code match only. A rodeo whose sanctioning_body string matches no
-- profile keeps working with a null association_id -- attaching the wrong
-- association's rules to a sanctioned rodeo is worse than attaching none.
-- ----------------------------------------------------------------------------
update rodeo_sanctioning rs
   set association_id = a.id
  from associations a
 where a.org_id is null
   and a.code = rs.sanctioning_body
   and rs.association_id is null;

comment on table associations is
    'A sanctioning body as configuration. Adding one is a row, never a deploy.';
