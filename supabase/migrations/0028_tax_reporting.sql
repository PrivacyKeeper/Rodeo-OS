-- ============================================================================
-- 0028_tax_reporting.sql
-- Year-end reporting: what the producer's accountant needs in January.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT DO, AND WHY
-- ---------------------------------------------------------------------------
-- It does not file anything. It cannot, and that is deliberate: `users` stores
-- `tax_id_last4` and nothing else. There is no SSN in this database, so there
-- is no 1099 this system could transmit even if it wanted to. That decision
-- was made in 0001 and it is the right one — a rodeo entry system holding tens
-- of thousands of Social Security numbers is a breach waiting to be named
-- after somebody.
--
-- What a producer actually needs is the number. Who did I pay, how much, did
-- they cross the threshold, and do I have a W-9 on file. That is a report, it
-- comes out of the ledger, and today it comes out of a shoebox.
--
-- ---------------------------------------------------------------------------
-- WHY THE THRESHOLD IS A ROW AND NOT A CONSTANT
-- ---------------------------------------------------------------------------
-- The US threshold was $600 for four decades and then moved. The One Big
-- Beautiful Bill Act, signed July 2025, raised the 1099-NEC and 1099-MISC
-- threshold to $2,000 for payments made on or after 1 January 2026, and from
-- 2026 it is indexed for inflation — so it will move again, quietly, most
-- years. A constant compiled into the payout engine would be wrong within
-- twelve months and nobody would notice until a producer under-reported.
--
-- So it is data, by country and by year, and the report states which threshold
-- it applied rather than leaving the reader to assume. A producer whose
-- accountant disagrees can change the row.
--
-- Canada is seeded at zero on purpose. Regulation 105 withholding is already
-- computed by the engine (`WITHHOLDING_RULES.CA`, 15%, form T4A-NR); a slip is
-- required for the payment, not for the payment being large.
-- ============================================================================

create table tax_reporting_thresholds (
    id          uuid primary key default gen_random_uuid(),
    /** Null = every producer. A producer may override with their own row. */
    org_id      uuid references organizations (id) on delete cascade,

    country     text not null,
    tax_year    int not null check (tax_year between 2000 and 2100),
    form        text not null,                    -- '1099-NEC', 'T4A-NR'

    /** Cents. Total paid to one person in the year, at or above which the
        payer has a reporting obligation. Zero means "always report". */
    threshold_cents int not null check (threshold_cents >= 0),

    notes       text,
    is_system   boolean not null default false,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique nulls not distinct (org_id, country, tax_year, form)
);

alter table tax_reporting_thresholds enable row level security;
alter table tax_reporting_thresholds force row level security;

create policy tax_thresholds_read on tax_reporting_thresholds
    for select using (org_id is null or app_is_org_member(org_id));

create policy tax_thresholds_write on tax_reporting_thresholds
    for all using (org_id is not null and app_is_org_staff(org_id))
    with check (org_id is not null and app_is_org_staff(org_id));

create trigger tax_thresholds_touch before update on tax_reporting_thresholds
    for each row execute function touch_updated_at();

grant select on tax_reporting_thresholds to authenticated;
grant insert, update, delete on tax_reporting_thresholds to authenticated;

insert into tax_reporting_thresholds
    (org_id, country, tax_year, form, threshold_cents, is_system, notes)
values
  (null, 'US', 2025, '1099-NEC', 60000, true,
   'The long-standing $600 threshold. Applies to payments made through 31 December 2025.'),
  (null, 'US', 2026, '1099-NEC', 200000, true,
   'Raised to $2,000 by the One Big Beautiful Bill Act for payments made on or '
   'after 1 January 2026, and indexed for inflation thereafter. Confirm the '
   'indexed figure with your accountant each year before filing.'),
  (null, 'CA', 2026, 'T4A-NR', 0, true,
   'Regulation 105. A slip accompanies the payment to a non-resident for '
   'services rendered in Canada; there is no de minimis amount here, so this '
   'is zero by design rather than unset.')
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- The report.
--
-- Gated on `app_can_view_financials` rather than plain staff: this is the one
-- query in the system that returns a mailing address next to a dollar total
-- for every person a producer paid all year.
-- ----------------------------------------------------------------------------
create or replace function tax_year_summary(
    p_org_id uuid,
    p_year   int,
    p_country text default null
)
returns table (
    contestant_id   uuid,
    first_name      text,
    last_name       text,
    address_line1   text,
    address_line2   text,
    city            text,
    state_province  text,
    postal_code     text,
    country         text,
    tax_id_type     text,
    tax_id_last4    text,
    tax_id_verified boolean,
    gross_cents     bigint,
    withholding_cents bigint,
    net_cents       bigint,
    payment_count   int,
    form            text,
    threshold_cents int,
    reportable      boolean,
    missing_tax_id  boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_org_country text;
begin
    if not app_can_view_financials(p_org_id) then
        raise exception 'not authorised to read this organisation''s finances'
            using errcode = '42501';
    end if;

    select o.country into v_org_country from organizations o where o.id = p_org_id;
    v_org_country := coalesce(p_country, v_org_country, 'US');

    return query
    with paid as (
        select t.to_user_id as person_id,
               -- gross_amount is what was earned before withholding; it is
               -- null on a payment that had none, in which case amount IS the
               -- gross. Reporting on `amount` alone would understate every
               -- non-resident's earnings by exactly the tax withheld from
               -- them, which is the one number a T4A-NR exists to state.
               sum(round(coalesce(t.gross_amount, t.amount) * 100))::bigint as gross_cents,
               sum(round(coalesce(t.withholding_amount, 0) * 100))::bigint as withholding_cents,
               sum(round(t.amount * 100))::bigint as net_cents,
               count(*)::int as payment_count
          from financial_transactions t
         where t.org_id = p_org_id
           and t.to_user_id is not null
           and t.transaction_type in (
                 'payout_prize', 'payout_ground_money', 'payout_day_money',
                 'payout_bonus', 'payout_stock_contractor'
               )
           and t.status in ('completed', 'released')
           and extract(year from t.created_at at time zone 'UTC') = p_year
         group by t.to_user_id
    ),
    threshold as (
        -- A producer's own override beats the system row. `order by org_id
        -- nulls last` is what expresses that preference.
        select th.form, th.threshold_cents
          from tax_reporting_thresholds th
         where th.country = v_org_country
           and th.tax_year = p_year
           and (th.org_id = p_org_id or th.org_id is null)
         order by th.org_id nulls last
         limit 1
    )
    select p.person_id, u.first_name, u.last_name,
           u.address_line1, u.address_line2, u.city, u.state_province,
           u.postal_code, u.country,
           u.tax_id_type, u.tax_id_last4, u.tax_id_verified,
           p.gross_cents, p.withholding_cents, p.net_cents, p.payment_count,
           th.form,
           th.threshold_cents,
           p.gross_cents >= th.threshold_cents,
           -- The thing the producer is chasing in January: somebody who
           -- crossed the threshold and never handed in a W-9.
           (p.gross_cents >= th.threshold_cents)
               and (u.tax_id_last4 is null or not u.tax_id_verified)
      from paid p
      join users u on u.id = p.person_id
     cross join threshold th
     order by p.gross_cents desc;
end;
$$;

comment on function tax_year_summary is
    'Everyone a producer paid in a calendar year, against the threshold in '
    'force for that year and country. Reports; does not file. This database '
    'holds only the last four digits of a tax identifier, deliberately.';

revoke all on function tax_year_summary(uuid, int, text) from public;
grant execute on function tax_year_summary(uuid, int, text) to authenticated;
