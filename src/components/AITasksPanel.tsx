// Compact panel showing recent AI agent activity (post generation, research, image search)
// pulled from social_posts + pending_commands tables. Lives at the top of the Job Queue page.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sparkles, Search, Image as ImageIcon, ExternalLink, ChevronDown, ChevronUp, Cpu, Globe, FileText, Hash } from 'lucide-react';
import { useState } from 'react';
import { listSocialPosts, getSocialImageUrl, type SocialPost } from '@/lib/socialPosts';
import { Link } from 'react-router-dom';

interface PendingCommand {
  id: string;
  command: string;
  args: any;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

async function listRecentCommands(): Promise<PendingCommand[]> {
  const { data } = await (supabase as any)
    .from('pending_commands')
    .select('*')
    .in('command', ['research_search', 'image_search', 'open_browser', 'check_stats'])
    .order('created_at', { ascending: false })
    .limit(8);
  return (data || []) as PendingCommand[];
}

const COMMAND_ICONS: Record<string, any> = {
  research_search: Search,
  image_search: ImageIcon,
  open_browser: Globe,
  check_stats: Hash,
};
const COMMAND_LABELS: Record<string, string> = {
  research_search: 'Web research',
  image_search: 'Image search',
  open_browser: 'Browser task',
  check_stats: 'Stats check',
};

function statusColor(status: string): string {
  if (status === 'completed' || status === 'success') return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30';
  if (status === 'failed' || status === 'error') return 'bg-destructive/10 text-destructive border-destructive/30';
  if (status === 'processing' || status === 'pending' || status === 'draft') return 'bg-amber-500/15 text-amber-700 border-amber-500/30';
  return 'bg-secondary text-secondary-foreground';
}

function PostRow({ post }: { post: SocialPost }) {
  const [expanded, setExpanded] = useState(false);
  const imageUrl = getSocialImageUrl(post.image_path);
  const variantCount = Object.keys(post.platform_variants || {}).length;
  const sourceCount = (post.ai_sources || []).length;
  const isAI = !!post.ai_prompt;

  return (
    <Card className="border bg-card/60">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-3">
          {imageUrl && (
            <img src={imageUrl} alt="" className="w-12 h-12 rounded-md object-cover border shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <Badge variant="outline" className="gap-1 text-[10px] h-5">
                {isAI ? <Sparkles className="w-2.5 h-2.5 text-primary" /> : <FileText className="w-2.5 h-2.5" />}
                {isAI ? 'AI Post' : 'Manual Post'}
              </Badge>
              <Badge variant="outline" className={`text-[10px] h-5 ${statusColor(post.status)}`}>
                {post.status}
              </Badge>
              {post.target_platforms.map((p) => (
                <Badge key={p} variant="secondary" className="text-[10px] h-5 capitalize">{p}</Badge>
              ))}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {new Date(post.created_at).toLocaleString()}
              </span>
            </div>
            {post.ai_prompt && (
              <p className="text-xs text-muted-foreground italic line-clamp-1">"{post.ai_prompt}"</p>
            )}
            <p className="text-xs line-clamp-2 mt-1">{post.description}</p>
            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
              {variantCount > 0 && <span>📝 {variantCount} variant{variantCount === 1 ? '' : 's'}</span>}
              {sourceCount > 0 && <span>🔗 {sourceCount} source{sourceCount === 1 ? '' : 's'}</span>}
              {post.hashtags.length > 0 && <span>#️⃣ {post.hashtags.length} tags</span>}
            </div>
          </div>
          <Button
            variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </Button>
        </div>
        {expanded && (
          <div className="border-t pt-2 space-y-1.5 text-[11px]">
            {post.ai_prompt && (
              <div><span className="font-medium text-muted-foreground">Prompt:</span> {post.ai_prompt}</div>
            )}
            {variantCount > 0 && (
              <div className="space-y-1">
                <div className="font-medium text-muted-foreground">Variants:</div>
                {Object.entries(post.platform_variants).map(([p, v]: [string, any]) => (
                  <div key={p} className="rounded bg-muted/40 px-2 py-1">
                    <span className="capitalize font-medium">{p}:</span>{' '}
                    <span className="text-muted-foreground">{v.description?.slice(0, 120)}…</span>
                  </div>
                ))}
              </div>
            )}
            {sourceCount > 0 && (
              <div>
                <span className="font-medium text-muted-foreground">Sources:</span>
                <div className="space-y-0.5 mt-1">
                  {(post.ai_sources || []).slice(0, 5).map((s: any, i: number) => (
                    <a key={i} href={s.url} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-primary hover:underline truncate">
                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">{s.title || s.url}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
            {post.platform_results.length > 0 && (
              <div className="space-y-0.5">
                <div className="font-medium text-muted-foreground">Results:</div>
                {post.platform_results.map((r) => (
                  <div key={r.name} className="text-[11px] capitalize">
                    {r.name}: <span className={r.status === 'success' ? 'text-emerald-600' : r.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                      {r.status}{r.url ? ` — ${r.url}` : ''}{r.error ? ` — ${r.error}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CommandRow({ cmd }: { cmd: PendingCommand }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = COMMAND_ICONS[cmd.command] || Cpu;
  const label = COMMAND_LABELS[cmd.command] || cmd.command;
  let resultPreview = '';
  let resultCount = 0;
  try {
    if (cmd.result) {
      const parsed = JSON.parse(cmd.result);
      if (Array.isArray(parsed?.results)) resultCount = parsed.results.length;
      resultPreview = parsed?.results?.[0]?.title || cmd.result.slice(0, 80);
    }
  } catch { resultPreview = cmd.result?.slice(0, 80) || ''; }

  return (
    <Card className="border bg-card/60">
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <span className="text-xs font-medium">{label}</span>
              <Badge variant="outline" className={`text-[10px] h-5 ${statusColor(cmd.status)}`}>
                {cmd.status}
              </Badge>
              {resultCount > 0 && (
                <Badge variant="secondary" className="text-[10px] h-5">{resultCount} results</Badge>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {new Date(cmd.created_at).toLocaleString()}
              </span>
            </div>
            {cmd.args?.query && (
              <p className="text-xs text-muted-foreground line-clamp-1">"{cmd.args.query}"</p>
            )}
            {resultPreview && cmd.status === 'completed' && (
              <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">→ {resultPreview}</p>
            )}
          </div>
          <Button
            variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </Button>
        </div>
        {expanded && cmd.result && (
          <pre className="mt-2 border-t pt-2 text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-words">
            {(() => { try { return JSON.stringify(JSON.parse(cmd.result), null, 2); } catch { return cmd.result; } })()}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

export default function AITasksPanel() {
  const [showAll, setShowAll] = useState(false);
  const { data: posts = [] } = useQuery({
    queryKey: ['social_posts'], queryFn: listSocialPosts, refetchInterval: 5000,
  });
  const { data: commands = [] } = useQuery({
    queryKey: ['pending_commands_recent'], queryFn: listRecentCommands, refetchInterval: 5000,
  });

  const recentPosts = posts.slice(0, showAll ? posts.length : 4);
  const recentCommands = commands.slice(0, showAll ? commands.length : 4);
  const total = posts.length + commands.length;

  if (total === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-primary" /> AI Agent Tasks ({total})
        </h2>
        <div className="flex items-center gap-2">
          <Link to="/social">
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
              Open Social Posts <ExternalLink className="w-3 h-3" />
            </Button>
          </Link>
          {total > 8 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs"
              onClick={() => setShowAll((s) => !s)}>
              {showAll ? 'Show less' : `Show all (${total})`}
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {recentPosts.map((p) => <PostRow key={p.id} post={p} />)}
        {recentCommands.map((c) => <CommandRow key={c.id} cmd={c} />)}
      </div>
    </div>
  );
}
