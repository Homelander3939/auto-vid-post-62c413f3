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
        { id: 'google/gemini-3-pro-image-preview', label: 'Nano Banana Pro (Gemini 3 Pro Image, preview)', recommended: true },
        { id: 'google/gemini-3.1-flash-image-preview', label: 'Nano Banana 2 (Gemini 3.1 Flash Image)' },
        { id: 'google/gemini-2.5-flash-image', label: 'Nano Banana (Gemini 2.5 Flash Image)' },
      ];
    } else if (provider === 'google' && apiKey) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      if (!r.ok) {
        error = `Google ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } else {
        const j = await r.json();
        const all = (j?.models || []) as any[];
        // Image-capable: any model that supports generateContent AND looks like an image model.
        // Catches gemini-*-image, gemini-3-pro-image-preview, gemini-3.1-flash-image-preview, imagen-*.
        const imgs = all.filter((m) => {
          const supportsGen =
            (m.supportedGenerationMethods || []).includes('generateContent') ||
            (m.supportedActions || []).includes('predict');
          const looksImage =
            /image|imagen|nano.banana/i.test(m.name) ||
            /image|nano.banana/i.test(m.displayName || '') ||
            /image generation|generates? images?/i.test(m.description || '');
          return supportsGen && looksImage;
        });
        models = imgs.map((m) => {
          const id = m.name.replace(/^models\//, '');
          let label = m.displayName || id;
          if (/gemini-3-pro-image-preview/i.test(id)) label = 'Nano Banana Pro (Gemini 3 Pro Image, preview)';
          else if (/gemini-3\.1-flash-image-preview/i.test(id)) label = 'Nano Banana 2 (Gemini 3.1 Flash Image)';
          else if (/gemini-2\.5-flash-image/i.test(id)) label = 'Nano Banana (Gemini 2.5 Flash Image)';
          else if (/imagen/i.test(id)) label = `Imagen — ${id}`;
          return {
            id,
            label,
            recommended: /gemini-3\.1-flash-image-preview|gemini-3-pro-image-preview/i.test(id),
          };
        });
        // Recommended first, then alphabetical.
        models.sort((a, b) => (Number(b.recommended) - Number(a.recommended)) || a.label.localeCompare(b.label));
        if (models.length === 0) {
          // Fallback to the well-known Nano Banana family even if discovery failed.
          models = [
            { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro (Gemini 3 Pro Image, preview)', recommended: true },
            { id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2 (Gemini 3.1 Flash Image)' },
            { id: 'gemini-2.5-flash-image', label: 'Nano Banana (Gemini 2.5 Flash Image)' },
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
      // Stock providers don't have "models" — surface a single canonical entry.
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
