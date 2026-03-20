import { useEffect, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSettings } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, Monitor, RefreshCw, Play, Eye, Cloud, AlertCircle, Maximize2, Minimize2 } from 'lucide-react';

export default function BrowserSessions() {
  const [loading, setLoading] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [debugUrls, setDebugUrls] = useState<Record<string, string>>({});

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const isCloud = settings?.uploadMode === 'cloud';

  // Fetch all jobs — use select('*') to get browserbase_session_id (not in TS types yet)
  const { data: recentJobs, refetch } = useQuery({
    queryKey: ['browser-sessions'],
    queryFn: async () => {
      const { data } = await supabase
        .from('upload_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30);
      // Cast to any and filter for those with a browserbase_session_id
      return ((data || []) as any[]).filter((j: any) => j.browserbase_session_id);
    },
    refetchInterval: 3000,
  });

  // Fetch debug URLs for running sessions via edge function
  const fetchDebugUrls = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase.functions.invoke('cloud-browser-status', {
        body: {},
      });
      if (data?.debugUrls) {
        setDebugUrls(data.debugUrls);
      }
    } catch (e) {
      console.error('Failed to fetch debug URLs:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isCloud) {
      fetchDebugUrls();
      const interval = setInterval(fetchDebugUrls, 8000);
      return () => clearInterval(interval);
    }
  }, [isCloud, fetchDebugUrls]);

  const activeJobs = recentJobs?.filter((j: any) => j.status === 'uploading') || [];
  const completedJobs = recentJobs?.filter((j: any) => j.status !== 'uploading' && j.status !== 'pending') || [];

  const getSessionViewUrl = (sessionId: string) =>
    `https://www.browserbase.com/sessions/${sessionId}`;

  const getLiveIframeUrl = (sessionId: string): string | null => {
    return debugUrls[sessionId] || null;
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'uploading': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'completed': return 'bg-emerald-100 text-emerald-800 border-emerald-200';
      case 'partial': return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'error': return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-muted text-muted-foreground';
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
              You'll be able to watch your uploads happen in real-time.
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
        <Button variant="outline" size="sm" onClick={() => { fetchDebugUrls(); refetch(); }} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Active uploads with live view */}
      {activeJobs.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
            Live Uploads
          </h2>
          {activeJobs.map((job: any) => {
            const sessionId = job.browserbase_session_id;
            const isExpanded = expandedSession === sessionId;
            const liveUrl = getLiveIframeUrl(sessionId);

            return (
              <Card key={job.id} className="border-amber-200 overflow-hidden">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <Monitor className="w-5 h-5 text-amber-600" />
                        <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-sm">{job.title || job.video_file_name}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-200 text-xs">
                            Uploading...
                          </Badge>
                          {(job.platform_results as any[])?.map((pr: any, i: number) => (
                            <Badge key={i} variant="outline" className="text-xs">
                              {pr.name}: {pr.status}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {sessionId && (
                        <>
                          <Button
                            variant={isExpanded ? "default" : "outline"}
                            size="sm"
                            onClick={() => setExpandedSession(isExpanded ? null : sessionId)}
                          >
                            {isExpanded ? <Minimize2 className="w-4 h-4 mr-1.5" /> : <Eye className="w-4 h-4 mr-1.5" />}
                            {isExpanded ? 'Collapse' : 'Watch Live'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(getSessionViewUrl(sessionId), '_blank')}
                          >
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Embedded live view */}
                  {isExpanded && sessionId && (
                    <div className="mt-4 rounded-lg overflow-hidden border border-border bg-black">
                      {liveUrl ? (
                        <iframe
                          src={liveUrl}
                          className="w-full border-0"
                          style={{ height: '600px' }}
                          allow="autoplay; clipboard-write"
                          sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center py-16 text-white/60">
                          <Monitor className="w-8 h-8 mb-3 opacity-40" />
                          <p className="text-sm">Loading live view...</p>
                          <p className="text-xs mt-1 opacity-60">
                            If the embed doesn't load,{' '}
                            <button
                              className="underline hover:text-white"
                              onClick={() => window.open(getSessionViewUrl(sessionId), '_blank')}
                            >
                              open in Browserbase
                            </button>
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* No active sessions */}
      {activeJobs.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Monitor className="w-10 h-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              No active browser sessions. Upload a video in Cloud Mode to see live automation here.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Recent sessions */}
      {completedJobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Recent Sessions</h2>
          <div className="space-y-2">
            {completedJobs.map((job: any) => (
              <Card key={job.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{job.title || job.video_file_name}</p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <Badge variant="outline" className={`text-xs ${statusColor(job.status)}`}>
                          {job.status}
                        </Badge>
                        {(job.platform_results as any[])?.map((pr: any, i: number) => (
                          <span key={i} className="text-xs text-muted-foreground">
                            {pr.name}: {pr.status === 'success' ? '✅' : pr.status === 'error' ? '❌' : '⏳'}
                            {pr.url && (
                              <a href={pr.url} target="_blank" rel="noopener" className="ml-1 text-primary hover:underline">
                                link
                              </a>
                            )}
                          </span>
                        ))}
                        <span className="text-xs text-muted-foreground">
                          {job.created_at && new Date(job.created_at).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {job.browserbase_session_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.open(getSessionViewUrl(job.browserbase_session_id), '_blank')}
                      >
                        <ExternalLink className="w-4 h-4 mr-1.5" />
                        View Recording
                      </Button>
                    )}
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
          <p>When you upload a video in Cloud Mode, a remote browser session is created via Browserbase.</p>
          <p>Click <strong>Watch Live</strong> to see the automation happening in real-time inside an embedded browser view.</p>
          <p>After completion, click <strong>View Recording</strong> to see a full replay on Browserbase.</p>
        </CardContent>
      </Card>
    </div>
  );
}
