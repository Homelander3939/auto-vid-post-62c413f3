import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getQueue, retryJob, deleteJob, clearQueue, type UploadJob, type PlatformResult, getVideoUrl } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, ExternalLink, Inbox, Trash2, Video } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const statusColors: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground',
  uploading: 'bg-[hsl(var(--info))]/10 text-[hsl(var(--info))]',
  success: 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]',
  error: 'bg-destructive/10 text-destructive',
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
                        {p.status}
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
