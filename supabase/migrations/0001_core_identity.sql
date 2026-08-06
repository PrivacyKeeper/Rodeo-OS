-- ============================================================================
-- 0001_core_identity.sql
-- Organizations (tenants), global users, and org membership.
--
-- Architecture ref: §2.2.1 Organizations, §2.2.2 Users and Roles
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ----------------------------------------------------------------------------
-- Organizations (tenants)
-- ----------------------------------------------------------------------------
create table organizations (
    id          uuid primary key default gen_random_uuid(),

    name        text not null,
    slug        text unique not null,          -- "smith-rodeo-company"
    type        text not null check (type in (
                    'producer', 'association', 'stock_contractor', 'venue'
                )),

    country     text not null default 'US',    -- ISO 3166-1 alpha-2
    timezone    text not null default 'America/Denver',
    currency    text not null default 'USD',   -- ISO 4217

    -- Stripe Connect (the org receives entry fees and disburses payouts)
    stripe_account_id           text,
    stripe_onboarding_complete  boolean not null default false,

    settings    jsonb not null default '{
        "default_scoring_config": null,
        "default_payout_config": null,
        "branding": {
            "logo_url": null,
            "primary_color": "#1a1a1a",
            "secondary_color": "#d4a017"
        },
        "notifications": {
            "email_results": true,
            "sms_enabled": false
        }
    }'::jsonb,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    deleted_at  timestamptz
);

create index idx_org_slug on organizations (slug) where deleted_at is null;

-- ----------------------------------------------------------------------------
-- Users are GLOBAL, not per-org. A contestant competes under many producers;
-- their profile, memberships and tax identity exist exactly once. (§2.4 #1)
-- ----------------------------------------------------------------------------
create table users (
    id              uuid primary key default gen_random_uuid(),

    email           citext unique,
    phone           text,
    first_name      text not null,
    last_name       text not null,
    date_of_birth   date,

    address_line1   text,
    address_line2   text,
    city            text,
    state_province  text,
    postal_code     text,
    country         text not null default 'US',

    -- Tax / compliance. The full identifier is NEVER stored here: it lives in
    -- Stripe, which is the system of record for tax identity.
    tax_id_type     text check (tax_id_type in ('ssn', 'ein', 'abn', 'cpf', 'sin')),
    tax_id_last4    text check (tax_id_last4 ~ '^[0-9]{4}$'),
    tax_id_verified boolean not null default false,

    -- Association memberships, denormalised for lookup speed.
    -- [{"body":"PRCA","number":"12345","expires":"2026-12-31","verified":false}]
    memberships     jsonb not null default '[]'::jsonb,

    -- Stripe. A user both PAYS (customer) and is PAID (connected account).
    -- Deviation from architecture v1.0, which only modelled stripe_customer_id
    -- and therefore had no way to disburse winnings. See docs/SPEC-DELTAS.md D13.
    stripe_customer_id          text,
    stripe_account_id           text,
    stripe_payouts_enabled      boolean not null default false,

    -- Link to Supabase Auth. Nullable: secretaries create contestant records
    -- for people who have never signed in.
    supabase_auth_id    uuid unique,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_users_email on users (email);
create index idx_users_name on users (last_name, first_name);
create index idx_users_supabase on users (supabase_auth_id);

-- ----------------------------------------------------------------------------
-- Organization membership (many-to-many, one row per role held)
-- ----------------------------------------------------------------------------
create table org_members (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    user_id     uuid not null references users (id) on delete cascade,

    role        text not null check (role in (
                    'owner', 'admin', 'secretary', 'judge', 'announcer',
                    'timer_operator', 'stock_contractor', 'pickup_rider',
                    'bullfighter', 'clown', 'gate_puller', 'chute_boss',
                    'veterinarian', 'sports_medicine', 'contestant'
                )),
    permissions jsonb not null default '{}'::jsonb,

    invited_at  timestamptz,
    accepted_at timestamptz,

    created_at  timestamptz not null default now(),

    unique (org_id, user_id, role)
);

create index idx_org_members_org on org_members (org_id);
create index idx_org_members_user on org_members (user_id);

-- Tenant-scoped tables below carry a `unique (org_id, id)` key so that their
-- children can declare COMPOSITE foreign keys on (org_id, parent_id). That is
-- what actually makes a cross-tenant reference impossible at the database
-- level. §2.4 #5 claims this is done but no table in the architecture declares
-- one — every FK there is single-column. See docs/SPEC-DELTAS.md D8.
