-- ============================================================================
-- 0033_run_video_analysis.sql
-- Video run analysis, ported from the pattern proven in BarrelConnect.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS REPLACES
-- ---------------------------------------------------------------------------
-- Every discipline app ships `src/lib/pose` -- capture guidance, a geometric
-- embedding, baseline building and a fault judge -- and every one of them
-- documents the same blocker: nothing produces `PoseFrame[]`, because there is
-- no on-device pose model, and none of MoveNet or BlazePose detects a horse.
-- The analysis engine has been finished and unreachable for months.
--
-- BarrelConnect solved the same problem without a pose model at all: extract
-- keyframes from the run video on the phone, hand them to a vision model with
-- a STRICT JSON SCHEMA, and store the structured result. That is what this
-- table backs, generalised from barrel racing to every event in the portfolio.
--
-- ---------------------------------------------------------------------------
-- WHY THE MODEL PICKS FROM OUR CODES INSTEAD OF WRITING PROSE
-- ---------------------------------------------------------------------------
-- AI_ANALYSIS.md is emphatic that faults have fixed codes and are "never
-- written as prose by a model", because a coach report counts how many people
-- on a roster share a fault and the count is only meaningful if the fault is
-- named identically every time. Ask a model to describe runs and the same
-- fault comes back three ways across three contestants, tallying as three
-- separate one-person problems.
--
-- That constraint survives here. The edge function sends the event's own fault
-- taxonomy as an enum in the JSON schema, so the model SELECTS codes rather
-- than inventing categories. It may still write the paragraph a human reads --
-- `summary`, `strengths`, `improvements` -- it does not get to decide what
-- happened.
--
-- ---------------------------------------------------------------------------
-- ON `status` AND WHY FAILURE IS A ROW, NOT A DROPPED REQUEST
-- ---------------------------------------------------------------------------
-- A row is written BEFORE the model is called and moved to 'failed' if
-- anything goes wrong. A contestant who filmed a run, waited, and got nothing
-- needs to see that it failed and be able to retry -- not an empty list that
-- looks like they never submitted it.
-- ============================================================================

create table run_video_analyses (
    id          uuid primary key default gen_random_uuid(),

    /** Whose run it is. Analyses are personal, not tenant-scoped. */
    contestant_id uuid not null references users (id) on delete cascade,

    /**
     * The career run this analyses, when there is one. Null for a video filmed
     * without logging a run first, which is the common case at a practice pen.
     */
    career_run_id uuid references career_runs (id) on delete set null,

    /** From reference_options domain 'event_type'. Decides the schema used. */
    event_code  text not null,

    /** Where the source video lives. May be a local URI the phone kept. */
    video_url   text,
    /** Public URLs of the extracted keyframes, in order. */
    frame_urls  text[] not null default '{}',
    frame_times_ms int[] not null default '{}',
    video_duration_ms int check (video_duration_ms is null or video_duration_ms > 0),

    status      text not null default 'processing' check (status in (
                    'processing', 'completed', 'failed'
                )),
    error_message text,

    /** The model's structured output, exactly as the schema defines it. */
    analysis    jsonb,
    /** Denormalised for sorting and for the card, without parsing `analysis`. */
    overall_score numeric(5, 2) check (overall_score is null or (overall_score >= 0 and overall_score <= 100)),
    /** Fault codes the model selected from this event's taxonomy. */
    fault_codes text[] not null default '{}',

    model_version text,
    tokens_used int check (tokens_used is null or tokens_used >= 0),

    created_at  timestamptz not null default now(),
    processed_at timestamptz,

    constraint completed_has_analysis check (
        status <> 'completed' or analysis is not null
    ),
    constraint failed_has_a_reason check (
        status <> 'failed' or error_message is not null
    )
);

create index idx_run_analyses_person on run_video_analyses (contestant_id, created_at desc);
create index idx_run_analyses_run on run_video_analyses (career_run_id)
    where career_run_id is not null;

alter table run_video_analyses enable row level security;
alter table run_video_analyses force row level security;

-- Strictly personal. There is no staff read here on purpose: a producer has no
-- business reading a contestant's practice coaching, and the coach-report path
-- (when it exists) will aggregate through an explicit consent grant rather
-- than by widening this.
create policy run_analyses_own_read on run_video_analyses
    for select using (contestant_id = app_current_user_id());

create policy run_analyses_own_insert on run_video_analyses
    for insert with check (contestant_id = app_current_user_id());

create policy run_analyses_own_delete on run_video_analyses
    for delete using (contestant_id = app_current_user_id());

-- Deliberately no UPDATE policy for the contestant. The result is written by
-- the edge function under the service role; letting the phone edit its own
-- score would make every number in here worthless.

grant select, insert, delete on run_video_analyses to authenticated;

comment on table run_video_analyses is
    'Structured video analysis of a run. The model selects fault codes from '
    'the event taxonomy supplied in the JSON schema; it never invents a '
    'category. Written by the analyse-run edge function under the service '
    'role -- a contestant can read and delete their own, never update one.';

-- ----------------------------------------------------------------------------
-- Storage for the extracted frames.
--
-- Public-read because the vision API fetches each frame by URL and cannot
-- present a bearer token. The frames are keyframes of a rodeo run, which is a
-- thing that happens in front of a crowd, and the path is a uuid nobody can
-- guess. The source VIDEO is not uploaded at all -- it stays on the phone,
-- which is the pattern AI_ANALYSIS.md describes and the reason a run costs a
-- few kilobytes to analyse rather than a few hundred megabytes.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'run-frames', 'run-frames', true, 5242880,
    array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- A contestant writes only under their own auth id, and may clear their own
-- frames. Reads are open because the bucket is public.
create policy run_frames_insert on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'run-frames'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

create policy run_frames_delete on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'run-frames'
        and (storage.foldername(name))[1] = auth.uid()::text
    );
