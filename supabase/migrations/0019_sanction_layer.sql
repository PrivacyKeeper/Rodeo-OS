-- ============================================================================
-- 0019_sanction_layer.sql
-- Getting sanctioned, staying sanctioned, and proving it.
--
-- ---------------------------------------------------------------------------
-- THE GAP THIS FILLS
-- ---------------------------------------------------------------------------
-- A committee producing a sanctioned rodeo has to do all of this, and none of
-- it is entries, draws, scores or payouts:
--
--   * Start six months out; file the approval application, committee contacts,
--     sponsorship agreement, livestock-welfare form, dues and ground rules.
--     File late and it costs $100.
--   * Have compliant insurance in place before the first performance.
--   * Escrow purse money and judges' fees ahead of the rodeo when required.
--   * Field the required number of carded judges, timers and a secretary.
--   * Run welfare procedures: veterinary access, facility inspection, trained
--     handlers, treatment space, transport, an injury-response plan.
--   * File the results by a wall-clock deadline after the final performance.
--
-- Central entry systems do not touch any of it. Neither does any competitor.
-- Today it is a volunteer with a folder and a calendar, and there is a fine
-- sitting on the deadline.
--
-- ---------------------------------------------------------------------------
-- THE DESIGN RULE THAT MATTERS MOST
-- ---------------------------------------------------------------------------
-- A jackpot must never see any of this.
--
-- Requirements hang off an ASSOCIATION. A rodeo with no sanctioning — which is
-- most rodeos in this country — generates zero compliance items and is never
-- asked a single compliance question. The seeded 'OPEN' profile has no
-- requirements at all, on purpose. If running a Tuesday-night roping ever
-- involves a welfare form, this layer has failed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- What an association requires, as data
-- ----------------------------------------------------------------------------
create table association_requirements (
    id          uuid primary key default gen_random_uuid(),
    association_id uuid not null references associations (id) on delete cascade,

    code        text not null,              -- 'approval_application'
    label       text not null,
    description text,

    requirement_type text not null check (requirement_type in (
        'document',     -- something has to be filed
        'insurance',    -- a certificate has to be on file and in date
        'escrow',       -- money has to be deposited before the rodeo
        'fee',          -- something has to be paid to the association
        'personnel',    -- N people in a role, carded or not
        'welfare',      -- an animal-welfare procedure has to be recorded
        'filing'        -- results have to reach the association
    )),

    /**
     * When it is due, relative to something real about the rodeo. Negative is
     * before. 'application_open' is the association's own annual window and is
     * only meaningful where a body publishes one.
     */
    due_anchor text not null default 'first_performance' check (due_anchor in (
        'first_performance', 'last_performance', 'application_open', 'season_start'
    )),
    due_offset_days int not null default 0,

    /** Being late costs this. Nulls where the body does not publish a figure. */
    late_fee_cents int check (late_fee_cents >= 0),

    /**
     * A blocking requirement stops the books being closed. A non-blocking one
     * is a reminder. Getting this wrong in the strict direction is worse than
     * getting it wrong in the loose direction: a secretary who cannot file at
     * 11:40pm because the software wants a sponsorship agreement will never
     * use the software again.
     */
    blocks_close boolean not null default false,

    /** For 'personnel': {"role":"judge","min_count":2,"must_be_carded":true} */
    /** For 'insurance': {"coverage_type":"public_liability","min_amount_cents":100000000} */
    /** For 'escrow':    {"covers":["purse","judges_fees"]} */
    config      jsonb not null default '{}'::jsonb,

    /** Same provenance discipline as the association profile itself. */
    verified_against text,
    is_verified boolean not null default false,

    sort_order  int not null default 0,
    is_active   boolean not null default true,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (association_id, code)
);

create index idx_assoc_req on association_requirements (association_id, sort_order)
    where is_active;

alter table association_requirements enable row level security;
alter table association_requirements force row level security;

-- Requirements are readable wherever the association profile is.
create policy assoc_req_read on association_requirements
    for select using (
        exists (
            select 1 from associations a
             where a.id = association_id
               and (a.org_id is null or app_is_org_member(a.org_id))
        )
    );

create policy assoc_req_write on association_requirements
    for all
    using (
        exists (
            select 1 from associations a
             where a.id = association_id
               and a.org_id is not null
               and app_is_org_staff(a.org_id)
        )
    )
    with check (
        exists (
            select 1 from associations a
             where a.id = association_id
               and a.org_id is not null
               and app_is_org_staff(a.org_id)
        )
    );

create trigger assoc_req_touch
    before update on association_requirements
    for each row execute function touch_updated_at();

grant select on association_requirements to anon, authenticated;
grant insert, update, delete on association_requirements to authenticated;

-- ----------------------------------------------------------------------------
-- Contract personnel credentials
--
-- Judges, secretaries, timers, announcers and pickup men are carded people in
-- sanctioned rodeo, and an arena secretary card is a two-year apprenticeship
-- before the exams. Until now the OS knew a person's ROLE and not whether they
-- were entitled to hold it — which means it could not tell a committee it was
-- short a judge, and a credential registry that cannot do that is a filing
-- cabinet.
-- ----------------------------------------------------------------------------
create table credentials (
    id          uuid primary key default gen_random_uuid(),

    user_id     uuid not null references users (id) on delete cascade,
    association_id uuid references associations (id) on delete set null,
    /** Kept alongside the id so an unmatched body still records something. */
    body_code   text not null,

    role        text not null,              -- 'judge', 'secretary', 'timer_operator'
    card_number text,
    card_class  text not null default 'full' check (card_class in (
                    'full', 'probationary', 'permit', 'apprentice'
                )),

    issued_on   date,
    expires_on  date,

    verified    boolean not null default false,
    verified_by uuid references users (id),
    verified_at timestamptz,
    document_url text,

    notes       text,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint credential_dates check (
        expires_on is null or issued_on is null or expires_on > issued_on
    ),
    unique (user_id, body_code, role, card_number)
);

create index idx_credentials_user on credentials (user_id);
create index idx_credentials_lookup on credentials (body_code, role, expires_on);

/** Is this person carded for this role by this body, on this date? */
create or replace function credential_is_current(
    p_user_id uuid, p_body text, p_role text, p_on date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from credentials c
         where c.user_id = p_user_id
           and c.body_code = p_body
           and c.role = p_role
           and c.verified
           and (c.issued_on is null or c.issued_on <= p_on)
           and (c.expires_on is null or c.expires_on >= p_on)
    );
$$;

comment on function credential_is_current is
    'Whether a person holds a verified, in-date card for a role. An unverified '
    'card counts for nothing — anybody can type a number into a box.';

alter table credentials enable row level security;
alter table credentials force row level security;

create policy credentials_own on credentials
    for select using (user_id = app_current_user_id());

-- Staff can see the cards of people who hold a role in their organisation.
-- Not of anybody else: a credential row carries a person's professional
-- standing and is nobody's business by default.
create policy credentials_org on credentials
    for select using (
        exists (
            select 1 from org_members m
             where m.user_id = credentials.user_id
               and m.accepted_at is not null
               and app_is_org_staff(m.org_id)
        )
    );

create policy credentials_self_write on credentials
    for insert with check (user_id = app_current_user_id() and not verified);

create policy credentials_self_edit on credentials
    for update
    using (user_id = app_current_user_id() and not verified)
    with check (user_id = app_current_user_id() and not verified);

create policy credentials_org_write on credentials
    for all
    using (
        exists (
            select 1 from org_members m
             where m.user_id = credentials.user_id
               and m.accepted_at is not null
               and app_is_org_staff(m.org_id)
        )
    )
    with check (
        exists (
            select 1 from org_members m
             where m.user_id = credentials.user_id
               and m.accepted_at is not null
               and app_is_org_staff(m.org_id)
        )
    );

create trigger credentials_touch
    before update on credentials
    for each row execute function touch_updated_at();

grant select, insert, update, delete on credentials to authenticated;

-- ----------------------------------------------------------------------------
-- Who is working this rodeo
-- ----------------------------------------------------------------------------
create table rodeo_personnel (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,

    user_id     uuid not null references users (id) on delete cascade,
    role        text not null,

    /** Resolved at assignment time; re-checked when compliance is evaluated. */
    credential_id uuid references credentials (id) on delete set null,

    fee_cents   bigint check (fee_cents >= 0),
    confirmed_at timestamptz,
    notes       text,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, id),
    unique (rodeo_id, user_id, role),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_rodeo_personnel on rodeo_personnel (org_id, rodeo_id, role);

alter table rodeo_personnel enable row level security;
alter table rodeo_personnel force row level security;

create policy rodeo_personnel_read on rodeo_personnel
    for select using (app_is_org_member(org_id) or user_id = app_current_user_id());

create policy rodeo_personnel_write on rodeo_personnel
    for all using (app_is_org_staff(org_id)) with check (app_is_org_staff(org_id));

create trigger rodeo_personnel_touch
    before update on rodeo_personnel
    for each row execute function touch_updated_at();

grant select, insert, update, delete on rodeo_personnel to authenticated;

-- ----------------------------------------------------------------------------
-- The rodeo's own compliance checklist
-- ----------------------------------------------------------------------------
create table rodeo_compliance_items (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,

    /** Null when a producer adds a checklist item of their own. */
    requirement_id uuid references association_requirements (id) on delete set null,
    association_code text,

    code        text not null,
    label       text not null,
    requirement_type text not null,
    blocks_close boolean not null default false,

    due_on      date,
    late_fee_cents int check (late_fee_cents >= 0),

    status      text not null default 'pending' check (status in (
                    'pending', 'in_progress', 'satisfied', 'waived', 'failed'
                )),

    /** Evidence. A document link, a transaction, or a note. */
    evidence_url text,
    evidence_transaction_id uuid,
    amount_cents bigint check (amount_cents >= 0),
    satisfied_at timestamptz,
    satisfied_by uuid references users (id),
    waived_reason text,

    notes       text,
    config      jsonb not null default '{}'::jsonb,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, id),
    unique (rodeo_id, code),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    constraint waiver_needs_a_reason check (
        status <> 'waived' or waived_reason is not null
    )
);

create index idx_compliance_rodeo on rodeo_compliance_items (org_id, rodeo_id, status);
create index idx_compliance_due on rodeo_compliance_items (org_id, due_on)
    where status in ('pending', 'in_progress');

alter table rodeo_compliance_items enable row level security;
alter table rodeo_compliance_items force row level security;

create policy compliance_read on rodeo_compliance_items
    for select using (app_is_org_member(org_id));

create policy compliance_write on rodeo_compliance_items
    for all using (app_is_org_staff(org_id)) with check (app_is_org_staff(org_id));

create trigger compliance_touch
    before update on rodeo_compliance_items
    for each row execute function touch_updated_at();

grant select, insert, update, delete on rodeo_compliance_items to authenticated;

-- ----------------------------------------------------------------------------
-- Livestock welfare
--
-- Every association in the sport has welfare rules and none of the software
-- records compliance with them. A vet check that happened and cannot be shown
-- to have happened is worth nothing in a dispute.
-- ----------------------------------------------------------------------------
create table welfare_records (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid,

    record_type text not null check (record_type in (
                    'vet_on_site', 'facility_inspection', 'animal_injury',
                    'animal_treatment', 'transport', 'equipment_check',
                    'stock_release'
                )),

    animal_id       uuid,                   -- org stock
    registry_id     uuid references animal_registry (id) on delete set null,

    occurred_at timestamptz not null,
    recorded_by uuid references users (id),
    veterinarian_id uuid references users (id),

    description text not null,
    outcome     text,
    /** Injury severity where relevant. Free of clinical judgement on our part. */
    severity    text check (severity in ('none', 'minor', 'serious', 'fatal')),

    document_url text,

    created_at  timestamptz not null default now(),

    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, animal_id) references animals (org_id, id) on delete set null
);

create index idx_welfare_rodeo on welfare_records (org_id, rodeo_id, occurred_at desc);
create index idx_welfare_animal on welfare_records (org_id, animal_id);

alter table welfare_records enable row level security;
alter table welfare_records force row level security;

create policy welfare_read on welfare_records
    for select using (app_is_org_member(org_id));

create policy welfare_write on welfare_records
    for insert with check (app_is_org_staff(org_id));

-- A welfare record is evidence. It is appended to, never rewritten.
create trigger welfare_no_rewrite
    before update or delete on welfare_records
    for each row execute function reject_mutation();

grant select, insert on welfare_records to authenticated;

-- ----------------------------------------------------------------------------
-- Conduct and discipline
-- ----------------------------------------------------------------------------
create table discipline_records (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid,

    subject_user_id uuid not null references users (id) on delete cascade,
    association_code text,

    record_type text not null check (record_type in (
                    'fine', 'complaint', 'grievance', 'hearing',
                    'suspension', 'reinstatement', 'warning'
                )),

    reason      text not null,
    amount_cents bigint check (amount_cents >= 0),

    status      text not null default 'open' check (status in (
                    'open', 'upheld', 'dismissed', 'paid', 'appealed', 'closed'
                )),

    occurred_on date not null,
    resolved_on date,

    raised_by   uuid references users (id),
    document_url text,
    notes       text,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete set null
);

create index idx_discipline_subject on discipline_records (subject_user_id, occurred_on desc);
create index idx_discipline_org on discipline_records (org_id, status);

alter table discipline_records enable row level security;
alter table discipline_records force row level security;

-- The person it is about can always see it. That is not a courtesy — a
-- disciplinary record somebody cannot read is one they cannot contest.
create policy discipline_subject on discipline_records
    for select using (subject_user_id = app_current_user_id());

create policy discipline_org on discipline_records
    for select using (app_is_org_staff(org_id));

create policy discipline_write on discipline_records
    for all using (app_is_org_staff(org_id)) with check (app_is_org_staff(org_id));

create trigger discipline_touch
    before update on discipline_records
    for each row execute function touch_updated_at();

grant select, insert, update, delete on discipline_records to authenticated;

-- ============================================================================
-- Generating and evaluating the checklist
-- ============================================================================

/**
 * Instantiate the compliance checklist for a rodeo from every association that
 * has approved it.
 *
 * Idempotent — safe to re-run when a sanctioning row is added later, which is
 * the normal case: a committee applies to a second body in March.
 *
 * A rodeo with no approved sanctioning generates nothing, and that silence is
 * the design.
 */
create or replace function generate_compliance_items(p_org_id uuid, p_rodeo_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    v_created int := 0;
    v_start date;
    v_end   date;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised to manage compliance for this organisation'
            using errcode = '42501';
    end if;

    select start_date, end_date into v_start, v_end
      from rodeos where id = p_rodeo_id and org_id = p_org_id;

    if v_start is null then
        raise exception 'rodeo not found in this organisation' using errcode = 'P0002';
    end if;

    insert into rodeo_compliance_items (
        org_id, rodeo_id, requirement_id, association_code,
        code, label, requirement_type, blocks_close,
        due_on, late_fee_cents, config
    )
    select
        p_org_id,
        p_rodeo_id,
        r.id,
        a.code,
        a.code || ':' || r.code,
        r.label,
        r.requirement_type,
        r.blocks_close,
        case r.due_anchor
            when 'first_performance' then v_start + r.due_offset_days
            when 'last_performance'  then v_end   + r.due_offset_days
            else null
        end,
        r.late_fee_cents,
        r.config
    from rodeo_sanctioning rs
    join associations a  on a.id = rs.association_id
    join association_requirements r on r.association_id = a.id and r.is_active
    where rs.org_id = p_org_id
      and rs.rodeo_id = p_rodeo_id
      -- PENDING counts, and that is the whole point. A committee that has just
      -- said "we are going PRCA this year" has not been approved yet — filing
      -- the approval application is item one on this very list. Generating the
      -- calendar only after approval would withhold the checklist until the
      -- thing the checklist exists to achieve had already happened.
      --
      -- Note the deliberate asymmetry with the books: MONEY rules (the
      -- deduction) and the FILING deadline apply only once a body has actually
      -- approved the rodeo. Owing an association 6% before it has agreed to
      -- sanction you is a different kind of wrong.
      and rs.approval_status in ('pending', 'approved', 'conditional')
    on conflict (rodeo_id, code) do nothing;

    get diagnostics v_created = row_count;
    return v_created;
end;
$$;

comment on function generate_compliance_items is
    'Builds a rodeo''s compliance checklist from the associations that approved '
    'it. A rodeo with no sanctioning generates nothing at all.';

/**
 * Evaluate personnel requirements against who is actually assigned.
 *
 * Returns one row per unmet requirement. Empty result = compliant.
 */
create or replace function personnel_shortfall(p_org_id uuid, p_rodeo_id uuid)
returns table (
    association_code text,
    role text,
    required int,
    assigned int,
    carded_required boolean,
    carded_assigned int
)
language sql
stable
security definer
set search_path = public
as $$
    with req as (
        select a.code as association_code,
               (c ->> 'role')                     as role,
               coalesce((c ->> 'min_count')::int, 1)          as required,
               coalesce((c ->> 'must_be_carded')::boolean, false) as carded_required
          from rodeo_sanctioning rs
          join associations a on a.id = rs.association_id
          cross join lateral jsonb_array_elements(a.required_credentials) c
         where rs.org_id = p_org_id
           and rs.rodeo_id = p_rodeo_id
           -- Pending too: carded judges have to be lined up before approval,
           -- not after.
           and rs.approval_status in ('pending', 'approved', 'conditional')
           and app_is_org_member(p_org_id)
    ),
    got as (
        select p.role,
               count(*) as assigned,
               count(*) filter (
                   where credential_is_current(
                       p.user_id, r2.association_code, p.role,
                       (select start_date from rodeos where id = p_rodeo_id)
                   )
               ) as carded_assigned,
               r2.association_code
          from rodeo_personnel p
          join req r2 on r2.role = p.role
         where p.org_id = p_org_id and p.rodeo_id = p_rodeo_id
         group by p.role, r2.association_code
    )
    select req.association_code,
           req.role,
           req.required,
           coalesce(got.assigned, 0)::int,
           req.carded_required,
           coalesce(got.carded_assigned, 0)::int
      from req
      left join got on got.role = req.role
                   and got.association_code = req.association_code
     where coalesce(got.assigned, 0) < req.required
        or (req.carded_required and coalesce(got.carded_assigned, 0) < req.required);
$$;

comment on function personnel_shortfall is
    'Unmet contract-personnel requirements for a rodeo. Empty means compliant. '
    'This is what lets the OS tell a committee it is short a carded judge '
    'BEFORE the rodeo rather than after.';

-- ============================================================================
-- Seed: PRCA requirements.
--
-- PROVENANCE WARNING. These mirror the committee guide and rule-book summaries
-- gathered on 7 August 2026 from secondary sources. Not one of them has been
-- checked against the rule book itself. They are seeded as UNVERIFIED so the
-- product can show a committee a plausible calendar while making it obvious
-- that the dates are ours, not the association's.
-- ============================================================================

insert into association_requirements (
    association_id, code, label, description, requirement_type,
    due_anchor, due_offset_days, late_fee_cents, blocks_close, config,
    verified_against, is_verified, sort_order
)
select a.id, v.code, v.label, v.description, v.requirement_type,
       v.due_anchor, v.due_offset_days, v.late_fee_cents, v.blocks_close, v.config,
       'Committee guide and rule-book summaries, 7 Aug 2026. Secondary sources. NOT checked against the rule book.',
       false, v.sort_order
  from associations a
 cross join (values
    ('approval_application', 'Annual approval application',
     'Sanctioning application, committee contacts and dues. Late filing carries a fee.',
     'document', 'first_performance', -90, 10000, false,
     '{}'::jsonb, 10),

    ('sponsorship_agreement', 'Sponsorship agreement',
     'Signed sponsorship agreement, including national-sponsor commitments.',
     'document', 'first_performance', -90, null, false, '{}'::jsonb, 20),

    ('ground_rules', 'Ground rules filed',
     'The rodeo''s ground rules, submitted with the approval application.',
     'document', 'first_performance', -90, null, false, '{}'::jsonb, 30),

    ('welfare_form', 'Livestock welfare form',
     'Signed livestock-welfare undertaking.',
     'welfare', 'first_performance', -90, null, false, '{}'::jsonb, 40),

    ('escrow_purse', 'Purse and judges'' fees escrowed',
     'Prize money and judges'' fees deposited ahead of the rodeo where required.',
     'escrow', 'first_performance', -30, null, false,
     '{"covers":["purse","judges_fees"]}'::jsonb, 50),

    ('insurance', 'Insurance certificate on file',
     'Compliant cover in place before the first performance.',
     'insurance', 'first_performance', -14, null, false,
     '{"coverage_type":"public_liability"}'::jsonb, 60),

    ('judges_carded', 'Carded judges engaged',
     'The required number of carded judges assigned to the rodeo.',
     'personnel', 'first_performance', -7, null, false,
     '{"role":"judge","min_count":2,"must_be_carded":true}'::jsonb, 70),

    ('secretary_carded', 'Carded arena secretary engaged',
     'A carded arena secretary assigned to the rodeo.',
     'personnel', 'first_performance', -7, null, false,
     '{"role":"secretary","min_count":1,"must_be_carded":true}'::jsonb, 80),

    -- NOT blocking, and the reason is worth writing down. This was seeded as
    -- a blocker in the first draft, which deadlocked the whole flow: the books
    -- could not close until the results were filed, and the results could not
    -- be filed until the books closed. The integration tests found it. A
    -- filing requirement is satisfied BY filing, so it can never be a
    -- precondition of the step that precedes filing.
    ('results_filed', 'Results filed with the association',
     'Completed rodeo submitted by the association''s deadline after the final performance.',
     'filing', 'last_performance', 0, 10000, false,
     '{"local_time":"23:59","timezone":"America/Denver"}'::jsonb, 90)
 ) as v(code, label, description, requirement_type, due_anchor, due_offset_days,
        late_fee_cents, blocks_close, config, sort_order)
 where a.code = 'PRCA' and a.org_id is null;

-- WPRA and IPRA: the filing obligation exists, the specifics do not. One
-- non-blocking reminder each rather than an invented calendar.
insert into association_requirements (
    association_id, code, label, description, requirement_type,
    due_anchor, due_offset_days, blocks_close, verified_against, is_verified, sort_order
)
select a.id, 'results_filed', 'Results filed with the association',
       'Deadline not established from published sources. Confirm with the association.',
       'filing', 'last_performance', 1, false,
       'Not established. Placeholder reminder, deliberately non-blocking.',
       false, 90
  from associations a
 where a.org_id is null and a.code in ('WPRA', 'IPRA', 'CPRA_CA');

comment on table rodeo_compliance_items is
    'A rodeo''s compliance checklist. Generated from the associations that '
    'approved it; empty for an unsanctioned rodeo, which is most of them.';
