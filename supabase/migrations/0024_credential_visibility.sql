-- ============================================================================
-- 0024_credential_visibility.sql
-- D40 — A secretary could not record the card of a judge she had just booked.
--
-- ---------------------------------------------------------------------------
-- The same mistake as D36, in a second place. `credentials_org_write` (0019)
-- allows staff to write a credential only for somebody who is an org_members
-- row in their organisation:
--
--     exists (select 1 from org_members m
--              where m.user_id = credentials.user_id
--                and m.accepted_at is not null
--                and app_is_org_staff(m.org_id))
--
-- A contract judge is not on your staff roster. He works four rodeos for four
-- different producers in a season and is a member of none of them. So the
-- committee that hires him cannot record his card, `credential_is_current()`
-- returns false because there is nothing to check, and `personnel_shortfall()`
-- reports the rodeo one carded judge short forever — while the judge stands in
-- the arena with the card in his pocket.
--
-- The lesson from D36 restated: any policy that assumes org_members is the only
-- way to relate a person to an organisation is wrong, because this schema
-- deliberately supports people who have no login and no membership anywhere.
--
-- ---------------------------------------------------------------------------
-- THE SPLIT THAT MAKES THIS SAFE
-- ---------------------------------------------------------------------------
-- Recording a card and verifying it are different acts, and only one of them
-- matters:
--
--   * RECORDING is harmless. `credential_is_current()` counts only verified
--     cards, so an unverified row changes nothing — it is a note saying "he
--     says he is carded, number J-99". Any staff member may write one, for
--     anybody. That is what makes the workflow possible.
--
--   * VERIFYING is the act with consequences, because it is what satisfies a
--     sanctioning requirement. It stays restricted to staff of an organisation
--     that has an actual relationship with the person, and nobody may verify
--     their own card.
--
-- Before this, the two were governed by one policy and the strict half made
-- the harmless half impossible.
-- ============================================================================

drop policy credentials_org_write on credentials;
drop policy credentials_self_write on credentials;
drop policy credentials_self_edit on credentials;

-- ----------------------------------------------------------------------------
-- Recording. Anybody on staff anywhere, for anybody — but never pre-verified.
-- ----------------------------------------------------------------------------
create policy credentials_insert on credentials
    for insert with check (
        not verified
        and (
            -- A person recording their own card.
            user_id = app_current_user_id()
            -- Or a secretary writing down what a contract judge told her.
            or exists (
                select 1 from org_members m
                 where m.user_id = app_current_user_id()
                   and m.accepted_at is not null
                   and m.role in ('owner', 'admin', 'secretary')
            )
        )
    );

comment on policy credentials_insert on credentials is
    'Anybody on staff may record a card for anybody, because a contract judge '
    'belongs to no organisation. The row is unverified and counts for nothing '
    'until somebody checks it. See delta D40.';

-- ----------------------------------------------------------------------------
-- Editing an unverified card. The holder, or staff who deal with them.
-- ----------------------------------------------------------------------------
create policy credentials_update_unverified on credentials
    for update
    using (
        not verified
        and (
            user_id = app_current_user_id()
            or exists (
                select 1 from rodeo_personnel p
                 where p.user_id = credentials.user_id
                   and app_is_org_staff(p.org_id)
            )
            or exists (
                select 1 from org_members m
                 where m.user_id = credentials.user_id
                   and m.accepted_at is not null
                   and app_is_org_staff(m.org_id)
            )
        )
    )
    with check (
        -- The holder may correct their own details but may NOT flip the
        -- verified flag by editing their own row. Self-certification would
        -- make the whole registry worthless.
        (user_id = app_current_user_id() and not verified)
        or exists (
            select 1 from rodeo_personnel p
             where p.user_id = credentials.user_id
               and app_is_org_staff(p.org_id)
        )
        or exists (
            select 1 from org_members m
             where m.user_id = credentials.user_id
               and m.accepted_at is not null
               and app_is_org_staff(m.org_id)
        )
    );

-- ----------------------------------------------------------------------------
-- A verified card may still be corrected or revoked, but only by staff who
-- have a relationship with the holder — never by the holder.
-- ----------------------------------------------------------------------------
create policy credentials_update_verified on credentials
    for update
    using (
        verified
        and user_id <> app_current_user_id()
        and (
            exists (
                select 1 from rodeo_personnel p
                 where p.user_id = credentials.user_id
                   and app_is_org_staff(p.org_id)
            )
            or exists (
                select 1 from org_members m
                 where m.user_id = credentials.user_id
                   and m.accepted_at is not null
                   and app_is_org_staff(m.org_id)
            )
        )
    )
    with check (user_id <> app_current_user_id());

create policy credentials_delete on credentials
    for delete using (
        user_id = app_current_user_id() and not verified
    );

-- ----------------------------------------------------------------------------
-- Verifying is a separate, auditable act.
--
-- SECURITY DEFINER so the check lives in one place rather than being spread
-- across a policy's WITH CHECK clause, where "is this person allowed to
-- verify" and "is this row allowed to change" get tangled together.
-- ----------------------------------------------------------------------------
create or replace function verify_credential(p_credential_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_holder uuid;
    v_actor  uuid := app_current_user_id();
begin
    select user_id into v_holder from credentials where id = p_credential_id;
    if v_holder is null then
        return false;
    end if;

    -- Nobody certifies their own card.
    if v_holder = v_actor then
        raise exception 'a card cannot be verified by its holder'
            using errcode = '42501';
    end if;

    -- The verifier must be staff somewhere that deals with this person:
    -- they are on one of our rodeos, or they are on our roster.
    if not (
        exists (
            select 1 from rodeo_personnel p
             where p.user_id = v_holder and app_is_org_staff(p.org_id)
        )
        or exists (
            select 1 from org_members m
             where m.user_id = v_holder
               and m.accepted_at is not null
               and app_is_org_staff(m.org_id)
        )
    ) then
        raise exception 'not authorised to verify this card' using errcode = '42501';
    end if;

    update credentials
       set verified = true, verified_by = v_actor, verified_at = now(),
           updated_at = now()
     where id = p_credential_id;

    return true;
end;
$$;

comment on function verify_credential is
    'Marks a card as checked by a human. Separate from recording it, because '
    'recording is harmless and verifying is what satisfies a sanctioning '
    'requirement. Nobody verifies their own.';

revoke all on function verify_credential(uuid) from public;
grant execute on function verify_credential(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The read side of the same defect, which is subtler.
--
-- `credentials_org` (0019) has the identical org_members assumption, so the
-- secretary who has just recorded a contract judge's card cannot read it back.
-- That is not merely inconvenient: `INSERT ... RETURNING` applies the SELECT
-- policy to the new row, so the insert itself fails with a row-level security
-- error even though the WITH CHECK passed. The write appeared broken when the
-- actual fault was the read.
--
-- `created_by` closes it. Whoever wrote a card down can see the card they
-- wrote down — which is the whole workflow — without opening the registry to
-- everybody.
-- ----------------------------------------------------------------------------
alter table credentials
    add column created_by uuid references users (id) on delete set null;

comment on column credentials.created_by is
    'Who recorded this card. Lets the secretary who wrote it down read it '
    'back, which INSERT ... RETURNING requires. See delta D40.';

create or replace function stamp_credential_author()
returns trigger
language plpgsql
as $$
begin
    if new.created_by is null then
        new.created_by := app_current_user_id();
    end if;
    return new;
end;
$$;

create trigger credentials_stamp_author
    before insert on credentials
    for each row execute function stamp_credential_author();

drop policy credentials_org on credentials;

create policy credentials_org on credentials
    for select using (
        -- Somebody on our roster.
        exists (
            select 1 from org_members m
             where m.user_id = credentials.user_id
               and m.accepted_at is not null
               and app_is_org_staff(m.org_id)
        )
        -- Somebody working one of our rodeos. The ordinary case for a judge.
        or exists (
            select 1 from rodeo_personnel p
             where p.user_id = credentials.user_id
               and app_is_org_staff(p.org_id)
        )
        -- Or we are the ones who wrote it down.
        or credentials.created_by = app_current_user_id()
    );

comment on policy credentials_org on credentials is
    'Staff read the cards of people on their roster, people working their '
    'rodeos, and cards they recorded themselves. Not the whole registry.';

-- ----------------------------------------------------------------------------
-- One more ordering trap, found by the same tests.
--
-- Verifying required a relationship, the relationship is created by assigning
-- somebody to a rodeo, and assigning resolved the credential — so the card had
-- to be verified before the assignment that made verification possible.
--
-- The real workflow has no such circle: the judge hands the secretary his card
-- at the gate, she writes the number down and confirms she has seen it. The
-- person who recorded a card is exactly the person who should be able to
-- verify it — as long as they are not its holder, which is the rule that
-- actually matters.
-- ----------------------------------------------------------------------------
create or replace function verify_credential(p_credential_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_holder  uuid;
    v_author  uuid;
    v_actor   uuid := app_current_user_id();
begin
    select user_id, created_by into v_holder, v_author
      from credentials where id = p_credential_id;
    if v_holder is null then
        return false;
    end if;

    -- The one rule that carries the weight: nobody certifies their own card.
    if v_holder = v_actor then
        raise exception 'a card cannot be verified by its holder'
            using errcode = '42501';
    end if;

    if not (
        -- Whoever wrote it down looked at it.
        v_author = v_actor
        -- Or somebody on staff who deals with the holder.
        or exists (
            select 1 from rodeo_personnel p
             where p.user_id = v_holder and app_is_org_staff(p.org_id)
        )
        or exists (
            select 1 from org_members m
             where m.user_id = v_holder
               and m.accepted_at is not null
               and app_is_org_staff(m.org_id)
        )
    ) then
        raise exception 'not authorised to verify this card' using errcode = '42501';
    end if;

    update credentials
       set verified = true, verified_by = v_actor, verified_at = now(),
           updated_at = now()
     where id = p_credential_id;

    return true;
end;
$$;
