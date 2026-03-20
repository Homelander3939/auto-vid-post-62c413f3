import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/telegram';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

    const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
    if (!TELEGRAM_API_KEY) throw new Error('TELEGRAM_API_KEY is not configured');

    const { chat_id, text, parse_mode, action } = await req.json();

    // Ensure chat_id is a number for Telegram API
    const numericChatId = typeof chat_id === 'string' ? Number(chat_id) : chat_id;

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