import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, UploadJob } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, ExternalLink, AlertCircle, Inbox } from 'lucide-react';
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

  const { data: jobs = [], isLoading, isError } = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.getQueue(),
    refetchInterval: 5000,
    retry: false,
  });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.retryJob(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      toast({ title: 'Retrying upload' });
    },
  });

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <AlertCircle className="w-10 h-10 text-destructive mb-4" />
        <h2 className="text-lg font-semibold">Server not reachable</h2>
        <p className="text-sm text-muted-foreground mt-1">Start the local server to view the queue.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload Queue</h1>
        <p className="text-sm text-muted-foreground mt-1">Track and manage upload jobs</p>
      </div>

      {jobs.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Inbox className="w-10 h-10 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">Queue is empty</h2>
          <p className="text-sm text-muted-foreground">Trigger an upload from the Dashboard to see jobs here.</p>
        </div>
      )}

      <div className="space-y-4">
        {jobs.map((job) => (
          <Card key={job.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium truncate">
                  {job.metadata?.title || job.videoFile}
                </CardTitle>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {new Date(job.createdAt).toLocaleString()}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {job.platforms.map((p) => (
                  <div key={p.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="capitalize text-sm font-medium w-20">{p.name}</span>
                      <Badge className={statusColors[p.status]} variant="secondary">
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
                          onClick={() => retryMutation.mutate(job.id)}
                          disabled={retryMutation.isPending}
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
