-- ============================================================================
-- 0036_account_deletion.sql
-- Deleting an account, without destroying a ledger.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS AT ALL
-- ---------------------------------------------------------------------------
-- App Store Review Guideline 5.1.1(v): an app that lets you create an account
-- must let you delete it from inside the app. Not an email to support, not a
-- web form. Apple rejects for this, and it is checked on first submission — so
-- without this, none of the seven apps reach TestFlight external review.
--
-- ---------------------------------------------------------------------------
-- WHY IT IS NOT A DELETE
-- ---------------------------------------------------------------------------
-- A contestant who has ever been paid cannot be removed from this database,
-- and it is worth being precise about why rather than treating it as an
-- inconvenience:
--
--   * `financial_transactions` is append-only, enforced by a trigger that
--     applies to the service role too (0009). A row cannot be deleted at all.
--   * `results` and `career_runs` are somebody else's record as much as
--     theirs: removing a contestant from a placing rewrites the standings for
--     everybody who finished behind them.
--   * `tax_year_summary()` has to keep reporting what a producer paid in a
--     year that has already closed. That obligation is the producer's and it
--     outlives the contestant's account.
--
-- So the login is destroyed and the person is de-identified, which is what
-- "delete my account" actually has to mean here. The `users` row survives as a
-- tombstone carrying no name, no contact details and no tax identifier — only
-- the id the ledger points at.
--
-- This is a legitimate reading of the guideline and of erasure law generally:
-- both permit retaining what a legal or financial obligation requires. What
-- neither permits is keeping the identity, and that is exactly what goes.
-- ============================================================================

create or replace function delete_my_account(p_auth_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user users;
    v_paid boolean;
    v_entries int;
begin
    select * into v_user from users where supabase_auth_id = p_auth_id;
    if v_user.id is null then
        -- An auth user with no profile. Nothing to de-identify, and the caller
        -- still needs the auth row gone, so this is a success rather than an
        -- error.
        return jsonb_build_object('deleted', true, 'anonymised', false);
    end if;

    select exists (
        select 1 from financial_transactions
         where to_user_id = v_user.id or from_user_id = v_user.id
    ) into v_paid;

    -- Live entries are SCRATCHED rather than deleted: a secretary with a draw
    -- sheet in her hand needs the slot off the sheet, not the history of it to
    -- vanish from under her.
    --
    -- 'scratched' and not 'turned_out' deliberately, and the first draft of
    -- this used 'cancelled', which is not a status this table has -- the check
    -- constraint caught it. The distinction that matters is the other one: a
    -- turnout carries a fine under most association rules, and closing an
    -- account is not the moment to decide somebody owes one. Whether the
    -- producer pursues it is a conversation between them, not a side effect of
    -- a delete button.
    update entries
       set status = 'scratched', updated_at = now()
     where (contestant_id = v_user.id or partner_id = v_user.id)
       and status in ('pending', 'confirmed', 'drawn');
    get diagnostics v_entries = row_count;

    -- Things that are purely the person's own and reference nothing: gone.
    delete from run_video_analyses where contestant_id = v_user.id;
    delete from career_runs where contestant_id = v_user.id and source = 'self_reported';
    delete from notices where user_id = v_user.id;
    delete from roper_classifications where user_id = v_user.id;

    -- Horses they own become unowned rather than deleted. A horse has a record
    -- of its own and may have been sold on; erasing it would take somebody
    -- else's animal out of the registry.
    update animal_registry
       set owner_user_id = null, is_claimed = false, updated_at = now()
     where owner_user_id = v_user.id;

    -- The de-identification itself.
    update users
       set first_name = 'Deleted',
           last_name  = 'Account',
           email = null,
           phone = null,
           date_of_birth = null,
           address_line1 = null,
           address_line2 = null,
           city = null,
           state_province = null,
           postal_code = null,
           tax_id_type = null,
           tax_id_last4 = null,
           tax_id_verified = false,
           memberships = '[]'::jsonb,
           stripe_customer_id = null,
           stripe_account_id = null,
           stripe_payouts_enabled = false,
           supabase_auth_id = null,
           updated_at = now()
     where id = v_user.id;

    return jsonb_build_object(
        'deleted', true,
        'anonymised', true,
        'entries_cancelled', v_entries,
        'financial_history_retained', v_paid
    );
end;
$$;

comment on function delete_my_account is
    'De-identifies a contestant and releases their login. Not a delete: the '
    'ledger is append-only and a producer''s tax obligation for a closed year '
    'outlives the account. The identity goes; the tombstone the ledger points '
    'at stays. App Store Guideline 5.1.1(v).';

-- Callable only by the edge function under the service role. A contestant
-- reaches it through that function, which verifies their JWT first — this is
-- not an RPC anybody can post to.
revoke all on function delete_my_account(uuid) from public, anon, authenticated;
