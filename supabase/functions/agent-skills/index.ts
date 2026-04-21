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

const SKILL_SCORE = {
  skillJson: 100,
  frameworkManifest: 95,
  claudeCommand: 90,
  structuredAgentPrompt: 88,
  markdownSkillFolder: 85,
  structuredSkillFolder: 84,
  explicitPromptFile: 83,
  namedMarkdownAgent: 80,
  namedStructuredAgent: 79,
  genericJson: 40,
  genericStructured: 30,
  genericMarkdown: 20,
} as const;

const IMPORTABLE_TEXT_FILE_RE = /\.(json|md|txt|yaml|yml|toml|prompt|skill|agent|instructions)$/i;
// Cap branch/path split attempts for GitHub tree/blob URLs so deeply nested paths
// do not fan out into excessive API calls while still covering common slashy branch names.
const MAX_MODE_PATH_CANDIDATES = 6;

type SkillRecord = {
  name: string;
  description: string;
  triggers: string[];
  steps: Array<{ note?: string; tool?: string; [key: string]: unknown }>;
  system_prompt: string;
  tags: string[];
  source_url: string;
  slug?: string;
};

function slugify(s: string): string {
  return (s || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

function parseGitHubRepo(url: string): { owner: string; repo: string; branch?: string; path?: string; mode?: 'tree' | 'blob'; refSegments?: string[] } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!['github.com', 'www.github.com'].includes(parsed.hostname)) return null;
  const segments = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = (segments[1] || '').replace(/\.git$/, '');
  if (!owner || !repo) return null;

  const mode = segments[2] === 'tree' || segments[2] === 'blob' ? segments[2] : undefined;
  const remainder = mode ? segments.slice(3) : [];

  return {
    owner,
    repo,
    branch: remainder[0],
    path: remainder.slice(1).join('/'),
    mode,
    refSegments: remainder,
  };
}

function isRawGitHubContentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'raw.githubusercontent.com';
  } catch {
    return false;
  }
}

function isDirectImportUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (['github.com', 'www.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)) return false;
    return IMPORTABLE_TEXT_FILE_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

function toRawGitHubUrl(owner: string, repo: string, branch: string, filePath: string) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.replace(/^\/+/, '')}`;
}

function scoreSkillPath(filePath: string) {
  const normalizedPath = filePath.toLowerCase();
  // Higher scores mean "more likely to be an explicit reusable skill definition".
  // This prioritizes canonical manifests first, then known framework layouts, then generic prompts.
  if (normalizedPath.endsWith('skill.json')) return SKILL_SCORE.skillJson;
  if (pathContainsFrameworkName(normalizedPath, 'openclaw') && /\.(json|yaml|yml|md)$/i.test(normalizedPath)) return SKILL_SCORE.frameworkManifest;
  if (pathContainsFrameworkName(normalizedPath, 'hermes') && /\.(json|yaml|yml|md)$/i.test(normalizedPath)) return SKILL_SCORE.frameworkManifest;
  if (normalizedPath.includes('.claude/commands/') && normalizedPath.endsWith('.md')) return SKILL_SCORE.claudeCommand;
  if ((normalizedPath.includes('/commands/') || normalizedPath.includes('/agents/') || normalizedPath.includes('/recipes/')) && /\.(yaml|yml|md)$/i.test(normalizedPath)) return SKILL_SCORE.structuredAgentPrompt;
  if ((normalizedPath.includes('/skills/') || normalizedPath.includes('/prompts/') || normalizedPath.includes('/agents/')) && normalizedPath.endsWith('.md')) return SKILL_SCORE.markdownSkillFolder;
  if ((normalizedPath.includes('/skills/') || normalizedPath.includes('/prompts/') || normalizedPath.includes('/agents/')) && /\.(yaml|yml|toml)$/i.test(normalizedPath)) return SKILL_SCORE.structuredSkillFolder;
  if (/(\.prompt|\.skill|\.agent)\.(md|yaml|yml|toml)$/i.test(normalizedPath)) return SKILL_SCORE.explicitPromptFile;
  if (/\.(prompt|skill|agent|instructions)$/i.test(normalizedPath)) return SKILL_SCORE.explicitPromptFile;
  if (/(agents|claude|hermes|openclaw)\.md$/i.test(normalizedPath)) return SKILL_SCORE.namedMarkdownAgent;
  if (/(agents|claude|hermes|openclaw)\.(yaml|yml|toml)$/i.test(normalizedPath)) return SKILL_SCORE.namedStructuredAgent;
  if (normalizedPath.endsWith('.json')) return SKILL_SCORE.genericJson;
  if (/\.(yaml|yml|toml)$/i.test(normalizedPath)) return SKILL_SCORE.genericStructured;
  if (normalizedPath.endsWith('.md')) return SKILL_SCORE.genericMarkdown;
  return 0;
}

function splitListLike(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(/[,\n]/)
    .map((item) => item.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function inferSkillTags(filePath: string, text: string): string[] {
  const haystack = `${filePath}\n${text}`.toLowerCase();
  const tags = new Set<string>(['github-import']);
  if (haystack.includes('openclaw')) tags.add('openclaw');
  if (haystack.includes('hermes')) tags.add('hermes');
  if (haystack.includes('claude')) tags.add('claude-style');
  if (haystack.includes('browser')) tags.add('browser');
  if (haystack.includes('research')) tags.add('research');
  if (haystack.includes('coding')) tags.add('coding');
  return [...tags];
}

function pathContainsFrameworkName(filePath: string, framework: string): boolean {
  const lower = filePath.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  const baseName = segments[segments.length - 1] || '';
  return segments.some((segment) => segment === framework || segment.startsWith(`${framework}.`) || segment.startsWith(`${framework}-`))
    || baseName === framework
    || baseName.startsWith(`${framework}.`)
    || baseName.startsWith(`${framework}-`);
}

function inferTriggersFromPath(filePath: string, name: string): string[] {
  const fileName = filePath.split('/').pop() || '';
  const stem = fileName.replace(/\.(json|md|txt|yaml|yml|toml)$/i, '');
  return [name, stem, stem.replace(/[-_]+/g, ' ')]
    .map((item) => item.trim())
    .filter((item, index, arr) => item.length > 2 && arr.indexOf(item) === index);
}

function extractMarkdownSection(text: string, heading: string): string {
  const lines = String(text || '').split('\n');
  const wanted = heading.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##?\s+(.+)$/);
    if (match && match[1].trim().toLowerCase() === wanted) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##?\s+/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

function parseLooseKeyValueText(text: string): Record<string, string | string[]> {
  const parsed: Record<string, string | string[]> = {};
  let activeKey = '';
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trimEnd();
    const topLevel = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (topLevel) {
      activeKey = topLevel[1].toLowerCase();
      parsed[activeKey] = topLevel[2].trim();
      continue;
    }
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && activeKey) {
      const existing = parsed[activeKey];
      parsed[activeKey] = Array.isArray(existing)
        ? [...existing, listItem[1].trim()]
        : [String(existing || '').trim()].filter(Boolean).concat(listItem[1].trim());
    }
  }
  return parsed;
}

function parseMarkdownSkill(raw: string, sourceUrl: string, filePath: string): SkillRecord {
  let text = String(raw || '');
  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter: Record<string, string | string[]> = {};
  if (frontmatterMatch) {
    Object.assign(frontmatter, parseLooseKeyValueText(frontmatterMatch[1]));
    text = text.slice(frontmatterMatch[0].length);
  }

  const headingMatch = text.match(/^#\s+(.+)$/m);
  const fileName = filePath.split('/').pop() || 'Imported Skill';
  const derivedName = fileName.replace(/\.(md|txt)$/i, '');
  const headingName = headingMatch?.[1]?.trim();
  const name = String(frontmatter.name || headingName || derivedName || 'Imported Skill').trim();
  const firstPlainParagraph = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('*') && !/^\d+\./.test(line));
  const sectionDescription = extractMarkdownSection(text, 'Description');
  const description = String(frontmatter.description || sectionDescription || firstPlainParagraph || '').trim();
  const stepSource = extractMarkdownSection(text, 'Steps') || extractMarkdownSection(text, 'Workflow') || text;
  const steps = stepSource.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line) && !/^(triggers?|tags?|description):/i.test(line))
    .slice(0, 12)
    .map((line) => ({ note: line.replace(/^([-*]|\d+\.)\s+/, '').trim() }));
  const tags = new Set<string>([
    ...splitListLike(frontmatter.tags),
    ...inferSkillTags(filePath, text),
  ]);
  const systemPrompt = extractMarkdownSection(text, 'System Prompt')
    || extractMarkdownSection(text, 'Instructions')
    || extractMarkdownSection(text, 'Prompt')
    || text.trim();
  const triggerSection = extractMarkdownSection(text, 'Triggers') || extractMarkdownSection(text, 'Keywords');

  return {
    name,
    description,
    triggers: [
      ...splitListLike(frontmatter.triggers || frontmatter.keywords || triggerSection),
      ...inferTriggersFromPath(filePath, name),
    ].filter((item, index, arr) => arr.indexOf(item) === index),
    steps,
    system_prompt: systemPrompt,
    tags: [...tags],
    source_url: sourceUrl,
  };
}

function normalizeSkillRecord(raw: any, sourceUrl: string, fallbackName: string): SkillRecord {
  const metadata = raw.metadata || raw.meta || {};
  const promptMessages = Array.isArray(raw.messages)
    ? raw.messages.map((msg: any) => msg?.content || msg?.text || '').filter(Boolean).join('\n\n')
    : '';
  const systemPromptBlocks = [raw.system_prompt, raw.systemPrompt, raw.prompt, raw.instructions, raw.content, raw.template, raw.prompt_template, metadata.prompt, promptMessages]
    .filter(Boolean)
    .map((value) => typeof value === 'string' ? value : JSON.stringify(value));
  const name = raw.name || raw.title || raw.slug || metadata.name || fallbackName;
  const description = raw.description || raw.summary || raw.purpose || metadata.description || '';
  const systemPrompt = systemPromptBlocks.join('\n\n').trim();
  const triggers = Array.isArray(raw.triggers) ? raw.triggers
    : Array.isArray(raw.keywords) ? raw.keywords
      : Array.isArray(metadata.triggers) ? metadata.triggers
        : typeof raw.triggers === 'string' ? raw.triggers.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
  const tags = new Set<string>([
    ...splitListLike(raw.tags),
    ...splitListLike(metadata.tags),
    ...inferSkillTags(sourceUrl, JSON.stringify(raw)),
  ]);
  if (raw.agent) tags.add(String(raw.agent));
  if (raw.framework) tags.add(String(raw.framework));
  if (metadata.framework) tags.add(String(metadata.framework));

  let steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (steps.length === 0 && Array.isArray(raw.workflow)) {
    steps = raw.workflow.map((step: any) => ({ note: typeof step === 'string' ? step : step.note || step.description || JSON.stringify(step) }));
  }
  if (steps.length === 0 && Array.isArray(raw.actions)) {
    steps = raw.actions.map((step: any) => ({ note: typeof step === 'string' ? step : step.note || step.description || JSON.stringify(step) }));
  }
  if (steps.length === 0 && Array.isArray(raw.commands)) {
    steps = raw.commands.map((step: any) => ({ note: typeof step === 'string' ? step : step.note || step.command || step.description || JSON.stringify(step) }));
  }
  if (steps.length === 0 && Array.isArray(raw.tasks)) {
    steps = raw.tasks.map((step: any) => ({ note: typeof step === 'string' ? step : step.note || step.task || step.description || JSON.stringify(step) }));
  }

  return {
    name,
    description,
    triggers: [...triggers, ...inferTriggersFromPath(sourceUrl, String(name))].filter((item, index, arr) => arr.indexOf(item) === index),
    steps,
    system_prompt: systemPrompt,
    tags: [...tags],
    source_url: sourceUrl,
  };
}

function parseStructuredSkillFile(raw: string, sourceUrl: string, filePath: string): SkillRecord {
  const parsed = parseLooseKeyValueText(raw);
  const name = String(parsed.name || parsed.title || filePath.split('/').pop()?.replace(/\.(yaml|yml|toml)$/i, '') || 'Imported Skill');
  const description = String(parsed.description || parsed.summary || parsed.purpose || '').trim();
  const prompt = String(parsed.system_prompt || parsed.prompt || parsed.instructions || parsed.template || raw).trim();
  const steps = splitListLike(parsed.steps || parsed.workflow || parsed.tasks || parsed.commands)
    .slice(0, 12)
    .map((note) => ({ note }));
  const triggers = [
    ...splitListLike(parsed.triggers || parsed.keywords),
    ...inferTriggersFromPath(filePath, name),
  ].filter((item, index, arr) => arr.indexOf(item) === index);
  const tags = [...new Set([...splitListLike(parsed.tags), ...inferSkillTags(filePath, raw)])];
  return {
    name,
    description,
    triggers,
    steps,
    system_prompt: prompt,
    tags,
    source_url: sourceUrl,
  };
}

function parseSkillTextFile(text: string, sourceUrl: string, filePath: string): SkillRecord[] {
  try {
    const json = JSON.parse(text);
    const baseName = slugify(filePath.split('/').pop() || 'skill') || 'skill';
    const records = Array.isArray(json)
      ? json
      : Array.isArray(json.skills) ? json.skills
        : Array.isArray(json.agents) ? json.agents
          : Array.isArray(json.commands) ? json.commands
            : [json];
    return records.map((record, index) => normalizeSkillRecord(record, sourceUrl, `${baseName}-${index + 1}`));
  } catch {
    return [/\.(yaml|yml|toml)$/i.test(filePath)
      ? parseStructuredSkillFile(text, sourceUrl, filePath)
      : parseMarkdownSkill(text, sourceUrl, filePath)];
  }
}

async function tryFetchRawSkillFile(owner: string, repo: string, branch: string, filePath: string): Promise<SkillRecord[]> {
  const rawUrl = toRawGitHubUrl(owner, repo, branch, filePath);
  const resp = await fetch(rawUrl);
  if (!resp.ok) return [];
  const text = await resp.text();
  return parseSkillTextFile(text, rawUrl, filePath)
    .filter((record) => record.system_prompt || record.steps.length > 0);
}

async function tryFetchSkillCandidates(owner: string, repo: string, branches: string[], filePaths: string[]): Promise<SkillRecord[]> {
  const seen = new Set<string>();
  for (const branch of branches) {
    for (const filePath of filePaths) {
      const normalized = filePath.replace(/^\/+/, '');
      const key = `${branch}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const imported = await tryFetchRawSkillFile(owner, repo, branch, normalized);
      if (imported.length > 0) return imported;
    }
  }
  return [];
}

function buildProbableRepoPaths(basePath: string): string[] {
  const normalizedBase = basePath.replace(/^\/+|\/+$/g, '');
  if (!normalizedBase) return [];
  const leaf = normalizedBase.split('/').filter(Boolean).pop() || 'skill';
  return [
    normalizedBase,
    `${normalizedBase}/skill.json`,
    `${normalizedBase}/README.md`,
    `${normalizedBase}/readme.md`,
    `${normalizedBase}/index.md`,
    `${normalizedBase}/prompt.md`,
    `${normalizedBase}/agent.md`,
    `${normalizedBase}/agent.yaml`,
    `${normalizedBase}/agent.yml`,
    `${normalizedBase}/agent.toml`,
    `${normalizedBase}/claude.md`,
    `${normalizedBase}/hermes.md`,
    `${normalizedBase}/openclaw.md`,
    `${normalizedBase}/${leaf}.json`,
    `${normalizedBase}/${leaf}.md`,
    `${normalizedBase}/${leaf}.yaml`,
    `${normalizedBase}/${leaf}.yml`,
    `${normalizedBase}/${leaf}.toml`,
  ].filter((value, index, arr) => arr.indexOf(value) === index && IMPORTABLE_TEXT_FILE_RE.test(value));
}

function buildModePathCandidates(parsed: { mode?: 'tree' | 'blob'; refSegments?: string[] }): Array<{ branch: string; path: string }> {
  const segments = Array.isArray(parsed.refSegments) ? parsed.refSegments.filter(Boolean) : [];
  if (!parsed.mode || segments.length < 2) return [];
  const candidates: Array<{ branch: string; path: string }> = [];
  // Start at 1 because we need at least one segment for the branch/ref name and one for the file path.
  for (let i = 1; i < segments.length && candidates.length < MAX_MODE_PATH_CANDIDATES; i += 1) {
    const branch = segments.slice(0, i).join('/');
    const path = segments.slice(i).join('/');
    if (branch && path) candidates.push({ branch, path });
  }
  return candidates;
}

function dedupeSkillRecords(skillRecords: SkillRecord[]): SkillRecord[] {
  const seen = new Set<string>();
  return skillRecords.filter((record) => {
    const key = JSON.stringify([record.source_url || '', record.name || '', record.system_prompt || '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseBundledSkillFiles(files: Array<{ path: string; content: string }>, sourceName: string): SkillRecord[] {
  const installed: SkillRecord[] = [];
  const candidates = files
    .filter((file) => typeof file?.path === 'string' && typeof file?.content === 'string')
    .map((file) => ({ ...file, score: scoreSkillPath(file.path) }))
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);

  for (const file of candidates) {
    const sourceUrl = `https://zip-import.local/${encodeURIComponent(sourceName)}/${file.path.replace(/^\/+/, '')}`;
    const parsed = parseSkillTextFile(file.content, sourceUrl, file.path)
      .filter((record) => record.system_prompt || record.steps.length > 0);
    installed.push(...parsed);
  }

  if (installed.length === 0) {
    throw new Error('No importable skills found in that ZIP file.');
  }

  return dedupeSkillRecords(installed);
}

async function fetchRepoSkills(url: string): Promise<SkillRecord[]> {
  if (isRawGitHubContentUrl(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not fetch ${url}: ${r.status}`);
    const text = await r.text();
    const imported = parseSkillTextFile(text, url, url.split('/').pop() || 'skill.md')
      .filter((record) => record.system_prompt || record.steps.length > 0);
    if (imported.length === 0) throw new Error('No importable skills found in that file.');
    return imported;
  }

  if (isDirectImportUrl(url)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not fetch ${url}: ${r.status}`);
    const text = await r.text();
    const imported = parseSkillTextFile(text, url, url.split('/').pop() || 'skill.txt')
      .filter((record) => record.system_prompt || record.steps.length > 0);
    if (imported.length === 0) throw new Error('No importable skills found in that file.');
    return imported;
  }

  const parsed = parseGitHubRepo(url);
  if (!parsed) throw new Error('Unsupported URL. Use a GitHub repo URL, blob URL, raw file URL, or direct remote skill file.');
  let defaultBranch = parsed.branch || 'main';
  try {
    const repoResp = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`);
    if (repoResp.ok) {
      const repoMeta = await repoResp.json();
      defaultBranch = parsed.branch || repoMeta.default_branch || defaultBranch;
    }
  } catch {
    // Best-effort only — raw.githubusercontent fallback below can still work.
  }

  const candidateBranches = [parsed.branch, defaultBranch, 'main', 'master']
    .filter((branch, index, arr): branch is string => !!branch && arr.indexOf(branch) === index);

  for (const candidate of buildModePathCandidates(parsed)) {
    const directFromMode = await tryFetchSkillCandidates(parsed.owner, parsed.repo, [candidate.branch, ...candidateBranches], [candidate.path]);
    if (directFromMode.length > 0) return directFromMode;
    const probableFromMode = await tryFetchSkillCandidates(parsed.owner, parsed.repo, [candidate.branch, ...candidateBranches], buildProbableRepoPaths(candidate.path));
    if (probableFromMode.length > 0) return probableFromMode;
  }

  if (parsed.path && IMPORTABLE_TEXT_FILE_RE.test(parsed.path)) {
    const direct = await tryFetchSkillCandidates(parsed.owner, parsed.repo, candidateBranches, [parsed.path]);
    if (direct.length > 0) return direct;
  }

  if (parsed.path) {
    const probable = await tryFetchSkillCandidates(parsed.owner, parsed.repo, candidateBranches, buildProbableRepoPaths(parsed.path));
    if (probable.length > 0) return probable;
  }

  let tree: any[] = [];
  try {
    const treeResp = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
    if (treeResp.ok) {
      const treeData = await treeResp.json();
      tree = Array.isArray(treeData.tree) ? treeData.tree : [];
    }
  } catch {
    // fall through to final error below
  }

  const basePath = parsed.path ? parsed.path.replace(/\/$/, '') : '';
  const filtered = tree.filter((entry: any) => entry.type === 'blob' && (!basePath || String(entry.path || '').startsWith(basePath)));
  const candidates = filtered
    .map((entry: any) => ({ ...entry, score: scoreSkillPath(String(entry.path || '')) }))
    .filter((entry: any) => entry.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 12);

  const installed: any[] = [];
  for (const candidate of candidates) {
    const imported = await tryFetchRawSkillFile(parsed.owner, parsed.repo, defaultBranch, candidate.path);
    installed.push(...imported);
  }

  if (installed.length > 0) return dedupeSkillRecords(installed);
  throw new Error('No importable skills found from that link. Try a direct raw file URL or upload a ZIP export instead.');
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

    if (body.action === 'install_bundle') {
      const { files, sourceName } = body;
      if (!Array.isArray(files) || files.length === 0) throw new Error('files are required');
      const imported = parseBundledSkillFiles(files, sourceName || 'skills.zip');
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
