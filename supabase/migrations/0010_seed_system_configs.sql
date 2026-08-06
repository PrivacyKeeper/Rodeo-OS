-- ============================================================================
-- 0010_seed_system_configs.sql
-- System scoring and payout templates (org_id IS NULL, is_system = true).
--
-- These are STARTING POINTS, not certified rulebooks. Appendix B of the
-- architecture records that the exact PRCA penalty tables, the full PBR 2026
-- variance provisions and the CPRA "number of monies" thresholds have not
-- been obtained. Anything below that is not verifiable from a public rulebook
-- is marked "unverified": true and must be confirmed before a sanctioned
-- rodeo is run on it. Producers clone a template and override.
-- ============================================================================

insert into scoring_configs
    (name, sanctioning_body, event_type, season, effective_date, is_system, config)
values
-- ---------------------------------------------------------------- roughstock
('PRCA Bareback Riding 2026', 'PRCA', 'bareback', '2026', '2026-01-01', true, '{
    "mode": "judged",
    "max_score": 100,
    "components": [
        {"name": "rider",  "min": 0, "max": 25, "judges": 2},
        {"name": "animal", "min": 0, "max": 25, "judges": 2}
    ],
    "increment": 0.5,
    "ride_duration_seconds": 8,
    "mark_out_required": true,
    "dq_triggers": [
        "mark_out_violation",
        "free_arm_touches_animal_or_self",
        "dismount_before_buzzer",
        "riding_hand_changes"
    ],
    "reride_conditions": ["poor_animal_performance", "foul", "equipment_failure"],
    "tie_resolution": "combine_and_split"
}'::jsonb),

('PRCA Saddle Bronc Riding 2026', 'PRCA', 'saddle_bronc', '2026', '2026-01-01', true, '{
    "mode": "judged",
    "max_score": 100,
    "components": [
        {"name": "rider",  "min": 0, "max": 25, "judges": 2},
        {"name": "animal", "min": 0, "max": 25, "judges": 2}
    ],
    "increment": 0.5,
    "ride_duration_seconds": 8,
    "mark_out_required": true,
    "dq_triggers": [
        "mark_out_violation",
        "free_arm_touches_animal_or_self",
        "dismount_before_buzzer",
        "loses_stirrup",
        "drops_rein"
    ],
    "reride_conditions": ["poor_animal_performance", "foul", "equipment_failure"],
    "tie_resolution": "combine_and_split"
}'::jsonb),

('PRCA Bull Riding 2026', 'PRCA', 'bull_riding', '2026', '2026-01-01', true, '{
    "mode": "judged",
    "max_score": 100,
    "components": [
        {"name": "rider",  "min": 0, "max": 25, "judges": 2},
        {"name": "animal", "min": 0, "max": 25, "judges": 2}
    ],
    "increment": 0.5,
    "ride_duration_seconds": 8,
    "mark_out_required": false,
    "dq_triggers": ["free_arm_touches_animal_or_self", "dismount_before_buzzer"],
    "reride_conditions": ["poor_animal_performance", "foul"],
    "tie_resolution": "combine_and_split"
}'::jsonb),

-- PBR moved to 0.1 increments and caps how far a rider score may exceed the
-- bull score. The cap is a REVIEW FLAG, not a rejection (§5.7).
('PBR Bull Riding 2026', 'PBR', 'bull_riding', '2026', '2026-01-01', true, '{
    "mode": "judged",
    "max_score": 100,
    "components": [
        {"name": "rider",  "min": 0, "max": 50, "judges": 1},
        {"name": "animal", "min": 0, "max": 50, "judges": 1}
    ],
    "increment": 0.1,
    "variance_cap": 3.0,
    "variance_cap_is_advisory": true,
    "ride_duration_seconds": 8,
    "mark_out_required": false,
    "dq_triggers": ["free_arm_touches_animal_or_self", "dismount_before_buzzer"],
    "reride_conditions": ["poor_animal_performance", "foul"],
    "tie_resolution": "combine_and_split",
    "unverified": true,
    "unverified_note": "Full PBR 2026 variance provisions not obtained. Architecture Appendix B."
}'::jsonb),

-- ------------------------------------------------------------- timed events
('PRCA Tie-Down Roping 2026', 'PRCA', 'tie_down_roping', '2026', '2026-01-01', true, '{
    "mode": "timed",
    "time_precision": 1,
    "timed_penalties": [
        {"type": "barrier_break", "seconds": 10.0}
    ],
    "tie_must_hold_seconds": 6,
    "dq_triggers": ["rope_not_holding_six_seconds", "jerk_down", "no_catch"],
    "reride_conditions": [],
    "tie_resolution": "combine_and_split"
}'::jsonb),

('PRCA Steer Wrestling 2026', 'PRCA', 'steer_wrestling', '2026', '2026-01-01', true, '{
    "mode": "timed",
    "time_precision": 1,
    "timed_penalties": [
        {"type": "barrier_break", "seconds": 10.0}
    ],
    "dq_triggers": ["illegal_fall", "steer_gets_up_and_is_not_rethrown"],
    "reride_conditions": [],
    "tie_resolution": "combine_and_split"
}'::jsonb),

('PRCA Team Roping 2026', 'PRCA', 'team_roping_header', '2026', '2026-01-01', true, '{
    "mode": "timed",
    "time_precision": 1,
    "timed_penalties": [
        {"type": "barrier_break",  "seconds": 10.0},
        {"type": "one_leg_catch",  "seconds": 5.0}
    ],
    "legal_head_catches": ["around_both_horns", "half_head", "around_neck"],
    "dq_triggers": ["illegal_head_catch", "crossfire", "no_catch"],
    "reride_conditions": [],
    "tie_resolution": "combine_and_split"
}'::jsonb),

('WPRA Barrel Racing 2026', 'WPRA', 'barrel_racing', '2026', '2026-01-01', true, '{
    "mode": "timed",
    "time_precision": 3,
    "timed_penalties": [
        {"type": "barrel_knockdown", "seconds": 5.0}
    ],
    "dq_triggers": ["off_pattern", "failure_to_complete_cloverleaf"],
    "reride_conditions": [],
    "tie_resolution": "combine_and_split"
}'::jsonb),

('WPRA Breakaway Roping 2026', 'WPRA', 'breakaway_roping', '2026', '2026-01-01', true, '{
    "mode": "timed",
    "time_precision": 2,
    "timed_penalties": [
        {"type": "barrier_break", "seconds": 10.0}
    ],
    "dq_triggers": ["no_catch", "rope_breaks_away_early", "illegal_catch"],
    "reride_conditions": [],
    "tie_resolution": "combine_and_split"
}'::jsonb),

('Open Goat Tying 2026', null, 'goat_tying', '2026', '2026-01-01', true, '{
    "mode": "timed",
    "time_precision": 2,
    "timed_penalties": [],
    "tie_must_hold_seconds": 6,
    "dq_triggers": ["tie_does_not_hold", "touching_goat_after_signal"],
    "reride_conditions": [],
    "tie_resolution": "combine_and_split"
}'::jsonb);

-- ============================================================================
-- Payout templates
-- ============================================================================

insert into payout_configs
    (name, sanctioning_body, season, effective_date, is_system, config)
values
-- The classic jackpot ladder: more entries, more places paid.
('Standard Jackpot 2026', null, '2026', '2026-01-01', true, '{
    "fee_structure": {
        "admin_pct": 0.06,
        "office_fee_flat": 5.00,
        "facility_fee_flat": 0,
        "cres_fee": 0,
        "sports_medicine_fee": 0,
        "circuit_fee": 0,
        "insurance_fee": 0
    },
    "payout_rules": [
        {"min_entries": 1,  "max_entries": 3,    "places_paid": 1, "splits": [1.0]},
        {"min_entries": 4,  "max_entries": 6,    "places_paid": 2, "splits": [0.60, 0.40]},
        {"min_entries": 7,  "max_entries": 12,   "places_paid": 3, "splits": [0.50, 0.30, 0.20]},
        {"min_entries": 13, "max_entries": 20,   "places_paid": 4, "splits": [0.40, 0.30, 0.20, 0.10]},
        {"min_entries": 21, "max_entries": 40,   "places_paid": 5, "splits": [0.35, 0.25, 0.18, 0.13, 0.09]},
        {"min_entries": 41, "max_entries": 99999,"places_paid": 6, "splits": [0.30, 0.23, 0.17, 0.13, 0.10, 0.07]}
    ],
    "ground_money_rule": "combine_and_split",
    "no_ground_money": false,
    "escrow_on_no_qualified": false,
    "day_money_enabled": false,
    "stock_contractor_pct": 0,
    "tie_resolution": "combine_and_split",
    "rounding": "largest_remainder"
}'::jsonb),

-- Multi-round: go-round money and average money out of one purse.
('Standard Two-Round Average 2026', null, '2026', '2026-01-01', true, '{
    "fee_structure": {"admin_pct": 0.06, "office_fee_flat": 5.00},
    "payout_rules": [
        {"min_entries": 1,  "max_entries": 6,    "places_paid": 2, "splits": [0.60, 0.40]},
        {"min_entries": 7,  "max_entries": 12,   "places_paid": 3, "splits": [0.50, 0.30, 0.20]},
        {"min_entries": 13, "max_entries": 99999,"places_paid": 4, "splits": [0.40, 0.30, 0.20, 0.10]}
    ],
    "go_round_average_split": {"go_round_pct": 0.40, "average_pct": 0.60},
    "ground_money_rule": "combine_and_split",
    "no_ground_money": false,
    "day_money_enabled": true,
    "tie_resolution": "combine_and_split",
    "rounding": "largest_remainder"
}'::jsonb),

-- "Cowboy rules": unfilled places are simply not paid.
('Cowboy Rules (No Ground Money) 2026', null, '2026', '2026-01-01', true, '{
    "fee_structure": {"admin_pct": 0.05, "office_fee_flat": 0},
    "payout_rules": [
        {"min_entries": 1,  "max_entries": 6,    "places_paid": 2, "splits": [0.60, 0.40]},
        {"min_entries": 7,  "max_entries": 99999,"places_paid": 3, "splits": [0.50, 0.30, 0.20]}
    ],
    "ground_money_rule": "none",
    "no_ground_money": true,
    "tie_resolution": "combine_and_split",
    "rounding": "largest_remainder"
}'::jsonb),

('4D Barrel Racing 2026', 'NBHA', '2026', '2026-01-01', true, '{
    "fee_structure": {"admin_pct": 0.0, "office_fee_flat": 3.00},
    "is_d_format": true,
    "d_format": {
        "divisions": 4,
        "time_splits": [0, 0.5, 1.0, 2.0],
        "division_pcts": [0.35, 0.30, 0.20, 0.15]
    },
    "payout_rules": [
        {"min_entries": 1,  "max_entries": 5,    "places_paid": 1, "splits": [1.0]},
        {"min_entries": 6,  "max_entries": 10,   "places_paid": 2, "splits": [0.60, 0.40]},
        {"min_entries": 11, "max_entries": 20,   "places_paid": 3, "splits": [0.50, 0.30, 0.20]},
        {"min_entries": 21, "max_entries": 99999,"places_paid": 4, "splits": [0.40, 0.30, 0.20, 0.10]}
    ],
    "ground_money_rule": "combine_and_split",
    "tie_resolution": "combine_and_split",
    "rounding": "largest_remainder"
}'::jsonb),

('CPRA Canada 2026', 'CPRA_CA', '2026', '2026-01-01', true, '{
    "fee_structure": {
        "admin_pct": 0.0,
        "office_fee_flat": 0,
        "cres_fee": 5.00,
        "sports_medicine_fee": 5.00
    },
    "payout_rules": [
        {"min_entries": 1,  "max_entries": 8,    "places_paid": 4, "splits": [0.40, 0.30, 0.20, 0.10]},
        {"min_entries": 9,  "max_entries": 99999,"places_paid": 6, "splits": [0.30, 0.23, 0.17, 0.13, 0.10, 0.07]}
    ],
    "ground_money_rule": "combine_and_split",
    "escrow_on_no_qualified": true,
    "tie_resolution": "combine_and_split",
    "rounding": "largest_remainder",
    "unverified": true,
    "unverified_note": "CPRA number-of-monies thresholds not obtained. Architecture Appendix B."
}'::jsonb);
