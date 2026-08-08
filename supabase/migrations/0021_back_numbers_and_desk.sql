-- ============================================================================
-- 0021_back_numbers_and_desk.sql
-- Back numbers, and the two small things the entry desk needs.
--
-- ---------------------------------------------------------------------------
-- BACK NUMBERS BELONG TO THE RODEO, NOT THE ENTRY
-- ---------------------------------------------------------------------------
-- The day sheet has carried a `back_number` field since it was written and it
-- has always been null, with a comment saying the column does not exist yet.
-- This is that column — but it is not on `entries`, and the reason matters.
--
-- A contestant wears ONE back number for the whole rodeo. Tyler Hayes is 214
-- in the bareback and 214 in the bull riding and 214 in slack on Sunday. Put
-- the number on the entry and a contestant entered in three events gets three
-- numbers, the announcer reads the wrong one, and the judge writes it on the
-- wrong sheet.
--
-- So: one row per person per rodeo.
-- ============================================================================

create table back_numbers (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,
    rodeo_id    uuid not null,
    contestant_id uuid not null references users (id) on delete cascade,

    /**
     * Text, not an integer. Real back numbers include '7A', '014' and '2-B',
     * and a producer who numbers by event prefix would lose the prefix to an
     * integer column. Sorting is handled in the query, not by the type.
     */
    back_number text not null check (length(trim(back_number)) > 0),

    issued_at   timestamptz not null default now(),
    returned_at timestamptz,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (org_id, id),
    /** One number per person per rodeo. */
    unique (rodeo_id, contestant_id),
    /** And one person per number, or two people answer to the same call. */
    unique (rodeo_id, back_number),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_back_numbers on back_numbers (org_id, rodeo_id);

alter table back_numbers enable row level security;
alter table back_numbers force row level security;

create policy back_numbers_read on back_numbers
    for select using (
        app_is_org_member(org_id) or contestant_id = app_current_user_id()
    );

create policy back_numbers_write on back_numbers
    for all using (app_is_org_staff(org_id)) with check (app_is_org_staff(org_id));

create trigger back_numbers_touch
    before update on back_numbers
    for each row execute function touch_updated_at();

grant select, insert, update, delete on back_numbers to authenticated;

/**
 * Hand out numbers to everybody entered who has not got one.
 *
 * Assigns in a stable order — surname, then forename — rather than by entry
 * time, so re-running it after late entries does not reshuffle numbers that
 * are already written on somebody's shirt. Existing numbers are never touched.
 *
 * Returns how many were issued.
 */
create or replace function assign_back_numbers(
    p_org_id uuid,
    p_rodeo_id uuid,
    p_start int default 1
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    v_next int := p_start;
    v_issued int := 0;
    r record;
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised to assign back numbers'
            using errcode = '42501';
    end if;

    -- Start above the highest purely numeric number already issued, so a
    -- second run after late entries continues the series instead of colliding
    -- with it.
    select greatest(
             p_start,
             coalesce(max((back_number)::int) + 1, p_start)
           )
      into v_next
      from back_numbers
     where rodeo_id = p_rodeo_id
       and back_number ~ '^[0-9]+$';

    for r in
        select distinct en.contestant_id, u.last_name, u.first_name
          from entries en
          join users u on u.id = en.contestant_id
         where en.org_id = p_org_id
           and en.rodeo_id = p_rodeo_id
           and en.status not in ('scratched', 'turned_out', 'no_show')
           and not exists (
                 select 1 from back_numbers b
                  where b.rodeo_id = p_rodeo_id
                    and b.contestant_id = en.contestant_id
               )
         order by u.last_name, u.first_name
    loop
        insert into back_numbers (org_id, rodeo_id, contestant_id, back_number)
        values (p_org_id, p_rodeo_id, r.contestant_id, v_next::text);
        v_next := v_next + 1;
        v_issued := v_issued + 1;
    end loop;

    return v_issued;
end;
$$;

comment on function assign_back_numbers is
    'Issues back numbers to everybody entered who has not got one, in a stable '
    'order so a second run after late entries never reshuffles a number that '
    'is already on a shirt.';

-- ----------------------------------------------------------------------------
-- A note on the entry. Secretaries write on the books.
-- ----------------------------------------------------------------------------
alter table entries add column notes text;

comment on column entries.notes is
    'Free text from the entry desk. Appears on the day sheet.';

-- ----------------------------------------------------------------------------
-- Finding a person at the desk.
--
-- A secretary types three letters of a surname while somebody stands in front
-- of her. Without this the search is a sequential scan of every user in the
-- system, and the desk is the one place in the product where latency is felt
-- by a queue of people.
-- ----------------------------------------------------------------------------
create extension if not exists pg_trgm;

create index idx_users_name_trgm
    on users using gin ((lower(first_name || ' ' || last_name)) gin_trgm_ops);

create index idx_users_phone on users (phone) where phone is not null;
