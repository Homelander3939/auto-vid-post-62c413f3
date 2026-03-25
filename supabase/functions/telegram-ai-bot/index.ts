import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';
const AI_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';
const MAX_RUNTIME_MS = 20_000;
const MIN_REMAINING_MS = 3_000;

/* ── Tool definitions (same as ai-chat) ─────────────── */
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
      parameters: { type: 'object', properties: { status: { type: 'string', description: 'Job status to clear, or "all"' } }, required: ['status'] },
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
          schedule_id: { type: 'number', description: 'Required for update/delete' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          cron_expression: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          folder_path: { type: 'string' },
          end_at: { type: 'string', description: 'ISO date when schedule should stop' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_platform_stats',
      description: 'Queue a stats check (views, likes, comments) for YouTube Shorts, TikTok videos, or Instagram Reels. This ALWAYS works — it queues a command via Supabase and the local server opens the browser on the user\'s computer to scrape stats, then sends the results back to Telegram. Use "all" to check all configured platforms at once. ALWAYS call this tool immediately when the user asks about stats, views, likes, or video performance — never explain why it might fail. Also use this when the user says "open browser and check my YouTube/TikTok/Instagram" or "open browser and see my stats".',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['youtube', 'tiktok', 'instagram', 'all'], description: 'Platform to check stats for, or "all" to check all platforms' },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_browser',
      description: 'Open a browser on the user\'s local computer to perform any general web task: searching the web, browsing a website, checking a page, looking up information, navigating to a URL, etc. Use this for ANY "open browser" request that is NOT specifically about checking YouTube/TikTok/Instagram video stats/views/likes/comments. Examples: "open browser and search for X", "open browser and go to google.com", "open browser and check my email", "open browser and look up Y", "open browser and visit Z". ALWAYS call this tool immediately — never say the browser cannot be opened.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Full natural-language description of the web task to perform. Be specific — include the URL, search query, or step-by-step instructions.',
          },
          url: {
            type: 'string',
            description: 'Optional starting URL (e.g., "https://www.google.com"). Defaults to Google if not provided.',
          },
        },
        required: ['task'],
      },
    },
  },
];

async function executeTool(supabase: any, name: string, args: any): Promise<string> {
  switch (name) {
    case 'create_upload_job': {
      const platforms = args.target_platforms || [];
      const platformResults = platforms.map((p: string) => ({ name: p, status: 'pending' }));
      const { data, error } = await supabase.from('upload_jobs').insert({
        video_file_name: args.video_file_name, title: args.title || '', description: args.description || '',
        tags: args.tags || [], target_platforms: platforms, status: 'pending',
        video_storage_path: args.video_storage_path || null,
        platform_results: platformResults,
      }).select().single();
      if (error) return `Failed: ${error.message}`;
      return `Done! Queued "${data.title}" for instant upload to ${data.target_platforms.join(', ')}.\nTitle: ${data.title}\nPlatforms: ${data.target_platforms.join(', ')}\nStatus: Pending`;
    }
    case 'schedule_upload': {
      const { data, error } = await supabase.from('scheduled_uploads').insert({
        video_file_name: args.video_file_name, title: args.title || '', description: args.description || '',
        tags: args.tags || [], target_platforms: args.target_platforms || [], scheduled_at: args.scheduled_at,
        status: 'scheduled', video_storage_path: args.video_storage_path || null,
      }).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Scheduled: "${data.title}" → ${data.target_platforms.join(', ')} at ${new Date(data.scheduled_at).toLocaleString()}`;
    }
    case 'update_cron_schedule': {
      const update: any = {};
      if (args.enabled !== undefined) update.enabled = args.enabled;
      if (args.cron_expression) update.cron_expression = args.cron_expression;
      if (args.platforms) update.platforms = args.platforms;
      const { data, error } = await supabase.from('schedule_config').update(update).eq('id', 1).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Cron updated: ${data.enabled ? 'ON' : 'OFF'} | ${data.cron_expression} | ${data.platforms.join(', ')}`;
    }
    case 'delete_upload_job': {
      const { error } = await supabase.from('upload_jobs').delete().eq('id', args.job_id);
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Job ${args.job_id} deleted.`;
    }
    case 'retry_failed_job': {
      const { data, error } = await supabase.from('upload_jobs')
        .update({ status: 'pending', completed_at: null, platform_results: [] })
        .eq('id', args.job_id).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Job "${data.title || data.video_file_name}" reset to pending.`;
    }
    case 'clear_jobs_by_status': {
      let query = supabase.from('upload_jobs').delete();
      if (args.status !== 'all') {
        query = query.eq('status', args.status);
      } else {
        query = query.neq('id', '00000000-0000-0000-0000-000000000000');
      }
      const { error, count } = await query;
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Cleared ${args.status === 'all' ? 'all' : args.status} jobs.`;
    }
    case 'edit_upload_job': {
      const updates: any = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.target_platforms !== undefined) updates.target_platforms = args.target_platforms;
      const { data, error } = await supabase.from('upload_jobs').update(updates).eq('id', args.job_id).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Updated job "${data.title}": platforms=${data.target_platforms?.join(', ')}, tags=${data.tags?.join(', ')}`;
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
      return `✅ Updated scheduled upload "${data.title}" → ${new Date(data.scheduled_at).toLocaleString()}`;
    }
    case 'manage_recurring_schedule': {
      if (args.action === 'delete') {
        if (!args.schedule_id) return '❌ Need schedule_id to delete.';
        const { error } = await supabase.from('schedule_config').delete().eq('id', args.schedule_id);
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Recurring schedule #${args.schedule_id} deleted.`;
      }
      if (args.action === 'create') {
        const payload: any = {
          name: args.name || 'Schedule',
          enabled: args.enabled ?? false,
          cron_expression: args.cron_expression || '0 9 * * *',
          platforms: args.platforms || ['youtube'],
          folder_path: args.folder_path || '',
          end_at: args.end_at || null,
        };
        const { data, error } = await supabase.from('schedule_config').insert(payload).select().single();
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Created recurring schedule "${data.name}" (#${data.id}): ${data.cron_expression}, ${data.platforms.join(', ')}`;
      }
      if (args.action === 'update') {
        if (!args.schedule_id) return '❌ Need schedule_id to update.';
        const updates: any = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.enabled !== undefined) updates.enabled = args.enabled;
        if (args.cron_expression !== undefined) updates.cron_expression = args.cron_expression;
        if (args.platforms !== undefined) updates.platforms = args.platforms;
        if (args.folder_path !== undefined) updates.folder_path = args.folder_path;
        if (args.end_at !== undefined) updates.end_at = args.end_at;
        const { data, error } = await supabase.from('schedule_config').update(updates).eq('id', args.schedule_id).select().single();
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Updated schedule "${data.name}" (#${data.id})`;
      }
      return '❌ Unknown action. Use create, update, or delete.';
    }
    case 'check_platform_stats': {
      // Queue a stats check via the pending_commands table so the local server
      // (which runs on the user's machine) picks it up and opens the browser.
      // Direct fetch to localhost:3001 cannot work from an edge function.
      const platform = args.platform || 'all';
      const { error } = await supabase.from('pending_commands').insert({
        command: 'check_stats',
        args: { platform },
        status: 'pending',
      });
      if (error) return `❌ Could not queue stats check: ${error.message}`;
      const platformLabel = platform === 'all' ? 'all platforms' : platform;
      return `✅ Stats check queued for ${platformLabel}! The browser will open on your computer and results will arrive here in Telegram within 60 seconds.`;
    }
    case 'open_browser': {
      // Queue a general browser task via the pending_commands table so the
      // local server picks it up and opens the browser on the user's machine.
      const { error } = await supabase.from('pending_commands').insert({
        command: 'open_browser',
        args: { task: args.task, url: args.url || null },
        status: 'pending',
      });
      if (error) return `❌ Could not queue browser task: ${error.message}`;
      return `✅ Browser task queued! The browser will open on your computer and I will report back the results here in Telegram within 60 seconds.`;
    }
    default: return `Unknown tool: ${name}`;
  }
}

async function callAIWithTools(apiKey: string, model: string, messages: any[], supabase: any): Promise<string> {
  const fullMessages = [...messages];
  for (let round = 0; round < 3; round++) {
    const resp = await fetch(AI_GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: fullMessages, tools, tool_choice: 'auto' }),
    });
    if (!resp.ok) {
      console.error('AI error:', resp.status, await resp.text());
      return resp.status === 429 ? 'Rate limit exceeded.' : resp.status === 402 ? 'AI credits exhausted.' : 'AI error.';
    }
    const data = await resp.json();
    const choice = data.choices?.[0];
    if (!choice) return "Sorry, couldn't process that.";
    if (choice.finish_reason === 'stop' || !choice.message?.tool_calls?.length) {
      return choice.message?.content || 'Done.';
    }
    fullMessages.push(choice.message);
    for (const tc of choice.message.tool_calls) {
      let args: any;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      console.log(`Tool: ${tc.function.name}`, args);
      const result = await executeTool(supabase, tc.function.name, args);
      fullMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  return 'Actions executed.';
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

type TelegramMediaRef = {
  url: string;
  name: string;
  type: string;
  size?: number;
  isImage: boolean;
};

function extFromMime(mimeType: string): string {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('pdf')) return 'pdf';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('mp4')) return 'mp4';
  return 'bin';
}

function parseAudioDataUrl(dataUrl: string): { base64: string; format: 'wav' | 'mp3' | 'ogg' } | null {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;

  const mime = (match[1] || '').toLowerCase();
  const base64 = match[2] || '';
  if (!base64) return null;

  let format: 'wav' | 'mp3' | 'ogg' = 'ogg';
  if (mime.includes('wav')) format = 'wav';
  else if (mime.includes('mpeg') || mime.includes('mp3')) format = 'mp3';

  return { base64, format };
}

async function getAppContext(supabase: any): Promise<string> {
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

  const pendingJobs = (jobs || []).filter((j: any) => j.status === 'pending');
  const processingJobs = (jobs || []).filter((j: any) => j.status === 'processing');
  const completedJobs = (jobs || []).filter((j: any) => j.status === 'completed');
  const failedJobs = (jobs || []).filter((j: any) => j.status === 'failed');
  const upcomingScheduled = (scheduled || []).filter((s: any) => s.status === 'scheduled');

  const formatJob = (j: any) =>
    `  ID: ${j.id} | "${j.title || j.video_file_name}" → ${j.target_platforms?.join(', ') || 'none'} [${j.status}]`;

  const formatScheduled = (s: any) =>
    `  ID: ${s.id} | "${s.title || s.video_file_name}" → ${s.target_platforms?.join(', ')} at ${new Date(s.scheduled_at).toLocaleString()} [${s.status}]`;

  const formatRecurring = (c: any) =>
    `  #${c.id} "${c.name}" | ${c.enabled ? 'ON' : 'OFF'} | ${c.cron_expression} | ${c.platforms?.join(', ')} | folder: ${c.folder_path || '(none)'}${c.end_at ? ` | ends: ${new Date(c.end_at).toLocaleString()}` : ''}`;

  const platformStatus = [];
  if (settings) {
    if (settings.youtube_enabled) platformStatus.push('YouTube ✓');
    if (settings.tiktok_enabled) platformStatus.push('TikTok ✓');
    if (settings.instagram_enabled) platformStatus.push('Instagram ✓');
  }

  return `
=== LIVE APP DATA ===
Platforms: ${platformStatus.join(', ') || 'None configured'}
Upload Mode: ${settings?.upload_mode || 'local'}

Queue: ${pendingJobs.length} pending, ${processingJobs.length} processing, ${completedJobs.length} done, ${failedJobs.length} failed
${pendingJobs.length > 0 ? `Pending:\n${pendingJobs.map(formatJob).join('\n')}` : ''}
${failedJobs.length > 0 ? `Failed:\n${failedJobs.map(formatJob).join('\n')}` : ''}
${completedJobs.length > 0 ? `Recent completed:\n${completedJobs.slice(0, 5).map(formatJob).join('\n')}` : ''}

Scheduled uploads: ${upcomingScheduled.length} upcoming
${upcomingScheduled.length > 0 ? upcomingScheduled.map(formatScheduled).join('\n') : ''}

Recurring schedules: ${(scheduleConfigs || []).length}
${(scheduleConfigs || []).length > 0 ? (scheduleConfigs || []).map(formatRecurring).join('\n') : 'None'}
===`;
}

async function fetchTelegramFileBytes(
  fileId: string,
  lovableKey: string,
  telegramKey: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    const fileResp = await fetch(`${TELEGRAM_GATEWAY}/getFile`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableKey}`,
        'X-Connection-Api-Key': telegramKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!fileResp.ok) return null;

    const fileData = await fileResp.json();
    const filePath = fileData.result?.file_path;
    if (!filePath) return null;

    const dlResp = await fetch(`${TELEGRAM_GATEWAY}/file/${filePath}`, {
      headers: {
        'Authorization': `Bearer ${lovableKey}`,
        'X-Connection-Api-Key': telegramKey,
      },
    });
    if (!dlResp.ok) return null;

    const contentType = dlResp.headers.get('content-type') || 'application/octet-stream';
    const bytes = new Uint8Array(await dlResp.arrayBuffer());
    return { bytes, mimeType: contentType.split(';')[0].trim() };
  } catch (e) {
    console.error('fetchTelegramFileBytes failed:', e);
    return null;
  }
}

async function uploadTelegramMediaToStorage(
  supabase: any,
  bytes: Uint8Array,
  mimeType: string,
  preferredName?: string,
): Promise<TelegramMediaRef | null> {
  try {
    const ext = extFromMime(mimeType);
    const safeName = preferredName?.replace(/[^a-zA-Z0-9._-]/g, '_') || `media.${ext}`;
    const storagePath = `chat/telegram/${Date.now()}-${crypto.randomUUID()}-${safeName}`;

    const { error } = await supabase.storage.from('videos').upload(storagePath, bytes, {
      contentType: mimeType,
      upsert: false,
    });
    if (error) {
      console.error('Storage upload failed:', error.message);
      return null;
    }

    const { data } = supabase.storage.from('videos').getPublicUrl(storagePath);
    return {
      url: data.publicUrl,
      name: preferredName || safeName,
      type: mimeType,
      size: bytes.byteLength,
      isImage: mimeType.startsWith('image/'),
    };
  } catch (e) {
    console.error('uploadTelegramMediaToStorage failed:', e);
    return null;
  }
}

async function extractMessageContent(
  supabase: any,
  message: any,
  lovableKey: string,
  telegramKey: string,
): Promise<{ text: string; images: TelegramMediaRef[]; files: TelegramMediaRef[]; audioDataUrl: string | null; hasMedia: boolean }> {
  const text = message.text || message.caption || '';
  const images: TelegramMediaRef[] = [];
  const files: TelegramMediaRef[] = [];
  let audioDataUrl: string | null = null;

  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    const download = await fetchTelegramFileBytes(largest.file_id, lovableKey, telegramKey);
    if (download) {
      const media = await uploadTelegramMediaToStorage(
        supabase,
        download.bytes,
        download.mimeType === 'application/octet-stream' ? 'image/jpeg' : download.mimeType,
        `telegram-photo-${largest.file_unique_id || Date.now()}.jpg`,
      );
      if (media) images.push(media);
    }
  }

  if (message.document?.file_id) {
    const doc = message.document;
    const download = await fetchTelegramFileBytes(doc.file_id, lovableKey, telegramKey);
    if (download) {
      const media = await uploadTelegramMediaToStorage(
        supabase,
        download.bytes,
        doc.mime_type || download.mimeType,
        doc.file_name,
      );
      if (media) {
        if (media.isImage) images.push(media);
        files.push(media);
      }
    }
  }

  const voiceLike = message.voice || message.audio || null;
  if (voiceLike?.file_id) {
    const download = await fetchTelegramFileBytes(voiceLike.file_id, lovableKey, telegramKey);
    if (download) {
      const guessedType = message.voice ? 'audio/ogg' : message.audio?.mime_type || download.mimeType;

      // Keep base64 for AI transcription
      let binary = '';
      for (let i = 0; i < download.bytes.length; i++) {
        binary += String.fromCharCode(download.bytes[i]);
      }
      audioDataUrl = `data:${guessedType};base64,${btoa(binary)}`;

      const media = await uploadTelegramMediaToStorage(
        supabase,
        download.bytes,
        guessedType,
        message.audio?.file_name || `telegram-${message.voice ? 'voice' : 'audio'}-${Date.now()}.${extFromMime(guessedType)}`,
      );
      if (media) files.push(media);
    }
  }

  const videoMsg = message.video || message.video_note || null;
  if (videoMsg?.file_id) {
    const download = await fetchTelegramFileBytes(videoMsg.file_id, lovableKey, telegramKey);
    if (download) {
      const media = await uploadTelegramMediaToStorage(
        supabase,
        download.bytes,
        message.video?.mime_type || download.mimeType,
        `telegram-video-${Date.now()}.mp4`,
      );
      if (media) files.push(media);
    }
  }

  return {
    text,
    images,
    files,
    audioDataUrl,
    hasMedia: images.length > 0 || files.length > 0,
  };
}

function sanitizeTelegramText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/\*\*/g, '')
    .replace(/__(.*?)__/g, '$1')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .slice(0, 3900);
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

  const { data: state, error: stateErr } = await supabase
    .from('telegram_bot_state')
    .select('update_offset')
    .eq('id', 1)
    .single();

  if (stateErr) return errResp(stateErr.message);

  let totalProcessed = 0;
  let currentOffset = state.update_offset;

  while (true) {
    const elapsed = Date.now() - startTime;
    const remainingMs = MAX_RUNTIME_MS - elapsed;
    if (remainingMs < MIN_REMAINING_MS) break;

    const timeout = Math.min(5, Math.floor(remainingMs / 1000) - 3);
    if (timeout < 1) break;

    console.log(`Polling with offset=${currentOffset}, timeout=${timeout}s, remaining=${Math.round(remainingMs / 1000)}s`);

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
      const message = update.message;
      if (!message) continue;

      const chatId = message.chat.id;
      const { text: userText, images, files, audioDataUrl, hasMedia } = await extractMessageContent(
        supabase,
        message,
        LOVABLE_API_KEY,
        TELEGRAM_API_KEY,
      );

      if (!userText && !hasMedia) continue;

      const displayText = userText
        || (images.length > 0 ? '📷 [Photo]'
          : audioDataUrl ? '🎤 [Voice message]'
            : files.length > 0 ? '📎 [File]'
              : '');

      await supabase.from('telegram_messages').upsert({
        update_id: update.update_id,
        chat_id: chatId,
        text: displayText,
        is_bot: false,
        raw_update: {
          ...update,
          media: { images, files },
        },
      }, { onConflict: 'update_id' });

      const { data: history } = await supabase
        .from('telegram_messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(10);

      // Build conversation history, filtering out past bot responses that contained
      // connectivity error phrases. These erroneous responses poison the AI context
      // by making the model think it's acceptable to say "I cannot reach the server".
      const BAD_RESPONSE_PATTERNS = [
        'cannot reach the local server',
        'cannot reach your local server',
        'still cannot reach',
        'local server to open the browser',
        'Ngrok',
        'ngrok',
        'tunnel has expired',
        'Tunnel URL',
        'Router\'s NAT',
        'NAT is blocking',
        'Windows Defender',
        'sandboxed by',
        'Puppeteer failed to launch',
        'Inbound request blocked',
        'One-Way Communication',
        'return path for my requests',
      ];

      const contextMessages = (history || []).reverse()
        .filter((m: any) => {
          if (!m.is_bot) return true; // always keep user messages
          const text = m.text || '';
          return !BAD_RESPONSE_PATTERNS.some((p) => text.includes(p));
        })
        .map((m: any) => ({
          role: m.is_bot ? 'assistant' : 'user',
          content: m.text || '',
        }));

      // Build the AI message with multimodal content
      const currentAiMsg: any = { role: 'user', content: '' };

      // Collect any video/file storage paths so AI can pass them to tools
      const attachedVideoPaths = files
        .filter((f) => f.type?.startsWith('video/') || f.name?.match(/\.(mp4|mov|avi|mkv|webm)$/i))
        .map((f) => {
          // Extract storage path from public URL
          const urlParts = f.url?.split('/storage/v1/object/public/videos/');
          return urlParts?.[1] || f.url;
        });

      const fileContext = files.length > 0
        ? `\n\nAttached files:\n${files.map((f) => `- ${f.name} (${f.type}, ${Math.round((f.size || 0) / 1024)}KB, url: ${f.url}${
            attachedVideoPaths.includes(f.url?.split('/storage/v1/object/public/videos/')?.[1] || f.url)
              ? `, storage_path: ${f.url?.split('/storage/v1/object/public/videos/')?.[1] || ''}`
              : ''
          })`).join('\n')}`
        : '';

      if (audioDataUrl) {
        const parsedAudio = parseAudioDataUrl(audioDataUrl);
        const parts: any[] = [];
        parts.push({
          type: 'text',
          text: (userText || 'Please transcribe this voice message and respond to what the person is saying. First show the transcription, then respond.') + fileContext,
        });
        if (parsedAudio) {
          parts.push({
            type: 'input_audio',
            input_audio: {
              data: parsedAudio.base64,
              format: parsedAudio.format,
            },
          });
        }
        currentAiMsg.content = parts;
      } else if (images.length > 0) {
        const parts: any[] = [];
        parts.push({ type: 'text', text: (userText || 'Please analyze this image in detail.') + fileContext });
        images.forEach((img) => parts.push({ type: 'image_url', image_url: { url: img.url } }));
        currentAiMsg.content = parts;
      } else if (files.length > 0) {
        currentAiMsg.content = `${userText || 'I sent a file.'}${fileContext}`;
      } else {
        currentAiMsg.content = userText || '';
      }

      contextMessages.push(currentAiMsg);

      // Send "typing..." indicator to Telegram
      void fetch(`${TELEGRAM_GATEWAY}/sendChatAction`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'X-Connection-Api-Key': TELEGRAM_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      });

      const appContext = await getAppContext(supabase);
      const model = audioDataUrl
        ? 'openai/gpt-5-mini'
        : (images.length > 0 ? 'google/gemini-2.5-flash' : 'google/gemini-3-flash-preview');

      const systemPrompt = `You are a helpful AI assistant for the Video Uploader app. You have FULL ACCESS to the app's live data AND can perform actions.

${appContext}

YOU CAN PERFORM ACTIONS via tool calls:
1. create_upload_job — Queue a video for immediate upload
2. schedule_upload — Schedule a video upload for a specific date/time
3. update_cron_schedule — Change the automatic cron schedule (legacy, for schedule #1)
4. delete_upload_job — Delete/cancel a queued job by ID
5. retry_failed_job — Retry a failed upload by ID
6. clear_jobs_by_status — Delete all jobs with a given status ("failed", "completed", "pending", or "all")
7. edit_upload_job — Edit a job's title, description, tags, or platforms
8. delete_scheduled_upload — Cancel a scheduled upload by ID
9. edit_scheduled_upload — Edit a scheduled upload's details or reschedule it
10. manage_recurring_schedule — Create, update, or delete recurring schedules (action: create/update/delete)
11. check_platform_stats — Queue a stats check that opens the browser on the user's computer to scrape video views, likes, and comments. Use "all" to check all platforms. Results arrive via a new Telegram message within ~60 seconds.
12. open_browser — Queue a general browser task (search the web, visit a website, look up anything). The browser opens on the user's computer and results are reported back here.

HOW check_platform_stats WORKS (understand this architecture):
- You call check_platform_stats(platform) → it inserts a row into the pending_commands Supabase table.
- The local server running on the user's Windows PC polls this table every minute.
- When it finds the command, it opens a real browser window (Playwright, headless=false) on the user's PC.
- The browser navigates to YouTube Studio / TikTok / Instagram, logs in using saved session, and scrapes stats.
- Stats are sent back to the user via a new Telegram message automatically.
- YOU NEVER connect directly to the browser — you only queue the command. The browser always runs on the user's machine.
- ALWAYS call this tool immediately. NEVER say "the browser connection is failing" or "I can't connect to your local server".

HOW open_browser WORKS:
- You call open_browser(task, url) → it inserts a row into the pending_commands Supabase table.
- The local server picks it up, opens a real browser window on the user's PC, and performs the task using AI-guided automation.
- Results (page title, URL, outcome) are sent back via Telegram.
- YOU NEVER connect to the browser directly — you only queue the command.
- ALWAYS call this tool immediately for any "open browser" request that is not about platform stats.

OPEN BROWSER ROUTING — MANDATORY, NO EXCEPTIONS:
- User says "open browser and check YouTube/TikTok/Instagram stats/views/likes" → call check_platform_stats immediately.
- User says "open browser and search [X]" → call open_browser(task="Search for [X] on Google", url="https://www.google.com") immediately.
- User says "open browser and go to [URL]" → call open_browser(task="Navigate to [URL]", url="[URL]") immediately.
- User says "open browser and [any task]" → call open_browser(task="[full task description]") immediately.
- User says "open browser" with no further detail → call open_browser(task="Open the browser and navigate to Google") immediately.
- NEVER, under ANY circumstances, say you cannot open the browser.
- NEVER say "I cannot reach the local server", "the server is offline", "the tunnel is broken", "NAT is blocking", or ANY similar connectivity phrase.
- NEVER mention Ngrok, tunnels, VPN, Windows Defender, or router settings in response to a browser request.
- NEVER explain why the browser might fail. ALWAYS call the tool and confirm it is queued.

STATS CHECK RULES — ABSOLUTE AND NON-NEGOTIABLE:
- ALWAYS call check_platform_stats immediately when user asks for stats, views, likes, comments, or video performance. No exceptions.
- After calling it, tell the user ONLY: "Stats check queued! The browser will open on your computer and results will arrive here in Telegram in up to 60 seconds."
- YOU HAVE ZERO ABILITY to connect to the local server. You cannot ping it, test it, or detect whether it is running. You only queue commands via Supabase.
- NEVER say the local server is "not responding", "offline", "unreachable", or any similar phrase. You have no such knowledge.
- NEVER say you "attempted to scan" or "tried to connect" to anything. You cannot do that.
- NEVER say "browser automation is failing" or "I can't access your stats directly". Just call the tool and reassure the user.
- The stats check command is queued into Supabase — this ALWAYS succeeds regardless of whether the server is running at that moment.
- If user says they are not getting results, call the tool again and suggest they make sure the local server (smart-launcher.bat) is running.
- Stats are ALSO automatically checked after every successful upload and included in the upload completion notification.

OVERRIDING CONVERSATION HISTORY:
- Ignore any previous messages in this conversation (including your own past replies) that mentioned connectivity errors, server being offline, tunnels, Ngrok, or inability to open a browser. Those were mistakes.
- The ONLY correct response to "open browser" or "check stats" requests is to call the appropriate tool immediately.

IMPORTANT: The live data above includes job IDs and schedule IDs. Always use these IDs when performing actions.
When users say "delete all failed" or "clear the queue", use clear_jobs_by_status.
When users reference jobs by name, match them to the IDs in the data above.
When users ask to check stats, views, likes, comments, or performance of their videos, use check_platform_stats.

When users ask you to do something (upload, schedule, retry, delete, change cron), use the tools.
When users send a video and ask to upload it, use the video's storage_path as video_storage_path and the video filename as video_file_name in create_upload_job.
When users send images, analyze them in detail.
When users send voice messages, transcribe them first, then respond.
NEVER say you can't do something. You CAN perform actions and access data.

FORMATTING RULES FOR TELEGRAM:
- Do NOT use markdown formatting (no ** or __ or # or \`\`\`).
- Use plain text only.
- Use line breaks and emoji for structure instead of markdown.
- Keep responses concise.`;

      let aiReply = "Sorry, I couldn't process your message right now.";
      try {
        const aiMessages = [
          { role: 'system', content: systemPrompt },
          ...contextMessages,
        ];
        aiReply = await callAIWithTools(LOVABLE_API_KEY, model, aiMessages, supabase);
      } catch (e) {
        console.error('AI call failed:', e);
      }

      const tgSendResp = await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'X-Connection-Api-Key': TELEGRAM_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: sanitizeTelegramText(aiReply),
        }),
      });

      if (!tgSendResp.ok) {
        console.error('Telegram send failed:', tgSendResp.status, await tgSendResp.text());
      }

      await supabase.from('telegram_messages').insert({
        update_id: update.update_id + 1_000_000_000,
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
