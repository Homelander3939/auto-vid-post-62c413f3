// AI handler — processes AI chat requests via LM Studio (local) instead of cloud AI Gateway.
// Used for both Telegram bot AI responses and web UI AI Chat.

const fetch = require('node-fetch');

const DEFAULT_LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234';
const DEFAULT_LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL || 'google/gemma-3-27b';
const LM_STUDIO_API_KEY = process.env.LM_STUDIO_API_KEY || 'lm-studio';

function normalizeLMStudioBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || DEFAULT_LM_STUDIO_URL).trim().replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function resolveLMStudioConfig(override = {}) {
  return {
    baseUrl: normalizeLMStudioBaseUrl(override.baseUrl),
    apiKey: override.apiKey || LM_STUDIO_API_KEY,
    model: override.model || DEFAULT_LM_STUDIO_MODEL,
  };
}

const LM_STUDIO_URL = normalizeLMStudioBaseUrl(DEFAULT_LM_STUDIO_URL);

/**
 * Resilient fetch wrapper for LM Studio.
 * If the request fails (model changed/unloaded), it auto-discovers the currently
 * loaded model and retries once. This prevents breakage when switching models.
 */
async function lmFetch(endpoint, bodyObj, config, retried = false) {
  const url = `${config.baseUrl}${endpoint}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyObj),
  }).catch(err => ({ ok: false, status: 0, _networkError: err }));

  // If success, return
  if (resp.ok) return resp;

  // If already retried, throw
  if (retried) {
    const errText = resp._networkError ? resp._networkError.message : await resp.text().catch(() => '');
    throw new Error(`LM Studio error (${resp.status || 'network'}): ${errText}`);
  }

  // Try to discover the currently loaded model
  console.warn(`[AI] LM Studio request failed (status ${resp.status || 'network error'}), discovering loaded model...`);
  try {
    const modelsResp = await fetch(`${config.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    });
    if (modelsResp.ok) {
      const modelsData = await modelsResp.json();
      const loaded = modelsData.data?.filter(m => m.id && m.object === 'model');
      if (loaded && loaded.length > 0) {
        const newModel = loaded[0].id;
        if (newModel !== config.model) {
          console.log(`[AI] Model changed: ${config.model} → ${newModel}. Retrying...`);
          config.model = newModel;
          bodyObj.model = newModel;
        }
        return lmFetch(endpoint, bodyObj, config, true);
      }
    }
  } catch (discoverErr) {
    console.warn(`[AI] Model discovery failed: ${discoverErr.message}`);
  }

  // Discovery didn't help — throw original error
  const errText = resp._networkError ? resp._networkError.message : await resp.text().catch(() => '');
  throw new Error(`LM Studio unreachable or no model loaded. Check that LM Studio is running. (${errText})`);
}

/* ── Tool definitions for the AI ─────────────── */
const tools = [
  {
    type: 'function',
    function: {
      name: 'create_upload_job',
      description: 'Create a new video upload job in the queue.',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string' },
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
      description: 'Schedule a video upload for a specific date/time.',
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
      name: 'update_cron_schedule',
      description: 'Update the automatic upload cron schedule.',
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
      name: 'delete_upload_job',
      description: 'Delete/cancel an upload job by ID.',
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
      description: 'Delete all upload jobs with a given status (e.g. "failed", "completed", "pending") or "all" to clear everything.',
      parameters: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_upload_job',
      description: 'Edit an upload job title, description, tags, or target platforms.',
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
      name: 'delete_scheduled_upload',
      description: 'Delete/cancel a scheduled upload by ID.',
      parameters: { type: 'object', properties: { scheduled_id: { type: 'string' } }, required: ['scheduled_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_scheduled_upload',
      description: 'Edit a scheduled upload title, description, tags, platforms, or scheduled_at time.',
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
      name: 'manage_recurring_schedule',
      description: 'Create, update, or delete a recurring schedule. Use action "create", "update", or "delete".',
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
      name: 'check_platform_stats',
      description: 'Queue a stats check (views, likes, comments) for YouTube Shorts, TikTok, or Instagram. Use "all" for all platforms.',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['youtube', 'tiktok', 'instagram', 'all'] },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_browser',
      description: 'Open a browser on the user\'s computer to perform any web task.',
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

/* ── Tool executor (uses Supabase client passed in) ─── */
async function executeTool(supabase, name, args) {
  switch (name) {
    case 'create_upload_job': {
      const platforms = args.target_platforms || [];
      const platformResults = platforms.map(p => ({ name: p, status: 'pending' }));
      const { data, error } = await supabase.from('upload_jobs').insert({
        video_file_name: args.video_file_name, title: args.title || '', description: args.description || '',
        tags: args.tags || [], target_platforms: platforms, status: 'pending',
        video_storage_path: args.video_storage_path || null,
        platform_results: platformResults,
      }).select().single();
      if (error) return `Failed: ${error.message}`;
      return `Done! Queued "${data.title}" for upload to ${data.target_platforms.join(', ')}.`;
    }
    case 'schedule_upload': {
      const { data, error } = await supabase.from('scheduled_uploads').insert({
        video_file_name: args.video_file_name, title: args.title || '', description: args.description || '',
        tags: args.tags || [], target_platforms: args.target_platforms || [], scheduled_at: args.scheduled_at,
        status: 'scheduled', video_storage_path: args.video_storage_path || null,
      }).select().single();
      if (error) return `Failed: ${error.message}`;
      return `Scheduled: "${data.title}" at ${new Date(data.scheduled_at).toLocaleString()}`;
    }
    case 'update_cron_schedule': {
      const update = {};
      if (args.enabled !== undefined) update.enabled = args.enabled;
      if (args.cron_expression) update.cron_expression = args.cron_expression;
      if (args.platforms) update.platforms = args.platforms;
      const { data, error } = await supabase.from('schedule_config').update(update).eq('id', 1).select().single();
      if (error) return `Failed: ${error.message}`;
      return `Cron updated: ${data.enabled ? 'ON' : 'OFF'} | ${data.cron_expression} | ${data.platforms.join(', ')}`;
    }
    case 'delete_upload_job': {
      const { error } = await supabase.from('upload_jobs').delete().eq('id', args.job_id);
      if (error) return `Failed: ${error.message}`;
      return `Job ${args.job_id} deleted.`;
    }
    case 'retry_failed_job': {
      const { data, error } = await supabase.from('upload_jobs')
        .update({ status: 'pending', completed_at: null, platform_results: [] })
        .eq('id', args.job_id).select().single();
      if (error) return `Failed: ${error.message}`;
      return `Job "${data.title || data.video_file_name}" reset to pending.`;
    }
    case 'clear_jobs_by_status': {
      let query = supabase.from('upload_jobs').delete();
      if (args.status !== 'all') {
        query = query.eq('status', args.status);
      } else {
        query = query.neq('id', '00000000-0000-0000-0000-000000000000');
      }
      const { error } = await query;
      if (error) return `Failed: ${error.message}`;
      return `Cleared ${args.status === 'all' ? 'all' : args.status} jobs.`;
    }
    case 'edit_upload_job': {
      const updates = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.target_platforms !== undefined) updates.target_platforms = args.target_platforms;
      const { data, error } = await supabase.from('upload_jobs').update(updates).eq('id', args.job_id).select().single();
      if (error) return `Failed: ${error.message}`;
      return `Updated job "${data.title}".`;
    }
    case 'delete_scheduled_upload': {
      const { error } = await supabase.from('scheduled_uploads').delete().eq('id', args.scheduled_id);
      if (error) return `Failed: ${error.message}`;
      return `Scheduled upload deleted.`;
    }
    case 'edit_scheduled_upload': {
      const updates = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.target_platforms !== undefined) updates.target_platforms = args.target_platforms;
      if (args.scheduled_at !== undefined) updates.scheduled_at = args.scheduled_at;
      const { data, error } = await supabase.from('scheduled_uploads').update(updates).eq('id', args.scheduled_id).select().single();
      if (error) return `Failed: ${error.message}`;
      return `Updated scheduled upload "${data.title}".`;
    }
    case 'manage_recurring_schedule': {
      if (args.action === 'delete') {
        if (!args.schedule_id) return 'Need schedule_id to delete.';
        const { error } = await supabase.from('schedule_config').delete().eq('id', args.schedule_id);
        if (error) return `Failed: ${error.message}`;
        return `Recurring schedule #${args.schedule_id} deleted.`;
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
        if (error) return `Failed: ${error.message}`;
        return `Created schedule "${data.name}" (#${data.id}).`;
      }
      if (args.action === 'update') {
        if (!args.schedule_id) return 'Need schedule_id to update.';
        const updates = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.enabled !== undefined) updates.enabled = args.enabled;
        if (args.cron_expression !== undefined) updates.cron_expression = args.cron_expression;
        if (args.platforms !== undefined) updates.platforms = args.platforms;
        if (args.folder_path !== undefined) updates.folder_path = args.folder_path;
        if (args.end_at !== undefined) updates.end_at = args.end_at;
        const { data, error } = await supabase.from('schedule_config').update(updates).eq('id', args.schedule_id).select().single();
        if (error) return `Failed: ${error.message}`;
        return `Updated schedule "${data.name}" (#${data.id}).`;
      }
      return 'Unknown action. Use create, update, or delete.';
    }
    case 'check_platform_stats': {
      const platform = args.platform || 'all';
      const { error } = await supabase.from('pending_commands').insert({
        command: 'check_stats',
        args: { platform },
        status: 'pending',
      });
      if (error) return `Could not queue stats check: ${error.message}`;
      return `Stats check queued for ${platform === 'all' ? 'all platforms' : platform}! Results will arrive via Telegram within 60 seconds.`;
    }
    case 'open_browser': {
      const { error } = await supabase.from('pending_commands').insert({
        command: 'open_browser',
        args: { task: args.task, url: args.url || null },
        status: 'pending',
      });
      if (error) return `Could not queue browser task: ${error.message}`;
      return `Browser task queued! Results will arrive via Telegram within 60 seconds.`;
    }
    default: return `Unknown tool: ${name}`;
  }
}

/* ── Get app context for system prompt ─── */
async function getAppContext(supabase) {
  const [
    { data: jobs },
    { data: scheduled },
    { data: settings },
    { data: scheduleConfigs },
  ] = await Promise.all([
    supabase.from('upload_jobs').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('scheduled_uploads').select('*').order('scheduled_at', { ascending: true }).limit(20),
    supabase.from('app_settings').select('*').eq('id', 1).single(),
    supabase.from('schedule_config').select('*').order('id', { ascending: true }),
  ]);

  const pendingJobs = (jobs || []).filter(j => j.status === 'pending');
  const processingJobs = (jobs || []).filter(j => j.status === 'processing');
  const completedJobs = (jobs || []).filter(j => j.status === 'completed');
  const failedJobs = (jobs || []).filter(j => j.status === 'failed');
  const upcomingScheduled = (scheduled || []).filter(s => s.status === 'scheduled');

  const formatJob = j =>
    `  ID: ${j.id} | "${j.title || j.video_file_name}" → ${j.target_platforms?.join(', ') || 'none'} [${j.status}]`;
  const formatScheduled = s =>
    `  ID: ${s.id} | "${s.title || s.video_file_name}" → ${s.target_platforms?.join(', ')} at ${new Date(s.scheduled_at).toLocaleString()} [${s.status}]`;
  const formatRecurring = c =>
    `  #${c.id} "${c.name}" | ${c.enabled ? 'ON' : 'OFF'} | ${c.cron_expression} | ${c.platforms?.join(', ')} | folder: ${c.folder_path || '(none)'}${c.end_at ? ` | ends: ${new Date(c.end_at).toLocaleString()}` : ''}`;

  const platformStatus = [];
  if (settings) {
    if (settings.youtube_enabled) platformStatus.push('YouTube');
    if (settings.tiktok_enabled) platformStatus.push('TikTok');
    if (settings.instagram_enabled) platformStatus.push('Instagram');
  }

  return `
=== LIVE APP DATA ===
Platforms: ${platformStatus.join(', ') || 'None configured'}
Queue: ${pendingJobs.length} pending, ${processingJobs.length} processing, ${completedJobs.length} done, ${failedJobs.length} failed
${pendingJobs.length > 0 ? `Pending:\n${pendingJobs.map(formatJob).join('\n')}` : ''}
${failedJobs.length > 0 ? `Failed:\n${failedJobs.map(formatJob).join('\n')}` : ''}
${completedJobs.length > 0 ? `Recent:\n${completedJobs.slice(0, 5).map(formatJob).join('\n')}` : ''}
Scheduled: ${upcomingScheduled.length} upcoming
${upcomingScheduled.length > 0 ? upcomingScheduled.map(formatScheduled).join('\n') : ''}
Recurring: ${(scheduleConfigs || []).length}
${(scheduleConfigs || []).length > 0 ? (scheduleConfigs || []).map(formatRecurring).join('\n') : 'None'}
===`;
}

/* ── Build system prompt ─── */
function buildSystemPrompt(appContext, isTelegram = false) {
  const formatting = isTelegram
    ? `FORMATTING: Use plain text only, no markdown. Use emoji and line breaks for structure. Keep responses concise.`
    : `FORMATTING: Use markdown for rich formatting.`;

  return `You are a helpful AI assistant for a Video Uploader app. You have access to live app data and can perform actions via tools.

${appContext}

You can perform these actions:
- create_upload_job, schedule_upload, edit_upload_job, delete_upload_job
- retry_failed_job, clear_jobs_by_status
- edit_scheduled_upload, delete_scheduled_upload
- update_cron_schedule, manage_recurring_schedule
- check_platform_stats (queues browser stats check on user's PC)
- open_browser (queues any browser task on user's PC)

When asked to do something, use the tools. When asked questions, answer from live data.
ALWAYS call check_platform_stats when user asks about stats/views/likes.
ALWAYS call open_browser when user asks to open browser for non-stats tasks.

${formatting}`;
}

/* ── Call LM Studio with tool support ─── */
async function callLMStudioWithTools(messages, supabase, maxRounds = 3, override = {}) {
  const config = resolveLMStudioConfig(override);
  const fullMessages = [...messages];

  for (let round = 0; round < maxRounds; round++) {
    const body = {
      model: config.model,
      messages: fullMessages,
      tools,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 2048,
    };

    const resp = await lmFetch('/chat/completions', body, config);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[AI] LM Studio error ${resp.status}: ${errText}`);
      return 'Sorry, AI processing failed. Make sure LM Studio is running.';
    }

    const data = await resp.json();
    const choice = data.choices?.[0];
    if (!choice) return "Sorry, couldn't process that.";

    if (choice.finish_reason === 'stop' || !choice.message?.tool_calls?.length) {
      return choice.message?.content || 'Done.';
    }

    // Process tool calls
    fullMessages.push(choice.message);
    for (const tc of choice.message.tool_calls) {
      let args;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      console.log(`[AI] Tool: ${tc.function.name}`, JSON.stringify(args));
      const result = await executeTool(supabase, tc.function.name, args);
      fullMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  return 'Actions executed.';
}

/* ── Streaming call to LM Studio (for web UI) ─── */
async function streamLMStudio(messages, supabase, override = {}) {
  const config = resolveLMStudioConfig(override);
  const appContext = await getAppContext(supabase);
  const systemPrompt = buildSystemPrompt(appContext, false);

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  // First try non-streaming to detect tool calls
  const body = {
    model: config.model,
    messages: fullMessages,
    tools,
    tool_choice: 'auto',
    temperature: 0.7,
    max_tokens: 2048,
  };

  const resp = await lmFetch('/chat/completions', body, config);

  const data = await resp.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No response from AI');

  // If tool calls, process them and make a follow-up call
  if (choice.message?.tool_calls?.length) {
    fullMessages.push(choice.message);
    for (const tc of choice.message.tool_calls) {
      let args;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      console.log(`[AI-Chat] Tool: ${tc.function.name}`, JSON.stringify(args));
      const result = await executeTool(supabase, tc.function.name, args);
      fullMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }

    // Follow-up call (streaming)
    const streamResp = await lmFetch('/chat/completions', {
      model: config.model,
      messages: fullMessages,
      stream: true,
      temperature: 0.7,
      max_tokens: 2048,
    }, config);

    return streamResp;
  }

  // No tool calls — return streaming response
  const streamResp = await lmFetch('/chat/completions', {
    model: config.model,
    messages: fullMessages,
    stream: true,
    temperature: 0.7,
    max_tokens: 2048,
  }, config);

  return streamResp;
}

/* ── Process a Telegram AI response command ─── */
async function processTelegramAIResponse(supabase, args, sendTelegramFn, backend) {
  const chatId = args.chat_id;
  const userText = args.user_text || '';
  const images = args.images || [];
  const files = args.files || [];

  // Build conversation history from recent telegram messages
  const { data: history } = await supabase
    .from('telegram_messages')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(10);

  const contextMessages = (history || []).reverse()
    .map(m => ({
      role: m.is_bot ? 'assistant' : 'user',
      content: m.text || '',
    }));

  // Build current message with file context
  let currentContent = userText;
  if (files.length > 0) {
    currentContent += `\n\nAttached files:\n${files.map(f => `- ${f.name} (${f.type}, url: ${f.url})`).join('\n')}`;
  }
  if (images.length > 0) {
    currentContent += `\n\nAttached images:\n${images.map(img => `- ${img.name} (url: ${img.url})`).join('\n')}`;
  }

  // Replace last user message with enriched version
  if (contextMessages.length > 0 && contextMessages[contextMessages.length - 1].role === 'user') {
    contextMessages[contextMessages.length - 1].content = currentContent;
  } else {
    contextMessages.push({ role: 'user', content: currentContent });
  }

  // Get app context and build system prompt
  const appContext = await getAppContext(supabase);
  const systemPrompt = buildSystemPrompt(appContext, true);

  const aiMessages = [
    { role: 'system', content: systemPrompt },
    ...contextMessages,
  ];

  let aiReply = "Sorry, I couldn't process your message right now.";
  try {
    aiReply = await callLMStudioWithTools(aiMessages, supabase);
  } catch (e) {
    console.error('[AI] Telegram AI call failed:', e.message);
    aiReply = `AI processing failed: ${e.message}. Make sure LM Studio is running at ${LM_STUDIO_URL}`;
  }

  // Clean up reply for Telegram (no markdown)
  const cleanReply = aiReply
    .replace(/\*\*/g, '')
    .replace(/__(.*?)__/g, '$1')
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .slice(0, 3900);

  // Send reply via Telegram
  try {
    await sendTelegramFn(null, chatId, cleanReply, backend);
  } catch (e) {
    console.error('[AI] Failed to send Telegram reply:', e.message);
  }

  // Store bot reply in telegram_messages
  const updateId = args.update_id || Date.now();
  await supabase.from('telegram_messages').insert({
    update_id: updateId + 1_000_000_000,
    chat_id: chatId,
    text: aiReply,
    is_bot: true,
    raw_update: { bot_reply: true },
  });

  return aiReply;
}

module.exports = {
  tools,
  executeTool,
  getAppContext,
  buildSystemPrompt,
  callLMStudioWithTools,
  streamLMStudio,
  processTelegramAIResponse,
  LM_STUDIO_URL,
};
