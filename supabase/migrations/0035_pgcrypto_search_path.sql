-- ============================================================================
-- 0035_pgcrypto_search_path.sql
-- Every function that hashes anything was unable to run.
--
-- ---------------------------------------------------------------------------
-- WHAT BROKE
-- ---------------------------------------------------------------------------
--     ERROR: function digest(text, unknown) does not exist
--
-- `digest()` comes from pgcrypto, and on Supabase pgcrypto is installed into
-- the `extensions` schema, not `public`. Any function pinned to
-- `search_path = public` therefore cannot see it:
--
--     sign_waiver           — no waiver could be signed, ever
--     verify_signed_waiver  — no signature could be checked
--     hash_book_closure     — the books could not be closed
--
-- ---------------------------------------------------------------------------
-- HOW EACH ONE GOT HERE, INCLUDING THE ONE I BROKE
-- ---------------------------------------------------------------------------
-- `sign_waiver` and `verify_signed_waiver` shipped this way in 0027. They have
-- never worked. Nothing caught it because nothing had called them: 0027 built
-- the signing flow and the app had no screen for it until now.
--
-- `hash_book_closure` is different, and worse. It was written in 0020 with NO
-- search_path, so it resolved `digest` through the caller's path — which on
-- Supabase includes `extensions` — and it worked. Migration 0030 then pinned
-- `search_path = public` across the eight functions the linter flagged as
-- having a mutable path, and that pin took `extensions` away. 0030 was my
-- change, the reasoning was right, and I did not check what the bodies
-- actually called. A hardening pass turned a working function into a broken
-- one and the linter went quiet, which is exactly the shape of change that
-- gets shipped.
--
-- ---------------------------------------------------------------------------
-- THE FIX, AND WHY NOT THE OTHER ONE
-- ---------------------------------------------------------------------------
-- `search_path = public, extensions` rather than `extensions, public`. Order
-- matters: our own objects must resolve first, so an extension cannot shadow a
-- table or a function this schema defines by adding one with the same name.
--
-- The alternative — schema-qualifying every call as `extensions.digest(...)` —
-- was rejected because it hard-codes a Supabase layout decision into the
-- middle of business logic, and this schema is meant to be portable to a plain
-- Postgres where pgcrypto sits somewhere else.
--
-- The other five functions 0030 pinned (reject_mutation, touch_updated_at,
-- record_score_edit, validate_reference_option, association_for,
-- stamp_credential_author, stamp_booking_exclusivity) call nothing outside
-- `public` and are correct as they stand. Checked rather than assumed.
-- ============================================================================

alter function sign_waiver(uuid, uuid, uuid, text, text, uuid, text, uuid, text, inet, text)
    set search_path = public, extensions;

alter function verify_signed_waiver(uuid)
    set search_path = public, extensions;

alter function hash_book_closure()
    set search_path = public, extensions;
