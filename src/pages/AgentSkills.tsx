import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sparkles, Github, Play, Trash2, Plus, CheckCircle2, BookOpen, Loader2, Brain, Upload } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';

interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string;
  source: 'manual' | 'github' | 'learned';
  source_url?: string;
  triggers: string[];
  steps: any[];
  system_prompt: string;
  tags: string[];
  enabled: boolean;
  use_count: number;
  last_used_at?: string;
  created_at: string;
}

interface PendingRun {
  id: string;
  prompt: string;
  pending_skill: any;
  created_at: string;
}

interface AgentMemory {
  id: string;
  title: string;
  content: string;
  memory_type: string;
  tags: string[];
  enabled: boolean;
  use_count: number;
  created_at: string;
}

const IMPORTABLE_ZIP_ENTRY_RE = /\.(json|md|txt|yaml|yml|toml)$/i;

export default function AgentSkills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [pending, setPending] = useState<PendingRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', description: '', triggers: '', system_prompt: '', steps: '' });
  const zipInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    const [s, m, p] = await Promise.all([
      supabase.from('agent_skills').select('*').order('created_at', { ascending: false }),
      supabase.from('agent_memories').select('*').order('importance', { ascending: false }).order('created_at', { ascending: false }).limit(30),
      supabase.from('agent_runs').select('id,prompt,pending_skill,created_at').not('pending_skill', 'is', null).order('created_at', { ascending: false }).limit(20),
    ]);
    setSkills((s.data as any) || []);
    setMemories((m.data as any) || []);
    setPending((p.data as any) || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel('agent_skills_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_skills' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_memories' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_runs' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const installFromGithub = async () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    try {
      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'install_github', url: installUrl.trim() },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      const installedCount = Number(data?.count || (Array.isArray(data?.skills) ? data.skills.length : 0)) || 1;
      toast.success(installedCount > 1 ? `Installed ${installedCount} skills` : `Installed: ${data.skill.name}`);
      setInstallUrl('');
      load();
    } catch (e: any) {
      toast.error(`Install failed: ${e.message}`);
    } finally {
      setInstalling(false);
    }
  };

  const installFromZip = async (file: File) => {
    setInstalling(true);
    try {
      const zip = await JSZip.loadAsync(file);
      const importableEntries = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .filter((entry) => !entry.name.startsWith('__MACOSX/'))
        .filter((entry) => IMPORTABLE_ZIP_ENTRY_RE.test(entry.name))
        .slice(0, 40);

      if (importableEntries.length === 0) {
        throw new Error('No importable skill files found in that ZIP. Include JSON, Markdown, YAML, TOML, or TXT skill files.');
      }

      const files = await Promise.all(importableEntries.map(async (entry) => ({
        path: entry.name,
        content: await entry.async('string'),
      })));

      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'install_bundle', sourceName: file.name, files },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      const installedCount = Number(data?.count || (Array.isArray(data?.skills) ? data.skills.length : 0)) || 1;
      toast.success(installedCount > 1 ? `Installed ${installedCount} skills from ZIP` : `Installed: ${data.skill.name}`);
      load();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'ZIP install failed';
      toast.error(message);
    } finally {
      if (zipInputRef.current) zipInputRef.current.value = '';
      setInstalling(false);
    }
  };

  const acceptPending = async (runId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'accept_pending', runId },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      toast.success(`Skill saved: ${data.skill.name}`);
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const dismissPending = async (runId: string) => {
    await supabase.from('agent_runs').update({ pending_skill: null }).eq('id', runId);
    load();
  };

  const runSkill = async (id: string) => {
    setRunning(id);
    try {
      const { data, error } = await supabase.functions.invoke('agent-skills', {
        body: { action: 'run_skill', skillId: id },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      toast.success('Skill running — open AI Chat to watch live progress.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRunning(null);
    }
  };

  const toggleEnabled = async (id: string, enabled: boolean) => {
    await supabase.from('agent_skills').update({ enabled }).eq('id', id);
    load();
  };

  const toggleMemory = async (id: string, enabled: boolean) => {
    await supabase.from('agent_memories').update({ enabled }).eq('id', id);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this skill?')) return;
    await supabase.from('agent_skills').delete().eq('id', id);
    load();
  };

  const removeMemory = async (id: string) => {
    if (!confirm('Delete this memory?')) return;
    await supabase.from('agent_memories').delete().eq('id', id);
    load();
  };

  const createManual = async () => {
    if (!draft.name.trim()) return;
    let parsedSteps: any[] = [];
    try {
      parsedSteps = draft.steps.trim()
        ? draft.steps.split('\n').filter(Boolean).map((line) => ({ note: line.trim() }))
        : [];
    } catch { /* */ }
    const slug = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '-' + Date.now().toString(36);
    const { error } = await supabase.from('agent_skills').insert({
      name: draft.name,
      slug,
      description: draft.description,
      source: 'manual',
      triggers: draft.triggers.split(',').map((t) => t.trim()).filter(Boolean),
      system_prompt: draft.system_prompt,
      steps: parsedSteps,
    });
    if (error) { toast.error(error.message); return; }
    toast.success('Skill created');
    setCreateOpen(false);
    setDraft({ name: '', description: '', triggers: '', system_prompt: '', steps: '' });
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-primary" /> Agent Skills
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Reusable routines the agent can run. Install from GitHub, write your own, or let the agent propose them after it learns a workflow.
          </p>
        </div>
        <Button variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-1.5" /> New Skill
        </Button>
      </div>

      {/* Install from GitHub */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Github className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Install from GitHub</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Paste a repo URL or raw file URL. The importer now scans common skill layouts such as <code className="text-[10px] bg-secondary px-1 rounded">skill.json</code>, <code className="text-[10px] bg-secondary px-1 rounded">skills/</code>, <code className="text-[10px] bg-secondary px-1 rounded">agents/</code>, <code className="text-[10px] bg-secondary px-1 rounded">commands/</code>, and Claude/OpenClaw/Hermes prompt files.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Input
            placeholder="https://github.com/owner/repo  or  raw skill.json URL"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            disabled={installing}
          />
          <Button onClick={installFromGithub} disabled={installing || !installUrl.trim()}>
            {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Install'}
          </Button>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void installFromZip(file);
            }}
          />
          <Button variant="outline" onClick={() => zipInputRef.current?.click()} disabled={installing}>
            {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4 mr-1.5" />}
            Upload ZIP
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          If a GitHub link cannot be imported, upload a ZIP export and the app will scan the archive for skills automatically.
        </p>
      </Card>

      {/* Pending proposals from agent runs */}
      {pending.length > 0 && (
        <Card className="p-4 border-primary/30 bg-primary/5">
          <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-primary" /> Proposed by Agent ({pending.length})
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            The agent thinks these workflows are worth saving as reusable skills.
          </p>
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="border rounded-lg p-3 bg-background">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">{p.pending_skill?.name || 'Untitled'}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{p.pending_skill?.description}</div>
                    <div className="text-[10px] text-muted-foreground mt-1 italic">From: "{p.prompt.slice(0, 100)}"</div>
                    {p.pending_skill?.steps?.length > 0 && (
                      <ol className="text-xs text-muted-foreground mt-2 ml-4 list-decimal space-y-0.5">
                        {p.pending_skill.steps.slice(0, 5).map((s: any, i: number) => (
                          <li key={i}>{s.note || s.tool}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <Button size="sm" onClick={() => acceptPending(p.id)}>Approve</Button>
                    <Button size="sm" variant="ghost" onClick={() => dismissPending(p.id)}>Dismiss</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
          <Brain className="w-4 h-4 text-muted-foreground" /> Persistent Memory ({memories.length})
        </h2>
        {memories.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground border-dashed">
            No persistent memories yet. In multi-agent mode the agent can now save durable facts, workflow notes, and subtask context here.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {memories.map((memory) => (
              <Card key={memory.id} className="p-4 flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="font-medium text-sm min-w-0 truncate">{memory.title}</div>
                  <Badge variant="outline" className="text-[9px] shrink-0">{memory.memory_type}</Badge>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-3 mb-2">{memory.content}</p>
                {memory.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {memory.tags.slice(0, 5).map((tag, i) => (
                      <Badge key={i} variant="secondary" className="text-[9px]">{tag}</Badge>
                    ))}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground mb-3">
                  used {memory.use_count} times
                </div>
                <div className="mt-auto flex items-center gap-2">
                  <Switch checked={memory.enabled} onCheckedChange={(v) => toggleMemory(memory.id, v)} />
                  <Button size="icon" variant="ghost" onClick={() => removeMemory(memory.id)} className="ml-auto">
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Skills list */}
      <div>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-muted-foreground" /> My Skills ({skills.length})
        </h2>
        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
        ) : skills.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground border-dashed">
            No skills yet. Install one from GitHub above, create one manually, or let the agent propose one after a successful task.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {skills.map((sk) => (
              <Card key={sk.id} className="p-4 flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="font-medium text-sm flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{sk.name}</span>
                  </div>
                  <Badge variant="outline" className="text-[9px] shrink-0">{sk.source}</Badge>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{sk.description || 'No description'}</p>
                {sk.triggers.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {sk.triggers.slice(0, 4).map((t, i) => (
                      <Badge key={i} variant="secondary" className="text-[9px]">{t}</Badge>
                    ))}
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground mb-3">
                  {sk.steps.length} steps · used {sk.use_count} times
                </div>
                <div className="mt-auto flex items-center gap-2">
                  <Button size="sm" className="flex-1" onClick={() => runSkill(sk.id)} disabled={running === sk.id || !sk.enabled}>
                    {running === sk.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Play className="w-3.5 h-3.5 mr-1" /> Run</>}
                  </Button>
                  <Switch checked={sk.enabled} onCheckedChange={(v) => toggleEnabled(sk.id, v)} />
                  <Button size="icon" variant="ghost" onClick={() => remove(sk.id)}>
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Manual create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>New Skill</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">Name</label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Daily LinkedIn digest" />
            </div>
            <div>
              <label className="text-xs font-medium">Description</label>
              <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} />
            </div>
            <div>
              <label className="text-xs font-medium">Trigger phrases (comma-separated)</label>
              <Input value={draft.triggers} onChange={(e) => setDraft({ ...draft, triggers: e.target.value })} placeholder="linkedin digest, daily summary" />
            </div>
            <div>
              <label className="text-xs font-medium">System instructions</label>
              <Textarea value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} rows={3} placeholder="Extra context for the agent when running this skill." />
            </div>
            <div>
              <label className="text-xs font-medium">Steps (one per line)</label>
              <Textarea value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} rows={4} placeholder="Research today's top AI news&#10;Generate a hero image&#10;Compose a LinkedIn post" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createManual} disabled={!draft.name.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
