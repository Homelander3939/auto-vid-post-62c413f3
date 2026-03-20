import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createUploadJob,
  parseTextContent,
  uploadVideoFile,
  getSettings,
  type VideoMetadata,
  type AppSettings,
} from '@/lib/storage';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileVideo, FileText, UploadCloud, CheckCircle2, CalendarClock, Zap, X, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import CampaignScheduler from '@/components/CampaignScheduler';

type PlatformStatus = { ready: boolean; reason: string };

function getPlatformStatuses(settings: AppSettings | undefined): Record<string, PlatformStatus> {
  if (!settings) return {
    youtube: { ready: false, reason: 'Loading settings…' },
    tiktok: { ready: false, reason: 'Loading settings…' },
    instagram: { ready: false, reason: 'Loading settings…' },
  };

  const check = (p: 'youtube' | 'tiktok' | 'instagram'): PlatformStatus => {
    const s = settings[p];
    if (!s.enabled) return { ready: false, reason: `${p} is disabled in Settings` };
    if (!s.email || !s.password) return { ready: false, reason: `${p} credentials missing in Settings` };
    return { ready: true, reason: '' };
  };

  return { youtube: check('youtube'), tiktok: check('tiktok'), instagram: check('instagram') };
}

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textFileName, setTextFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  const platformStatuses = getPlatformStatuses(settings);

  // Auto-select only ready platforms on settings load
  useEffect(() => {
    if (!settings) return;
    const ready = Object.entries(platformStatuses)
      .filter(([, s]) => s.ready)
      .map(([name]) => name);
    setSelectedPlatforms(ready);
  }, [settings?.youtube.enabled, settings?.tiktok.enabled, settings?.instagram.enabled,
      settings?.youtube.email, settings?.tiktok.email, settings?.instagram.email]);

  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    if (!title) {
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
      setTitle(name);
    }
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
      if (parsed.title) setTitle(parsed.title);
      if (parsed.description) setDescription(parsed.description);
      if (parsed.tags?.length) setTagsInput(parsed.tags.join(', '));
      // Only auto-select platforms from text file if they're ready
      if (parsed.platforms?.length) {
        const readyFromText = parsed.platforms.filter(p => platformStatuses[p]?.ready);
        if (readyFromText.length > 0) setSelectedPlatforms(readyFromText);
      }
      toast({ title: `Text file loaded: ${file.name}` });
    } catch {
      toast({ title: 'Could not read text file', variant: 'destructive' });
    }
  };

  const clearTextFile = () => {
    setTextContent(null);
    setTextFileName(null);
    if (textInputRef.current) textInputRef.current.value = '';
  };

  const handleUpload = async () => {
    if (!videoFile || !title.trim() || selectedPlatforms.length === 0) return;

    // Final guard: only allow ready platforms
    const readyPlatforms = selectedPlatforms.filter(p => platformStatuses[p]?.ready);
    if (readyPlatforms.length === 0) {
      toast({ title: 'No platforms ready', description: 'Configure credentials in Settings first.', variant: 'destructive' });
      return;
    }

    setUploading(true);
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
      const metadata: VideoMetadata = {
        title: title.trim(),
        description: description.trim(),
        tags,
        platforms: readyPlatforms,
      };

      const storagePath = await uploadVideoFile(videoFile);
      await createUploadJob(videoFile.name, storagePath, metadata, readyPlatforms);

      // Trigger the correct executor based on mode
      const uploadMode = settings?.uploadMode || 'local';
      if (uploadMode === 'local') {
        // Try to trigger local server
        try {
          await fetch('http://localhost:3001/api/process-pending', { method: 'POST', signal: AbortSignal.timeout(5000) });
        } catch {
          console.log('Local server not reachable — cron will pick up the job');
        }
      } else {
        try {
          await supabase.functions.invoke('process-uploads', { body: {} });
        } catch (e) {
          console.log('Auto-trigger process-uploads:', e);
        }
      }

      toast({
        title: 'Job queued!',
        description: `Uploading to ${readyPlatforms.join(', ')}. ${uploadMode === 'local' ? 'Local server will process.' : 'Cloud will process.'}`,
      });

      queryClient.invalidateQueries({ queryKey: ['queue'] });
      setVideoFile(null);
      setTextContent(null);
      setTextFileName(null);
      setTitle('');
      setDescription('');
      setTagsInput('');
      if (videoInputRef.current) videoInputRef.current.value = '';
      if (textInputRef.current) textInputRef.current.value = '';
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const togglePlatform = (p: string) => {
    const status = platformStatuses[p];
    if (!status?.ready) {
      toast({ title: `${p} not ready`, description: status?.reason || 'Configure in Settings', variant: 'destructive' });
      return;
    }
    setSelectedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  const canUpload = !!videoFile && title.trim().length > 0 && selectedPlatforms.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Upload now or schedule a campaign</p>
      </div>

      <Tabs defaultValue="single" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="single" className="gap-2">
            <Zap className="w-3.5 h-3.5" />
            Single Upload
          </TabsTrigger>
          <TabsTrigger value="campaign" className="gap-2">
            <CalendarClock className="w-3.5 h-3.5" />
            Campaign
          </TabsTrigger>
        </TabsList>

        <TabsContent value="single" className="space-y-5 mt-6">
          <input ref={videoInputRef} type="file" accept="video/*,.mp4,.mov,.avi,.mkv,.webm" className="hidden" onChange={handleVideoSelect} />
          <button
            type="button"
            onClick={() => videoInputRef.current?.click()}
            className={`w-full flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] ${
              videoFile ? 'border-primary/50 bg-primary/5' : 'border-border'
            }`}
          >
            {videoFile ? (
              <>
                <CheckCircle2 className="w-6 h-6 text-primary" />
                <span className="text-sm font-medium truncate max-w-full">{videoFile.name}</span>
                <span className="text-xs text-muted-foreground">{(videoFile.size / 1024 / 1024).toFixed(1)} MB — tap to change</span>
              </>
            ) : (
              <>
                <FileVideo className="w-6 h-6 text-primary" />
                <span className="text-sm font-medium">Select Video File</span>
                <span className="text-xs text-muted-foreground">.mp4, .mov, .avi, .mkv, .webm</span>
              </>
            )}
          </button>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Video Details</CardTitle>
              <CardDescription>Title is required. Other fields are optional.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">Title <span className="text-destructive">*</span></Label>
                <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="My awesome video" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="desc">Description</Label>
                <Textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description…" rows={3} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tags">Tags</Label>
                <Input id="tags" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="tag1, tag2, tag3" />
                <p className="text-xs text-muted-foreground">Comma-separated</p>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <input ref={textInputRef} type="file" accept=".txt,text/plain" className="hidden" onChange={handleTextSelect} />
                {textFileName ? (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <FileText className="w-3 h-3" />
                    {textFileName}
                    <button onClick={clearTextFile} className="ml-1 hover:text-destructive"><X className="w-3 h-3" /></button>
                  </Badge>
                ) : (
                  <Button type="button" variant="ghost" size="sm" className="text-xs gap-1.5" onClick={() => textInputRef.current?.click()}>
                    <FileText className="w-3.5 h-3.5" />
                    Import from .txt file
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5 space-y-4">
              <div className="space-y-2">
                <Label>Platforms</Label>
                <div className="flex flex-wrap gap-2">
                  {(['youtube', 'tiktok', 'instagram'] as const).map((p) => {
                    const status = platformStatuses[p];
                    return (
                      <Tooltip key={p}>
                        <TooltipTrigger asChild>
                          <Button
                            variant={selectedPlatforms.includes(p) ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => togglePlatform(p)}
                            className={`capitalize gap-1.5 ${!status?.ready ? 'opacity-50' : ''}`}
                          >
                            {!status?.ready && <AlertTriangle className="w-3 h-3" />}
                            {p}
                          </Button>
                        </TooltipTrigger>
                        {!status?.ready && (
                          <TooltipContent side="bottom" className="max-w-[200px] text-xs">
                            {status?.reason}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    );
                  })}
                </div>
                {selectedPlatforms.length === 0 && (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    No platforms ready. Configure credentials in Settings.
                  </p>
                )}
              </div>
              <Button onClick={handleUpload} disabled={!canUpload || uploading} className="w-full gap-2" size="lg">
                <UploadCloud className="w-4 h-4" />
                {uploading ? 'Uploading…' : 'Queue Upload Now'}
              </Button>
              {!canUpload && !uploading && (
                <p className="text-xs text-muted-foreground text-center">
                  {!videoFile ? 'Select a video file' : !title.trim() ? 'Enter a title' : 'Select at least one platform'}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="campaign" className="mt-6">
          <CampaignScheduler />
        </TabsContent>
      </Tabs>
    </div>
  );
}
