/**
 * The grounds, the outbox, the releases and the year-end numbers.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE FOUR LIVE TOGETHER
 * ---------------------------------------------------------------------------
 * They are the four things a producer does that are not the rodeo. Stalls and
 * RV spots are their own income; notices are how anybody finds out anything;
 * a release is what stands between them and a claim; and in January somebody
 * has to add up what was paid to whom. None of it is competition, all of it is
 * the business, and until now the OS did the competition and left the business
 * on a clipboard.
 *
 * Same rules as every other repository here: RLS does the isolation, every
 * value is bound through a tagged template, and anything with a rule behind it
 * goes through a database function rather than being reimplemented in TypeScript
 * where a second caller can get it wrong.
 */

import type { Json, Tx } from './client.ts';

// ===========================================================================
// Bookable resources
// ===========================================================================

export interface ResourceRow {
  id: string;
  org_id: string;
  rodeo_id: string | null;
  resource_type: string;
  name: string;
  description: string | null;
  capacity: number;
  price_cents: number;
  price_unit: string;
  is_active: boolean;
  sort_order: number;
}

export async function listResources(
  tx: Tx,
  orgId: string,
  rodeoId?: string | null,
): Promise<ResourceRow[]> {
  return tx<ResourceRow[]>`
    select id, org_id, rodeo_id, resource_type, name, description,
           capacity, price_cents, price_unit, is_active, sort_order
      from bookable_resources
     where org_id = ${orgId}
       and is_active
       ${
         rodeoId
           ? tx`and (rodeo_id is null or rodeo_id = ${rodeoId})`
           : tx``
       }
     order by sort_order, resource_type, name
  `;
}

export interface NewResource {
  rodeo_id?: string | null;
  resource_type: string;
  name: string;
  description?: string | null;
  capacity?: number;
  price_cents?: number;
  price_unit?: string;
  sort_order?: number;
}

export async function createResource(
  tx: Tx,
  orgId: string,
  input: NewResource,
): Promise<ResourceRow> {
  const [row] = await tx<ResourceRow[]>`
    insert into bookable_resources
      (org_id, rodeo_id, resource_type, name, description, capacity,
       price_cents, price_unit, sort_order)
    values (${orgId}, ${input.rodeo_id ?? null}, ${input.resource_type},
            ${input.name}, ${input.description ?? null},
            ${input.capacity ?? 1}, ${input.price_cents ?? 0},
            ${input.price_unit ?? 'per_stay'}, ${input.sort_order ?? 0})
    returning id, org_id, rodeo_id, resource_type, name, description,
              capacity, price_cents, price_unit, is_active, sort_order
  `;
  return row;
}

/**
 * What is left, by date range.
 *
 * A producer standing at the gate needs "how many RV spots for Friday to
 * Sunday", and the honest answer counts the live bookings that overlap those
 * dates rather than the ones that happen to start on Friday.
 */
export interface AvailabilityRow extends ResourceRow {
  taken: number;
  remaining: number;
}

export async function checkAvailability(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
  rodeoId?: string | null,
): Promise<AvailabilityRow[]> {
  return tx<AvailabilityRow[]>`
    select r.id, r.org_id, r.rodeo_id, r.resource_type, r.name, r.description,
           r.capacity, r.price_cents, r.price_unit, r.is_active, r.sort_order,
           coalesce(b.taken, 0)::int as taken,
           greatest(r.capacity - coalesce(b.taken, 0), 0)::int as remaining
      from bookable_resources r
      left join lateral (
            select sum(bk.quantity)::int as taken
              from bookings bk
             where bk.resource_id = r.id
               and bk.status in ('held', 'confirmed', 'completed')
               and bk.stay && daterange(${from}::date, ${to}::date, '[)')
           ) b on true
     where r.org_id = ${orgId}
       and r.is_active
       ${rodeoId ? tx`and (r.rodeo_id is null or r.rodeo_id = ${rodeoId})` : tx``}
     order by r.sort_order, r.resource_type, r.name
  `;
}

// ===========================================================================
// Bookings
// ===========================================================================

export interface BookingRow {
  id: string;
  org_id: string;
  resource_id: string;
  rodeo_id: string | null;
  user_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  stay: string;
  quantity: number;
  amount_cents: number;
  paid: boolean;
  status: string;
  hold_expires_at: string | null;
  notes: string | null;
}

export interface BookingInput {
  resource_id: string;
  from: string;
  to: string;
  quantity?: number;
  user_id?: string | null;
  contact_name?: string | null;
  rodeo_id?: string | null;
}

/**
 * Take a booking.
 *
 * Goes through `book_resource()` because capacity above one cannot be enforced
 * by the exclusion constraint — it has to be counted under a lock, and doing
 * that here in TypeScript would put the check outside the transaction that
 * needs it.
 */
export async function bookResource(
  tx: Tx,
  orgId: string,
  input: BookingInput,
): Promise<BookingRow> {
  const [row] = await tx<BookingRow[]>`
    select * from book_resource(
      ${orgId}, ${input.resource_id}, ${input.from}::date, ${input.to}::date,
      ${input.quantity ?? 1}, ${input.user_id ?? null},
      ${input.contact_name ?? null}, ${input.rodeo_id ?? null}
    )
  `;
  return row;
}

export interface BookingListRow extends BookingRow {
  resource_name: string;
  resource_type: string;
  arrival: string;
  departure: string;
  person_name: string | null;
}

export async function listBookings(
  tx: Tx,
  orgId: string,
  rodeoId?: string | null,
): Promise<BookingListRow[]> {
  return tx<BookingListRow[]>`
    select b.id, b.org_id, b.resource_id, b.rodeo_id, b.user_id,
           b.contact_name, b.contact_phone, b.stay::text as stay, b.quantity,
           b.amount_cents, b.paid, b.status, b.hold_expires_at::text as hold_expires_at,
           b.notes,
           r.name as resource_name, r.resource_type,
           lower(b.stay)::text as arrival, upper(b.stay)::text as departure,
           nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '')
             as person_name
      from bookings b
      join bookable_resources r on r.id = b.resource_id
      left join users u on u.id = b.user_id
     where b.org_id = ${orgId}
       ${rodeoId ? tx`and b.rodeo_id = ${rodeoId}` : tx``}
     order by lower(b.stay), r.name
  `;
}

/**
 * Confirm a hold, usually because it was paid for.
 *
 * The hold expiry is cleared at the same time. A confirmed booking that still
 * carries an expiry is the kind of row a cleanup job deletes at three in the
 * morning after somebody has already paid for it.
 */
export async function confirmBooking(
  tx: Tx,
  orgId: string,
  bookingId: string,
  paymentReference?: string | null,
): Promise<BookingRow | null> {
  const [row] = await tx<BookingRow[]>`
    update bookings
       set status = 'confirmed',
           paid = true,
           payment_reference = coalesce(${paymentReference ?? null}, payment_reference),
           hold_expires_at = null
     where org_id = ${orgId} and id = ${bookingId}
       and status in ('held', 'confirmed')
    returning id, org_id, resource_id, rodeo_id, user_id, contact_name,
              contact_phone, stay::text as stay, quantity, amount_cents, paid,
              status, hold_expires_at::text as hold_expires_at, notes
  `;
  return row ?? null;
}

export async function cancelBooking(
  tx: Tx,
  orgId: string,
  bookingId: string,
  reason: string,
  refundCents?: number | null,
): Promise<BookingRow | null> {
  const [row] = await tx<BookingRow[]>`
    update bookings
       set status = 'cancelled',
           cancelled_at = now(),
           cancel_reason = ${reason},
           refund_cents = ${refundCents ?? null}
     where org_id = ${orgId} and id = ${bookingId}
       and status <> 'cancelled'
    returning id, org_id, resource_id, rodeo_id, user_id, contact_name,
              contact_phone, stay::text as stay, quantity, amount_cents, paid,
              status, hold_expires_at::text as hold_expires_at, notes
  `;
  return row ?? null;
}

/**
 * Drop holds nobody paid for.
 *
 * Returns the rows it released so the caller can say what happened rather than
 * silently freeing a stall somebody thinks they have.
 */
export async function expireHolds(tx: Tx, orgId: string): Promise<BookingRow[]> {
  return tx<BookingRow[]>`
    update bookings
       set status = 'cancelled',
           cancelled_at = now(),
           cancel_reason = 'hold expired without payment'
     where org_id = ${orgId}
       and status = 'held'
       and not paid
       and hold_expires_at is not null
       and hold_expires_at < now()
    returning id, org_id, resource_id, rodeo_id, user_id, contact_name,
              contact_phone, stay::text as stay, quantity, amount_cents, paid,
              status, hold_expires_at::text as hold_expires_at, notes
  `;
}

// ===========================================================================
// Notices
// ===========================================================================

export interface NoticeRow {
  id: string;
  notice_type: string;
  user_id: string | null;
  rodeo_id: string | null;
  subject: string;
  body: string;
  channel: string;
  status: string;
  send_after: string;
  sent_at: string | null;
  created_at: string;
}

export async function queueNotice(
  tx: Tx,
  orgId: string,
  input: {
    notice_type: string;
    user_id: string;
    subject: string;
    body: string;
    rodeo_id?: string | null;
    channel?: string;
    payload?: Json;
    send_after?: string | null;
  },
): Promise<string> {
  const [{ queue_notice: id }] = await tx<{ queue_notice: string }[]>`
    select queue_notice(
      ${orgId}, ${input.notice_type}, ${input.user_id}, ${input.subject},
      ${input.body}, ${input.rodeo_id ?? null}, ${input.channel ?? 'in_app'},
      ${tx.json(input.payload ?? {})},
      coalesce(${input.send_after ?? null}::timestamptz, now())
    ) as queue_notice
  `;
  return id;
}

/** Tell everybody drawn into a rodeo that the draw is up. */
export async function notifyDrawPosted(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<number> {
  const [{ notify_draw_posted: count }] = await tx<{ notify_draw_posted: number }[]>`
    select notify_draw_posted(${orgId}, ${rodeoId}) as notify_draw_posted
  `;
  return count;
}

export async function listNotices(
  tx: Tx,
  orgId: string,
  rodeoId?: string | null,
  limit = 200,
): Promise<NoticeRow[]> {
  return tx<NoticeRow[]>`
    select id::text as id, notice_type, user_id, rodeo_id, subject, body,
           channel, status, send_after::text as send_after,
           sent_at::text as sent_at, created_at::text as created_at
      from notices
     where org_id = ${orgId}
       ${rodeoId ? tx`and rodeo_id = ${rodeoId}` : tx``}
     order by created_at desc
     limit ${limit}
  `;
}

/** A person's own inbox. Runs as them, so RLS is the whole filter. */
export async function listMyNotices(tx: Tx, limit = 100): Promise<NoticeRow[]> {
  return tx<NoticeRow[]>`
    select id::text as id, notice_type, user_id, rodeo_id, subject, body,
           channel, status, send_after::text as send_after,
           sent_at::text as sent_at, created_at::text as created_at
      from notices
     where user_id = app_current_user_id()
     order by created_at desc
     limit ${limit}
  `;
}

// ===========================================================================
// Waivers
// ===========================================================================

export interface WaiverTemplateRow {
  id: string;
  org_id: string | null;
  name: string;
  waiver_type: string;
  body_text: string;
  version: number;
  required_by: string[];
  applies_to_roles: string[];
  requires_notary: boolean;
  is_active: boolean;
}

export async function listWaiverTemplates(
  tx: Tx,
  orgId: string,
): Promise<WaiverTemplateRow[]> {
  return tx<WaiverTemplateRow[]>`
    select id, org_id, name, waiver_type, body_text, version, required_by,
           applies_to_roles, requires_notary, is_active
      from waiver_templates
     where (org_id = ${orgId} or org_id is null)
       and is_active
     order by org_id nulls last, waiver_type, name
  `;
}

export interface SignedWaiverRow {
  id: string;
  org_id: string;
  user_id: string;
  waiver_template_id: string;
  rodeo_id: string | null;
  waiver_text_hash: string;
  waiver_version: number;
  signature_method: string;
  typed_name: string | null;
  signed_at: string;
  record_hash: string;
  recorded_by: string | null;
}

export interface SignWaiverInput {
  template_id: string;
  user_id: string;
  method: string;
  typed_name?: string | null;
  rodeo_id?: string | null;
  signature_image_url?: string | null;
  guardian_user_id?: string | null;
  guardian_name?: string | null;
  ip?: string | null;
  user_agent?: string | null;
}

/**
 * Sign, or record a signature.
 *
 * Never computes a hash here. `sign_waiver()` reads the template text out of
 * the database and hashes that, because a hash produced on the signer's own
 * device proves only that the device can hash.
 */
export async function signWaiver(
  tx: Tx,
  orgId: string,
  input: SignWaiverInput,
): Promise<SignedWaiverRow> {
  const [row] = await tx<SignedWaiverRow[]>`
    select id, org_id, user_id, waiver_template_id, rodeo_id, waiver_text_hash,
           waiver_version, signature_method, typed_name,
           signed_at::text as signed_at, record_hash, recorded_by
      from sign_waiver(
        ${orgId}, ${input.template_id}, ${input.user_id}, ${input.method},
        ${input.typed_name ?? null}, ${input.rodeo_id ?? null},
        ${input.signature_image_url ?? null}, ${input.guardian_user_id ?? null},
        ${input.guardian_name ?? null}, ${input.ip ?? null}::inet,
        ${input.user_agent ?? null}
      )
  `;
  return row;
}

export interface WaiverVerification {
  signed_waiver_id: string;
  text_matches: boolean;
  record_matches: boolean;
  template_changed_since: boolean;
}

export async function verifySignedWaiver(
  tx: Tx,
  signedId: string,
): Promise<WaiverVerification> {
  const [row] = await tx<WaiverVerification[]>`
    select * from verify_signed_waiver(${signedId})
  `;
  return row;
}

export interface WaiverShortfallRow {
  contestant_id: string;
  first_name: string;
  last_name: string;
  template_id: string;
  template_name: string;
  waiver_type: string;
  signed: boolean;
  /** Null when nothing is on file. What `verify_signed_waiver()` needs. */
  signed_waiver_id: string | null;
  signed_at: string | null;
}

export async function waiverShortfall(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<WaiverShortfallRow[]> {
  return tx<WaiverShortfallRow[]>`
    select contestant_id, first_name, last_name, template_id, template_name,
           waiver_type, signed, signed_waiver_id, signed_at::text as signed_at
      from waiver_shortfall(${orgId}, ${rodeoId})
  `;
}

// ===========================================================================
// Year-end tax reporting
// ===========================================================================

export interface TaxSummaryRow {
  contestant_id: string;
  first_name: string;
  last_name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id_type: string | null;
  tax_id_last4: string | null;
  tax_id_verified: boolean;
  gross_cents: string;
  withholding_cents: string;
  net_cents: string;
  payment_count: number;
  form: string;
  threshold_cents: number;
  reportable: boolean;
  missing_tax_id: boolean;
}

export async function taxYearSummary(
  tx: Tx,
  orgId: string,
  year: number,
  country?: string | null,
): Promise<TaxSummaryRow[]> {
  return tx<TaxSummaryRow[]>`
    select contestant_id, first_name, last_name, address_line1, address_line2,
           city, state_province, postal_code, country, tax_id_type,
           tax_id_last4, tax_id_verified,
           gross_cents::text as gross_cents,
           withholding_cents::text as withholding_cents,
           net_cents::text as net_cents,
           payment_count, form, threshold_cents, reportable, missing_tax_id
      from tax_year_summary(${orgId}, ${year}, ${country ?? null})
  `;
}
