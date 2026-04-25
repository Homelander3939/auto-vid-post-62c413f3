// Agent diagnostics — returns a single JSON snapshot of:
//   • configured AI / image / research providers + key presence
//   • Lovable AI gateway reachability
//   • Local worker liveness (inferred from pending_commands queue)
//   • Recent agent_runs success/failure counts
// Used by the UI to render a "Diagnostics" status badge and surface clear
// errors instead of silent failures.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function maskKey(k?: string | null): string {
  if (!k) return '';
  const t = String(k).trim();
  if (t.length <= 8) return '***';
  return `${t.slice(0, 4)}…${t.slice(-3)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }).catch(() => { clearTimeout(t); resolve(fallback); });
  });
}

async function probeLovableGateway(key: string): Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    // HEAD/OPTIONS to base URL — avoids burning a chat completion and is much faster.
    const resp = await fetch('https://ai.gateway.lovable.dev/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const latency = Date.now() - t0;
    // Drain body to avoid leaks
    try { await resp.text(); } catch {}
    if (resp.status === 401 || resp.status === 403) return { ok: false, latencyMs: latency, status: resp.status, error: 'Unauthorized — LOVABLE_API_KEY invalid.' };
    if (resp.status === 402) return { ok: false, latencyMs: latency, status: 402, error: 'Out of credits.' };
    if (resp.status === 429) return { ok: true, latencyMs: latency, status: 429, error: 'Rate limited (gateway alive).' };
    return { ok: resp.ok || resp.status === 404, latencyMs: latency, status: resp.status };
  } catch (e: any) {
    clearTimeout(timer);
    return { ok: false, latencyMs: Date.now() - t0, error: e?.name === 'AbortError' ? 'Gateway probe timed out (5s)' : (e?.message || 'fetch failed') };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Settings
    const { data: settings } = await supabase
      .from('app_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    // Local worker liveness via pending_commands recency
    const ninetySecAgo = new Date(Date.now() - 90_000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const lovableKey = Deno.env.get('LOVABLE_API_KEY') || '';

    const [recentCompletedRes, lastEverRes, runsRes, gatewayProbe] = await Promise.all([
      withTimeout(
        supabase.from('pending_commands').select('completed_at').gte('completed_at', ninetySecAgo).order('completed_at', { ascending: false }).limit(1),
        4000, { data: null } as any,
      ),
      withTimeout(
        supabase.from('pending_commands').select('completed_at').not('completed_at', 'is', null).order('completed_at', { ascending: false }).limit(1),
        4000, { data: null } as any,
      ),
      withTimeout(
        supabase.from('agent_runs').select('status').gte('created_at', dayAgo).limit(200),
        4000, { data: [] } as any,
      ),
      lovableKey
        ? withTimeout(probeLovableGateway(lovableKey), 6000, { ok: false, latencyMs: 6000, error: 'Probe timed out' })
        : Promise.resolve({ ok: false, latencyMs: 0, error: 'LOVABLE_API_KEY missing' }),
    ]);

    const recentCompleted = recentCompletedRes?.data;
    const lastEver = lastEverRes?.data;
    const runs = runsRes?.data || [];

    let lastSeenAt: string | null = recentCompleted?.[0]?.completed_at || null;
    if (!lastSeenAt) lastSeenAt = lastEver?.[0]?.completed_at || null;
    const workerAlive = !!recentCompleted?.length;

    const stats = (runs || []).reduce(
      (acc: any, r: any) => {
        acc.total++;
        if (r.status === 'completed') acc.completed++;
        else if (r.status === 'failed' || r.status === 'error') acc.failed++;
        else if (r.status === 'running') acc.running++;
        return acc;
      },
      { total: 0, completed: 0, failed: 0, running: 0 },
    );

    const s = settings || ({} as any);
    const providers = {
      chat: {
        provider: s.ai_provider || 'lovable',
        model: s.ai_model || 'google/gemini-3-flash-preview',
        hasKey: !!(s.ai_api_key && s.ai_api_key.trim()) || (s.ai_provider || 'lovable') === 'lovable',
        baseUrl: s.ai_base_url || '',
        keyMasked: maskKey(s.ai_api_key),
      },
      image: {
        provider: s.image_provider || 'auto',
        model: s.image_model || '',
        hasKey: !!(s.image_api_key && s.image_api_key.trim()) || (s.image_provider || 'auto') === 'auto',
        keyMasked: maskKey(s.image_api_key),
      },
      research: {
        provider: s.research_provider || 'auto',
        depth: s.research_depth || 'standard',
        hasKey: !!(s.research_api_key && s.research_api_key.trim()),
        keyMasked: maskKey(s.research_api_key),
      },
    };

    // Build human-readable status
    const issues: string[] = [];
    if (!gatewayProbe.ok) issues.push(`Lovable AI gateway: ${gatewayProbe.error || `HTTP ${gatewayProbe.status}`}`);
    if (!workerAlive) issues.push(lastSeenAt ? `Local worker last seen ${lastSeenAt}` : 'Local worker has never connected');
    if (providers.chat.provider !== 'lovable' && providers.chat.provider !== 'lmstudio' && !providers.chat.hasKey) {
      issues.push(`Chat provider "${providers.chat.provider}" has no API key configured`);
    }
    if (providers.chat.provider === 'lmstudio' && !providers.chat.baseUrl) {
      issues.push('LM Studio selected but no base URL configured');
    }

    const overall = issues.length === 0 ? 'healthy' : (gatewayProbe.ok ? 'degraded' : 'down');

    return new Response(
      JSON.stringify({
        overall,
        issues,
        gateway: gatewayProbe,
        local_worker: { alive: workerAlive, last_seen_at: lastSeenAt },
        providers,
        runs_24h: stats,
        checked_at: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e: any) {
    console.error('agent-diagnostics error', e);
    return new Response(JSON.stringify({ overall: 'down', error: e?.message || 'unknown' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
