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
];

async function executeTool(supabase: any, name: string, args: any): Promise<string> {
  switch (name) {
    case 'create_upload_job': {
      const { data, error } = await supabase.from('upload_jobs').insert({
        video_file_name: args.video_file_name, title: args.title || '', description: args.description || '',
        tags: args.tags || [], target_platforms: args.target_platforms || [], status: 'pending',
        video_storage_path: args.video_storage_path || null,
      }).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Job created: "${data.title}" → ${data.target_platforms.join(', ')} [pending]`;
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
  return text.replace(/\u0000/g, '').slice(0, 3900);
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

      const contextMessages = (history || []).reverse().map((m: any) => ({
        role: m.is_bot ? 'assistant' : 'user',
        content: m.text || '',
      }));

      // Build the AI message with multimodal content
      const currentAiMsg: any = { role: 'user', content: '' };

      if (audioDataUrl) {
        // Pass audio to Gemini for transcription + response
        const parts: any[] = [];
        parts.push({
          type: 'text',
          text: userText || 'Please transcribe this voice message and respond to what the person is saying. First show the transcription, then respond.',
        });
        parts.push({
          type: 'image_url',
          image_url: { url: audioDataUrl },
        });
        currentAiMsg.content = parts;
      } else if (images.length > 0) {
        const parts: any[] = [];
        parts.push({ type: 'text', text: userText || 'Please analyze this image in detail.' });
        images.forEach((img) => parts.push({ type: 'image_url', image_url: { url: img.url } }));
        currentAiMsg.content = parts;
      } else if (files.length > 0) {
        currentAiMsg.content = `${userText || 'I sent a file.'}\n\nAttached files:\n${files
          .map((f) => `- ${f.name} (${f.type}, ${Math.round((f.size || 0) / 1024)}KB)`)
          .join('\n')}`;
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
      const model = (images.length > 0 || audioDataUrl) ? 'google/gemini-2.5-flash' : 'google/gemini-2.5-flash';

      const systemPrompt = `You are a helpful AI assistant for the Video Uploader app. You have FULL ACCESS to the app's live data AND can perform actions.

${appContext}

YOU CAN PERFORM ACTIONS via tool calls:
1. create_upload_job — Queue a video for upload
2. schedule_upload — Schedule a video upload for a specific time
3. update_cron_schedule — Change the automatic cron schedule
4. delete_upload_job — Delete/cancel a queued job
5. retry_failed_job — Retry a failed upload

When users ask you to do something (upload, schedule, retry, delete, change cron), use the tools.
When users send images, analyze them in detail.
When users send voice messages, transcribe them first, then respond.
NEVER say you can't do something. You CAN perform actions and access data.
Keep responses concise for Telegram.`;

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
