-- ============================================================================
-- 0002_configs.sql
-- Versioned scoring and payout configuration.
--
-- Architecture ref: §2.2.7 (scoring_configs), §2.2.8 (payout_configs)
--
-- ORDERING NOTE: the architecture defines these in §2.2.7/§2.2.8, but
-- rodeo_sanctioning (§2.2.3) and rodeo_events (§2.2.4) both hold FKs to them.
-- Executed in document order the schema does not build. Configs come first
-- here. See docs/SPEC-DELTAS.md D7.
--
-- Every rule the scoring and payout engines apply is DATA in these tables, not
-- code. A sanctioning body changing a rule mid-season is a new config row with
-- a later effective_date, never a code deploy. Scores keep an immutable
-- reference to the config that produced them so historical results stay
-- reproducible.
-- ============================================================================

create table scoring_configs (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid references organizations (id) on delete cascade,
                -- NULL = system-provided template, visible to every tenant

    name        text not null,              -- "PBR 2026 Bull Riding"
    sanctioning_body text,                  -- 'PRCA', 'WPRA', 'PBR', 'IPRA', ...
    event_type  text,                       -- see rodeo_events.event_type
    season      text,                       -- "2026"
    effective_date date,

    -- Shape documented in packages/types/src/scoring.ts (ScoringConfigBody).
    config      jsonb not null,

    is_system   boolean not null default false,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    -- A tenant config must belong to a tenant; a system config must not.
    constraint scoring_config_ownership check (
        (is_system and org_id is null) or (not is_system and org_id is not null)
    )
);

create index idx_scoring_configs_body
    on scoring_configs (sanctioning_body, season, event_type);
create index idx_scoring_configs_org on scoring_configs (org_id);

create table payout_configs (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid references organizations (id) on delete cascade,

    name        text not null,              -- "PRCA Standard 2026"
    sanctioning_body text,
    season      text,
    effective_date date,

    -- Shape documented in packages/types/src/payouts.ts (PayoutConfigBody).
    config      jsonb not null,

    is_system   boolean not null default false,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint payout_config_ownership check (
        (is_system and org_id is null) or (not is_system and org_id is not null)
    )
);

create index idx_payout_configs_body
    on payout_configs (sanctioning_body, season);
create index idx_payout_configs_org on payout_configs (org_id);
