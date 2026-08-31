/**
 * delete-account — App Store Guideline 5.1.1(v).
 *
 * An app that lets somebody create an account must let them delete it from
 * inside the app. Apple checks this on first submission, so without it none of
 * the seven apps reaches TestFlight external review.
 *
 * Two steps, in this order, and the order matters:
 *
 *   1. `delete_my_account()` de-identifies the contestant record. It is not a
 *      DELETE — the ledger is append-only by trigger, and a producer's tax
 *      obligation for a closed year outlives the account. The identity goes;
 *      the tombstone the ledger points at stays.
 *   2. The auth user is deleted, which destroys the login.
 *
 * If step 2 fails after step 1 succeeded, the person is de-identified but can
 * still sign in — to an account with no name and no data. That is recoverable
 * and visible. The reverse order would delete the login first and leave a
 * fully-identified orphan record nobody can reach to clean up, which is not.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization header');

    // The token is the whole authorisation. There is deliberately no user id in
    // the request body: a caller must never be able to name somebody else.
    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', ''),
    );
    if (userError || !user) throw new Error('Unauthorized');

    const { data: result, error: rpcError } = await supabase.rpc('delete_my_account', {
      p_auth_id: user.id,
    });
    if (rpcError) throw new Error(`Could not close the account: ${rpcError.message}`);

    const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
    if (deleteError) {
      // Step 1 has already run. Say so plainly rather than reporting a clean
      // failure, because the person's data really is gone.
      throw new Error(
        `Your details were removed, but the login could not be deleted: ${deleteError.message}. Contact support and it will be finished.`,
      );
    }

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('delete-account failed:', message);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
