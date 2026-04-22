// Lists available image-generation models for a given provider+key.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Body { provider: string; apiKey?: string; comfyuiBaseUrl?: string }
interface Model { id: string; label: string; recommended?: boolean }

const GOOGLE_IMAGE_MODEL_PREFERENCE = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
];

function normalizeGoogleImageModel(model?: string): string {
  return (model || '').replace(/^models\//, '').trim();
}

function isGoogleAIStudioImageModel(meta: any): boolean {
  const id = normalizeGoogleImageModel(meta?.name || '');
  return (
    !!id &&
    (meta?.supportedGenerationMethods || []).includes('generateContent') &&
    (/gemini.*image/i.test(id) ||
      /gemini.*image/i.test(meta?.displayName || '') ||
      /nano.?banana/i.test(meta?.displayName || '') ||
      /generates? images?/i.test(meta?.description || ''))
  );
}

function modelRank(id: string): number {
  const idx = GOOGLE_IMAGE_MODEL_PREFERENCE.indexOf(id);
  return idx === -1 ? 999 : idx;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const { provider, apiKey, comfyuiBaseUrl } = (await req.json()) as Body;
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
        const imgs = all.filter(isGoogleAIStudioImageModel);
        models = imgs.map((m) => {
          const id = normalizeGoogleImageModel(m.name);
          let label = m.displayName || id;
          if (/gemini-3-pro-image-preview/i.test(id)) label = 'Nano Banana Pro (Gemini 3 Pro Image, preview)';
          else if (/gemini-3\.1-flash-image-preview/i.test(id)) label = 'Nano Banana 2 (Gemini 3.1 Flash Image)';
          else if (/gemini-2\.5-flash-image/i.test(id)) label = 'Nano Banana (Gemini 2.5 Flash Image)';
          return {
            id,
            label,
            recommended: /gemini-3\.1-flash-image-preview|gemini-3-pro-image-preview/i.test(id),
          };
        });
        models.sort((a, b) => modelRank(a.id) - modelRank(b.id) || a.label.localeCompare(b.label));
        if (models.length === 0) {
          models = [
            { id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2 (Gemini 3.1 Flash Image)', recommended: true },
            { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro (Gemini 3 Pro Image, preview)' },
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
    } else if (provider === 'nvidia' && apiKey) {
      // NVIDIA NIM — image-capable models from build.nvidia.com
      const r = await fetch('https://integrate.api.nvidia.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) {
        error = `NVIDIA ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } else {
        const j = await r.json();
        const all = (j?.data || []) as any[];
        // NVIDIA hosts well-known image models: SDXL, SD3, FLUX, consistory, picasso families
        const imgs = all.filter((m: any) =>
          /flux|stable-diffusion|sdxl|sd3|picasso|consistory|kandinsky|edify-image/i.test(m.id || ''),
        );
        models = imgs.map((m: any) => ({
          id: m.id,
          label: m.id,
          recommended: /flux\.1|sdxl-turbo|stable-diffusion-3/i.test(m.id),
        }));
        // Curated fallback (NVIDIA's catalog is huge; surface the popular image NIMs).
        if (models.length === 0) {
          models = [
            { id: 'black-forest-labs/flux.1-schnell', label: 'FLUX.1 Schnell (fast)', recommended: true },
            { id: 'black-forest-labs/flux.1-dev', label: 'FLUX.1 Dev (high quality)' },
            { id: 'stabilityai/sdxl-turbo', label: 'SDXL Turbo' },
            { id: 'stabilityai/stable-diffusion-3-medium', label: 'Stable Diffusion 3 Medium' },
            { id: 'stabilityai/stable-diffusion-xl', label: 'Stable Diffusion XL' },
          ];
        }
        models.sort((a, b) => (Number(b.recommended) - Number(a.recommended)) || a.label.localeCompare(b.label));
      }
    } else if (provider === 'xai' && apiKey) {
      // xAI (Grok) — image-capable model family
      const r = await fetch('https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) {
        error = `xAI ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } else {
        const j = await r.json();
        const all = (j?.data || []) as any[];
        const imgs = all.filter((m: any) => /image/i.test(m.id || ''));
        models = imgs.map((m: any) => ({
          id: m.id,
          label: m.id,
          recommended: /grok-2-image/i.test(m.id),
        }));
        if (models.length === 0) {
          models = [
            { id: 'grok-2-image-1212', label: 'Grok 2 Image (Dec 2024)', recommended: true },
            { id: 'grok-2-image', label: 'Grok 2 Image' },
          ];
        }
        models.sort((a, b) => (Number(b.recommended) - Number(a.recommended)) || a.label.localeCompare(b.label));
      }
    } else if (provider === 'unsplash' || provider === 'pexels') {
      models = [{ id: 'default', label: provider === 'unsplash' ? 'Unsplash search' : 'Pexels search', recommended: true }];
    } else if (provider === 'comfyui') {
      // ComfyUI doesn't have discrete models in the same sense; it uses workflows.
      // Return a placeholder that lets users know the server is configured.
      const baseUrl = (comfyuiBaseUrl || 'http://localhost:8188').replace(/\/+$/, '');
      try {
        const r = await fetch(`${baseUrl}/object_info`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`ComfyUI ${r.status}`);
        models = [{ id: 'comfyui-default', label: 'ComfyUI (uses your loaded workflow)', recommended: true }];
      } catch (e: any) {
        error = `ComfyUI not reachable at ${baseUrl}: ${e.message}. Make sure ComfyUI is running.`;
        models = [{ id: 'comfyui-default', label: 'ComfyUI (server offline)', recommended: false }];
      }
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
