-- ============================================================================
-- 0030_definer_hardening.sql
-- Two findings from the database linter, run against the live project after
-- 0001-0029 were applied.
--
-- ---------------------------------------------------------------------------
-- 1. SECURITY DEFINER FUNCTIONS WITH A MUTABLE search_path
-- ---------------------------------------------------------------------------
-- Eight functions were created without `set search_path`. Every function this
-- schema marks SECURITY DEFINER already pins it; these eight are the trigger
-- and helper functions, which were written as plain functions and then ended
-- up reachable from a definer context anyway -- `record_score_edit()` fires on
-- an UPDATE made from inside `close_rodeo_books()`, and `option_is_valid()` is
-- called by a definer validator.
--
-- An unpinned search_path is only exploitable by somebody who can already
-- create objects in a schema earlier on the path, which on Supabase means a
-- privileged role. It is still the wrong default: pinning costs nothing and
-- removes the question.
--
-- ---------------------------------------------------------------------------
-- 2. anon COULD CALL EVERY DEFINER FUNCTION OVER /rest/v1/rpc
-- ---------------------------------------------------------------------------
-- Supabase's default privileges grant EXECUTE on functions in `public` to both
-- `anon` and `authenticated`. The `revoke all ... from public` lines in 0022,
-- 0024, 0027 and 0028 removed the PUBLIC grant and left the role grants
-- untouched, so a signed-out caller could still POST to
-- /rest/v1/rpc/close_rodeo_books.
--
-- Nothing leaks today: every one of these opens with an `app_is_org_staff()`
-- check and `app_current_user_id()` is null for anon, so each call raises
-- 42501 rather than doing anything. But "it happens to be guarded inside" is
-- not the same as "it is not callable", and the guard is the last line, not
-- the first.
--
-- THE LINE DRAWN HERE. The predicate helpers stay executable by anon, and that
-- is deliberate rather than an oversight:
--
--   app_current_user_id, app_is_org_member, app_is_org_staff, app_can_score,
--   app_can_view_financials, app_has_org_role, option_is_valid,
--   credential_is_current, org_has_module
--
-- These are evaluated INSIDE row-level security policies and validation
-- triggers, as the querying role. Revoking anon's EXECUTE would not harden
-- anything -- it would make `select * from sidepots` fail outright for a
-- signed-out visitor reading a published rodeo, because `sidepots_member_read`
-- calls `app_is_org_member`. They take an org id and answer a question about
-- the caller, so an anonymous caller learns only that they are anonymous.
--
-- Everything that ACTS or REPORTS is revoked.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Pin the search_path on the eight that lack it.
--
-- `alter function ... set search_path` rather than redefining each body: the
-- definitions are correct and restating them here would be a second copy to
-- keep in step with 0009, 0013, 0017, 0020, 0023, 0024 and 0025.
-- ----------------------------------------------------------------------------
alter function reject_mutation()            set search_path = public;
alter function touch_updated_at()           set search_path = public;
alter function record_score_edit()          set search_path = public;
alter function validate_reference_option()  set search_path = public;
alter function association_for(uuid, text)  set search_path = public;
alter function hash_book_closure()          set search_path = public;
alter function stamp_credential_author()    set search_path = public;
alter function stamp_booking_exclusivity()  set search_path = public;

-- ----------------------------------------------------------------------------
-- 2. Take the action and report functions away from anon.
--
-- `authenticated` keeps EXECUTE throughout -- these are the API's own entry
-- points and each one authorises its caller on its first statement.
-- ----------------------------------------------------------------------------

-- Money and the record.
revoke execute on function close_rodeo_books(uuid, uuid, uuid, jsonb, jsonb, text, timestamptz) from anon;
revoke execute on function file_rodeo_books(uuid, uuid, uuid, text, boolean, bigint) from anon;
revoke execute on function reopen_rodeo_books(uuid, uuid, uuid, text) from anon;
revoke execute on function record_career_runs(uuid, uuid) from anon;
revoke execute on function tax_year_summary(uuid, int, text) from anon;

-- The desk.
revoke execute on function search_people(uuid, text, int) from anon;
revoke execute on function assign_back_numbers(uuid, uuid, int) from anon;
revoke execute on function book_resource(uuid, uuid, date, date, int, uuid, text, uuid) from anon;

-- Compliance, credentials and releases.
revoke execute on function generate_compliance_items(uuid, uuid) from anon;
revoke execute on function personnel_shortfall(uuid, uuid) from anon;
revoke execute on function verify_credential(uuid) from anon;
revoke execute on function sign_waiver(uuid, uuid, uuid, text, text, uuid, text, uuid, text, inet, text) from anon;
revoke execute on function verify_signed_waiver(uuid) from anon;
revoke execute on function waiver_shortfall(uuid, uuid) from anon;

-- Notices. An open outbox is a spam relay with our sending domain on it.
revoke execute on function queue_notice(uuid, text, uuid, text, text, uuid, text, jsonb, timestamptz) from anon;
revoke execute on function notify_draw_posted(uuid, uuid) from anon;

-- ----------------------------------------------------------------------------
-- The four public views keep `security_invoker = false`, and the linter will
-- keep reporting them. That property is the entire mechanism described in
-- 0016 and 0018: the view runs as its owner so it can read `users`, and its
-- SELECT list is the only thing that crosses -- a first and last name, never
-- an email, phone, date of birth, address or tax identifier. Making them
-- invoker views would not tighten anything; it would return zero rows to
-- every anonymous reader and empty the public results pages again, which is
-- the defect D31 was written to fix.
-- ----------------------------------------------------------------------------
comment on view public_results is
    'Scoreboard data. Runs as owner ON PURPOSE (delta D31): a name lookup that '
    'needed an RLS policy on `users` would expose the whole contestant row. '
    'The SELECT list is the security boundary. Do not convert to '
    'security_invoker -- see 0016 and 0030.';
