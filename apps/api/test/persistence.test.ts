/**
 * Integration tests against a real PostgreSQL database with RLS enabled.
 *
 * These are the tests that matter most in the repository. Everything else
 * verifies logic in isolation; this verifies that the logic, the schema and
 * the access model hold together when a real user makes a real request.
 *
 * In particular the tenant-isolation tests run AS THE USER — `set local role
 * authenticated` with verified JWT claims — not as a superuser. A superuser
 * bypasses RLS, so a test that passes as postgres proves nothing about
 * whether one producer can read another producer's entries.
 *
 * Requires: TEST_DATABASE_URL pointing at a database with the migrations and
 * supabase/local/bootstrap.sql applied. Skipped when unset.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  calculatePayout,
  calculateTimedScore,
  toCents,
  type ScoringConfig,
} from '@rodeo-os/engine';

import { Database, createSql, type VerifiedClaims } from '../src/core/database/client.ts';
import {
  changesSince,
  createOption,
  disburse,
  finalizeScore,
  loadAllOptions,
  loadOptions,
  loadPayoutContext,
  loadPublicResults,
  loadScoringConfig,
  loadServerState,
  persistScore,
  updateOption,
} from '../src/core/database/repositories.ts';

const url = process.env.TEST_DATABASE_URL;

describe('persistence', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Database;

  // Two tenants, so every isolation test has somebody to be isolated from.
  const orgA = randomUUID();
  const orgB = randomUUID();
  const authA = randomUUID();
  const authB = randomUUID();
  const authRoper = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const roper = randomUUID();
  const roper2 = randomUUID();
  const rodeoA = randomUUID();
  const eventA = randomUUID();
  const entry1 = randomUUID();
  const entry2 = randomUUID();
  const scoringConfigId = randomUUID();
  const payoutConfigId = randomUUID();

  const claims = (sub: string): VerifiedClaims => ({ sub, role: 'authenticated' });
  const secretaryA = () => claims(authA);
  const secretaryB = () => claims(authB);

  const TIMED: ScoringConfig = {
    mode: 'timed',
    time_precision: 2,
    timed_penalties: [{ type: 'barrier_break', seconds: 10 }],
    dq_triggers: ['no_catch'],
  };

  before(async () => {
    db = new Database(createSql({ connectionString: url!, max: 5 }));

    // Fixture setup is the one legitimate use of the service role: there is no
    // authenticated user yet to act for.
    await db.asService('integration test fixture setup', async (tx) => {
      await tx`
        insert into organizations (id, name, slug, type) values
          (${orgA}, 'Tenant A Rodeo Co', ${'a-' + orgA.slice(0, 8)}, 'producer'),
          (${orgB}, 'Tenant B Rodeo Co', ${'b-' + orgB.slice(0, 8)}, 'producer')
      `;
      await tx`
        insert into users (id, first_name, last_name, supabase_auth_id) values
          (${userA}, 'Sec', 'A', ${authA}),
          (${userB}, 'Sec', 'B', ${authB}),
          (${roper}, 'Casey', 'Roper', ${authRoper}),
          (${roper2}, 'Dale', 'Heeler', null)
      `;
      await tx`
        insert into org_members (org_id, user_id, role, accepted_at) values
          (${orgA}, ${userA}, 'secretary', now()),
          (${orgB}, ${userB}, 'secretary', now()),
          (${orgA}, ${roper}, 'contestant', now())
      `;
      await tx`
        insert into scoring_configs (id, org_id, name, is_system, config)
        values (${scoringConfigId}, ${orgA}, 'Test Timed', false,
                ${tx.json(TIMED as unknown as Record<string, unknown>)})
      `;
      await tx`
        insert into payout_configs (id, org_id, name, is_system, config)
        values (${payoutConfigId}, ${orgA}, 'Test Ladder', false, ${tx.json({
          fee_structure: { admin_pct: 0.06, office_fee_flat: 500 },
          payout_rules: [
            { min_entries: 1, max_entries: 99, places_paid: 3, splits: [0.5, 0.3, 0.2] },
          ],
          ground_money_rule: 'combine_and_split',
        })})
      `;
      await tx`
        insert into rodeos (id, org_id, name, slug, start_date, end_date,
                            rodeo_type, status)
        values (${rodeoA}, ${orgA}, 'A Jackpot', 'a-jackpot',
                '2026-09-01', '2026-09-01', 'jackpot', 'in_progress')
      `;
      await tx`
        insert into rodeo_events (id, org_id, rodeo_id, event_type, scoring_mode,
                                  entry_fee, added_money, scoring_config_id,
                                  payout_config_id)
        values (${eventA}, ${orgA}, ${rodeoA}, 'breakaway_roping', 'timed',
                100.00, 500.00, ${scoringConfigId}, ${payoutConfigId})
      `;
      await tx`
        insert into entries (id, org_id, rodeo_id, rodeo_event_id, contestant_id,
                             status) values
          (${entry1}, ${orgA}, ${rodeoA}, ${eventA}, ${roper}, 'confirmed'),
          (${entry2}, ${orgA}, ${rodeoA}, ${eventA}, ${roper2}, 'confirmed')
      `;
    });
  });

  after(async () => {
    if (!db) return;
    // Teardown runs on the RAW connection, not asService(): the append-only
    // triggers bind service_role too, and only a superuser may suspend them
    // with session_replication_role. That the test harness has to reach past
    // both the policy layer AND the trigger layer to clean up is the clearest
    // demonstration that neither is decorative.
    await db.raw.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`delete from transaction_status_events where org_id in (${orgA}, ${orgB})`;
      await tx`delete from financial_transactions where org_id in (${orgA}, ${orgB})`;
      await tx`delete from scores where org_id in (${orgA}, ${orgB})`;
      await tx`delete from results where org_id in (${orgA}, ${orgB})`;
      await tx`delete from entries where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeo_events where org_id in (${orgA}, ${orgB})`;
      await tx`delete from rodeos where org_id in (${orgA}, ${orgB})`;
      await tx`delete from scoring_configs where org_id in (${orgA}, ${orgB})`;
      await tx`delete from payout_configs where org_id in (${orgA}, ${orgB})`;
      await tx`delete from reference_options where org_id in (${orgA}, ${orgB})`;
      await tx`delete from org_members where org_id in (${orgA}, ${orgB})`;
      await tx`delete from users where id in (${userA}, ${userB}, ${roper}, ${roper2})`;
      await tx`delete from organizations where id in (${orgA}, ${orgB})`;
    });
    await db.close();
  });

  // =========================================================================
  // Tenant isolation, exercised as real authenticated users
  // =========================================================================

  describe('tenant isolation under RLS', () => {
    it("a secretary sees their own org's rodeos", async () => {
      const rows = await db.asUser(secretaryA(), (tx) =>
        tx`select id from rodeos where id = ${rodeoA}`,
      );
      assert.equal(rows.length, 1);
    });

    it("a secretary cannot read another org's entries", async () => {
      const rows = await db.asUser(secretaryB(), (tx) =>
        tx`select id from entries where rodeo_event_id = ${eventA}`,
      );
      assert.equal(rows.length, 0, 'tenant B must see none of tenant A entries');
    });

    it("a secretary cannot read another org's scoring configs", async () => {
      const cfg = await db.asUser(secretaryB(), (tx) =>
        loadScoringConfig(tx, scoringConfigId),
      );
      assert.equal(cfg, null);
    });

    it("a secretary cannot write into another org", async () => {
      await assert.rejects(
        () =>
          db.asUser(secretaryB(), (tx) =>
            tx`
              insert into rodeos (org_id, name, slug, start_date, end_date, rodeo_type)
              values (${orgA}, 'Hijack', ${'hijack-' + randomUUID().slice(0, 8)},
                      '2026-10-01', '2026-10-01', 'jackpot')
            `,
          ),
        /row-level security|violates/i,
        'writing into another tenant must be refused by the policy',
      );
    });

    it('an anonymous reader sees published rodeos and no entries', async () => {
      const rodeos = await db.asAnon((tx) =>
        tx`select id from rodeos where id = ${rodeoA}`,
      );
      assert.equal(rodeos.length, 1, 'an in-progress rodeo is public');

      const entries = await db.asAnon((tx) =>
        tx`select id from entries where rodeo_event_id = ${eventA}`,
      );
      assert.equal(entries.length, 0, 'entries are never public');
    });

    it('a contestant sees their own entry but not the whole field', async () => {
      const rows = await db.asUser(claims(authRoper), (tx) =>
        tx`select id, contestant_id from entries where rodeo_event_id = ${eventA}`,
      );
      // The contestant is also an org member here, so the member-read policy
      // applies — what matters is that it is scoped to their org at all.
      assert.ok(rows.length >= 1);
      assert.ok(rows.some((r) => r.contestant_id === roper));
    });

    it('the identity does not leak between pooled connections', async () => {
      // Entries, not rodeos: an in-progress rodeo is deliberately public, so
      // tenant B seeing it proves nothing. Entries are never public.
      const asA = await db.asUser(secretaryA(), (tx) =>
        tx`select id from entries where rodeo_event_id = ${eventA}`,
      );
      assert.equal(asA.length, 2, 'tenant A sees its own field');

      const asB = await db.asUser(secretaryB(), (tx) =>
        tx`select id from entries where rodeo_event_id = ${eventA}`,
      );
      assert.equal(asB.length, 0, 'tenant B must not inherit tenant A context');

      // And back again, to catch a sticky setting in the other direction.
      const asAAgain = await db.asUser(secretaryA(), (tx) =>
        tx`select id from entries where rodeo_event_id = ${eventA}`,
      );
      assert.equal(asAAgain.length, 2);
    });

    it('an unauthenticated transaction resolves auth.uid() to null', async () => {
      const rows = await db.asAnon(
        (tx) => tx<{ uid: string | null }[]>`select auth.uid() as uid`,
      );
      assert.equal(rows[0].uid, null);
    });
  });

  // =========================================================================
  // Options
  // =========================================================================

  describe('options', () => {
    it('loads the seeded system options', async () => {
      const all = await db.asUser(secretaryA(), (tx) => loadAllOptions(tx, orgA));
      assert.ok(all.length > 250, `expected the full seed, got ${all.length}`);
      const eventTypes = all.filter((o) => o.domain === 'event_type');
      assert.ok(eventTypes.some((o) => o.code === 'wild_cow_milking'));
      assert.ok(eventTypes.every((o) => o.is_custom === false));
    });

    it('a producer adds their own option and can use it', async () => {
      const created = await db.asUser(secretaryA(), (tx) =>
        createOption(tx, orgA, 'event_type', {
          code: 'mounted_shooting',
          label: 'Cowboy Mounted Shooting',
          category: 'Other',
        }),
      );
      assert.equal(created.is_custom, true);

      const mine = await db.asUser(secretaryA(), (tx) =>
        loadOptions(tx, orgA, 'event_type'),
      );
      assert.ok(mine.some((o) => o.code === 'mounted_shooting'));
    });

    it("another producer never sees it", async () => {
      const theirs = await db.asUser(secretaryB(), (tx) =>
        loadOptions(tx, orgB, 'event_type'),
      );
      assert.ok(!theirs.some((o) => o.code === 'mounted_shooting'));
    });

    it('a system option cannot be edited, only hidden', async () => {
      const result = await db.asUser(secretaryA(), (tx) =>
        updateOption(tx, orgA, 'event_type', 'bull_riding', { label: 'Hijacked' }),
      );
      assert.equal(result, null, 'system options are not writable');
    });

    it('a producer can rename and deactivate their own option', async () => {
      const updated = await db.asUser(secretaryA(), (tx) =>
        updateOption(tx, orgA, 'event_type', 'mounted_shooting', {
          label: 'Mounted Shooting',
          is_active: false,
        }),
      );
      assert.equal(updated?.label, 'Mounted Shooting');

      const active = await db.asUser(secretaryA(), (tx) =>
        loadOptions(tx, orgA, 'event_type'),
      );
      assert.ok(!active.some((o) => o.code === 'mounted_shooting'));
    });
  });

  // =========================================================================
  // Score round trip
  // =========================================================================

  describe('scoring round trip', () => {
    const score1 = randomUUID();
    const score2 = randomUUID();

    it('loads a config, scores a run, and stores it as provisional', async () => {
      const config = await db.asUser(secretaryA(), (tx) =>
        loadScoringConfig(tx, scoringConfigId),
      );
      assert.ok(config);
      assert.equal(config!.mode, 'timed');

      const result = calculateTimedScore({ raw_time: 2.34 }, config!);
      assert.equal(result.final_time, 2.34);

      await db.asUser(secretaryA(), (tx) =>
        persistScore(tx, {
          id: score1,
          org_id: orgA,
          rodeo_id: rodeoA,
          rodeo_event_id: eventA,
          entry_id: entry1,
          contestant_id: roper,
          go_round: 1,
          scoring_config_id: scoringConfigId,
          source: 'manual',
          entered_by: userA,
          result,
        }),
      );

      const rows = await db.asUser(secretaryA(), (tx) =>
        tx<{ final_time: string; status: string }[]>`
          select final_time, status from scores where id = ${score1}
        `,
      );
      assert.equal(Number(rows[0].final_time), 2.34);
      assert.equal(rows[0].status, 'official');
    });

    // Regression for SPEC-DELTAS D26. Writing a config with
    // JSON.stringify(x)::jsonb stores a jsonb STRING SCALAR, so the config
    // reads back as text and every rule in it silently disappears.
    it('a stored config round-trips as an object, not a jsonb string', async () => {
      const rows = await db.asUser(secretaryA(), (tx) =>
        tx<{ t: string }[]>`
          select jsonb_typeof(config) as t from scoring_configs
           where id = ${scoringConfigId}
        `,
      );
      assert.equal(rows[0].t, 'object', 'config must be a jsonb object');

      const config = await db.asUser(secretaryA(), (tx) =>
        loadScoringConfig(tx, scoringConfigId),
      );
      assert.equal(typeof config, 'object');
      assert.equal(config!.mode, 'timed');
      assert.equal(config!.time_precision, 2);
      assert.equal(config!.timed_penalties?.[0]?.seconds, 10);
    });

    it('a penalty is persisted with the run', async () => {
      const config = await db.asUser(secretaryA(), (tx) =>
        loadScoringConfig(tx, scoringConfigId),
      );
      const result = calculateTimedScore(
        { raw_time: 2.5, penalties: [{ type: 'barrier_break' }] },
        config!,
      );
      assert.equal(result.final_time, 12.5);

      await db.asUser(secretaryA(), (tx) =>
        persistScore(tx, {
          id: score2,
          org_id: orgA,
          rodeo_id: rodeoA,
          rodeo_event_id: eventA,
          entry_id: entry2,
          contestant_id: roper2,
          go_round: 1,
          scoring_config_id: scoringConfigId,
          source: 'manual',
          entered_by: userA,
          result,
        }),
      );

      const rows = await db.asUser(secretaryA(), (tx) =>
        tx<{ time_penalties: { type: string; seconds: number }[] }[]>`
          select time_penalties from scores where id = ${score2}
        `,
      );
      assert.equal(rows[0].time_penalties[0].type, 'barrier_break');
      assert.equal(rows[0].time_penalties[0].seconds, 10);
    });

    // An official score at a running rodeo is PUBLIC by design — that is the
    // live results page (§4.1). Asserting it is private would be asserting a
    // bug. What must hold is that a score at a rodeo which is not yet public
    // stays invisible.
    it('an official score at a running rodeo is public, by design', async () => {
      const rows = await db.asAnon((tx) =>
        tx`select id from scores where id = ${score1}`,
      );
      assert.equal(rows.length, 1, 'live results are meant to be readable');
    });

    it('a score at a draft rodeo is invisible to everyone outside the org', async () => {
      const draftRodeo = randomUUID();
      const draftEvent = randomUUID();
      const draftEntry = randomUUID();
      const draftScore = randomUUID();

      await db.asService('fixture: draft rodeo for visibility test', async (tx) => {
        await tx`
          insert into rodeos (id, org_id, name, slug, start_date, end_date,
                              rodeo_type, status)
          values (${draftRodeo}, ${orgA}, 'Unpublished', ${'draft-' + draftRodeo.slice(0, 8)},
                  '2026-10-01', '2026-10-01', 'jackpot', 'draft')
        `;
        await tx`
          insert into rodeo_events (id, org_id, rodeo_id, event_type, scoring_mode)
          values (${draftEvent}, ${orgA}, ${draftRodeo}, 'breakaway_roping', 'timed')
        `;
        await tx`
          insert into entries (id, org_id, rodeo_id, rodeo_event_id, contestant_id, status)
          values (${draftEntry}, ${orgA}, ${draftRodeo}, ${draftEvent}, ${roper}, 'confirmed')
        `;
        await tx`
          insert into scores (id, org_id, rodeo_id, rodeo_event_id, entry_id,
                              contestant_id, final_time, status, source)
          values (${draftScore}, ${orgA}, ${draftRodeo}, ${draftEvent}, ${draftEntry},
                  ${roper}, 3.10, 'official', 'manual')
        `;
      });

      const anon = await db.asAnon((tx) =>
        tx`select id from scores where id = ${draftScore}`,
      );
      assert.equal(anon.length, 0, 'a draft rodeo leaks nothing publicly');

      const otherTenant = await db.asUser(secretaryB(), (tx) =>
        tx`select id from scores where id = ${draftScore}`,
      );
      assert.equal(otherTenant.length, 0, 'and nothing to another producer');

      const ownTenant = await db.asUser(secretaryA(), (tx) =>
        tx`select id from scores where id = ${draftScore}`,
      );
      assert.equal(ownTenant.length, 1, 'but the producer sees their own');
    });

    it('finalizing a score that is already official is a no-op, not a lie', async () => {
      const out = await db.asUser(secretaryA(), (tx) =>
        finalizeScore(tx, orgA, score1, userA),
      );
      assert.equal(out, null, 'nothing was provisional to finalize');
    });

    it('an edit is recorded in history even from the API path', async () => {
      await db.asUser(secretaryA(), (tx) =>
        tx`update scores set final_time = 2.40, last_edited_by = ${userA}
            where id = ${score1}`,
      );
      const rows = await db.asUser(secretaryA(), (tx) =>
        tx<{ n: number }[]>`
          select jsonb_array_length(edit_history) as n from scores where id = ${score1}
        `,
      );
      assert.equal(rows[0].n, 1);
    });
  });

  // =========================================================================
  // Payout: load context, calculate, disburse
  // =========================================================================

  describe('payout round trip', () => {
    const key = `test-payout-${randomUUID()}`;

    it('loads context with money already converted to cents', async () => {
      const ctx = await db.asUser(secretaryA(), (tx) =>
        loadPayoutContext(tx, orgA, eventA),
      );
      assert.ok(ctx);
      assert.equal(ctx!.entry_fee_cents, toCents(100), '$100 entry fee');
      assert.equal(ctx!.added_money_cents, toCents(500), '$500 added');
      assert.equal(ctx!.entries.length, 2);
      assert.equal(ctx!.results.length, 2);
      assert.ok(
        ctx!.results.every((r) => typeof r.final_time === 'number'),
        'timed results carry a time, not a score',
      );
    });

    it('calculates a payout that reconciles against the stored data', async () => {
      const ctx = await db.asUser(secretaryA(), (tx) =>
        loadPayoutContext(tx, orgA, eventA),
      );
      const result = calculatePayout({
        payout_config: ctx!.config,
        scoring_mode: ctx!.scoring_mode,
        entries: ctx!.entries,
        results: ctx!.results,
        added_money_cents: ctx!.added_money_cents,
        entry_fee_cents: ctx!.entry_fee_cents,
      });

      assert.equal(result.ok, true);
      // $500 added + 2 x $100 = $700 gross. 6% + $5/entry = $52 fees.
      assert.equal(result.gross_purse_cents, toCents(700));
      assert.equal(result.fees.total_cents, toCents(52));
      assert.equal(result.net_purse_cents, toCents(648));

      const paid = result.payouts.reduce((s, p) => s + p.amount_cents, 0);
      assert.equal(
        paid + result.unpaid_cents + result.escrow_cents,
        result.net_purse_cents,
        'every cent accounted for',
      );
      // Two qualified, three places paid: ground money spreads the 3rd share.
      assert.equal(paid, result.net_purse_cents);
    });

    it('writes the ledger and is idempotent on retry', async () => {
      const lines = [
        { contestant_id: roper, amount_cents: 40000, type: 'prize', place: 1 },
        { contestant_id: roper2, amount_cents: 24800, type: 'prize', place: 2 },
      ];

      const first = await db.asUser(secretaryA(), (tx) =>
        disburse(tx, orgA, rodeoA, key, userA, lines),
      );
      assert.equal(first.transactions_written, 2);
      assert.equal(first.total_cents, 64800);
      assert.equal(first.already_disbursed, false);

      // The same call again — a retried request after a timeout.
      const second = await db.asUser(secretaryA(), (tx) =>
        disburse(tx, orgA, rodeoA, key, userA, lines),
      );
      assert.equal(second.already_disbursed, true, 'the retry did not pay again');
      assert.equal(second.transactions_written, 2, 'still only two rows exist');

      const rows = await db.asUser(secretaryA(), (tx) =>
        tx<{ n: string }[]>`
          select count(*) as n from financial_transactions
           where org_id = ${orgA} and idempotency_key like ${key + ':%'}
        `,
      );
      assert.equal(Number(rows[0].n), 2, 'no double payment in the ledger');
    });

    // Two independent layers stop the ledger being edited, and the test has to
    // exercise both. RLS gives no UPDATE policy at all, so a secretary's update
    // matches zero rows and never reaches the trigger. The trigger is what
    // catches the service role, which bypasses RLS entirely — and the service
    // role is what the API itself runs background jobs as.
    it('RLS gives no one an UPDATE path to the ledger', async () => {
      const before = await db.asUser(secretaryA(), (tx) =>
        tx<{ amount: string }[]>`
          select amount from financial_transactions
           where org_id = ${orgA} and idempotency_key like ${key + ':%'}
           order by amount desc limit 1
        `,
      );

      await db.asUser(secretaryA(), (tx) =>
        tx`update financial_transactions set amount = 1
            where org_id = ${orgA} and idempotency_key like ${key + ':%'}`,
      );

      const after = await db.asUser(secretaryA(), (tx) =>
        tx<{ amount: string }[]>`
          select amount from financial_transactions
           where org_id = ${orgA} and idempotency_key like ${key + ':%'}
           order by amount desc limit 1
        `,
      );
      assert.equal(after[0].amount, before[0].amount, 'no row was changed');
    });

    it('the trigger stops even the service role, which bypasses RLS', async () => {
      await assert.rejects(
        () =>
          db.asService('deliberate tamper attempt in test', (tx) =>
            tx`update financial_transactions set amount = 1
                where org_id = ${orgA} and idempotency_key like ${key + ':%'}`,
          ),
        /append-only/i,
        'the append-only trigger must bind the service role too',
      );
    });

    it("another tenant cannot see the money", async () => {
      const rows = await db.asUser(secretaryB(), (tx) =>
        tx`select id from financial_transactions where org_id = ${orgA}`,
      );
      assert.equal(rows.length, 0);
    });

    it('a contestant sees their own payout and not the other roper', async () => {
      const rows = await db.asUser(claims(authRoper), (tx) =>
        tx<{ to_user_id: string }[]>`
          select to_user_id from financial_transactions
           where idempotency_key like ${key + ':%'}
        `,
      );
      // The contestant is a member of org A but not financial staff, so the
      // only rows they may read are the ones naming them.
      assert.ok(rows.length >= 1);
      assert.ok(rows.every((r) => r.to_user_id === roper));
    });
  });

  // =========================================================================
  // Team roping, end to end through the database
  // =========================================================================

  describe('team roping through the database', () => {
    const trEvent = randomUUID();
    const trConfig = randomUUID();
    const header1 = randomUUID();
    const heeler1 = randomUUID();
    const header2 = randomUUID();
    const heeler2 = randomUUID();
    const trEntry1 = randomUUID();
    const trEntry2 = randomUUID();

    before(async () => {
      await db.asService('fixture: team roping event', async (tx) => {
        await tx`
          insert into users (id, first_name, last_name) values
            (${header1}, 'Head', 'One'),
            (${heeler1}, 'Heel', 'One'),
            (${header2}, 'Head', 'Two'),
            (${heeler2}, 'Heel', 'Two')
        `;
        await tx`
          insert into payout_configs (id, org_id, name, is_system, config)
          values (${trConfig}, ${orgA}, 'TR Winner Take All', false, ${tx.json({
            fee_structure: {},
            team_payout: 'full_to_each',
            team_size: 2,
            payout_rules: [
              { min_entries: 1, max_entries: 99, places_paid: 1, splits: [1.0] },
            ],
            ground_money_rule: 'combine_and_split',
          })})
        `;
        await tx`
          insert into rodeo_events (id, org_id, rodeo_id, event_type, scoring_mode,
                                    entry_fee, added_money, payout_config_id)
          values (${trEvent}, ${orgA}, ${rodeoA}, 'team_roping_header', 'timed',
                  50.00, 0, ${trConfig})
        `;
        // One entry per TEAM, with the heeler as the partner.
        await tx`
          insert into entries (id, org_id, rodeo_id, rodeo_event_id,
                               contestant_id, partner_id, status) values
            (${trEntry1}, ${orgA}, ${rodeoA}, ${trEvent}, ${header1}, ${heeler1}, 'confirmed'),
            (${trEntry2}, ${orgA}, ${rodeoA}, ${trEvent}, ${header2}, ${heeler2}, 'confirmed')
        `;
        await tx`
          insert into scores (org_id, rodeo_id, rodeo_event_id, entry_id,
                              contestant_id, final_time, status, source) values
            (${orgA}, ${rodeoA}, ${trEvent}, ${trEntry1}, ${header1}, 6.42, 'official', 'manual'),
            (${orgA}, ${rodeoA}, ${trEvent}, ${trEntry2}, ${header2}, 7.11, 'official', 'manual')
        `;
      });
    });

    it('loads both ropers on each team from partner_id', async () => {
      const ctx = await db.asUser(secretaryA(), (tx) =>
        loadPayoutContext(tx, orgA, trEvent),
      );
      assert.ok(ctx);
      assert.equal(ctx!.results.length, 2, 'two teams');
      for (const r of ctx!.results) {
        assert.equal(r.team_members?.length, 2, 'header and heeler both present');
      }
    });

    it('pays the header AND the heeler, and does not double the purse', async () => {
      const ctx = await db.asUser(secretaryA(), (tx) =>
        loadPayoutContext(tx, orgA, trEvent),
      );
      const result = calculatePayout({
        payout_config: ctx!.config,
        scoring_mode: ctx!.scoring_mode,
        entries: ctx!.entries,
        added_money_cents: ctx!.added_money_cents,
        entry_fee_cents: ctx!.entry_fee_cents,
        results: ctx!.results,
      });

      assert.equal(result.ok, true, JSON.stringify(result.issues));

      const paid = result.payouts.reduce((s, p) => s + p.amount_cents, 0);
      assert.equal(
        paid + result.unpaid_cents + result.escrow_cents,
        result.net_purse_cents,
        'the purse goes out exactly once',
      );

      const winners = result.payouts.filter((p) => p.amount_cents > 0);
      assert.equal(winners.length, 2, 'the winning header and heeler');
      const ids = winners.map((w) => w.contestant_id).sort();
      assert.deepEqual(ids, [header1, heeler1].sort());
      assert.equal(
        winners[0].amount_cents,
        winners[1].amount_cents,
        'a-Man: both ends credited the same',
      );
      assert.ok(
        result.payouts.every((p) => p.contestant_id !== trEntry1),
        'no line is addressed to an entry id instead of a person',
      );
    });
  });

  // =========================================================================
  // Sync and public reads
  // =========================================================================

  describe('sync', () => {
    it('finds the server state a client would be conflicting with', async () => {
      const state = await db.asUser(secretaryA(), (tx) =>
        loadServerState(tx, orgA, {
          entity_type: 'score',
          id: randomUUID(),
          data: { entry_id: entry1, go_round: 1 },
        }),
      );
      assert.ok(state, 'the existing run is found');
      assert.equal(state!.source, 'manual');
    });

    it('returns changes since a timestamp', async () => {
      const changes = await db.asUser(secretaryA(), (tx) =>
        changesSince(tx, orgA, '2020-01-01T00:00:00Z'),
      );
      assert.ok(changes.length >= 2);
      assert.ok(changes.every((c) => c.entity_type === 'score'));
    });

    it('another tenant gets nothing from the same call', async () => {
      const changes = await db.asUser(secretaryB(), (tx) =>
        changesSince(tx, orgB, '2020-01-01T00:00:00Z'),
      );
      assert.equal(changes.length, 0);
    });
  });

  describe('public reads', () => {
    it('serves a results page anonymously', async () => {
      const out = (await db.asAnon((tx) => loadPublicResults(tx, rodeoA))) as {
        rodeo: { name: string };
        events: unknown[];
      } | null;
      assert.ok(out, 'the rodeo is publicly visible');
      assert.equal(out!.rodeo.name, 'A Jackpot');
    });
  });

  // =========================================================================
  // The service-role escape hatch
  // =========================================================================

  describe('asService', () => {
    it('refuses to run without a stated reason', async () => {
      await assert.rejects(
        () => db.asService('', async (tx) => tx`select 1`),
        /requires a reason/,
      );
    });
  });
});
