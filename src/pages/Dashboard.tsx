import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createUploadJob,
  parseTextContent,
  uploadVideoFile,
  getVideoUrl,
  getSettings,
  type VideoMetadata,
} from '@/lib/storage';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileVideo, FileText, Upload, FolderOpen, Info, UploadCloud, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textFileName, setTextFileName] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [uploading, setUploading] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  // Check latest job from DB for status display
  const { data: latestJobs = [] } = useQuery({
    queryKey: ['queue'],
    queryFn: async () => {
      const { data } = await supabase
        .from('upload_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(3);
      return data || [];
    },
    refetchInterval: 3000,
  });

  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    toast({ title: `Video selected: ${file.name}` });
  };

  const handleTextSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setTextContent(text);
      setTextFileName(file.name);
      const parsed = parseTextContent(text);
      setMetadata(parsed);
      toast({ title: `Text file loaded: ${file.name}` });
    } catch {
      toast({ title: 'Could not read text file', variant: 'destructive' });
    }
  };

  const handleUpload = async () => {
    if (!videoFile || !metadata) return;
    setUploading(true);

    try {
      // Check if any platform credentials are configured
      const settings = await getSettings();
      const platforms =
        selectedPlatforms.length > 0 ? selectedPlatforms : metadata.platforms;

      const missingCreds: string[] = [];
      for (const p of platforms) {
        if (p === 'youtube' && (!settings.youtube.email || !settings.youtube.enabled)) missingCreds.push('YouTube');
        if (p === 'tiktok' && (!settings.tiktok.email || !settings.tiktok.enabled)) missingCreds.push('TikTok');
        if (p === 'instagram' && (!settings.instagram.email || !settings.instagram.enabled)) missingCreds.push('Instagram');
      }

      // Upload video to storage
      const storagePath = await uploadVideoFile(videoFile);

      // Create job in database
      const job = await createUploadJob(
        videoFile.name,
        storagePath,
        metadata,
        platforms
      );

      const warningMsg = missingCreds.length > 0
        ? `⚠️ Missing credentials for: ${missingCreds.join(', ')}. Configure them in Settings. `
        : '';

      toast({
        title: 'Job queued!',
        description: `${warningMsg}Video stored. The local server will pick it up and upload to platforms via browser automation.`,
      });

      queryClient.invalidateQueries({ queryKey: ['queue'] });

      // Reset
      setVideoFile(null);
      setTextContent(null);
      setTextFileName(null);
      setMetadata(null);
      if (videoInputRef.current) videoInputRef.current.value = '';
      if (textInputRef.current) textInputRef.current.value = '';
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const togglePlatform = (p: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  const platforms = metadata?.platforms || ['youtube', 'tiktok', 'instagram'];
  const activePlatforms = selectedPlatforms.length > 0 ? selectedPlatforms : platforms;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload video and text file, then publish to platforms
        </p>
      </div>

      {/* File Selection */}
      <div className="grid gap-4 sm:grid-cols-2">
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
          className="hidden"
          onChange={handleVideoSelect}
        />
        <button
          type="button"
          onClick={() => videoInputRef.current?.click()}
          className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] ${
            videoFile ? 'border-[hsl(var(--success))] bg-[hsl(var(--success))]/5' : 'border-border'
          }`}
        >
          {videoFile ? (
            <>
              <CheckCircle2 className="w-7 h-7 text-[hsl(var(--success))]" />
              <span className="text-sm font-medium">{videoFile.name}</span>
              <span className="text-xs text-muted-foreground">
                {(videoFile.size / 1024 / 1024).toFixed(1)} MB — click to change
              </span>
            </>
          ) : (
            <>
              <FileVideo className="w-7 h-7 text-primary" />
              <span className="text-sm font-medium">Select Video File</span>
              <span className="text-xs text-muted-foreground">.mp4, .mov, .avi, .mkv, .webm</span>
            </>
          )}
        </button>

        <input
          ref={textInputRef}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          onChange={handleTextSelect}
        />
        <button
          type="button"
          onClick={() => textInputRef.current?.click()}
          className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] ${
            textContent ? 'border-[hsl(var(--success))] bg-[hsl(var(--success))]/5' : 'border-border'
          }`}
        >
          {textContent ? (
            <>
              <CheckCircle2 className="w-7 h-7 text-[hsl(var(--success))]" />
              <span className="text-sm font-medium">{textFileName}</span>
              <span className="text-xs text-muted-foreground">Parsed successfully — click to change</span>
            </>
          ) : (
            <>
              <FileText className="w-7 h-7 text-primary" />
              <span className="text-sm font-medium">Select Text File</span>
              <span className="text-xs text-muted-foreground">.txt with title, description, tags</span>
            </>
          )}
        </button>
      </div>

      {/* Metadata Preview */}
      {metadata && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Parsed Metadata</CardTitle>
            <CardDescription>Extracted from {textFileName}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Title</label>
              <p className="text-sm mt-1">{metadata.title || '—'}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Description</label>
              <p className="text-sm mt-1 whitespace-pre-wrap">{metadata.description || '—'}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tags</label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {metadata.tags?.length ? (
                  metadata.tags.map((tag) => (
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
      {videoFile && metadata && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload to Platforms</CardTitle>
            <CardDescription>Select platforms and publish your video</CardDescription>
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
              onClick={handleUpload}
              disabled={uploading || activePlatforms.length === 0}
              className="gap-2"
            >
              <UploadCloud className="w-4 h-4" />
              {uploading ? 'Uploading video…' : 'Start Upload'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!videoFile && !textContent && (
        <Card className="border-[hsl(var(--info))]/30 bg-[hsl(var(--info))]/5">
          <CardContent className="flex items-start gap-3 pt-5">
            <Info className="w-5 h-5 text-[hsl(var(--info))] shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-foreground mb-1">How to use</p>
              <ol className="text-muted-foreground list-decimal list-inside space-y-1">
                <li>Select a video file (.mp4, .mov, etc.)</li>
                <li>Select a text file with metadata (title, description, tags)</li>
                <li>Review parsed metadata and pick target platforms</li>
                <li>Click "Start Upload" — video is stored and queued</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
