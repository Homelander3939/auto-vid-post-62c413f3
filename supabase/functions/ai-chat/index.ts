import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const AI_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';

/* ── Tool definitions ─────────────────────────────────── */

const tools = [
  {
    type: 'function',
    function: {
      name: 'create_upload_job',
      description: 'Create a new video upload job in the queue. Use when user wants to upload a video to platforms.',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string', description: 'Name of the video file' },
          title: { type: 'string', description: 'Video title for platforms' },
          description: { type: 'string', description: 'Video description' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags/hashtags for the video' },
          target_platforms: {
            type: 'array',
            items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] },
            description: 'Platforms to upload to',
          },
          video_storage_path: { type: 'string', description: 'Storage path if video was already uploaded' },
        },
        required: ['video_file_name', 'title', 'target_platforms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_upload',
      description: 'Schedule a video upload for a specific date/time.',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string', description: 'Name of the video file' },
          title: { type: 'string', description: 'Video title' },
          description: { type: 'string', description: 'Video description' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags/hashtags' },
          target_platforms: {
            type: 'array',
            items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] },
            description: 'Platforms to upload to',
          },
          scheduled_at: { type: 'string', description: 'ISO 8601 datetime for when to upload' },
          video_storage_path: { type: 'string', description: 'Storage path if video was already uploaded' },
        },
        required: ['video_file_name', 'title', 'target_platforms', 'scheduled_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_cron_schedule',
      description: 'Update the automatic upload cron schedule settings.',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'Enable or disable the cron schedule' },
          cron_expression: { type: 'string', description: 'Cron expression (e.g. "0 9 * * *" for daily at 9am)' },
          platforms: {
            type: 'array',
            items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] },
            description: 'Platforms for scheduled uploads',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_upload_job',
      description: 'Delete/cancel an upload job by its ID.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'The UUID of the upload job to delete' },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed_job',
      description: 'Retry a failed upload job by resetting its status to pending.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'The UUID of the failed job to retry' },
        },
        required: ['job_id'],
      },
    },
  },
];

/* ── Tool executor ────────────────────────────────────── */

async function executeTool(supabase: any, name: string, args: any): Promise<string> {
  switch (name) {
    case 'create_upload_job': {
      const { data, error } = await supabase.from('upload_jobs').insert({
        video_file_name: args.video_file_name,
        title: args.title || '',
        description: args.description || '',
        tags: args.tags || [],
        target_platforms: args.target_platforms || [],
        status: 'pending',
        video_storage_path: args.video_storage_path || null,
      }).select().single();
      if (error) return `❌ Failed to create job: ${error.message}`;
      return `✅ Upload job created!\nID: ${data.id}\nTitle: "${data.title}"\nFile: ${data.video_file_name}\nPlatforms: ${data.target_platforms.join(', ')}\nStatus: pending`;
    }
    case 'schedule_upload': {
      const { data, error } = await supabase.from('scheduled_uploads').insert({
        video_file_name: args.video_file_name,
        title: args.title || '',
        description: args.description || '',
        tags: args.tags || [],
        target_platforms: args.target_platforms || [],
        scheduled_at: args.scheduled_at,
        status: 'scheduled',
        video_storage_path: args.video_storage_path || null,
      }).select().single();
      if (error) return `❌ Failed to schedule: ${error.message}`;
      return `✅ Upload scheduled!\nID: ${data.id}\nTitle: "${data.title}"\nFile: ${data.video_file_name}\nPlatforms: ${data.target_platforms.join(', ')}\nScheduled: ${new Date(data.scheduled_at).toLocaleString()}`;
    }
    case 'update_cron_schedule': {
      const update: any = {};
      if (args.enabled !== undefined) update.enabled = args.enabled;
      if (args.cron_expression) update.cron_expression = args.cron_expression;
      if (args.platforms) update.platforms = args.platforms;
      const { data, error } = await supabase.from('schedule_config')
        .update(update).eq('id', 1).select().single();
      if (error) return `❌ Failed to update cron: ${error.message}`;
      return `✅ Cron schedule updated!\nEnabled: ${data.enabled}\nExpression: ${data.cron_expression}\nPlatforms: ${data.platforms.join(', ')}`;
    }
    case 'delete_upload_job': {
      const { error } = await supabase.from('upload_jobs').delete().eq('id', args.job_id);
      if (error) return `❌ Failed to delete job: ${error.message}`;
      return `✅ Job ${args.job_id} deleted.`;
    }
    case 'retry_failed_job': {
      const { data, error } = await supabase.from('upload_jobs')
        .update({ status: 'pending', completed_at: null, platform_results: [] })
        .eq('id', args.job_id)
        .select().single();
      if (error) return `❌ Failed to retry job: ${error.message}`;
      return `✅ Job "${data.title || data.video_file_name}" reset to pending.`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/* ── Lightweight context (fast) ───────────────────────── */

async function getAppContextFast(supabase: any): Promise<string> {
  const [
    { data: jobs },
    { data: scheduled },
    { data: settings },
    { data: scheduleConfig },
  ] = await Promise.all([
    supabase.from('upload_jobs').select('id,title,video_file_name,status,target_platforms').order('created_at', { ascending: false }).limit(10),
    supabase.from('scheduled_uploads').select('id,title,video_file_name,status,target_platforms,scheduled_at').eq('status', 'scheduled').order('scheduled_at', { ascending: true }).limit(5),
    supabase.from('app_settings').select('youtube_enabled,tiktok_enabled,instagram_enabled,telegram_enabled,folder_path').eq('id', 1).single(),
    supabase.from('schedule_config').select('enabled,cron_expression,platforms').eq('id', 1).single(),
  ]);

  const pending = (jobs || []).filter((j: any) => j.status === 'pending').length;
  const processing = (jobs || []).filter((j: any) => j.status === 'processing').length;
  const failed = (jobs || []).filter((j: any) => j.status === 'failed').length;
  const done = (jobs || []).filter((j: any) => j.status === 'completed').length;
  const upcoming = scheduled || [];

  const platforms = [];
  if (settings?.youtube_enabled) platforms.push('YouTube');
  if (settings?.tiktok_enabled) platforms.push('TikTok');
  if (settings?.instagram_enabled) platforms.push('Instagram');

  const cronInfo = scheduleConfig;

  let ctx = `=== APP STATE ===\nPlatforms: ${platforms.join(', ') || 'None'}\nQueue: ${pending} pending, ${processing} processing, ${done} done, ${failed} failed`;

  if (failed > 0) {
    const failedJobs = (jobs || []).filter((j: any) => j.status === 'failed');
    ctx += `\nFailed: ${failedJobs.map((j: any) => `[${j.id.slice(0,8)}] "${j.title || j.video_file_name}"`).join(', ')}`;
  }
  if (pending > 0) {
    const pendingJobs = (jobs || []).filter((j: any) => j.status === 'pending');
    ctx += `\nPending: ${pendingJobs.map((j: any) => `[${j.id.slice(0,8)}] "${j.title || j.video_file_name}"`).join(', ')}`;
  }
  if (upcoming.length > 0) {
    ctx += `\nScheduled: ${upcoming.map((s: any) => `"${s.title || s.video_file_name}" at ${new Date(s.scheduled_at).toLocaleString()}`).join('; ')}`;
  }
  ctx += `\nCron: ${cronInfo?.enabled ? 'ON' : 'OFF'} ${cronInfo?.cron_expression || ''} ${(cronInfo?.platforms || []).join(',')}`;
  ctx += '\n===';
  return ctx;
}

/* ── System prompt ────────────────────────────────────── */

function buildSystemPrompt(appContext: string): string {
  return `You are a helpful AI assistant for a Video Uploader app. You have access to live app data and can perform actions.

${appContext}

You can: create_upload_job, schedule_upload, update_cron_schedule, delete_upload_job, retry_failed_job.
When asked to perform actions, use tool calls. When asked questions, answer from the live data above.
Use markdown. Be concise but helpful.`;
}

/* ── Streaming approach: try stream, detect tool calls ── */

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { messages } = await req.json();
    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: 'messages array is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get context in parallel with message transformation
    const appContextPromise = getAppContextFast(supabase);

    // Transform messages for multimodal support
    const transformedMessages = messages.map((msg: any) => {
      if (msg.role === 'system') return msg;
      if (msg.images && msg.images.length > 0) {
        const content: any[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const img of msg.images) {
          content.push({ type: 'image_url', image_url: { url: img.url } });
        }
        return { role: msg.role, content };
      }
      if (msg.files && msg.files.length > 0) {
        let fileContext = msg.content || '';
        for (const file of msg.files) {
          fileContext += `\n\n[Attached file: ${file.name} (${file.type}, ${file.size})]`;
          if (file.textContent) fileContext += `\nFile contents:\n\`\`\`\n${file.textContent}\n\`\`\``;
        }
        return { role: msg.role, content: fileContext };
      }
      return { role: msg.role, content: msg.content };
    });

    const appContext = await appContextPromise;
    const systemPrompt = buildSystemPrompt(appContext);
    const hasImages = messages.some((m: any) => m.images && m.images.length > 0);
    const model = hasImages ? 'google/gemini-2.5-flash' : 'google/gemini-3-flash-preview';

    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...transformedMessages,
    ];

    // First attempt: streaming with tools
    const aiResp = await fetch(AI_GATEWAY, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: fullMessages,
        tools,
        tool_choice: 'auto',
        stream: true,
      }),
    });

    if (!aiResp.ok) {
      const status = aiResp.status;
      if (status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment.' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted.' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const t = await aiResp.text();
      console.error('AI error:', status, t);
      return new Response(JSON.stringify({ error: 'AI service error' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse the streaming response - if we detect tool_calls, buffer and handle them
    // If pure text, pipe through immediately
    const reader = aiResp.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let toolCalls: any[] = [];
    let contentChunks: string[] = [];
    let finishReason = '';
    let hasToolCalls = false;

    // Read the first few chunks to detect if this is a tool call response
    // We'll buffer initially, then decide to stream or handle tools
    const encoder = new TextEncoder();

    // Strategy: pipe through as a TransformStream.
    // If we encounter tool_calls in the SSE, we buffer everything,
    // execute tools, call AI again non-streaming, then send that result.
    // If it's pure content, each chunk flows through immediately.

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Process in background
    (async () => {
      try {
        let isToolCall = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = sseBuffer.indexOf('\n')) !== -1) {
            let line = sseBuffer.slice(0, idx);
            sseBuffer = sseBuffer.slice(idx + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line.startsWith(':') || line.trim() === '') continue;
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(jsonStr);
              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta || {};
              if (choice.finish_reason) finishReason = choice.finish_reason;

              // Check for tool calls
              if (delta.tool_calls) {
                isToolCall = true;
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? toolCalls.length;
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = { id: tc.id || '', function: { name: '', arguments: '' } };
                  }
                  if (tc.id) toolCalls[idx].id = tc.id;
                  if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                }
              }

              // Regular content - stream through if no tool calls detected
              if (delta.content && !isToolCall) {
                contentChunks.push(delta.content);
                const chunk = JSON.stringify({ choices: [{ delta: { content: delta.content } }] });
                await writer.write(encoder.encode(`data: ${chunk}\n\n`));
              } else if (delta.content) {
                contentChunks.push(delta.content);
              }
            } catch {
              // Partial JSON, put back
              sseBuffer = line + '\n' + sseBuffer;
              break;
            }
          }
        }

        // If tool calls were made, execute them and get final response
        if (isToolCall && toolCalls.length > 0) {
          // Execute all tool calls
          const toolMessage = {
            role: 'assistant',
            content: contentChunks.join('') || null,
            tool_calls: toolCalls.map((tc, i) => ({
              id: tc.id || `call_${i}`,
              type: 'function',
              function: tc.function,
            })),
          };
          fullMessages.push(toolMessage);

          for (const tc of toolCalls) {
            let args: any;
            try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
            console.log(`Executing tool: ${tc.function.name}`, args);
            const result = await executeTool(supabase, tc.function.name, args);
            fullMessages.push({
              role: 'tool',
              tool_call_id: tc.id || `call_0`,
              content: result,
            });
          }

          // Second AI call - stream the final response
          const resp2 = await fetch(AI_GATEWAY, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, messages: fullMessages, stream: true }),
          });

          if (resp2.ok && resp2.body) {
            const reader2 = resp2.body.getReader();
            let buf2 = '';
            while (true) {
              const { done, value } = await reader2.read();
              if (done) break;
              buf2 += decoder.decode(value, { stream: true });
              let idx2: number;
              while ((idx2 = buf2.indexOf('\n')) !== -1) {
                let line2 = buf2.slice(0, idx2);
                buf2 = buf2.slice(idx2 + 1);
                if (line2.endsWith('\r')) line2 = line2.slice(0, -1);
                if (line2.startsWith(':') || line2.trim() === '') continue;
                if (!line2.startsWith('data: ')) continue;
                const js2 = line2.slice(6).trim();
                if (js2 === '[DONE]') continue;
                try {
                  const p2 = JSON.parse(js2);
                  const c2 = p2.choices?.[0]?.delta?.content;
                  if (c2) {
                    const chunk = JSON.stringify({ choices: [{ delta: { content: c2 } }] });
                    await writer.write(encoder.encode(`data: ${chunk}\n\n`));
                  }
                } catch {}
              }
            }
          } else {
            // Fallback: send tool results as plain text
            const toolResults = fullMessages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n');
            const chunk = JSON.stringify({ choices: [{ delta: { content: toolResults || 'Actions completed.' } }] });
            await writer.write(encoder.encode(`data: ${chunk}\n\n`));
          }
        }

        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error('Stream processing error:', e);
        const errChunk = JSON.stringify({ choices: [{ delta: { content: 'An error occurred processing your request.' } }] });
        await writer.write(encoder.encode(`data: ${errChunk}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' },
    });
  } catch (e) {
    console.error('chat error:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

export { tools, executeTool, getAppContextFast as getAppContext, buildSystemPrompt };
