import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DEFAULT_LOVABLE_MODEL, LOVABLE_GATEWAY, resolveChatProviderConfig } from '../_shared/ai-provider.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const AI_GATEWAY = LOVABLE_GATEWAY;
const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';
const DIRECT_TOOL_REPLY_NAMES = new Set(['generate_social_post', 'research_web', 'check_platform_stats', 'open_browser', 'run_agent']);

// Models that natively understand image inputs. Anything else triggers a vision fallback to Lovable.
const VISION_CAPABLE_MODEL_RE = /(gemini|gpt-4o|gpt-5|gpt-4-vision|claude-3|llama-3\.2-vision|llava|pixtral)/i;

/* ── Tool definitions (full agentic surface) ─────────── */

const tools = [
  {
    type: 'function',
    function: {
      name: 'create_upload_job',
      description: 'Queue a video for immediate upload to one or more social platforms.',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string', description: 'Name of the video file (already uploaded to storage)' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          video_storage_path: { type: 'string' },
        },
        required: ['video_file_name', 'title', 'target_platforms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_upload',
      description: 'Schedule a video upload for a specific date/time (ISO 8601, Tbilisi GET timezone).',
      parameters: {
        type: 'object',
        properties: {
          video_file_name: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          scheduled_at: { type: 'string' },
          video_storage_path: { type: 'string' },
        },
        required: ['video_file_name', 'title', 'target_platforms', 'scheduled_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_upload_job',
      description: 'Edit a queued upload job (title, description, tags, platforms).',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_upload_job',
      description: 'Delete an upload job by ID.',
      parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed_job',
      description: 'Retry a failed upload job.',
      parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_jobs_by_status',
      description: 'Bulk delete upload jobs with a given status ("failed", "completed", "pending") or "all".',
      parameters: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_scheduled_upload',
      description: 'Cancel a scheduled upload by ID.',
      parameters: { type: 'object', properties: { scheduled_id: { type: 'string' } }, required: ['scheduled_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_scheduled_upload',
      description: 'Edit a scheduled upload (title, description, tags, platforms, scheduled_at).',
      parameters: {
        type: 'object',
        properties: {
          scheduled_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          scheduled_at: { type: 'string' },
        },
        required: ['scheduled_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_cron_schedule',
      description: 'Update primary recurring upload cron (id=1).',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          cron_expression: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_recurring_schedule',
      description: 'Create, update, or delete a recurring upload schedule.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'delete'] },
          schedule_id: { type: 'number' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
          cron_expression: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string', enum: ['youtube', 'tiktok', 'instagram'] } },
          folder_path: { type: 'string' },
          end_at: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_social_post',
      description: 'Use the Deep Research Agent to generate an AI social media post (with web research, sources, and platform-tailored variants). Optionally schedule it.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Topic or instructions for the post' },
          target_platforms: { type: 'array', items: { type: 'string', enum: ['x', 'linkedin', 'facebook'] }, description: 'Social text platforms only — X (Twitter), LinkedIn, Facebook. Never tiktok/instagram/youtube here.' },
          include_image: { type: 'boolean' },
          scheduled_at: { type: 'string', description: 'Optional ISO datetime to schedule (omit to post immediately)' },
        },
        required: ['prompt', 'target_platforms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research_web',
      description: 'Run a deep web research task (multi-source) and return findings + source URLs. Uses configured research provider or local Playwright fallback.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          depth: { type: 'string', enum: ['light', 'standard', 'deep'] },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_platform_stats',
      description: 'Queue an engagement-stats scrape (views/likes/comments) on the local browser for YouTube, TikTok, Instagram, or all.',
      parameters: {
        type: 'object',
        properties: { platform: { type: 'string', enum: ['youtube', 'tiktok', 'instagram', 'all'] } },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_browser',
      description: 'Queue an arbitrary browser task on the user\'s local PC (e.g. "open my YouTube Studio analytics").',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_agent',
      description: 'START A FULL AUTONOMOUS AGENT (like Claude Code / Codex) for any complex multi-step task: building apps/websites, deep research with synthesis, generating + saving files to the user\'s PC, opening preview in browser, combining research + code + images. ALWAYS use this for anything beyond a simple one-shot tool call. The agent plans, executes, and reports back live with steps visible to the user.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The full task description, verbatim from the user.' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Save a durable, reusable memory the assistant should remember across all future chats (preferences, stable facts, account info, workflows). Only call when the user explicitly says to remember something or shares a clearly reusable preference.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          memory_type: { type: 'string', enum: ['fact', 'workflow', 'preference', 'subtask'] },
          importance: { type: 'number', minimum: 1, maximum: 100 },
        },
        required: ['title', 'content'],
      },
    },
  },
];

/* ── Tool executor ────────────────────────────────────── */

function truncatePrompt(s: string, n = 80): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function buildMessageForModel(message: any) {
  const formatFileSize = (value: unknown) => {
    const size = typeof value === 'number' ? value : Number(value || 0);
    if (!Number.isFinite(size) || size <= 0) return null;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };
  const describeFile = (file: any) => {
    const parts = [file.type || 'file'];
    const size = formatFileSize(file.size);
    if (size) parts.push(size);
    return `${file.name} (${parts.join(', ')})`;
  };
  const images = Array.isArray(message?.images) ? message.images.filter((img: any) => img?.url) : [];
  const files = Array.isArray(message?.files) ? message.files : [];
  if (images.length > 0) {
    const content: any[] = [];
    if (message?.content) content.push({ type: 'text', text: message.content });
    for (const img of images) content.push({ type: 'image_url', image_url: { url: img.url } });
    if (files.length > 0) {
      const fileSummary = files
        .filter((file: any) => !file?.isImage)
        .map((file: any) => `- ${describeFile(file)}${file.textContent ? `\n${file.textContent}` : ''}`)
        .join('\n');
      if (fileSummary) content.push({ type: 'text', text: `Attached files:\n${fileSummary}` });
    }
    return { role: message.role, content };
  }

  if (files.length > 0) {
    let fileContext = message.content || '';
    for (const file of files) {
      fileContext += `\n\n[Attached file: ${describeFile(file)}]`;
      if (file.textContent) fileContext += `\n${file.textContent}`;
    }
    return { role: message.role, content: fileContext.trim() };
  }

  return { role: message.role, content: message.content };
}

async function executeTool(
  supabase: any,
  name: string,
  args: any,
  supabaseUrl: string,
  serviceKey: string,
  opts: { telegramChatId?: string | number | null } = {},
): Promise<string> {
  switch (name) {
    case 'create_upload_job': {
      const platforms = args.target_platforms || [];
      const platformResults = platforms.map((p: string) => ({ name: p, status: 'pending' }));
      const { data, error } = await supabase.from('upload_jobs').insert({
        video_file_name: args.video_file_name,
        title: args.title || '',
        description: args.description || '',
        tags: args.tags || [],
        target_platforms: platforms,
        status: 'pending',
        video_storage_path: args.video_storage_path || null,
        platform_results: platformResults,
      }).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Queued "${data.title}" → ${data.target_platforms.join(', ')} (id ${data.id.slice(0, 8)})`;
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
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Scheduled "${data.title}" for ${new Date(data.scheduled_at).toLocaleString()} → ${data.target_platforms.join(', ')}`;
    }
    case 'edit_upload_job': {
      const updates: any = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.target_platforms !== undefined) updates.target_platforms = args.target_platforms;
      const { data, error } = await supabase.from('upload_jobs').update(updates).eq('id', args.job_id).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Updated "${data.title}".`;
    }
    case 'delete_upload_job': {
      const { error } = await supabase.from('upload_jobs').delete().eq('id', args.job_id);
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Job ${args.job_id.slice(0, 8)} deleted.`;
    }
    case 'retry_failed_job': {
      const { data, error } = await supabase.from('upload_jobs')
        .update({ status: 'pending', completed_at: null, platform_results: [] })
        .eq('id', args.job_id).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ "${data.title || data.video_file_name}" reset to pending.`;
    }
    case 'clear_jobs_by_status': {
      let query = supabase.from('upload_jobs').delete();
      if (args.status !== 'all') query = query.eq('status', args.status);
      else query = query.neq('id', '00000000-0000-0000-0000-000000000000');
      const { error } = await query;
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Cleared ${args.status} jobs.`;
    }
    case 'delete_scheduled_upload': {
      const { error } = await supabase.from('scheduled_uploads').delete().eq('id', args.scheduled_id);
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Scheduled upload deleted.`;
    }
    case 'edit_scheduled_upload': {
      const updates: any = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.target_platforms !== undefined) updates.target_platforms = args.target_platforms;
      if (args.scheduled_at !== undefined) updates.scheduled_at = args.scheduled_at;
      const { data, error } = await supabase.from('scheduled_uploads').update(updates).eq('id', args.scheduled_id).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Updated scheduled "${data.title}".`;
    }
    case 'update_cron_schedule': {
      const update: any = {};
      if (args.enabled !== undefined) update.enabled = args.enabled;
      if (args.cron_expression) update.cron_expression = args.cron_expression;
      if (args.platforms) update.platforms = args.platforms;
      const { data, error } = await supabase.from('schedule_config').update(update).eq('id', 1).select().single();
      if (error) return `❌ Failed: ${error.message}`;
      return `✅ Cron: ${data.enabled ? 'ON' : 'OFF'} | ${data.cron_expression} | ${data.platforms.join(', ')}`;
    }
    case 'manage_recurring_schedule': {
      if (args.action === 'delete') {
        if (!args.schedule_id) return '❌ Need schedule_id.';
        const { error } = await supabase.from('schedule_config').delete().eq('id', args.schedule_id);
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Recurring schedule #${args.schedule_id} deleted.`;
      }
      if (args.action === 'create') {
        const payload = {
          name: args.name || 'Schedule',
          enabled: args.enabled ?? false,
          cron_expression: args.cron_expression || '0 9 * * *',
          platforms: args.platforms || ['youtube'],
          folder_path: args.folder_path || '',
          end_at: args.end_at || null,
        };
        const { data, error } = await supabase.from('schedule_config').insert(payload).select().single();
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Created "${data.name}" (#${data.id}).`;
      }
      if (args.action === 'update') {
        if (!args.schedule_id) return '❌ Need schedule_id.';
        const updates: any = {};
        for (const k of ['name', 'enabled', 'cron_expression', 'platforms', 'folder_path', 'end_at']) {
          if (args[k] !== undefined) updates[k] = args[k];
        }
        const { data, error } = await supabase.from('schedule_config').update(updates).eq('id', args.schedule_id).select().single();
        if (error) return `❌ Failed: ${error.message}`;
        return `✅ Updated "${data.name}".`;
      }
      return '❌ Unknown action.';
    }
    case 'generate_social_post': {
      // Mirror the in-app "Generate" button exactly:
      // 1) Auto-cancel stale (>10min) running jobs so the queue self-heals.
      // 2) Refuse if a fresh job is genuinely still running — only one agentic task at a time.
      // 3) Pre-create the generation_jobs row (status=running) RIGHT NOW so the user
      //    sees the task appear in the Job Queue immediately with live steps, instead
      //    of waiting for the edge function cold-start before anything shows up.
      // 4) Fire-and-forget the generator with the pre-created jobId so it reuses the row
      //    instead of inserting a duplicate or hitting its own 409 guard.
      try {
        try { await supabase.rpc('cancel_stale_generation_jobs'); } catch { /* best-effort */ }
        const { data: liveJobs } = await supabase
          .from('generation_jobs')
          .select('id, prompt')
          .eq('status', 'running')
          .order('created_at', { ascending: false })
          .limit(1);
        if (liveJobs && liveJobs.length > 0) {
          return `⏳ Another generation is already running ("${truncatePrompt(liveJobs[0].prompt, 60)}"). Reply "cancel" to stop it, or wait for it to finish before starting a new one.`;
        }

        const platforms = (args.target_platforms || ['x']).filter((p: string) => ['x', 'linkedin', 'facebook'].includes(p));
        const platformsLabel = platforms.join(', ');
        const startupEvent = {
          type: 'step',
          id: 'startup',
          emoji: '🚀',
          label: 'Starting agent — warming up research and image tools…',
          status: 'active',
          ts: Date.now(),
        };
        const { data: jobRow, error: jobErr } = await supabase.from('generation_jobs').insert({
          prompt: args.prompt,
          platforms,
          include_image: args.include_image !== false,
          status: 'running',
          events: [startupEvent],
        }).select('id').single();
        if (jobErr || !jobRow?.id) {
          return `❌ Failed to start generation: ${jobErr?.message || 'could not create job'}`;
        }
        const jobId = jobRow.id;

        const kickBody: Record<string, unknown> = {
          prompt: args.prompt,
          platforms,
          includeImage: args.include_image !== false,
          stream: false,
          existingJobId: jobId,
        };
        // Fire-and-forget — the function streams via SSE, mirrors every step into
        // generation_jobs.events (visible live in the Job Queue), saves a draft, and
        // sends a Telegram preview when finished.
        void fetch(`${supabaseUrl}/functions/v1/generate-social-post`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(kickBody),
        }).catch((e) => console.warn('generate-social-post kick failed:', e));

        return `✨ Started agent for "${truncatePrompt(args.prompt)}" → ${platformsLabel}. Open the Job Queue to watch live steps (research, sources, image search). I'll send the full draft (image + per-platform variants + sources) to Telegram in 1-2 minutes. Reply "post" to publish, "edit <text>" to revise, or "skip" to discard. Nothing publishes without your approval.`;
      } catch (e) {
        console.warn('generate_social_post tool failed:', e);
        return `❌ Failed to start generation: ${(e as Error).message}`;
      }
    }
    case 'research_web': {
      try {
        const task = `Research this topic on the web and produce a sourced summary: "${args.query}". Depth: ${args.depth || 'standard'}. Use the configured research provider first, fall back to the local PC browser if needed, and finish with the most useful findings plus source links.`;
        const r = await fetch(`${supabaseUrl}/functions/v1/agent-run`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: task,
            source: opts.telegramChatId ? 'telegram' : 'ai-chat',
            telegram_chat_id: opts.telegramChatId || null,
          }),
        });
        const d = await r.json();
        if (!r.ok || !d.runId) return `❌ Research agent failed to start: ${d.error || 'unknown'}`;
        return `__AGENT_RUN__:${d.runId}\n🔍 Started research agent for "${truncatePrompt(args.query, 100)}". It will search, summarize, and return sourced findings${opts.telegramChatId ? ' in this chat' : ' with live progress below'}.`;
      } catch (e) {
        return `❌ Failed to start research agent: ${(e as Error).message}`;
      }
    }
    case 'check_platform_stats': {
      const { error } = await supabase.from('pending_commands').insert({
        command: 'check_stats',
        args: { platform: args.platform || 'all' },
        status: 'pending',
      });
      if (error) return `❌ ${error.message}`;
      return `📊 Stats scrape queued for ${args.platform}. Results in Telegram within ~60s.`;
    }
    case 'open_browser': {
      const { error } = await supabase.from('pending_commands').insert({
        command: 'open_browser',
        args: { task: args.task, url: args.url || null },
        status: 'pending',
      });
      if (error) return `❌ ${error.message}`;
      return `🌐 Browser task queued: "${args.task}". Updates via Telegram.`;
    }
    case 'run_agent': {
      try {
        const r = await fetch(`${supabaseUrl}/functions/v1/agent-run`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: args.task,
            source: opts.telegramChatId ? 'telegram' : 'ai-chat',
            telegram_chat_id: opts.telegramChatId || null,
          }),
        });
        const d = await r.json();
        if (!r.ok || !d.runId) return `❌ Agent failed to start: ${d.error || 'unknown'}`;
        return `__AGENT_RUN__:${d.runId}\n🤖 Started agent for: "${truncatePrompt(args.task, 100)}". ${opts.telegramChatId ? 'You will get live progress updates in this Telegram chat.' : 'Watch live steps below — plan, research, file writes, browser actions, and preview will appear in real-time.'}`;
      } catch (e) {
        return `❌ Agent start failed: ${(e as Error).message}`;
      }
    }
    case 'remember_fact': {
      const payload = {
        title: String(args.title || '').trim(),
        content: String(args.content || '').trim(),
        memory_type: String(args.memory_type || 'fact'),
        tags: Array.isArray(args.tags) ? args.tags.map((t: any) => String(t).trim()).filter(Boolean) : [],
        importance: Math.min(Math.max(Number(args.importance) || 60, 1), 100),
      };
      if (!payload.title || !payload.content) return '❌ Memory needs title and content.';
      const { error } = await supabase.from('agent_memories').insert(payload);
      if (error) return `❌ Failed to save memory: ${error.message}`;
      return `🧠 Saved memory: "${payload.title}".`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/* ── Lightweight context ──────────────────────────────── */

function keywordOverlap(a: string, b: string): number {
  const tokens = (s: string) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const ta = tokens(a); const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit;
}

interface AppContext {
  text: string;
  memories: Array<{ title: string; content: string; importance: number }>;
  skills: Array<{ name: string; slug: string; description: string; triggers: string[] }>;
  agentMemoryEnabled: boolean;
}

async function getAppContextFast(supabase: any, userPrompt = ''): Promise<AppContext> {
  const [
    { data: jobs },
    { data: scheduled },
    { data: settings },
    { data: scheduleConfigs },
    { data: socialPosts },
    { data: memoriesRaw },
    { data: skillsRaw },
  ] = await Promise.all([
    supabase.from('upload_jobs').select('id,title,video_file_name,status,target_platforms').order('created_at', { ascending: false }).limit(10),
    supabase.from('scheduled_uploads').select('id,title,video_file_name,status,target_platforms,scheduled_at').eq('status', 'scheduled').order('scheduled_at', { ascending: true }).limit(5),
    supabase.from('app_settings').select('youtube_enabled,tiktok_enabled,instagram_enabled,telegram_enabled,folder_path,research_provider,image_provider,ai_provider,ai_model,agent_memory_enabled,agent_memory_max_items').eq('id', 1).single(),
    supabase.from('schedule_config').select('id,name,enabled,cron_expression,platforms').order('id', { ascending: true }),
    supabase.from('social_posts').select('id,status,target_platforms,ai_prompt').order('created_at', { ascending: false }).limit(5),
    supabase.from('agent_memories').select('title,content,importance,tags').eq('enabled', true).order('importance', { ascending: false }).order('updated_at', { ascending: false }).limit(40),
    supabase.from('agent_skills').select('name,slug,description,triggers').eq('enabled', true).limit(50),
  ]);

  const j = jobs || [];
  const counts = {
    pending: j.filter((x: any) => x.status === 'pending').length,
    processing: j.filter((x: any) => x.status === 'processing').length,
    failed: j.filter((x: any) => x.status === 'failed').length,
    done: j.filter((x: any) => x.status === 'completed').length,
  };

  const platforms: string[] = [];
  if (settings?.youtube_enabled) platforms.push('YouTube');
  if (settings?.tiktok_enabled) platforms.push('TikTok');
  if (settings?.instagram_enabled) platforms.push('Instagram');

  let ctx = `=== LIVE APP STATE (Tbilisi GET timezone) ===\n`;
  ctx += `Video platforms enabled: ${platforms.join(', ') || 'None'}\n`;
  ctx += `Upload queue: ${counts.pending} pending, ${counts.processing} processing, ${counts.done} done, ${counts.failed} failed\n`;
  ctx += `AI model: ${settings?.ai_provider || 'lovable'} / ${settings?.ai_model || 'auto'} | Research: ${settings?.research_provider || 'auto'} | Images: ${settings?.image_provider || 'auto'}\n`;

  if (counts.failed > 0) {
    ctx += `Failed jobs: ${j.filter((x: any) => x.status === 'failed').map((x: any) => `[${x.id.slice(0, 8)}] "${x.title || x.video_file_name}"`).join(', ')}\n`;
  }
  if (counts.pending > 0) {
    ctx += `Pending: ${j.filter((x: any) => x.status === 'pending').map((x: any) => `[${x.id.slice(0, 8)}] "${x.title || x.video_file_name}"`).join(', ')}\n`;
  }
  if ((scheduled || []).length > 0) {
    ctx += `Scheduled video uploads: ${(scheduled || []).map((s: any) => `"${s.title || s.video_file_name}" at ${new Date(s.scheduled_at).toLocaleString()}`).join('; ')}\n`;
  }
  if ((scheduleConfigs || []).length > 0) {
    ctx += `Recurring schedules:\n${(scheduleConfigs || []).map((c: any) => `  #${c.id} "${c.name}" ${c.enabled ? 'ON' : 'OFF'} | ${c.cron_expression} | ${(c.platforms || []).join(',')}`).join('\n')}\n`;
  }
  if ((socialPosts || []).length > 0) {
    ctx += `Recent social posts: ${(socialPosts || []).map((p: any) => `[${p.status}] ${(p.ai_prompt || '').slice(0, 40)}`).join(' | ')}\n`;
  }
  ctx += '===';

  // Score and pick relevant memories for this user prompt
  const memMax = Math.min(Math.max(Number(settings?.agent_memory_max_items) || 8, 1), 20);
  const memEnabled = settings?.agent_memory_enabled !== false;
  const memList = (memoriesRaw || []) as any[];
  const memories = memEnabled
    ? memList
        .map((m) => ({ m, score: keywordOverlap(userPrompt, `${m.title}\n${m.content}\n${(m.tags || []).join(' ')}`) + (Number(m.importance) || 0) / 25 }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, memMax)
        .map((e) => ({ title: e.m.title, content: e.m.content, importance: e.m.importance }))
    : [];

  // Score skills (by trigger/name overlap with prompt)
  const skillList = (skillsRaw || []) as any[];
  const skills = skillList
    .map((s) => ({
      s,
      score: keywordOverlap(userPrompt, `${s.name}\n${s.description}\n${(s.triggers || []).join(' ')}`),
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((e) => ({ name: e.s.name, slug: e.s.slug, description: e.s.description, triggers: e.s.triggers || [] }));

  return { text: ctx, memories, skills, agentMemoryEnabled: memEnabled };
}

/* ── System prompt ────────────────────────────────────── */

function buildSystemPrompt(appContext: AppContext, isTelegram = false): string {
  const fmt = isTelegram
    ? 'Plain text only — NO markdown asterisks/backticks. Use line breaks and emoji for structure. Be concise.'
    : 'Use markdown for rich formatting.';

  const memoryBlock = appContext.memories.length > 0
    ? `\n## Persistent memory (most relevant facts about user/project)\n${appContext.memories.map((m) => `- (importance ${m.importance}) ${m.title}: ${m.content}`).join('\n')}\n_Use these as background facts. To save a new long-term fact, call remember_fact._\n`
    : appContext.agentMemoryEnabled
      ? `\n## Persistent memory\n_(empty — call remember_fact when the user shares a durable fact worth recalling next time)_\n`
      : '';

  const skillBlock = appContext.skills.length > 0
    ? `\n## Saved skills (reusable workflows the user has trained)\n${appContext.skills.map((s) => `- ${s.name} [${s.slug}] — ${s.description || 'no description'}${(s.triggers || []).length ? ` (triggers: ${(s.triggers || []).join(', ')})` : ''}`).join('\n')}\n_If a user request matches a skill, prefer launching it via run_agent with the skill slug._\n`
    : '';

  return `You are the autonomous AI agent for Uploadphy — a multi-platform video & social-post automation app.

${appContext.text}
${memoryBlock}${skillBlock}
## Your capabilities (call tools, do not just describe)
- **Video uploads**: create_upload_job, schedule_upload, edit_upload_job, delete_upload_job, retry_failed_job, clear_jobs_by_status
- **Scheduling**: schedule_upload, edit_scheduled_upload, delete_scheduled_upload, update_cron_schedule, manage_recurring_schedule
- **Social posts (deep research agent)**: generate_social_post — multi-step plan → search → scrape → write → image, with sources
- **Web research**: research_web — autonomous web research with configured provider or local browser fallback
- **Stats scraping**: check_platform_stats — queues Playwright scrape on user's local PC, results via Telegram
- **Generic browser tasks**: open_browser — runs any natural-language browser task locally
- **Full autonomous local-PC agent**: run_agent — use this for coding, file generation, previews, browser work, deep research, image generation, and multi-step workflows (Claude Code / OpenClaw / Hermes style)
- **Memory**: remember_fact — store a long-term fact (user preference, project rule, recurring detail) for future sessions

## Behavior rules
- For anything involving code, files, local shell commands, browser previews, multi-step web research, or "do this on my PC", ALWAYS call run_agent instead of trying to answer inline.
- Be PROACTIVE. If the user says "post about X to Twitter at 9pm tomorrow" → call generate_social_post with scheduled_at.
- CRITICAL — generate_social_post NEVER auto-publishes. It runs the full in-app generation flow (research → image → per-platform variants), saves the result as a DRAFT on /social, and sends a Telegram preview. The user must reply "post" / "edit <text>" / "skip" in Telegram to actually publish, revise, or discard. Always make this clear in your reply ("I'll send you the draft to review — nothing will be posted until you approve").
- Mirror the in-app experience: when the user asks from Telegram to generate a post, it should produce the same result as opening the Generate Post page, typing the prompt, and clicking Generate — same visual progress feed, same draft, same Telegram preview. Other agentic flows (research, stats, browser tasks) follow the same pattern: queue the task, run it exactly like the in-app button does, and report back via Telegram.
- If user asks for stats/views/engagement → ALWAYS call check_platform_stats (do not hallucinate numbers).
- If user asks to research something → call research_web (do not answer from memory if it's news/recent).
- If user asks "what's pending / what's scheduled" → answer from the LIVE APP STATE above.
- All times are Tbilisi GET (UTC+4). Convert relative times like "tomorrow 9am" to ISO 8601.
- ${fmt}`;
}

/* ── Helper: send to Telegram ─────────────────────────── */

async function sendTelegram(chatId: string | number, text: string, lovableKey: string, telegramKey: string) {
  try {
    await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableKey}`,
        'X-Connection-Api-Key': telegramKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    });
  } catch (e) {
    console.error('Telegram send failed:', e);
  }
}

/* ── Non-streaming agent loop (used for Telegram mode) ─ */

async function runAgentNonStreaming(
  supabase: any,
  fullMessages: any[],
  chatUrl: string,
  chatKey: string,
  model: string,
  lovableKey: string,
  supabaseUrl: string,
  serviceKey: string,
  opts: { telegramChatId?: string | number | null } = {},
  maxSteps = 4,
): Promise<string> {
  const makeReq = (url: string, key: string, mdl: string) => fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: mdl, messages: fullMessages, tools, tool_choice: 'auto' }),
  });

  for (let step = 0; step < maxSteps; step++) {
    let r = await makeReq(chatUrl, chatKey, model);
    if (!r.ok) {
      // Fall back to Lovable Gateway with default model on any failure.
      if (chatUrl !== AI_GATEWAY || model !== DEFAULT_LOVABLE_MODEL) {
        const errText = await r.text();
        console.warn(`runAgentNonStreaming: ${chatUrl}/${model} failed (${r.status}): ${errText.slice(0, 200)}, retrying with Lovable default`);
        r = await makeReq(AI_GATEWAY, lovableKey, DEFAULT_LOVABLE_MODEL);
      }
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`AI gateway ${r.status}: ${t.slice(0, 300)}`);
      }
    }
    const data = await r.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) return 'No response.';
    fullMessages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        const result = await executeTool(supabase, tc.function.name, args, supabaseUrl, serviceKey, opts);
        fullMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      continue;
    }

    return msg.content || '✅ Done.';
  }
  return '⚠️ Agent reached max iterations.';
}

/* ── Main handler ─────────────────────────────────────── */

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const { messages, telegram_chat_id, telegram_user_text } = body;

    /* ── TELEGRAM MODE: single user text → reply directly to chat ── */
    if (telegram_chat_id && typeof telegram_user_text === 'string') {
      const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
      if (!TELEGRAM_API_KEY) {
        return new Response(JSON.stringify({ error: 'TELEGRAM_API_KEY not configured' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Pull recent telegram chat history for context
      const { data: history } = await supabase
        .from('telegram_messages')
        .select('text,is_bot,created_at,raw_update')
        .eq('chat_id', telegram_chat_id)
        .order('created_at', { ascending: false })
        .limit(10);

      const ctx = await getAppContextFast(supabase);
      const sys = buildSystemPrompt(ctx, true);
      const historyMsgs = ((history || []) as any[])
        .reverse()
        .filter((m) => m.text || m.raw_update?.media)
        .map((m) => buildMessageForModel({
          role: m.is_bot ? 'assistant' : 'user',
          content: m.text || '',
          images: m.raw_update?.media?.images || [],
          files: m.raw_update?.media?.files || [],
        }));
      const newestTelegramMessage = ((history || []) as any[]).find((m) => !m.is_bot);
      const fallbackTelegramMessage = {
        text: telegram_user_text,
        raw_update: { media: { images: [], files: [] } },
      };
      const currentTelegramMessage = newestTelegramMessage || fallbackTelegramMessage;
      const currentUserMessage = buildMessageForModel({
        role: 'user',
        content: currentTelegramMessage.text || telegram_user_text,
        images: currentTelegramMessage.raw_update?.media?.images || [],
        files: currentTelegramMessage.raw_update?.media?.files || [],
      });

      const fullMessages = [
        { role: 'system', content: sys },
        ...historyMsgs,
        currentUserMessage,
      ];

      // Resolve AI config for Telegram mode the same way as web mode.
      const { data: tgSettings } = await supabase.from('app_settings').select('ai_provider,ai_api_key,ai_model,ai_base_url').eq('id', 1).single();
      const tgChatConfig = resolveChatProviderConfig({
        provider: (tgSettings as any)?.ai_provider,
        apiKey: (tgSettings as any)?.ai_api_key,
        model: (tgSettings as any)?.ai_model,
        baseUrl: (tgSettings as any)?.ai_base_url,
      }, LOVABLE_API_KEY);

      try {
        const reply = await runAgentNonStreaming(
          supabase, fullMessages, tgChatConfig.url, tgChatConfig.key, tgChatConfig.model, LOVABLE_API_KEY, supabaseUrl, serviceKey,
          { telegramChatId: telegram_chat_id },
        );
        const visibleReply = reply.replace(/__AGENT_RUN__:[0-9a-f-]+\n?/gi, '').trim() || '✅ Done.';
        await sendTelegram(telegram_chat_id, visibleReply, LOVABLE_API_KEY, TELEGRAM_API_KEY);

        // Mirror bot reply to telegram_messages so UI sees it
        await supabase.from('telegram_messages').insert({
          update_id: -Math.floor(Date.now()),
          chat_id: telegram_chat_id,
          text: reply.slice(0, 3000),
          is_bot: true,
          raw_update: { source: 'ai-chat-edge' },
        });

        return new Response(JSON.stringify({ ok: true, reply: visibleReply }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        const msg = `⚠️ AI processing failed: ${e instanceof Error ? e.message : 'unknown error'}`;
        await sendTelegram(telegram_chat_id, msg, LOVABLE_API_KEY, TELEGRAM_API_KEY);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    /* ── WEB MODE: streaming with tool support ── */
    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'messages array is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const appContextPromise = getAppContextFast(supabase);
    const aiSettingsPromise = supabase.from('app_settings').select('ai_provider,ai_api_key,ai_model,ai_base_url').eq('id', 1).single();

    const transformedMessages = messages.map((msg: any) => msg.role === 'system' ? msg : buildMessageForModel(msg));

    const [appContext, { data: aiSettings }] = await Promise.all([appContextPromise, aiSettingsPromise]);
    const systemPrompt = buildSystemPrompt(appContext, false);
    const hasImages = messages.some((m: any) => m.images && m.images.length > 0);

    // Resolve the chat model from user settings; fall back to a Lovable-compatible vision model
    // for image attachments (which requires gemini-2.5-flash or equivalent).
    const chatConfig = resolveChatProviderConfig({
      provider: (aiSettings as any)?.ai_provider,
      apiKey: (aiSettings as any)?.ai_api_key,
      model: (aiSettings as any)?.ai_model,
      baseUrl: (aiSettings as any)?.ai_base_url,
    }, LOVABLE_API_KEY);
    const chatUrl = chatConfig.url;
    const chatKey = chatConfig.key;
    const model = hasImages ? 'google/gemini-2.5-flash' : chatConfig.model;
    // For image messages, force Lovable Gateway (which provides the vision-capable model).
    const effectiveChatUrl = hasImages ? AI_GATEWAY : chatUrl;
    const effectiveChatKey = hasImages ? LOVABLE_API_KEY : chatKey;

    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...transformedMessages,
    ];

    const makeChatRequest = (url: string, key: string, mdl: string) => fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: mdl, messages: fullMessages, tools, tool_choice: 'auto', stream: true }),
    });

    let aiResp = await makeChatRequest(effectiveChatUrl, effectiveChatKey, model);

    // If the user's configured provider/model fails, fall back to Lovable Gateway with the default model.
    if (!aiResp.ok && (chatConfig.provider !== 'lovable' || chatConfig.model !== DEFAULT_LOVABLE_MODEL)) {
      const errText = await aiResp.text();
      console.warn(`ai-chat: primary provider ${chatConfig.provider}/${model} failed (${aiResp.status}): ${errText.slice(0, 200)}, retrying with Lovable default`);
      aiResp = await makeChatRequest(AI_GATEWAY, LOVABLE_API_KEY, DEFAULT_LOVABLE_MODEL);
    }

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded.' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted. Add funds in Workspace Settings → Usage.' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const t = await aiResp.text();
      console.error('AI error:', aiResp.status, t);
      return new Response(JSON.stringify({ error: 'AI service error' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const reader = aiResp.body!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let sseBuffer = '';
    const toolCalls: any[] = [];
    const contentChunks: string[] = [];

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

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

              if (delta.tool_calls) {
                isToolCall = true;
                for (const tc of delta.tool_calls) {
                  const i = tc.index ?? toolCalls.length;
                  if (!toolCalls[i]) toolCalls[i] = { id: tc.id || '', function: { name: '', arguments: '' } };
                  if (tc.id) toolCalls[i].id = tc.id;
                  if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
                }
              }

              if (delta.content && !isToolCall) {
                contentChunks.push(delta.content);
                const chunk = JSON.stringify({ choices: [{ delta: { content: delta.content } }] });
                await writer.write(encoder.encode(`data: ${chunk}\n\n`));
              } else if (delta.content) {
                contentChunks.push(delta.content);
              }
            } catch {
              sseBuffer = line + '\n' + sseBuffer;
              break;
            }
          }
        }

        if (isToolCall && toolCalls.length > 0) {
          // Stream a small status indicator
          const statusChunk = JSON.stringify({ choices: [{ delta: { content: `\n\n🛠️ Running ${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''}...\n\n` } }] });
          await writer.write(encoder.encode(`data: ${statusChunk}\n\n`));

          fullMessages.push({
            role: 'assistant',
            content: contentChunks.join('') || null,
            tool_calls: toolCalls.map((tc, i) => ({
              id: tc.id || `call_${i}`,
              type: 'function',
              function: tc.function,
            })),
          });

          const directToolReplies: string[] = [];

          for (const tc of toolCalls) {
            let args: any = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* */ }
            console.log(`Tool: ${tc.function.name}`, args);
            const result = await executeTool(supabase, tc.function.name, args, supabaseUrl, serviceKey);
            fullMessages.push({ role: 'tool', tool_call_id: tc.id || 'call_0', content: result });
            if (DIRECT_TOOL_REPLY_NAMES.has(tc.function.name)) {
              directToolReplies.push(result);
            }
          }

          if (directToolReplies.length > 0) {
            // Long-running / queueing tools already return user-facing text (and agent-run IDs),
            // so we stream that response directly and skip a second AI pass that could hide it.
            const directReply = directToolReplies.join('\n\n').trim();
            if (directReply) {
              const chunk = JSON.stringify({ choices: [{ delta: { content: directReply } }] });
              await writer.write(encoder.encode(`data: ${chunk}\n\n`));
            }
            await writer.write(encoder.encode('data: [DONE]\n\n'));
            return;
          }

          // Second pass: reuse the user's configured provider/model. If it isn't a
          // chat-completion-compatible endpoint (rare), fall through to Lovable on failure.
          const second = await fetch(effectiveChatUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${effectiveChatKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: fullMessages, stream: true }),
          });
          const resp2 = second.ok
            ? second
            : await fetch(AI_GATEWAY, {
                method: 'POST',
                headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: DEFAULT_LOVABLE_MODEL, messages: fullMessages, stream: true }),
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
                } catch { /* */ }
              }
            }
          } else {
            const toolResults = fullMessages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n');
            const chunk = JSON.stringify({ choices: [{ delta: { content: toolResults || '✅ Actions completed.' } }] });
            await writer.write(encoder.encode(`data: ${chunk}\n\n`));
          }
        }

        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error('Stream error:', e);
        const errChunk = JSON.stringify({ choices: [{ delta: { content: '\n\n⚠️ Error processing your request.' } }] });
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
