-- ============================================================================
-- 0027_waiver_signing.sql
-- The signing flow. The tables have existed since 0007 and nothing could use
-- them.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS MISSING, AND WHY IT WAS NOT MERELY INCOMPLETE
-- ---------------------------------------------------------------------------
-- 0007 built `waiver_templates` and `signed_waivers` with real tamper evidence
-- — a hash of the exact text the signer saw, and a hash over the whole record.
-- Then two policies made it impossible to sign anything.
--
--   D42. `waiver_templates_read` is `org_id is null or app_is_org_member(...)`.
--        A contestant entering a rodeo is not a member of the producer's
--        organisation. So the person being asked to sign the release CANNOT
--        READ IT. The one document in this schema whose entire legal weight
--        rests on the signer having seen the text, and the signer is the one
--        party denied the text. This is D36 and D40 for the third time: a
--        policy that treats org_members as the only relationship a person can
--        have with an organisation, in a schema built for people who have no
--        membership anywhere.
--
--   D43. `signed_waivers_self_insert` requires `user_id = app_current_user_id()`.
--        Two consequences. A contestant created at the desk has no login at
--        all — `app_current_user_id()` is somebody else or nothing — so that
--        person can never have a waiver on file, and they are precisely the
--        person a jackpot producer most needs a release from. And a paper
--        waiver signed at the gate, which is how the overwhelming majority of
--        these are actually collected, cannot be recorded by the secretary who
--        is holding it.
--
-- ---------------------------------------------------------------------------
-- WHY SIGNING IS A FUNCTION AND NOT A POLICY
-- ---------------------------------------------------------------------------
-- `waiver_text_hash` is supposed to prove what the signer saw. If the client
-- computes it and sends it, it proves nothing whatsoever — it is a number the
-- signer's own browser made up. The same is true of `record_hash`.
--
-- So the hashes are computed HERE, from the template row as it exists in the
-- database at the moment of signing, and the client is never asked for them.
-- That is the difference between evidence and decoration, and it is the whole
-- reason 0007 bothered with the columns.
--
-- Matching the existing house style: `digest(..., 'sha256')` from pgcrypto, as
-- `book_closures.totals_hash` already does in 0020.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- D42 — the signer can read the document.
-- ----------------------------------------------------------------------------
drop policy waiver_templates_read on waiver_templates;

create policy waiver_templates_read on waiver_templates
    for select using (
        -- System templates. Nothing private in them.
        org_id is null
        -- Our own, whatever its state.
        or app_is_org_member(org_id)
        -- An active template of a producer we are entered with. This is the
        -- clause that makes signing possible.
        or (
            is_active and exists (
                select 1 from entries e
                 where e.org_id = waiver_templates.org_id
                   and (e.contestant_id = app_current_user_id()
                        or e.partner_id = app_current_user_id())
            )
        )
        -- Or working one of their rodeos: judges and pickup men sign too.
        or (
            is_active and exists (
                select 1 from rodeo_personnel p
                 where p.org_id = waiver_templates.org_id
                   and p.user_id = app_current_user_id()
            )
        )
        -- Or we have already signed it, so we can read back what we signed.
        or exists (
            select 1 from signed_waivers s
             where s.waiver_template_id = waiver_templates.id
               and (s.user_id = app_current_user_id()
                    or s.guardian_user_id = app_current_user_id())
        )
    );

comment on policy waiver_templates_read on waiver_templates is
    'The signer can read the document. A contestant is not a member of the '
    'producer''s organisation, and the old policy denied them the only text '
    'whose signature has any legal weight. See delta D42.';

-- ----------------------------------------------------------------------------
-- D43 — who actually collected the signature.
--
-- Same shape as `credentials.created_by` in D40, for the same two reasons: the
-- desk needs to record a waiver for somebody who has no login, and whoever
-- recorded it must be named on the row. An unattributed waiver recorded by
-- staff is worth less than no waiver at all, because it looks like evidence.
-- ----------------------------------------------------------------------------
alter table signed_waivers
    add column recorded_by uuid references users (id) on delete set null;

comment on column signed_waivers.recorded_by is
    'Who put this row here. Equal to user_id when somebody signed for '
    'themselves; the secretary''s id when a paper waiver was recorded at the '
    'desk. Never null after 0027. See delta D43.';

-- A paper release handed over at the gate is a real signature method and the
-- commonest one. Recording it as `click_to_sign` would be a lie in the
-- evidence column.
alter table signed_waivers
    drop constraint signed_waivers_signature_method_check;

alter table signed_waivers
    add constraint signed_waivers_signature_method_check
    check (signature_method in (
        'click_to_sign', 'typed_name', 'drawn_signature', 'paper_on_file'
    ));

alter table signed_waivers
    drop constraint signature_evidence_present;

alter table signed_waivers
    add constraint signature_evidence_present check (
        (signature_method = 'typed_name' and typed_name is not null)
        or (signature_method = 'drawn_signature' and signature_image_url is not null)
        or (signature_method = 'paper_on_file' and typed_name is not null)
        or signature_method = 'click_to_sign'
    );

-- ----------------------------------------------------------------------------
-- Signing.
--
-- SECURITY DEFINER because the hashes have to be computed from the stored
-- template rather than taken from the caller, and because a person with no
-- login cannot be the one making the call.
-- ----------------------------------------------------------------------------
create or replace function sign_waiver(
    p_org_id       uuid,
    p_template_id  uuid,
    p_user_id      uuid,
    p_method       text,
    p_typed_name   text default null,
    p_rodeo_id     uuid default null,
    p_signature_image_url text default null,
    p_guardian_user_id uuid default null,
    p_guardian_name    text default null,
    p_ip           inet default null,
    p_user_agent   text default null
)
returns signed_waivers
language plpgsql
security definer
set search_path = public
as $$
declare
    v_actor    uuid := app_current_user_id();
    v_body     text;
    v_version  int;
    v_tpl_org  uuid;
    v_active   boolean;
    v_signed   timestamptz := now();
    v_text_hash text;
    v_row      signed_waivers;
begin
    select body_text, version, org_id, is_active
      into v_body, v_version, v_tpl_org, v_active
      from waiver_templates
     where id = p_template_id;

    if v_body is null then
        raise exception 'no such waiver template' using errcode = 'P0002';
    end if;
    if not v_active then
        raise exception 'that waiver template is no longer in use'
            using errcode = '23514';
    end if;
    -- A system template (org_id null) may be signed for any organisation. An
    -- org's own template may not be borrowed by a different producer.
    if v_tpl_org is not null and v_tpl_org <> p_org_id then
        raise exception 'that template belongs to another organisation'
            using errcode = '42501';
    end if;

    -- Who may do this: the signer, their guardian, or staff of the producer
    -- collecting it. Staff is the paper case, and it is attributed below.
    if not (
        p_user_id = v_actor
        or (p_guardian_user_id is not null and p_guardian_user_id = v_actor)
        or app_is_org_staff(p_org_id)
    ) then
        raise exception 'not authorised to sign this waiver for that person'
            using errcode = '42501';
    end if;

    -- Staff may record a signature but never one purporting to be their own
    -- act on somebody else's behalf without saying so.
    if p_user_id <> v_actor and p_method = 'click_to_sign' then
        raise exception
            'a waiver recorded for another person needs a name or a signature, '
            'not a click'
            using errcode = '23514';
    end if;

    v_text_hash := encode(digest(v_body, 'sha256'), 'hex');

    insert into signed_waivers (
        org_id, user_id, waiver_template_id, rodeo_id,
        waiver_text_hash, waiver_version,
        signature_method, signature_image_url, typed_name,
        signed_at, ip_address, user_agent, consent_to_electronic,
        guardian_user_id, guardian_name, recorded_by,
        record_hash
    )
    values (
        p_org_id, p_user_id, p_template_id, p_rodeo_id,
        v_text_hash, v_version,
        p_method, p_signature_image_url, p_typed_name,
        v_signed, p_ip, p_user_agent, p_method <> 'paper_on_file',
        p_guardian_user_id, p_guardian_name, coalesce(v_actor, p_user_id),
        -- The record hash covers the identity of the signature, the text that
        -- was signed, and when. Changing any of them later is detectable.
        encode(digest(concat_ws('|',
            p_org_id::text, p_user_id::text, p_template_id::text,
            coalesce(p_rodeo_id::text, ''), v_text_hash, v_version::text,
            p_method, coalesce(p_typed_name, ''),
            coalesce(p_guardian_user_id::text, ''),
            to_char(v_signed at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')
        ), 'sha256'), 'hex')
    )
    returning * into v_row;

    return v_row;
end;
$$;

comment on function sign_waiver is
    'Records a signature and computes both hashes from the stored template. '
    'The client is never asked for a hash, because a hash the signer''s own '
    'browser produced is not evidence of anything.';

revoke all on function sign_waiver(uuid, uuid, uuid, text, text, uuid, text, uuid, text, inet, text) from public;
grant execute on function sign_waiver(uuid, uuid, uuid, text, text, uuid, text, uuid, text, inet, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Reading back what was recorded at the desk.
--
-- `signed_waivers_own_read` and `signed_waivers_staff_read` already cover the
-- signer and the producer. `recorded_by` closes the same gap D40 closed for
-- credentials: `INSERT ... RETURNING` applies the SELECT policy, so whoever
-- wrote the row must be able to read it back or the write appears to fail.
-- ----------------------------------------------------------------------------
create policy signed_waivers_recorder_read on signed_waivers
    for select using (recorded_by = app_current_user_id());

-- ----------------------------------------------------------------------------
-- Verifying the evidence.
--
-- The point of storing a hash is that somebody can check it later. If nothing
-- ever recomputes it, the column is decoration. This is what a producer runs
-- when a claim arrives and a lawyer asks whether the release on file is the
-- release that was signed.
-- ----------------------------------------------------------------------------
create or replace function verify_signed_waiver(p_signed_id uuid)
returns table (
    signed_waiver_id uuid,
    text_matches   boolean,
    record_matches boolean,
    template_changed_since boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    s signed_waivers;
    v_body text;
    v_current_version int;
    v_recomputed_text text;
begin
    select * into s from signed_waivers where id = p_signed_id;
    if s.id is null then
        raise exception 'no such signed waiver' using errcode = 'P0002';
    end if;
    if not (app_is_org_staff(s.org_id)
            or s.user_id = app_current_user_id()
            or s.guardian_user_id = app_current_user_id()) then
        raise exception 'not authorised' using errcode = '42501';
    end if;

    select body_text, version into v_body, v_current_version
      from waiver_templates where id = s.waiver_template_id;

    v_recomputed_text := encode(digest(coalesce(v_body, ''), 'sha256'), 'hex');

    return query select
        s.id,
        -- True when the template's text still hashes to what was signed. False
        -- is not necessarily tampering: the producer may have issued a new
        -- version over the top of the old row, which is why the third column
        -- exists to tell those two cases apart.
        v_recomputed_text = s.waiver_text_hash,
        encode(digest(concat_ws('|',
            s.org_id::text, s.user_id::text, s.waiver_template_id::text,
            coalesce(s.rodeo_id::text, ''), s.waiver_text_hash,
            s.waiver_version::text, s.signature_method,
            coalesce(s.typed_name, ''),
            coalesce(s.guardian_user_id::text, ''),
            to_char(s.signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')
        ), 'sha256'), 'hex') = s.record_hash,
        v_current_version <> s.waiver_version;
end;
$$;

revoke all on function verify_signed_waiver(uuid) from public;
grant execute on function verify_signed_waiver(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Who has not signed.
--
-- The question a secretary actually asks, the morning of the rodeo. Every
-- contestant with a live entry, and whether the required releases are on file.
-- ----------------------------------------------------------------------------
create or replace function waiver_shortfall(p_org_id uuid, p_rodeo_id uuid)
returns table (
    contestant_id uuid,
    first_name  text,
    last_name   text,
    template_id uuid,
    template_name text,
    waiver_type text,
    signed      boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
    if not app_is_org_staff(p_org_id) then
        raise exception 'not authorised' using errcode = '42501';
    end if;

    return query
    with people as (
        select distinct e.contestant_id as person_id
          from entries e
         where e.org_id = p_org_id and e.rodeo_id = p_rodeo_id
           and e.status not in ('scratched', 'turned_out', 'cancelled')
        union
        select distinct e.partner_id
          from entries e
         where e.org_id = p_org_id and e.rodeo_id = p_rodeo_id
           and e.partner_id is not null
           and e.status not in ('scratched', 'turned_out', 'cancelled')
    ),
    required as (
        select t.id, t.name, t.waiver_type
          from waiver_templates t
         where t.org_id = p_org_id
           and t.is_active
           and ('contestant' = any (t.applies_to_roles)
                or cardinality(t.applies_to_roles) = 0)
    )
    select p.person_id, u.first_name, u.last_name,
           r.id, r.name, r.waiver_type,
           exists (
               select 1 from signed_waivers s
                where s.org_id = p_org_id
                  and s.user_id = p.person_id
                  and s.waiver_template_id = r.id
                  -- An org-level release covers every rodeo; a rodeo-specific
                  -- one only covers its own.
                  and (s.rodeo_id is null or s.rodeo_id = p_rodeo_id)
           )
      from people p
      join users u on u.id = p.person_id
     cross join required r
     order by u.last_name, u.first_name, r.name;
end;
$$;

comment on function waiver_shortfall is
    'Every person with a live entry crossed with every active contestant '
    'release, and whether it is on file. The morning-of question.';

revoke all on function waiver_shortfall(uuid, uuid) from public;
grant execute on function waiver_shortfall(uuid, uuid) to authenticated;
