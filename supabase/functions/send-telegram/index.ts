import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/telegram';

async function mirrorBotMessage(chatId: number, text: string, source: string) {
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key || !chatId) return;
    const supabase = createClient(url, key);
    // Synthesize a unique negative update_id so it never collides with real Telegram updates.
    const updateId = -Math.floor(Date.now() * 1000 + Math.random() * 1000);
    await supabase.from('telegram_messages').insert({
      update_id: updateId,
      chat_id: chatId,
      text: (text || '').slice(0, 4000),
      is_bot: true,
      raw_update: { source, synthetic: true },
    });
  } catch (e) {
    console.error('[send-telegram] mirror failed:', e);
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sendPhotoViaGateway({
  lovableApiKey,
  telegramApiKey,
  chatId,
  photoBase64,
  mimeType,
  caption,
  parseMode,
}: {
  lovableApiKey: string;
  telegramApiKey: string;
  chatId: string | number;
  photoBase64: string;
  mimeType: string;
  caption?: string;
  parseMode: string;
}) {
  const bytes = base64ToBytes(photoBase64);
  const boundary = `----lovable-${crypto.randomUUID()}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];

  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
  if (caption) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\n${parseMode}\r\n`));
  }
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.png"\r\nContent-Type: ${mimeType || 'image/png'}\r\n\r\n`));
  parts.push(bytes);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }

  const response = await fetch(`${GATEWAY_URL}/sendPhoto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${lovableApiKey}`,
      'X-Connection-Api-Key': telegramApiKey,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(`Telegram API call failed [${response.status}]: ${JSON.stringify(data)}`);
  }

  return data;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

    const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
    if (!TELEGRAM_API_KEY) throw new Error('TELEGRAM_API_KEY is not configured');

    const { chat_id, text, parse_mode, action, photo_base64, photo_mime_type } = await req.json();

    // Ensure chat_id is a number for Telegram API
    const numericChatId = typeof chat_id === 'string' ? Number(chat_id) : chat_id;

    // Photo upload path (used for obstacle screenshots)
    if (photo_base64) {
      if (!chat_id) {
        return new Response(
          JSON.stringify({ success: false, error: 'chat_id is required when photo_base64 is provided' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const photoResult = await sendPhotoViaGateway({
        lovableApiKey: LOVABLE_API_KEY,
        telegramApiKey: TELEGRAM_API_KEY,
        chatId: numericChatId,
        photoBase64: photo_base64,
        mimeType: photo_mime_type || 'image/png',
        caption: text,
        parseMode: parse_mode || 'HTML',
      });

      return new Response(
        JSON.stringify({ success: true, message_id: photoResult.result?.message_id }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // If action is specified (e.g. "typing"), send chat action instead of message
    if (action) {
      const actionResp = await fetch(`${GATEWAY_URL}/sendChatAction`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'X-Connection-Api-Key': TELEGRAM_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chat_id: numericChatId, action }),
      });
      const actionData = await actionResp.json();
      return new Response(
        JSON.stringify({ success: actionResp.ok, result: actionData.result }),
        { status: actionResp.ok ? 200 : 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!chat_id || !text) {
      return new Response(
        JSON.stringify({ success: false, error: 'chat_id and text are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const response = await fetch(`${GATEWAY_URL}/sendMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'X-Connection-Api-Key': TELEGRAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: numericChatId,
        text,
        parse_mode: parse_mode || 'HTML',
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Telegram API call failed [${response.status}]: ${JSON.stringify(data)}`);
    }

    return new Response(
      JSON.stringify({ success: true, message_id: data.result?.message_id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Error sending Telegram message:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});