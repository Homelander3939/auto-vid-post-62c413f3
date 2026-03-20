import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSettings } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, Monitor, RefreshCw, Play, Eye, Cloud, AlertCircle } from 'lucide-react';

interface SessionInfo {
  id: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
  pages?: { id: string; url: string; title: string }[];
}

export default function BrowserSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const isCloud = settings?.uploadMode === 'cloud';

  // Fetch active/recent sessions from upload_jobs
  const { data: recentJobs, refetch } = useQuery({
    queryKey: ['browser-sessions'],
    queryFn: async () => {
      const { data } = await supabase
        .from('upload_jobs')
        .select('id, title, video_file_name, status, platform_results, browserbase_session_id, created_at, completed_at')
        .not('browserbase_session_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(20);
      return data || [];
    },
    refetchInterval: 5000,
  });

  // Fetch live session details from Browserbase API via edge function
  const fetchSessions = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('cloud-browser-status', {
        body: {},
      });
      if (data?.sessions) {
        setSessions(data.sessions);
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isCloud) fetchSessions();
  }, [isCloud]);

  const activeJobs = recentJobs?.filter(j => j.status === 'uploading') || [];
  const completedJobs = recentJobs?.filter(j => j.status !== 'uploading' && j.status !== 'pending') || [];

  const getBrowserbaseUrl = (sessionId: string) =>
    `https://www.browserbase.com/sessions/${sessionId}`;

  const getDebugUrl = (sessionId: string) =>
    `https://www.browserbase.com/sessions/${sessionId}`;

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
        <Button variant="outline" size="sm" onClick={() => { fetchSessions(); refetch(); }} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Active uploads */}
      {activeJobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Live Uploads</h2>
          {activeJobs.map(job => (
            <Card key={job.id} className="border-amber-200 bg-amber-50/50">
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
                      <div className="flex items-center gap-2 mt-1">
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

                  {job.browserbase_session_id && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(getDebugUrl(job.browserbase_session_id!), '_blank')}
                    >
                      <Eye className="w-4 h-4 mr-1.5" />
                      Watch Live
                    </Button>
                  )}
                </div>

                {/* Embedded live view (if supported) */}
                {job.browserbase_session_id && liveSessionId === job.browserbase_session_id && (
                  <div className="mt-4 rounded-lg overflow-hidden border bg-black aspect-video">
                    <iframe
                      src={`https://www.browserbase.com/sessions/${job.browserbase_session_id}`}
                      className="w-full h-full"
                      allow="autoplay"
                    />
                  </div>
                )}

                {job.browserbase_session_id && liveSessionId !== job.browserbase_session_id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 text-xs"
                    onClick={() => setLiveSessionId(job.browserbase_session_id)}
                  >
                    <Play className="w-3 h-3 mr-1" />
                    Try embed session viewer
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
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
            {completedJobs.map(job => (
              <Card key={job.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{job.title || job.video_file_name}</p>
                      <div className="flex items-center gap-2 mt-1.5">
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
                        onClick={() => window.open(getBrowserbaseUrl(job.browserbase_session_id!), '_blank')}
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
          <p>Click "Watch Live" to open the Browserbase session viewer and watch the upload automation in real-time.</p>
          <p>After completion, click "View Recording" to see a replay of what happened in the browser.</p>
        </CardContent>
      </Card>
    </div>
  );
}
