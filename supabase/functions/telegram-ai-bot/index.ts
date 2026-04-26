import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';
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

  const voiceLike = message.voice || message.audio || null;
  if (voiceLike?.file_id) {
    const download = await fetchTelegramFileBytes(voiceLike.file_id, lovableKey, telegramKey);
    if (download) {
      const guessedType = message.voice ? 'audio/ogg' : message.audio?.mime_type || download.mimeType;
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
    hasMedia: images.length > 0 || files.length > 0,
  };
}

/* ── Main: poll Telegram, store messages, queue AI processing to local server ── */

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
          : files.length > 0 ? '📎 [File]'
            : '');

      // Store the incoming message
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

      // Send typing indicator via Telegram
      void fetch(`${TELEGRAM_GATEWAY}/sendChatAction`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'X-Connection-Api-Key': TELEGRAM_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
      });

      // Queue processing for the local worker. The local server polls pending_commands
      // and answers via the user's own Telegram bot token + LM Studio, avoiding cloud AI credits.
      const { error: queueErr } = await supabase.from('pending_commands').insert({
        command: 'ai_response',
        args: {
          chat_id: chatId,
          user_text: displayText,
          update_id: update.update_id,
          images,
          files,
          source: 'telegram-ai-bot-local-queue',
        },
        status: 'pending',
      });
      if (queueErr) {
        console.error('Failed to queue Telegram AI response:', queueErr.message);
        continue;
      }

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
