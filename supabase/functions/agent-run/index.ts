// Agent Runner — multi-step autonomous agent (like Claude Code / Codex)
// - Uses the user-configured AI provider (ai_provider/ai_api_key/ai_model from app_settings)
//   for the planning/reasoning loop. Falls back to Lovable AI Gateway if no key.
// - Streams every step (plan, tool_call, tool_result, thought, file_write, done) into
//   agent_runs.events so the web UI and Telegram can render a live activity feed.
// - Tools that need the local Windows PC (write_file, read_file, run_shell, open_in_browser,
//   serve_preview) are queued for the local worker through pending_commands; the worker
//   appends results back into agent_runs.events.
//
// Two entry modes:
//   POST { prompt, source: 'web', telegram_chat_id? }      → creates a run, returns { runId } immediately.
//   POST { runId, action: 'cancel' }                       → cancels a running agent.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const LOVABLE_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';
const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';
const MAX_STEPS = 12;

/* ── Tool catalog exposed to the planner LLM ─────────────────────────── */
const tools = [
  {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Emit / update the high-level numbered plan. Call this FIRST before any other tool. You may call again to revise the plan as you learn more.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of short step descriptions (3-7 steps).',
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'research_deep',
      description: 'Run deep web research using the user\'s configured research provider (Perplexity/Firecrawl/Tavily) or local browser fallback. Returns synthesized findings + source URLs INLINE for you to use.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          depth: { type: 'string', enum: ['light', 'standard', 'deep'], default: 'standard' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image with the user\'s configured image model (Gemini Nano Banana / OpenAI / Stability) and return its public URL.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:5'], default: '16:9' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file inside this run\'s workspace folder on the user\'s LOCAL PC. Path is relative (e.g. "index.html" or "src/App.tsx"). Overwrites if exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace folder.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files in the workspace folder (recursive).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a shell command in the workspace folder (allowlisted: npm, npx, node, python, git, dir, ls). Requires user to have enabled shell access in Settings.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'e.g. "npm install" or "node build.js"' },
          timeout_seconds: { type: 'number', default: 60 },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_in_browser',
      description: 'Open a URL or local file in the user\'s default browser on their PC.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'Full URL or workspace-relative path' } },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'serve_preview',
      description: 'Start a static preview server for the workspace folder. Returns a URL the user can open. Best for HTML/JS apps.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_skill',
      description: 'Propose saving the routine you just executed as a reusable Skill (like OpenClaw/Hermes skills). The user will review and approve from the Skills page. Use this when the task represents a repeatable workflow worth memorizing.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short skill name, e.g. "Daily LinkedIn digest"' },
          description: { type: 'string' },
          triggers: { type: 'array', items: { type: 'string' }, description: 'Phrases that should auto-suggest this skill in future' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string' },
                note: { type: 'string' },
                args: { type: 'object', additionalProperties: true },
              },
              required: ['note'],
            },
          },
          system_prompt: { type: 'string', description: 'Extra instructions to load when re-running this skill' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Mark the agent task as complete. Call this LAST with a short summary of what was accomplished and any links/paths the user should know about.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['file', 'url', 'image', 'preview'] },
                label: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['kind', 'label', 'value'],
            },
          },
        },
        required: ['summary'],
      },
    },
  },
];

/* ── Helpers ──────────────────────────────────────────────────────────── */

function slugify(s: string): string {
  return (s || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

async function appendEvent(supabase: any, runId: string, event: any) {
  const { data: row } = await supabase.from('agent_runs').select('events').eq('id', runId).single();
  const events = Array.isArray(row?.events) ? row.events : [];
  events.push({ ...event, ts: Date.now() });
  await supabase.from('agent_runs').update({ events }).eq('id', runId);
  return events;
}

async function setStatus(supabase: any, runId: string, patch: any) {
  await supabase.from('agent_runs').update(patch).eq('id', runId);
}

async function getRun(supabase: any, runId: string) {
  const { data } = await supabase.from('agent_runs').select('*').eq('id', runId).single();
  return data;
}

/* ── Telegram live-status (edits a single message in place) ──────────── */

async function tgSend(chatId: string, text: string, lovKey: string, tgKey: string): Promise<number | null> {
  try {
    const r = await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovKey}`,
        'X-Connection-Api-Key': tgKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) }),
    });
    const d = await r.json();
    return d?.result?.message_id ?? null;
  } catch (e) {
    console.error('tgSend failed:', e);
    return null;
  }
}

async function tgEdit(chatId: string, messageId: number, text: string, lovKey: string, tgKey: string) {
  try {
    await fetch(`${TELEGRAM_GATEWAY}/editMessageText`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovKey}`,
        'X-Connection-Api-Key': tgKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text.slice(0, 3900) }),
    });
  } catch (e) {
    console.error('tgEdit failed:', e);
  }
}

function renderTelegramStatus(prompt: string, events: any[], status: string): string {
  const planEvent = [...events].reverse().find((e) => e.type === 'plan');
  const plan = planEvent?.steps as string[] | undefined;
  const recent = events.filter((e) => ['tool_call', 'tool_result', 'thought', 'finish'].includes(e.type)).slice(-6);

  let txt = `🤖 Agent — ${status === 'running' ? '⏳ working' : status === 'completed' ? '✅ done' : '⚠️ ' + status}\n\n`;
  txt += `📝 ${prompt.slice(0, 140)}${prompt.length > 140 ? '…' : ''}\n\n`;
  if (plan && plan.length) {
    txt += `🧭 Plan:\n${plan.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\n`;
  }
  if (recent.length) {
    txt += `▶ Activity:\n`;
    for (const e of recent) {
      if (e.type === 'tool_call') txt += `  🔧 ${e.name}${e.label ? ` — ${e.label}` : ''}\n`;
      else if (e.type === 'tool_result') txt += `  ${e.ok ? '✓' : '✗'} ${e.name}: ${(e.summary || '').slice(0, 100)}\n`;
      else if (e.type === 'finish') txt += `\n${e.summary || 'Done.'}\n`;
    }
  }
  return txt.trim();
}

/* ── Provider map: read user's configured keys ───────────────────────── */

async function getProviderMap(supabase: any) {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  const s = data || {};
  // Pick best image key: prefer image_keys[] entries with apiKey, else image_api_key
  let imageKey = '';
  let imageProvider = s.image_provider || 'auto';
  let imageModel = s.image_model || '';
  try {
    const keys = Array.isArray(s.image_keys) ? s.image_keys : [];
    const usable = keys.find((k: any) => k && k.apiKey && k.enabled !== false);
    if (usable) { imageKey = usable.apiKey; imageProvider = usable.provider || imageProvider; imageModel = usable.model || imageModel; }
  } catch { /* ignore */ }
  if (!imageKey) imageKey = s.image_api_key || '';

  return {
    chat: {
      provider: s.ai_provider || 'lovable',
      apiKey: s.ai_api_key || '',
      model: s.ai_model || 'google/gemini-3-flash-preview',
    },
    research: {
      provider: s.research_provider || 'auto',
      apiKey: s.research_api_key || '',
    },
    image: {
      provider: imageProvider,
      apiKey: imageKey,
      model: imageModel,
      imageKeys: (Array.isArray(s.image_keys) ? s.image_keys : []).filter((k: any) => k && k.enabled !== false),
    },
    shellEnabled: !!s.agent_shell_enabled,
    workspaceRoot: s.agent_workspace_path || '',
  };
}

/* ── Call planner LLM (user's provider, fallback Lovable) ────────────── */

async function callPlanner(messages: any[], chat: any, lovableKey: string): Promise<any> {
  // Build endpoint + headers + model based on provider
  let url = LOVABLE_GATEWAY;
  let key = lovableKey;
  let model = chat.model || 'google/gemini-3-flash-preview';

  if (chat.provider === 'openai' && chat.apiKey) {
    url = 'https://api.openai.com/v1/chat/completions';
    key = chat.apiKey;
    if (!model || model.startsWith('google/')) model = 'gpt-4o-mini';
  } else if (chat.provider === 'openrouter' && chat.apiKey) {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    key = chat.apiKey;
  } else if (chat.provider === 'anthropic' && chat.apiKey) {
    // Anthropic has incompatible API — fall back to Lovable for the agent loop
    // (deep tool-calling differs). We still use the user's model selection elsewhere.
    url = LOVABLE_GATEWAY;
    key = lovableKey;
    if (!model || model.startsWith('claude')) model = 'google/gemini-3-flash-preview';
  } else if (chat.provider === 'lmstudio' && chat.apiKey) {
    // LM Studio exposes OpenAI-compatible endpoint at user-provided URL via apiKey field
    // For agent reliability, fall back to Lovable. (LM Studio is used via local server.)
    url = LOVABLE_GATEWAY;
    key = lovableKey;
    if (!model || !model.includes('/')) model = 'google/gemini-3-flash-preview';
  }

  const body: any = { model, messages, tools, tool_choice: 'auto' };
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Planner LLM failed (${r.status}): ${t.slice(0, 300)}`);
  }
  return await r.json();
}

/* ── Cloud-side tool executors (research + image — done in edge fn) ──── */

type ResearchSource = { title: string; url: string; snippet?: string };

function inferResearchProvider(provider: string, apiKey: string): string {
  if (provider && provider !== 'auto') return provider;
  // Heuristic only for auto mode. The Settings UI auto-detects providers earlier,
  // so these regexes are only best-effort guesses when a key exists but the provider stayed on auto.
  const key = String(apiKey || '').trim();
  // Brave Search API keys usually start with BSA...
  if (/^BSA[A-Za-z0-9_-]{10,}$/i.test(key)) return 'brave';
  // Tavily keys use the tvly- prefix.
  if (/^tvly-[A-Za-z0-9]{10,}$/i.test(key)) return 'tavily';
  // Serper keys are 64-char hex strings.
  if (/^[a-f0-9]{64}$/i.test(key)) return 'serper';
  // Firecrawl keys use the fc- prefix.
  if (/^fc-[A-Za-z0-9]{10,}$/i.test(key)) return 'firecrawl';
  return 'local';
}

async function searchBrave(apiKey: string, query: string, count = 6): Promise<ResearchSource[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Brave ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.web?.results || []).map((item: any) => ({ title: item.title, url: item.url, snippet: item.description || '' }));
}

async function searchTavily(apiKey: string, query: string, count = 6): Promise<ResearchSource[]> {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: 'advanced' }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.results || []).map((item: any) => ({ title: item.title, url: item.url, snippet: item.content || '' }));
}

async function searchSerper(apiKey: string, query: string, count = 6): Promise<ResearchSource[]> {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: count }),
  });
  if (!r.ok) throw new Error(`Serper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.organic || []).map((item: any) => ({ title: item.title, url: item.link, snippet: item.snippet || '' }));
}

async function searchFirecrawl(apiKey: string, query: string, count = 6): Promise<ResearchSource[]> {
  const r = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: count }),
  });
  if (!r.ok) throw new Error(`Firecrawl ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d?.data || []).map((item: any) => ({ title: item.title || item.metadata?.title || item.url, url: item.url, snippet: item.description || item.markdown || '' }));
}

async function searchLocalViaCommand(supabase: any, query: string, count = 6): Promise<ResearchSource[]> {
  const queued = await queueLocalCommand(supabase, 'research_search', { query, count });
  if (!queued.ok) throw new Error(typeof queued.result === 'string' ? queued.result : 'Local research worker failed');
  const result = queued.result?.results || queued.result?.result?.results || [];
  return (Array.isArray(result) ? result : []).map((item: any) => ({
    title: item.title || item.url || 'Untitled result',
    url: item.url,
    snippet: item.snippet || '',
  })).filter((item: ResearchSource) => !!item.url);
}

async function runResearchSearch(supabase: any, provider: string, apiKey: string, query: string, count = 6): Promise<{ provider: string; sources: ResearchSource[] }> {
  const chosen = inferResearchProvider(provider, apiKey);
  const order = chosen === 'local' ? ['local'] : [chosen, 'local'];
  let lastError: Error | null = null;
  for (const candidate of order) {
    try {
      let sources: ResearchSource[] = [];
      if (candidate === 'brave' && apiKey) sources = await searchBrave(apiKey, query, count);
      else if (candidate === 'tavily' && apiKey) sources = await searchTavily(apiKey, query, count);
      else if (candidate === 'serper' && apiKey) sources = await searchSerper(apiKey, query, count);
      else if (candidate === 'firecrawl' && apiKey) sources = await searchFirecrawl(apiKey, query, count);
      else if (candidate === 'local') sources = await searchLocalViaCommand(supabase, query, count);
      if (sources.length > 0) return { provider: candidate, sources };
    } catch (error) {
      lastError = error as Error;
    }
  }
  if (lastError) throw lastError;
  return { provider: chosen, sources: [] };
}

function trimText(value: string, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function execResearchDeep(args: any, providers: any, lovableKey: string, supabase: any): Promise<{ ok: boolean; summary: string; data?: any }> {
  try {
    const count = args.depth === 'deep' ? 8 : args.depth === 'light' ? 4 : 6;
    const { provider, sources } = await runResearchSearch(
      supabase,
      providers.research.provider,
      providers.research.apiKey,
      args.query,
      count,
    );
    if (sources.length === 0) {
      return { ok: false, summary: 'Research returned no sources.' };
    }

    const sourceSummary = sources.slice(0, 6)
      .map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${trimText(item.snippet || '', 300)}`)
      .join('\n\n');

    const llmResp = await fetch(LOVABLE_GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lovableKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: 'You are a research assistant. Synthesize the supplied search results into a concise, useful summary with concrete facts. Do not invent facts or URLs.',
          },
          {
            role: 'user',
            content: `Research query: ${args.query}\nProvider: ${provider}\n\nSearch results:\n${sourceSummary}`,
          },
        ],
      }),
    });
    const llmData = await llmResp.json().catch(() => ({}));
    const findings = llmData?.choices?.[0]?.message?.content
      || sources.slice(0, 4).map((item) => `• ${item.title} — ${trimText(item.snippet || '', 180)}`).join('\n');

    return {
      ok: true,
      summary: `Found ${sources.length} sources via ${provider}.`,
      data: { findings, sources, provider },
    };
  } catch (e) {
    return { ok: false, summary: `Research failed: ${(e as Error).message}` };
  }
}

function inferImageProvider(provider: string, apiKey: string): string {
  if (provider && provider !== 'auto') return provider;
  // Heuristic only for auto mode. Prefer the explicit saved provider whenever present;
  // these regexes are only best-effort guesses when the provider stayed on auto.
  const key = String(apiKey || '').trim();
  // xAI keys use the xai- prefix.
  if (/^xai-[A-Za-z0-9_-]{20,}$/i.test(key)) return 'xai';
  // NVIDIA NIM keys use the nvapi- prefix.
  if (/^nvapi-[A-Za-z0-9_-]{20,}$/i.test(key)) return 'nvidia';
  // Google AI Studio keys use the AIza prefix.
  if (/^AIza[A-Za-z0-9_-]{20,}$/.test(key)) return 'google';
  // OpenAI keys use sk- / sk-proj- prefixes.
  if (/^sk-(proj-)?[A-Za-z0-9_-]{20,}$/.test(key)) return 'openai';
  // Pexels keys are long mixed-case alphanumeric strings.
  if (/^[A-Za-z0-9]{50,60}$/.test(key) && !/^[a-f0-9]+$/i.test(key)) return 'pexels';
  // Unsplash access keys are shorter mixed-case tokens.
  if (/^[A-Za-z0-9_-]{40,48}$/.test(key)) return 'unsplash';
  return 'lovable';
}

async function findUnsplashImage(key: string, query: string): Promise<{ url: string; credit: string } | null> {
  const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=squarish`, {
    headers: { Authorization: `Client-ID ${key}` },
  });
  if (!r.ok) throw new Error(`Unsplash ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const img = d?.results?.[0];
  return img ? { url: img.urls?.regular || img.urls?.full, credit: `Photo by ${img.user?.name || 'Unsplash'}` } : null;
}

async function findPexelsImage(key: string, query: string): Promise<{ url: string; credit: string } | null> {
  const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
    headers: { Authorization: key },
  });
  if (!r.ok) throw new Error(`Pexels ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const img = d?.photos?.[0];
  return img ? { url: img.src?.large || img.src?.original, credit: `Photo by ${img.photographer || 'Pexels'}` } : null;
}

async function generateAIImage(provider: string, key: string, prompt: string, model: string, lovableKey: string): Promise<{ dataUrl: string | null; remoteUrl?: string | null; credit?: string | null; error?: string }> {
  try {
    if (provider === 'unsplash' && key) {
      const found = await findUnsplashImage(key, prompt);
      return { dataUrl: null, remoteUrl: found?.url || null, credit: found?.credit || null };
    }
    if (provider === 'pexels' && key) {
      const found = await findPexelsImage(key, prompt);
      return { dataUrl: null, remoteUrl: found?.url || null, credit: found?.credit || null };
    }
    if (provider === 'openai' && key) {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
      });
      if (!r.ok) return { dataUrl: null, error: `OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const d = await r.json();
      const b64 = d?.data?.[0]?.b64_json;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : null, remoteUrl: d?.data?.[0]?.url || null };
    }
    if (provider === 'google' && key) {
      const imageModel = model || 'gemini-2.5-flash-image';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(imageModel)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 1500) }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        }),
      });
      if (!r.ok) return { dataUrl: null, error: `Google ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const d = await r.json();
      const part = (d?.candidates?.[0]?.content?.parts || []).find((item: any) => item?.inlineData?.data || item?.inline_data?.data);
      const b64 = part?.inlineData?.data || part?.inline_data?.data;
      const mime = part?.inlineData?.mimeType || part?.inline_data?.mime_type || 'image/png';
      return { dataUrl: b64 ? `data:${mime};base64,${b64}` : null };
    }
    if (provider === 'nvidia' && key) {
      const r = await fetch(`https://ai.api.nvidia.com/v1/genai/${model || 'black-forest-labs/flux.1-schnell'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt: prompt.slice(0, 1500), width: 1024, height: 1024, samples: 1, steps: 4, cfg_scale: 3.5 }),
      });
      if (!r.ok) return { dataUrl: null, error: `NVIDIA ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const d = await r.json();
      const b64 = d?.image || d?.artifacts?.[0]?.base64 || d?.data?.[0]?.b64_json;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : null, remoteUrl: d?.data?.[0]?.url || null };
    }
    if (provider === 'xai' && key) {
      const r = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'grok-2-image-1212', prompt: prompt.slice(0, 1500), n: 1, response_format: 'b64_json' }),
      });
      if (!r.ok) return { dataUrl: null, error: `xAI ${r.status}: ${(await r.text()).slice(0, 200)}` };
      const d = await r.json();
      const b64 = d?.data?.[0]?.b64_json;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : null, remoteUrl: d?.data?.[0]?.url || null };
    }

    const r = await fetch(LOVABLE_GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lovableKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'google/gemini-2.5-flash-image',
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image', 'text'],
      }),
    });
    if (!r.ok) return { dataUrl: null, error: `Lovable ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const d = await r.json();
    return { dataUrl: d?.choices?.[0]?.message?.images?.[0]?.image_url?.url || null };
  } catch (e) {
    return { dataUrl: null, error: (e as Error).message };
  }
}

async function uploadAgentImage(supabase: any, dataUrlOrRemoteUrl: string): Promise<{ url: string; path: string } | null> {
  try {
    if (/^https?:\/\//i.test(dataUrlOrRemoteUrl)) {
      const r = await fetch(dataUrlOrRemoteUrl);
      if (!r.ok) return null;
      const mime = r.headers.get('content-type') || 'image/jpeg';
      const ext = mime.split('/')[1]?.split(';')[0] || 'jpg';
      const bytes = new Uint8Array(await r.arrayBuffer());
      const path = `agent/${Date.now()}-${crypto.randomUUID().slice(0, 6)}.${ext}`;
      const { error } = await supabase.storage.from('social-media').upload(path, bytes, { contentType: mime });
      if (error) return null;
      const { data } = supabase.storage.from('social-media').getPublicUrl(path);
      return { url: data.publicUrl, path };
    }

    const match = dataUrlOrRemoteUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!match) return null;
    const mime = match[1];
    const b64 = match[2];
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ext = mime.split('/')[1] || 'png';
    const path = `agent/${Date.now()}-${crypto.randomUUID().slice(0, 6)}.${ext}`;
    const { error } = await supabase.storage.from('social-media').upload(path, bytes, { contentType: mime });
    if (error) return null;
    const { data } = supabase.storage.from('social-media').getPublicUrl(path);
    return { url: data.publicUrl, path };
  } catch {
    return null;
  }
}

async function execGenerateImage(args: any, providers: any, lovableKey: string, supabase: any): Promise<{ ok: boolean; summary: string; data?: any }> {
  const configuredChain = Array.isArray(providers.image.imageKeys) ? providers.image.imageKeys : [];
  const chain = configuredChain.length > 0
    ? configuredChain.map((entry: any) => ({
      provider: inferImageProvider(entry.provider || 'auto', entry.apiKey || ''),
      apiKey: entry.apiKey || '',
      model: entry.model || '',
      label: entry.label || '',
    }))
    : [{
      provider: inferImageProvider(providers.image.provider, providers.image.apiKey),
      apiKey: providers.image.apiKey || '',
      model: providers.image.model || '',
      label: providers.image.provider || 'primary',
    }];

  if (!chain.some((entry: any) => entry.provider === 'lovable')) {
    chain.push({ provider: 'lovable', apiKey: '', model: 'google/gemini-2.5-flash-image', label: 'lovable fallback' });
  }

  for (const entry of chain) {
    const generated = await generateAIImage(entry.provider, entry.apiKey || '', args.prompt, entry.model || '', lovableKey);
    const source = generated.dataUrl || generated.remoteUrl || '';
    if (!source) continue;
    const uploaded = await uploadAgentImage(supabase, source);
    if (!uploaded) continue;
    return {
      ok: true,
      summary: `Image generated via ${entry.provider}.`,
      data: { url: uploaded.url, path: uploaded.path, prompt: args.prompt, provider: entry.provider, credit: generated.credit || null },
    };
  }

  return { ok: false, summary: 'Image generation failed for every configured provider.' };
}

/* ── Wait helper for local-side tools (poll pending_commands) ────────── */

async function waitForLocalCommand(supabase: any, commandId: string, timeoutMs = 90_000): Promise<{ ok: boolean; result: any }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const { data } = await supabase.from('pending_commands').select('status,result').eq('id', commandId).single();
    if (!data) continue;
    if (data.status === 'completed' || data.status === 'failed') {
      let parsed: any = data.result;
      try { parsed = JSON.parse(data.result); } catch { /* keep string */ }
      return { ok: data.status === 'completed', result: parsed };
    }
  }
  return { ok: false, result: 'Local worker timed out (is your local server running?)' };
}

async function queueLocalCommand(supabase: any, command: string, args: any): Promise<{ ok: boolean; result: any }> {
  const { data, error } = await supabase
    .from('pending_commands')
    .insert({ command, args, status: 'pending' })
    .select('id')
    .single();
  if (error) return { ok: false, result: `Could not queue: ${error.message}` };
  return await waitForLocalCommand(supabase, data.id);
}

/* ── Main agent loop ─────────────────────────────────────────────────── */

async function runAgent(supabase: any, runId: string, lovableKey: string, telegramKey: string | null) {
  const run = await getRun(supabase, runId);
  if (!run) return;
  const providers = await getProviderMap(supabase);

  const systemPrompt = `You are an autonomous coding/research agent (like Claude Code or Codex) running inside a video & social-post automation app.

# Your environment
- Workspace folder on the user's local Windows PC (slug: "${slugify(run.prompt)}")${providers.workspaceRoot ? ` rooted at "${providers.workspaceRoot}"` : ''}.
- Tools to: research the web, generate images, read/write/list files in the workspace, run allowlisted shell commands (${providers.shellEnabled ? 'ENABLED' : 'DISABLED — do not call run_shell'}), open URLs/files in the user's default browser, and start a static preview server.
- Configured providers: chat=${providers.chat.provider}/${providers.chat.model}, research=${providers.research.provider}, image=${providers.image.provider}.

# Workflow (MUST follow)
1. ALWAYS call \`plan\` FIRST with 3-7 concise steps before doing anything else.
2. Then execute tools one at a time, observing each result before the next call.
3. Use \`research_deep\` for anything time-sensitive or factual you don't already know.
4. For "build me an app/page" requests: write all needed files with \`write_file\`, then \`serve_preview\` and \`open_in_browser\` so the user can see it immediately.
5. For "open X / browse to Y" requests: use \`open_in_browser\`.
6. ALWAYS finish with \`finish\` — include a short summary and artifacts (file paths, preview URL, image URLs).
7. Be DECISIVE. Don't ask the user clarifying questions — make reasonable choices.
8. Keep file contents production-ready (proper HTML5, modern CSS/JS, valid syntax).

# Quality bar
- Output is shown live to the user step-by-step. Be concise in tool args.
- For HTML apps: include Tailwind via CDN, proper meta tags, responsive layout.
- Image prompts: be specific about style, lighting, composition.

User request: ${run.prompt}`;

  // Find matching skills (simple keyword overlap on triggers + name)
  const promptLow = run.prompt.toLowerCase();
  const { data: allSkills } = await supabase.from('agent_skills').select('*').eq('enabled', true);
  const matched = (allSkills || []).filter((sk: any) => {
    const trigs = [sk.name, ...(sk.triggers || [])].filter(Boolean).map((t: string) => t.toLowerCase());
    return trigs.some((t: string) => t && promptLow.includes(t));
  }).slice(0, 3);

  let skillContext = '';
  if (matched.length > 0) {
    skillContext = `\n\n# Relevant saved skills (use them if applicable)
${matched.map((sk: any, i: number) => `## Skill ${i + 1}: ${sk.name}
Description: ${sk.description}
${sk.system_prompt ? `Instructions: ${sk.system_prompt}\n` : ''}Steps:
${(sk.steps || []).map((s: any, j: number) => `  ${j + 1}. ${s.note || s.tool}`).join('\n')}`).join('\n\n')}`;
    // Mark first match as the primary skill
    await setStatus(supabase, runId, { skill_id: matched[0].id });
    await appendEvent(supabase, runId, { type: 'skill_matched', name: matched[0].name, id: matched[0].id });
  }

  const systemPromptFull = systemPrompt + skillContext + `\n\n# Skills system
You can also call \`save_skill\` after a successful novel routine — it proposes saving the workflow so the user can approve and reuse it later. Only propose when the task is genuinely repeatable.`;

  const messages: any[] = [
    { role: 'system', content: systemPromptFull },
    { role: 'user', content: run.prompt },
  ];

  let telegramMsgId: number | null = run.telegram_status_message_id ?? null;
  const updateTelegram = async () => {
    if (!run.telegram_chat_id || !telegramKey) return;
    const fresh = await getRun(supabase, runId);
    if (!fresh) return;
    const txt = renderTelegramStatus(fresh.prompt, fresh.events || [], fresh.status);
    if (telegramMsgId) {
      await tgEdit(run.telegram_chat_id, telegramMsgId, txt, lovableKey, telegramKey);
    } else {
      telegramMsgId = await tgSend(run.telegram_chat_id, txt, lovableKey, telegramKey);
      if (telegramMsgId) await setStatus(supabase, runId, { telegram_status_message_id: telegramMsgId });
    }
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Cancellation check
      const live = await getRun(supabase, runId);
      if (live?.status === 'cancelled') {
        await appendEvent(supabase, runId, { type: 'cancelled' });
        await updateTelegram();
        return;
      }

      const data = await callPlanner(messages, providers.chat, lovableKey);
      const choice = data?.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        await appendEvent(supabase, runId, { type: 'error', message: 'Empty response from planner.' });
        break;
      }
      messages.push(msg);

      if (msg.content && msg.content.trim()) {
        await appendEvent(supabase, runId, { type: 'thought', text: msg.content.slice(0, 600) });
      }

      const calls = msg.tool_calls || [];
      if (calls.length === 0) {
        // No tool calls and no finish — wrap up
        await appendEvent(supabase, runId, { type: 'finish', summary: msg.content || 'Done.' });
        await setStatus(supabase, runId, { status: 'completed', completed_at: new Date().toISOString() });
        await updateTelegram();
        return;
      }

      let finished = false;
      for (const tc of calls) {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* */ }
        const name = tc.function.name;

        await appendEvent(supabase, runId, {
          type: 'tool_call',
          name,
          label: name === 'plan' ? `${(args.steps || []).length} steps`
            : name === 'research_deep' ? args.query?.slice(0, 80)
            : name === 'generate_image' ? args.prompt?.slice(0, 80)
            : name === 'write_file' ? args.path
            : name === 'read_file' ? args.path
            : name === 'run_shell' ? args.command?.slice(0, 80)
            : name === 'open_in_browser' ? args.target
            : name === 'serve_preview' ? 'workspace'
            : name === 'save_skill' ? args.name
            : name === 'finish' ? 'summary'
            : '',
        });
        await updateTelegram();

        let toolResultText = '';
        let toolResultData: any = null;
        let ok = true;

        if (name === 'plan') {
          await appendEvent(supabase, runId, { type: 'plan', steps: args.steps || [] });
          toolResultText = `Plan recorded: ${(args.steps || []).length} steps.`;
        } else if (name === 'research_deep') {
          const r = await execResearchDeep(args, providers, lovableKey, supabase);
          ok = r.ok;
          toolResultText = ok ? r.data?.findings || r.summary : r.summary;
          toolResultData = r.data;
        } else if (name === 'generate_image') {
          const r = await execGenerateImage(args, providers, lovableKey, supabase);
          ok = r.ok;
          toolResultText = ok ? `Image URL: ${r.data.url}` : r.summary;
          toolResultData = r.data;
        } else if (name === 'write_file' || name === 'read_file' || name === 'list_files' || name === 'run_shell' || name === 'open_in_browser' || name === 'serve_preview') {
          if (name === 'run_shell' && !providers.shellEnabled) {
            ok = false;
            toolResultText = 'Shell access is disabled in Settings → Agent Workspace. Ask the user to enable it.';
          } else {
            const slug = slugify(run.prompt);
            const r = await queueLocalCommand(supabase, `agent_${name}`, {
              ...args,
              runId,
              projectSlug: slug,
              workspaceRoot: providers.workspaceRoot || '',
            });
            ok = r.ok;
            toolResultText = typeof r.result === 'string' ? r.result : JSON.stringify(r.result).slice(0, 1500);
            toolResultData = typeof r.result === 'object' ? r.result : null;
          }
        } else if (name === 'save_skill') {
          await setStatus(supabase, runId, {
            pending_skill: {
              name: args.name,
              description: args.description,
              triggers: args.triggers || [],
              steps: args.steps || [],
              system_prompt: args.system_prompt || '',
              tags: args.tags || [],
            },
          });
          await appendEvent(supabase, runId, { type: 'skill_proposed', name: args.name });
          toolResultText = `Skill "${args.name}" proposed. The user can approve it from the Skills page to reuse it later.`;
        } else if (name === 'finish') {
          await appendEvent(supabase, runId, { type: 'finish', summary: args.summary || 'Done.', artifacts: args.artifacts || [] });
          await setStatus(supabase, runId, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            result: { summary: args.summary, artifacts: args.artifacts || [] },
          });
          finished = true;
          toolResultText = 'finished';
        } else {
          ok = false;
          toolResultText = `Unknown tool: ${name}`;
        }

        await appendEvent(supabase, runId, {
          type: 'tool_result',
          name,
          ok,
          summary: toolResultText.slice(0, 200),
          data: toolResultData,
        });
        await updateTelegram();

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResultText.slice(0, 6000),
        });
      }

      if (finished) {
        await updateTelegram();
        return;
      }
    }

    // Max steps reached
    await appendEvent(supabase, runId, { type: 'error', message: `Reached max ${MAX_STEPS} steps.` });
    await setStatus(supabase, runId, { status: 'completed', completed_at: new Date().toISOString() });
    await updateTelegram();
  } catch (e) {
    console.error('Agent loop crashed:', e);
    await appendEvent(supabase, runId, { type: 'error', message: (e as Error).message });
    await setStatus(supabase, runId, { status: 'failed', error: (e as Error).message, completed_at: new Date().toISOString() });
    await updateTelegram();
  }
}

/* ── HTTP entry ──────────────────────────────────────────────────────── */

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');
    const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY') || null;
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();

    // Cancel
    if (body.action === 'cancel' && body.runId) {
      await setStatus(supabase, body.runId, { status: 'cancelled', completed_at: new Date().toISOString() });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Wait for an existing run (used by ai-chat to block until plan emitted)
    if (body.action === 'await_plan' && body.runId) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const r = await getRun(supabase, body.runId);
        const hasPlan = (r?.events || []).some((e: any) => e.type === 'plan');
        if (hasPlan || r?.status !== 'running') {
          return new Response(JSON.stringify({ ok: true, run: r }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({ ok: true, run: await getRun(supabase, body.runId) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { prompt, source, telegram_chat_id } = body;
    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'prompt is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const providers = await getProviderMap(supabase);
    const slug = slugify(prompt);
    const { data: row, error } = await supabase.from('agent_runs').insert({
      prompt,
      status: 'running',
      events: [{ type: 'started', ts: Date.now() }],
      model: providers.chat.model,
      workspace_path: slug,
      source: source || 'web',
      telegram_chat_id: telegram_chat_id || null,
    }).select('id').single();
    if (error) throw new Error(error.message);

    // Fire-and-forget the loop so the HTTP response returns immediately
    EdgeRuntime.waitUntil(runAgent(supabase, row.id, LOVABLE_API_KEY, TELEGRAM_API_KEY));

    return new Response(JSON.stringify({ ok: true, runId: row.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('agent-run handler error:', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// EdgeRuntime is provided by Supabase
declare const EdgeRuntime: { waitUntil: (p: Promise<any>) => void };
