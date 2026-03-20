import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSettings } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ExternalLink, Monitor, RefreshCw, Eye, Cloud, AlertCircle, Brain, Bot } from 'lucide-react';

type BrowserJob = any;
type RunningSession = { id: string; status?: string; startedAt?: string; createdAt?: string };
type AIStep = { step: number; action: string; reasoning: string; timestamp: string };

export default function BrowserSessions() {
  const [loading, setLoading] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [runningSessions, setRunningSessions] = useState<RunningSession[]>([]);
  const [debugUrls, setDebugUrls] = useState<Record<string, string>>({});
  const [showAILog, setShowAILog] = useState(true);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const isCloud = settings?.uploadMode === 'cloud';

  const { data: recentJobs, refetch: refetchJobs } = useQuery({
    queryKey: ['browser-sessions-jobs'],
    queryFn: async () => {
      const { data } = await supabase
        .from('upload_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(40);
      return (data || []) as BrowserJob[];
    },
    refetchInterval: 3000,
  });

  const fetchRunningSessions = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase.functions.invoke('cloud-browser-status', { body: {} });
      const sessions = Array.isArray(data?.sessions)
        ? data.sessions
        : Array.isArray(data?.sessions?.data)
          ? data.sessions.data
          : [];
      setRunningSessions(sessions);
      setDebugUrls(data?.debugUrls || {});

      if (!expandedSession && sessions.length > 0) {
        setExpandedSession(sessions[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch running sessions:', error);
      setRunningSessions([]);
      setDebugUrls({});
    } finally {
      setLoading(false);
    }
  }, [expandedSession]);

  useEffect(() => {
    if (!isCloud) return;
    fetchRunningSessions();
    const interval = setInterval(fetchRunningSessions, 8000);
    return () => clearInterval(interval);
  }, [isCloud, fetchRunningSessions]);

  const getBrowserbaseUrl = (sessionId: string) => `https://www.browserbase.com/sessions/${sessionId}`;

  const jobsBySession = new Map(
    (recentJobs || [])
      .filter((job: BrowserJob) => !!job.browserbase_session_id)
      .map((job: BrowserJob) => [job.browserbase_session_id, job]),
  );

  const completedJobs = (recentJobs || []).filter(
    (job: BrowserJob) => !!job.browserbase_session_id && ['completed', 'partial', 'error'].includes(job.status),
  );

  // Extract AI steps from a job
  const getAISteps = (job: BrowserJob): AIStep[] => {
    const results = Array.isArray(job?.platform_results) ? job.platform_results : [];
    const aiLog = results.find((r: any) => r.name === '_ai_log');
    return aiLog?.steps || [];
  };

  const actionIcon = (action: string) => {
    switch (action) {
      case 'click': return '👆';
      case 'type': return '⌨️';
      case 'navigate': return '🧭';
      case 'wait': return '⏳';
      case 'scroll': return '📜';
      case 'upload_file': return '📁';
      case 'need_verification': return '🔐';
      case 'done': return '✅';
      default: return '🔄';
    }
  };

  if (!isCloud) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Browser Sessions</h1>
          <p className="text-muted-foreground mt-1">Monitor live cloud browser automation</p>
        </div>

        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Cloud className="w-12 h-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium mb-2">Cloud Mode Required</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Switch to Cloud Mode from the sidebar to use Browserbase remote browser automation.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Browser Sessions</h1>
          <p className="text-muted-foreground mt-1 text-sm">AI-powered cloud browser automation</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showAILog ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowAILog(!showAILog)}
          >
            <Brain className="w-4 h-4 mr-1.5" />
            AI Log
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              fetchRunningSessions();
              refetchJobs();
            }}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {runningSessions.length > 0 ? (
        <div className="space-y-4">
          {runningSessions.map((session) => {
            const job = jobsBySession.get(session.id);
            const isOpen = expandedSession === session.id;
            const liveUrl = debugUrls[session.id];
            const aiSteps = job ? getAISteps(job) : [];

            return (
              <Card key={session.id}>
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="space-y-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {job?.title || job?.video_file_name || `Session ${session.id.slice(0, 8)}`}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary" className="gap-1">
                          <Bot className="w-3 h-3" />
                          AI Agent
                        </Badge>
                        <Badge variant="outline">running</Badge>
                        {job?.status && <Badge variant="outline">job: {job.status}</Badge>}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button variant={isOpen ? 'default' : 'outline'} size="sm" onClick={() => setExpandedSession(isOpen ? null : session.id)}>
                        <Eye className="w-4 h-4 mr-1.5" />
                        <span className="hidden sm:inline">{isOpen ? 'Hide Live' : 'Watch Live'}</span>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => window.open(getBrowserbaseUrl(session.id), '_blank')}>
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className={`grid gap-4 ${showAILog && aiSteps.length > 0 ? 'lg:grid-cols-[1fr_320px]' : ''}`}>
                      {/* Live browser stream */}
                      <div className="rounded-lg overflow-hidden border border-border bg-card">
                        {liveUrl ? (
                          <iframe
                            src={liveUrl}
                            title={`Live session ${session.id}`}
                            className="w-full"
                            style={{ height: 'min(620px, 60vh)' }}
                            allow="autoplay; clipboard-write"
                            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                          />
                        ) : (
                          <div className="py-10 text-center text-sm text-muted-foreground">
                            Loading live debug stream… click refresh if needed.
                          </div>
                        )}
                      </div>

                      {/* AI Decision Log */}
                      {showAILog && aiSteps.length > 0 && (
                        <Card className="border-dashed">
                          <CardHeader className="pb-2 pt-3 px-3">
                            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                              <Brain className="w-3.5 h-3.5" />
                              AI Reasoning
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="p-0">
                            <ScrollArea className="h-[min(540px,55vh)]">
                              <div className="px-3 pb-3 space-y-2">
                                {aiSteps.map((s, i) => (
                                  <div key={i} className="flex items-start gap-2 text-xs">
                                    <span className="shrink-0 mt-0.5">{actionIcon(s.action)}</span>
                                    <div className="min-w-0">
                                      <span className="font-medium text-foreground">{s.action}</span>
                                      <p className="text-muted-foreground leading-relaxed mt-0.5">{s.reasoning}</p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </ScrollArea>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Monitor className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              No active sessions. Start a cloud upload — the AI agent will drive the browser automatically.
            </p>
          </CardContent>
        </Card>
      )}

      {completedJobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recent Sessions</h2>
          <div className="space-y-2">
            {completedJobs.map((job: BrowserJob) => {
              const aiSteps = getAISteps(job);

              return (
                <Card key={job.id}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{job.title || job.video_file_name}</p>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-muted-foreground">
                          <Badge variant={job.status === 'error' ? 'destructive' : 'secondary'}>{job.status}</Badge>
                          {aiSteps.length > 0 && (
                            <Badge variant="outline" className="gap-1">
                              <Bot className="w-3 h-3" />
                              {aiSteps.length} steps
                            </Badge>
                          )}
                          {(job.platform_results as any[])?.filter((pr: any) => pr.name !== '_ai_log').map((pr: any, i: number) => (
                            <span key={i}>
                              {pr.name}: {pr.status === 'success' ? '✅' : pr.status === 'error' ? '❌' : '⏳'}
                              {pr.url && (
                                <a href={pr.url} target="_blank" rel="noopener" className="ml-1 text-primary hover:underline">
                                  link
                                </a>
                              )}
                            </span>
                          ))}
                          <span>{job.created_at && new Date(job.created_at).toLocaleString()}</span>
                        </div>
                      </div>

                      <Button variant="ghost" size="sm" onClick={() => window.open(getBrowserbaseUrl(job.browserbase_session_id), '_blank')}>
                        <ExternalLink className="w-4 h-4 mr-1.5" />
                        <span className="hidden sm:inline">Recording</span>
                      </Button>
                    </div>

                    {/* Expandable AI log for completed jobs */}
                    {showAILog && aiSteps.length > 0 && (
                      <ScrollArea className="max-h-40 border rounded-md p-2">
                        <div className="space-y-1">
                          {aiSteps.map((s, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs">
                              <span className="shrink-0">{actionIcon(s.action)}</span>
                              <span className="text-muted-foreground">
                                <span className="font-medium text-foreground">{s.action}</span> — {s.reasoning}
                              </span>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            About AI Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>The AI agent uses vision to understand each page and decides the next action — like a human would.</p>
          <p>It handles login, verification (via Telegram), file upload, metadata entry, and publishing automatically.</p>
          <p>Toggle "AI Log" to see step-by-step reasoning alongside the live browser stream.</p>
        </CardContent>
      </Card>
    </div>
  );
}
