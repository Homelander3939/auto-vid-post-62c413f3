// Polled by pg_cron every minute. Finds enabled social_post_schedules whose
// cron expression is due and invokes generate-social-post (which already saves
// a draft AND pushes a Telegram preview). Updates last_run_at on success.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Tiny cron matcher: supports M H D M DOW with *, */N, and comma lists.
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (!step || step <= 0) return false;
    return (value - min) % step === 0;
  }
  return field.split(',').map((p) => parseInt(p, 10)).filter((n) => !isNaN(n)).includes(value);
}

// All cron expressions are interpreted in **Asia/Tbilisi (UTC+4, no DST)** —
// the user's local timezone. We shift `now` by +4h before extracting fields so
// `0 9 * * *` means "09:00 Tbilisi" not 09:00 UTC.
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
function isDue(cron: string, now: Date): boolean {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  const local = new Date(now.getTime() + TBILISI_OFFSET_MS);
  const minute = local.getUTCMinutes();
  const hour   = local.getUTCHours();
  const day    = local.getUTCDate();
  const month  = local.getUTCMonth() + 1;
  const wday   = local.getUTCDay();
  return fieldMatches(m, minute, 0, 59)
    && fieldMatches(h, hour, 0, 23)
    && fieldMatches(dom, day, 1, 31)
    && fieldMatches(mon, month, 1, 12)
    && fieldMatches(dow, wday, 0, 6);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let body: any = {};
  try { body = await req.json(); } catch {}
  const forceId: number | null = body?.scheduleId ?? null;
  const force: boolean = !!body?.force;

  const now = new Date();
  const { data: schedules, error } = await supabase
    .from('social_post_schedules')
    .select('*')
    .eq('enabled', true);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const triggered: any[] = [];
  const skipped: any[] = [];

  for (const s of (schedules || [])) {
    if (forceId && s.id !== forceId) continue;
    if (s.end_at && new Date(s.end_at).getTime() < now.getTime()) {
      skipped.push({ id: s.id, reason: 'expired' });
      continue;
    }

    // Skip if already ran in the same minute (cron resolution).
    const lastRun = s.last_run_at ? new Date(s.last_run_at) : null;
    if (!force && lastRun) {
      const sameMinute = lastRun.getUTCFullYear() === now.getUTCFullYear()
        && lastRun.getUTCMonth() === now.getUTCMonth()
        && lastRun.getUTCDate() === now.getUTCDate()
        && lastRun.getUTCHours() === now.getUTCHours()
        && lastRun.getUTCMinutes() === now.getUTCMinutes();
      if (sameMinute) { skipped.push({ id: s.id, reason: 'already-ran-this-minute' }); continue; }
    }

    if (!force && !isDue(s.cron_expression, now)) {
      skipped.push({ id: s.id, reason: 'not-due' });
      continue;
    }

    const platforms: string[] = (s.target_platforms || []).filter(
      (p: string) => ['x', 'linkedin', 'facebook'].includes(p),
    );
    if (platforms.length === 0 || !s.ai_prompt) {
      skipped.push({ id: s.id, reason: 'missing-prompt-or-platforms' });
      continue;
    }

    // Mark last_run_at FIRST to avoid double-fire if pg_cron retries.
    await supabase.from('social_post_schedules')
      .update({ last_run_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('id', s.id);

    // Fire and forget — generate-social-post handles its own SSE / job row /
    // draft save / Telegram preview. We don't block on it.
    const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-social-post`;
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({
        prompt: s.ai_prompt,
        platforms,
        includeImage: s.include_image !== false,
        stream: false,
      }),
    }).catch((e) => console.error('[run-due-generations] invoke failed', s.id, e?.message));

    triggered.push({ id: s.id, name: s.name, platforms });
  }

  return new Response(JSON.stringify({ ok: true, triggered, skipped, now: now.toISOString() }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
