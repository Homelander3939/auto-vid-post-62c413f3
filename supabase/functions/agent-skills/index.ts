// Agent Skills manager — install from GitHub URL, accept proposed skills, run a skill on demand.
//
// POST { action: 'install_github', url }      → fetches skill.json from a GitHub repo (raw URL or repo URL) and stores it
// POST { action: 'accept_pending', runId }    → promotes agent_runs.pending_skill into agent_skills
// POST { action: 'run_skill', skillId, input? } → kicks off an agent-run pre-loaded with that skill
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function slugify(s: string): string {
  return (s || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

// Convert a GitHub repo URL or blob URL to a raw URL for skill.json
function toRawSkillUrl(url: string): string[] {
  const candidates: string[] = [];
  if (url.includes('raw.githubusercontent.com')) {
    candidates.push(url);
    return candidates;
  }
  // https://github.com/{owner}/{repo}  or .../tree/branch/path  or .../blob/branch/path/skill.json
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?$/);
  if (m) {
    const [, owner, repo, branch = 'main', path = ''] = m;
    const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
    if (path.endsWith('skill.json')) {
      candidates.push(`${base}/${path}`);
    } else if (path) {
      candidates.push(`${base}/${path.replace(/\/$/, '')}/skill.json`);
    } else {
      candidates.push(`${base}/skill.json`);
      candidates.push(`${base.replace('/main', '/master')}/skill.json`);
    }
  } else {
    candidates.push(url);
  }
  return candidates;
}

async function fetchSkillJson(url: string): Promise<any> {
  const tries = toRawSkillUrl(url);
  let lastErr = '';
  for (const u of tries) {
    try {
      const r = await fetch(u);
      if (!r.ok) { lastErr = `${u} → ${r.status}`; continue; }
      const text = await r.text();
      try { return { json: JSON.parse(text), raw_url: u }; }
      catch { lastErr = `${u} → invalid JSON`; }
    } catch (e) { lastErr = `${u} → ${(e as Error).message}`; }
  }
  throw new Error(`Could not load skill.json. Tried: ${tries.join(', ')}. Last error: ${lastErr}`);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json();

    if (body.action === 'install_github') {
      const { url } = body;
      if (!url) throw new Error('url is required');
      const { json, raw_url } = await fetchSkillJson(url);

      const name = json.name || 'Untitled Skill';
      const slugBase = slugify(json.slug || name);
      // Ensure unique slug
      let slug = slugBase;
      let n = 1;
      while (true) {
        const { data: existing } = await supabase.from('agent_skills').select('id').eq('slug', slug).maybeSingle();
        if (!existing) break;
        n += 1; slug = `${slugBase}-${n}`;
      }

      const { data, error } = await supabase.from('agent_skills').insert({
        name,
        slug,
        description: json.description || '',
        source: 'github',
        source_url: raw_url,
        triggers: Array.isArray(json.triggers) ? json.triggers : [],
        steps: Array.isArray(json.steps) ? json.steps : [],
        system_prompt: json.system_prompt || json.systemPrompt || '',
        tags: Array.isArray(json.tags) ? json.tags : [],
      }).select().single();
      if (error) throw new Error(error.message);

      return new Response(JSON.stringify({ ok: true, skill: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'accept_pending') {
      const { runId, edits } = body;
      if (!runId) throw new Error('runId required');
      const { data: run } = await supabase.from('agent_runs').select('pending_skill,prompt').eq('id', runId).single();
      const proposal = run?.pending_skill;
      if (!proposal) throw new Error('No pending skill on this run.');

      const merged = { ...proposal, ...(edits || {}) };
      const slugBase = slugify(merged.slug || merged.name || run?.prompt || 'skill');
      let slug = slugBase;
      let n = 1;
      while (true) {
        const { data: existing } = await supabase.from('agent_skills').select('id').eq('slug', slug).maybeSingle();
        if (!existing) break;
        n += 1; slug = `${slugBase}-${n}`;
      }

      const { data, error } = await supabase.from('agent_skills').insert({
        name: merged.name || 'Learned skill',
        slug,
        description: merged.description || '',
        source: 'learned',
        triggers: Array.isArray(merged.triggers) ? merged.triggers : [],
        steps: Array.isArray(merged.steps) ? merged.steps : [],
        system_prompt: merged.system_prompt || '',
        tags: Array.isArray(merged.tags) ? merged.tags : ['learned'],
      }).select().single();
      if (error) throw new Error(error.message);

      await supabase.from('agent_runs').update({ pending_skill: null, skill_id: data.id }).eq('id', runId);
      return new Response(JSON.stringify({ ok: true, skill: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'run_skill') {
      const { skillId, input } = body;
      if (!skillId) throw new Error('skillId required');
      const { data: skill } = await supabase.from('agent_skills').select('*').eq('id', skillId).single();
      if (!skill) throw new Error('Skill not found');

      // Bump usage
      await supabase.from('agent_skills').update({
        use_count: (skill.use_count || 0) + 1,
        last_used_at: new Date().toISOString(),
      }).eq('id', skillId);

      // Build a prompt that primes the agent with the skill's plan
      const stepsText = (skill.steps || []).map((s: any, i: number) =>
        `  ${i + 1}. ${s.note || s.tool || JSON.stringify(s)}`
      ).join('\n');
      const prompt = `Run the saved skill "${skill.name}".

${skill.description || ''}

${input ? `User input for this run:\n${input}\n` : ''}
${skill.system_prompt ? `Skill instructions:\n${skill.system_prompt}\n` : ''}
${stepsText ? `Suggested steps:\n${stepsText}` : ''}`.trim();

      // Delegate to agent-run
      const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/agent-run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt, source: body.source || 'skill' }),
      });
      const d = await r.json();
      if (d?.runId) {
        await supabase.from('agent_runs').update({ skill_id: skillId }).eq('id', d.runId);
      }
      return new Response(JSON.stringify(d), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unknown action: ${body.action}`);
  } catch (e) {
    console.error('agent-skills error:', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
