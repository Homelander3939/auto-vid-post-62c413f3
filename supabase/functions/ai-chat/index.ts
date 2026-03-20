import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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

    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: 'messages array is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const systemPrompt = `You are a helpful AI assistant integrated into a Video Uploader application.
You help users with:
- Managing video uploads to YouTube, TikTok, and Instagram
- Writing video titles, descriptions, and tags
- Scheduling upload campaigns
- Troubleshooting upload errors
- General questions about content creation and social media strategy
- Analyzing images and files that users share with you

When users share images, analyze them thoroughly and provide helpful feedback.
When users share documents or text files, read and summarize them.
Be concise, friendly, and actionable. Use markdown formatting for better readability.
If the user asks about upload status, suggest checking the Upload Queue page.
If asked about scheduling, explain the Campaign scheduler feature.`;

    // Transform messages to support multimodal content (images)
    const transformedMessages = messages.map((msg: any) => {
      if (msg.role === 'system') return msg;
      
      // If message has image attachments, convert to multimodal format
      if (msg.images && msg.images.length > 0) {
        const content: any[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const img of msg.images) {
          content.push({
            type: 'image_url',
            image_url: { url: img.url },
          });
        }
        return { role: msg.role, content };
      }
      
      // If message has file attachments (non-image), add file info as text
      if (msg.files && msg.files.length > 0) {
        let fileContext = msg.content || '';
        for (const file of msg.files) {
          fileContext += `\n\n[Attached file: ${file.name} (${file.type}, ${file.size})]`;
          if (file.textContent) {
            fileContext += `\nFile contents:\n\`\`\`\n${file.textContent}\n\`\`\``;
          }
        }
        return { role: msg.role, content: fileContext };
      }
      
      return { role: msg.role, content: msg.content };
    });

    // Use gemini-2.5-flash for multimodal support
    const hasImages = messages.some((m: any) => m.images && m.images.length > 0);
    const model = hasImages ? 'google/gemini-2.5-flash' : 'google/gemini-2.5-flash';

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...transformedMessages,
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in Settings > Workspace > Usage." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI service error" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("chat error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
