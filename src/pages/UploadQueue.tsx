import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getQueue, retryJob, deleteJob, clearQueue, type UploadJob, type PlatformResult, getVideoUrl } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, ExternalLink, Inbox, Trash2, Video, Monitor } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const statusColors: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  uploading: 'bg-blue-100 text-blue-700',
  success: 'bg-emerald-100 text-emerald-700',
  error: 'bg-destructive/10 text-destructive',
};

const statusLabels: Record<string, string> = {
  pending: 'waiting for server',
  uploading: 'uploading…',
  success: 'uploaded',
  error: 'failed',
};

export default function UploadQueue() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['queue'],
    queryFn: () => getQueue(),
    refetchInterval: 3000,
  });

  const handleRetry = async (jobId: string) => {
    await retryJob(jobId);
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    toast({ title: 'Retrying upload' });
  };

  const handleDelete = async (jobId: string) => {
    await deleteJob(jobId);
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    toast({ title: 'Job deleted' });
  };

  const handleClear = async () => {
    await clearQueue();
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    toast({ title: 'Queue cleared' });
  };

  const hasPending = jobs.some((j) => j.platform_results.some((p: PlatformResult) => p.status === 'pending'));

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Upload Queue</h1>
          <p className="text-sm text-muted-foreground mt-1">Track and manage upload jobs</p>
        </div>
        {jobs.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleClear} className="gap-2 text-muted-foreground">
            <Trash2 className="w-3.5 h-3.5" />
            Clear All
          </Button>
        )}
      </div>

      {hasPending && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <Monitor className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-amber-800">Waiting for local server</p>
            <p className="text-amber-700 mt-0.5">
              Pending jobs will be processed when your local server is running. It checks for new jobs every minute 
              and uploads via real browser automation (Playwright). See the Setup Guide to get started.
            </p>
          </div>
        </div>
      )}

      {jobs.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Inbox className="w-10 h-10 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">Queue is empty</h2>
          <p className="text-sm text-muted-foreground">
            Upload a video from the Dashboard to see jobs here.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {jobs.map((job) => (
          <Card key={job.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <CardTitle className="text-sm font-medium truncate">
                    {job.title || job.video_file_name}
                  </CardTitle>
                  {job.video_storage_path && (
                    <a
                      href={getVideoUrl(job.video_storage_path)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0"
                    >
                      <Video className="w-3.5 h-3.5 text-muted-foreground hover:text-primary" />
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {new Date(job.created_at).toLocaleString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(job.id)}
                    className="h-7 px-1.5 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2.5">
                {job.platform_results.map((p: PlatformResult) => (
                  <div key={p.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="capitalize text-sm font-medium w-20">{p.name}</span>
                      <Badge className={statusColors[p.status] || ''} variant="secondary">
                        {statusLabels[p.status] || p.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      {p.url && (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline text-xs flex items-center gap-1"
                        >
                          View <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      {p.error && (
                        <span className="text-xs text-destructive truncate max-w-48">{p.error}</span>
                      )}
                      {p.status === 'error' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRetry(job.id)}
                          className="h-7 px-2"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
