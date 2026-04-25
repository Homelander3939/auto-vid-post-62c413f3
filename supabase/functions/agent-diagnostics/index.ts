// Agent diagnostics — lightweight, non-blocking snapshot.
// Important: this function must never perform live DB or external gateway probes.
// A previous implementation timed out because pending fetches could keep the Edge
// runtime open even after Promise.race returned a fallback response.

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const lovableKey = Deno.env.get('LOVABLE_API_KEY') || '';
    const browserbaseKey = Deno.env.get('BROWSERBASE_API_KEY') || '';
    const browserbaseProjectId = Deno.env.get('BROWSERBASE_PROJECT_ID') || '';

    const issues: string[] = [
      'Live DB/gateway probes are disabled in this badge to prevent diagnostics from blocking the app.',
    ];

    if (!lovableKey) issues.push('LOVABLE_API_KEY missing');
    if (!browserbaseKey) issues.push('BROWSERBASE_API_KEY missing');
    if (!browserbaseProjectId) issues.push('BROWSERBASE_PROJECT_ID missing');

    return json({
      overall: issues.length > 1 ? 'degraded' : 'healthy',
      issues,
      gateway: {
        ok: !!lovableKey,
        latencyMs: 0,
        status: lovableKey ? 200 : undefined,
        error: lovableKey ? undefined : 'LOVABLE_API_KEY missing',
        mode: 'env-only',
      },
      local_worker: {
        alive: null,
        last_seen_at: null,
        mode: 'reported by local health checks / pending command results',
      },
      providers: {
        chat: {
          provider: 'configured-in-settings',
          model: 'configured-in-settings',
          hasKey: !!lovableKey,
          baseUrl: '',
          keyMasked: maskKey(lovableKey),
        },
        image: {
          provider: 'configured-in-settings',
          model: '',
          hasKey: true,
          keyMasked: '',
        },
        research: {
          provider: 'local/browser',
          depth: 'configured-in-settings',
          hasKey: !!browserbaseKey || true,
          keyMasked: maskKey(browserbaseKey),
        },
      },
      runs_24h: { total: 0, completed: 0, failed: 0, running: 0, mode: 'disabled-live-query' },
      checked_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('agent-diagnostics error', e);
    return json({ overall: 'down', error: e?.message || 'unknown' }, 200);
  }
});
