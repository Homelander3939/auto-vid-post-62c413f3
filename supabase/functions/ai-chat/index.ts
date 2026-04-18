import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const AI_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';
const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';

/* ── Tool definitions (full agentic surface) ─────────── */

const tools = [
  {
    type: 'function',
    function: {
      name: 'create_upload_job',
      description: 'Queue a video for immediate upload to one or more social platforms.',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string', description: 'Name of the video file (already uploaded to storage)' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          video_storage_path: { type: 'string' },
        },
        required: ['video_file_name', 'title', 'target_platforms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_upload',
      description: 'Schedule a video upload for a specific date/time (ISO 8601, Tbilisi GET timezone).',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          scheduled_at: { type: 'string' },
          video_storage_path: { type: 'string' },
        },
        required: ['video_file_name', 'title', 'target_platforms', 'scheduled_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_upload_job',
      description: 'Edit a queued upload job (title, description, tags, platforms).',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_upload_job',
      description: 'Delete an upload job by ID.',
      parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed_job',
      description: 'Retry a failed upload job.',
      parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_jobs_by_status',
      description: 'Bulk delete upload jobs with a given status ("failed", "completed", "pending") or "all".',
      parameters: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_scheduled_upload',
      description: 'Cancel a scheduled upload by ID.',
      parameters: { type: 'object', properties: { scheduled_id: { type: 'string' } }, required: ['scheduled_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_scheduled_upload',
      description: 'Edit a scheduled upload (title, description, tags, platforms, scheduled_at).',
      parameters: {
        type: 'object',
        properties: {
          scheduled_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          scheduled_at: { type: 'string' },
        },
        required: ['scheduled_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_cron_schedule',
      description: 'Update primary recurring upload cron (id=1).',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          cron_expression: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_recurring_schedule',
      description: 'Create, update, or delete a recurring upload schedule.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'delete'] },
          schedule_id: { type: 'number' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          cron_expression: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          folder_path: { type: 'string' },
          end_at: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_social_post',
      description: 'Use the Deep Research Agent to generate an AI social media post (with web research, sources, and platform-tailored variants). Optionally schedule it.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Topic or instructions for the post' },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['x', 'linkedin', 'facebook'] }, description: 'Social text platforms only — X (Twitter), LinkedIn, Facebook. Never tiktok/instagram/youtube here.' },
          include_image: { type: 'boolean' },
          scheduled_at: { type: 'string', description: 'Optional ISO datetime to schedule (omit to post immediately)' },
        },
        required: ['prompt', 'target_platforms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research_web',
      description: 'Run a deep web research task (multi-source) and return findings + source URLs. Uses configured research provider or local Playwright fallback.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          depth: { type: 'string', enum: ['light', 'standard', 'deep'] },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_platform_stats',
      description: 'Queue an engagement-stats scrape (views/likes/comments) on the local browser for YouTube, TikTok, Instagram, or all.',
      parameters: {
        type: 'object',
        properties: { platform: { type: 'string', enum: ['youtube', 'tiktok', 'instagram', 'all'] } },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_browser',
      description: 'Queue an arbitrary browser task on the user\'s local PC (e.g. "open my YouTube Studio analytics").',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['task'],
      },
    },
  },
];

/* ── Tool executor ────────────────────────────────────── */

function truncatePrompt(s: string, n = 80): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

async function executeTool(supabase: any, name: string, args: any, supabaseUrl: string, serviceKey: string): Promise<string> {
  switch (name) {
    case 'create_upload_job': {
      const platforms = args.target_platforms || [];
      const platformResults = platforms.map((p: string) => ({ name: p, status: 'pending' }));
      const { data, error } = await supabase.from('upload_jobs').insert({
        video_file_name: args.video_file_name,
        title: args.title || '',
        description: args.description || '',
        tags: args.tags || [],
        target_platforms: platforms,
        status: 'pending',
        video_storage_path: args.video_storage_path || null,
        platform_results: platformResults,
      }).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Queued "${data.title}" → ${data.target_platforms.join(', ')} (id ${data.id.slice(0, 8)})`;
    }
    case 'schedule_upload': {
      const { data, error } = await supabase.from('scheduled_uploads').insert({
        video_file_name: args.video_file_name,
        title: args.title || '',
        description: args.description || '',
        tags: args.tags || [],
        target_platforms: args.target_platforms || [],
        scheduled_at: args.scheduled_at,
        status: 'scheduled',
        video_storage_path: args.video_storage_path || null,
      }).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Scheduled "${data.title}" for ${new Date(data.scheduled_at).toLocaleString()} → ${data.target_platforms.join(', ')}`;
    }
    case 'edit_upload_job': {
      const updates: any = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.target_platforms !== undefined) updates.target_platforms = args.target_platforms;
      const { data, error } = await supabase.from('upload_jobs').update(updates).eq('id', args.job_id).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Updated "${data.title}".`;
    }
    case 'delete_upload_job': {
      const { error } = await supabase.from('upload_jobs').delete().eq('id', args.job_id);
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Job ${args.job_id.slice(0, 8)} deleted.`;
    }
    case 'retry_failed_job': {
      const { data, error } = await supabase.from('upload_jobs')
        .update({ status: 'pending', completed_at: null, platform_results: [] })
        .eq('id', args.job_id).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ "${data.title || data.video_file_name}" reset to pending.`;
    }
    case 'clear_jobs_by_status': {
      let query = supabase.from('upload_jobs').delete();
      if (args.status !== 'all') query = query.eq('status', args.status);
      else query = query.neq('id', '00000000-0000-0000-0000-000000000000');
      const { error } = await query;
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Cleared ${args.status} jobs.`;
    }
    case 'delete_scheduled_upload': {
      const { error } = await supabase.from('scheduled_uploads').delete().eq('id', args.scheduled_id);
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Scheduled upload deleted.`;
    }
    case 'edit_scheduled_upload': {
      const updates: any = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.target_platforms !== undefined) updates.target_platforms = args.target_platforms;
      if (args.scheduled_at !== undefined) updates.scheduled_at = args.scheduled_at;
      const { data, error } = await supabase.from('scheduled_uploads').update(updates).eq('id', args.scheduled_id).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Updated scheduled "${data.title}".`;
    }
    case 'update_cron_schedule': {
      const update: any = {};
      if (args.enabled !== undefined) update.enabled = args.enabled;
      if (args.cron_expression) update.cron_expression = args.cron_expression;
      if (args.platforms) update.platforms = args.platforms;
      const { data, error } = await supabase.from('schedule_config').update(update).eq('id', 1).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Cron: ${data.enabled ? 'ON' : 'OFF'} | ${data.cron_expression} | ${data.platforms.join(', ')}`;
    }
    case 'manage_recurring_schedule': {
      if (args.action === 'delete') {
        if (!args.schedule_id) return '❌ Need schedule_id.';
        const { error } = await supabase.from('schedule_config').delete().eq('id', args.schedule_id);
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Recurring schedule #${args.schedule_id} deleted.`;
      }
      if (args.action === 'create') {
        const payload = {
          name: args.name || 'Schedule',
          enabled: args.enabled ?? false,
          cron_expression: args.cron_expression || '0 9 * * *',
          platforms: args.platforms || ['youtube'],
          folder_path: args.folder_path || '',
          end_at: args.end_at || null,
        };
        const { data, error } = await supabase.from('schedule_config').insert(payload).select().single();
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Created "${data.name}" (#${data.id}).`;
      }
      if (args.action === 'update') {
        if (!args.schedule_id) return '❌ Need schedule_id.';
        const updates: any = {};
        for (const k of ['name', 'enabled', 'cron_expression', 'platforms', 'folder_path', 'end_at']) {
          if (args[k] !== undefined) updates[k] = args[k];
        }
        const { data, error } = await supabase.from('schedule_config').update(updates).eq('id', args.schedule_id).select().single();
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Updated "${data.name}".`;
      }
      return '❌ Unknown action.';
    }
    case 'generate_social_post': {
      // IMPORTANT: Do NOT pre-insert a 'pending' social_posts row — that would
      // make the local socialPostProcessor try to publish an empty post immediately.
      // Instead, mirror the in-app "Generate" button: kick the deep-research agent,
      // which will run the full visual generation flow, save the result as a DRAFT
      // on /social, and send a Telegram preview. The user then explicitly replies
      // "post" / "edit <text>" / "skip" in Telegram to publish or discard.
      //
      // Scheduling path is the only case where we DO insert a row up-front (status
      // 'scheduled') so the scheduler can pick it up at the requested time after
      // the draft is generated and approved.
      try {
        const kickBody: Record<string, unknown> = {
          prompt: args.prompt,
          platforms: args.target_platforms || ['x'],
          includeImage: args.include_image !== false,
          stream: false,
        };
        // Fire-and-forget — generation streams via SSE, saves draft, notifies Telegram.
        void fetch(`${supabaseUrl}/functions/v1/generate-social-post`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(kickBody),
        }).catch((e) => console.warn('generate-social-post kick failed:', e));
      } catch (e) {
        console.warn('generate-social-post kick threw:', e);
        return `❌ Failed to start generation: ${(e as Error).message}`;
      }
      const platformsLabel = (args.target_platforms || ['x']).join(', ');
      return `✨ Generating your draft post about "${truncatePrompt(args.prompt)}" for ${platformsLabel} now — exactly like clicking Generate in the app. I'll send you the full draft (image + per-platform variants + sources) in Telegram in 1-2 minutes. Reply "post" to publish, "edit <text>" to revise, or "skip" to discard. Nothing will be published until you approve.`;
    }
    case 'research_web': {
      const { error } = await supabase.from('pending_commands').insert({
        command: 'research',
        args: { query: args.query, depth: args.depth || 'standard' },
        status: 'pending',
      });
      if (error) return `❌ Failed to queue research: ${error.message}`;
      return `🔍 Deep research queued for "${args.query}". Findings + sources will arrive via Telegram in 1-3 minutes.`;
    }
    case 'check_platform_stats': {
      const { error } = await supabase.from('pending_commands').insert({
        command: 'check_stats',
        args: { platform: args.platform || 'all' },
        status: 'pending',
      });
      if (error) return `❌ ${error.message}`;
      return `📊 Stats scrape queued for ${args.platform}. Results in Telegram within ~60s.`;
    }
    case 'open_browser': {
      const { error } = await supabase.from('pending_commands').insert({
        command: 'open_browser',
        args: { task: args.task, url: args.url || null },
        status: 'pending',
      });
      if (error) return `❌ ${error.message}`;
      return `🌐 Browser task queued: "${args.task}". Updates via Telegram.`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/* ── Lightweight context ──────────────────────────────── */

async function getAppContextFast(supabase: any): Promise<string> {
  const [
    { data: jobs },
    { data: scheduled },
    { data: settings },
    { data: scheduleConfigs },
    { data: socialPosts },
  ] = await Promise.all([
    supabase.from('upload_jobs').select('id,title,video_file_name,status,target_platforms').order('created_at', { ascending: false }).limit(10),
    supabase.from('scheduled_uploads').select('id,title,video_file_name,status,target_platforms,scheduled_at').eq('status', 'scheduled').order('scheduled_at', { ascending: true }).limit(5),
    supabase.from('app_settings').select('youtube_enabled,tiktok_enabled,instagram_enabled,telegram_enabled,folder_path,research_provider,image_provider,ai_provider,ai_model').eq('id', 1).single(),
    supabase.from('schedule_config').select('id,name,enabled,cron_expression,platforms').order('id', { ascending: true }),
    supabase.from('social_posts').select('id,status,target_platforms,ai_prompt').order('created_at', { ascending: false }).limit(5),
  ]);

  const j = jobs || [];
  const counts = {
    pending: j.filter((x: any) => x.status === 'pending').length,
    processing: j.filter((x: any) => x.status === 'processing').length,
    failed: j.filter((x: any) => x.status === 'failed').length,
    done: j.filter((x: any) => x.status === 'completed').length,
  };

  const platforms: string[] = [];
  if (settings?.youtube_enabled) platforms.push('YouTube');
  if (settings?.tiktok_enabled) platforms.push('TikTok');
  if (settings?.instagram_enabled) platforms.push('Instagram');

  let ctx = `=== LIVE APP STATE (Tbilisi GET timezone) ===\n`;
  ctx += `Video platforms enabled: ${platforms.join(', ') || 'None'}\n`;
  ctx += `Upload queue: ${counts.pending} pending, ${counts.processing} processing, ${counts.done} done, ${counts.failed} failed\n`;
  ctx += `AI model: ${settings?.ai_provider || 'lovable'} / ${settings?.ai_model || 'auto'} | Research: ${settings?.research_provider || 'auto'} | Images: ${settings?.image_provider || 'auto'}\n`;

  if (counts.failed > 0) {
    ctx += `Failed jobs: ${j.filter((x: any) => x.status === 'failed').map((x: any) => `[${x.id.slice(0, 8)}] "${x.title || x.video_file_name}"`).join(', ')}\n`;
  }
  if (counts.pending > 0) {
    ctx += `Pending: ${j.filter((x: any) => x.status === 'pending').map((x: any) => `[${x.id.slice(0, 8)}] "${x.title || x.video_file_name}"`).join(', ')}\n`;
  }
  if ((scheduled || []).length > 0) {
    ctx += `Scheduled video uploads: ${(scheduled || []).map((s: any) => `"${s.title || s.video_file_name}" at ${new Date(s.scheduled_at).toLocaleString()}`).join('; ')}\n`;
  }
  if ((scheduleConfigs || []).length > 0) {
    ctx += `Recurring schedules:\n${(scheduleConfigs || []).map((c: any) => `  #${c.id} "${c.name}" ${c.enabled ? 'ON' : 'OFF'} | ${c.cron_expression} | ${(c.platforms || []).join(',')}`).join('\n')}\n`;
  }
  if ((socialPosts || []).length > 0) {
    ctx += `Recent social posts: ${(socialPosts || []).map((p: any) => `[${p.status}] ${(p.ai_prompt || '').slice(0, 40)}`).join(' | ')}\n`;
  }
  ctx += '===';
  return ctx;
}

/* ── System prompt ────────────────────────────────────── */

function buildSystemPrompt(appContext: string, isTelegram = false): string {
  const fmt = isTelegram
    ? 'Plain text only — NO markdown asterisks/backticks. Use line breaks and emoji for structure. Be concise.'
    : 'Use markdown for rich formatting.';
  return `You are the autonomous AI agent for an Uploadphy — a multi-platform video & social-post automation app.

${appContext}

## Your capabilities (call tools, do not just describe)
- **Video uploads**: create_upload_job, schedule_upload, edit_upload_job, delete_upload_job, retry_failed_job, clear_jobs_by_status
- **Scheduling**: schedule_upload, edit_scheduled_upload, delete_scheduled_upload, update_cron_schedule, manage_recurring_schedule
- **Social posts (deep research agent)**: generate_social_post — multi-step plan → search → scrape → write → image, with sources
- **Web research**: research_web — autonomous web research with configured provider or local browser fallback
- **Stats scraping**: check_platform_stats — queues Playwright scrape on user's local PC, results via Telegram
- **Generic browser tasks**: open_browser — runs any natural-language browser task locally

## Behavior rules
- Be PROACTIVE. If the user says "post about X to Twitter at 9pm tomorrow" → call generate_social_post with scheduled_at.
- CRITICAL — generate_social_post NEVER auto-publishes. It runs the full in-app generation flow (research → image → per-platform variants), saves the result as a DRAFT on /social, and sends a Telegram preview. The user must reply "post" / "edit <text>" / "skip" in Telegram to actually publish, revise, or discard. Always make this clear in your reply ("I'll send you the draft to review — nothing will be posted until you approve").
- Mirror the in-app experience: when the user asks from Telegram to generate a post, it should produce the same result as opening the Generate Post page, typing the prompt, and clicking Generate — same visual progress feed, same draft, same Telegram preview. Other agentic flows (research, stats, browser tasks) follow the same pattern: queue the task, run it exactly like the in-app button does, and report back via Telegram.
- If user asks for stats/views/engagement → ALWAYS call check_platform_stats (do not hallucinate numbers).
- If user asks to research something → call research_web (do not answer from memory if it's news/recent).
- If user asks "what's pending / what's scheduled" → answer from the LIVE APP STATE above.
- All times are Tbilisi GET (UTC+4). Convert relative times like "tomorrow 9am" to ISO 8601.
- ${fmt}`;
}

/* ── Helper: send to Telegram ─────────────────────────── */

async function sendTelegram(chatId: string | number, text: string, lovableKey: string, telegramKey: string) {
  try {
    await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableKey}`,
        'X-Connection-Api-Key': telegramKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    });
  } catch (e) {
    console.error('Telegram send failed:', e);
  }
}

/* ── Non-streaming agent loop (used for Telegram mode) ─ */

async function runAgentNonStreaming(
  supabase: any,
  fullMessages: any[],
  model: string,
  lovableKey: string,
  supabaseUrl: string,
  serviceKey: string,
  maxSteps = 4,
): Promise<string> {
  for (let step = 0; step < maxSteps; step++) {
    const r = await fetch(AI_GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lovableKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: fullMessages, tools, tool_choice: 'auto' }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`AI gateway ${r.status}: ${t.slice(0, 300)}`);
    }
    const data = await r.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) return 'No response.';
    fullMessages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        const result = await executeTool(supabase, tc.function.name, args, supabaseUrl, serviceKey);
        fullMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
    }

    return msg.content || '✅ Done.';
  }
  return '⚠️ Agent reached max iterations.';
}

/* ── Main handler ─────────────────────────────────────── */

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const { messages, telegram_chat_id, telegram_user_text } = body;

    /* ── TELEGRAM MODE: single user text → reply directly to chat ── */
    if (telegram_chat_id && typeof telegram_user_text === 'string') {
      const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
      if (!TELEGRAM_API_KEY) {
        return new Response(JSON.stringify({ error: 'TELEGRAM_API_KEY not configured' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Pull recent telegram chat history for context
      const { data: history } = await supabase
        .from('telegram_messages')
        .select('text,is_bot,created_at')
        .eq('chat_id', telegram_chat_id)
        .order('created_at', { ascending: false })
        .limit(10);

      const ctx = await getAppContextFast(supabase);
      const sys = buildSystemPrompt(ctx, true);
      const historyMsgs = ((history || []) as any[])
        .reverse()
        .filter((m) => m.text)
        .map((m) => ({ role: m.is_bot ? 'assistant' : 'user', content: m.text }));

      const fullMessages = [
        { role: 'system', content: sys },
        ...historyMsgs,
        { role: 'user', content: telegram_user_text },
      ];

      try {
        const reply = await runAgentNonStreaming(
          supabase, fullMessages, 'google/gemini-2.5-flash', LOVABLE_API_KEY, supabaseUrl, serviceKey,
        );
        await sendTelegram(telegram_chat_id, reply, LOVABLE_API_KEY, TELEGRAM_API_KEY);

        // Mirror bot reply to telegram_messages so UI sees it
        await supabase.from('telegram_messages').insert({
          update_id: -Math.floor(Date.now()),
          chat_id: telegram_chat_id,
          text: reply.slice(0, 3000),
          is_bot: true,
          raw_update: { source: 'ai-chat-edge' },
        });

        return new Response(JSON.stringify({ ok: true, reply }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        const msg = `⚠️ AI processing failed: ${e instanceof Error ? e.message : 'unknown error'}`;
        await sendTelegram(telegram_chat_id, msg, LOVABLE_API_KEY, TELEGRAM_API_KEY);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    /* ── WEB MODE: streaming with tool support ── */
    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'messages array is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const appContextPromise = getAppContextFast(supabase);

    const transformedMessages = messages.map((msg: any) => {
      if (msg.role === 'system') return msg;
      if (msg.images && msg.images.length > 0) {
        const content: any[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const img of msg.images) content.push({ type: 'image_url', image_url: { url: img.url } });
        return { role: msg.role, content };
      }
      if (msg.files && msg.files.length > 0) {
        let fileContext = msg.content || '';
        for (const file of msg.files) {
          fileContext += `\n\n[Attached file: ${file.name} (${file.type}, ${file.size})]`;
          if (file.textContent) fileContext += `\nFile contents:\n\`\`\`\n${file.textContent}\n\`\`\``;
        }
        return { role: msg.role, content: fileContext };
      }
      return { role: msg.role, content: msg.content };
    });

    const appContext = await appContextPromise;
    const systemPrompt = buildSystemPrompt(appContext, false);
    const hasImages = messages.some((m: any) => m.images && m.images.length > 0);
    const model = hasImages ? 'google/gemini-2.5-flash' : 'google/gemini-3-flash-preview';

    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...transformedMessages,
    ];

    const aiResp = await fetch(AI_GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: fullMessages, tools, tool_choice: 'auto', stream: true }),
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded.' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted. Add funds in Workspace Settings → Usage.' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const t = await aiResp.text();
      console.error('AI error:', aiResp.status, t);
      return new Response(JSON.stringify({ error: 'AI service error' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const reader = aiResp.body!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let sseBuffer = '';
    const toolCalls: any[] = [];
    const contentChunks: string[] = [];

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    (async () => {
      try {
        let isToolCall = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = sseBuffer.indexOf('\n')) !== -1) {
            let line = sseBuffer.slice(0, idx);
            sseBuffer = sseBuffer.slice(idx + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line.startsWith(':') || line.trim() === '') continue;
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(jsonStr);
              const choice = parsed.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta || {};

              if (delta.tool_calls) {
                isToolCall = true;
                for (const tc of delta.tool_calls) {
                  const i = tc.index ?? toolCalls.length;
                  if (!toolCalls[i]) toolCalls[i] = { id: tc.id || '', function: { name: '', arguments: '' } };
                  if (tc.id) toolCalls[i].id = tc.id;
                  if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
                }
              }

              if (delta.content && !isToolCall) {
                contentChunks.push(delta.content);
                const chunk = JSON.stringify({ choices: [{ delta: { content: delta.content } }] });
                await writer.write(encoder.encode(`data: ${chunk}\n\n`));
              } else if (delta.content) {
                contentChunks.push(delta.content);
              }
            } catch {
              sseBuffer = line + '\n' + sseBuffer;
              break;
            }
          }
        }

        if (isToolCall && toolCalls.length > 0) {
          // Stream a small status indicator
          const statusChunk = JSON.stringify({ choices: [{ delta: { content: `\n\n🛠️ Running ${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''}...\n\n` } }] });
          await writer.write(encoder.encode(`data: ${statusChunk}\n\n`));

          fullMessages.push({
            role: 'assistant',
            content: contentChunks.join('') || null,
            tool_calls: toolCalls.map((tc, i) => ({
              id: tc.id || `call_${i}`,
              type: 'function',
              function: tc.function,
            })),
          });

          for (const tc of toolCalls) {
            let args: any = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* */ }
            console.log(`Tool: ${tc.function.name}`, args);
            const result = await executeTool(supabase, tc.function.name, args, supabaseUrl, serviceKey);
            fullMessages.push({ role: 'tool', tool_call_id: tc.id || 'call_0', content: result });
          }

          const resp2 = await fetch(AI_GATEWAY, {
            method: 'POST',
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: fullMessages, stream: true }),
          });

          if (resp2.ok && resp2.body) {
            const reader2 = resp2.body.getReader();
            let buf2 = '';
            while (true) {
              const { done, value } = await reader2.read();
              if (done) break;
              buf2 += decoder.decode(value, { stream: true });
              let idx2: number;
              while ((idx2 = buf2.indexOf('\n')) !== -1) {
                let line2 = buf2.slice(0, idx2);
                buf2 = buf2.slice(idx2 + 1);
                if (line2.endsWith('\r')) line2 = line2.slice(0, -1);
                if (line2.startsWith(':') || line2.trim() === '') continue;
                if (!line2.startsWith('data: ')) continue;
                const js2 = line2.slice(6).trim();
                if (js2 === '[DONE]') continue;
                try {
                  const p2 = JSON.parse(js2);
                  const c2 = p2.choices?.[0]?.delta?.content;
                  if (c2) {
                    const chunk = JSON.stringify({ choices: [{ delta: { content: c2 } }] });
                    await writer.write(encoder.encode(`data: ${chunk}\n\n`));
                  }
                } catch { /* */ }
              }
            }
          } else {
            const toolResults = fullMessages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n');
            const chunk = JSON.stringify({ choices: [{ delta: { content: toolResults || '✅ Actions completed.' } }] });
            await writer.write(encoder.encode(`data: ${chunk}\n\n`));
          }
        }

        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error('Stream error:', e);
        const errChunk = JSON.stringify({ choices: [{ delta: { content: '\n\n⚠️ Error processing your request.' } }] });
        await writer.write(encoder.encode(`data: ${errChunk}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' },
    });
  } catch (e) {
    console.error('chat error:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

export { tools, executeTool, getAppContextFast as getAppContext, buildSystemPrompt };
