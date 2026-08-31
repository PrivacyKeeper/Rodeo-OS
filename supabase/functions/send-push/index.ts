/**
 * send-push — drains the notice outbox to Expo's push service.
 *
 * `notices` is written in the same transaction as the thing it announces, so a
 * draw committed on a bad connection in an arena office is never lost to a
 * failed network call. This is the other half: a worker that delivers those
 * rows later, with retries.
 *
 * AUTHENTICATION. `verify_jwt` is false because the caller is a cron schedule,
 * not a person — but the function is NOT open. It requires a shared secret in
 * `x-worker-secret` matching PUSH_WORKER_SECRET. Without that env var set the
 * function refuses every request rather than defaulting to open, which is the
 * failure mode that matters: an open endpoint that sends notifications to real
 * people is a spam relay with our sending identity on it.
 *
 * IDEMPOTENCE. A notice is marked `sending` before the push and `sent` after.
 * A crash in between leaves it `sending` and it is NOT retried automatically —
 * duplicate draw notifications are worse than a late one, and a stuck row is
 * visible in the table rather than silently re-fired.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Expo accepts at most 100 messages per request. */
const CHUNK = 100;

type QueueRow = {
  notice_id: number;
  token: string;
  subject: string;
  body: string;
  payload: Record<string, unknown> | null;
};

type ExpoTicket = {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
};

Deno.serve(async (req: Request) => {
  try {
    const secret = Deno.env.get('PUSH_WORKER_SECRET');
    if (!secret) {
      // Refuse rather than run open. A misconfigured worker that still sends is
      // worse than one that does not.
      return new Response(
        JSON.stringify({ error: 'PUSH_WORKER_SECRET is not configured for this project' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (req.headers.get('x-worker-secret') !== secret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: queue, error: queueError } = await supabase.rpc('pending_push_notices', {
      p_limit: 200,
    });
    if (queueError) throw new Error(`Could not read the queue: ${queueError.message}`);

    const rows = (queue ?? []) as QueueRow[];
    if (rows.length === 0) {
      return new Response(JSON.stringify({ sent: 0, failed: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Claim them before sending, so a second worker running concurrently does
    // not send the same notice twice.
    const noticeIds = [...new Set(rows.map((r) => r.notice_id))];
    await supabase
      .from('notices')
      .update({ status: 'sending' })
      .in('id', noticeIds)
      .in('status', ['pending', 'failed']);

    let sent = 0;
    let failed = 0;
    const deadTokens: string[] = [];
    const failedNotices = new Set<number>();

    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      const messages = batch.map((r) => ({
        to: r.token,
        title: r.subject,
        body: r.body,
        data: r.payload ?? {},
        sound: 'default',
      }));

      let tickets: ExpoTicket[] = [];
      try {
        const response = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(messages),
        });
        const json = (await response.json()) as { data?: ExpoTicket[]; errors?: unknown };
        tickets = json.data ?? [];
      } catch (error) {
        // The whole batch is unsent. Put it back rather than losing it.
        for (const r of batch) failedNotices.add(r.notice_id);
        failed += batch.length;
        console.error('push batch failed', error);
        continue;
      }

      batch.forEach((row, index) => {
        const ticket = tickets[index];
        if (ticket?.status === 'ok') {
          sent++;
          return;
        }
        failed++;
        failedNotices.add(row.notice_id);
        // The one error worth acting on: the app was uninstalled, so the token
        // is dead and every future send to it would fail the same way.
        if (ticket?.details?.error === 'DeviceNotRegistered') {
          deadTokens.push(row.token);
        }
      });
    }

    if (deadTokens.length > 0) {
      await supabase
        .from('push_tokens')
        .update({ is_active: false, last_error: 'DeviceNotRegistered' })
        .in('token', deadTokens);
    }

    const delivered = noticeIds.filter((id) => !failedNotices.has(id));
    if (delivered.length > 0) {
      await supabase
        .from('notices')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .in('id', delivered);
    }

    for (const id of failedNotices) {
      // Read-modify-write on a single row rather than a bulk update, because
      // `attempts` has to increment per notice and that is what stops a
      // permanently broken token being retried forever.
      const { data: current } = await supabase
        .from('notices')
        .select('attempts')
        .eq('id', id)
        .single();
      await supabase
        .from('notices')
        .update({ status: 'failed', attempts: (current?.attempts ?? 0) + 1 })
        .eq('id', id);
    }

    return new Response(
      JSON.stringify({ sent, failed, dead_tokens: deadTokens.length }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('send-push failed:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
