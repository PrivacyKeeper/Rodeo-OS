/**
 * The public pages — the SEO surface for all nine .pro sites.
 *
 * Two things are asserted here and they are both about safety rather than
 * markup: nothing private escapes into HTML, and nothing a contestant typed
 * about themselves is shown as though it were an official result.
 *
 * Escaping is tested with a contestant literally called `<script>`, because
 * this module is the only place in the product that emits markup by string
 * concatenation and therefore the only place where that could go wrong.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.ts';
import { Database, createSql } from '../src/core/database/client.ts';

const url = process.env.TEST_DATABASE_URL;

describe('public pages', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const org = randomUUID();
  const rodeo = randomUUID();
  const event = randomUUID();
  const entry = randomUUID();
  const roper = randomUUID();
  const nasty = randomUUID();
  const horse = randomUUID();
  const slug = `pub-${rodeo.slice(0, 8)}`;

  before(async () => {
    db = new Database(createSql({ connectionString: url!, max: 5 }));
    app = await buildApp({
      db,
      logger: false,
      // These routes are unauthenticated, so the verifier is never reached.
      verifier: { verify: async () => { throw new Error('not used'); } } as never,
    });

    await db.asService('public pages fixture', async (tx) => {
      await tx`insert into organizations (id, name, slug, type)
               values (${org}, 'Pub Co', ${'pub-' + org.slice(0, 8)}, 'producer')`;
      await tx`insert into users (id, first_name, last_name) values
               (${roper}, 'Casey', 'Publicroper'),
               (${nasty}, ${'<script>alert(1)</script>'}, ${'O\'Brien & Sons'})`;
      await tx`insert into rodeos (id, org_id, name, slug, start_date, end_date,
                                   rodeo_type, status, venue_city, venue_state)
               values (${rodeo}, ${org}, ${'Pub Rodeo <b>'}, ${slug},
                       '2026-07-04', '2026-07-05', 'jackpot', 'results_official',
                       'Ada', 'OK')`;
      await tx`insert into rodeo_events (id, org_id, rodeo_id, event_type,
                                         scoring_mode, entry_fee)
               values (${event}, ${org}, ${rodeo}, 'barrel_racing', 'timed', 50)`;
      await tx`insert into animal_registry (id, barn_name, animal_type)
               values (${horse}, 'Publicdash', 'horse')`;
      await tx`insert into entries (id, org_id, rodeo_id, rodeo_event_id,
                                    contestant_id, status, horse_id)
               values (${entry}, ${org}, ${rodeo}, ${event}, ${roper}, 'drawn', ${horse})`;
      await tx`insert into results (org_id, rodeo_id, rodeo_event_id, contestant_id,
                                    result_type, go_round, place, payout_amount,
                                    aggregate_score, is_official) values
               (${org}, ${rodeo}, ${event}, ${roper}, 'go_round', 1, 1, 640.00, 17.42, true),
               (${org}, ${rodeo}, ${event}, ${nasty}, 'go_round', 2, 2, 360.00, 17.90, true)`;
      // A career run for the contestant, plus one they typed themselves.
      await tx`insert into career_runs (contestant_id, animal_id, org_id, rodeo_id,
                                        rodeo_event_id, rodeo_name, event_code,
                                        run_date, venue_city, venue_state,
                                        result_type, place, earnings_cents,
                                        source, is_verified) values
               (${roper}, ${horse}, ${org}, ${rodeo}, ${event}, ${'Pub Rodeo <b>'},
                'barrel_racing', '2026-07-04', 'Ada', 'OK', 'go_round', 1, 64000,
                'platform', true)`;
      await tx`insert into career_runs (contestant_id, rodeo_name, event_code,
                                        run_date, result_type, earnings_cents, source)
               values (${roper}, 'I Definitely Won A Buckle Here', 'barrel_racing',
                       '2026-05-01', 'go_round', 500000, 'self_reported')`;
    });
  });

  after(async () => {
    if (app) await app.close();
    if (!db) return;
    await db.raw.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`delete from career_runs where contestant_id in (${roper}, ${nasty})`;
      await tx`delete from results where org_id = ${org}`;
      await tx`delete from entries where org_id = ${org}`;
      await tx`delete from rodeo_events where org_id = ${org}`;
      await tx`delete from rodeos where org_id = ${org}`;
      await tx`delete from animal_registry where id = ${horse}`;
      await tx`delete from users where id in (${roper}, ${nasty})`;
      await tx`delete from organizations where id = ${org}`;
    });
    await db.close();
  });

  const get = (path: string) => app.inject({ method: 'GET', url: path });

  describe('the rodeo page', () => {
    it('renders results without a login', async () => {
      const res = await get(`/results/${slug}`);
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /text\/html/);
      assert.match(res.body, /Casey Publicroper/);
      assert.match(res.body, /17\.42/);
      assert.match(res.body, /\$640\.00/);
    });

    it('escapes everything that came out of the database', async () => {
      // A contestant called <script> is a contestant called <script>.
      const res = await get(`/results/${slug}`);
      assert.ok(
        !res.body.includes('<script>alert(1)</script>'),
        'raw markup from a name reached the page',
      );
      assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.match(res.body, /O&#39;Brien &amp; Sons/);
      assert.match(res.body, /Pub Rodeo &lt;b&gt;/);
    });

    it('carries the metadata a crawler needs', async () => {
      const res = await get(`/results/${slug}`);
      assert.match(res.body, /<link rel="canonical"/);
      assert.match(res.body, /<meta name="description"/);
      assert.match(res.body, /application\/ld\+json/);
      assert.match(res.body, /"@type":"SportsEvent"/);
      assert.ok(!res.body.includes('noindex'), 'a page with results must be indexable');
    });

    it('needs no JavaScript to be read', async () => {
      const res = await get(`/results/${slug}`);
      // The only <script> on the page is the JSON-LD block.
      const scripts = res.body.match(/<script[^>]*>/g) ?? [];
      assert.equal(scripts.length, 1);
      assert.match(scripts[0], /application\/ld\+json/);
    });

    it('404s a rodeo that has published nothing, and says do not index it', async () => {
      const res = await get('/results/no-such-rodeo');
      assert.equal(res.statusCode, 404);
      assert.match(res.body, /noindex/);
    });
  });

  describe('the contestant page', () => {
    it('shows official runs', async () => {
      const res = await get(`/results/contestant/${roper}`);
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /Casey Publicroper/);
      assert.match(res.body, /Publicdash/);
      assert.match(res.body, /\$640\.00/);
    });

    it('never shows a run the contestant typed themselves', async () => {
      // An unverified claim shown next to official results destroys the
      // credibility of the whole record, which is the only asset here.
      const res = await get(`/results/contestant/${roper}`);
      assert.ok(!res.body.includes('I Definitely Won A Buckle Here'));
      assert.ok(!res.body.includes('$5,000.00'));
    });

    it('404s an id with no public record', async () => {
      const res = await get(`/results/contestant/${randomUUID()}`);
      assert.equal(res.statusCode, 404);
    });

    it('rejects a malformed id rather than querying with it', async () => {
      const res = await get('/results/contestant/not-a-uuid');
      assert.equal(res.statusCode, 404);
    });
  });

  describe('the horse page', () => {
    it('publishes what nobody else in the sport publishes', async () => {
      const res = await get(`/results/horse/${horse}`);
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /Publicdash/);
      assert.match(res.body, /\$640\.00/);
    });
  });

  describe('crawler plumbing', () => {
    it('serves robots.txt pointing at the sitemap', async () => {
      const res = await get('/robots.txt');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /Allow: \/results/);
      assert.match(res.body, /Disallow: \/v1\//);
      assert.match(res.body, /Sitemap:/);
    });

    it('serves a sitemap listing every published rodeo', async () => {
      const res = await get('/sitemap.xml');
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /xml/);
      assert.match(res.body, new RegExp(`/results/${slug}`));
    });
  });

  describe('what must never leak', () => {
    it('no page carries a contact detail, an id of ours, or a tax field', async () => {
      const pages = await Promise.all([
        get('/results'),
        get(`/results/${slug}`),
        get(`/results/contestant/${roper}`),
        get(`/results/horse/${horse}`),
      ]);
      for (const res of pages) {
        for (const forbidden of [
          'email', 'phone', 'date_of_birth', 'tax_id', 'stripe',
          'supabase_auth_id', 'address_line',
        ]) {
          assert.ok(
            !res.body.toLowerCase().includes(forbidden),
            `'${forbidden}' appeared on ${res.request?.url ?? 'a public page'}`,
          );
        }
      }
    });
  });
});
