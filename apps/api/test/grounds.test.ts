/**
 * Integration tests for the grounds, the outbox, the releases and the
 * year-end report — against a real database with RLS on.
 *
 * Run AS REAL USERS. Three of the four things tested here were built because
 * a policy written against `org_members` denied the one person who needed the
 * row, and a test that runs as a superuser cannot see that class of fault at
 * all. So every assertion below goes through `db.asUser`, and the fixtures
 * deliberately include a contestant who has no login and no membership
 * anywhere — the person this schema exists to support and the person every
 * broken policy has excluded.
 *
 * Requires TEST_DATABASE_URL. Skipped when unset.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.ts';
import { Database, createSql, type VerifiedClaims } from '../src/core/database/client.ts';
import * as grounds from '../src/core/database/grounds-repo.ts';

const url = process.env.TEST_DATABASE_URL;

describe('grounds', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Database;

  const orgA = randomUUID();
  const orgB = randomUUID();
  const authA = randomUUID();
  const authB = randomUUID();
  const authRoper = randomUUID();
  const secA = randomUUID();
  const secB = randomUUID();

  /** Has a login and a membership. The easy case. */
  const roper = randomUUID();
  /**
   * Entered at the desk by the secretary. No supabase_auth_id, no org_members
   * row, no way to sign anything for himself. The case that broke D36, D40,
   * D42 and D43.
   */
  const walkup = randomUUID();

  const rodeoA = randomUUID();
  const rodeoB = randomUUID();
  const eventA = randomUUID();
  const stall = randomUUID();
  const camping = randomUUID();
  const tplA = randomUUID();
  const tplB = randomUUID();

  const claims = (sub: string): VerifiedClaims => ({ sub, role: 'authenticated' });
  const asSecA = () => claims(authA);
  const asSecB = () => claims(authB);
  const asRoper = () => claims(authRoper);

  before(async () => {
    db = new Database(createSql({ connectionString: url!, max: 5 }));

    await db.asService('grounds integration fixture', async (tx) => {
      await tx`
        insert into organizations (id, name, slug, type, country) values
          (${orgA}, 'Grounds A', ${'gr-a-' + orgA.slice(0, 8)}, 'producer', 'US'),
          (${orgB}, 'Grounds B', ${'gr-b-' + orgB.slice(0, 8)}, 'producer', 'US')
      `;
      await tx`
        insert into users (id, first_name, last_name, supabase_auth_id, country,
                           tax_id_type, tax_id_last4, tax_id_verified) values
          (${secA}, 'Sue', 'Secretary', ${authA}, 'US', null, null, false),
          (${secB}, 'Other', 'Secretary', ${authB}, 'US', null, null, false),
          (${roper}, 'Casey', 'Roper', ${authRoper}, 'US', 'ssn', '1234', true),
          (${walkup}, 'Dale', 'Walkup', null, 'US', null, null, false)
      `;
      await tx`
        insert into org_members (org_id, user_id, role, accepted_at) values
          (${orgA}, ${secA}, 'secretary', now()),
          (${orgB}, ${secB}, 'secretary', now()),
          (${orgA}, ${roper}, 'contestant', now())
      `;
      await tx`
        insert into rodeos (id, org_id, name, slug, start_date, end_date,
                            rodeo_type, status, venue_city, venue_state) values
          (${rodeoA}, ${orgA}, 'Grounds Rodeo', ${'gr-r-' + rodeoA.slice(0, 8)},
           '2026-09-10', '2026-09-12', 'jackpot', 'in_progress', 'Ada', 'OK'),
          (${rodeoB}, ${orgB}, 'Other Rodeo', ${'gr-o-' + rodeoB.slice(0, 8)},
           '2026-09-10', '2026-09-12', 'jackpot', 'in_progress', 'Ada', 'OK')
      `;
      await tx`
        insert into rodeo_events (id, org_id, rodeo_id, event_type, scoring_mode,
                                  entry_fee, added_money, sort_order)
        values (${eventA}, ${orgA}, ${rodeoA}, 'breakaway_roping', 'timed',
                50.00, 500.00, 1)
      `;
      // Both contestants are entered and drawn. The walk-up has no login.
      await tx`
        insert into entries (org_id, rodeo_id, rodeo_event_id, contestant_id,
                             status, draw_position, entry_fee_amount, fees_paid) values
          (${orgA}, ${rodeoA}, ${eventA}, ${roper}, 'confirmed', 1, 50.00, true),
          (${orgA}, ${rodeoA}, ${eventA}, ${walkup}, 'confirmed', 2, 50.00, true)
      `;
      await tx`
        insert into bookable_resources (id, org_id, rodeo_id, resource_type,
                                        name, capacity, price_cents, price_unit)
        values
          (${stall}, ${orgA}, ${rodeoA}, 'stall', 'Barn 3, Stall 14', 1, 3500, 'per_night'),
          (${camping}, ${orgA}, ${rodeoA}, 'camping', 'North field', 20, 2000, 'per_stay')
      `;
      await tx`
        insert into waiver_templates (id, org_id, name, waiver_type, body_text,
                                      version, applies_to_roles, is_active) values
          (${tplA}, ${orgA}, 'Release of Liability', 'liability_release',
           'I assume the risk of livestock.', 1, array['contestant'], true),
          (${tplB}, ${orgB}, 'Other Release', 'liability_release',
           'Some other text.', 1, array['contestant'], true)
      `;
    });
  });

  after(async () => {
    if (!db) return;
    await db.raw.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`delete from notices where org_id in (${orgA}, ${orgB})`;
      await tx`delete from bookings where org_id in (${orgA}, ${orgB})`;
      await tx`delete from bookable_resources where org_id in (${orgA}, ${orgB})`;
      await tx`delete from signed_waivers where org_id in (${orgA}, ${orgB})`;
      await tx`delete from waiver_templates where org_id in (${orgA}, ${orgB})`;
      await tx`delete from financial_transactions where org_id in (${orgA}, ${orgB})`;
      await tx`delete from entries where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeo_events where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeos where org_id in (${orgA}, ${orgB})`;
      await tx`delete from org_members where org_id in (${orgA}, ${orgB})`;
      await tx`delete from users where id in (${secA}, ${secB}, ${roper}, ${walkup})`;
      await tx`delete from organizations where id in (${orgA}, ${orgB})`;
    });
    await db.close();
  });

  // =======================================================================
  // Bookings
  // =======================================================================

  describe('bookings', () => {
    it('takes a booking and prices it by the night', async () => {
      const row = await db.asUser(asSecA(), (tx) =>
        grounds.bookResource(tx, orgA, {
          resource_id: stall,
          from: '2026-09-10',
          to: '2026-09-13',
          contact_name: 'Dale Walkup',
          rodeo_id: rodeoA,
        }),
      );
      assert.equal(row.status, 'held');
      // Three nights at $35. Priced from the resource, never from the client.
      assert.equal(row.amount_cents, 10500);
      assert.ok(row.hold_expires_at, 'an unpaid hold must expire');
    });

    it('refuses to double-book the same stall', async () => {
      await assert.rejects(
        () =>
          db.asUser(asSecA(), (tx) =>
            grounds.bookResource(tx, orgA, {
              resource_id: stall,
              // Overlaps the existing 10th–13th by one night.
              from: '2026-09-12',
              to: '2026-09-14',
              contact_name: 'Somebody Else',
            }),
          ),
        (err: { code?: string }) => err.code === '23P01',
        'the exclusion constraint, not application code, must be what stops this',
      );
    });

    it('allows a booking that starts the day the last one ends', async () => {
      // Half-open ranges: [10,13) and [13,15) do not overlap. A stall is free
      // the morning the previous horse leaves, and an inclusive range would
      // wrongly block it.
      const row = await db.asUser(asSecA(), (tx) =>
        grounds.bookResource(tx, orgA, {
          resource_id: stall,
          from: '2026-09-13',
          to: '2026-09-15',
          contact_name: 'Next Up',
        }),
      );
      assert.equal(row.status, 'held');
    });

    it('counts capacity above one instead of forbidding overlap', async () => {
      // Twenty spaces. Two overlapping bookings are fine.
      const a = await db.asUser(asSecA(), (tx) =>
        grounds.bookResource(tx, orgA, {
          resource_id: camping,
          from: '2026-09-10',
          to: '2026-09-13',
          quantity: 12,
          contact_name: 'Group A',
        }),
      );
      const b = await db.asUser(asSecA(), (tx) =>
        grounds.bookResource(tx, orgA, {
          resource_id: camping,
          from: '2026-09-11',
          to: '2026-09-12',
          quantity: 8,
          contact_name: 'Group B',
        }),
      );
      assert.equal(a.quantity, 12);
      assert.equal(b.quantity, 8);

      // The twenty-first space does not exist.
      await assert.rejects(
        () =>
          db.asUser(asSecA(), (tx) =>
            grounds.bookResource(tx, orgA, {
              resource_id: camping,
              from: '2026-09-11',
              to: '2026-09-12',
              quantity: 1,
              contact_name: 'One Too Many',
            }),
          ),
        /only 0 of 20 left/,
      );
    });

    it('reports remaining capacity for a date range', async () => {
      const rows = await db.asUser(asSecA(), (tx) =>
        grounds.checkAvailability(tx, orgA, '2026-09-11', '2026-09-12', rodeoA),
      );
      const field = rows.find((r) => r.id === camping);
      assert.ok(field);
      assert.equal(field.taken, 20);
      assert.equal(field.remaining, 0);

      // A range that touches neither booking is wide open again.
      const later = await db.asUser(asSecA(), (tx) =>
        grounds.checkAvailability(tx, orgA, '2026-10-01', '2026-10-02', rodeoA),
      );
      assert.equal(later.find((r) => r.id === camping)?.remaining, 20);
    });

    it('frees the dates when a booking is cancelled', async () => {
      const taken = await db.asUser(asSecA(), (tx) =>
        grounds.bookResource(tx, orgA, {
          resource_id: stall,
          from: '2026-10-01',
          to: '2026-10-03',
          contact_name: 'Cancels Later',
        }),
      );
      await db.asUser(asSecA(), (tx) =>
        grounds.cancelBooking(tx, orgA, taken.id, 'rig broke down'),
      );
      // Same dates, and the constraint no longer objects.
      const replacement = await db.asUser(asSecA(), (tx) =>
        grounds.bookResource(tx, orgA, {
          resource_id: stall,
          from: '2026-10-01',
          to: '2026-10-03',
          contact_name: 'Took The Spot',
        }),
      );
      assert.equal(replacement.status, 'held');
    });

    it('will not let another producer book or read these resources', async () => {
      await assert.rejects(
        () =>
          db.asUser(asSecB(), (tx) =>
            grounds.bookResource(tx, orgA, {
              resource_id: stall,
              from: '2026-11-01',
              to: '2026-11-02',
              contact_name: 'Trespasser',
            }),
          ),
        /not authorised/,
      );

      const theirs = await db.asUser(asSecB(), (tx) =>
        grounds.listBookings(tx, orgA),
      );
      assert.equal(theirs.length, 0, 'RLS, not the WHERE clause, hides these');
    });

    it('clears an expired hold and says which ones it released', async () => {
      const doomed = await db.asUser(asSecA(), (tx) =>
        grounds.bookResource(tx, orgA, {
          resource_id: stall,
          from: '2026-12-01',
          to: '2026-12-02',
          contact_name: 'Never Paid',
        }),
      );
      await db.asService('age the hold', (tx) => tx`
        update bookings set hold_expires_at = now() - interval '1 hour'
         where id = ${doomed.id}
      `);

      const released = await db.asUser(asSecA(), (tx) => grounds.expireHolds(tx, orgA));
      assert.ok(released.some((r) => r.id === doomed.id));

      // A confirmed booking is never swept up by the same run.
      const paid = await db.asUser(asSecA(), (tx) =>
        grounds.bookResource(tx, orgA, {
          resource_id: stall,
          from: '2026-12-05',
          to: '2026-12-06',
          contact_name: 'Paid Up',
        }),
      );
      await db.asUser(asSecA(), (tx) =>
        grounds.confirmBooking(tx, orgA, paid.id, 'cash'),
      );
      await db.asService('age the paid hold', (tx) => tx`
        update bookings set hold_expires_at = now() - interval '1 hour'
         where id = ${paid.id}
      `);
      const second = await db.asUser(asSecA(), (tx) => grounds.expireHolds(tx, orgA));
      assert.ok(
        !second.some((r) => r.id === paid.id),
        'a paid booking must survive the sweep',
      );
    });

    it('deletes a rodeo that has bookings without taking the bookings with it (D41)', async () => {
      // The bug: `on delete set null` with no column list nulls org_id too,
      // and org_id is NOT NULL, so the delete failed outright.
      const scratch = randomUUID();
      await db.asService('D41 fixture', async (tx) => {
        await tx`
          insert into rodeos (id, org_id, name, slug, start_date, end_date,
                              rodeo_type, status)
          values (${scratch}, ${orgA}, 'Deleted Rodeo',
                  ${'gr-d-' + scratch.slice(0, 8)}, '2027-01-01', '2027-01-02',
                  'jackpot', 'draft')
        `;
        await tx`
          insert into bookings (org_id, resource_id, rodeo_id, contact_name, stay)
          values (${orgA}, ${stall}, ${scratch}, 'Booked For It',
                  daterange('2027-01-01', '2027-01-03', '[)'))
        `;
        await tx`delete from rodeos where id = ${scratch}`;
      });

      const [{ n }] = await db.asService('D41 check', (tx) => tx<{ n: string }[]>`
        select count(*) as n from bookings
         where org_id = ${orgA} and contact_name = 'Booked For It' and rodeo_id is null
      `);
      assert.equal(n, '1', 'the booking survives with its tenant intact');
    });
  });

  // =======================================================================
  // Notices
  // =======================================================================

  describe('notices', () => {
    it('tells everybody drawn into a rodeo, once', async () => {
      const first = await db.asUser(asSecA(), (tx) =>
        grounds.notifyDrawPosted(tx, orgA, rodeoA),
      );
      assert.equal(first, 2, 'both entered contestants, login or not');

      // Idempotent. Running it again after a re-draw does not spam anybody.
      const second = await db.asUser(asSecA(), (tx) =>
        grounds.notifyDrawPosted(tx, orgA, rodeoA),
      );
      assert.equal(second, 0);
    });

    it('queues a notice for somebody who has no login at all', async () => {
      const id = await db.asUser(asSecA(), (tx) =>
        grounds.queueNotice(tx, orgA, {
          notice_type: 'entry_confirmed',
          user_id: walkup,
          subject: 'You are in',
          body: 'Breakaway, second out.',
          rodeo_id: rodeoA,
          payload: { rodeo_id: rodeoA },
        }),
      );
      assert.ok(id);
    });

    it('shows a contestant their own notices and nobody else theirs', async () => {
      const mine = await db.asUser(asRoper(), (tx) => grounds.listMyNotices(tx));
      assert.ok(mine.length >= 1);
      assert.ok(
        mine.every((n) => n.user_id === roper),
        'the inbox is filtered by RLS, not by the query',
      );
    });

    it('will not queue a notice for another producer', async () => {
      await assert.rejects(
        () =>
          db.asUser(asSecB(), (tx) =>
            grounds.queueNotice(tx, orgA, {
              notice_type: 'entry_confirmed',
              user_id: roper,
              subject: 'Not yours to send',
              body: 'nope',
            }),
          ),
        /not authorised/,
      );
    });
  });

  // =======================================================================
  // Waivers
  // =======================================================================

  describe('waivers', () => {
    let signedForRoper: string;
    let signedForWalkup: string;

    it('lets a contestant read the release they are being asked to sign (D42)', async () => {
      // The whole point. Casey is not a member of org A's staff; before 0027
      // this returned nothing and the signature would have been on a document
      // the signer could not see.
      const rows = await db.asUser(asRoper(), (tx) =>
        grounds.listWaiverTemplates(tx, orgA),
      );
      const mine = rows.find((r) => r.id === tplA);
      assert.ok(mine, 'the signer can read the document');
      assert.equal(mine.body_text, 'I assume the risk of livestock.');
    });

    it('does not show a contestant another producer\'s templates', async () => {
      const rows = await db.asUser(asRoper(), (tx) =>
        grounds.listWaiverTemplates(tx, orgB),
      );
      assert.ok(
        !rows.some((r) => r.id === tplB),
        'reading your own producer\'s release is not a key to everybody else\'s',
      );
    });

    it('signs for oneself and hashes the stored text, not a client value', async () => {
      const row = await db.asUser(asRoper(), (tx) =>
        grounds.signWaiver(tx, orgA, {
          template_id: tplA,
          user_id: roper,
          method: 'typed_name',
          typed_name: 'Casey Roper',
          rodeo_id: rodeoA,
        }),
      );
      signedForRoper = row.id;
      assert.equal(row.recorded_by, roper);
      assert.equal(row.waiver_version, 1);
      // SHA-256 of 'I assume the risk of livestock.'
      assert.match(row.waiver_text_hash, /^[0-9a-f]{64}$/);
      assert.match(row.record_hash, /^[0-9a-f]{64}$/);
      assert.notEqual(row.waiver_text_hash, row.record_hash);
    });

    it('records a paper release for a contestant with no login (D43)', async () => {
      const row = await db.asUser(asSecA(), (tx) =>
        grounds.signWaiver(tx, orgA, {
          template_id: tplA,
          user_id: walkup,
          method: 'paper_on_file',
          typed_name: 'Dale Walkup',
          rodeo_id: rodeoA,
        }),
      );
      signedForWalkup = row.id;
      assert.equal(row.user_id, walkup);
      assert.equal(
        row.recorded_by,
        secA,
        'the row must name the person who put it there, not the signer',
      );
      // The insert returned a row at all, which is the D40 lesson: INSERT ...
      // RETURNING applies the SELECT policy, so the recorder must be able to
      // read what they wrote.
      assert.ok(row.record_hash);
    });

    it('refuses to let staff click-to-sign on somebody else\'s behalf', async () => {
      await assert.rejects(
        () =>
          db.asUser(asSecA(), (tx) =>
            grounds.signWaiver(tx, orgA, {
              template_id: tplA,
              user_id: walkup,
              method: 'click_to_sign',
            }),
          ),
        /needs a name or a signature/,
      );
    });

    it('refuses a template belonging to another producer', async () => {
      await assert.rejects(
        () =>
          db.asUser(asSecA(), (tx) =>
            grounds.signWaiver(tx, orgA, {
              template_id: tplB,
              user_id: walkup,
              method: 'paper_on_file',
              typed_name: 'Dale Walkup',
            }),
          ),
        /belongs to another organisation/,
      );
    });

    it('refuses a stranger signing for a contestant', async () => {
      await assert.rejects(
        () =>
          db.asUser(asSecB(), (tx) =>
            grounds.signWaiver(tx, orgA, {
              template_id: tplA,
              user_id: roper,
              method: 'paper_on_file',
              typed_name: 'Casey Roper',
            }),
          ),
        /not authorised/,
      );
    });

    it('verifies the evidence it stored', async () => {
      const v = await db.asUser(asSecA(), (tx) =>
        grounds.verifySignedWaiver(tx, signedForRoper),
      );
      assert.equal(v.text_matches, true);
      assert.equal(v.record_matches, true);
      assert.equal(v.template_changed_since, false);
    });

    it('detects a document changed under a signature', async () => {
      // The producer quietly edits the release after it was signed. This is
      // the single scenario the hash columns exist for.
      await db.asService('tamper with a signed release', (tx) => tx`
        update waiver_templates
           set body_text = 'I assume the risk of livestock AND WAIVE EVERYTHING.'
         where id = ${tplA}
      `);
      const v = await db.asUser(asSecA(), (tx) =>
        grounds.verifySignedWaiver(tx, signedForRoper),
      );
      assert.equal(v.text_matches, false, 'the text no longer hashes to what was signed');
      assert.equal(v.record_matches, true, 'the signature record itself is untouched');
      assert.equal(
        v.template_changed_since,
        false,
        'and the version was NOT bumped — which is what makes it tampering '
          + 'rather than a reissue',
      );

      await db.asService('restore the tampered release', (tx) => tx`
        update waiver_templates
           set body_text = 'I assume the risk of livestock.'
         where id = ${tplA}
      `);
    });

    it('cannot be altered after the fact at all', async () => {
      // The first line of defence is that there is no second version of a
      // signed waiver: the table is append-only, so the obvious attack —
      // editing the name on a release somebody already signed — does not get
      // as far as the hash.
      await assert.rejects(
        () =>
          db.asService('attempt to edit a signed release', (tx) => tx`
            update signed_waivers set typed_name = 'Somebody Else'
             where id = ${signedForWalkup}
          `),
        /append-only/,
      );
    });

    it('detects a row forged around the append-only rule', async () => {
      // The hash is the second line of defence, and it covers the case the
      // first cannot: a row written straight into the table without going
      // through sign_waiver(), by something with database access. It looks
      // exactly like a real signature until the hash is recomputed.
      const forged = randomUUID();
      await db.asService('forge a signed release for the hash test', (tx) => tx`
        insert into signed_waivers
          (id, org_id, user_id, waiver_template_id, rodeo_id, waiver_text_hash,
           waiver_version, signature_method, typed_name, signed_at,
           record_hash, recorded_by)
        values (${forged}, ${orgA}, ${walkup}, ${tplA}, ${rodeoA},
                encode(digest('I assume the risk of livestock.', 'sha256'), 'hex'),
                1, 'typed_name', 'Dale Walkup', now(),
                'deadbeef', ${secA})
      `);

      const v = await db.asUser(asSecA(), (tx) =>
        grounds.verifySignedWaiver(tx, forged),
      );
      assert.equal(v.text_matches, true, 'the forger copied the text correctly');
      assert.equal(v.record_matches, false, 'and could not produce the record hash');

      // Superuser, not service_role: `session_replication_role` is what turns
      // the append-only trigger off, and only a superuser may set it. That is
      // the point — the application role cannot undo this even deliberately.
      await db.raw.begin(async (tx) => {
        await tx`set local session_replication_role = 'replica'`;
        await tx`delete from signed_waivers where id = ${forged}`;
      });
    });

    it('answers the morning-of question: who has not signed', async () => {
      const rows = await db.asUser(asSecA(), (tx) =>
        grounds.waiverShortfall(tx, orgA, rodeoA),
      );
      assert.equal(rows.length, 2, 'two contestants, one active release each');
      assert.ok(rows.every((r) => r.signed), 'both signed above');

      // A third contestant enters and has signed nothing.
      const late = randomUUID();
      await db.asService('late entry', async (tx) => {
        await tx`
          insert into users (id, first_name, last_name) values
            (${late}, 'Late', 'Entry')
        `;
        await tx`
          insert into entries (org_id, rodeo_id, rodeo_event_id, contestant_id,
                               status, entry_fee_amount)
          values (${orgA}, ${rodeoA}, ${eventA}, ${late}, 'confirmed', 50.00)
        `;
      });

      const after2 = await db.asUser(asSecA(), (tx) =>
        grounds.waiverShortfall(tx, orgA, rodeoA),
      );
      const missing = after2.filter((r) => !r.signed);
      assert.equal(missing.length, 1);
      assert.equal(missing[0].contestant_id, late);

      await db.raw.begin(async (tx) => {
        await tx`set local session_replication_role = 'replica'`;
        await tx`delete from entries where contestant_id = ${late}`;
        await tx`delete from users where id = ${late}`;
      });
    });

    it('hands back an id the evidence check can actually use', async () => {
      // 0027 built verify_signed_waiver() and 0027's shortfall returned only a
      // boolean, so the check could not be reached from the one screen that
      // lists signed releases. The id closes that loop, and this asserts the
      // round trip rather than the column's existence.
      const rows = await db.asUser(asSecA(), (tx) =>
        grounds.waiverShortfall(tx, orgA, rodeoA),
      );
      const onFile = rows.filter((r) => r.signed);
      assert.ok(onFile.length > 0);
      for (const r of onFile) {
        assert.ok(r.signed_waiver_id, 'a signed row must carry its id');
        assert.ok(r.signed_at, 'and when it was signed');
      }
      // Unsigned rows carry null, so `signed` and the id can never disagree.
      for (const r of rows.filter((x) => !x.signed)) {
        assert.equal(r.signed_waiver_id, null);
      }

      const v = await db.asUser(asSecA(), (tx) =>
        grounds.verifySignedWaiver(tx, onFile[0].signed_waiver_id!),
      );
      assert.equal(v.record_matches, true);
    });

    it('will not run the shortfall for another producer', async () => {
      await assert.rejects(
        () => db.asUser(asSecB(), (tx) => grounds.waiverShortfall(tx, orgA, rodeoA)),
        /not authorised/,
      );
    });
  });

  // =======================================================================
  // Year-end
  // =======================================================================

  describe('tax year summary', () => {
    before(async () => {
      // Two payouts to Casey and one to Dale, in 2026. Casey clears the 2026
      // threshold; Dale does not.
      await db.asService('payout fixture', (tx) => tx`
        insert into financial_transactions
          (org_id, rodeo_id, to_user_id, transaction_type, amount, status, created_at)
        values
          (${orgA}, ${rodeoA}, ${roper}, 'payout_prize', 1500.00, 'completed',
           '2026-09-12 20:00:00+00'),
          (${orgA}, ${rodeoA}, ${roper}, 'payout_day_money', 800.00, 'completed',
           '2026-09-11 20:00:00+00'),
          (${orgA}, ${rodeoA}, ${walkup}, 'payout_prize', 400.00, 'completed',
           '2026-09-12 20:00:00+00'),
          -- A different year, and an entry fee taken IN. Neither belongs in
          -- the 2026 report.
          (${orgA}, ${rodeoA}, ${roper}, 'payout_prize', 9999.00, 'completed',
           '2025-09-12 20:00:00+00')
      `);
    });

    it('totals what was paid, against the threshold for that year', async () => {
      const rows = await db.asUser(asSecA(), (tx) =>
        grounds.taxYearSummary(tx, orgA, 2026),
      );
      assert.equal(rows.length, 2);

      const casey = rows.find((r) => r.contestant_id === roper);
      assert.ok(casey);
      assert.equal(casey.gross_cents, '230000', '$1,500 + $800, and not last year\'s');
      assert.equal(casey.payment_count, 2);
      assert.equal(casey.form, '1099-NEC');
      // $2,000 — raised from $600 for payments made on or after 1 Jan 2026.
      assert.equal(casey.threshold_cents, 200000);
      assert.equal(casey.reportable, true);
      assert.equal(casey.missing_tax_id, false, 'Casey has a verified W-9');

      const dale = rows.find((r) => r.contestant_id === walkup);
      assert.ok(dale);
      assert.equal(dale.gross_cents, '40000');
      assert.equal(dale.reportable, false, '$400 is under the 2026 threshold');
      assert.equal(dale.missing_tax_id, false, 'not reportable, so nothing is missing');
    });

    it('applies the old threshold to the old year', async () => {
      const rows = await db.asUser(asSecA(), (tx) =>
        grounds.taxYearSummary(tx, orgA, 2025),
      );
      const casey = rows.find((r) => r.contestant_id === roper);
      assert.ok(casey);
      assert.equal(casey.threshold_cents, 60000, 'the $600 rule still governs 2025');
      assert.equal(casey.gross_cents, '999900');
    });

    it('flags somebody over the threshold with no W-9', async () => {
      await db.asService('big payout to the walk-up', (tx) => tx`
        insert into financial_transactions
          (org_id, rodeo_id, to_user_id, transaction_type, amount, status, created_at)
        values (${orgA}, ${rodeoA}, ${walkup}, 'payout_prize', 5000.00, 'completed',
                '2026-09-13 20:00:00+00')
      `);
      const rows = await db.asUser(asSecA(), (tx) =>
        grounds.taxYearSummary(tx, orgA, 2026),
      );
      const dale = rows.find((r) => r.contestant_id === walkup);
      assert.ok(dale);
      assert.equal(dale.reportable, true);
      assert.equal(
        dale.missing_tax_id,
        true,
        'the January phone call this report exists to generate',
      );
    });

    it('reports the gross, not the net, when tax was withheld', async () => {
      // A Canadian rodeo withholds 15% under Regulation 105. The T4A-NR states
      // the gross; reporting `amount` alone would understate it by exactly the
      // tax deducted.
      await db.asService('withheld payout', (tx) => tx`
        insert into financial_transactions
          (org_id, rodeo_id, to_user_id, transaction_type, amount, gross_amount,
           withholding_rule, withholding_rate, withholding_amount, status, created_at)
        values (${orgA}, ${rodeoA}, ${roper}, 'payout_prize', 850.00, 1000.00,
                'reg_105', 0.15, 150.00, 'completed', '2026-09-14 20:00:00+00')
      `);
      const rows = await db.asUser(asSecA(), (tx) =>
        grounds.taxYearSummary(tx, orgA, 2026),
      );
      const casey = rows.find((r) => r.contestant_id === roper);
      assert.ok(casey);
      assert.equal(casey.gross_cents, '330000', '$2,300 plus the $1,000 gross');
      assert.equal(casey.withholding_cents, '15000');
      assert.equal(casey.net_cents, '315000', '$2,300 plus the $850 actually paid');
    });

    it('will not show one producer another producer\'s payments', async () => {
      await assert.rejects(
        () => db.asUser(asSecB(), (tx) => grounds.taxYearSummary(tx, orgA, 2026)),
        /not authorised/,
      );
    });

    it('will not show a contestant the report', async () => {
      await assert.rejects(
        () => db.asUser(asRoper(), (tx) => grounds.taxYearSummary(tx, orgA, 2026)),
        /not authorised/,
      );
    });
  });

  // =======================================================================
  // HTTP status mapping
  //
  // These go through the real Fastify app rather than the repository, because
  // the thing being asserted is what the person at the desk SEES. Every rule
  // in this module lives in a SECURITY DEFINER function that raises with an
  // errcode; without the mapping in the routes module they all arrive as 500,
  // and the error handler replaces the message with "An unexpected error
  // occurred." A secretary told she may not click-to-sign on somebody else's
  // behalf can fix that in three seconds. A secretary told the server broke
  // rings somebody.
  // =======================================================================

  describe('http status mapping', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    const base = () => `/v1/orgs/${orgA}`;
    const headers = { authorization: 'Bearer test' };

    before(async () => {
      app = await buildApp({
        db,
        logger: false,
        verifier: {
          verify: async () => ({
            sub: authA,
            exp: 9e9,
            iat: 0,
            email: 'sue@example.com',
            app_metadata: {
              user_id: secA,
              org_memberships: [{ org_id: orgA, role: 'owner', permissions: [] }],
            },
          }),
        } as never,
      });
    });

    after(async () => {
      if (app) await app.close();
    });

    it('403 from the middleware when the caller is not in that org at all', async () => {
      // Never reaches the database. Worth pinning: it is the cheap check and
      // it must stay in front of the expensive one.
      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgB}/waivers/sign`,
        headers,
        payload: {
          template_id: tplB,
          user_id: roper,
          method: 'paper_on_file',
          typed_name: 'Casey Roper',
        },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(JSON.parse(res.body).error.code, 'NOT_A_MEMBER');
    });

    it('403, not 500, when the database is the one refusing', async () => {
      // The caller IS staff of org A and posts to org A, so the middleware
      // waves it through — and sign_waiver() raises 42501 because the template
      // belongs to somebody else. This is the path the mapping exists for.
      const res = await app.inject({
        method: 'POST',
        url: `${base()}/waivers/sign`,
        headers,
        payload: {
          template_id: tplB,
          user_id: roper,
          method: 'paper_on_file',
          typed_name: 'Casey Roper',
        },
      });
      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, 'FORBIDDEN');
      assert.match(body.error.message, /belongs to another organisation/);
    });

    it('404, not 500, when the thing does not exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${base()}/waivers/${randomUUID()}/verify`,
        headers,
      });
      assert.equal(res.statusCode, 404);
    });

    it('400 with the reason, not a generic 500, when a rule is broken', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${base()}/waivers/sign`,
        headers,
        payload: { template_id: tplA, user_id: walkup, method: 'click_to_sign' },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      // The function's own wording has to survive to the screen.
      assert.match(body.error.message, /needs a name or a signature/);
    });

    it('409 when the stall is already taken', async () => {
      const resource = randomUUID();
      await db.asService('status mapping fixture', (tx) => tx`
        insert into bookable_resources (id, org_id, resource_type, name, capacity)
        values (${resource}, ${orgA}, 'stall', 'Status Stall', 1)
      `);
      const take = () => app.inject({
        method: 'POST',
        url: `${base()}/bookings`,
        headers,
        payload: {
          resource_id: resource,
          from: '2027-03-01',
          to: '2027-03-04',
          contact_name: 'First',
        },
      });
      assert.equal((await take()).statusCode, 201);
      const second = await take();
      assert.equal(second.statusCode, 409);
      assert.equal(JSON.parse(second.body).error.code, 'ALREADY_BOOKED');
    });

    it('403 when a contestant asks for the year-end report', async () => {
      // requirePermission stops this before the database does — 'tax.report'
      // is owner and admin only, and a secretary is neither.
      const secretaryApp = await buildApp({
        db,
        logger: false,
        verifier: {
          verify: async () => ({
            sub: authA,
            exp: 9e9,
            iat: 0,
            app_metadata: {
              user_id: secA,
              org_memberships: [
                { org_id: orgA, role: 'secretary', permissions: [] },
              ],
            },
          }),
        } as never,
      });
      const res = await secretaryApp.inject({
        method: 'GET',
        url: `${base()}/tax-summary?year=2026`,
        headers,
      });
      assert.equal(res.statusCode, 403);
      await secretaryApp.close();
    });
  });
});
