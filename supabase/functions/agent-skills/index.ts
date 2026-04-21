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

function parseGitHubRepo(url: string): { owner: string; repo: string; branch?: string; path?: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?$/);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    branch: m[3],
    path: m[4] || '',
  };
}

function toRawGitHubUrl(owner: string, repo: string, branch: string, filePath: string) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.replace(/^\/+/, '')}`;
}

function parseMarkdownSkill(raw: string, sourceUrl: string, filePath: string) {
  let text = String(raw || '');
  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter: Record<string, string> = {};
  if (frontmatterMatch) {
    for (const line of frontmatterMatch[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      frontmatter[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    text = text.slice(frontmatterMatch[0].length);
  }

  const headingMatch = text.match(/^#\s+(.+)$/m);
  const name = frontmatter.name || headingMatch?.[1]?.trim() || filePath.split('/').pop()?.replace(/\.(md|txt)$/i, '') || 'Imported Skill';
  const description = frontmatter.description
    || text.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('*') && !/^\d+\./.test(line))
    || '';
  const steps = text.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
    .slice(0, 12)
    .map((line) => ({ note: line.replace(/^([-*]|\d+\.)\s+/, '').trim() }));
  const tags = new Set<string>((frontmatter.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean));
  if (/openclaw/i.test(filePath) || /openclaw/i.test(text)) tags.add('openclaw');
  if (/hermes/i.test(filePath) || /hermes/i.test(text)) tags.add('hermes');
  if (/claude/i.test(filePath) || /claude/i.test(text)) tags.add('claude-style');
  tags.add('github-import');

  return {
    name,
    description,
    triggers: (frontmatter.triggers || frontmatter.keywords || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    steps,
    system_prompt: text.trim(),
    tags: [...tags],
    source_url: sourceUrl,
  };
}

function normalizeSkillRecord(raw: any, sourceUrl: string, fallbackName: string) {
  const name = raw.name || raw.title || raw.slug || fallbackName;
  const description = raw.description || raw.summary || raw.purpose || '';
  const systemPrompt = raw.system_prompt || raw.systemPrompt || raw.prompt || raw.instructions || raw.content || '';
  const triggers = Array.isArray(raw.triggers) ? raw.triggers
    : Array.isArray(raw.keywords) ? raw.keywords
      : typeof raw.triggers === 'string' ? raw.triggers.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
  const tags = new Set<string>(Array.isArray(raw.tags) ? raw.tags : []);
  if (raw.agent) tags.add(String(raw.agent));
  if (raw.framework) tags.add(String(raw.framework));
  if (/openclaw/i.test(JSON.stringify(raw))) tags.add('openclaw');
  if (/hermes/i.test(JSON.stringify(raw))) tags.add('hermes');
  if (/claude/i.test(JSON.stringify(raw))) tags.add('claude-style');
  tags.add('github-import');

  let steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (steps.length === 0 && Array.isArray(raw.workflow)) {
    steps = raw.workflow.map((step: any) => ({ note: typeof step === 'string' ? step : step.note || step.description || JSON.stringify(step) }));
  }
  if (steps.length === 0 && Array.isArray(raw.actions)) {
    steps = raw.actions.map((step: any) => ({ note: typeof step === 'string' ? step : step.note || step.description || JSON.stringify(step) }));
  }

  return {
    name,
    description,
    triggers,
    steps,
    system_prompt: systemPrompt,
    tags: [...tags],
    source_url: sourceUrl,
  };
}

async function fetchRepoSkills(url: string): Promise<any[]> {
  if (url.includes('raw.githubusercontent.com')) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not fetch ${url}: ${r.status}`);
    const text = await r.text();
    try {
      const json = JSON.parse(text);
      const records = Array.isArray(json) ? json : Array.isArray(json.skills) ? json.skills : [json];
      return records.map((record, index) => normalizeSkillRecord(record, url, `Imported Skill ${index + 1}`));
    } catch {
      return [parseMarkdownSkill(text, url, url.split('/').pop() || 'skill.md')];
    }
  }

  const parsed = parseGitHubRepo(url);
  if (!parsed) throw new Error('Unsupported URL. Use a GitHub repo URL, blob URL, or raw file URL.');

  const repoResp = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`);
  if (!repoResp.ok) throw new Error(`Could not inspect GitHub repo: ${repoResp.status}`);
  const repoMeta = await repoResp.json();
  const branch = parsed.branch || repoMeta.default_branch || 'main';

  const treeResp = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!treeResp.ok) throw new Error(`Could not list repo files: ${treeResp.status}`);
  const treeData = await treeResp.json();
  const tree = Array.isArray(treeData.tree) ? treeData.tree : [];
  const basePath = parsed.path ? parsed.path.replace(/\/$/, '') : '';
  const filtered = tree.filter((entry: any) => entry.type === 'blob' && (!basePath || String(entry.path || '').startsWith(basePath)));

  const scoreFile = (filePath: string) => {
    const path = filePath.toLowerCase();
    if (path.endsWith('skill.json')) return 100;
    if (path.includes('openclaw') && path.endsWith('.json')) return 95;
    if (path.includes('hermes') && path.endsWith('.json')) return 95;
    if (path.includes('.claude/commands/') && path.endsWith('.md')) return 90;
    if ((path.includes('/skills/') || path.includes('/prompts/') || path.includes('/agents/')) && path.endsWith('.md')) return 85;
    if (/(agents|claude|hermes|openclaw)\.md$/i.test(path)) return 80;
    if (path.endsWith('.json')) return 40;
    if (path.endsWith('.md')) return 20;
    return 0;
  };

  const candidates = filtered
    .map((entry: any) => ({ ...entry, score: scoreFile(String(entry.path || '')) }))
    .filter((entry: any) => entry.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 12);

  if (candidates.length === 0) {
    throw new Error('No recognizable skill files found in that repository.');
  }

  const installed: any[] = [];
  for (const candidate of candidates) {
    const rawUrl = toRawGitHubUrl(parsed.owner, parsed.repo, branch, candidate.path);
    const r = await fetch(rawUrl);
    if (!r.ok) continue;
    const text = await r.text();
    try {
      const json = JSON.parse(text);
      const records = Array.isArray(json) ? json : Array.isArray(json.skills) ? json.skills : [json];
      for (const [index, record] of records.entries()) {
        const normalized = normalizeSkillRecord(record, rawUrl, `${candidate.path.split('/').pop() || 'skill'} ${index + 1}`);
        if (normalized.system_prompt || normalized.steps.length > 0) installed.push(normalized);
      }
    } catch {
      const parsedSkill = parseMarkdownSkill(text, rawUrl, candidate.path);
      if (parsedSkill.system_prompt || parsedSkill.steps.length > 0) installed.push(parsedSkill);
    }
  }

  if (installed.length === 0) throw new Error('No importable skills found in that repository.');
  return installed;
}

async function insertSkills(supabase: any, skillRecords: any[]) {
  const inserted = [];
  for (const record of skillRecords) {
    const slugBase = slugify(record.slug || record.name);
    let slug = slugBase;
    let n = 1;
    while (true) {
      const { data: existing } = await supabase.from('agent_skills').select('id').eq('slug', slug).maybeSingle();
      if (!existing) break;
      n += 1;
      slug = `${slugBase}-${n}`;
    }
    const { data, error } = await supabase.from('agent_skills').insert({
      name: record.name || 'Imported Skill',
      slug,
      description: record.description || '',
      source: 'github',
      source_url: record.source_url,
      triggers: Array.isArray(record.triggers) ? record.triggers : [],
      steps: Array.isArray(record.steps) ? record.steps : [],
      system_prompt: record.system_prompt || '',
      tags: Array.isArray(record.tags) ? record.tags : [],
    }).select().single();
    if (error) throw new Error(error.message);
    inserted.push(data);
  }
  return inserted;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json();

    if (body.action === 'install_github') {
      const { url } = body;
      if (!url) throw new Error('url is required');
      const imported = await fetchRepoSkills(url);
      const installed = await insertSkills(supabase, imported);

      return new Response(JSON.stringify({
        ok: true,
        skill: installed[0],
        skills: installed,
        count: installed.length,
      }), {
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
