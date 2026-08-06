-- ============================================================================
-- 0012_rules_2026_corrections.sql
-- Rule corrections verified against published sources, August 2026.
--
-- See docs/RULES.md for the source and date behind every value changed here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PBR runs FOUR judges, not one.
--
-- Each of the four marks the rider 0-25 and the bull 0-25; the eight marks are
-- combined and divided by two for the official score out of 100. The seeded
-- config modelled a single judge marking 0-50 on each side, which validates a
-- one-card ride as complete and, once four real cards arrive, records a
-- 90-point ride as 180.
--
-- Confirmed: PBR's own announcement of the 2026 scoring change, and PBR 101.
-- The 0.1 increment and the 3.0 variance cap are confirmed by the same source
-- and were already correct.
-- ----------------------------------------------------------------------------
update scoring_configs
set config = jsonb_build_object(
        'mode', 'judged',
        'max_score', 100,
        'components', jsonb_build_array(
            jsonb_build_object('name', 'rider',  'min', 0, 'max', 25, 'judges', 4),
            jsonb_build_object('name', 'animal', 'min', 0, 'max', 25, 'judges', 4)
        ),
        'score_divisor', 2,
        'increment', 0.1,
        'variance_cap', 3.0,
        'variance_cap_is_advisory', true,
        'ride_duration_seconds', 8,
        'mark_out_required', false,
        'dq_triggers', jsonb_build_array(
            'free_arm_touches_animal_or_self', 'dismount_before_buzzer'
        ),
        'reride_conditions', jsonb_build_array('poor_animal_performance', 'foul'),
        'tie_resolution', 'combine_and_split',
        'notes', to_jsonb(
            'Four judges each mark rider 0-25 and bull 0-25; the eight marks '
            'are combined and divided by two. Rider may not exceed the bull by '
            'more than 3.0, but may be marked any amount below it.'::text
        )
    ),
    updated_at = now()
where is_system
  and sanctioning_body = 'PBR'
  and season = '2026';

-- ----------------------------------------------------------------------------
-- PRCA sums two judges straight to 100. Made explicit rather than relying on
-- the divisor defaulting to 1.
-- ----------------------------------------------------------------------------
update scoring_configs
set config = config || jsonb_build_object('score_divisor', 1),
    updated_at = now()
where is_system
  and sanctioning_body = 'PRCA'
  and config->>'mode' = 'judged';

-- ----------------------------------------------------------------------------
-- The PRCA roughstock configs are confirmed against the 2026 rulebook and no
-- longer carry an unverified flag: two judges, 0-25 for the animal and 0-25
-- for the rider, 0.5 increments, eight seconds, one hand, and a mark-out
-- required in bareback and saddle bronc but not in bull riding.
--
-- The timed-event penalties are likewise confirmed: 10 seconds for a broken
-- barrier, 5 seconds for a single hind leg in team roping, a six-second rope
-- hold in tie-down, and 5 seconds per barrel knocked in WPRA barrel racing.
-- ----------------------------------------------------------------------------
update scoring_configs
set config = (config - 'unverified' - 'unverified_note')
             || jsonb_build_object(
                    'verified_against',
                    case sanctioning_body
                        when 'WPRA' then 'WPRA 2026 Rule Book'
                        else 'PRCA 2026 Rule Book'
                    end,
                    'verified_on', '2026-08-08'
                ),
    updated_at = now()
where is_system
  and sanctioning_body in ('PRCA', 'WPRA');

-- PBR's increment, variance cap and judge structure are now sourced, so the
-- blanket unverified flag comes off too.
update scoring_configs
set config = (config - 'unverified' - 'unverified_note')
             || jsonb_build_object(
                    'verified_against', 'PBR 2026 scoring announcement (Nov 2025) and PBR 101',
                    'verified_on', '2026-08-08'
                ),
    updated_at = now()
where is_system
  and sanctioning_body = 'PBR'
  and season = '2026';

-- ----------------------------------------------------------------------------
-- Barrel knockdowns are repeatable; every other penalty here is once-only.
--
-- The engine defaults a penalty to non-repeatable, which is right for a
-- barrier break but wrong for barrels: knocking two costs 10 seconds, not 5.
-- The seeded WPRA config never set the flag, so a two-barrel run was charged
-- for one.
-- ----------------------------------------------------------------------------
update scoring_configs
set config = jsonb_set(
        config,
        '{timed_penalties}',
        '[{"type": "barrel_knockdown", "seconds": 5.0, "repeatable": true}]'::jsonb
    ),
    updated_at = now()
where is_system
  and event_type in ('barrel_racing', 'jr_barrel_racing', 'pole_bending');
