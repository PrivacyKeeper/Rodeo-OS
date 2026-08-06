-- ============================================================================
-- 0005_scores_and_results.sql
-- Individual runs/rides and the aggregated placings derived from them.
--
-- Architecture ref: §2.2.7
--
-- Scores keep BOTH the raw judge/timer inputs and the calculated outcome
-- (§2.4 #2). If a sanctioning body changes a rule mid-season, historical runs
-- can be recomputed from the inputs that were actually recorded.
-- ============================================================================

create table scores (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,
    rodeo_event_id  uuid not null,
    entry_id        uuid not null,
    contestant_id   uuid not null references users (id),

    go_round        int not null default 1,
    performance     int,

    -- ---- Timed events -----------------------------------------------------
    raw_time        decimal(10, 3) check (raw_time >= 0),
    time_penalties  jsonb not null default '[]'::jsonb,
    -- [{"type":"barrier_break","seconds":10.0}]
    final_time      decimal(10, 3) check (final_time >= 0),

    -- ---- Judged events ----------------------------------------------------
    judge_scores    jsonb not null default '[]'::jsonb,
    -- [{"judge_id":"uuid","judge_position":1,"rider":23.0,"animal":22.5}]
    final_score     decimal(8, 2),

    animal_id       uuid,
    animal_score    decimal(8, 2),          -- animal half, for stock standings

    status          text not null default 'provisional' check (status in (
                        'provisional', 'official', 'dq', 'no_time', 'reride',
                        'medical_out', 'turned_out', 'scratched'
                    )),
    dq_reason       text,

    is_reride       boolean not null default false,
    original_score_id uuid references scores (id),
    reride_reason   text,

    -- Provenance drives offline conflict resolution: hardware outranks a
    -- secretary keystroke, which outranks anything else (§4.4).
    source          text not null default 'manual' check (source in (
                        'manual', 'timer_hardware', 'web_serial', 'import',
                        'timer_bridge'
                    )),
    hardware_timestamp bigint,              -- FarmTek: 125us resolution

    -- Immutable pointer to the ruleset that produced final_score/final_time
    scoring_config_id uuid references scoring_configs (id),

    entered_by      uuid references users (id),
    last_edited_by  uuid references users (id),
    edit_history    jsonb not null default '[]'::jsonb,
    -- append-only: [{"at":"ISO8601","by":"uuid","field":"final_score","from":85.0,"to":85.5}]

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade,
    foreign key (org_id, entry_id) references entries (org_id, id) on delete cascade,
    foreign key (org_id, animal_id) references animals (org_id, id),

    -- A run cannot be simultaneously timed and judged.
    constraint score_is_timed_xor_judged check (
        (raw_time is null and final_time is null)
        or (final_score is null and animal_score is null)
    ),
    -- A disqualification has to say why.
    constraint dq_has_reason check (status <> 'dq' or dq_reason is not null)
);

create index idx_scores_event_round on scores (org_id, rodeo_event_id, go_round);
create index idx_scores_contestant on scores (contestant_id, rodeo_id);
create index idx_scores_status on scores (org_id, rodeo_event_id, status)
    where status in ('provisional', 'official');

-- Exactly one live score per entry per go-round. A reride is a new row and the
-- original is marked 'reride', which frees the slot.
create unique index idx_scores_one_live_per_entry
    on scores (entry_id, go_round)
    where status in ('provisional', 'official');

-- ----------------------------------------------------------------------------
-- Aggregated placings
-- ----------------------------------------------------------------------------
create table results (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,
    rodeo_event_id  uuid not null,
    contestant_id   uuid not null references users (id),

    result_type     text not null check (result_type in (
                        'go_round', 'average', 'aggregate', 'd_division',
                        'day_money', 'overall'
                    )),
    go_round        int,                    -- null for average/aggregate
    d_division      int,                    -- 1..4 for D-format

    aggregate_score decimal(10, 3),
    place           int check (place >= 1),
    tied_with       uuid[] not null default '{}',

    payout_amount   decimal(12, 2) not null default 0 check (payout_amount >= 0),
    ground_money    decimal(12, 2) not null default 0 check (ground_money >= 0),
    day_money       decimal(12, 2) not null default 0 check (day_money >= 0),

    points_earned   decimal(10, 2) not null default 0,

    is_official     boolean not null default false,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade
);

-- The architecture's UNIQUE(rodeo_event_id, contestant_id, result_type,
-- go_round, d_division) does not do what it looks like: go_round and
-- d_division are nullable, and in SQL NULLs never collide, so the average row
-- is duplicable. NULLS NOT DISTINCT fixes it. See docs/SPEC-DELTAS.md D15.
create unique index idx_results_unique
    on results (rodeo_event_id, contestant_id, result_type, go_round, d_division)
    nulls not distinct;

create index idx_results_event
    on results (org_id, rodeo_event_id, result_type, place);
