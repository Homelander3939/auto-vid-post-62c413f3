import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';
const AI_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';
const MAX_RUNTIME_MS = 55_000;
const MIN_REMAINING_MS = 5_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

async function getAppContext(supabase: any): Promise<string> {
  const [
    { data: jobs },
    { data: scheduled },
    { data: settings },
    { data: scheduleConfig },
  ] = await Promise.all([
    supabase.from('upload_jobs').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('scheduled_uploads').select('*').order('scheduled_at', { ascending: true }).limit(20),
    supabase.from('app_settings').select('*').eq('id', 1).single(),
    supabase.from('schedule_config').select('*').eq('id', 1).single(),
  ]);

  const pendingJobs = (jobs || []).filter((j: any) => j.status === 'pending');
  const processingJobs = (jobs || []).filter((j: any) => j.status === 'processing');
  const completedJobs = (jobs || []).filter((j: any) => j.status === 'completed');
  const failedJobs = (jobs || []).filter((j: any) => j.status === 'failed');

  const upcomingScheduled = (scheduled || []).filter((s: any) => s.status === 'scheduled');

  const formatJob = (j: any) =>
    `• "${j.title || j.video_file_name}" → ${j.target_platforms?.join(', ') || 'none'} [${j.status}]`;

  const formatScheduled = (s: any) =>
    `• "${s.title || s.video_file_name}" → ${new Date(s.scheduled_at).toLocaleString()} [${s.status}]`;

  const platformStatus = [];
  if (settings) {
    if (settings.youtube_enabled) platformStatus.push('YouTube ✓');
    if (settings.tiktok_enabled) platformStatus.push('TikTok ✓');
    if (settings.instagram_enabled) platformStatus.push('Instagram ✓');
  }

  return `
=== LIVE APP DATA ===
Platforms: ${platformStatus.join(', ') || 'None'}
Queue: ${pendingJobs.length} pending, ${processingJobs.length} processing, ${completedJobs.length} done, ${failedJobs.length} failed
${pendingJobs.length > 0 ? `Pending:\n${pendingJobs.map(formatJob).join('\n')}` : 'No pending jobs.'}
${failedJobs.length > 0 ? `Failed:\n${failedJobs.map(formatJob).join('\n')}` : ''}
${completedJobs.length > 0 ? `Recent done:\n${completedJobs.slice(0, 3).map(formatJob).join('\n')}` : ''}
Scheduled: ${upcomingScheduled.length} upcoming
${upcomingScheduled.length > 0 ? upcomingScheduled.map(formatScheduled).join('\n') : ''}
===`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) return errResp('LOVABLE_API_KEY not configured');

  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
  if (!TELEGRAM_API_KEY) return errResp('TELEGRAM_API_KEY not configured');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let totalProcessed = 0;

  const { data: state, error: stateErr } = await supabase
    .from('telegram_bot_state')
    .select('update_offset')
    .eq('id', 1)
    .single();

  if (stateErr) return errResp(stateErr.message);

  let currentOffset = state.update_offset;

  while (true) {
    const elapsed = Date.now() - startTime;
    const remainingMs = MAX_RUNTIME_MS - elapsed;
    if (remainingMs < MIN_REMAINING_MS) break;

    const timeout = Math.min(50, Math.floor(remainingMs / 1000) - 5);
    if (timeout < 1) break;

    const response = await fetch(`${TELEGRAM_GATEWAY}/getUpdates`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'X-Connection-Api-Key': TELEGRAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        offset: currentOffset,
        timeout,
        allowed_updates: ['message'],
      }),
    });

    const data = await response.json();
    if (!response.ok) return errResp(JSON.stringify(data), 502);

    const updates = data.result ?? [];
    if (updates.length === 0) continue;

    for (const update of updates) {
      if (!update.message?.text) continue;
      const chatId = update.message.chat.id;
      const userText = update.message.text;

      // Get conversation history
      const { data: history } = await supabase
        .from('telegram_messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(10);

      const contextMessages = (history || []).reverse().map((m: any) => ({
        role: m.is_bot ? 'assistant' : 'user',
        content: m.text,
      }));

      contextMessages.push({ role: 'user', content: userText });

      // Store user message
      await supabase.from('telegram_messages').upsert({
        update_id: update.update_id,
        chat_id: chatId,
        text: userText,
        is_bot: false,
        raw_update: update,
      }, { onConflict: 'update_id' });

      // Get live app context for AI
      const appContext = await getAppContext(supabase);

      // Call AI with app context
      let aiReply = "Sorry, I couldn't process your message right now.";
      try {
        const aiResp = await fetch(AI_GATEWAY, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'google/gemini-3-flash-preview',
            messages: [
              {
                role: 'system',
                content: `You are a helpful AI assistant for the Video Uploader app. You have FULL ACCESS to the app's live data.

${appContext}

You help users manage video uploads to YouTube, TikTok, and Instagram. Be concise for Telegram format.
When users ask about queued jobs, scheduled uploads, or settings — USE THE LIVE DATA ABOVE to answer accurately.
NEVER say you don't have access to the data. You DO have access.
Keep responses short and formatted for Telegram (use simple markdown).`,
              },
              ...contextMessages,
            ],
          }),
        });

        if (aiResp.ok) {
          const aiData = await aiResp.json();
          aiReply = aiData.choices?.[0]?.message?.content || aiReply;
        }
      } catch (e) {
        console.error('AI call failed:', e);
      }

      // Send reply via Telegram
      await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'X-Connection-Api-Key': TELEGRAM_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: aiReply,
          parse_mode: 'Markdown',
        }),
      });

      // Store bot reply
      await supabase.from('telegram_messages').insert({
        update_id: update.update_id + 1000000000,
        chat_id: chatId,
        text: aiReply,
        is_bot: true,
        raw_update: { bot_reply: true },
      });

      totalProcessed++;
    }

    const newOffset = Math.max(...updates.map((u: any) => u.update_id)) + 1;
    await supabase
      .from('telegram_bot_state')
      .update({ update_offset: newOffset, updated_at: new Date().toISOString() })
      .eq('id', 1);

    currentOffset = newOffset;
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

function errResp(msg: string, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
