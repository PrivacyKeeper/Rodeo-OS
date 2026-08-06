-- ============================================================================
-- 0013_reference_options.sql
-- The options layer. Every dropdown in the product is backed by this table.
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
-- The architecture puts its option lists in CHECK constraints:
--
--     event_type text not null check (event_type in ('bareback', ...19 values))
--     role       text not null check (role in (...14 values))
--
-- That means a producer running a ranch rodeo cannot enter wild cow milking, a
-- playday cannot run a keyhole race, and adding either requires a schema
-- migration and a deploy. For a platform whose whole claim is that a producer
-- never needs another tool, a fixed list of nineteen events is the ceiling on
-- that claim.
--
-- Toast does not ship a fixed menu; it ships a menu builder. Procore does not
-- ship fixed project fields; it ships configurable field sets and templates.
-- Both are "the only system you need" precisely because the operator can
-- express their own operation inside them.
--
-- ---------------------------------------------------------------------------
-- THE LINE
-- ---------------------------------------------------------------------------
-- Not everything becomes editable data. The distinction drawn here:
--
--   * A value the CODE BRANCHES ON stays a CHECK constraint. `scoring_mode`
--     ('judged' | 'timed') selects a calculation path; `transaction_type`
--     drives ledger semantics; `status` fields drive state machines. If a
--     producer could invent a new one, the engine would not know what to do
--     with it. These stay locked.
--
--   * A value that is a LABEL FOR A HUMAN becomes reference data. Event types,
--     roles, fee names, DQ reasons, draw methods, penalty names. The code
--     never switches on these; it stores them, displays them, and totals money
--     against them.
--
-- System options (org_id IS NULL) are visible to everybody and cannot be
-- edited by a producer. A producer adds their own alongside them, scoped to
-- their org, and can hide system options they never use.
-- ============================================================================

create table reference_options (
    id          uuid primary key default gen_random_uuid(),

    /** Which dropdown this belongs to. See the seed below for the full set. */
    domain      text not null,
    /** Stable machine value stored on the row that references it. */
    code        text not null,
    /** What the human sees. */
    label       text not null,
    description text,

    /** Null = system option, available to every tenant. */
    org_id      uuid references organizations (id) on delete cascade,
    is_system   boolean not null default false,

    /** Grouping inside the dropdown: "Rough Stock", "Timed", "Ranch Rodeo". */
    category    text,
    sort_order  int not null default 0,

    /**
     * Domain-specific extras. For event_type: scoring_mode, is_roughstock,
     * default animal. For penalty_type: default seconds. For fee_type: whether
     * it is per-entry or a percentage.
     */
    metadata    jsonb not null default '{}'::jsonb,

    /** Producers hide options they never use rather than deleting them. */
    is_active   boolean not null default true,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint reference_option_ownership check (
        (is_system and org_id is null) or (not is_system and org_id is not null)
    )
);

-- A code is unique within its domain, per tenant. A producer may shadow a
-- system code with their own variant of the same name.
create unique index idx_ref_system_code
    on reference_options (domain, code) where org_id is null;
create unique index idx_ref_org_code
    on reference_options (domain, code, org_id) where org_id is not null;

create index idx_ref_domain on reference_options (domain, sort_order)
    where is_active;

alter table reference_options enable row level security;
alter table reference_options force row level security;

create policy reference_options_read on reference_options
    for select using (org_id is null or app_is_org_member(org_id));

create policy reference_options_write on reference_options
    for all
    using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

create trigger reference_options_touch
    before update on reference_options
    for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------------
-- Validation. Replaces the CHECK constraints: a value must exist in its
-- domain, and must be either a system option or one belonging to the same
-- tenant as the row referencing it. A tenant cannot borrow another tenant's
-- custom event type.
-- ----------------------------------------------------------------------------
create or replace function option_is_valid(
    p_domain text,
    p_code   text,
    p_org_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from reference_options
        where domain = p_domain
          and code = p_code
          and is_active
          and (org_id is null or org_id = p_org_id)
    );
$$;

create or replace function validate_reference_option()
returns trigger
language plpgsql
as $$
declare
    v_domain text := tg_argv[0];
    v_column text := tg_argv[1];
    v_value  text;
    v_org    uuid;
begin
    execute format('select ($1).%I::text, ($1).org_id', v_column)
       into v_value, v_org using new;

    if v_value is null then
        return new;
    end if;

    if not option_is_valid(v_domain, v_value, v_org) then
        raise exception
            '% is not a valid % for this organization. Add it under Settings > Options first.',
            v_value, v_domain
            using errcode = 'foreign_key_violation';
    end if;

    return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Swap the hardcoded CHECKs for reference validation.
-- ----------------------------------------------------------------------------
alter table rodeo_events  drop constraint rodeo_events_event_type_check;
alter table rodeos        drop constraint rodeos_rodeo_type_check;
alter table org_members   drop constraint org_members_role_check;
alter table animals       drop constraint animals_animal_type_check;
alter table entries       drop constraint entries_release_type_check;

create trigger rodeo_events_validate_event_type
    before insert or update of event_type on rodeo_events
    for each row execute function validate_reference_option('event_type', 'event_type');

create trigger rodeos_validate_type
    before insert or update of rodeo_type on rodeos
    for each row execute function validate_reference_option('rodeo_type', 'rodeo_type');

create trigger org_members_validate_role
    before insert or update of role on org_members
    for each row execute function validate_reference_option('org_role', 'role');

create trigger animals_validate_type
    before insert or update of animal_type on animals
    for each row execute function validate_reference_option('animal_type', 'animal_type');

create trigger entries_validate_release
    before insert or update of release_type on entries
    for each row execute function validate_reference_option('release_reason', 'release_type');

-- ============================================================================
-- SEED — every option a producer or jackpot runner actually needs.
-- ============================================================================

-- ---------------------------------------------------------------- event_type
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
-- Rough stock
('event_type','bareback','Bareback Riding','Rough Stock',10,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"bareback_bronc","mark_out_required":true}'),
('event_type','saddle_bronc','Saddle Bronc Riding','Rough Stock',20,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"saddle_bronc","mark_out_required":true}'),
('event_type','bull_riding','Bull Riding','Rough Stock',30,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"bull","mark_out_required":false}'),
('event_type','ranch_bronc','Ranch Bronc Riding','Rough Stock',40,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"saddle_bronc"}'),
('event_type','ranch_bareback','Ranch Bareback','Rough Stock',50,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"bareback_bronc"}'),
('event_type','steer_riding','Steer Riding','Rough Stock',60,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"steer"}'),
('event_type','jr_bull_riding','Junior Bull Riding','Rough Stock',70,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"bull","youth":true}'),
('event_type','mini_bull_riding','Mini Bull Riding','Rough Stock',80,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"mini_bull","youth":true}'),
('event_type','calf_riding','Calf Riding','Rough Stock',90,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"calf","youth":true}'),
('event_type','mutton_busting','Mutton Bustin''','Rough Stock',100,true,'{"scoring_mode":"judged","is_roughstock":true,"animal_type":"sheep","youth":true}'),
-- Roping
('event_type','tie_down_roping','Tie-Down Roping','Roping',200,true,'{"scoring_mode":"timed","animal_type":"calf","tie_must_hold_seconds":6}'),
('event_type','breakaway_roping','Breakaway Roping','Roping',210,true,'{"scoring_mode":"timed","animal_type":"calf"}'),
('event_type','team_roping_header','Team Roping — Header','Roping',220,true,'{"scoring_mode":"timed","animal_type":"steer","team":true,"end":"header"}'),
('event_type','team_roping_heeler','Team Roping — Heeler','Roping',230,true,'{"scoring_mode":"timed","animal_type":"steer","team":true,"end":"heeler"}'),
('event_type','steer_roping','Steer Roping','Roping',240,true,'{"scoring_mode":"timed","animal_type":"steer"}'),
('event_type','ribbon_roping','Ribbon Roping','Roping',250,true,'{"scoring_mode":"timed","animal_type":"calf","team":true}'),
('event_type','jr_breakaway','Junior Breakaway','Roping',260,true,'{"scoring_mode":"timed","animal_type":"calf","youth":true}'),
('event_type','dummy_roping','Dummy Roping','Roping',270,true,'{"scoring_mode":"timed","animal_type":null,"youth":true}'),
-- Timed / cattle
('event_type','steer_wrestling','Steer Wrestling','Timed',300,true,'{"scoring_mode":"timed","animal_type":"steer"}'),
('event_type','chute_dogging','Chute Dogging','Timed',310,true,'{"scoring_mode":"timed","animal_type":"steer","youth":true}'),
('event_type','goat_tying','Goat Tying','Timed',320,true,'{"scoring_mode":"timed","animal_type":"goat","tie_must_hold_seconds":6}'),
('event_type','goat_tail_untying','Goat Tail Untying','Timed',330,true,'{"scoring_mode":"timed","animal_type":"goat","youth":true}'),
-- Speed
('event_type','barrel_racing','Barrel Racing','Speed',400,true,'{"scoring_mode":"timed","animal_type":"horse","d_format_capable":true}'),
('event_type','pole_bending','Pole Bending','Speed',410,true,'{"scoring_mode":"timed","animal_type":"horse","d_format_capable":true}'),
('event_type','jr_barrel_racing','Junior Barrel Racing','Speed',420,true,'{"scoring_mode":"timed","animal_type":"horse","youth":true,"d_format_capable":true}'),
('event_type','flag_race','Flag Race','Speed',430,true,'{"scoring_mode":"timed","animal_type":"horse"}'),
('event_type','keyhole_race','Keyhole Race','Speed',440,true,'{"scoring_mode":"timed","animal_type":"horse"}'),
('event_type','stake_race','Stake Race','Speed',450,true,'{"scoring_mode":"timed","animal_type":"horse"}'),
('event_type','straightaway_barrels','Straightaway Barrels','Speed',460,true,'{"scoring_mode":"timed","animal_type":"horse"}'),
('event_type','boot_scramble','Boot Scramble','Speed',470,true,'{"scoring_mode":"timed","youth":true}'),
('event_type','stick_horse_race','Stick Horse Race','Speed',480,true,'{"scoring_mode":"timed","youth":true}'),
('event_type','calf_scramble','Calf Scramble','Speed',490,true,'{"scoring_mode":"timed","animal_type":"calf","youth":true}'),
-- Ranch rodeo
('event_type','wild_cow_milking','Wild Cow Milking','Ranch Rodeo',500,true,'{"scoring_mode":"timed","animal_type":"cow","team":true}'),
('event_type','team_penning','Team Penning','Ranch Rodeo',510,true,'{"scoring_mode":"timed","animal_type":"cow","team":true}'),
('event_type','team_sorting','Team Sorting','Ranch Rodeo',520,true,'{"scoring_mode":"timed","animal_type":"cow","team":true}'),
('event_type','ranch_doctoring','Ranch Doctoring','Ranch Rodeo',530,true,'{"scoring_mode":"timed","animal_type":"steer","team":true}'),
('event_type','wild_horse_race','Wild Horse Race','Ranch Rodeo',540,true,'{"scoring_mode":"timed","animal_type":"horse","team":true}'),
('event_type','ranch_branding','Ranch Branding','Ranch Rodeo',550,true,'{"scoring_mode":"timed","animal_type":"calf","team":true}'),
('event_type','steer_mugging','Steer Mugging','Ranch Rodeo',560,true,'{"scoring_mode":"timed","animal_type":"steer","team":true}'),
('event_type','trailer_loading','Trailer Loading','Ranch Rodeo',570,true,'{"scoring_mode":"timed","animal_type":"cow","team":true}'),
('event_type','ranch_sorting','Ranch Sorting','Ranch Rodeo',580,true,'{"scoring_mode":"timed","animal_type":"cow","team":true}'),
-- Cow horse / show
('event_type','cutting','Cutting','Cow Horse',600,true,'{"scoring_mode":"judged","animal_type":"cow"}'),
('event_type','reined_cow_horse','Reined Cow Horse','Cow Horse',610,true,'{"scoring_mode":"judged","animal_type":"cow"}'),
('event_type','working_cow_horse','Working Cow Horse','Cow Horse',620,true,'{"scoring_mode":"judged","animal_type":"cow"}'),
('event_type','reining','Reining','Cow Horse',630,true,'{"scoring_mode":"judged","animal_type":"horse"}'),
('event_type','ranch_riding','Ranch Riding','Cow Horse',640,true,'{"scoring_mode":"judged","animal_type":"horse"}'),
('event_type','ranch_trail','Ranch Trail','Cow Horse',650,true,'{"scoring_mode":"judged","animal_type":"horse"}'),
('event_type','other','Other','Other',900,true,'{"scoring_mode":"timed"}');

-- ----------------------------------------------------------------- org_role
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('org_role','owner','Owner','Management',10,true,'{"can_disburse":true}'),
('org_role','admin','Administrator','Management',20,true,'{"can_disburse":true}'),
('org_role','secretary','Rodeo Secretary','Management',30,true,'{"can_score":true}'),
('org_role','assistant_secretary','Assistant Secretary','Management',40,true,'{}'),
('org_role','arena_director','Arena Director','Management',50,true,'{}'),
('org_role','board_member','Board Member','Management',60,true,'{}'),
('org_role','judge','Judge','Officials',100,true,'{"can_score":true}'),
('org_role','line_judge','Line Judge','Officials',110,true,'{"can_score":true}'),
('org_role','field_judge','Field Judge','Officials',120,true,'{"can_score":true}'),
('org_role','back_judge','Back Judge','Officials',130,true,'{"can_score":true}'),
('org_role','barrier_judge','Barrier Judge','Officials',140,true,'{"can_score":true}'),
('org_role','flagger','Flagger','Officials',150,true,'{"can_score":true}'),
('org_role','timer_operator','Timer Operator','Officials',160,true,'{"can_score":true}'),
('org_role','chute_boss','Chute Boss','Arena Crew',200,true,'{}'),
('org_role','gate_man','Gate Man','Arena Crew',210,true,'{}'),
('org_role','pickup_rider','Pickup Rider','Arena Crew',220,true,'{}'),
('org_role','bullfighter','Bullfighter','Arena Crew',230,true,'{}'),
('org_role','barrelman','Barrelman','Arena Crew',240,true,'{}'),
('org_role','clown','Rodeo Clown','Arena Crew',250,true,'{}'),
('org_role','announcer','Announcer','Production',300,true,'{}'),
('org_role','photographer','Photographer','Production',310,true,'{}'),
('org_role','videographer','Videographer','Production',320,true,'{}'),
('org_role','media','Media','Production',330,true,'{}'),
('org_role','sponsor_coordinator','Sponsor Coordinator','Production',340,true,'{}'),
('org_role','ticket_seller','Ticket Seller','Production',350,true,'{}'),
('org_role','concessions','Concessions','Production',360,true,'{}'),
('org_role','stock_contractor','Stock Contractor','Stock & Care',400,true,'{}'),
('org_role','veterinarian','Veterinarian','Stock & Care',410,true,'{}'),
('org_role','sports_medicine','Sports Medicine','Stock & Care',420,true,'{}'),
('org_role','emt','EMT / Medic','Stock & Care',430,true,'{}'),
('org_role','farrier','Farrier','Stock & Care',440,true,'{}'),
('org_role','contestant','Contestant','Participants',500,true,'{}'),
('org_role','parent_guardian','Parent / Guardian','Participants',510,true,'{}'),
('org_role','volunteer','Volunteer','Participants',520,true,'{}');

-- --------------------------------------------------------------- rodeo_type
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('rodeo_type','jackpot','Jackpot','Open',10,true,'{}'),
('rodeo_type','roping','Roping','Open',20,true,'{}'),
('rodeo_type','barrel_race','Barrel Race','Open',30,true,'{}'),
('rodeo_type','bull_bash','Bull Bash / Bull Riding Only','Open',40,true,'{}'),
('rodeo_type','open','Open Rodeo','Open',50,true,'{}'),
('rodeo_type','playday','Playday','Open',60,true,'{}'),
('rodeo_type','sanctioned','Sanctioned Rodeo','Sanctioned',100,true,'{}'),
('rodeo_type','invitational','Invitational','Sanctioned',110,true,'{}'),
('rodeo_type','tour_stop','Tour Stop','Sanctioned',120,true,'{}'),
('rodeo_type','finals','Finals','Sanctioned',130,true,'{}'),
('rodeo_type','series','Series','Sanctioned',140,true,'{}'),
('rodeo_type','amateur','Amateur','Sanctioned',150,true,'{}'),
('rodeo_type','ranch_rodeo','Ranch Rodeo','Sanctioned',160,true,'{}'),
('rodeo_type','youth','Youth Rodeo','Youth',200,true,'{}'),
('rodeo_type','junior_high','Junior High Rodeo','Youth',210,true,'{}'),
('rodeo_type','high_school','High School Rodeo','Youth',220,true,'{}'),
('rodeo_type','college','College Rodeo','Youth',230,true,'{}'),
('rodeo_type','futurity','Futurity','Special',300,true,'{}'),
('rodeo_type','derby','Derby','Special',310,true,'{}'),
('rodeo_type','incentive','Incentive','Special',320,true,'{}'),
('rodeo_type','benefit','Benefit / Charity','Special',330,true,'{}'),
('rodeo_type','clinic','Clinic','Special',340,true,'{}'),
('rodeo_type','practice','Practice / Exhibition','Special',350,true,'{}');

-- -------------------------------------------------------- sanctioning_body
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('sanctioning_body','none','None / Open','Unsanctioned',1,true,'{}'),
('sanctioning_body','PRCA','PRCA — Professional Rodeo Cowboys Association','Professional',10,true,'{"country":"US"}'),
('sanctioning_body','WPRA','WPRA — Women''s Professional Rodeo Association','Professional',20,true,'{"country":"US"}'),
('sanctioning_body','PBR','PBR — Professional Bull Riders','Professional',30,true,'{"country":"US"}'),
('sanctioning_body','IPRA','IPRA — International Professional Rodeo Association','Professional',40,true,'{"country":"US"}'),
('sanctioning_body','CBR','CBR — Championship Bull Riding','Professional',50,true,'{"country":"US"}'),
('sanctioning_body','WCRA','WCRA — World Champions Rodeo Alliance','Professional',60,true,'{"country":"US"}'),
('sanctioning_body','CPRA_CA','CPRA — Canadian Professional Rodeo Association','International',100,true,'{"country":"CA"}'),
('sanctioning_body','ABCRA','ABCRA — Australian Bushmens Campdraft & Rodeo Association','International',110,true,'{"country":"AU"}'),
('sanctioning_body','USTRC','USTRC — United States Team Roping Championships','Roping',200,true,'{"handicap_system":true}'),
('sanctioning_body','WSTR','WSTR — World Series of Team Roping','Roping',210,true,'{"handicap_system":true}'),
('sanctioning_body','NTR','NTR — National Team Roping','Roping',220,true,'{"handicap_system":true}'),
('sanctioning_body','NBHA','NBHA — National Barrel Horse Association','Barrels',300,true,'{"d_format":true}'),
('sanctioning_body','BBR','BBR — Better Barrel Races','Barrels',310,true,'{"d_format":true}'),
('sanctioning_body','NHSRA','NHSRA — National High School Rodeo Association','Youth',400,true,'{}'),
('sanctioning_body','NJHRA','NJHRA — National Junior High Rodeo Association','Youth',410,true,'{}'),
('sanctioning_body','NLBRA','NLBRA — National Little Britches Rodeo Association','Youth',420,true,'{}'),
('sanctioning_body','NIRA','NIRA — National Intercollegiate Rodeo Association','Youth',430,true,'{}'),
('sanctioning_body','ACRA','ACRA — American Cowboys Rodeo Association','Amateur',500,true,'{}'),
('sanctioning_body','APRA','APRA — American Professional Rodeo Association','Amateur',510,true,'{}'),
('sanctioning_body','SRA','SRA — Southern Rodeo Association','Amateur',520,true,'{}'),
('sanctioning_body','UPRA','UPRA — United Professional Rodeo Association','Amateur',530,true,'{}'),
('sanctioning_body','RMPRA','RMPRA — Rocky Mountain Pro Rodeo Association','Amateur',540,true,'{}'),
('sanctioning_body','other','Other / Regional','Amateur',900,true,'{}');

-- ------------------------------------------------------------------ fee_type
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('fee_type','entry_fee','Entry Fee','Contestant',10,true,'{"basis":"per_entry","goes_to":"purse"}'),
('fee_type','stock_charge','Stock Charge','Contestant',20,true,'{"basis":"per_entry","goes_to":"stock_contractor"}'),
('fee_type','cattle_charge','Cattle Charge','Contestant',30,true,'{"basis":"per_entry","goes_to":"stock_contractor"}'),
('fee_type','office_fee','Office Fee','Contestant',40,true,'{"basis":"per_entry","goes_to":"producer"}'),
('fee_type','day_fee','Day Fee','Contestant',50,true,'{"basis":"per_entry","goes_to":"producer"}'),
('fee_type','late_fee','Late Entry Fee','Contestant',60,true,'{"basis":"per_entry","goes_to":"producer"}'),
('fee_type','permit_fee','Permit Fee','Contestant',70,true,'{"basis":"per_entry","goes_to":"association"}'),
('fee_type','membership_fee','Membership Fee','Contestant',80,true,'{"basis":"per_entry","goes_to":"association"}'),
('fee_type','sidepot_buyin','Sidepot Buy-In','Contestant',90,true,'{"basis":"per_entry","goes_to":"sidepot"}'),
('fee_type','incentive_buyin','Incentive Buy-In','Contestant',100,true,'{"basis":"per_entry","goes_to":"sidepot"}'),
('fee_type','admin_fee','Administrative Fee','Producer',200,true,'{"basis":"percentage","goes_to":"producer"}'),
('fee_type','facility_fee','Facility Fee','Producer',210,true,'{"basis":"per_entry","goes_to":"venue"}'),
('fee_type','arena_fee','Arena Fee','Producer',220,true,'{"basis":"per_entry","goes_to":"venue"}'),
('fee_type','ground_fee','Ground Fee','Producer',230,true,'{"basis":"per_entry","goes_to":"venue"}'),
('fee_type','stall_fee','Stall Fee','Producer',240,true,'{"basis":"flat","goes_to":"venue"}'),
('fee_type','hookup_fee','RV Hookup Fee','Producer',250,true,'{"basis":"flat","goes_to":"venue"}'),
('fee_type','gate_fee','Gate Admission','Producer',260,true,'{"basis":"flat","goes_to":"producer"}'),
('fee_type','judge_fee','Judge Fee','Officials',300,true,'{"basis":"flat","goes_to":"official"}'),
('fee_type','timer_fee','Timer Fee','Officials',310,true,'{"basis":"flat","goes_to":"official"}'),
('fee_type','sanctioning_fee','Sanctioning Fee','Association',400,true,'{"basis":"per_entry","goes_to":"association"}'),
('fee_type','circuit_fee','Circuit Fee','Association',410,true,'{"basis":"per_entry","goes_to":"circuit_association"}'),
('fee_type','cres_fee','CRES Fee','Association',420,true,'{"basis":"per_entry","goes_to":"cpra_central"}'),
('fee_type','sports_medicine_fee','Sports Medicine Fee','Association',430,true,'{"basis":"per_entry","goes_to":"association"}'),
('fee_type','insurance_fee','Insurance Fee','Association',440,true,'{"basis":"per_entry","goes_to":"insurer"}'),
('fee_type','platform_fee','Platform Fee','Platform',500,true,'{"basis":"percentage","goes_to":"platform"}');

-- -------------------------------------------------------------- penalty_type
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('penalty_type','barrier_break','Broken Barrier','Roping / Timed',10,true,'{"default_seconds":10,"repeatable":false,"note":"5 seconds under USTRC and WSTR"}'),
('penalty_type','one_leg_catch','One Hind Leg','Team Roping',20,true,'{"default_seconds":5,"repeatable":false}'),
('penalty_type','barrel_knockdown','Barrel Knocked Over','Speed',30,true,'{"default_seconds":5,"repeatable":true}'),
('penalty_type','pole_knockdown','Pole Knocked Over','Speed',40,true,'{"default_seconds":5,"repeatable":true}'),
('penalty_type','missed_flag','Missed Flag','Speed',50,true,'{"default_seconds":5,"repeatable":false}'),
('penalty_type','dropped_flag','Dropped Flag','Speed',60,true,'{"default_seconds":5,"repeatable":false}'),
('penalty_type','gate_penalty','Gate Penalty','Ranch Rodeo',70,true,'{"default_seconds":10,"repeatable":false}'),
('penalty_type','wrong_cattle','Wrong Cattle','Ranch Rodeo',80,true,'{"default_seconds":10,"repeatable":true}'),
('penalty_type','equipment_penalty','Equipment Penalty','General',90,true,'{"default_seconds":5,"repeatable":false}');

-- ----------------------------------------------------------------- dq_reason
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('dq_reason','mark_out_violation','Missed the Mark-Out','Rough Stock',10,true,'{}'),
('dq_reason','free_arm_touches_animal_or_self','Free Arm Touched Animal or Self','Rough Stock',20,true,'{}'),
('dq_reason','dismount_before_buzzer','Bucked Off / Dismounted Before Buzzer','Rough Stock',30,true,'{}'),
('dq_reason','riding_hand_changes','Changed Riding Hand','Rough Stock',40,true,'{}'),
('dq_reason','loses_stirrup','Lost a Stirrup','Rough Stock',50,true,'{}'),
('dq_reason','drops_rein','Dropped the Rein','Rough Stock',60,true,'{}'),
('dq_reason','no_catch','No Catch','Roping',100,true,'{}'),
('dq_reason','illegal_head_catch','Illegal Head Catch','Roping',110,true,'{}'),
('dq_reason','crossfire','Crossfire','Roping',120,true,'{}'),
('dq_reason','tie_did_not_hold','Tie Did Not Hold Six Seconds','Roping',130,true,'{}'),
('dq_reason','jerk_down','Jerk-Down','Roping',140,true,'{"unresolved":true,"note":"No-time or fine — pending association ruling"}'),
('dq_reason','rope_breaks_away_early','Rope Broke Away Early','Roping',150,true,'{}'),
('dq_reason','illegal_fall','Illegal Fall','Steer Wrestling',200,true,'{}'),
('dq_reason','steer_not_rethrown','Steer Got Up and Was Not Rethrown','Steer Wrestling',210,true,'{}'),
('dq_reason','off_pattern','Off Pattern','Speed',300,true,'{}'),
('dq_reason','failure_to_complete_pattern','Failed to Complete the Pattern','Speed',310,true,'{}'),
('dq_reason','touching_goat_after_signal','Touched the Goat After the Signal','Goat Tying',400,true,'{}'),
('dq_reason','unsportsmanlike_conduct','Unsportsmanlike Conduct','General',500,true,'{}'),
('dq_reason','equipment_violation','Equipment Violation','General',510,true,'{}'),
('dq_reason','late_to_chute','Late to the Chute','General',520,true,'{}'),
('dq_reason','refused_stock','Refused Stock','General',530,true,'{}'),
('dq_reason','ineligible_division','Ineligible for the Division','General',540,true,'{}'),
('dq_reason','no_show','No Show','General',550,true,'{}');

-- --------------------------------------------------------------- catch_type
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('catch_type','around_both_horns','Around Both Horns','Legal Head Catch',10,true,'{"legal":true}'),
('catch_type','half_head','Half Head','Legal Head Catch',20,true,'{"legal":true}'),
('catch_type','around_neck','Around the Neck','Legal Head Catch',30,true,'{"legal":true}'),
('catch_type','both_hind_legs','Both Hind Legs','Heel Catch',40,true,'{"legal":true}'),
('catch_type','one_hind_leg','One Hind Leg','Heel Catch',50,true,'{"legal":true,"penalty":"one_leg_catch"}'),
('catch_type','front_leg','Front Leg','Illegal',60,true,'{"legal":false}'),
('catch_type','figure_eight','Figure Eight','Illegal',70,true,'{"legal":false}'),
('catch_type','around_belly','Around the Belly','Illegal',80,true,'{"legal":false}');

-- -------------------------------------------------------------- draw_method
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('draw_method','random','Random Draw','Automatic',10,true,'{}'),
('draw_method','random_by_division','Random Within Division','Automatic',20,true,'{}'),
('draw_method','random_witnessed','Random, Witnessed','Automatic',30,true,'{"requires_witness":true}'),
('draw_method','buddy_group','Buddy / Travel Partner Groups','Automatic',40,true,'{}'),
('draw_method','seeded_by_standings','Seeded by Standings','Seeded',100,true,'{}'),
('draw_method','reverse_standings','Reverse Order of Standings','Seeded',110,true,'{}'),
('draw_method','sequential_by_entry','Order of Entry','Sequential',200,true,'{}'),
('draw_method','manual','Manual / Secretary Assigned','Manual',300,true,'{}');

-- ------------------------------------------------------------- entry_method
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('entry_method','online','Online','Self-Service',10,true,'{}'),
('entry_method','phone','Phone / Call-In','Assisted',20,true,'{}'),
('entry_method','mail','Mail-In','Assisted',30,true,'{}'),
('entry_method','walk_up','Walk-Up','Day Of',40,true,'{}'),
('entry_method','day_of','Day-Of Entry','Day Of',50,true,'{}'),
('entry_method','secretary_entered','Entered by Secretary','Assisted',60,true,'{}'),
('entry_method','procom','PROCOM','Import',70,true,'{}'),
('entry_method','imported','Imported from File','Import',80,true,'{}');

-- ------------------------------------------------------------- timer_system
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('timer_system','manual_stopwatch','Manual Stopwatch','Manual',10,true,'{"authority":"manual"}'),
('timer_system','hand_time','Hand Time (Backup)','Manual',20,true,'{"authority":"manual"}'),
('timer_system','farmtek_polaris','FarmTek Polaris','Electronic',100,true,'{"authority":"timer_hardware","protocol":"serial","resolution_us":125}'),
('timer_system','daktronics_omnisport','Daktronics OmniSport 2000','Electronic',110,true,'{"authority":"timer_hardware","protocol":"serial"}'),
('timer_system','electric_eye_generic','Electric Eye (Generic)','Electronic',120,true,'{"authority":"timer_hardware"}'),
('timer_system','web_serial','Web Serial (Chromium)','Electronic',130,true,'{"authority":"web_serial"}'),
('timer_system','timer_bridge','Timer Bridge App','Electronic',140,true,'{"authority":"timer_bridge"}');

-- ------------------------------------------------------------- animal_type
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('animal_type','bull','Bull','Rough Stock',10,true,'{}'),
('animal_type','mini_bull','Mini Bull','Rough Stock',20,true,'{}'),
('animal_type','saddle_bronc','Saddle Bronc','Rough Stock',30,true,'{}'),
('animal_type','bareback_bronc','Bareback Bronc','Rough Stock',40,true,'{}'),
('animal_type','calf','Calf','Cattle',100,true,'{"prca_weight_min":220,"prca_weight_max":280}'),
('animal_type','steer','Steer','Cattle',110,true,'{"prca_weight_min":450,"prca_weight_max":650}'),
('animal_type','heifer','Heifer','Cattle',120,true,'{}'),
('animal_type','cow','Cow','Cattle',130,true,'{}'),
('animal_type','horse','Horse','Other',200,true,'{}'),
('animal_type','goat','Goat','Other',210,true,'{}'),
('animal_type','sheep','Sheep','Other',220,true,'{}');

-- ---------------------------------------------------------- release_reason
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('release_reason','medical','Medical Release','Released',10,true,'{"requires_documentation":true,"counts_as_turnout":false}'),
('release_reason','vet_release','Veterinary Release','Released',20,true,'{"requires_documentation":true,"counts_as_turnout":false}'),
('release_reason','stock_issue','Stock Issue','Released',30,true,'{"counts_as_turnout":false}'),
('release_reason','weather','Weather','Released',40,true,'{"counts_as_turnout":false}'),
('release_reason','personal','Personal','Turnout',100,true,'{"counts_as_turnout":true}'),
('release_reason','travel','Travel','Turnout',110,true,'{"counts_as_turnout":true}'),
('release_reason','no_notice','No Notice Given','Turnout',120,true,'{"counts_as_turnout":true,"note":"PRCA requires 30h notice before the performance"}');

-- -------------------------------------------------------- payout_structure
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('payout_structure','standard_ladder','Standard Ladder (places by entry count)','Standard',10,true,'{}'),
('payout_structure','ground_money','Ladder with Ground Money','Standard',20,true,'{}'),
('payout_structure','cowboy_rules','Cowboy Rules (unfilled places not paid)','Standard',30,true,'{}'),
('payout_structure','winner_take_all','Winner Take All','Standard',40,true,'{}'),
('payout_structure','100_percent_payback','100% Payback','Standard',50,true,'{"admin_pct":0}'),
('payout_structure','go_round_average','Go-Round Money plus Average','Multi-Round',100,true,'{}'),
('payout_structure','ipra_three_head','IPRA Three-Head (2:2:3)','Multi-Round',110,true,'{}'),
('payout_structure','day_money','Day Money','Multi-Round',120,true,'{}'),
('payout_structure','d_format','D-Format Divisions','Divisional',200,true,'{}'),
('payout_structure','handicap_divisions','Handicap Divisions','Divisional',210,true,'{}'),
('payout_structure','progressive','Progressive / Rollover','Special',300,true,'{}'),
('payout_structure','added_money_only','Added Money Only','Special',310,true,'{}');

-- ---------------------------------------------------------- payment_method
insert into reference_options (domain, code, label, category, sort_order, is_system, metadata) values
('payment_method','stripe_connect','Card (online)','Electronic',10,true,'{"automated":true}'),
('payment_method','card_terminal','Card (in person)','Electronic',20,true,'{}'),
('payment_method','ach','Bank Transfer / ACH','Electronic',30,true,'{"automated":true}'),
('payment_method','venmo','Venmo','Electronic',40,true,'{}'),
('payment_method','paypal','PayPal','Electronic',50,true,'{}'),
('payment_method','cash','Cash','In Person',100,true,'{}'),
('payment_method','check','Check','In Person',110,true,'{}'),
('payment_method','money_order','Money Order','In Person',120,true,'{}'),
('payment_method','account_credit','Account Credit','Internal',200,true,'{}');
