// Lists available image-generation models for a given provider+key.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Body { provider: string; apiKey?: string }
interface Model { id: string; label: string; recommended?: boolean }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const { provider, apiKey } = (await req.json()) as Body;
    let models: Model[] = [];
    let error: string | undefined;

    if (provider === 'lovable') {
      models = [
        { id: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image (Nano Banana)', recommended: true },
        { id: 'google/gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image (preview, higher quality)' },
        { id: 'google/gemini-3.1-flash-image-preview', label: 'Gemini 3.1 Flash Image (Nano Banana 2)' },
      ];
    } else if (provider === 'google' && apiKey) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      if (!r.ok) {
        error = `Google ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } else {
        const j = await r.json();
        const all = (j?.models || []) as any[];
        // Filter to models capable of image generation
        const imgs = all.filter((m) => /image/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'));
        models = imgs.map((m) => ({
          id: m.name.replace(/^models\//, ''),
          label: `${m.displayName || m.name.replace(/^models\//, '')}`,
          recommended: /gemini-2\.5-flash-image|nano-banana/i.test(m.name),
        }));
        if (models.length === 0) {
          // Fallback: show the well-known Nano Banana family
          models = [
            { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image (Nano Banana)', recommended: true },
            { id: 'gemini-2.0-flash-preview-image-generation', label: 'Gemini 2.0 Flash Image Preview' },
          ];
        }
      }
    } else if (provider === 'openai' && apiKey) {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) {
        error = `OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } else {
        const j = await r.json();
        const imgs = (j?.data || []).filter((m: any) => /dall-e|gpt-image/i.test(m.id));
        models = imgs.map((m: any) => ({
          id: m.id,
          label: m.id,
          recommended: /gpt-image-1/i.test(m.id),
        }));
      }
    } else if (provider === 'unsplash' || provider === 'pexels') {
      // Stock providers don't have "models", surface a single canonical entry.
      models = [{ id: 'default', label: provider === 'unsplash' ? 'Unsplash search' : 'Pexels search', recommended: true }];
    } else {
      error = `Unsupported provider or missing API key: ${provider}`;
    }

    return new Response(JSON.stringify({ models, error }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ models: [], error: e?.message || 'Unknown error' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
