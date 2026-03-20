import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ScanResult } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { FileVideo, FileText, Upload, AlertCircle, FolderOpen } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useState } from 'react';

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);

  const { data: scan, isLoading, isError, refetch } = useQuery({
    queryKey: ['scan'],
    queryFn: () => api.scanFolder(),
    retry: false,
    refetchInterval: 15000,
  });

  const uploadMutation = useMutation({
    mutationFn: (platforms: string[]) => api.triggerUpload(platforms),
    onSuccess: () => {
      toast({ title: 'Upload started', description: 'Check the queue for progress.' });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Upload failed', description: err.message, variant: 'destructive' });
    },
  });

  const togglePlatform = (p: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <AlertCircle className="w-10 h-10 text-destructive mb-4" />
        <h2 className="text-lg font-semibold mb-1">Cannot connect to local server</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Make sure the Node.js server is running on port 3001. Run{' '}
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">npm run server</code> in your terminal.
        </p>
      </div>
    );
  }

  const platforms = scan?.metadata?.platforms || ['youtube', 'tiktok', 'instagram'];
  const activePlatforms = selectedPlatforms.length > 0 ? selectedPlatforms : platforms;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Detected files from your configured folder</p>
      </div>

      {/* Detected Files */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FileVideo className="w-4 h-4 text-primary" />
              Video File
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-5 w-48" />
            ) : scan?.videoFile ? (
              <p className="text-sm font-mono truncate">{scan.videoFile}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No video file found</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              Text File
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-5 w-48" />
            ) : scan?.textFile ? (
              <p className="text-sm font-mono truncate">{scan.textFile}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No text file found</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Metadata Preview */}
      {scan?.metadata && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Parsed Metadata</CardTitle>
            <CardDescription>Extracted from the text file</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Title</label>
              <p className="text-sm mt-1">{scan.metadata.title || '—'}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Description</label>
              <p className="text-sm mt-1 whitespace-pre-wrap">{scan.metadata.description || '—'}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tags</label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {scan.metadata.tags?.length ? (
                  scan.metadata.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">No tags</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upload Action */}
      {scan?.videoFile && scan?.metadata && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload to Platforms</CardTitle>
            <CardDescription>Select platforms and start uploading</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              {['youtube', 'tiktok', 'instagram'].map((p) => (
                <Button
                  key={p}
                  variant={activePlatforms.includes(p) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => togglePlatform(p)}
                  className="capitalize"
                >
                  {p}
                </Button>
              ))}
            </div>
            <Button
              onClick={() => uploadMutation.mutate(activePlatforms)}
              disabled={uploadMutation.isPending || activePlatforms.length === 0}
              className="gap-2"
            >
              <Upload className="w-4 h-4" />
              {uploadMutation.isPending ? 'Starting…' : 'Start Upload'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!isLoading && !scan?.videoFile && !scan?.textFile && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen className="w-10 h-10 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">No files detected</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            Place a video file (.mp4, .mov) and a .txt metadata file in your configured folder, then refresh.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>
            Refresh
          </Button>
        </div>
      )}
    </div>
  );
}
