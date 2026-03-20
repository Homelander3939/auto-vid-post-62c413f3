import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const BB_API = 'https://api.browserbase.com/v1';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const BROWSERBASE_API_KEY = Deno.env.get('BROWSERBASE_API_KEY');
  if (!BROWSERBASE_API_KEY) {
    return new Response(JSON.stringify({ sessions: [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const resp = await fetch(`${BB_API}/sessions?status=RUNNING`, {
      headers: { 'x-bb-api-key': BROWSERBASE_API_KEY },
    });

    if (!resp.ok) {
      console.error('Browserbase API error:', await resp.text());
      return new Response(JSON.stringify({ sessions: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await resp.json();
    return new Response(JSON.stringify({ sessions: data || [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('Error fetching sessions:', e);
    return new Response(JSON.stringify({ sessions: [], error: e.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
