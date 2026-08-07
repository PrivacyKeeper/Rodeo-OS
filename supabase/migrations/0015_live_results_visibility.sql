-- ============================================================================
-- 0015_live_results_visibility.sql
--
-- Results were strictly LESS public than the scores they are derived from.
--
-- `scores_public_read` (0008) exposes an official score once the rodeo is
-- 'in_progress' — that is the live results page, and it is the point of §4.1's
-- public SSE endpoint. But `results_public_read` required the rodeo to be
-- 'completed' or later.
--
-- So during a rodeo a spectator could see every raw time and not the placings
-- computed from them. The leaderboard was hidden while the numbers behind it
-- were on the screen. At a multi-day rodeo that means no live average and no
-- standings until the whole thing is over, which is exactly when people stop
-- caring.
--
-- Nothing is disclosed by this that the scores did not already disclose:
-- results are derived data, and `is_official` still gates provisional
-- placings out.
--
-- See docs/SPEC-DELTAS.md D30.
-- ============================================================================

drop policy results_public_read on results;

create policy results_public_read on results
    for select using (
        is_official
        and exists (
            select 1 from rodeos r
            where r.id = results.rodeo_id
              and r.status in ('in_progress', 'completed', 'results_official', 'settled')
        )
    );

comment on table results is
    'Derived placings. Rebuilt from scores on every finalise, so a corrected '
    'run moves the placings, the average and the points together. Public once '
    'official and the rodeo is under way — matching scores_public_read.';
