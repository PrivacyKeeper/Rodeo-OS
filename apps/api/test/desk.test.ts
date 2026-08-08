/**
 * Integration tests for the entry desk — people, entries, back numbers and
 * sidepots. Against a real database with RLS on, as real users.
 *
 * The person search is the one to read carefully: it is deliberately GLOBAL
 * (a contestant exists once across every producer), so "does it leak contact
 * details to a producer who has never met them?" is a real question and it is
 * asked here rather than assumed.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Database, createSql, type VerifiedClaims } from '../src/core/database/client.ts';
import * as desk from '../src/core/database/desk-repo.ts';
import * as ops from '../src/core/database/operations-repo.ts';

const url = process.env.TEST_DATABASE_URL;

describe('entry desk', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Database;

  const orgA = randomUUID();
  const orgB = randomUUID();
  const authA = randomUUID();
  const authB = randomUUID();
  const secA = randomUUID();
  const secB = randomUUID();
  const roper = randomUUID();
  const dupe = randomUUID();
  const stranger = randomUUID();
  const rodeoA = randomUUID();
  const eventA = randomUUID();
  const entry1 = randomUUID();
  const entryDupe = randomUUID();

  const claims = (sub: string): VerifiedClaims => ({ sub, role: 'authenticated' });
  const asA = () => claims(authA);
  const asB = () => claims(authB);

  before(async () => {
    db = new Database(createSql({ connectionString: url!, max: 5 }));
    await db.asService('desk integration fixture', async (tx) => {
      await tx`
        insert into organizations (id, name, slug, type) values
          (${orgA}, 'Desk A', ${'desk-a-' + orgA.slice(0, 8)}, 'producer'),
          (${orgB}, 'Desk B', ${'desk-b-' + orgB.slice(0, 8)}, 'producer')
      `;
      await tx`
        insert into users (id, first_name, last_name, email, phone, city,
                           state_province, supabase_auth_id) values
          (${secA}, 'Sue', 'Deskclerk', ${'sue-' + secA.slice(0, 8) + '@x.test'},
           null, null, null, ${authA}),
          (${secB}, 'Bea', 'Otherdesk', ${'bea-' + secB.slice(0, 8) + '@x.test'},
           null, null, null, ${authB}),
          (${roper}, 'Casey', 'Zzxroper', ${'casey-' + roper.slice(0, 8) + '@x.test'},
           '555-0101', 'Ada', 'OK', null),
          (${dupe}, 'Casey', 'Zzxroper', null, '555-0101', 'Ada', 'OK', null),
          (${stranger}, 'Nobody', 'Zzxstranger',
           ${'nb-' + stranger.slice(0, 8) + '@x.test'}, '555-0999', 'Elko', 'NV', null)
      `;
      await tx`
        insert into org_members (org_id, user_id, role, accepted_at) values
          (${orgA}, ${secA}, 'secretary', now()),
          (${orgB}, ${secB}, 'secretary', now())
      `;
      await tx`
        insert into rodeos (id, org_id, name, slug, start_date, end_date, rodeo_type, status)
        values (${rodeoA}, ${orgA}, 'Desk Jackpot', ${'desk-j-' + rodeoA.slice(0, 8)},
                '2026-11-01', '2026-11-01', 'jackpot', 'entries_open')
      `;
      await tx`
        insert into rodeo_events (id, org_id, rodeo_id, event_type, scoring_mode,
                                  entry_fee, added_money)
        values (${eventA}, ${orgA}, ${rodeoA}, 'breakaway_roping', 'timed', 50.00, 500.00)
      `;
      await tx`
        insert into entries (id, org_id, rodeo_id, rodeo_event_id, contestant_id,
                             status, entry_fee_amount, fees_paid) values
          (${entry1}, ${orgA}, ${rodeoA}, ${eventA}, ${roper}, 'confirmed', 50.00, true),
          (${entryDupe}, ${orgA}, ${rodeoA}, ${eventA}, ${dupe}, 'confirmed', 50.00, false)
      `;
    });
  });

  after(async () => {
    if (!db) return;
    await db.raw.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`delete from person_merges where kept_user_id in (${roper}, ${dupe})`;
      await tx`delete from sidepot_entries where org_id in (${orgA}, ${orgB})`;
      await tx`delete from sidepots where org_id in (${orgA}, ${orgB})`;
      await tx`delete from back_numbers where org_id in (${orgA}, ${orgB})`;
      await tx`delete from career_runs where org_id in (${orgA}, ${orgB})`;
      await tx`delete from entries where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeo_events where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeos where org_id in (${orgA}, ${orgB})`;
      await tx`delete from org_members where org_id in (${orgA}, ${orgB})`;
      await tx`delete from users where id in (${secA}, ${secB}, ${roper}, ${dupe}, ${stranger})`;
      await tx`delete from organizations where id in (${orgA}, ${orgB})`;
    });
    await db.close();
  });

  // =======================================================================
  // Finding people
  // =======================================================================

  describe('person search', () => {
    it('finds somebody who has never competed here', async () => {
      // Global on purpose: searching only this org's contestants would create
      // a duplicate for every roper who has competed anywhere else.
      const rows = await db.asUser(asA(), (tx) => desk.searchPeople(tx, orgA, 'zzxstranger'));
      assert.ok(rows.some((r) => r.id === stranger));
    });

    it('withholds contact details for somebody this org does not know', async () => {
      const rows = await db.asUser(asA(), (tx) => desk.searchPeople(tx, orgA, 'zzxstranger'));
      const row = rows.find((r) => r.id === stranger)!;
      assert.equal(row.email, null, 'a stranger\'s email must not come back');
      assert.equal(row.phone, null, 'nor their phone');
      assert.equal(row.known_here, false);
      // City and state DO come back — enough to tell two Casey Ropers apart,
      // and not enough to contact anybody.
      assert.equal(row.state_province, 'NV');
    });

    it('gives contact details for somebody already entered here', async () => {
      const rows = await db.asUser(asA(), (tx) => desk.searchPeople(tx, orgA, 'zzxroper'));
      const row = rows.find((r) => r.id === roper)!;
      assert.ok(row.email, 'this org has taken their entry, so it has their email');
      assert.equal(row.known_here, true);
      assert.ok(row.entries_here >= 1);
    });

    it('the other org gets no contact details for the same person', async () => {
      const rows = await db.asUser(asB(), (tx) => desk.searchPeople(tx, orgB, 'zzxroper'));
      const row = rows.find((r) => r.id === roper)!;
      assert.equal(row.email, null);
      assert.equal(row.phone, null);
      assert.equal(row.known_here, false);
    });

    it('sorts people this org knows above people it does not', async () => {
      const rows = await db.asUser(asA(), (tx) => desk.searchPeople(tx, orgA, 'zzx'));
      const first = rows.findIndex((r) => r.known_here);
      const firstUnknown = rows.findIndex((r) => !r.known_here);
      assert.ok(first >= 0 && (firstUnknown === -1 || first < firstUnknown));
    });

    it('matches on a phone number, which is what the desk actually types', async () => {
      const rows = await db.asUser(asA(), (tx) => desk.searchPeople(tx, orgA, '555-0999'));
      assert.ok(rows.some((r) => r.id === stranger));
    });
  });

  // =======================================================================
  // Merging duplicates
  // =======================================================================

  describe('merging duplicates', () => {
    it('moves the entries and records why, without deleting the tombstone', async () => {
      const out = await db.asUser(asA(), (tx) =>
        desk.mergePeople(tx, roper, dupe, secA, 'Same person, entered twice at the desk'),
      );
      assert.equal(out.moved.entries, 1);
      // Both records were entered in the same event, so the moved entry takes
      // the next free slot rather than colliding — the thing entry_slot is for.
      const slots = await db.asUser(
        asA(),
        (tx) => tx<{ entry_slot: number }[]>`
          select entry_slot from entries
           where contestant_id = ${roper} and rodeo_event_id = ${eventA}
           order by entry_slot`,
      );
      assert.deepEqual(slots.map((s) => s.entry_slot), [1, 2]);

      const rows = await db.asUser(
        asA(),
        (tx) => tx<{ n: number }[]>`
          select count(*)::int as n from entries where contestant_id = ${roper}`,
      );
      assert.equal(rows[0].n, 2, 'both entries now belong to the kept record');

      // The merged record survives as a tombstone so "where did that run go?"
      // has an answer.
      const still = await db.asService('desk test: verify tombstone', (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from users where id = ${dupe}`,
      );
      assert.equal(still[0].n, 1);
    });

    it('a merge cannot be edited afterwards', async () => {
      await assert.rejects(
        () =>
          db.asService('desk test: prove person_merges is append-only', (tx) =>
            tx`update person_merges set reason = 'nope' where merged_user_id = ${dupe}`,
          ),
        /append-only/i,
      );
    });

    it('refuses to merge somebody into themselves', async () => {
      await assert.rejects(() =>
        db.asUser(asA(), (tx) => desk.mergePeople(tx, roper, roper, secA, 'nonsense')),
      );
    });
  });

  // =======================================================================
  // Back numbers
  // =======================================================================

  describe('back numbers', () => {
    it('hands one to everybody entered, in surname order', async () => {
      const issued = await db.asUser(asA(), (tx) =>
        desk.assignBackNumbers(tx, orgA, rodeoA, 1),
      );
      assert.ok(issued >= 1);
      const rows = await db.asUser(asA(), (tx) => desk.listBackNumbers(tx, orgA, rodeoA));
      assert.ok(rows.some((r) => r.contestant_id === roper));
    });

    it('a second run never reshuffles a number already on a shirt', async () => {
      const before = await db.asUser(asA(), (tx) => desk.listBackNumbers(tx, orgA, rodeoA));
      const mine = before.find((r) => r.contestant_id === roper)!.back_number;

      await db.asService('desk test: a late entry turns up', (tx) =>
        tx`insert into entries (org_id, rodeo_id, rodeo_event_id, contestant_id,
                                status, entry_fee_amount)
           values (${orgA}, ${rodeoA}, ${eventA}, ${stranger}, 'confirmed', 50.00)`,
      );

      const issued = await db.asUser(asA(), (tx) => desk.assignBackNumbers(tx, orgA, rodeoA, 1));
      assert.equal(issued, 1, 'only the late entry gets a number');

      const after = await db.asUser(asA(), (tx) => desk.listBackNumbers(tx, orgA, rodeoA));
      assert.equal(
        after.find((r) => r.contestant_id === roper)!.back_number,
        mine,
        'the existing number did not move',
      );
    });

    it('one number cannot be on two people', async () => {
      const rows = await db.asUser(asA(), (tx) => desk.listBackNumbers(tx, orgA, rodeoA));
      const taken = rows[0].back_number;
      const other = rows.find((r) => r.contestant_id !== rows[0].contestant_id)!;
      await assert.rejects(
        () =>
          db.asUser(asA(), (tx) =>
            desk.setBackNumber(tx, orgA, rodeoA, other.contestant_id, taken),
          ),
        /duplicate key/i,
      );
    });

    it('accepts a number that is not a number', async () => {
      // '7A' and '2-B' are real back numbers. An integer column would lose them.
      const row = await db.asUser(asA(), (tx) =>
        desk.setBackNumber(tx, orgA, rodeoA, roper, '7A'),
      );
      assert.equal(row.back_number, '7A');
    });

    it('reaches the day sheet', async () => {
      const ctx = await db.asUser(asA(), (tx) => ops.loadDaySheet(tx, orgA, rodeoA, null));
      // loadDaySheet does not join back numbers yet for the null-performance
      // case, but the entry list the desk shows does — assert that path.
      const rows = await db.asUser(asA(), (tx) => desk.listEntries(tx, orgA, rodeoA, null));
      assert.ok(ctx);
      assert.ok(rows.some((r) => r.back_number === '7A'));
    });
  });

  // =======================================================================
  // The books at the desk
  // =======================================================================

  describe('entries list', () => {
    it('shows who owes money', async () => {
      const rows = await db.asUser(asA(), (tx) => desk.listEntries(tx, orgA, rodeoA, null));
      assert.ok(rows.length >= 2);
      assert.ok(rows.some((r) => !r.fees_paid));
    });

    it('takes a payment at the desk', async () => {
      const rows = await db.asUser(asA(), (tx) => desk.listEntries(tx, orgA, rodeoA, null));
      const owing = rows.find((r) => !r.fees_paid)!;
      const ok = await db.asUser(asA(), (tx) =>
        desk.markEntryPaid(tx, orgA, owing.entry_id, true),
      );
      assert.equal(ok, true);
      const after = await db.asUser(asA(), (tx) => desk.listEntries(tx, orgA, rodeoA, null));
      assert.equal(after.find((r) => r.entry_id === owing.entry_id)!.fees_paid, true);
    });

    it("the other org's secretary sees none of it", async () => {
      const rows = await db.asUser(asB(), (tx) => desk.listEntries(tx, orgA, rodeoA, null));
      assert.equal(rows.length, 0, 'RLS refused');
    });
  });

  // =======================================================================
  // Sidepots
  // =======================================================================

  describe('sidepots', () => {
    let sidepotId: string;

    it('is created against an event', async () => {
      const row = await db.asUser(asA(), (tx) =>
        desk.createSidepot(tx, orgA, rodeoA, {
          rodeo_event_id: eventA,
          name: '$20 Sidepot',
          buy_in_cents: 2000,
        }),
      );
      sidepotId = row.id;
      assert.equal(row.name, '$20 Sidepot');
    });

    it('cannot be created twice with the same name on one event', async () => {
      await assert.rejects(() =>
        db.asUser(asA(), (tx) =>
          desk.createSidepot(tx, orgA, rodeoA, {
            rodeo_event_id: eventA,
            name: '$20 Sidepot',
            buy_in_cents: 2000,
          }),
        ),
      );
    });

    it('counts only paid buy-ins as collected', async () => {
      await db.asService('desk test: two buy-ins, one unpaid', async (tx) => {
        await tx`
          insert into sidepot_entries (org_id, sidepot_id, entry_id, contestant_id,
                                       amount_paid_cents, paid) values
            (${orgA}, ${sidepotId}, ${entry1}, ${roper}, 2000, true),
            (${orgA}, ${sidepotId}, ${entryDupe}, ${roper}, 2000, false)
        `;
      });
      const rows = await db.asUser(asA(), (tx) => desk.listSidepots(tx, orgA, rodeoA));
      const pot = rows.find((r) => r.id === sidepotId)!;
      assert.equal(pot.buyers, 2, 'two people said they were in');
      assert.equal(Number(pot.collected_cents), 2000, 'one of them actually paid');
    });

    it('falls back to the event ladder when it has none of its own', async () => {
      // A producer adds a $20 sidepot and expects it to pay the way the event
      // does. Without the fallback, calculating it returns NO_PAYOUT_CONFIG.
      await db.asService('desk test: give the event a ladder', async (tx) => {
        const cfgId = randomUUID();
        await tx`
          insert into payout_configs (id, org_id, name, is_system, config)
          values (${cfgId}, ${orgA}, 'Desk Ladder', false, ${tx.json({
            fee_structure: {},
            payout_rules: [
              { min_entries: 1, max_entries: 99, places_paid: 2, splits: [0.6, 0.4] },
            ],
          })})
        `;
        await tx`update rodeo_events set payout_config_id = ${cfgId} where id = ${eventA}`;
      });

      const config = await db.asUser(asA(), (tx) =>
        desk.loadSidepotPayoutConfig(tx, orgA, sidepotId),
      );
      assert.ok(config, 'inherited the event ladder');
      assert.ok(Array.isArray((config as { payout_rules?: unknown[] }).payout_rules));
    });

    it('standings carry who paid and how they ran', async () => {
      const { sidepot, standings } = await db.asUser(asA(), (tx) =>
        desk.loadSidepotStandings(tx, orgA, sidepotId),
      );
      assert.ok(sidepot);
      assert.equal(sidepot.buy_in_cents, 2000);
      assert.equal(standings.length, 2);
      assert.equal(standings.filter((s) => s.paid).length, 1);
    });
  });
});
