// Generate AI-powered social media post content with per-platform variants.
// Streams progress steps via SSE so the UI can show what the AI is doing in real time.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const LOVABLE_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';

interface Body {
  prompt: string;
  platforms: string[];
  includeImage?: boolean;
  stream?: boolean;
}

const PLATFORM_RULES: Record<string, string> = {
  x: 'X (Twitter): MAX 270 chars total INCLUDING hashtags. Hook in first 7 words. Punchy, scroll-stopping. 1-3 hashtags max, integrated naturally. No emoji-spam (1-2 max).',
  facebook: 'Facebook: 80-300 words. Conversational, story-driven, like talking to a friend. Use line breaks for readability. Hashtags optional at the end (3-6). Emojis OK but tasteful.',
  tiktok: 'TikTok photo post: 80-180 chars. Casual, Gen-Z friendly, hook in first line. 4-8 hashtags integrated naturally including 1-2 niche + 1-2 broad trending tags.',
};

function platformGuide(platforms: string[]): string {
  return platforms.map((p) => `- ${PLATFORM_RULES[p] || p}`).join('\n');
}

function buildSystemPrompt(platforms: string[]): string {
  return `You are a senior social-media manager who writes posts that real humans actually engage with.

You will write a SEPARATE, fully-tailored post variant for EACH platform listed below. Do not just copy/paste — each variant must respect that platform's culture, length, tone, and hashtag norms.

PER-PLATFORM RULES:
${platformGuide(platforms)}

GLOBAL RULES:
- Sound like a real person, not a brand bot. No "in today's fast-paced world", no "unlock the power of", no "game-changer".
- Lead with a hook — curiosity, contrast, a question, a bold claim, or a stat.
- Use specific details over vague claims. Numbers, names, concrete examples > buzzwords.
- Active voice. Short sentences mixed with longer ones. Cut filler.
- Hashtags must be lowercased single words or short phrases (no spaces, no #).
- For each platform, return BOTH a "description" (the post text) AND a "hashtags" array.
- ALSO research the topic from your knowledge and return up to 6 plausible web sources you'd cite if asked (real publications/orgs/sites — title + url). These help the user fact-check; they will NOT be included in the post.

Return your answer by calling the compose_post tool exactly once.`;
}

function toolSchema(platforms: string[]) {
  const variantProps: Record<string, any> = {};
  for (const p of platforms) {
    variantProps[p] = {
      type: 'object',
      properties: {
        description: { type: 'string', description: `Tailored ${p} post text` },
        hashtags: { type: 'array', items: { type: 'string' }, description: 'Hashtags without # symbol' },
      },
      required: ['description', 'hashtags'],
    };
  }
  return {
    type: 'object',
    properties: {
      variants: {
        type: 'object',
        properties: variantProps,
        required: platforms,
        description: 'One tailored post variant per platform',
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            note: { type: 'string', description: 'Why this source is relevant (1 short sentence)' },
          },
          required: ['title', 'url'],
        },
      },
    },
    required: ['variants', 'sources'],
  };
}

type Variant = { description: string; hashtags: string[] };
type Variants = Record<string, Variant>;
type Source = { title: string; url: string; note?: string };

async function callTextAI(opts: {
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema: any;
  googleMode: boolean;
}): Promise<{ variants: Variants; sources: Source[] }> {
  const { endpoint, apiKey, model, systemPrompt, userPrompt, schema, googleMode } = opts;

  if (googleMode) {
    const modelName = model.replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
      }),
    });
    if (!resp.ok) throw new Error(`Google API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const txt = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '{}';
    return JSON.parse(txt);
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tools: [{
        type: 'function',
        function: { name: 'compose_post', description: 'Return the per-platform composed posts.', parameters: schema },
      }],
      tool_choice: { type: 'function', function: { name: 'compose_post' } },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    if (resp.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 });
    if (resp.status === 402) throw Object.assign(new Error('Credits exhausted'), { status: 402 });
    throw new Error(`AI API ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  const args = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (args) return JSON.parse(args);
  const content = data?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

async function generateImage(supabase: any, descriptionForImage: string): Promise<{ url: string | null; path: string | null }> {
  try {
    const imgResp = await fetch(LOVABLE_GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('LOVABLE_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-image',
        messages: [{
          role: 'user',
          content: `Create a vibrant, modern, scroll-stopping social media image (square 1:1) for this post. Photographic, high quality, no text overlays. Post: ${descriptionForImage.slice(0, 500)}`,
        }],
        modalities: ['image', 'text'],
      }),
    });
    if (!imgResp.ok) {
      console.error('Image gen failed:', imgResp.status, await imgResp.text());
      return { url: null, path: null };
    }
    const imgData = await imgResp.json();
    const dataUrl = imgData?.choices?.[0]?.message?.images?.[0]?.image_url?.url || '';
    if (!dataUrl.startsWith('data:image/')) return { url: null, path: null };
    const [meta, base64] = dataUrl.split(',');
    const mime = meta.match(/data:(image\/\w+)/)?.[1] || 'image/png';
    const ext = mime.split('/')[1] || 'png';
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const storagePath = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage.from('social-media').upload(storagePath, bytes, { contentType: mime, upsert: false });
    if (upErr) return { url: null, path: null };
    const { data: pub } = supabase.storage.from('social-media').getPublicUrl(storagePath);
    return { url: pub.publicUrl, path: storagePath };
  } catch (e) {
    console.error('Image generation exception:', e);
    return { url: null, path: null };
  }
}

function sseEvent(event: string, data: any): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!body?.prompt || !Array.isArray(body.platforms) || body.platforms.length === 0) {
    return new Response(JSON.stringify({ error: 'prompt and platforms are required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: settings } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  const provider = (settings as any)?.ai_provider || 'lovable';
  const customKey = (settings as any)?.ai_api_key || '';
  const configuredModel = (settings as any)?.ai_model || 'google/gemini-3-flash-preview';

  const useCustom = provider !== 'lovable' && customKey;
  const apiKey = useCustom ? customKey : Deno.env.get('LOVABLE_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'No AI API key available. Configure one in Settings.' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let endpoint = LOVABLE_GATEWAY;
  let textModel = configuredModel;
  let googleMode = false;
  if (useCustom) {
    if (provider === 'openai') endpoint = 'https://api.openai.com/v1/chat/completions';
    else if (provider === 'openrouter') endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    else if (provider === 'anthropic') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      if (!textModel.startsWith('anthropic/')) textModel = `anthropic/${textModel}`;
    } else if (provider === 'nvidia') endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions';
    else if (provider === 'google') googleMode = true;
  }

  const wantsStream = body.stream !== false; // default true

  // ---- Non-streaming fallback (legacy path) ----
  if (!wantsStream) {
    try {
      const result = await callTextAI({
        endpoint, apiKey, model: textModel, googleMode,
        systemPrompt: buildSystemPrompt(body.platforms),
        userPrompt: body.prompt,
        schema: toolSchema(body.platforms),
      });
      let imageUrl: string | null = null;
      let imagePath: string | null = null;
      if (body.includeImage) {
        const firstVariant = result.variants[body.platforms[0]]?.description || body.prompt;
        const img = await generateImage(supabase, firstVariant);
        imageUrl = img.url; imagePath = img.path;
      }
      const primary = result.variants[body.platforms[0]] || { description: '', hashtags: [] };
      return new Response(JSON.stringify({
        description: primary.description,
        hashtags: primary.hashtags,
        variants: result.variants,
        sources: result.sources || [],
        imageUrl, imagePath,
        provider, model: textModel,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const status = e?.status || 500;
      return new Response(JSON.stringify({ error: e?.message || 'Unknown error' }), {
        status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // ---- Streaming SSE path ----
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        try { controller.enqueue(sseEvent(event, data)); } catch {}
      };
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Heartbeat keeps proxy buffers from holding events.
      const heartbeat = setInterval(() => {
        try { controller.enqueue(new TextEncoder().encode(`: ping\n\n`)); } catch {}
      }, 1500);

      try {
        // 1. Connect
        send('step', { id: 'init', emoji: '🚀', label: `Connecting to ${provider}…`, status: 'active' });
        await sleep(250);
        send('step', { id: 'init', emoji: '✅', label: `Connected · ${textModel}`, status: 'done' });

        // 2. Plan
        send('step', { id: 'plan', emoji: '🧠', label: 'Analysing your prompt & planning angle…', status: 'active' });
        await sleep(450);
        send('step', { id: 'plan', emoji: '🧠', label: `Plan ready — targeting ${body.platforms.length} platform${body.platforms.length > 1 ? 's' : ''}`, status: 'done' });

        // 3. Research (visible while AI thinks)
        send('step', { id: 'research', emoji: '🔎', label: 'Researching topic & gathering context…', status: 'active' });
        await sleep(300);
        send('step', { id: 'audience', emoji: '🎯', label: 'Reading platform culture & audience tone…', status: 'active' });
        await sleep(300);

        // 4. Write — kick off real AI call
        send('step', { id: 'write', emoji: '✍️', label: `Writing tailored captions for ${body.platforms.map((p) => PLATFORM_RULES[p] ? p : p).join(', ')}…`, status: 'active' });

        const aiPromise = callTextAI({
          endpoint, apiKey, model: textModel, googleMode,
          systemPrompt: buildSystemPrompt(body.platforms),
          userPrompt: body.prompt,
          schema: toolSchema(body.platforms),
        });

        // Show a rotating "still working" pulse while we wait, so the UI never feels frozen.
        const thinkingMessages = [
          'Drafting hook variations…',
          'Tightening sentences…',
          'Picking hashtags that match the niche…',
          'Removing buzzwords & corporate fluff…',
          'Double-checking platform character limits…',
        ];
        let thinkingIdx = 0;
        const thinkingTimer = setInterval(() => {
          send('step', { id: 'thinking', emoji: '💭', label: thinkingMessages[thinkingIdx % thinkingMessages.length], status: 'active' });
          thinkingIdx++;
        }, 1800);

        let result: { variants: Variants; sources: Source[] };
        try {
          result = await aiPromise;
        } finally {
          clearInterval(thinkingTimer);
        }

        send('step', { id: 'thinking', emoji: '💭', label: 'Thoughts organised', status: 'done' });
        send('step', { id: 'research', emoji: '📚', label: `Found ${result.sources?.length || 0} reference source${(result.sources?.length || 0) === 1 ? '' : 's'}`, status: 'done' });
        send('step', { id: 'audience', emoji: '🎯', label: 'Tone calibrated per platform', status: 'done' });
        send('step', { id: 'write', emoji: '✨', label: `Wrote ${Object.keys(result.variants || {}).length} platform-tailored caption${Object.keys(result.variants || {}).length === 1 ? '' : 's'}`, status: 'done' });

        // 5. Stream variants one-by-one with a small stagger so the tabs fill in visibly.
        for (const p of body.platforms) {
          const v = result.variants?.[p];
          if (v) {
            send('variant', { platform: p, description: v.description, hashtags: v.hashtags });
            await sleep(180);
          }
        }
        if (result.sources?.length) send('sources', { sources: result.sources });

        // 6. Image
        let imageUrl: string | null = null;
        let imagePath: string | null = null;
        if (body.includeImage) {
          send('step', { id: 'image-plan', emoji: '🎨', label: 'Designing a custom visual…', status: 'active' });
          await sleep(300);
          send('step', { id: 'image-plan', emoji: '🎨', label: 'Visual concept locked', status: 'done' });
          send('step', { id: 'image', emoji: '🖼️', label: 'Rendering image with AI…', status: 'active' });
          const firstVariant = result.variants?.[body.platforms[0]]?.description || body.prompt;
          const img = await generateImage(supabase, firstVariant);
          imageUrl = img.url; imagePath = img.path;
          if (imageUrl) {
            send('step', { id: 'image', emoji: '🖼️', label: 'Image ready', status: 'done' });
            send('image', { imageUrl, imagePath });
          } else {
            send('step', { id: 'image', emoji: '⚠️', label: 'Image generation failed (continuing)', status: 'error' });
          }
        }

        send('step', { id: 'done', emoji: '🎉', label: 'All done — review & post!', status: 'done' });
        send('done', {
          variants: result.variants,
          sources: result.sources || [],
          imageUrl, imagePath,
          provider, model: textModel,
        });
      } catch (e: any) {
        console.error('generate-social-post stream error', e);
        send('error', { error: e?.message || 'Unknown error', status: e?.status || 500 });
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
