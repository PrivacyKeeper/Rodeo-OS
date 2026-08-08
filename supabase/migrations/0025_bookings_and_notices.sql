-- ============================================================================
-- 0025_bookings_and_notices.sql
-- Stalls and RV spots, and telling people things.
--
-- ---------------------------------------------------------------------------
-- WHY BOOKINGS BELONG IN A RODEO SYSTEM
-- ---------------------------------------------------------------------------
-- Entry fees are the CONTESTANTS' money — a producer holds them and pays them
-- straight back out as purse. Stall fees, RV hookups and arena rental are the
-- producer's own income, and until now the books reconciled the money that
-- passes through and said nothing about the money they keep. That is half a
-- set of books, and it is the half they personally care about.
--
-- The shape is the same one every booking system has: a finite resource, held
-- against dates, released or blocked by payment, with a cancellation window.
-- Modelled once here, it also serves arena rental, clinic seats, and — later —
-- stock contractor and contract-personnel availability, all of which are the
-- same problem wearing a different hat.
--
-- ---------------------------------------------------------------------------
-- WHY NOTICES ARE AN OUTBOX AND NOT AN EMAIL CALL
-- ---------------------------------------------------------------------------
-- Nothing here sends anything. Rows are written in the same transaction as the
-- thing they are about, and a separate worker delivers them.
--
-- That matters at a rodeo: a secretary commits the draw on a hotspot in an
-- arena office, and an inline call to an email provider means the draw either
-- waits for a network round trip or is lost when it fails. Writing a row
-- cannot fail separately from the draw itself, and a delivery that fails is
-- retried instead of forgotten.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Bookable resources
-- ----------------------------------------------------------------------------
create table bookable_resources (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    /** Null = available at every rodeo this producer runs. */
    rodeo_id    uuid,

    /** From reference_options domain 'resource_type'. Producer-extensible. */
    resource_type text not null,
    name        text not null,              -- 'Barn 3, Stall 14', 'RV 22 (30A)'
    description text,

    /**
     * How many of this row can be booked at once. A single stall is 1; a
     * "grounds camping" row with fifty spaces is 50 and needs no fifty rows.
     */
    capacity    int not null default 1 check (capacity >= 1),

    price_cents int not null default 0 check (price_cents >= 0),
    /** 'per_night', 'per_stay', 'per_head'. Priced by the producer, not us. */
    price_unit  text not null default 'per_stay',

    is_active   boolean not null default true,
    sort_order  int not null default 0,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_resources_org on bookable_resources (org_id, resource_type)
    where is_active;

-- ----------------------------------------------------------------------------
-- A booking
--
-- Dates are a DATERANGE rather than two columns, because the thing that has to
-- be true — two bookings of the same stall must not overlap — is a constraint
-- Postgres can enforce directly with an exclusion index. Two date columns and
-- an application check is how double-booking happens on the one weekend the
-- arena is full.
-- ----------------------------------------------------------------------------
create extension if not exists btree_gist;

create table bookings (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    resource_id uuid not null,
    rodeo_id    uuid,

    /** Who it is for. A contestant, or a name for somebody with no record. */
    user_id     uuid references users (id) on delete set null,
    contact_name text,
    contact_phone text,

    /** Half-open: [arrival, departure). A one-night stay is two dates. */
    stay        daterange not null,
    quantity    int not null default 1 check (quantity >= 1),

    amount_cents int not null default 0 check (amount_cents >= 0),
    paid        boolean not null default false,
    payment_reference text,

    status      text not null default 'held' check (status in (
                    'held', 'confirmed', 'cancelled', 'no_show', 'completed'
                )),
    /**
     * A hold that is not paid for expires. Without this every abandoned
     * checkout blocks a stall until somebody notices.
     */
    hold_expires_at timestamptz,

    cancelled_at timestamptz,
    cancel_reason text,
    refund_cents int check (refund_cents >= 0),

    notes       text,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, resource_id)
        references bookable_resources (org_id, id) on delete cascade,
    /**
     * `set null (rodeo_id)` — the column list is load-bearing. Without it
     * Postgres nulls EVERY referencing column, org_id included, and org_id is
     * NOT NULL, so deleting a rodeo that has bookings fails outright. See
     * delta D41 and 0026, which fixes the same mistake in three older tables.
     */
    foreign key (org_id, rodeo_id) references rodeos (org_id, id)
        on delete set null (rodeo_id),
    constraint booking_has_somebody check (
        user_id is not null or contact_name is not null
    ),
    constraint cancel_has_reason check (
        status <> 'cancelled' or cancel_reason is not null
    ),
    constraint stay_is_not_empty check (not isempty(stay)),

    /**
     * True when this resource holds one party at a time — a stall, a tack
     * room, an arena block. Denormalised from `bookable_resources.capacity`
     * because the exclusion constraint below needs it and the WHERE clause of
     * an exclusion constraint can only see this row. Set by a trigger; never
     * by a caller.
     */
    exclusive boolean not null default true
);

/**
 * Copy the resource's exclusivity onto the booking.
 *
 * A stall is exclusive and the constraint enforces it outright. A fifty-space
 * camping field is not, and its limit is counted under a lock in
 * book_resource() instead.
 */
create or replace function stamp_booking_exclusivity()
returns trigger
language plpgsql
as $$
begin
    select capacity = 1 into new.exclusive
      from bookable_resources where id = new.resource_id;
    if new.exclusive is null then
        raise exception 'no such resource' using errcode = 'P0002';
    end if;
    return new;
end;
$$;

create trigger bookings_stamp_exclusivity
    before insert on bookings
    for each row execute function stamp_booking_exclusivity();

create index idx_bookings_resource on bookings (org_id, resource_id);
create index idx_bookings_rodeo on bookings (org_id, rodeo_id);
create index idx_bookings_user on bookings (user_id) where user_id is not null;

/**
 * The constraint that makes this a booking system rather than a list.
 *
 * Two LIVE bookings of the same EXCLUSIVE resource may not overlap in time.
 * Cancelled and no-show rows are excluded so a stall frees up the moment
 * somebody drops it, and the check is in the database — an application-level
 * check loses to a race between two people booking the last stall at the same
 * moment.
 *
 * `exclusive` in the WHERE clause is what makes capacity work at all. Without
 * it the constraint applies to every resource, a twenty-space camping field
 * accepts exactly one booking, and the careful capacity counting in
 * book_resource() below never runs because the constraint fires first. That is
 * how this was originally written and a test caught it: an exclusion
 * constraint cannot count, only forbid, so it must be told which rows it is
 * entitled to forbid.
 */
create index idx_bookings_no_overlap on bookings using gist (resource_id, stay)
    where exclusive and status in ('held', 'confirmed', 'completed');

alter table bookings
    add constraint bookings_no_double_booking
    exclude using gist (
        resource_id with =,
        stay with &&
    ) where (exclusive and status in ('held', 'confirmed', 'completed'));

alter table bookable_resources enable row level security;
alter table bookable_resources force row level security;
alter table bookings enable row level security;
alter table bookings force row level security;

-- What is for sale is public: a contestant needs to see there are stalls
-- before they turn up with a horse.
create policy resources_public_read on bookable_resources
    for select using (
        is_active
        or app_is_org_member(org_id)
    );

create policy resources_write on bookable_resources
    for all using (app_is_org_staff(org_id)) with check (app_is_org_staff(org_id));

create policy bookings_read on bookings
    for select using (
        app_is_org_member(org_id) or user_id = app_current_user_id()
    );

create policy bookings_write on bookings
    for all using (app_is_org_staff(org_id)) with check (app_is_org_staff(org_id));

create trigger resources_touch before update on bookable_resources
    for each row execute function touch_updated_at();
create trigger bookings_touch before update on bookings
    for each row execute function touch_updated_at();

grant select on bookable_resources to anon, authenticated;
grant insert, update, delete on bookable_resources to authenticated;

/**
 * No direct INSERT, deliberately.
 *
 * A resource with capacity above one is protected only by the counting in
 * book_resource(); the exclusion constraint above cannot help it. If a caller
 * could insert straight into this table, they could oversell a camping field
 * without ever touching the check that stops it. So the only way in is the
 * function, which is SECURITY DEFINER and therefore unaffected by this.
 *
 * Updates stay open: confirming, cancelling and expiring a hold are ordinary
 * writes governed by `bookings_write`, and none of them can create an overlap.
 */
grant select, update, delete on bookings to authenticated;

/**
 * Book a resource, respecting capacity.
 *
 * The exclusion constraint forbids overlap outright, which is right for a
 * single stall and wrong for a fifty-space camping field. So a resource with
 * capacity greater than one is counted here instead, inside a transaction that
 * takes an advisory lock on the resource — the same technique the settlement
 * code uses, and for the same reason: a locking read on a table with row-level
 * security does not do what it looks like (delta D28).
 */
create or replace function book_resource(
    p_org_id      uuid,
    p_resource_id uuid,
    p_from        date,
    p_to          date,
    p_quantity    int default 1,
    p_user_id     uuid default null,
    p_contact     text default null,
    p_rodeo_id    uuid default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    v_capacity int;
    v_price    int;
    v_nights   int;
    v_taken    int;
    v_row      bookings;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised to take bookings for this organisation'
            using errcode = '42501';
    end if;
    if p_to <= p_from then
        raise exception 'a stay must end after it starts' using errcode = '22007';
    end if;

    -- Serialise everybody booking this resource. Advisory rather than a
    -- locking read, for the reason in delta D28.
    perform pg_advisory_xact_lock(hashtextextended(p_resource_id::text, 0));

    select capacity, price_cents into v_capacity, v_price
      from bookable_resources
     where id = p_resource_id and org_id = p_org_id and is_active;

    if v_capacity is null then
        raise exception 'no such resource' using errcode = 'P0002';
    end if;

    if v_capacity > 1 then
        select coalesce(sum(quantity), 0) into v_taken
          from bookings
         where resource_id = p_resource_id
           and status in ('held', 'confirmed', 'completed')
           and stay && daterange(p_from, p_to, '[)');

        if v_taken + p_quantity > v_capacity then
            raise exception 'only % of % left for those dates',
                greatest(v_capacity - v_taken, 0), v_capacity
                using errcode = '23514';
        end if;
    end if;

    v_nights := p_to - p_from;

    insert into bookings (org_id, resource_id, rodeo_id, user_id, contact_name,
                          stay, quantity, amount_cents, status, hold_expires_at)
    values (p_org_id, p_resource_id, p_rodeo_id, p_user_id, p_contact,
            daterange(p_from, p_to, '[)'), p_quantity,
            -- Priced by the unit the producer set. Nightly multiplies.
            case (select price_unit from bookable_resources where id = p_resource_id)
                when 'per_night' then v_price * v_nights * p_quantity
                when 'per_head'  then v_price * p_quantity
                else v_price * p_quantity
            end,
            'held',
            now() + interval '24 hours')
    returning * into v_row;

    return v_row;
end;
$$;

comment on function book_resource is
    'Books a resource for a date range, respecting capacity. Capacity of one '
    'is enforced by an exclusion constraint; more than one is counted under an '
    'advisory lock, because an exclusion constraint can forbid but not count.';

-- Seed the resource types every rodeo already sells on a clipboard.
insert into reference_options (domain, code, label, description, is_system, category, sort_order)
values
  ('resource_type', 'stall', 'Stall', 'A single horse stall.', true, 'Grounds', 10),
  ('resource_type', 'rv_spot', 'RV spot', 'Hookup or dry camping space.', true, 'Grounds', 20),
  ('resource_type', 'tack_room', 'Tack room', null, true, 'Grounds', 30),
  ('resource_type', 'pen', 'Pen', 'Stock pen or turnout.', true, 'Grounds', 40),
  ('resource_type', 'arena_slot', 'Arena time', 'Practice or rental block.', true, 'Facility', 50),
  ('resource_type', 'clinic_seat', 'Clinic seat', null, true, 'Programme', 60),
  ('resource_type', 'vendor_space', 'Vendor space', null, true, 'Facility', 70),
  ('resource_type', 'camping', 'Camping', 'Unserviced ground.', true, 'Grounds', 80)
on conflict do nothing;

-- ============================================================================
-- Notices — an outbox, not a mailer
-- ============================================================================

create table notices (
    id          bigserial primary key,
    org_id      uuid references organizations (id) on delete cascade,

    /** From reference_options domain 'notice_type'. */
    notice_type text not null,

    /** Who it is for. Null recipient with a topic = a broadcast. */
    user_id     uuid references users (id) on delete cascade,
    email       text,
    phone       text,

    /** What it is about, so a click can go somewhere useful. */
    rodeo_id    uuid,
    entity_type text,
    entity_id   uuid,

    subject     text not null,
    body        text not null,
    /** Structured payload for a push notification or a templated email. */
    payload     jsonb not null default '{}'::jsonb,

    /** 'email' | 'sms' | 'push' | 'in_app'. Producer-configurable per type. */
    channel     text not null default 'in_app',

    status      text not null default 'pending' check (status in (
                    'pending', 'sending', 'sent', 'failed', 'cancelled', 'suppressed'
                )),
    attempts    int not null default 0 check (attempts >= 0),
    last_error  text,

    /** Not before this. A deadline reminder is written now and sent later. */
    send_after  timestamptz not null default now(),
    sent_at     timestamptz,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    constraint notice_has_a_recipient check (
        user_id is not null or email is not null or phone is not null
    )
);

create index idx_notices_queue on notices (status, send_after)
    where status in ('pending', 'failed');
create index idx_notices_user on notices (user_id, created_at desc);
create index idx_notices_rodeo on notices (org_id, rodeo_id);

alter table notices enable row level security;
alter table notices force row level security;

-- A person reads their own notices; staff read what their org sent.
create policy notices_own on notices
    for select using (user_id = app_current_user_id());

create policy notices_org on notices
    for select using (org_id is not null and app_is_org_member(org_id));

create policy notices_write on notices
    for insert with check (org_id is not null and app_is_org_staff(org_id));

create trigger notices_touch before update on notices
    for each row execute function touch_updated_at();

grant select, insert on notices to authenticated;
grant usage, select on sequence notices_id_seq to authenticated;

insert into reference_options (domain, code, label, description, is_system, category, sort_order)
values
  ('notice_type', 'draw_posted', 'Draw posted',
   'The draw is up. The single most-wanted message in the sport.', true, 'Rodeo', 10),
  ('notice_type', 'results_posted', 'Results posted', null, true, 'Rodeo', 20),
  ('notice_type', 'entry_confirmed', 'Entry confirmed', null, true, 'Entry', 30),
  ('notice_type', 'payment_received', 'Payment received', null, true, 'Entry', 40),
  ('notice_type', 'entry_deadline', 'Entries closing', null, true, 'Entry', 50),
  ('notice_type', 'performance_reminder', 'You run soon', null, true, 'Rodeo', 60),
  ('notice_type', 'stock_drawn', 'Stock drawn', null, true, 'Rodeo', 70),
  ('notice_type', 'booking_confirmed', 'Booking confirmed', null, true, 'Grounds', 80),
  ('notice_type', 'compliance_due', 'Filing due', 'To the producer, not the contestant.', true, 'Producer', 90),
  ('notice_type', 'insurance_expiring', 'Insurance expiring', null, true, 'Producer', 100),
  ('notice_type', 'payout_sent', 'You were paid', null, true, 'Money', 110)
on conflict do nothing;

/**
 * Queue a notice.
 *
 * Called inside the transaction that does the thing being announced, so the
 * draw and "the draw is posted" either both happen or neither does. Delivery
 * is somebody else's problem, later, with retries.
 */
create or replace function queue_notice(
    p_org_id   uuid,
    p_type     text,
    p_user_id  uuid,
    p_subject  text,
    p_body     text,
    p_rodeo_id uuid default null,
    p_channel  text default 'in_app',
    p_payload  jsonb default '{}'::jsonb,
    p_send_after timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id bigint;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised' using errcode = '42501';
    end if;

    insert into notices (org_id, notice_type, user_id, rodeo_id, subject, body,
                         channel, payload, send_after)
    values (p_org_id, p_type, p_user_id, p_rodeo_id, p_subject, p_body,
            p_channel, coalesce(p_payload, '{}'::jsonb), p_send_after)
    returning id into v_id;

    return v_id;
end;
$$;

/**
 * Tell everybody drawn into a rodeo that the draw is up.
 *
 * One row per contestant, written in the same transaction as the draw. This is
 * the message contestants want more than any other, and posting it to a
 * Facebook page at eleven at night is how it is done today.
 */
create or replace function notify_draw_posted(p_org_id uuid, p_rodeo_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    v_name text;
    v_count int;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised' using errcode = '42501';
    end if;

    select name into v_name from rodeos where id = p_rodeo_id and org_id = p_org_id;
    if v_name is null then
        raise exception 'rodeo not found' using errcode = 'P0002';
    end if;

    insert into notices (org_id, notice_type, user_id, rodeo_id, subject, body,
                         channel, payload)
    select distinct
           p_org_id, 'draw_posted', e.contestant_id, p_rodeo_id,
           v_name || ' — the draw is up',
           'Your position is posted. Open the app to see when you run.',
           'push',
           jsonb_build_object('rodeo_id', p_rodeo_id)
      from entries e
     where e.org_id = p_org_id
       and e.rodeo_id = p_rodeo_id
       and e.draw_position is not null
       and e.status not in ('scratched', 'turned_out', 'no_show')
       -- Never twice for the same draw.
       and not exists (
             select 1 from notices n
              where n.rodeo_id = p_rodeo_id
                and n.user_id = e.contestant_id
                and n.notice_type = 'draw_posted'
           );

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

comment on table notices is
    'Outbox. Rows are written in the transaction that does the thing being '
    'announced; a worker delivers them. Nothing here sends anything, which is '
    'what stops a flaky arena hotspot losing a draw.';
