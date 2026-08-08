-- ============================================================================
-- 0023_score_corrections.sql
-- Why a score changed, not just that it did.
--
-- ---------------------------------------------------------------------------
-- The arena reverses a call more often than any software design admits. A
-- judge's sheet turns up with 17.24 where the terminal has 17.42; a barrier
-- flag was missed; a time was read off the wrong lane. Correcting a score is
-- an ordinary operation, not an admin escape hatch, and it happens in front of
-- a contestant who wants to know what changed.
--
-- `record_score_edit()` already appended the old and new values to
-- `edit_history` on every UPDATE — including one made by bypassing the API,
-- which is the only reason that guarantee is worth anything. What it did not
-- capture is WHY, and "17.42 became 17.24 at 21:47" is an argument rather than
-- an answer.
--
-- So: a reason column, and the trigger carries it into every history entry it
-- writes. A correction with no reason is still recorded — this does not force
-- one, because refusing to save a fix at eleven at night over a missing
-- sentence is worse than an unexplained fix. But the API asks for one and the
-- screen makes it awkward to skip.
-- ============================================================================

alter table scores add column correction_reason text;

comment on column scores.correction_reason is
    'Why the most recent correction was made. Carried into edit_history by '
    'record_score_edit(), so the history is self-explanatory without joining '
    'anything.';

-- ----------------------------------------------------------------------------
-- Rewritten so every appended entry carries the reason and the run's identity.
-- Same guarantees as before: history is append-only regardless of what the
-- caller supplies, and the trigger fires on any UPDATE from any role.
-- ----------------------------------------------------------------------------
create or replace function record_score_edit()
returns trigger
language plpgsql
as $$
declare
    edits jsonb := '[]'::jsonb;
    -- Whichever reason applies to this transition. A DQ explains itself with
    -- dq_reason, a re-ride with reride_reason, everything else with the
    -- correction reason.
    v_reason text := coalesce(
        case
            when new.status = 'dq' and new.status is distinct from old.status
                then new.dq_reason
            when new.status = 'reride' and new.status is distinct from old.status
                then new.reride_reason
            else new.correction_reason
        end,
        new.correction_reason
    );
begin
    if new.final_score is distinct from old.final_score then
        edits := edits || jsonb_build_object(
            'at', now(), 'by', new.last_edited_by,
            'field', 'final_score', 'from', old.final_score, 'to', new.final_score,
            'reason', v_reason
        );
    end if;

    if new.final_time is distinct from old.final_time then
        edits := edits || jsonb_build_object(
            'at', now(), 'by', new.last_edited_by,
            'field', 'final_time', 'from', old.final_time, 'to', new.final_time,
            'reason', v_reason
        );
    end if;

    if new.status is distinct from old.status then
        edits := edits || jsonb_build_object(
            'at', now(), 'by', new.last_edited_by,
            'field', 'status', 'from', old.status, 'to', new.status,
            'reason', v_reason
        );
    end if;

    if jsonb_array_length(edits) > 0 then
        -- Append-only even when the caller supplied a shorter array.
        new.edit_history := old.edit_history || edits;
    else
        new.edit_history := old.edit_history;
    end if;

    new.updated_at := now();
    return new;
end;
$$;

comment on function record_score_edit is
    'Appends every change of a score, time or status to edit_history, with the '
    'reason. Fires on any UPDATE from any role, so a change made outside the '
    'API is recorded too.';
