-- ============================================================================
-- 0004_entries_and_stock.sql
-- Entries, buddy groups, livestock, stock draws.
--
-- Architecture ref: §2.2.5, §2.2.6
-- ============================================================================

create table buddy_groups (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,
    name        text,
    created_by  uuid references users (id),
    created_at  timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create table entries (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,
    rodeo_event_id  uuid not null,
    contestant_id   uuid not null references users (id),

    -- Team roping partner (header entry names the heeler and vice versa)
    partner_id      uuid references users (id),

    -- Ropers commonly enter the same event more than once with different
    -- partners or different horses. The architecture's unique index forbids
    -- that outright; here the slot number distinguishes the runs.
    -- See docs/SPEC-DELTAS.md D10.
    entry_slot      int not null default 1 check (entry_slot >= 1),

    entry_type      text not null default 'official' check (entry_type in (
                        'official', 'unofficial', 'exhibition', 'permit'
                    )),
    -- WPRA: only 'official' entries carry World Championship points.

    status          text not null default 'pending' check (status in (
                        'pending', 'confirmed', 'drawn', 'scratched',
                        'turned_out', 'medical_release', 'no_show',
                        'disqualified'
                    )),

    procom_confirmation text,

    -- Draw assignment, written by the draw engine
    performance_number int,
    go_round_number    int not null default 1,
    draw_position      int,

    buddy_group_id  uuid,

    entry_fee_amount decimal(10, 2) check (entry_fee_amount >= 0),
    fees_paid        boolean not null default false,
    payment_id       text,                  -- Stripe PaymentIntent

    -- PRCA requires notice at least 30h before the performance for a turnout
    -- not to carry a fine.
    turnout_notified_at timestamptz,
    release_type        text check (release_type in ('medical', 'personal', 'stock_issue')),

    entered_at      timestamptz not null default now(),
    confirmed_at    timestamptz,
    drawn_at        timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade,
    foreign key (org_id, buddy_group_id) references buddy_groups (org_id, id) on delete set null,
    constraint partner_is_not_self check (partner_id is null or partner_id <> contestant_id)
);

create index idx_entries_rodeo on entries (org_id, rodeo_id, rodeo_event_id);
create index idx_entries_contestant on entries (contestant_id, rodeo_id);
create index idx_entries_status on entries (org_id, rodeo_id, status);

-- One live entry per contestant per slot per go-round. Scratched and turned-out
-- entries are excluded so the slot can be re-entered.
create unique index idx_entries_unique
    on entries (rodeo_event_id, contestant_id, entry_slot, go_round_number)
    where status not in ('scratched', 'turned_out');

-- ----------------------------------------------------------------------------
-- Livestock
-- ----------------------------------------------------------------------------
create table animals (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,

    contractor_id uuid references users (id),

    name        text not null,
    brand_number text,
    registration_number text,

    animal_type text not null check (animal_type in (
                    'bull', 'saddle_bronc', 'bareback_bronc',
                    'calf', 'steer', 'horse', 'goat'
                )),
    breed       text,
    color       text,
    sex         text check (sex in ('male', 'female', 'gelding', 'steer')),

    -- PRCA weight rules: tie-down calves 220-280 lb, steers 450-650 lb.
    -- Enforced in the compliance module rather than as a CHECK, because the
    -- limits differ by sanctioning body and by youth division.
    weight_lbs  int check (weight_lbs > 0),
    date_of_birth date,

    career_stats jsonb not null default '{}'::jsonb,
    -- {"avg_score":42.5,"buckoff_pct":68.2,"total_outs":147}

    health_status text not null default 'active' check (health_status in (
                        'active', 'injured', 'retired', 'deceased'
                    )),
    last_vet_check date,

    -- WPRA PESI sire-incentive lineage
    sire_id     uuid references animals (id),
    dam_id      uuid references animals (id),
    pesi_enrolled boolean not null default false,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, id)
);

create index idx_animals_org on animals (org_id);
create index idx_animals_contractor on animals (org_id, contractor_id);
create index idx_animals_type on animals (org_id, animal_type);

-- ----------------------------------------------------------------------------
-- Stock draw assignments
-- ----------------------------------------------------------------------------
create table stock_draws (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,
    rodeo_event_id uuid not null,

    entry_id    uuid not null,
    animal_id   uuid not null,

    go_round    int not null default 1,
    performance int,

    is_redraw       boolean not null default false,
    original_draw_id uuid references stock_draws (id),
    redraw_reason   text check (redraw_reason in ('turnout', 'reride', 'animal_issue')),

    created_at  timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade,
    foreign key (org_id, entry_id) references entries (org_id, id) on delete cascade,
    foreign key (org_id, animal_id) references animals (org_id, id)
);

create index idx_stock_draws on stock_draws (org_id, rodeo_event_id, go_round);

-- An animal is drawn once per go-round unless the first draw was superseded.
create unique index idx_stock_draws_animal_once
    on stock_draws (rodeo_event_id, go_round, animal_id)
    where not is_redraw;
