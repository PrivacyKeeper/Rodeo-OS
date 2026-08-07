/**
 * Integration tests for the day sheet, the books, the sanction layer and the
 * global record — against a real database with RLS on.
 *
 * Run AS REAL USERS, like the rest of the integration suite. The record layer
 * in particular is the only part of this system whose tables are not
 * tenant-scoped, so "can tenant B read a contestant's runs from tenant A?" is
 * not a question application code can be trusted to answer. It is asked here,
 * as tenant B, with RLS deciding.
 *
 * Requires TEST_DATABASE_URL. Skipped when unset.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildDaySheet, checkBooks, renderDaySheetText, toCents } from '@rodeo-os/engine';

import { Database, createSql, type VerifiedClaims } from '../src/core/database/client.ts';
import * as ops from '../src/core/database/operations-repo.ts';

const url = process.env.TEST_DATABASE_URL;

describe('operations', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Database;

  const orgA = randomUUID();
  const orgB = randomUUID();
  const authA = randomUUID();
  const authB = randomUUID();
  const authRoper = randomUUID();
  const secA = randomUUID();
  const secB = randomUUID();
  const roper = randomUUID();
  const judge1 = randomUUID();

  // A sanctioned rodeo and an unsanctioned jackpot, because the most important
  // property of the sanction layer is what it does NOT do to a jackpot.
  const sanctioned = randomUUID();
  const jackpot = randomUUID();
  const evBarrels = randomUUID();
  const evJackpot = randomUUID();
  const entry1 = randomUUID();
  const entry2 = randomUUID();
  const horse = randomUUID();
  const perf1 = randomUUID();

  const claims = (sub: string): VerifiedClaims => ({ sub, role: 'authenticated' });
  const asSecA = () => claims(authA);
  const asSecB = () => claims(authB);
  const asRoper = () => claims(authRoper);

  before(async () => {
    db = new Database(createSql({ connectionString: url!, max: 5 }));

    await db.asService('operations integration fixture', async (tx) => {
      await tx`
        insert into organizations (id, name, slug, type) values
          (${orgA}, 'Ops A', ${'ops-a-' + orgA.slice(0, 8)}, 'producer'),
          (${orgB}, 'Ops B', ${'ops-b-' + orgB.slice(0, 8)}, 'producer')
      `;
      await tx`
        insert into users (id, first_name, last_name, supabase_auth_id) values
          (${secA}, 'Sue', 'Secretary', ${authA}),
          (${secB}, 'Other', 'Secretary', ${authB}),
          (${roper}, 'Casey', 'Barrelracer', ${authRoper}),
          (${judge1}, 'Hank', 'Judge', null)
      `;
      await tx`
        insert into org_members (org_id, user_id, role, accepted_at) values
          (${orgA}, ${secA}, 'secretary', now()),
          (${orgB}, ${secB}, 'secretary', now()),
          (${orgA}, ${roper}, 'contestant', now()),
          (${orgA}, ${judge1}, 'judge', now())
      `;
      await tx`
        insert into rodeos (id, org_id, name, slug, start_date, end_date,
                            rodeo_type, status, venue_city, venue_state) values
          (${sanctioned}, ${orgA}, 'Ops Sanctioned', ${'ops-s-' + sanctioned.slice(0, 8)},
           '2026-09-10', '2026-09-12', 'sanctioned', 'in_progress', 'Ada', 'OK'),
          (${jackpot}, ${orgA}, 'Tuesday Jackpot', ${'ops-j-' + jackpot.slice(0, 8)},
           '2026-09-15', '2026-09-15', 'jackpot', 'in_progress', 'Ada', 'OK')
      `;
      await tx`
        insert into performances (id, org_id, rodeo_id, performance_number, name,
                                  performance_type, scheduled_start, arena_dragged_after)
        values (${perf1}, ${orgA}, ${sanctioned}, 1, 'Friday Night', 'performance',
                '2026-09-11 19:00:00-06', 5)
      `;
      await tx`
        insert into rodeo_events (id, org_id, rodeo_id, event_type, scoring_mode,
                                  entry_fee, added_money, sort_order) values
          (${evBarrels}, ${orgA}, ${sanctioned}, 'barrel_racing', 'timed', 100.00, 1000.00, 1),
          (${evJackpot}, ${orgA}, ${jackpot}, 'breakaway_roping', 'timed', 50.00, 0, 1)
      `;
      await tx`
        insert into rodeo_sanctioning (org_id, rodeo_id, sanctioning_body,
                                       approval_status, association_id)
        select ${orgA}, ${sanctioned}, 'PRCA', 'approved', id
          from associations where code = 'PRCA' and org_id is null
      `;
      await tx`
        insert into animal_registry (id, barn_name, registered_name, animal_type)
        values (${horse}, 'Dash', 'Streakin Dash Ta Fame', 'horse')
      `;
      await tx`
        insert into entries (id, org_id, rodeo_id, rodeo_event_id, contestant_id,
                             status, draw_position, performance_number,
                             entry_fee_amount, fees_paid, horse_id) values
          (${entry1}, ${orgA}, ${sanctioned}, ${evBarrels}, ${roper},
           'confirmed', 2, 1, 100.00, true, ${horse}),
          (${entry2}, ${orgA}, ${sanctioned}, ${evBarrels}, ${judge1},
           'confirmed', 1, 1, 100.00, true, null)
      `;
      await tx`
        insert into rodeo_personnel (org_id, rodeo_id, user_id, role)
        values (${orgA}, ${sanctioned}, ${judge1}, 'judge')
      `;
    });
  });

  after(async () => {
    if (!db) return;
    await db.raw.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`delete from book_closures where org_id in (${orgA}, ${orgB})`;
      await tx`delete from career_runs where org_id in (${orgA}, ${orgB})`;
      await tx`delete from career_runs where contestant_id in (${roper}, ${judge1})`;
      await tx`delete from rodeo_compliance_items where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeo_personnel where org_id in (${orgA}, ${orgB})`;
      await tx`delete from credentials where user_id in (${judge1}, ${roper})`;
      await tx`delete from results where org_id in (${orgA}, ${orgB})`;
      await tx`delete from scores where org_id in (${orgA}, ${orgB})`;
      await tx`delete from entries where org_id in (${orgA}, ${orgB})`;
      await tx`delete from performances where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeo_sanctioning where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeo_events where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeos where org_id in (${orgA}, ${orgB})`;
      await tx`delete from animal_registry where id = ${horse}`;
      await tx`delete from org_members where org_id in (${orgA}, ${orgB})`;
      await tx`delete from users where id in (${secA}, ${secB}, ${roper}, ${judge1})`;
      await tx`delete from organizations where id in (${orgA}, ${orgB})`;
    });
    await db.close();
  });

  // =======================================================================
  // Day sheet
  // =======================================================================

  describe('day sheet', () => {
    it('loads a performance and orders it by the draw', async () => {
      const ctx = await db.asUser(asSecA(), (tx) =>
        ops.loadDaySheet(tx, orgA, sanctioned, 1),
      );
      assert.ok(ctx);
      const sheet = buildDaySheet({
        rodeo_id: ctx.rodeo.id,
        rodeo_name: ctx.rodeo.name,
        venue: ctx.rodeo.venue,
        sanctioned_by: ctx.sanctioned_by,
        performance: {
          id: '1',
          name: ctx.performance.name,
          type: ctx.performance.type,
          date: ctx.performance.date,
          arena_dragged_after: ctx.performance.arena_dragged_after,
        },
        events: ctx.events,
        entries: ctx.entries,
        stock: ctx.stock,
        personnel: ctx.personnel,
      });

      assert.equal(sheet.total_runs, 2);
      const names = sheet.sections[0].runs.map((r) => r.contestant_name);
      assert.deepEqual(names, ['Hank Judge', 'Casey Barrelracer']);
    });

    it('carries the horse through from the registry', async () => {
      const ctx = await db.asUser(asSecA(), (tx) =>
        ops.loadDaySheet(tx, orgA, sanctioned, 1),
      );
      const casey = ctx!.entries.find((e) => e.contestant_name === 'Casey Barrelracer');
      assert.equal(casey?.horse_name, 'Dash');
    });

    it('names the personnel and says whether they are carded', async () => {
      const ctx = await db.asUser(asSecA(), (tx) =>
        ops.loadDaySheet(tx, orgA, sanctioned, 1),
      );
      assert.equal(ctx!.personnel.length, 1);
      assert.equal(ctx!.personnel[0].role, 'judge');
      assert.equal(ctx!.personnel[0].carded, false, 'no credential attached yet');
    });

    it('renders printable text an arena office can use', async () => {
      const ctx = await db.asUser(asSecA(), (tx) =>
        ops.loadDaySheet(tx, orgA, sanctioned, 1),
      );
      const text = renderDaySheetText(
        buildDaySheet({
          rodeo_id: ctx!.rodeo.id,
          rodeo_name: ctx!.rodeo.name,
          performance: { id: '1', name: 'Friday Night', type: 'performance', date: '2026-09-11' },
          events: ctx!.events,
          entries: ctx!.entries,
        }),
      );
      assert.match(text, /OPS SANCTIONED/);
      assert.match(text, /Casey Barrelracer/);
    });

    it("another tenant's secretary sees no entries and no personnel", async () => {
      // A published rodeo and its event list ARE publicly readable — that is
      // the public schedule, by policy. What must never cross is who entered
      // and who is working it, and that is what this asserts. Written first as
      // "the whole thing comes back null", which was wrong about the policy
      // rather than wrong about the risk.
      const ctx = await db.asUser(asSecB(), (tx) =>
        ops.loadDaySheet(tx, orgA, sanctioned, 1),
      );
      assert.equal(ctx?.entries.length, 0, 'RLS refused the entries');
      assert.equal(ctx?.personnel.length, 0, 'and the personnel');
    });
  });

  // =======================================================================
  // The sanction layer
  // =======================================================================

  describe('sanction layer', () => {
    it('generates a checklist for a sanctioned rodeo', async () => {
      const items = await db.asUser(asSecA(), async (tx) => {
        await ops.generateCompliance(tx, orgA, sanctioned);
        return ops.loadCompliance(tx, orgA, sanctioned);
      });
      assert.ok(items.length >= 9);
      assert.equal(
        items.filter((i) => i.blocks_close).length,
        0,
        'a compliance calendar is a set of reminders, not a set of gates',
      );
    });

    it('is idempotent — a second body added in March does not duplicate', async () => {
      const before = await db.asUser(asSecA(), (tx) =>
        ops.loadCompliance(tx, orgA, sanctioned),
      );
      await db.asUser(asSecA(), (tx) => ops.generateCompliance(tx, orgA, sanctioned));
      const after = await db.asUser(asSecA(), (tx) =>
        ops.loadCompliance(tx, orgA, sanctioned),
      );
      assert.equal(after.length, before.length);
    });

    it('generates NOTHING for an unsanctioned jackpot', async () => {
      // The single most important property of this layer.
      const items = await db.asUser(asSecA(), async (tx) => {
        await ops.generateCompliance(tx, orgA, jackpot);
        return ops.loadCompliance(tx, orgA, jackpot);
      });
      assert.equal(items.length, 0);
    });

    it('reports the personnel shortfall against what the body requires', async () => {
      const ctx = await db.asUser(asSecA(), (tx) => ops.loadBooks(tx, orgA, sanctioned));
      const judge = ctx!.personnel_shortfall.find((s) => s.role === 'judge');
      assert.ok(judge, 'PRCA requires judges and only one is assigned');
      assert.equal(judge.required, 2);
      assert.equal(judge.assigned, 1);
    });

    it('a jackpot has no shortfall, because nothing requires anything', async () => {
      const ctx = await db.asUser(asSecA(), (tx) => ops.loadBooks(tx, orgA, jackpot));
      assert.equal(ctx!.personnel_shortfall.length, 0);
    });

    it('carries the association filing rule through to the books', async () => {
      const ctx = await db.asUser(asSecA(), (tx) => ops.loadBooks(tx, orgA, sanctioned));
      assert.equal(ctx!.association_code, 'PRCA');
      assert.equal(ctx!.filing.local_time, '23:59');
      assert.equal(ctx!.filing.timezone, 'America/Denver');
      assert.equal(
        ctx!.rules_verified,
        false,
        'the PRCA profile is seeded from secondary sources and must say so',
      );
    });

    it('an unsanctioned jackpot has no deadline and no deduction', async () => {
      const ctx = await db.asUser(asSecA(), (tx) => ops.loadBooks(tx, orgA, jackpot));
      assert.equal(ctx!.filing.local_time, null);
      assert.equal(ctx!.fee_schedule, null);
    });
  });

  // =======================================================================
  // Closing the books
  // =======================================================================

  describe('close the books', () => {
    it('blocks while a run has no score', async () => {
      const ctx = await db.asUser(asSecA(), (tx) => ops.loadBooks(tx, orgA, sanctioned));
      const status = checkBooks({ ...ctx!, now_ms: Date.parse('2026-09-12T20:00:00Z') });
      assert.equal(status.ready, false);
      assert.ok(status.blockers.some((b) => b.code === 'UNSCORED_RUN'));
      // And it names somebody, rather than saying "2 issues".
      assert.ok(status.blockers.some((b) => /Casey Barrelracer/.test(b.where)));
    });

    it('closes once the runs are scored and the placings are official', async () => {
      await db.asService('operations test: score and place the event', async (tx) => {
        await tx`
          insert into scores (org_id, rodeo_id, rodeo_event_id, entry_id,
                              contestant_id, go_round, raw_time, final_time, status)
          values
            (${orgA}, ${sanctioned}, ${evBarrels}, ${entry1}, ${roper}, 1, 17.42, 17.42, 'official'),
            (${orgA}, ${sanctioned}, ${evBarrels}, ${entry2}, ${judge1}, 1, 18.10, 18.10, 'official')
        `;
        // Purse: $1000 added + $200 entry fees = $1200 gross. PRCA takes 6%
        // ($72), leaving $1128 to disburse.
        await tx`
          insert into results (org_id, rodeo_id, rodeo_event_id, contestant_id,
                               result_type, go_round, place, payout_amount, is_official)
          values
            (${orgA}, ${sanctioned}, ${evBarrels}, ${roper}, 'go_round', 1, 1, 676.80, true),
            (${orgA}, ${sanctioned}, ${evBarrels}, ${judge1}, 'go_round', 1, 2, 451.20, true)
        `;
      });

      const ctx = await db.asUser(asSecA(), (tx) => ops.loadBooks(tx, orgA, sanctioned));
      const status = checkBooks({ ...ctx!, now_ms: Date.parse('2026-09-12T20:00:00Z') });

      assert.equal(
        status.ready,
        true,
        `blocked by: ${status.blockers.map((b) => `${b.code}@${b.where}`).join(', ')}`,
      );
      assert.equal(status.totals.gross_purse_cents, toCents(1200));
      assert.equal(status.totals.association_deduction_cents, toCents(72));
      assert.equal(status.totals.net_purse_cents, toCents(1128));
      assert.equal(status.totals.unpaid_purse_cents, 0);
    });

    it('paperwork warns but never blocks', async () => {
      // Nine compliance items are outstanding and the rodeo is a judge short.
      const ctx = await db.asUser(asSecA(), (tx) => ops.loadBooks(tx, orgA, sanctioned));
      const status = checkBooks({ ...ctx!, now_ms: Date.parse('2026-09-12T20:00:00Z') });
      assert.ok(status.warnings.length > 0);
      assert.equal(status.ready, true);
    });

    it('no seeded requirement blocks the close', async () => {
      // The first draft seeded 'results filed' as blocking, which deadlocked
      // the entire flow: the books could not close until the results were
      // filed, and the results could not be filed until the books closed. This
      // test is the one that found it, and it is here to stop it coming back.
      const ctx = await db.asUser(asSecA(), (tx) => ops.loadBooks(tx, orgA, sanctioned));
      assert.equal(
        ctx!.compliance.filter((c) => c.blocks_close).length,
        0,
        'nothing PRCA requires may stand between a secretary and filing',
      );
      const status = checkBooks({ ...ctx!, now_ms: Date.parse('2026-09-12T20:00:00Z') });
      assert.equal(status.blockers.length, 0);
    });

    it('closes, writes the career record, and marks the rodeo official', async () => {
      const closure = await db.asUser(asSecA(), async (tx) => {
        const ctx = await ops.loadBooks(tx, orgA, sanctioned);
        const status = checkBooks({ ...ctx!, now_ms: Date.parse('2026-09-12T20:00:00Z') });
        assert.equal(status.ready, true, JSON.stringify(status.blockers));
        return ops.closeBooks(
          tx,
          orgA,
          sanctioned,
          secA,
          status.totals as unknown as Record<string, number>,
          status.warnings,
          ctx!.association_code,
          status.deadline.due_at,
        );
      });

      assert.equal(closure.sequence, 1);
      assert.equal(closure.closure_type, 'closed');
      assert.equal(Number(closure.net_purse_cents), toCents(1128));
      assert.match(closure.totals_hash, /^[0-9a-f]{64}$/);

      const [rodeo] = await db.asUser(
        asSecA(),
        (tx) => tx<{ status: string }[]>`select status from rodeos where id = ${sanctioned}`,
      );
      assert.equal(rodeo.status, 'results_official');
    });

    it('the closure cannot be edited afterwards, even by the service role', async () => {
      // Two layers, and they fail differently. As a user the UPDATE matches no
      // rows at all, because book_closures has no UPDATE policy — the same
      // shape as delta D28, where a locking read returned nothing for exactly
      // this reason. That is silent, so it proves nothing about the trigger.
      const before = await db.asUser(
        asSecA(),
        (tx) => tx<{ paid_out_cents: string }[]>`
          select paid_out_cents::text as paid_out_cents from book_closures
           where rodeo_id = ${sanctioned} order by sequence limit 1`,
      );
      await db.asUser(
        asSecA(),
        (tx) => tx`update book_closures set paid_out_cents = 1 where rodeo_id = ${sanctioned}`,
      );
      const afterUser = await db.asUser(
        asSecA(),
        (tx) => tx<{ paid_out_cents: string }[]>`
          select paid_out_cents::text as paid_out_cents from book_closures
           where rodeo_id = ${sanctioned} order by sequence limit 1`,
      );
      assert.equal(afterUser[0].paid_out_cents, before[0].paid_out_cents);

      // The service role bypasses RLS, so this one actually reaches a row —
      // and the trigger stops it. That is the layer that matters, because it
      // is the one an application bug would otherwise walk straight through.
      await assert.rejects(
        () =>
          db.asService(
            'operations test: prove the closure trigger binds the service role',
            (tx) => tx`update book_closures set paid_out_cents = 1 where rodeo_id = ${sanctioned}`,
          ),
        /append-only/i,
      );
    });

    it('files, and then reopens with a reason on the record', async () => {
      const filed = await db.asUser(asSecA(), (tx) =>
        ops.fileBooks(tx, orgA, sanctioned, secA, 'PRCA-2026-0091', false, null),
      );
      assert.equal(filed.closure_type, 'filed');
      assert.equal(filed.filing_reference, 'PRCA-2026-0091');

      const reopened = await db.asUser(asSecA(), (tx) =>
        ops.reopenBooks(tx, orgA, sanctioned, secA, 'Judge sheet shows 17.24, not 17.42'),
      );
      assert.equal(reopened.closure_type, 'reopened');
      assert.equal(reopened.sequence, 3);

      const state = await db.asUser(asSecA(), (tx) =>
        ops.loadBookState(tx, orgA, sanctioned),
      );
      assert.equal(state?.state, 'reopened');
    });

    it("another tenant's secretary cannot close somebody else's books", async () => {
      await assert.rejects(
        () => db.asUser(asSecB(), (tx) => ops.closeBooks(tx, orgA, jackpot, secB, {}, [], null, null)),
        /not authorised/i,
      );
    });
  });

  // =======================================================================
  // The record layer — the part with no tenant scoping
  // =======================================================================

  describe('the record', () => {
    it('a contestant reads their own career', async () => {
      const runs = await db.asUser(asRoper(), (tx) => ops.loadCareer(tx, roper));
      assert.equal(runs.length, 1);
      assert.equal(runs[0].place, 1);
      assert.equal(Number(runs[0].earnings_cents), toCents(676.8));
      assert.equal(runs[0].source, 'platform');
      assert.equal(runs[0].is_verified, true);
    });

    it('the horse came with it', async () => {
      const runs = await db.asUser(asRoper(), (tx) => ops.loadCareer(tx, roper));
      assert.equal(runs[0].animal_name, 'Dash');
    });

    it("another tenant's staff cannot read that career", async () => {
      // The one question application code must not be trusted to answer.
      const runs = await db.asUser(asSecB(), (tx) => ops.loadCareer(tx, roper));
      assert.equal(runs.length, 0, 'RLS refused, not a WHERE clause');
    });

    it('the recording org can see what happened at its own rodeo', async () => {
      const runs = await db.asUser(asSecA(), (tx) => ops.loadCareer(tx, roper));
      assert.equal(runs.length, 1);
    });

    it('the horse has a career of its own', async () => {
      const career = await db.asUser(asSecA(), (tx) => ops.animalCareer(tx, horse));
      assert.ok(career);
      assert.equal(career.barn_name, 'Dash');
      assert.equal(career.runs, 1);
      assert.equal(career.wins, 1);
      assert.equal(Number(career.earnings_cents), toCents(676.8));
    });

    it('the registry is searchable by barn name and by papers', async () => {
      const byBarn = await db.asUser(asSecA(), (tx) => ops.searchRegistry(tx, 'dash', 'horse'));
      assert.ok(byBarn.some((r) => r.id === horse));
      const byPapers = await db.asUser(asSecA(), (tx) =>
        ops.searchRegistry(tx, 'streakin', null),
      );
      assert.ok(byPapers.some((r) => r.id === horse));
    });

    it('re-closing updates the record in place rather than duplicating it', async () => {
      await db.asUser(asSecA(), async (tx) => {
        const ctx = await ops.loadBooks(tx, orgA, sanctioned);
        const status = checkBooks({ ...ctx!, now_ms: Date.parse('2026-09-12T20:00:00Z') });
        await ops.closeBooks(
          tx,
          orgA,
          sanctioned,
          secA,
          status.totals as unknown as Record<string, number>,
          [],
          ctx!.association_code,
          null,
        );
      });
      const runs = await db.asUser(asRoper(), (tx) => ops.loadCareer(tx, roper));
      assert.equal(runs.length, 1, 'a correction re-files, it does not double-count');
    });
  });

  // =======================================================================
  // Setting up a rodeo — the path the secretary interface actually takes
  // =======================================================================

  describe('rodeo setup', () => {
    let created: Awaited<ReturnType<typeof ops.createRodeo>>;

    it('creates a jackpot in one call, with rules attached', async () => {
      created = await db.asUser(asSecA(), (tx) =>
        ops.createRodeo(tx, orgA, {
          name: 'Wizard Jackpot',
          slug: 'wizard-jackpot-' + orgA.slice(0, 6),
          rodeo_type: 'jackpot',
          start_date: '2026-10-06',
          end_date: '2026-10-06',
          venue_city: 'Ada',
          venue_state: 'OK',
          events: [
            { event_type: 'breakaway_roping', scoring_mode: 'timed', entry_fee: 50 },
            { event_type: 'barrel_racing', scoring_mode: 'timed', entry_fee: 50 },
          ],
        }),
      );
      assert.equal(created.events.length, 2);
      assert.equal(created.compliance_items, 0, 'a jackpot is asked nothing');
    });

    it('attaches a scoring config, so the first score is not rejected', async () => {
      // A rodeo you can create but cannot score is worse than no wizard. The
      // scoring route requires scoring_config_id, and the setup screen does
      // not ask for one — so the repository has to resolve it.
      const rows = await db.asUser(
        asSecA(),
        (tx) => tx<{ scoring_config_id: string | null; payout_config_id: string | null }[]>`
          select scoring_config_id, payout_config_id from rodeo_events
           where rodeo_id = ${created.id}`,
      );
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.ok(row.scoring_config_id, 'every event needs a rule set');
        assert.ok(row.payout_config_id, 'and a payout ladder');
      }
    });

    it('never crosses event types when it picks a default rule set', async () => {
      // A bareback config applied to barrel racing would score every run wrong
      // and look like it worked.
      const rows = await db.asUser(
        asSecA(),
        (tx) => tx<{ event_type: string; cfg_event: string | null }[]>`
          select e.event_type, c.event_type as cfg_event
            from rodeo_events e
            join scoring_configs c on c.id = e.scoring_config_id
           where e.rodeo_id = ${created.id}`,
      );
      for (const row of rows) {
        assert.equal(row.cfg_event, row.event_type);
      }
    });

    it('a sanctioned rodeo comes out of the same call with its calendar', async () => {
      const s = await db.asUser(asSecA(), (tx) =>
        ops.createRodeo(tx, orgA, {
          name: 'Wizard Sanctioned',
          slug: 'wizard-sanc-' + orgA.slice(0, 6),
          rodeo_type: 'sanctioned',
          start_date: '2026-10-20',
          end_date: '2026-10-22',
          sanctioning: ['PRCA'],
          events: [{ event_type: 'bareback', scoring_mode: 'judged', is_roughstock: true }],
        }),
      );
      assert.ok(s.compliance_items >= 9, 'the association brought its own calendar');
    });

    it('lists what the secretary needs to see on the home screen', async () => {
      const rows = await db.asUser(asSecA(), (tx) => ops.listRodeos(tx, orgA));
      const jack = rows.find((r) => r.id === created.id)!;
      assert.equal(jack.event_count, 2);
      assert.equal(jack.sanctioned_by.length, 0);
      const sanc = rows.find((r) => r.name === 'Wizard Sanctioned')!;
      assert.deepEqual([...sanc.sanctioned_by], ['PRCA']);
    });

    it("cannot create a rodeo in somebody else's organisation", async () => {
      await assert.rejects(() =>
        db.asUser(asSecB(), (tx) =>
          ops.createRodeo(tx, orgA, {
            name: 'Trespass',
            slug: 'trespass-' + orgA.slice(0, 6),
            rodeo_type: 'jackpot',
            start_date: '2026-10-06',
            end_date: '2026-10-06',
            events: [{ event_type: 'barrel_racing', scoring_mode: 'timed' }],
          }),
        ),
      );
    });
  });

  // =======================================================================
  // Associations
  // =======================================================================

  describe('associations', () => {
    it('are readable as reference data and say what is unverified', async () => {
      const rows = await db.asUser(asSecA(), (tx) => ops.loadAssociations(tx, orgA));
      const prca = rows.find((r) => r.code === 'PRCA');
      assert.ok(prca);
      assert.equal(prca.is_verified, false);
      assert.match(prca.verified_against ?? '', /NOT checked against the PRCA rule book/i);
      assert.equal(prca.mandates_own_system, true);
      assert.match(prca.system_carve_out ?? '', /another system/i);
    });

    it('the open profile asks nothing of anybody', async () => {
      const rows = await db.asUser(asSecA(), (tx) => ops.loadAssociations(tx, orgA));
      const open = rows.find((r) => r.code === 'OPEN')!;
      assert.equal((open.required_credentials as unknown[]).length, 0);
      assert.equal(open.results_due_local_time, null);
    });
  });
});
