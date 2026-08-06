-- ============================================================================
-- 0003_rodeos.sql
-- Rodeos, sanctioning approvals, disciplines, performances.
--
-- Architecture ref: §2.2.3, §2.2.4, §2.2.10
-- ============================================================================

create table rodeos (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,

    name        text not null,
    slug        text not null,
    description text,

    start_date  date not null,
    end_date    date not null,
    timezone    text not null default 'America/Denver',

    venue_name      text,
    venue_address   text,
    venue_city      text,
    venue_state     text,
    venue_country   text not null default 'US',
    venue_lat       decimal(9, 6),
    venue_lng       decimal(9, 6),

    rodeo_type  text not null check (rodeo_type in (
                    'jackpot', 'sanctioned', 'open', 'invitational',
                    'youth', 'amateur', 'college', 'high_school',
                    'finals', 'tour_stop'
                )),

    num_performances int not null default 1 check (num_performances >= 1),
    num_go_rounds    int not null default 1 check (num_go_rounds >= 1),
    has_short_go     boolean not null default false,
    has_slack        boolean not null default false,

    total_added_money decimal(12, 2) not null default 0 check (total_added_money >= 0),

    status      text not null default 'draft' check (status in (
                    'draft', 'published', 'entries_open', 'entries_closed',
                    'in_progress', 'completed', 'results_official', 'settled',
                    'cancelled'
                )),

    entry_open_date       timestamptz,
    entry_close_date      timestamptz,
    max_entries_per_event int,
    allow_online_entry    boolean not null default true,

    ground_rules text,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, slug),
    unique (org_id, id),                    -- composite-FK target
    constraint rodeo_dates check (end_date >= start_date)
);

create index idx_rodeos_org_date on rodeos (org_id, start_date desc);
create index idx_rodeos_status on rodeos (org_id, status);

-- ----------------------------------------------------------------------------
-- A rodeo can be approved by more than one sanctioning body, each of which
-- brings its own scoring and payout rules.
-- ----------------------------------------------------------------------------
create table rodeo_sanctioning (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,

    sanctioning_body text not null,         -- 'PRCA', 'WPRA', 'PBR', 'IPRA', 'CPRA_CA', ...
    approval_number  text,
    approval_status  text not null default 'pending' check (approval_status in (
                        'pending', 'approved', 'denied', 'conditional'
                    )),

    scoring_config_id uuid references scoring_configs (id),
    payout_config_id  uuid references payout_configs (id),

    created_at  timestamptz not null default now(),

    unique (rodeo_id, sanctioning_body),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_rodeo_sanc on rodeo_sanctioning (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- Disciplines within a rodeo
-- ----------------------------------------------------------------------------
create table rodeo_events (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,

    event_type  text not null check (event_type in (
                    'bareback', 'saddle_bronc', 'bull_riding', 'tie_down_roping',
                    'steer_wrestling', 'team_roping_header', 'team_roping_heeler',
                    'barrel_racing', 'breakaway_roping', 'goat_tying',
                    'pole_bending', 'reined_cow_horse', 'steer_roping',
                    'ranch_bronc', 'mutton_busting', 'calf_riding',
                    'jr_bull_riding', 'jr_barrel_racing', 'other'
                )),

    scoring_mode text not null check (scoring_mode in ('judged', 'timed')),

    -- Roughstock flag drives day-money eligibility (§6.4). The architecture's
    -- payout code reads rodeoEvent.is_roughstock but never defines the column.
    -- See docs/SPEC-DELTAS.md D14.
    is_roughstock boolean not null default false,

    entry_fee            decimal(10, 2) not null default 0 check (entry_fee >= 0),
    additional_entry_fee decimal(10, 2) not null default 0 check (additional_entry_fee >= 0),
    added_money          decimal(10, 2) not null default 0 check (added_money >= 0),
    stock_charge         decimal(10, 2) not null default 0 check (stock_charge >= 0),

    num_go_rounds  int not null default 1 check (num_go_rounds >= 1),
    has_short_go   boolean not null default false,
    short_go_count int,

    scoring_config_id uuid references scoring_configs (id),
    payout_config_id  uuid references payout_configs (id),

    -- D-format (barrel racing, pole bending)
    is_d_format     boolean not null default false,
    d_format_config jsonb,
    -- {"divisions":4,"time_splits":[0,0.5,1.0,2.0],"division_pcts":[0.35,0.30,0.20,0.15]}

    sort_order  int not null default 0,
    status      text not null default 'active'
                check (status in ('active', 'cancelled')),

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, id),                    -- composite-FK target
    unique (rodeo_id, event_type),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    constraint d_format_needs_config check (not is_d_format or d_format_config is not null),
    constraint short_go_needs_count check (not has_short_go or short_go_count is not null)
);

create index idx_rodeo_events on rodeo_events (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- Performances and slack
-- ----------------------------------------------------------------------------
create table performances (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,

    performance_number int not null,
    name        text,                       -- "Friday Night", "Saturday Matinee"
    performance_type text not null default 'performance' check (performance_type in (
                        'performance', 'slack', 'short_go', 'finals'
                    )),

    scheduled_start timestamptz,
    actual_start    timestamptz,
    actual_end      timestamptz,

    -- Arena maintenance. WPRA requires a drag every N runs in barrel racing.
    arena_dragged_after int,
    condensed_drag      boolean not null default false,

    status      text not null default 'scheduled' check (status in (
                    'scheduled', 'in_progress', 'completed', 'cancelled'
                )),

    created_at  timestamptz not null default now(),

    unique (rodeo_id, performance_number),
    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_performances on performances (org_id, rodeo_id, performance_number);
