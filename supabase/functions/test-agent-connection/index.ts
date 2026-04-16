// Universal probe for research + image providers used by the agent.
// Returns { ok, latency, sample?, error? } so the Settings UI can show a green pill with proof.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Body {
  kind: 'research' | 'image';
  provider: string;
  apiKey?: string;
  localUrl?: string;
  model?: string; // for image: actually invoke this model with a tiny generation call
}

async function probeResearch(provider: string, apiKey: string, localUrl: string): Promise<{ ok: boolean; sample?: string; latency: number; error?: string }> {
  const t0 = Date.now();
  const q = 'lovable cloud';
  try {
    if (provider === 'brave') {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=1`, {
        headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      });
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `Brave ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j = await r.json();
      return { ok: true, latency: Date.now() - t0, sample: j?.web?.results?.[0]?.title };
    }
    if (provider === 'tavily') {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query: q, max_results: 1 }),
      });
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `Tavily ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j = await r.json();
      return { ok: true, latency: Date.now() - t0, sample: j?.results?.[0]?.title };
    }
    if (provider === 'serper') {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 1 }),
      });
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `Serper ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j = await r.json();
      return { ok: true, latency: Date.now() - t0, sample: j?.organic?.[0]?.title };
    }
    if (provider === 'firecrawl') {
      const r = await fetch('https://api.firecrawl.dev/v2/search', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, limit: 1 }),
      });
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `Firecrawl ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j = await r.json();
      const item = j?.data?.[0] || j?.web?.[0];
      return { ok: true, latency: Date.now() - t0, sample: item?.title || item?.url };
    }
    if (provider === 'local') {
      const url = `${(localUrl || 'http://localhost:3001').replace(/\/$/, '')}/api/research/search?q=${encodeURIComponent(q)}&n=1`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!r || !r.ok) return { ok: false, latency: Date.now() - t0, error: 'Local server not reachable. Make sure the local worker is running.' };
      const j = await r.json();
      return { ok: true, latency: Date.now() - t0, sample: j?.results?.[0]?.title || 'Local browser ready' };
    }
    return { ok: false, latency: Date.now() - t0, error: `Unknown research provider: ${provider}` };
  } catch (e: any) {
    return { ok: false, latency: Date.now() - t0, error: e?.message || 'Unknown error' };
  }
}

// Tiny prompt for the live image generation probe — kept short to minimise cost/latency.
const TINY_IMG_PROMPT = 'a tiny red dot on white background';

async function probeImage(provider: string, apiKey: string, model?: string): Promise<{ ok: boolean; sample?: string; latency: number; error?: string; model?: string }> {
  const t0 = Date.now();
  try {
    if (provider === 'unsplash') {
      const r = await fetch(`https://api.unsplash.com/search/photos?query=sunset&per_page=1&client_id=${encodeURIComponent(apiKey)}`);
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `Unsplash ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j = await r.json();
      const url = j?.results?.[0]?.urls?.thumb;
      return { ok: true, latency: Date.now() - t0, sample: url ? `${j.total} photos available` : 'OK', model: 'unsplash-search' };
    }
    if (provider === 'pexels') {
      const r = await fetch('https://api.pexels.com/v1/search?query=sunset&per_page=1', { headers: { Authorization: apiKey } });
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `Pexels ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j = await r.json();
      return { ok: true, latency: Date.now() - t0, sample: `${j.total_results} photos available`, model: 'pexels-search' };
    }
    if (provider === 'openai') {
      // If a model was chosen, do a real (small) generation call so the user sees that model works on this key.
      if (model) {
        const r = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: TINY_IMG_PROMPT, size: '1024x1024', n: 1 }),
        });
        if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `OpenAI ${model}: ${r.status} ${(await r.text()).slice(0, 140)}` };
        return { ok: true, latency: Date.now() - t0, sample: `${model} generated 1 image`, model };
      }
      // Otherwise fall back to listing models.
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `OpenAI ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j = await r.json();
      const hasDalle = (j?.data || []).some((m: any) => /dall-e|gpt-image/i.test(m.id));
      return { ok: true, latency: Date.now() - t0, sample: hasDalle ? 'DALL-E / gpt-image available' : 'API key valid' };
    }
    if (provider === 'google') {
      // Real generation call against the chosen model — proves the key + model combination really works.
      if (model) {
        const m = model.replace(/^models\//, '');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: TINY_IMG_PROMPT }] }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
          }),
        });
        const j = await r.json().catch(() => ({} as any));
        if (!r.ok) {
          const msg = j?.error?.message || JSON.stringify(j).slice(0, 200);
          return { ok: false, latency: Date.now() - t0, error: `Google ${m}: ${r.status} ${msg.slice(0, 180)}` };
        }
        const parts = j?.candidates?.[0]?.content?.parts || [];
        const hasImg = parts.some((p: any) => p?.inlineData?.data || p?.inline_data?.data);
        if (!hasImg) {
          // The model accepted but returned no image — usually means model doesn't actually support image gen.
          return { ok: false, latency: Date.now() - t0, error: `Google ${m}: 200 but no image returned — model likely doesn't support image generation. Pick a Nano Banana model.`, model: m };
        }
        return { ok: true, latency: Date.now() - t0, sample: `${m} returned a real image · ${parts.length} part(s)`, model: m };
      }
      // No model — just check key.
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `Google ${r.status}: ${(await r.text()).slice(0, 120)}` };
      const j = await r.json();
      const imageModels = (j?.models || []).filter((mm: any) => /image/i.test(mm.name));
      const sample = imageModels.find((mm: any) => /gemini.*image|nano.*banana/i.test(mm.name))?.name?.replace('models/', '');
      return { ok: true, latency: Date.now() - t0, sample: sample ? `${sample} available` : `${imageModels.length} models`, model: sample };
    }
    if (provider === 'lovable') {
      const key = Deno.env.get('LOVABLE_API_KEY');
      if (!key) return { ok: false, latency: Date.now() - t0, error: 'LOVABLE_API_KEY not configured' };
      const m = model || 'google/gemini-2.5-flash-image';
      // Real generation call — confirm the chosen Nano Banana variant works.
      const r = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: TINY_IMG_PROMPT }],
          modalities: ['image', 'text'],
        }),
      });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok) return { ok: false, latency: Date.now() - t0, error: `Lovable AI ${m}: ${r.status} ${(j?.error || JSON.stringify(j)).toString().slice(0, 160)}`, model: m };
      const img = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!img) return { ok: false, latency: Date.now() - t0, error: `Lovable AI ${m}: no image returned`, model: m };
      return { ok: true, latency: Date.now() - t0, sample: `${m} returned a real image`, model: m };
    }
    return { ok: false, latency: Date.now() - t0, error: `Unknown image provider: ${provider}` };
  } catch (e: any) {
    return { ok: false, latency: Date.now() - t0, error: e?.message || 'Unknown error' };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const { kind, provider, apiKey, localUrl, model } = (await req.json()) as Body;
    if (!kind || !provider) {
      return new Response(JSON.stringify({ ok: false, error: 'kind and provider required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const needsKey = provider !== 'local' && provider !== 'lovable';
    if (needsKey && !apiKey) {
      return new Response(JSON.stringify({ ok: false, error: 'API key required for this provider' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const result = kind === 'research'
      ? await probeResearch(provider, apiKey || '', localUrl || '')
      : await probeImage(provider, apiKey || '', model);
    return new Response(JSON.stringify({ ...result, provider }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'Unknown error' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
