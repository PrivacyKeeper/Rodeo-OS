-- ============================================================================
-- 0034_contestant_draw_visibility.sql
-- D44 — A contestant could not see what he drew.
--
-- ---------------------------------------------------------------------------
-- THE SAME MISTAKE, A FOURTH TIME
-- ---------------------------------------------------------------------------
-- `stock_draws_member_read` and `animals_member_read` are both
-- `app_is_org_member(org_id)`. A contestant who enters a rodeo is not a member
-- of the producer's organisation -- 0022 established that, 0024 established it
-- again for credentials, and 0027 for waiver templates. So:
--
--   * a bareback rider cannot see which horse he drew;
--   * a bull rider cannot see which bull;
--   * neither can see the animal's name, let alone its record.
--
-- This one stings more than the others. `notify_draw_posted()` in 0025
-- describes the draw as "the message contestants want more than any other",
-- and the whole platform's pitch against a Facebook page at eleven at night is
-- that the draw arrives in the app. The notification was built. The row it
-- points at was unreadable by the person it was sent to.
--
-- ---------------------------------------------------------------------------
-- WHAT IS OPENED, AND WHAT IS NOT
-- ---------------------------------------------------------------------------
-- A contestant may read a draw row that belongs to THEIR OWN entry, and the
-- animal named on it. Not the rest of the pen, and not other people's draws:
-- knowing what everybody else drew before the sheet is posted is a competitive
-- advantage, and it is the producer's information to publish.
--
-- The animal policy is written through `stock_draws` rather than as a blanket
-- read, so a contestant sees an animal only once they are actually on it. The
-- global `animal_registry` from 0018 is separate and already world-readable —
-- that is a horse's papers, which is a public fact. This is a producer's pen.
-- ============================================================================

create policy stock_draws_contestant_read on stock_draws
    for select using (
        exists (
            select 1 from entries e
             where e.id = stock_draws.entry_id
               and (e.contestant_id = app_current_user_id()
                    or e.partner_id = app_current_user_id())
        )
    );

comment on policy stock_draws_contestant_read on stock_draws is
    'A contestant reads the draw for their own entry. Not the rest of the pen '
    '— what everybody else drew is the producer''s to publish. See delta D44.';

create policy animals_drawn_contestant_read on animals
    for select using (
        exists (
            select 1
              from stock_draws d
              join entries e on e.id = d.entry_id
             where d.animal_id = animals.id
               and (e.contestant_id = app_current_user_id()
                    or e.partner_id = app_current_user_id())
        )
    );

comment on policy animals_drawn_contestant_read on animals is
    'A contestant reads the animal they actually drew, and no other. Written '
    'through stock_draws rather than as a blanket read so entering a rodeo '
    'does not expose a contractor''s whole pen. See delta D44.';

-- ----------------------------------------------------------------------------
-- `buddy_groups` already carries a contestant-facing read policy, so travel
-- partners can see the group they entered together in. Checked rather than
-- assumed: the first draft of this migration added a duplicate and the
-- database refused it, which is the right outcome and worth leaving recorded.
-- ----------------------------------------------------------------------------

grant select on stock_draws to authenticated;
grant select on animals to authenticated;
