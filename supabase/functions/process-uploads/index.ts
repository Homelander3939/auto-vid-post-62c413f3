import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');

  // Get settings
  const { data: settings } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .single();

  if (!settings) {
    return new Response(JSON.stringify({ ok: false, error: 'No settings found' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const uploadMode = (settings as any).upload_mode || 'local';

  // === LOCAL MODE: only handle stale job cleanup, do NOT process uploads ===
  // Local uploads are handled by the local Node.js server via Playwright.
  if (uploadMode === 'local') {
    // Still fix stale jobs so UI stays accurate
    await fixStaleJobs(supabase, settings, LOVABLE_API_KEY, TELEGRAM_API_KEY);
    return new Response(JSON.stringify({ ok: true, mode: 'local', processed: 0, message: 'Local mode — uploads handled by local server' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // === CLOUD MODE: process via Browserbase ===
  const configuredTelegramChatId = settings?.telegram_chat_id;

  async function resolveTelegramChatId(): Promise<number | null> {
    if (configuredTelegramChatId && Number.isFinite(Number(configuredTelegramChatId))) {
      return Number(configuredTelegramChatId);
    }
    const { data: latestMessage } = await supabase
      .from('telegram_messages')
      .select('chat_id')
      .eq('is_bot', false)
      .order('created_at', { ascending: false })
      .limit(1);
    const fallbackId = latestMessage?.[0]?.chat_id;
    if (!fallbackId || !Number.isFinite(Number(fallbackId))) return null;
    const numericFallbackId = Number(fallbackId);
    await supabase.from('app_settings').update({ telegram_chat_id: String(numericFallbackId) }).eq('id', 1);
    return numericFallbackId;
  }

  const resolvedTelegramChatId = await resolveTelegramChatId();
  const telegramEnabled = Boolean(settings?.telegram_enabled && TELEGRAM_API_KEY && LOVABLE_API_KEY && resolvedTelegramChatId);

  async function notifyTelegram(text: string) {
    if (!telegramEnabled || !resolvedTelegramChatId) return;
    try {
      await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'X-Connection-Api-Key': TELEGRAM_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chat_id: resolvedTelegramChatId, text, parse_mode: 'HTML' }),
      });
    } catch (e) {
      console.error('Telegram notification failed:', e);
    }
  }

  // Fix stale jobs
  await fixStaleJobs(supabase, settings, LOVABLE_API_KEY, TELEGRAM_API_KEY);

  // Fetch pending jobs
  const { data: jobs } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(5);

  if (!jobs || jobs.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let totalProcessed = 0;

  for (const job of jobs) {
    const platformResults = (job.platform_results as any[]) || [];

    await supabase.from('upload_jobs').update({ status: 'uploading' }).eq('id', job.id);

    for (const pr of platformResults) {
      if (pr.status !== 'pending') continue;

      const platEmail = settings[`${pr.name}_email`] || '';
      const platPassword = settings[`${pr.name}_password`] || '';
      const platEnabled = settings[`${pr.name}_enabled`];

      if (!platEnabled) {
        pr.status = 'error';
        pr.error = `${pr.name} is not enabled in Settings.`;
        await supabase.from('upload_jobs').update({ platform_results: platformResults }).eq('id', job.id);
        continue;
      }

      if (!platEmail || !platPassword) {
        pr.status = 'error';
        pr.error = `${pr.name} credentials missing. Add email and password in Settings.`;
        await supabase.from('upload_jobs').update({ platform_results: platformResults }).eq('id', job.id);
        continue;
      }

      pr.status = 'uploading';
      await supabase.from('upload_jobs').update({ platform_results: platformResults }).eq('id', job.id);

      try {
        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => controller.abort(), 540000);

        const cloudResp = await fetch(`${supabaseUrl}/functions/v1/cloud-browser-upload`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            job_id: job.id,
            platform: pr.name,
            credentials: { email: platEmail, password: platPassword },
          }),
          signal: controller.signal,
        });
        clearTimeout(fetchTimeout);

        const cloudRaw = await cloudResp.text();
        let cloudData: any;
        try { cloudData = JSON.parse(cloudRaw); } catch {
          throw new Error(`Cloud browser returned invalid response [${cloudResp.status}]`);
        }

        if (!cloudResp.ok || !cloudData.success) {
          throw new Error(cloudData?.error || `Cloud upload failed [${cloudResp.status}]`);
        }

        pr.status = 'success';
        pr.url = cloudData.url || '';
      } catch (e: any) {
        pr.status = 'error';
        pr.error = e.name === 'AbortError' ? 'Cloud session timed out (9 min)' : (e.message || 'Upload failed');
      }

      await supabase.from('upload_jobs').update({ platform_results: platformResults }).eq('id', job.id);
    }

    // Final status
    const allDone = platformResults.every((p: any) => p.status === 'success' || p.status === 'error');
    const allSuccess = platformResults.every((p: any) => p.status === 'success');
    const anySuccess = platformResults.some((p: any) => p.status === 'success');
    const finalStatus = allDone
      ? (allSuccess ? 'completed' : (anySuccess ? 'partial' : 'failed'))
      : 'pending';

    await supabase.from('upload_jobs').update({
      platform_results: platformResults,
      status: finalStatus,
      completed_at: allDone ? new Date().toISOString() : null,
    }).eq('id', job.id);

    if (allDone) {
      const summary = platformResults.map((p: any) => {
        if (p.status === 'success') return `✅ ${p.name}: uploaded${p.url ? ` — ${p.url}` : ''}`;
        return `❌ ${p.name}: ${p.error || 'failed'}`;
      }).join('\n');
      await notifyTelegram(`📋 <b>Upload Summary</b>\n📹 ${job.title || job.video_file_name}\n\n${summary}`);
    }

    totalProcessed++;
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

// Shared stale job fixer
async function fixStaleJobs(supabase: any, settings: any, lovableApiKey: string | undefined, telegramApiKey: string | undefined) {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: staleJobs } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('status', 'uploading')
    .lt('created_at', staleThreshold);

  if (!staleJobs || staleJobs.length === 0) return;

  for (const stale of staleJobs) {
    const pr = (stale.platform_results as any[]) || [];
    let changed = false;
    for (const p of pr) {
      if (p.status === 'uploading') {
        p.status = 'error';
        p.error = 'Upload timed out or session crashed.';
        changed = true;
      }
    }
    if (changed) {
      const allDone = pr.every((p: any) => p.status === 'success' || p.status === 'error');
      const finalStatus = allDone
        ? (pr.every((p: any) => p.status === 'success') ? 'completed' : (pr.some((p: any) => p.status === 'success') ? 'partial' : 'failed'))
        : 'failed';
      await supabase.from('upload_jobs').update({
        platform_results: pr,
        status: finalStatus,
        completed_at: new Date().toISOString(),
      }).eq('id', stale.id);
    }
  }
}
