-- ============================================================================
-- 0031_definer_hardening_public.sql
-- 0030 revoked from the wrong grantee, and the linter said so.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG
-- ---------------------------------------------------------------------------
-- 0030 wrote `revoke execute on function ... from anon` for sixteen functions.
-- Six of them lost anon's access; ten did not, and the difference is visible
-- in the ACL:
--
--     search_people      postgres=X/postgres authenticated=X/postgres ...
--     close_rodeo_books  =X/postgres         postgres=X/postgres ...
--                        ^^^^^^^^^^^
--
-- That leading `=X/postgres` is a grant to PUBLIC. `anon` never held a direct
-- grant on these functions -- it could execute them because PUBLIC can, and
-- revoking a privilege from a role does not remove the privilege it inherits
-- from PUBLIC. The six that worked were the six whose own migrations (0022,
-- 0024, 0027, 0028) had already written `revoke all ... from public`, so
-- 0030's line had nothing left to do and looked like it was the thing that
-- did it.
--
-- So the correct form is: revoke from PUBLIC, then grant back to the roles
-- that should have it. Which also means every one of these needs an explicit
-- `grant execute to authenticated` afterwards, because the grant they were
-- relying on is the one being removed.
--
-- ---------------------------------------------------------------------------
-- THE SAME LINE AS 0030
-- ---------------------------------------------------------------------------
-- The predicate helpers -- app_current_user_id, app_is_org_member,
-- app_is_org_staff, app_can_score, app_can_view_financials, app_has_org_role,
-- option_is_valid, credential_is_current, org_has_module -- keep their PUBLIC
-- grant, for the reason set out in 0030: they are evaluated inside RLS
-- policies and validation triggers as the querying role, and taking them away
-- from anon would break the public results pages rather than protect them.
--
-- Only the functions that act or report are closed.
-- ============================================================================

-- Money and the record.
revoke execute on function close_rodeo_books(uuid, uuid, uuid, jsonb, jsonb, text, timestamptz) from public;
grant  execute on function close_rodeo_books(uuid, uuid, uuid, jsonb, jsonb, text, timestamptz) to authenticated;

revoke execute on function file_rodeo_books(uuid, uuid, uuid, text, boolean, bigint) from public;
grant  execute on function file_rodeo_books(uuid, uuid, uuid, text, boolean, bigint) to authenticated;

revoke execute on function reopen_rodeo_books(uuid, uuid, uuid, text) from public;
grant  execute on function reopen_rodeo_books(uuid, uuid, uuid, text) to authenticated;

revoke execute on function record_career_runs(uuid, uuid) from public;
grant  execute on function record_career_runs(uuid, uuid) to authenticated;

-- The desk.
revoke execute on function assign_back_numbers(uuid, uuid, int) from public;
grant  execute on function assign_back_numbers(uuid, uuid, int) to authenticated;

revoke execute on function book_resource(uuid, uuid, date, date, int, uuid, text, uuid) from public;
grant  execute on function book_resource(uuid, uuid, date, date, int, uuid, text, uuid) to authenticated;

-- Compliance.
revoke execute on function generate_compliance_items(uuid, uuid) from public;
grant  execute on function generate_compliance_items(uuid, uuid) to authenticated;

revoke execute on function personnel_shortfall(uuid, uuid) from public;
grant  execute on function personnel_shortfall(uuid, uuid) to authenticated;

-- Notices. An outbox anybody can write to is a spam relay with our sending
-- domain on the envelope.
revoke execute on function queue_notice(uuid, text, uuid, text, text, uuid, text, jsonb, timestamptz) from public;
grant  execute on function queue_notice(uuid, text, uuid, text, text, uuid, text, jsonb, timestamptz) to authenticated;

revoke execute on function notify_draw_posted(uuid, uuid) from public;
grant  execute on function notify_draw_posted(uuid, uuid) to authenticated;
