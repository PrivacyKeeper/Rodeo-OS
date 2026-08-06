-- ============================================================================
-- 0007_compliance.sql
-- Waivers, signatures, insurance certificates, audit log.
--
-- Architecture ref: §2.2.9
--
-- A signed waiver is evidence. It is written once and never altered; the hash
-- columns are what make a later alteration detectable.
-- ============================================================================

create table waiver_templates (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid references organizations (id) on delete cascade,
                -- NULL = system template

    name        text not null,
    waiver_type text not null check (waiver_type in (
                    'liability_release', 'medical_waiver', 'media_consent',
                    'minor_consent', 'stock_contractor_insurance',
                    'drug_testing_consent', 'code_of_conduct'
                )),

    body_text   text not null,              -- Markdown
    version     int not null default 1 check (version >= 1),

    required_by text[] not null default '{}',        -- ['PRCA','WPRA']
    applies_to_roles text[] not null default '{}',   -- ['contestant','stock_contractor']
    requires_notary boolean not null default false,  -- CPRA Canada

    is_active   boolean not null default true,

    created_at  timestamptz not null default now(),

    unique (org_id, name, version)
);

-- ----------------------------------------------------------------------------
-- Signed waivers — IMMUTABLE
-- ----------------------------------------------------------------------------
create table signed_waivers (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete restrict,

    user_id     uuid not null references users (id),
    waiver_template_id uuid not null references waiver_templates (id),
    rodeo_id    uuid,                       -- NULL for org-level waivers

    -- Tamper evidence: the exact text the signer saw, hashed at signing time.
    waiver_text_hash text not null,         -- SHA-256 of body_text
    waiver_version   int not null,

    signature_method text not null check (signature_method in (
                        'click_to_sign', 'typed_name', 'drawn_signature'
                    )),
    signature_image_url text,
    typed_name  text,

    signed_at   timestamptz not null,
    ip_address  inet,
    user_agent  text,
    consent_to_electronic boolean not null default true,

    record_hash text not null,              -- SHA-256 over the whole record

    guardian_user_id uuid references users (id),
    guardian_name    text,

    pdf_url     text,

    created_at  timestamptz not null default now(),
    -- deliberately no updated_at

    foreign key (org_id, rodeo_id) references rodeos (org_id, id),
    constraint signature_evidence_present check (
        (signature_method = 'typed_name' and typed_name is not null)
        or (signature_method = 'drawn_signature' and signature_image_url is not null)
        or signature_method = 'click_to_sign'
    )
);

create index idx_signed_waivers on signed_waivers (org_id, user_id, waiver_template_id);
create index idx_signed_waivers_rodeo on signed_waivers (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- Insurance certificates
-- ----------------------------------------------------------------------------
create table insurance_certificates (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations (id) on delete cascade,

    holder_id   uuid not null references users (id),

    policy_number text,
    insurer_name  text not null,
    coverage_type text not null check (coverage_type in (
                        'public_liability', 'personal_accident', 'ad_d'
                    )),
    coverage_amount decimal(14, 2) check (coverage_amount >= 0),
    currency    text not null default 'USD',

    effective_date date not null,
    expiry_date    date not null,

    certificate_url text,

    verified    boolean not null default false,
    verified_by uuid references users (id),
    verified_at timestamptz,

    expiry_reminded boolean not null default false,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint insurance_dates check (expiry_date > effective_date)
);

create index idx_insurance on insurance_certificates (org_id, holder_id, expiry_date);

-- ----------------------------------------------------------------------------
-- Audit log — every privileged action, append-only
-- ----------------------------------------------------------------------------
create table audit_log (
    id          bigserial primary key,
    org_id      uuid references organizations (id) on delete restrict,

    actor_id    uuid references users (id),
    actor_role  text,

    action      text not null,              -- 'score.correct', 'payout.disburse'
    entity_type text not null,
    entity_id   uuid,

    before      jsonb,
    after       jsonb,

    ip_address  inet,
    user_agent  text,
    request_id  text,

    created_at  timestamptz not null default now()
);

create index idx_audit_org_time on audit_log (org_id, created_at desc);
create index idx_audit_entity on audit_log (entity_type, entity_id);
create index idx_audit_actor on audit_log (actor_id, created_at desc);
