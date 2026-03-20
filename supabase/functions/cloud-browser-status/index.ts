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
    return new Response(JSON.stringify({ sessions: [], debugUrls: {} }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Fetch running sessions
    const resp = await fetch(`${BB_API}/sessions?status=RUNNING`, {
      headers: { 'x-bb-api-key': BROWSERBASE_API_KEY },
    });

    if (!resp.ok) {
      console.error('Browserbase API error:', resp.status, await resp.text());
      return new Response(JSON.stringify({ sessions: [], debugUrls: {} }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const sessions = await resp.json();
    const debugUrls: Record<string, string> = {};

    // For each running session, get the debug connection info
    for (const session of (sessions || [])) {
      try {
        const debugResp = await fetch(`${BB_API}/sessions/${session.id}/debug`, {
          headers: { 'x-bb-api-key': BROWSERBASE_API_KEY },
        });
        if (debugResp.ok) {
          const debugData = await debugResp.json();
          // Construct the devtools inspector URL
          if (debugData.debuggerFullscreenUrl) {
            debugUrls[session.id] = debugData.debuggerFullscreenUrl;
          } else if (debugData.debuggerUrl) {
            debugUrls[session.id] = debugData.debuggerUrl;
          } else if (debugData.wsUrl || debugData.pages?.[0]) {
            // Construct from page info
            const page = debugData.pages?.[0];
            if (page?.debuggerUrl) {
              debugUrls[session.id] = page.debuggerUrl;
            } else {
              // Fallback: construct devtools URL
              const wsUrl = debugData.wsUrl || `wss://connect.browserbase.com/debug/${session.id}`;
              debugUrls[session.id] = `https://www.browserbase.com/devtools/inspector.html?${wsUrl}`;
            }
          }
          console.log(`Debug info for ${session.id}:`, JSON.stringify(debugData).slice(0, 500));
        }
      } catch (e) {
        console.error(`Failed to get debug info for session ${session.id}:`, e);
      }
    }

    return new Response(JSON.stringify({ sessions: sessions || [], debugUrls }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('Error fetching sessions:', e);
    return new Response(JSON.stringify({ sessions: [], debugUrls: {}, error: e.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
