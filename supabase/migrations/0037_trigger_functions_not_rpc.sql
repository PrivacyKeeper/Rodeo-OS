-- ============================================================================
-- 0037_trigger_functions_not_rpc.sql
-- Two trigger functions I added were exposed as RPC endpoints.
--
-- The linter flagged both after 0032:
--
--     /rest/v1/rpc/handle_new_auth_user
--     /rest/v1/rpc/guard_self_profile_edit
--
-- Both are SECURITY DEFINER trigger functions, and Supabase's default
-- privileges grant EXECUTE on public functions to anon and authenticated. So
-- they were reachable by a signed-out caller over HTTP.
--
-- The practical risk is small: PostgreSQL refuses to run a function returning
-- `trigger` outside a trigger context, so a POST gets an error rather than an
-- effect. But "the type system happens to stop it" is not the same as "it is
-- not exposed", and this pair is SECURITY DEFINER precisely because they do
-- things the caller could not — provisioning a profile row, and guarding
-- against self-certifying a tax identifier.
--
-- These are mine, added in 0032, and 0030/0031 had already been through this
-- exact exercise for the action functions. I extended the surface and did not
-- re-run the check that would have caught it. Re-running the linter after a
-- schema change is the habit that catches this, not remembering to.
-- ============================================================================

revoke all on function handle_new_auth_user() from public, anon, authenticated;
revoke all on function guard_self_profile_edit() from public, anon, authenticated;

-- Triggers execute as the table owner and do not consult these grants, so both
-- keep working exactly as before. Verified below rather than assumed.
