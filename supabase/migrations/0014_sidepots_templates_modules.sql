-- ============================================================================
-- 0014_sidepots_templates_modules.sql
--
-- Three things the Toast/Procore model requires that Architecture v1.0 has no
-- table for:
--
--   1. SIDEPOTS. Every jackpot has them. A roper enters the #10, then throws
--      $20 at the incentive and $20 at the sidepot. Three separate purses off
--      one run, paid to three different lists of people. Without this the
--      secretary is running the jackpot on paper next to the software, which
--      is exactly the failure mode "the only app you need" has to avoid.
--
--   2. TEMPLATES. Procore clones a project; Toast clones a menu. A producer
--      runs the same rodeo every year with the same events, fees, ground rules
--      and payout ladder. Rebuilding it from scratch each season is the reason
--      people stay on spreadsheets.
--
--   3. MODULE ENTITLEMENT. §3.2 sells Core, Premium and Discipline modules but
--      the schema has nowhere to record who bought what. That is the business
--      model, and it needs a table before it needs a billing integration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Sidepots, incentives and options
--
-- Modelled as a purse attached to an event rather than as an event, because a
-- sidepot is scored off the SAME run — the contestant does not go again. The
-- payout engine treats it as another pool over the same ranked field, so the
-- existing tie, ground-money and rounding behaviour applies unchanged.
-- ----------------------------------------------------------------------------
create table sidepots (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,
    rodeo_event_id uuid not null,

    name        text not null,              -- "Incentive", "$20 Sidepot", "Rookie"
    sidepot_type text not null default 'sidepot' check (sidepot_type in (
                    'sidepot',      -- optional extra purse, anyone may buy in
                    'incentive',    -- buy-in restricted by eligibility
                    'option',       -- "the option" -- added money on top
                    'rookie',       -- restricted to a contestant class
                    'senior',
                    'youth',
                    'novice',
                    'jackpot'       -- a wholly separate pot off the same run
                )),

    buy_in_cents int not null default 0 check (buy_in_cents >= 0),
    added_money_cents int not null default 0 check (added_money_cents >= 0),

    /** Own ladder, or inherit the event's. */
    payout_config_id uuid references payout_configs (id),

    /**
     * Who may buy in. Null = anyone entered in the event.
     * {"max_age":18} {"min_age":50} {"first_year_only":true}
     * {"divisions":["#9.5","#10.5"]} {"max_handicap":5}
     */
    eligibility jsonb,

    /**
     * Which go-round the sidepot is scored on. Null = the average.
     * A "fast time" sidepot pays off one round; an average sidepot pays off
     * the aggregate.
     */
    go_round    int,

    /** Sidepots usually pay 100% back -- no admin cut. */
    is_100_percent_payback boolean not null default true,

    status      text not null default 'open' check (status in (
                    'open', 'closed', 'calculated', 'paid', 'cancelled'
                )),

    sort_order  int not null default 0,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, id),
    unique (rodeo_event_id, name),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade
);

create index idx_sidepots_event on sidepots (org_id, rodeo_event_id, status);

create table sidepot_entries (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    sidepot_id  uuid not null,
    entry_id    uuid not null,
    contestant_id uuid not null references users (id),

    amount_paid_cents int not null check (amount_paid_cents >= 0),
    paid        boolean not null default false,
    payment_id  text,
    payment_method text,

    created_at  timestamptz not null default now(),

    unique (sidepot_id, entry_id),
    unique (org_id, id),
    foreign key (org_id, sidepot_id) references sidepots (org_id, id) on delete cascade,
    foreign key (org_id, entry_id) references entries (org_id, id) on delete cascade
);

create index idx_sidepot_entries on sidepot_entries (org_id, sidepot_id);

alter table sidepots enable row level security;
alter table sidepots force row level security;
alter table sidepot_entries enable row level security;
alter table sidepot_entries force row level security;

-- Sidepots are public once the rodeo is: contestants shop them before entering.
create policy sidepots_public_read on sidepots
    for select using (
        exists (
            select 1 from rodeos r
            where r.id = sidepots.rodeo_id
              and r.status in ('published', 'entries_open', 'entries_closed',
                               'in_progress', 'completed', 'results_official', 'settled')
        )
    );

create policy sidepots_member_read on sidepots
    for select using (app_is_org_member(org_id));

create policy sidepots_staff_write on sidepots
    for all
    using (app_is_org_staff(org_id))
    with check (app_is_org_staff(org_id));

create policy sidepot_entries_own_read on sidepot_entries
    for select using (contestant_id = app_current_user_id());

create policy sidepot_entries_staff_read on sidepot_entries
    for select using (app_is_org_member(org_id));

create policy sidepot_entries_staff_write on sidepot_entries
    for all
    using (app_is_org_staff(org_id))
    with check (app_is_org_staff(org_id));

-- Sidepot money moves through the same ledger as everything else.
alter table financial_transactions
    add column sidepot_id uuid,
    add constraint financial_transactions_sidepot_fk
        foreign key (org_id, sidepot_id) references sidepots (org_id, id);

create index idx_txn_sidepot on financial_transactions (org_id, sidepot_id)
    where sidepot_id is not null;

-- ----------------------------------------------------------------------------
-- Rodeo templates
--
-- The whole shape of a rodeo -- events, fees, ladders, ground rules, sidepots,
-- performances -- captured as JSON so next year's is one click. Stored as a
-- document rather than as shadow tables because a template is a snapshot, not
-- a live object: changing the template must not alter a rodeo already built
-- from it.
-- ----------------------------------------------------------------------------
create table rodeo_templates (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid references organizations (id) on delete cascade,

    name        text not null,
    description text,
    /** 'jackpot' | 'sanctioned' | 'ranch_rodeo' | 'playday' | 'barrel_race' */
    template_type text,

    /**
     * {"rodeo": {...}, "events": [...], "sidepots": [...],
     *  "performances": [...], "fees": {...}, "ground_rules": "..."}
     */
    definition  jsonb not null,

    is_system   boolean not null default false,
    times_used  int not null default 0,

    created_by  uuid references users (id),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint rodeo_template_ownership check (
        (is_system and org_id is null) or (not is_system and org_id is not null)
    )
);

create index idx_rodeo_templates_org on rodeo_templates (org_id);

alter table rodeo_templates enable row level security;
alter table rodeo_templates force row level security;

create policy rodeo_templates_read on rodeo_templates
    for select using (is_system or app_is_org_member(org_id));

create policy rodeo_templates_write on rodeo_templates
    for all
    using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

create trigger rodeo_templates_touch
    before update on rodeo_templates
    for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- Module entitlement (§3.2)
--
-- Core is always on. Premium modules are bought. Discipline apps are vertical
-- extensions the producer can switch on for their contestants.
-- ----------------------------------------------------------------------------
create table org_modules (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,

    module      text not null,
    tier        text not null default 'core' check (tier in (
                    'platform', 'core', 'premium', 'discipline'
                )),

    enabled     boolean not null default true,
    /** Null = no end date. Set when a subscription lapses. */
    expires_at  timestamptz,

    /** Per-module settings: seat counts, limits, feature switches. */
    settings    jsonb not null default '{}'::jsonb,

    stripe_subscription_item_id text,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, module)
);

create index idx_org_modules on org_modules (org_id) where enabled;

alter table org_modules enable row level security;
alter table org_modules force row level security;

create policy org_modules_member_read on org_modules
    for select using (app_is_org_member(org_id));

create policy org_modules_owner_write on org_modules
    for all
    using (app_has_org_role(org_id, array['owner', 'admin']))
    with check (app_has_org_role(org_id, array['owner', 'admin']));

create trigger org_modules_touch
    before update on org_modules
    for each row execute function touch_updated_at();

create or replace function org_has_module(p_org_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from org_modules
        where org_id = p_org_id
          and module = p_module
          and enabled
          and (expires_at is null or expires_at > now())
    );
$$;

-- The module catalogue, as reference data so the pricing page and the
-- entitlement check read the same list.
insert into reference_options (domain, code, label, description, category, sort_order, is_system, metadata) values
('module','auth','Auth & Identity','Accounts, roles, invitations.','Platform',10,true,'{"tier":"platform","always_on":true}'),
('module','tenancy','Organizations','Producer accounts and staff.','Platform',20,true,'{"tier":"platform","always_on":true}'),
('module','payments','Payment Gateway','Entry fees in, payouts out.','Platform',30,true,'{"tier":"platform","always_on":true}'),
('module','sync','Sync & Offline','Works with no signal in the arena.','Platform',40,true,'{"tier":"platform","always_on":true}'),
('module','notifications','Notifications','Email, SMS and push.','Platform',50,true,'{"tier":"platform","always_on":true}'),
('module','documents','Documents & Storage','Waivers, certificates, tax forms.','Platform',60,true,'{"tier":"platform","always_on":true}'),
('module','audit','Audit Log','Who changed what, and when.','Platform',70,true,'{"tier":"platform","always_on":true}'),
('module','events','Event Management','Rodeos, performances, sanctioning.','Core',100,true,'{"tier":"core"}'),
('module','entries','Entry & Draw','Online entry, buddy groups, draw engine.','Core',110,true,'{"tier":"core"}'),
('module','contestants','Contestant Portal','Enter, view the draw, see results.','Core',120,true,'{"tier":"core"}'),
('module','results','Results & Standings','Placings, averages, season points.','Core',130,true,'{"tier":"core"}'),
('module','waivers','Waiver & Compliance','Signing, storage, tamper evidence.','Core',140,true,'{"tier":"core"}'),
('module','scoring','Scoring Engine','Judged and timed, every sanctioning body.','Premium',200,true,'{"tier":"premium"}'),
('module','payouts','Payout Engine','Fees, ties, ground money, cent-exact.','Premium',210,true,'{"tier":"premium"}'),
('module','timer','Timer Integration','FarmTek and Daktronics hardware.','Premium',220,true,'{"tier":"premium"}'),
('module','broadcast','Live Broadcast','Live scores to the stands.','Premium',230,true,'{"tier":"premium"}'),
('module','stock','Stock Management','Animals, draws, career stats.','Premium',240,true,'{"tier":"premium"}'),
('module','tax','Tax & Reporting','1099, T4A-NR, PAYG withholding.','Premium',250,true,'{"tier":"premium"}'),
('module','analytics','Analytics & Reports','Dashboards and data export.','Premium',260,true,'{"tier":"premium"}'),
('module','series','Multi-Rodeo Series','Tours, circuits, season standings.','Premium',270,true,'{"tier":"premium"}'),
('module','sidepots','Sidepots & Incentives','Extra purses off the same run.','Premium',280,true,'{"tier":"premium"}'),
('module','handicap','Handicap Divisions','USTRC and WSTR numbered roping.','Premium',290,true,'{"tier":"premium"}'),
('module','barrelconnect','BarrelConnect','Barrel racing community app.','Discipline',300,true,'{"tier":"discipline","domain":"barrelconnect.pro"}'),
('module','bullrider','Bullrider.Pro','Bull riding community app.','Discipline',310,true,'{"tier":"discipline","domain":"bullrider.pro"}'),
('module','breakawayroping','BreakawayRoping.Pro','Breakaway community app.','Discipline',320,true,'{"tier":"discipline","domain":"breakawayroping.pro"}'),
('module','teamrope','TeamRope.Pro','Team roping community app.','Discipline',330,true,'{"tier":"discipline","domain":"teamrope.pro"}'),
('module','tiedown','TieDown.Pro','Tie-down community app.','Discipline',340,true,'{"tier":"discipline","domain":"tiedown.pro"}'),
('module','saddlebronc','SaddleBronc.Pro','Saddle bronc community app.','Discipline',350,true,'{"tier":"discipline","domain":"saddlebronc.pro"}'),
('module','barebackbronc','BarebackBronc.Pro','Bareback community app.','Discipline',360,true,'{"tier":"discipline","domain":"barebackbronc.pro"}'),
('module','bulldogging','Bulldogging.Pro','Steer wrestling community app.','Discipline',370,true,'{"tier":"discipline","domain":"bulldogging.pro"}'),
('module','ranchrodeo','RanchRodeo.Pro','Ranch rodeo community app.','Discipline',380,true,'{"tier":"discipline","domain":"ranchrodeo.pro"}');

-- ----------------------------------------------------------------------------
-- Producer-facing entry settings that a jackpot runner needs and v1.0 omits.
-- ----------------------------------------------------------------------------
alter table rodeo_events
    add column entry_methods       text[] not null default '{online}',
    add column draw_method         text not null default 'random',
    add column max_entries_per_contestant int not null default 1
        check (max_entries_per_contestant >= 1),
    add column min_entries_to_hold int,
    add column books_open_at       timestamptz,
    add column books_close_at      timestamptz,
    add column payout_structure    text,
    add column ground_rules        text,
    -- Arena setup a contestant asks about before entering.
    add column score_line_feet     numeric(5, 1),
    add column arena_length_feet   int,
    add column arena_width_feet    int,
    add column drag_every_n_runs   int;

comment on column rodeo_events.min_entries_to_hold is
    'Below this the event does not fill and entry fees are refunded.';

alter table rodeos
    add column payment_methods text[] not null default '{stripe_connect}',
    add column refund_policy   text,
    add column contact_name    text,
    add column contact_phone   text,
    add column contact_email   text,
    add column template_id     uuid references rodeo_templates (id);
