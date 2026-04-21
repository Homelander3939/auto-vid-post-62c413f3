import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Loader2, CheckCircle2, XCircle, Brain, Search, Image as ImageIcon,
  FileText, Terminal, Globe, Eye, ListChecks, Sparkles, X,
} from 'lucide-react';

interface AgentEvent {
  type: string;
  ts?: number;
  steps?: string[];
  text?: string;
  name?: string;
  label?: string;
  ok?: boolean;
  summary?: string;
  data?: any;
  message?: string;
  artifacts?: { kind: string; label: string; value: string }[];
}

interface AgentRun {
  id: string;
  prompt: string;
  status: string;
  events: AgentEvent[];
  result?: { summary: string; artifacts?: any[] } | null;
  error?: string | null;
}

const TOOL_ICON: Record<string, any> = {
  plan: ListChecks,
  research_deep: Search,
  generate_image: ImageIcon,
  write_file: FileText,
  read_file: FileText,
  list_files: FileText,
  run_shell: Terminal,
  open_in_browser: Globe,
  serve_preview: Eye,
  finish: Sparkles,
};

export default function AgentRunPanel({ runId }: { runId: string }) {
  const [run, setRun] = useState<AgentRun | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await supabase.from('agent_runs').select('*').eq('id', runId).single();
      if (active && data) setRun(data as any);
    };
    load();
    const channel = supabase
      .channel(`agent_run_${runId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'agent_runs', filter: `id=eq.${runId}` },
        (payload) => { if (active) setRun(payload.new as any); })
      .subscribe();
    const interval = setInterval(load, 4000);
    return () => { active = false; clearInterval(interval); supabase.removeChannel(channel); };
  }, [runId]);

  if (!run) {
    return (
      <Card className="p-3 bg-secondary/30 border-dashed">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Starting agent…
        </div>
      </Card>
    );
  }

  const events = Array.isArray(run.events) ? run.events : [];
  const planEvent = [...events].reverse().find((e) => e.type === 'plan');
  const plan = planEvent?.steps || [];
  const finishEvent = events.find((e) => e.type === 'finish');
  const isRunning = run.status === 'running';

  // Match each plan step to whether any tool_result has fired since the plan
  const planEventIdx = events.findIndex((e) => e === planEvent);
  const completedToolCount = events.slice(planEventIdx + 1).filter((e) => e.type === 'tool_result' && e.name !== 'plan' && e.name !== 'finish').length;

  const cancel = async () => {
    await supabase.functions.invoke('agent-run', { body: { action: 'cancel', runId } });
  };

  return (
    <Card className="overflow-hidden border bg-gradient-to-br from-primary/5 to-secondary/30">
      <div className="px-3 py-2 border-b bg-background/50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-md bg-primary/15 flex items-center justify-center shrink-0">
            <Brain className="w-3.5 h-3.5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-medium truncate">Agent Run</div>
            <div className="text-[10px] text-muted-foreground truncate">{run.prompt}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isRunning ? (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <Loader2 className="w-3 h-3 animate-spin" /> Working
            </Badge>
          ) : run.status === 'completed' ? (
            <Badge variant="secondary" className="gap-1 text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-3 h-3" /> Done
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1 text-[10px]">
              <XCircle className="w-3 h-3" /> {run.status}
            </Badge>
          )}
          {isRunning && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={cancel}>
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {plan.length > 0 && (
        <div className="px-3 py-2.5 border-b bg-background/30">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
            <ListChecks className="w-3 h-3" /> Plan
          </div>
          <ol className="space-y-1">
            {plan.map((s: string, i: number) => {
              const done = i < completedToolCount;
              const active = i === completedToolCount && isRunning;
              return (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className={`mt-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium shrink-0 ${
                    done ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                    : active ? 'bg-primary/20 text-primary'
                    : 'bg-muted text-muted-foreground'
                  }`}>
                    {done ? '✓' : i + 1}
                  </span>
                  <span className={done ? 'text-muted-foreground line-through' : active ? 'text-foreground font-medium' : 'text-foreground/80'}>{s}</span>
                  {active && <Loader2 className="w-3 h-3 animate-spin text-primary mt-0.5" />}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div className="px-3 py-2 max-h-72 overflow-y-auto space-y-1.5">
        {events.filter((e) => ['tool_call', 'tool_result', 'thought', 'error'].includes(e.type)).slice(-20).map((e, i) => {
          if (e.type === 'thought') {
            return (
              <div key={i} className="text-[11px] text-muted-foreground italic px-1.5 py-1 border-l-2 border-muted ml-1">
                💭 {e.text}
              </div>
            );
          }
          if (e.type === 'error') {
            return <div key={i} className="text-[11px] text-destructive">⚠️ {e.message}</div>;
          }
          if (e.type === 'tool_call') {
            const Icon = TOOL_ICON[e.name || ''] || Terminal;
            return (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <Icon className="w-3 h-3 text-primary shrink-0" />
                <span className="font-mono text-foreground/80">{e.name}</span>
                {e.label && <span className="text-muted-foreground truncate">→ {e.label}</span>}
                <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
              </div>
            );
          }
          if (e.type === 'tool_result') {
            return (
              <div key={i} className="flex items-start gap-2 text-[11px] -mt-1.5 ml-5">
                {e.ok ? <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0 mt-0.5" /> : <XCircle className="w-3 h-3 text-destructive shrink-0 mt-0.5" />}
                <span className="text-muted-foreground">{e.summary}</span>
                {e.data?.url && e.name === 'generate_image' && (
                  <img src={e.data.url} alt="" className="ml-auto w-12 h-12 rounded object-cover border" />
                )}
              </div>
            );
          }
          return null;
        })}
        {events.length === 1 && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      {finishEvent && (
        <div className="px-3 py-2.5 border-t bg-emerald-500/5">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1 flex items-center gap-1">
            <Sparkles className="w-3 h-3" /> Result
          </div>
          <p className="text-xs text-foreground mb-2">{finishEvent.summary}</p>
          {(finishEvent.artifacts || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(finishEvent.artifacts || []).map((a, i) => (
                a.kind === 'url' || a.kind === 'preview' ? (
                  <a key={i} href={a.value} target="_blank" rel="noopener noreferrer">
                    <Badge variant="outline" className="gap-1 text-[10px] hover:bg-primary/10 cursor-pointer">
                      <Globe className="w-2.5 h-2.5" /> {a.label}
                    </Badge>
                  </a>
                ) : a.kind === 'image' ? (
                  <a key={i} href={a.value} target="_blank" rel="noopener noreferrer">
                    <img src={a.value} alt={a.label} className="w-16 h-16 rounded object-cover border" />
                  </a>
                ) : (
                  <Badge key={i} variant="outline" className="gap-1 text-[10px]">
                    <FileText className="w-2.5 h-2.5" /> {a.label}
                  </Badge>
                )
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
