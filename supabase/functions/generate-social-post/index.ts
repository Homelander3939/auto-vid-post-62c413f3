// Generate AI-powered social media post content (description, hashtags, optional image).
// Uses Lovable AI Gateway by default; routes to a custom provider if user configured one.
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
}

function platformGuide(platforms: string[]): string {
  const parts: string[] = [];
  if (platforms.includes('x')) parts.push('- X (Twitter): keep under 280 chars total INCLUDING hashtags. Punchy, hook-first.');
  if (platforms.includes('facebook')) parts.push('- Facebook: 1-3 paragraphs, conversational, friendly. Hashtags optional but allowed at end.');
  if (platforms.includes('tiktok')) parts.push('- TikTok photo post: short caption with 4-8 hashtags integrated naturally.');
  return parts.join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = (await req.json()) as Body;
    if (!body?.prompt || !Array.isArray(body.platforms) || body.platforms.length === 0) {
      return new Response(JSON.stringify({ error: 'prompt and platforms are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Read AI provider config
    const { data: settings } = await supabase.from('app_settings').select('*').eq('id', 1).single();
    const provider = (settings as any)?.ai_provider || 'lovable';
    const customKey = (settings as any)?.ai_api_key || '';
    const configuredModel = (settings as any)?.ai_model || 'google/gemini-3-flash-preview';

    const useCustom = provider !== 'lovable' && customKey;
    const apiKey = useCustom ? customKey : Deno.env.get('LOVABLE_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No AI API key available. Configure one in Settings or use Lovable AI.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let endpoint = LOVABLE_GATEWAY;
    let textModel = configuredModel;
    if (useCustom) {
      if (provider === 'openai') {
        endpoint = 'https://api.openai.com/v1/chat/completions';
        if (!textModel.startsWith('gpt-')) textModel = 'gpt-4o-mini';
      } else if (provider === 'openrouter') {
        endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      } else if (provider === 'anthropic') {
        // Anthropic has a different shape; for simplicity we proxy through OpenAI-compat via OpenRouter style
        endpoint = 'https://openrouter.ai/api/v1/chat/completions';
        if (!textModel.includes('claude')) textModel = 'anthropic/claude-3.5-sonnet';
      }
    }

    const systemPrompt = `You are an expert social media manager. Given a user prompt, write a single high-quality post.
Follow these per-platform rules:
${platformGuide(body.platforms)}

Always research the topic mentally and write in human, conversational language — no fluff, no AI clichés like "in today's fast-paced world".
Integrate hashtags naturally into the description if appropriate, AND also return them in the dedicated hashtags array.
Return JSON with exactly: { "description": string, "hashtags": string[] (no # symbol), "sources": [{title?, url?}] }.`;

    const textResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: textModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: body.prompt },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'compose_post',
            description: 'Return the composed post.',
            parameters: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                hashtags: { type: 'array', items: { type: 'string' } },
                sources: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { title: { type: 'string' }, url: { type: 'string' } },
                  },
                },
              },
              required: ['description', 'hashtags'],
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'compose_post' } },
      }),
    });

    if (!textResp.ok) {
      const t = await textResp.text();
      console.error('AI text error', textResp.status, t);
      if (textResp.status === 429) {
        return new Response(JSON.stringify({ error: 'AI rate limited. Try again in a moment.' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (textResp.status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted. Add funds in Settings > Workspace > Usage.' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`AI generation failed: ${textResp.status}`);
    }

    const textData = await textResp.json();
    const toolCall = textData?.choices?.[0]?.message?.tool_calls?.[0];
    let parsed: { description: string; hashtags: string[]; sources?: any[] } = {
      description: '', hashtags: [], sources: [],
    };
    if (toolCall?.function?.arguments) {
      try { parsed = JSON.parse(toolCall.function.arguments); } catch {}
    } else {
      // Fallback: use plain content
      const content = textData?.choices?.[0]?.message?.content || '';
      parsed.description = content;
    }

    let imageUrl: string | null = null;
    let imagePath: string | null = null;

    if (body.includeImage) {
      try {
        const imgResp = await fetch(LOVABLE_GATEWAY, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('LOVABLE_API_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash-image',
            messages: [{ role: 'user', content: `Create a vibrant, modern social media image for this post: ${parsed.description.slice(0, 500)}` }],
            modalities: ['image', 'text'],
          }),
        });
        if (imgResp.ok) {
          const imgData = await imgResp.json();
          const dataUrl = imgData?.choices?.[0]?.message?.images?.[0]?.image_url?.url || '';
          if (dataUrl.startsWith('data:image/')) {
            const [meta, base64] = dataUrl.split(',');
            const mime = meta.match(/data:(image\/\w+)/)?.[1] || 'image/png';
            const ext = mime.split('/')[1] || 'png';
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const storagePath = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
            const { error: upErr } = await supabase.storage.from('social-media').upload(storagePath, bytes, {
              contentType: mime, upsert: false,
            });
            if (!upErr) {
              imagePath = storagePath;
              const { data: pub } = supabase.storage.from('social-media').getPublicUrl(storagePath);
              imageUrl = pub.publicUrl;
            }
          }
        } else {
          console.error('Image gen failed:', imgResp.status, await imgResp.text());
        }
      } catch (e) {
        console.error('Image generation exception:', e);
      }
    }

    return new Response(JSON.stringify({
      description: parsed.description || '',
      hashtags: parsed.hashtags || [],
      imageUrl,
      imagePath,
      sources: parsed.sources || [],
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('generate-social-post error', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
