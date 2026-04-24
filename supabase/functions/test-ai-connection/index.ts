// Test an AI provider+model combo with a tiny ping to verify the connection works.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Body {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { provider, apiKey: customKey, model, baseUrl } = (await req.json()) as Body;
    if (!provider) {
      return new Response(JSON.stringify({ ok: false, error: 'provider required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const isLocal = provider === 'lmstudio';
    const useCustom = provider !== 'lovable' && (customKey || isLocal);
    const apiKey = useCustom ? (customKey || (isLocal ? 'lm-studio' : '')) : Deno.env.get('LOVABLE_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ ok: false, error: 'No API key available' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const targetModel = model || (provider === 'lovable' ? 'google/gemini-3-flash-preview' : '');
    if (!targetModel) {
      return new Response(JSON.stringify({ ok: false, error: 'model required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const t0 = Date.now();
    let resp: Response;

    if (provider === 'google' && useCustom) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel.replace(/^models\//, ''))}:generateContent?key=${encodeURIComponent(apiKey)}`;
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 5 } }),
      });
    } else if (provider === 'lmstudio') {
      const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
      if (!trimmed) {
        return new Response(JSON.stringify({ ok: false, error: 'LM Studio base URL is required' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (/localhost|127\.0\.0\.1|192\.168\.|10\.|172\./i.test(trimmed)) {
        return new Response(JSON.stringify({
          ok: true,
          provider,
          model: targetModel,
          latency: 0,
          note: 'LM Studio is on a private network. The cloud cannot reach it directly — your local worker will use it instead. Connection assumed OK.',
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const endpoint = trimmed.endsWith('/v1') ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: targetModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
      });
    } else {
      let endpoint = 'https://ai.gateway.lovable.dev/v1/chat/completions';
      let m = targetModel;
      if (useCustom) {
        if (provider === 'openai') endpoint = 'https://api.openai.com/v1/chat/completions';
        else if (provider === 'openrouter') endpoint = 'https://openrouter.ai/api/v1/chat/completions';
        else if (provider === 'anthropic') { endpoint = 'https://openrouter.ai/api/v1/chat/completions'; if (!m.startsWith('anthropic/')) m = `anthropic/${m}`; }
        else if (provider === 'nvidia') endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
        else if (provider === 'xai') endpoint = 'https://api.x.ai/v1/chat/completions';
      }
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
      });
    }

    const latency = Date.now() - t0;
    if (!resp.ok) {
      const t = await resp.text();
      return new Response(JSON.stringify({ ok: false, error: `Status ${resp.status}: ${t.slice(0, 200)}`, latency }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, provider, model: targetModel, latency }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'Unknown error' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
