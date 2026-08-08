/**
 * The public surface.
 *
 * ---------------------------------------------------------------------------
 * EVERY QUERY HERE RUNS AS `anon`.
 * ---------------------------------------------------------------------------
 * Not "runs with a WHERE clause that hides private things" — runs as a role
 * with no membership anywhere, so the only rows that come back are the ones
 * the public policies and the three public views already allow. If a function
 * in this file were wrong it would return too little, never somebody's
 * contact details.
 *
 * That is why the views exist. `public_results`, `public_standings` and
 * `public_career` each expose a contestant's first and last name and nothing
 * else from `users` — no email, no phone, no date of birth, no address, no tax
 * identifier. Delta D31 records what happened when that boundary was not
 * there.
 */

import type { Tx } from './client.ts';

export interface PublicRodeoCard {
  rodeo_id: string;
  slug: string;
  name: string;
  start_date: string;
  end_date: string;
  venue_city: string | null;
  venue_state: string | null;
  events: number;
  placings: number;
}

/** Rodeos with published results, newest first. The index page. */
export async function listPublicRodeos(
  tx: Tx,
  limit = 50,
): Promise<PublicRodeoCard[]> {
  return tx<PublicRodeoCard[]>`
    select pr.rodeo_id, pr.rodeo_slug as slug, pr.rodeo_name as name,
           pr.start_date::text as start_date, pr.end_date::text as end_date,
           pr.venue_city, pr.venue_state,
           count(distinct pr.rodeo_event_id)::int as events,
           count(*)::int as placings
      from public_results pr
     group by pr.rodeo_id, pr.rodeo_slug, pr.rodeo_name,
              pr.start_date, pr.end_date, pr.venue_city, pr.venue_state
     order by pr.start_date desc
     limit ${limit}
  `;
}

export interface PublicPlacing {
  event_type: string;
  event_sort_order: number;
  result_type: string;
  go_round: number | null;
  d_division: number | null;
  place: number | null;
  first_name: string;
  last_name: string;
  contestant_id: string;
  aggregate_score: string | null;
  payout_amount: string;
}

export interface PublicRodeoPage {
  rodeo_id: string;
  slug: string;
  name: string;
  start_date: string;
  end_date: string;
  venue_city: string | null;
  venue_state: string | null;
  placings: PublicPlacing[];
}

/** One rodeo's scoreboard, by slug or by id. */
export async function loadPublicRodeo(
  tx: Tx,
  key: string,
): Promise<PublicRodeoPage | null> {
  const rows = await tx<
    (PublicPlacing & {
      rodeo_id: string;
      rodeo_slug: string;
      rodeo_name: string;
      start_date: string;
      end_date: string;
      venue_city: string | null;
      venue_state: string | null;
    })[]
  >`
    select pr.rodeo_id, pr.rodeo_slug, pr.rodeo_name,
           pr.start_date::text as start_date, pr.end_date::text as end_date,
           pr.venue_city, pr.venue_state,
           pr.event_type, pr.event_sort_order, pr.result_type, pr.go_round,
           pr.d_division, pr.place, pr.first_name, pr.last_name,
           pr.contestant_id,
           pr.aggregate_score::text as aggregate_score,
           pr.payout_amount::text as payout_amount
      from public_results pr
     where pr.rodeo_slug = ${key}
        or pr.rodeo_id::text = ${key}
     order by pr.event_sort_order, pr.result_type, pr.go_round nulls first,
              pr.place nulls last
  `;
  if (rows.length === 0) return null;
  const first = rows[0];
  return {
    rodeo_id: first.rodeo_id,
    slug: first.rodeo_slug,
    name: first.rodeo_name,
    start_date: first.start_date,
    end_date: first.end_date,
    venue_city: first.venue_city,
    venue_state: first.venue_state,
    placings: rows,
  };
}

export interface PublicCareerRow {
  rodeo_name: string;
  event_code: string;
  run_date: string;
  venue_city: string | null;
  venue_state: string | null;
  association_code: string | null;
  place: number | null;
  earnings_cents: string;
  animal_name: string | null;
  source: string;
  is_verified: boolean;
}

/**
 * A contestant's public career.
 *
 * Reads `public_career`, which excludes self-reported runs outright — an
 * unverified claim shown next to official results damages the credibility of
 * the whole record, and credibility is the only asset here.
 */
export async function loadPublicCareer(
  tx: Tx,
  contestantId: string,
): Promise<{ name: string; runs: PublicCareerRow[] } | null> {
  const rows = await tx<(PublicCareerRow & { first_name: string; last_name: string })[]>`
    select first_name, last_name, rodeo_name, event_code,
           run_date::text as run_date, venue_city, venue_state,
           association_code, place, earnings_cents::text as earnings_cents,
           animal_name, source, is_verified
      from public_career
     where contestant_id = ${contestantId}
     order by run_date desc
     limit 500
  `;
  if (rows.length === 0) return null;
  return {
    name: `${rows[0].first_name} ${rows[0].last_name}`.trim(),
    runs: rows,
  };
}

export interface PublicAnimalPage {
  animal_id: string;
  barn_name: string;
  registered_name: string | null;
  animal_type: string;
  runs: number;
  wins: number;
  best_place: number | null;
  earnings_cents: string;
  first_run: string | null;
  last_run: string | null;
}

/** What a horse or bull has done. Nobody else in the sport publishes this. */
export async function loadPublicAnimal(
  tx: Tx,
  animalId: string,
): Promise<PublicAnimalPage | null> {
  const [row] = await tx<PublicAnimalPage[]>`
    select animal_id, barn_name, registered_name, animal_type,
           runs::int, wins::int, best_place,
           coalesce(earnings_cents, 0)::text as earnings_cents,
           first_run::text as first_run, last_run::text as last_run
      from public_animal_career
     where animal_id = ${animalId}
  `;
  return row ?? null;
}

export interface PublicStandingRow {
  first_name: string;
  last_name: string;
  contestant_id: string;
  total_points: string;
  total_earnings: string;
  rodeos_entered: number;
}

export async function loadPublicStandings(
  tx: Tx,
  body: string,
  season: string,
  eventType: string,
): Promise<PublicStandingRow[]> {
  return tx<PublicStandingRow[]>`
    select first_name, last_name, contestant_id,
           total_points::text as total_points,
           total_earnings::text as total_earnings,
           rodeos_entered::int as rodeos_entered
      from public_standings
     where sanctioning_body = ${body}
       and season = ${season}
       and event_type = ${eventType}
     order by total_earnings desc nulls last, total_points desc
     limit 200
  `;
}
