import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const AI_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';

/* ── Tool definitions ─────────────────────────────────── */

const tools = [
  {
    type: 'function',
    function: {
      name: 'create_upload_job',
      description: 'Create a new video upload job in the queue. Use when user wants to upload a video to platforms.',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string', description: 'Name of the video file' },
          title: { type: 'string', description: 'Video title for platforms' },
          description: { type: 'string', description: 'Video description' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags/hashtags for the video' },
          target_platforms: {
            type: 'array',
            items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] },
            description: 'Platforms to upload to',
          },
          video_storage_path: { type: 'string', description: 'Storage path if video was already uploaded' },
        },
        required: ['video_file_name', 'title', 'target_platforms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_upload',
      description: 'Schedule a video upload for a specific date/time.',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string', description: 'Name of the video file' },
          title: { type: 'string', description: 'Video title' },
          description: { type: 'string', description: 'Video description' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags/hashtags' },
          target_platforms: {
            type: 'array',
            items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] },
            description: 'Platforms to upload to',
          },
          scheduled_at: { type: 'string', description: 'ISO 8601 datetime for when to upload (e.g. 2026-03-21T09:00:00Z)' },
          video_storage_path: { type: 'string', description: 'Storage path if video was already uploaded' },
        },
        required: ['video_file_name', 'title', 'target_platforms', 'scheduled_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_cron_schedule',
      description: 'Update the automatic upload cron schedule settings.',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'Enable or disable the cron schedule' },
          cron_expression: { type: 'string', description: 'Cron expression (e.g. "0 9 * * *" for daily at 9am)' },
          platforms: {
            type: 'array',
            items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] },
            description: 'Platforms for scheduled uploads',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_upload_job',
      description: 'Delete/cancel an upload job by its ID.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'The UUID of the upload job to delete' },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed_job',
      description: 'Retry a failed upload job by resetting its status to pending.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'The UUID of the failed job to retry' },
        },
        required: ['job_id'],
      },
    },
  },
];

/* ── Tool executor ────────────────────────────────────── */

async function executeTool(supabase: any, name: string, args: any): Promise<string> {
  switch (name) {
    case 'create_upload_job': {
      const { data, error } = await supabase.from('upload_jobs').insert({
        video_file_name: args.video_file_name,
        title: args.title || '',
        description: args.description || '',
        tags: args.tags || [],
        target_platforms: args.target_platforms || [],
        status: 'pending',
        video_storage_path: args.video_storage_path || null,
      }).select().single();
      if (error) return `❌ Failed to create job: ${error.message}`;
      return `✅ Upload job created!\nID: ${data.id}\nTitle: "${data.title}"\nFile: ${data.video_file_name}\nPlatforms: ${data.target_platforms.join(', ')}\nStatus: pending`;
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
      if (error) return `❌ Failed to schedule: ${error.message}`;
      return `✅ Upload scheduled!\nID: ${data.id}\nTitle: "${data.title}"\nFile: ${data.video_file_name}\nPlatforms: ${data.target_platforms.join(', ')}\nScheduled: ${new Date(data.scheduled_at).toLocaleString()}`;
    }

    case 'update_cron_schedule': {
      const update: any = {};
      if (args.enabled !== undefined) update.enabled = args.enabled;
      if (args.cron_expression) update.cron_expression = args.cron_expression;
      if (args.platforms) update.platforms = args.platforms;

      const { data, error } = await supabase.from('schedule_config')
        .update(update).eq('id', 1).select().single();
      if (error) return `❌ Failed to update cron: ${error.message}`;
      return `✅ Cron schedule updated!\nEnabled: ${data.enabled}\nExpression: ${data.cron_expression}\nPlatforms: ${data.platforms.join(', ')}`;
    }

    case 'delete_upload_job': {
      const { error } = await supabase.from('upload_jobs').delete().eq('id', args.job_id);
      if (error) return `❌ Failed to delete job: ${error.message}`;
      return `✅ Job ${args.job_id} deleted.`;
    }

    case 'retry_failed_job': {
      const { data, error } = await supabase.from('upload_jobs')
        .update({ status: 'pending', completed_at: null, platform_results: [] })
        .eq('id', args.job_id)
        .select().single();
      if (error) return `❌ Failed to retry job: ${error.message}`;
      return `✅ Job "${data.title || data.video_file_name}" reset to pending.`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

/* ── App context ──────────────────────────────────────── */

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
  const completedScheduled = (scheduled || []).filter((s: any) => s.status === 'completed');

  const formatJob = (j: any) =>
    `  • [${j.id.slice(0,8)}] "${j.title || j.video_file_name}" → ${j.target_platforms?.join(', ') || 'none'} | status: ${j.status}`;

  const formatScheduled = (s: any) =>
    `  • [${s.id.slice(0,8)}] "${s.title || s.video_file_name}" → ${s.target_platforms?.join(', ') || 'none'} | ${new Date(s.scheduled_at).toLocaleString()} [${s.status}]`;

  const platformStatus = [];
  if (settings) {
    if (settings.youtube_enabled) platformStatus.push(`YouTube (${settings.youtube_email || 'no email'})`);
    if (settings.tiktok_enabled) platformStatus.push(`TikTok (${settings.tiktok_email || 'no email'})`);
    if (settings.instagram_enabled) platformStatus.push(`Instagram (${settings.instagram_email || 'no email'})`);
    if (settings.telegram_enabled) platformStatus.push(`Telegram (chat: ${settings.telegram_chat_id || 'not set'})`);
  }

  const cronInfo = scheduleConfig?.data || scheduleConfig;
  const cronEnabled = cronInfo?.enabled ? 'ENABLED' : 'DISABLED';
  const cronExpr = cronInfo?.cron_expression || 'not set';
  const cronPlatforms = cronInfo?.platforms?.join(', ') || 'none';

  return `
=== LIVE APP DATA ===
PLATFORMS: ${platformStatus.length > 0 ? platformStatus.join(' | ') : 'None configured'}
WATCH FOLDER: ${settings?.folder_path || 'Not set'}

UPLOAD QUEUE: ${pendingJobs.length} pending, ${processingJobs.length} processing, ${completedJobs.length} done, ${failedJobs.length} failed (${(jobs || []).length} total)
${pendingJobs.length > 0 ? `PENDING:\n${pendingJobs.map(formatJob).join('\n')}` : 'No pending jobs.'}
${failedJobs.length > 0 ? `FAILED:\n${failedJobs.map(formatJob).join('\n')}` : ''}
${completedJobs.length > 0 ? `RECENT DONE:\n${completedJobs.slice(0, 5).map(formatJob).join('\n')}` : ''}

SCHEDULED: ${upcomingScheduled.length} upcoming, ${completedScheduled.length} completed
${upcomingScheduled.length > 0 ? `UPCOMING:\n${upcomingScheduled.map(formatScheduled).join('\n')}` : 'No upcoming.'}

CRON: ${cronEnabled} | ${cronExpr} | ${cronPlatforms}
===`;
}

/* ── Shared system prompt ─────────────────────────────── */

function buildSystemPrompt(appContext: string, forTelegram = false): string {
  const base = `You are a helpful AI assistant for the Video Uploader app. You have FULL ACCESS to the app's live data AND can perform actions.

${appContext}

YOU CAN PERFORM THESE ACTIONS via tool calls:
1. **create_upload_job** — Queue a video for immediate upload to YouTube/TikTok/Instagram
2. **schedule_upload** — Schedule a video upload for a specific date/time
3. **update_cron_schedule** — Enable/disable or change the automatic cron schedule
4. **delete_upload_job** — Delete/cancel a queued job
5. **retry_failed_job** — Retry a failed upload by resetting it to pending

WHEN USERS ASK YOU TO DO SOMETHING (upload, schedule, retry, delete, change cron):
- Gather required info (title, platforms, schedule time, etc.) by asking if not provided
- Use the appropriate tool call to execute the action
- Confirm what you did with the result

When users just ask questions, answer using the LIVE APP DATA above.
NEVER say you can't perform actions — you CAN create jobs, schedule uploads, and manage the queue.`;

  if (forTelegram) {
    return base + '\nKeep responses concise for Telegram. Use simple formatting.';
  }
  return base + '\nUse markdown formatting for readability.';
}

/* ── AI call with tool loop ───────────────────────────── */

async function callAIWithTools(
  supabase: any,
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: any[],
): Promise<string> {
  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  // Up to 3 tool-call rounds
  for (let round = 0; round < 3; round++) {
    const resp = await fetch(AI_GATEWAY, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: fullMessages,
        tools,
        tool_choice: 'auto',
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      console.error('AI error:', resp.status, t);
      if (resp.status === 429) return 'Rate limit exceeded. Please try again in a moment.';
      if (resp.status === 402) return 'AI credits exhausted. Add credits in Settings > Workspace > Usage.';
      return 'AI service error. Please try again.';
    }

    const data = await resp.json();
    const choice = data.choices?.[0];

    if (!choice) return "Sorry, I couldn't process that.";

    // If no tool calls, return the text
    if (choice.finish_reason === 'stop' || !choice.message?.tool_calls?.length) {
      return choice.message?.content || "Done.";
    }

    // Process tool calls
    fullMessages.push(choice.message);

    for (const tc of choice.message.tool_calls) {
      let args: any;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      console.log(`Executing tool: ${tc.function.name}`, args);
      const result = await executeTool(supabase, tc.function.name, args);

      fullMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  return "I executed the requested actions. Check the results above.";
}

export { tools, executeTool, getAppContext, buildSystemPrompt, callAIWithTools };

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: 'messages array is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const appContext = await getAppContext(supabase);
    const systemPrompt = buildSystemPrompt(appContext, false);

    // Transform messages for multimodal support
    const transformedMessages = messages.map((msg: any) => {
      if (msg.role === 'system') return msg;
      if (msg.images && msg.images.length > 0) {
        const content: any[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const img of msg.images) {
          content.push({ type: 'image_url', image_url: { url: img.url } });
        }
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

    const hasImages = messages.some((m: any) => m.images && m.images.length > 0);
    const model = hasImages ? 'google/gemini-2.5-flash' : 'google/gemini-2.5-flash';

    // Use non-streaming tool-calling flow
    const reply = await callAIWithTools(supabase, LOVABLE_API_KEY, model, systemPrompt, transformedMessages);

    // Return as a simple SSE stream for compatibility with the frontend
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send the full reply as one SSE event
        const chunk = JSON.stringify({
          choices: [{ delta: { content: reply } }],
        });
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' },
    });
  } catch (e) {
    console.error('chat error:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
