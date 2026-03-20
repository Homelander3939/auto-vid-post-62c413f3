import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';
const AI_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';
const MAX_RUNTIME_MS = 20_000;
const MIN_REMAINING_MS = 3_000;

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
): Promise<{ text: string; images: TelegramMediaRef[]; files: TelegramMediaRef[]; hasMedia: boolean }> {
  const text = message.text || message.caption || '';
  const images: TelegramMediaRef[] = [];
  const files: TelegramMediaRef[] = [];

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

  const voiceLike = message.voice || message.audio || message.video || null;
  if (voiceLike?.file_id) {
    const download = await fetchTelegramFileBytes(voiceLike.file_id, lovableKey, telegramKey);
    if (download) {
      const guessedType = message.voice
        ? 'audio/ogg'
        : message.audio?.mime_type || message.video?.mime_type || download.mimeType;
      const media = await uploadTelegramMediaToStorage(
        supabase,
        download.bytes,
        guessedType,
        message.audio?.file_name || `telegram-${message.voice ? 'voice' : message.video ? 'video' : 'audio'}-${Date.now()}.${extFromMime(guessedType)}`,
      );
      if (media) files.push(media);
    }
  }

  return {
    text,
    images,
    files,
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
      const { text: userText, images, files, hasMedia } = await extractMessageContent(
        supabase,
        message,
        LOVABLE_API_KEY,
        TELEGRAM_API_KEY,
      );

      if (!userText && !hasMedia) continue;

      const displayText = userText
        || (images.length > 0 ? '📷 [Photo]'
          : files.some((f) => f.type.startsWith('audio/')) ? '🎤 [Voice message]'
            : '📎 [File]');

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

      const currentAiMsg: any = {
        role: 'user',
        content: userText || (images.length ? 'What do you see in this image?' : 'I sent a file.'),
      };

      if (images.length > 0) {
        const parts: any[] = [];
        parts.push({ type: 'text', text: userText || 'Please analyze this image in detail.' });
        images.forEach((img) => parts.push({ type: 'image_url', image_url: { url: img.url } }));
        currentAiMsg.content = parts;
      } else if (files.length > 0) {
        currentAiMsg.content = `${userText || 'I sent a file.'}\n\nAttached files:\n${files
          .map((f) => `- ${f.name} (${f.type}, ${Math.round((f.size || 0) / 1024)}KB)`)
          .join('\n')}`;
      }

      contextMessages.push(currentAiMsg);

      const appContext = await getAppContext(supabase);
      const model = images.length > 0 ? 'google/gemini-2.5-flash' : 'google/gemini-3-flash-preview';

      let aiReply = "Sorry, I couldn't process your message right now.";
      try {
        const aiResp = await fetch(AI_GATEWAY, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'system',
                content: `You are a helpful AI assistant for the Video Uploader app. You have FULL ACCESS to the app's live data.

${appContext}

You help users manage video uploads to YouTube, TikTok, and Instagram. Be concise for Telegram format.
When users ask about queued jobs, scheduled uploads, or settings — USE THE LIVE DATA ABOVE to answer accurately.
When users send images, analyze what is ACTUALLY in the image and avoid guessing.
When users send non-image files/voice, acknowledge receipt and explain clearly if transcription/content extraction is not available.
NEVER say you don't have access to the data. You DO have access.
Keep responses short and readable for Telegram.`,
              },
              ...contextMessages,
            ],
          }),
        });

        if (aiResp.ok) {
          const aiData = await aiResp.json();
          aiReply = aiData.choices?.[0]?.message?.content || aiReply;
        } else {
          console.error('AI response error:', aiResp.status, await aiResp.text());
        }
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
