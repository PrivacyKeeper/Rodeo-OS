/**
 * Per-event analysis vocabulary.
 *
 * THE FAULT CODES ARE NOT INVENTED HERE. Every code below is copied from the
 * shipping `src/lib/pose/event.ts` of the app that owns the event. That file is
 * the source of truth, and AI_ANALYSIS.md is explicit about why: a coach report
 * counts how many people on a roster share a fault, and the count is only
 * meaningful if the fault is named identically every time. A second vocabulary
 * living on the server would produce codes the app cannot label, which is the
 * same fragmentation the taxonomy exists to prevent — reintroduced by us.
 *
 * The first draft of this file did exactly that: it invented a plausible list
 * per event (DISMOUNT_SLOW, SLOW_DOWN_THE_ROPE, FLANK_STRUGGLE...) that
 * overlapped the real one by about a third. Every non-overlapping code would
 * have come back to a phone that had no label for it.
 *
 * The codes are sent to the model as a JSON-schema `enum`, so selecting one is
 * the only thing it can do. `meaning` goes into the prompt so the model knows
 * what each code is for without being free to reinterpret it.
 *
 * WHEN AN APP ADDS A FAULT, ADD IT HERE TOO. Codes are permanent once shipped:
 * reword a label freely, never change what a code means. Retire and replace.
 */

export type EventFault = { code: string; meaning: string };

export type EventProfile = {
  label: string;
  identify: string;
  phases: string[];
  faults: EventFault[];
  emphasis: string;
};

const TIE_DOWN: EventProfile = {
  label: 'tie-down roping',
  identify: 'a mounted roper catching a calf, dismounting, flanking it and tying three legs',
  phases: ['box and barrier', 'catch', 'dismount and down the rope', 'flank and tie'],
  faults: [
    { code: 'BARRIER_MARGIN_THIN', meaning: 'Leaving close enough to the barrier that a ten-second penalty is a matter of luck.' },
    { code: 'DISMOUNT_SLOW', meaning: 'Slow from the catch to feet on the ground.' },
    { code: 'TIE_SLOW', meaning: 'Slow through the wraps and the hooey.' },
    { code: 'HORSE_NOT_WORKING_ROPE', meaning: 'The horse is not holding the rope tight through the tie.' },
    { code: 'HORSE_STOP_LATE', meaning: 'The horse stops late after the catch.' },
    { code: 'JERK_DOWN_RISK', meaning: 'The calf came close to being jerked off all four feet.' },
  ],
  emphasis:
    'Segment the run. A roper does not want to know he was 8.4 — he wants to know which of the four segments cost him. The dismount and the tie are where tenths disappear unmeasured.',
};

const BREAKAWAY: EventProfile = {
  label: 'breakaway roping',
  identify: 'a mounted roper catching a calf around the neck, with a string that breaks from the saddle horn',
  phases: ['box and barrier', 'delivery', 'catch and draw tight'],
  faults: [
    { code: 'BARRIER_MARGIN_THIN', meaning: 'Leaving close enough to the barrier that ten seconds is a matter of luck.' },
    { code: 'SLOW_OUT_OF_THE_BOX', meaning: 'The horse is not gathered when the barrier drops.' },
    { code: 'DELIVERY_LATE', meaning: 'Extra swings past the point the shot was there.' },
    { code: 'SHOULDERS_OPEN_AT_DELIVERY', meaning: 'The body turns with the rope hand, so the loop leaves off line.' },
    { code: 'LOOP_COLLAPSING', meaning: 'The loop flattens before it reaches the neck.' },
    { code: 'REACHING', meaning: 'Throwing from further back than the roper’s own delivery position.' },
    { code: 'SLOW_DRAW_TIGHT', meaning: 'Slow from the catch to the flag while the slack comes out.' },
    { code: 'HORSE_NOT_RATING', meaning: 'The horse runs past the calf instead of coming back.' },
  ],
  emphasis:
    'The shortest run in rodeo — under three seconds. There is no second half to make time up in, so weight the box and the delivery heavily.',
};

const TEAM_ROPING: EventProfile = {
  label: 'team roping',
  identify: 'two mounted ropers, a header catching the steer and a heeler catching its hind legs',
  phases: ['box and barrier', 'head catch', 'handle and corner', 'heel shot'],
  faults: [
    { code: 'CROSSFIRE_RISK_RELEASE', meaning: 'The heel loop was released before the steer was changing direction (release standard).' },
    { code: 'CROSSFIRE_RISK_CONTACT', meaning: 'The heel loop made contact before the steer was changing direction (contact standard).' },
    { code: 'POOR_HANDLE', meaning: 'The header did not set the steer up cleanly for the heeler.' },
    { code: 'HEELER_POSITION_WIDE', meaning: 'The heeler is wide through the corner.' },
    { code: 'BARRIER_MARGIN_THIN', meaning: 'Leaving close enough to the barrier that a penalty is a matter of luck.' },
    { code: 'DALLY_THUMB_EXPOSED', meaning: 'The thumb is exposed on the dally — an injury risk, not a time penalty.' },
  ],
  emphasis:
    'Two athletes and two horses. Attribute faults to the header or the heeler explicitly in the notes. The handle through the corner is the most under-analysed part of the run.',
};

const STEER_WRESTLING: EventProfile = {
  label: 'steer wrestling',
  identify: 'a mounted contestant sliding off a horse onto a running steer and throwing it flat',
  phases: ['box and barrier', 'catch', 'setup and throw'],
  faults: [
    { code: 'DISMOUNT_EARLY', meaning: 'Leaving the horse before the steer is in position.' },
    { code: 'HEEL_PLANT_POOR', meaning: 'Heels not planted, so there is nothing to throw against.' },
    { code: 'HAZER_LINE_POOR', meaning: 'The hazer is not keeping the steer straight.' },
    { code: 'BARRIER_MARGIN_THIN', meaning: 'Leaving close enough to the barrier that a penalty is a matter of luck.' },
    { code: 'SHOULDER_LOAD_HIGH', meaning: 'The shoulder is loaded outside the contestant’s usual range — an injury risk.' },
  ],
  emphasis:
    'The throw is decided before it starts, by whether he got his feet under him. Judge the setup, not just the fall.',
};

const SADDLE_BRONC: EventProfile = {
  label: 'saddle bronc riding',
  identify: 'a rider on a bucking horse with a bronc saddle and a rein, spurring in rhythm',
  phases: ['mark out', 'first jumps', 'middle of the ride', 'whistle'],
  faults: [
    { code: 'MARKOUT_MARGINAL', meaning: 'The mark-out is close enough that a judge could call it either way.' },
    { code: 'SPUR_TIMING_LATE', meaning: 'The spur stroke is half a beat behind the horse.' },
    { code: 'SPUR_AMPLITUDE_SHORT', meaning: 'The stroke is short of the rider’s own usual range.' },
    { code: 'POSITION_UNDER_DROP', meaning: 'Shoulders forward on the drop.' },
    { code: 'FREE_ARM_CROSSING', meaning: 'The free arm is crossing the body.' },
    { code: 'INCONSISTENT_BODY_ANGLE', meaning: 'Position varying jump to jump.' },
  ],
  emphasis:
    'Rhythm is the event. Judge whether the spur stroke matches the horse rather than whether it is fast, and watch rein-hand position.',
};

const BAREBACK: EventProfile = {
  label: 'bareback riding',
  identify: 'a rider on a bucking horse holding a rigging with one hand, spurring',
  phases: ['mark out', 'first jumps', 'middle of the ride', 'whistle'],
  faults: [
    { code: 'LICK_INCOMPLETE', meaning: 'The spur lick does not complete through its full arc.' },
    { code: 'KNEE_LIFT_FADING', meaning: 'Knee lift fading in the last three jumps.' },
    { code: 'MARKOUT_MARGINAL', meaning: 'The mark-out is close enough that a judge could call it either way.' },
    { code: 'LAYBACK_INCONSISTENT', meaning: 'Lay-back varying through the drop.' },
    { code: 'FREE_ARM_CROSSING', meaning: 'The free arm is crossing the body.' },
    { code: 'ELBOW_LOAD_HIGH', meaning: 'The rigging arm is loaded outside the rider’s usual range — an injury risk.' },
    { code: 'NECK_POSITION_RISK', meaning: 'Neck position at impact is a concern.' },
  ],
  emphasis:
    'The mark-out decides whether there is a score at all — judge it first and explicitly. After that, lick completeness and knee lift are what separate a 78 from an 85.',
};

const RANCH: EventProfile = {
  label: 'ranch rodeo',
  identify: 'a team of ranch cowboys working cattle against a clock',
  phases: ['setup', 'work', 'finish'],
  faults: [
    { code: 'DEAD_TIME_HIGH', meaning: 'The team is waiting on each other rather than working.' },
    { code: 'ROLE_LOAD_UNEVEN', meaning: 'The work is shared unevenly across the team.' },
    { code: 'LINE_CROSS_SPREAD', meaning: 'A ragged start — the team crosses the line spread out.' },
    { code: 'GAIT_VIOLATION_OBSERVED', meaning: 'Possible loping in the herd, where a walk or trot is required.' },
    { code: 'MULTIPLE_IN_HERD_OBSERVED', meaning: 'Possible second rider in the herd where only one is allowed.' },
    { code: 'MILKING_SEQUENCE_SLOW', meaning: 'Slow from the rope coming off to the milk.' },
    { code: 'BRONC_LOW_EXPOSURE', meaning: 'Riding safe rather than for score.' },
  ],
  emphasis:
    'A team event — attribute to a role rather than a person, and describe what the cattle did, because half of a ranch rodeo run is the draw. The gait and herd faults are OBSERVATIONS, not rulings: say what you saw and leave the call to the judge.',
};

export const EVENT_PROFILES: Record<string, EventProfile> = {
  tie_down_roping: TIE_DOWN,
  breakaway_roping: BREAKAWAY,
  jr_breakaway: BREAKAWAY,
  // One run with two ends. Analysing the heel shot without the head catch that
  // set it up would be judging the second half of a sentence.
  team_roping_header: TEAM_ROPING,
  team_roping_heeler: TEAM_ROPING,
  steer_wrestling: STEER_WRESTLING,
  chute_dogging: STEER_WRESTLING,
  saddle_bronc: SADDLE_BRONC,
  bareback: BAREBACK,
  ranch_bareback: BAREBACK,
  ranch_bronc: RANCH,
  wild_cow_milking: RANCH,
  team_penning: RANCH,
  team_sorting: RANCH,
  ranch_doctoring: RANCH,
  wild_horse_race: RANCH,
  ranch_branding: RANCH,
  steer_mugging: RANCH,
  trailer_loading: RANCH,
  ranch_sorting: RANCH,
};

export function profileFor(eventCode: string): EventProfile {
  return EVENT_PROFILES[eventCode] ?? RANCH;
}
