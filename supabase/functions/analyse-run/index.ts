/**
 * analyse-run — structured video analysis of a rodeo run.
 *
 * Ported from the pattern proven in BarrelConnect's `analyze-video`, and
 * generalised from barrel racing to every event in the portfolio.
 *
 * WHY FRAMES AND NOT VIDEO. The vision API accepts images, not MP4s. The phone
 * extracts keyframes with expo-video-thumbnails and uploads only those, so a
 * run costs a few kilobytes to analyse instead of a few hundred megabytes and
 * the source video never leaves the device. That is the pattern AI_ANALYSIS.md
 * describes, and it is also why this works at a rodeo on one bar of signal.
 *
 * WHY A STRICT SCHEMA. The model selects fault codes from the event's own
 * taxonomy, supplied as an enum. It cannot invent a category. A coach report
 * counts how many people on a roster share a fault, and that count is only
 * meaningful if the same mistake is named identically every time — ask a model
 * to describe runs freely and one fault comes back three ways across three
 * contestants, tallying as three separate one-person problems. The model still
 * writes the paragraph a human reads; it does not decide what happened.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

import { profileFor } from './events.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

interface AnalyseRunRequest {
  analysis_id?: string;
  event_code: string;
  frame_urls: string[];
  frame_times_ms?: number[];
  video_duration_ms?: number | null;
  video_url?: string | null;
  career_run_id?: string | null;
}

const MAX_FRAMES = 24;

function schemaFor(phases: string[], faultCodes: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'is_expected_event',
      'confidence',
      'overall_score',
      'summary',
      'phases',
      'faults',
      'strengths',
      'improvements',
      'key_moments',
    ],
    properties: {
      is_expected_event: { type: 'boolean' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      overall_score: { type: 'number' },
      summary: { type: 'string' },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'score', 'notes'],
          properties: {
            name: { type: 'string', enum: phases },
            score: { type: 'number' },
            notes: { type: 'string' },
          },
        },
      },
      faults: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'severity', 'evidence'],
          properties: {
            // The enum is the whole point: selection, never invention.
            code: { type: 'string', enum: faultCodes },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            evidence: { type: 'string' },
          },
        },
      },
      strengths: { type: 'array', items: { type: 'string' } },
      improvements: { type: 'array', items: { type: 'string' } },
      key_moments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['timestamp', 'description', 'type'],
          properties: {
            timestamp: { type: 'string' },
            description: { type: 'string' },
            type: { type: 'string', enum: ['good', 'improvement'] },
          },
        },
      },
    },
  };
}

type ResponsesBlock = { type?: string; text?: string; refusal?: string };
type ResponsesItem = { type?: string; role?: string; content?: ResponsesBlock[] };

function extractAssistantText(data: Record<string, unknown>): string {
  const topError = data.error as { message?: string } | undefined;
  if (topError?.message) {
    throw new Error(`OpenAI response error: ${topError.message}`);
  }

  const status = data.status;
  if (status === 'failed') throw new Error('OpenAI response status failed');
  if (status !== 'completed') {
    const reason = (data.incomplete_details as { reason?: string } | undefined)?.reason;
    throw new Error(
      `OpenAI response not completed (status=${String(status)}${reason ? ` reason=${reason}` : ''})`,
    );
  }

  const output = data.output as ResponsesItem[] | undefined;
  if (!Array.isArray(output)) throw new Error('OpenAI response missing output array');

  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    if (item.role != null && item.role !== 'assistant') continue;
    for (const block of item.content) {
      if (block.type === 'output_text' && typeof block.text === 'string') parts.push(block.text);
      if (typeof block.refusal === 'string' && block.refusal.length > 0) {
        throw new Error(`OpenAI content refusal: ${block.refusal.slice(0, 300)}`);
      }
    }
  }
  return parts.join('');
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function normalizeFrameTimes(
  count: number,
  supplied: number[] | undefined,
  durationMs: number | null,
): number[] {
  if (supplied && supplied.length === count) {
    return supplied.map((t) => (Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0));
  }
  if (durationMs && durationMs > 0 && count > 0) {
    return Array.from({ length: count }, (_, i) =>
      Math.round((count === 1 ? 0.5 : i / (count - 1)) * (durationMs - 1)),
    );
  }
  return Array.from({ length: count }, (_, i) => i);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let analysisId: string | undefined;

  try {
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) throw new Error('OPENAI_API_KEY is not set for this project');

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization header');

    const { data: { user }, error: userError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', ''),
    );
    if (userError || !user) throw new Error('Unauthorized');

    // The caller is an auth user; every row here is keyed to the contestant
    // record that auth user resolves to.
    const { data: profile } = await supabase
      .from('users')
      .select('id')
      .eq('supabase_auth_id', user.id)
      .single();
    if (!profile) throw new Error('No contestant record for this account');

    const body = (await req.json()) as AnalyseRunRequest;
    const { event_code, frame_urls, frame_times_ms, video_duration_ms, video_url, career_run_id } =
      body;

    if (!event_code) throw new Error('event_code is required');
    if (!Array.isArray(frame_urls) || frame_urls.length === 0) {
      throw new Error(
        'No frames were supplied. Pick the video again so the app can extract keyframes.',
      );
    }

    // A cap, not a truncation of the run: frames are sampled across the whole
    // clip on the phone, so trimming here would silently drop the end of it.
    if (frame_urls.length > MAX_FRAMES) {
      throw new Error(`Too many frames (${frame_urls.length}); the maximum is ${MAX_FRAMES}`);
    }

    const durationMs =
      typeof video_duration_ms === 'number' && Number.isFinite(video_duration_ms) && video_duration_ms > 0
        ? Math.round(video_duration_ms)
        : null;

    const times = normalizeFrameTimes(frame_urls.length, frame_times_ms, durationMs);

    // Written BEFORE the model is called, so a failure is a row the contestant
    // can see and retry rather than a request that vanished.
    const { data: created, error: insertError } = await supabase
      .from('run_video_analyses')
      .insert({
        contestant_id: profile.id,
        career_run_id: career_run_id ?? null,
        event_code,
        video_url: video_url ?? null,
        frame_urls,
        frame_times_ms: times,
        video_duration_ms: durationMs,
        status: 'processing',
      })
      .select('id')
      .single();

    if (insertError || !created) {
      throw new Error(`Could not record the analysis: ${insertError?.message ?? 'unknown'}`);
    }
    analysisId = created.id;

    const eventProfile = profileFor(event_code);

    const timeline = frame_urls
      .map((_, i) => {
        const t = times[i] ?? 0;
        const clock = formatClock(t);
        if (durationMs) {
          const pct = ((t / durationMs) * 100).toFixed(1);
          return `- Image ${i + 1}: ~${t} ms (${clock}) ≈ ${pct}% through the clip`;
        }
        return `- Image ${i + 1}: ~${t} ms (${clock}) — infer sequence from frame order`;
      })
      .join('\n');

    const faultList = eventProfile.faults
      .map((f) => `  ${f.code} — ${f.meaning}`)
      .join('\n');

    const prompt = [
      `You are an expert ${eventProfile.label} coach analysing ${frame_urls.length} still frames from ONE run.`,
      '',
      'FRAME TIMELINE (each line matches the next image, in order):',
      timeline,
      durationMs
        ? `Total clip length: ~${durationMs} ms (${formatClock(durationMs)}).`
        : 'Total clip length: unknown.',
      '',
      `First decide whether these frames actually show ${eventProfile.identify}. If they do not, set is_expected_event false, overall_score 0, leave phases and faults empty, and say why in the summary.`,
      '',
      'These are stills, not video. Motion between frames is not visible, so an instant that decides a call may simply not be captured. Only assert something you can actually see; where you cannot, say so in the summary and lower your confidence rather than guessing.',
      '',
      `Score 0-100 overall and per phase. The phases for this event are: ${eventProfile.phases.join(', ')}.`,
      '',
      'FAULT CODES. This is the complete, closed list, and each line says what the code means:',
      faultList,
      '',
      'Choose only from those codes. If what you observe is not in the list, describe it in `improvements` instead — do not force a code that nearly fits. These codes are counted across a whole roster to find shared problems, so a wrong code is worse than a missing one.',
      '',
      eventProfile.emphasis,
      '',
      'Timestamps in key_moments should use mm:ss and line up with the timeline above.',
    ].join('\n');

    const model = Deno.env.get('OPENAI_RUN_ANALYSIS_MODEL')?.trim() || 'gpt-5.4';

    const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: prompt }];
    for (let i = 0; i < frame_urls.length; i++) {
      content.push({ type: 'input_image', image_url: frame_urls[i], detail: 'auto' });
    }

    const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [{ type: 'message', role: 'user', content }],
        max_output_tokens: 8192,
        temperature: 0.3,
        text: {
          format: {
            type: 'json_schema',
            name: 'rodeo_run_analysis',
            strict: true,
            schema: schemaFor(
              eventProfile.phases,
              eventProfile.faults.map((f) => f.code),
            ),
          },
        },
      }),
    });

    if (!openaiResponse.ok) {
      const text = await openaiResponse.text();
      throw new Error(`OpenAI request failed: ${openaiResponse.status} — ${text.slice(0, 200)}`);
    }

    const openaiData = (await openaiResponse.json()) as Record<string, unknown>;
    const text = extractAssistantText(openaiData);
    if (!text) throw new Error('No analysis returned');

    const analysis = JSON.parse(text) as Record<string, unknown>;
    if (!('overall_score' in analysis) || !('summary' in analysis)) {
      throw new Error('The analysis came back incomplete');
    }

    const faults = Array.isArray(analysis.faults) ? (analysis.faults as { code?: string }[]) : [];
    // Filtered against the taxonomy a second time. `strict` should make this
    // impossible, but a code that is not ours in a column other things count
    // is worth one cheap guard.
    const allowed = new Set(eventProfile.faults.map((f) => f.code));
    const faultCodes = faults
      .map((f) => f.code)
      .filter((c): c is string => typeof c === 'string' && allowed.has(c));

    const usage = openaiData.usage as { total_tokens?: number } | undefined;

    const { error: updateError } = await supabase
      .from('run_video_analyses')
      .update({
        status: 'completed',
        analysis,
        overall_score: Math.max(0, Math.min(100, Number(analysis.overall_score) || 0)),
        fault_codes: faultCodes,
        model_version: model,
        tokens_used: usage?.total_tokens ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq('id', analysisId);

    if (updateError) throw new Error(`Could not save the analysis: ${updateError.message}`);

    return new Response(
      JSON.stringify({ success: true, analysis_id: analysisId, analysis }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('analyse-run failed:', message);

    if (analysisId) {
      await supabase
        .from('run_video_analyses')
        .update({
          status: 'failed',
          error_message: message.slice(0, 500),
          processed_at: new Date().toISOString(),
        })
        .eq('id', analysisId);
    }

    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
