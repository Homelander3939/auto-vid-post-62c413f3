import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSettings } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, Monitor, RefreshCw, Eye, Cloud, AlertCircle } from 'lucide-react';

type BrowserJob = any;
type RunningSession = { id: string; status?: string; startedAt?: string; createdAt?: string };

export default function BrowserSessions() {
  const [loading, setLoading] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [runningSessions, setRunningSessions] = useState<RunningSession[]>([]);
  const [debugUrls, setDebugUrls] = useState<Record<string, string>>({});

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Browser Sessions</h1>
          <p className="text-muted-foreground mt-1">Monitor live cloud browser automation</p>
        </div>
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

      {runningSessions.length > 0 ? (
        <div className="space-y-4">
          {runningSessions.map((session) => {
            const job = jobsBySession.get(session.id);
            const isOpen = expandedSession === session.id;
            const liveUrl = debugUrls[session.id];

            return (
              <Card key={session.id}>
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <p className="font-medium text-sm">
                        {job?.title || job?.video_file_name || `Session ${session.id.slice(0, 8)}`}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary">running</Badge>
                        {job?.status && <Badge variant="outline">job: {job.status}</Badge>}
                        <span className="text-xs text-muted-foreground font-mono">{session.id}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button variant={isOpen ? 'default' : 'outline'} size="sm" onClick={() => setExpandedSession(isOpen ? null : session.id)}>
                        <Eye className="w-4 h-4 mr-1.5" />
                        {isOpen ? 'Hide Live' : 'Watch Live'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => window.open(getBrowserbaseUrl(session.id), '_blank')}>
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="rounded-lg overflow-hidden border border-border bg-card">
                      {liveUrl ? (
                        <iframe
                          src={liveUrl}
                          title={`Live session ${session.id}`}
                          className="w-full"
                          style={{ height: 620 }}
                          allow="autoplay; clipboard-write"
                          sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                        />
                      ) : (
                        <div className="py-10 text-center text-sm text-muted-foreground">
                          Loading live debug stream… click refresh if needed.
                        </div>
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
              No active browser sessions right now. Start a cloud upload and this page will show the live stream.
            </p>
          </CardContent>
        </Card>
      )}

      {completedJobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recent Sessions</h2>
          <div className="space-y-2">
            {completedJobs.map((job: BrowserJob) => (
              <Card key={job.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{job.title || job.video_file_name}</p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap text-xs text-muted-foreground">
                        <Badge variant={job.status === 'error' ? 'destructive' : 'secondary'}>{job.status}</Badge>
                        {(job.platform_results as any[])?.map((pr: any, i: number) => (
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
                      View Recording
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            About Browser Sessions
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>Live running sessions are shown above directly from Browserbase debug streams.</p>
          <p>If YouTube shows a verification page, keep the live stream open, complete login once, then retry the upload.</p>
          <p>After completion, use View Recording for a full replay.</p>
        </CardContent>
      </Card>
    </div>
  );
}
