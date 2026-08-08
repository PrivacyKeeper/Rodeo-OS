/**
 * Integration tests for corrections, results, stock and personnel.
 *
 * The correction tests are the ones that matter: the guarantee is not that a
 * score can be changed, it is that a change cannot be hidden. That is enforced
 * by a trigger, so it is asserted against the database rather than against the
 * function that is supposed to call it.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Database, createSql, type VerifiedClaims } from '../src/core/database/client.ts';
import * as ops from '../src/core/database/operations-repo.ts';
import {
  correctScore,
  disqualifyScore,
  loadScoreSheet,
  markReride,
} from '../src/core/database/repositories.ts';

const url = process.env.TEST_DATABASE_URL;

describe('arena operations', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Database;

  const org = randomUUID();
  const auth = randomUUID();
  const sec = randomUUID();
  const roper = randomUUID();
  const judge = randomUUID();
  const rodeo = randomUUID();
  const event = randomUUID();
  const entry = randomUUID();
  const score = randomUUID();

  const asSec = (): VerifiedClaims => ({ sub: auth, role: 'authenticated' });

  before(async () => {
    db = new Database(createSql({ connectionString: url!, max: 5 }));
    await db.asService('arena integration fixture', async (tx) => {
      await tx`insert into organizations (id, name, slug, type)
               values (${org}, 'Arena Co', ${'arena-' + org.slice(0, 8)}, 'producer')`;
      await tx`insert into users (id, first_name, last_name, supabase_auth_id) values
               (${sec}, 'Sam', 'Secretary', ${auth}),
               (${roper}, 'Rae', 'Runner', null),
               (${judge}, 'Jed', 'Judgely', null)`;
      await tx`insert into org_members (org_id, user_id, role, accepted_at)
               values (${org}, ${sec}, 'secretary', now())`;
      await tx`insert into rodeos (id, org_id, name, slug, start_date, end_date,
                                   rodeo_type, status)
               values (${rodeo}, ${org}, 'Arena Rodeo', ${'ar-' + rodeo.slice(0, 8)},
                       '2026-12-01', '2026-12-01', 'sanctioned', 'in_progress')`;
      await tx`insert into rodeo_sanctioning (org_id, rodeo_id, sanctioning_body,
                                              approval_status, association_id)
               select ${org}, ${rodeo}, 'PRCA', 'approved', id
                 from associations where code = 'PRCA' and org_id is null`;
      await tx`insert into rodeo_events (id, org_id, rodeo_id, event_type,
                                         scoring_mode, entry_fee, added_money)
               values (${event}, ${org}, ${rodeo}, 'barrel_racing', 'timed', 50, 500)`;
      await tx`insert into entries (id, org_id, rodeo_id, rodeo_event_id,
                                    contestant_id, status, entry_fee_amount, fees_paid)
               values (${entry}, ${org}, ${rodeo}, ${event}, ${roper},
                       'drawn', 50, true)`;
      await tx`insert into scores (id, org_id, rodeo_id, rodeo_event_id, entry_id,
                                   contestant_id, go_round, raw_time, final_time, status)
               values (${score}, ${org}, ${rodeo}, ${event}, ${entry}, ${roper},
                       1, 17.42, 17.42, 'official')`;
    });
  });

  after(async () => {
    if (!db) return;
    await db.raw.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`delete from career_runs where org_id = ${org}`;
      await tx`delete from rodeo_personnel where org_id = ${org}`;
      await tx`delete from credentials where user_id in (${judge}, ${roper})`;
      await tx`delete from stock_draws where org_id = ${org}`;
      await tx`delete from animals where org_id = ${org}`;
      await tx`delete from results where org_id = ${org}`;
      await tx`delete from scores where org_id = ${org}`;
      await tx`delete from entries where org_id = ${org}`;
      await tx`delete from rodeo_compliance_items where org_id = ${org}`;
      await tx`delete from rodeo_sanctioning where org_id = ${org}`;
      await tx`delete from rodeo_events where org_id = ${org}`;
      await tx`delete from rodeos where org_id = ${org}`;
      await tx`delete from org_members where org_id = ${org}`;
      await tx`delete from users where id in (${sec}, ${roper}, ${judge})`;
      await tx`delete from organizations where id = ${org}`;
    });
    await db.close();
  });

  describe('corrections', () => {
    it('changes the time and records the reason on the row', async () => {
      const out = await db.asUser(asSec(), (tx) =>
        correctScore(tx, org, score, sec, {
          final_time: 17.24,
          reason: "Judge's sheet reads 17.24",
        }),
      );
      assert.ok(out);

      const sheet = await db.asUser(asSec(), (tx) => loadScoreSheet(tx, org, event));
      const row = sheet.find((r) => r.score_id === score)!;
      assert.equal(Number(row.final_time), 17.24);
      assert.match(row.correction_reason ?? '', /17\.24/);
    });

    it('the old value survives in the history, with the reason', async () => {
      const sheet = await db.asUser(asSec(), (tx) => loadScoreSheet(tx, org, event));
      const history = sheet.find((r) => r.score_id === score)!.edit_history as {
        field: string; from: unknown; to: unknown; reason?: string;
      }[];
      const change = history.find((e) => e.field === 'final_time')!;
      assert.equal(Number(change.from), 17.42);
      assert.equal(Number(change.to), 17.24);
      assert.match(change.reason ?? '', /Judge/);
    });

    it('the history cannot be shortened, even by the service role', async () => {
      // The guarantee is not that our function keeps history — it is that the
      // database does, so a change made by going round the API is recorded too.
      await db.asService('arena test: try to erase the history', (tx) =>
        tx`update scores set edit_history = '[]'::jsonb, final_time = 15.00,
                             correction_reason = 'sneaky'
            where id = ${score}`,
      );
      const sheet = await db.asUser(asSec(), (tx) => loadScoreSheet(tx, org, event));
      const history = sheet.find((r) => r.score_id === score)!.edit_history as unknown[];
      assert.ok(
        history.length >= 2,
        'the trigger re-appended over the cleared array and kept the earlier entries',
      );
    });

    it('a DQ clears the time so it cannot re-enter the ranking', async () => {
      const out = await db.asUser(asSec(), (tx) =>
        disqualifyScore(tx, org, score, sec, 'Broke the barrier and missed the flag'),
      );
      assert.equal(out?.status, 'dq');
      const sheet = await db.asUser(asSec(), (tx) => loadScoreSheet(tx, org, event));
      const row = sheet.find((r) => r.score_id === score)!;
      assert.equal(row.final_time, null, 'a DQ has no placing time');
      assert.match(row.dq_reason ?? '', /barrier/);
    });

    it('a DQ is not correctable back into a live score by accident', async () => {
      const out = await db.asUser(asSec(), (tx) =>
        correctScore(tx, org, score, sec, { final_time: 17.24, reason: 'oops' }),
      );
      assert.equal(out, null, 'correctScore only touches provisional or official runs');
    });

    it('a re-ride frees the slot so the replacement can be scored', async () => {
      const second = randomUUID();
      await db.asService('arena test: a second run to re-ride', (tx) =>
        tx`insert into scores (id, org_id, rodeo_id, rodeo_event_id, entry_id,
                               contestant_id, go_round, raw_time, final_time, status)
           values (${second}, ${org}, ${rodeo}, ${event}, ${entry}, ${roper},
                   2, 18.10, 18.10, 'official')`,
      );

      // The unique index allows one live score per entry per round, so the
      // replacement cannot be written until the original is stood down.
      const out = await db.asUser(asSec(), (tx) =>
        markReride(tx, org, second, sec, 'Gate hung on the way in'),
      );
      assert.ok(out);

      await db.asService('arena test: score the re-ride', (tx) =>
        tx`insert into scores (org_id, rodeo_id, rodeo_event_id, entry_id,
                               contestant_id, go_round, raw_time, final_time, status)
           values (${org}, ${rodeo}, ${event}, ${entry}, ${roper},
                   2, 17.90, 17.90, 'official')`,
      );

      const sheet = await db.asUser(asSec(), (tx) => loadScoreSheet(tx, org, event));
      const round2 = sheet.filter((r) => r.go_round === 2);
      assert.equal(round2.length, 2, 'the original is kept as evidence');
      assert.equal(round2.filter((r) => r.status === 'official').length, 1);
    });
  });

  describe('results publication', () => {
    it('publishes a whole event at once', async () => {
      await db.asService('arena test: two provisional placings', (tx) =>
        tx`insert into results (org_id, rodeo_id, rodeo_event_id, contestant_id,
                                result_type, go_round, place, payout_amount, is_official)
           values (${org}, ${rodeo}, ${event}, ${roper}, 'go_round', 1, 1, 330.00, false),
                  (${org}, ${rodeo}, ${event}, ${judge}, 'go_round', 2, 2, 220.00, false)`,
      );

      const before = await db.asUser(asSec(), (tx) => ops.loadResults(tx, org, rodeo));
      assert.equal(before.filter((r) => r.is_official).length, 0);

      const changed = await db.asUser(asSec(), (tx) =>
        ops.setResultsOfficial(tx, org, event, true),
      );
      assert.equal(changed, 2, 'half a published event is worse than none');

      const after = await db.asUser(asSec(), (tx) => ops.loadResults(tx, org, rodeo));
      assert.ok(after.every((r) => r.is_official));
    });

    it('can be pulled back', async () => {
      await db.asUser(asSec(), (tx) => ops.setResultsOfficial(tx, org, event, false));
      const rows = await db.asUser(asSec(), (tx) => ops.loadResults(tx, org, rodeo));
      assert.ok(rows.every((r) => !r.is_official));
    });
  });

  describe('stock', () => {
    it('is added and can be taken out of the draw', async () => {
      const animal = await db.asUser(asSec(), (tx) =>
        ops.createAnimal(tx, org, { name: 'Night Crawler', animal_type: 'bull',
                                    brand_number: '214' }),
      );
      const listed = await db.asUser(asSec(), (tx) => ops.listAnimals(tx, org, rodeo));
      assert.ok(listed.some((a) => a.id === animal.id && a.health_status === 'active'));

      await db.asUser(asSec(), (tx) => ops.setAnimalHealth(tx, org, animal.id, 'injured'));
      const after = await db.asUser(asSec(), (tx) => ops.listAnimals(tx, org, rodeo));
      assert.equal(after.find((a) => a.id === animal.id)!.health_status, 'injured');
    });
  });

  describe('personnel', () => {
    it('assigns somebody and attaches their card automatically', async () => {
      // A secretary should not have to know a judge's card number, and a
      // shortfall that depends on somebody remembering to link it will always
      // say the rodeo is short.
      await db.asUser(asSec(), (tx) =>
        ops.addCredential(tx, judge, {
          body_code: 'PRCA', role: 'judge', card_number: 'J-99',
          issued_on: '2026-01-01', expires_on: '2026-12-31',
        }),
      );
      const cards = await db.asUser(asSec(), (tx) => ops.listCredentials(tx, judge));
      await db.asUser(asSec(), (tx) => ops.verifyCredential(tx, cards[0].id, sec));

      const row = await db.asUser(asSec(), (tx) =>
        ops.assignPersonnel(tx, org, rodeo, judge, 'judge', 25000),
      );
      assert.ok(row);
      assert.equal(row.carded, true);
      assert.equal(row.card_number, 'J-99');
    });

    it('an unverified card does not count towards the requirement', async () => {
      const other = randomUUID();
      await db.asService('arena test: an unverified judge', async (tx) => {
        await tx`insert into users (id, first_name, last_name)
                 values (${other}, 'Unver', 'Ified')`;
      });
      await db.asUser(asSec(), (tx) =>
        ops.addCredential(tx, other, { body_code: 'PRCA', role: 'judge', card_number: 'J-00' }),
      );
      const row = await db.asUser(asSec(), (tx) =>
        ops.assignPersonnel(tx, org, rodeo, other, 'judge', null),
      );
      assert.equal(row?.carded, false, 'anybody can type a number into a box');

      await db.raw.begin(async (tx) => {
        await tx`set local session_replication_role = 'replica'`;
        await tx`delete from rodeo_personnel where user_id = ${other}`;
        await tx`delete from credentials where user_id = ${other}`;
        await tx`delete from users where id = ${other}`;
      });
    });

    it('reports the shortfall PRCA actually requires', async () => {
      const out = await db.asUser(asSec(), (tx) => ops.loadBooks(tx, org, rodeo));
      const judgeShort = out!.personnel_shortfall.find((s) => s.role === 'judge');
      assert.ok(judgeShort, 'one carded judge assigned, PRCA wants two');
      assert.equal(judgeShort.required, 2);
      assert.equal(judgeShort.assigned, 1);
    });
  });
});
