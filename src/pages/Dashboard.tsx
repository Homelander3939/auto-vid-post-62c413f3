import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createUploadJob,
  createScheduledUpload,
  parseTextContent,
  uploadVideoFile,
  getSettings,
  getPlatformAccounts,
  type VideoMetadata,
  type AppSettings,
  type PlatformAccount,
} from '@/lib/storage';
import { cleanVideoTitle, matchVideoTextFiles, sortFilesBySeriesNumber, INTENSITY_OPTIONS } from '@/lib/titleUtils';
import { supabase } from '@/integrations/supabase/client';
import AccountPicker, { useAccountsForPlatforms } from '@/components/AccountPicker';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileVideo, FileText, UploadCloud, CheckCircle2, CalendarClock, Zap, X, AlertTriangle, Clock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import CampaignScheduler from '@/components/CampaignScheduler';
import { saveLocalJobAccountSelections, saveLocalScheduledAccountSelections, type PlatformAccountSelections } from '@/lib/localBrowserProfiles';

type PlatformStatus = { ready: boolean; reason: string };

function getPlatformStatuses(
  settings: AppSettings | undefined,
  accountsByPlatform: Record<string, PlatformAccount[]>
): Record<string, PlatformStatus> {
  if (!settings) return {
    youtube: { ready: false, reason: 'Loading settings…' },
    tiktok: { ready: false, reason: 'Loading settings…' },
    instagram: { ready: false, reason: 'Loading settings…' },
  };

  const check = (p: 'youtube' | 'tiktok' | 'instagram'): PlatformStatus => {
    const accs = accountsByPlatform[p] || [];
    // If we have platform_accounts, use those
    if (accs.length > 0) {
      return { ready: true, reason: '' };
    }
    // Fallback to app_settings
    const s = settings[p];
    if (!s.enabled) return { ready: false, reason: `${p} is disabled in Settings` };
    if (!s.email || !s.password) return { ready: false, reason: `${p} credentials missing in Settings` };
    return { ready: true, reason: '' };
  };

  return { youtube: check('youtube'), tiktok: check('tiktok'), instagram: check('instagram') };
}

interface BatchEntry {
  videoFile: File;
  textFile?: File;
  title: string;
  description: string;
  tags: string[];
}

function buildPlatformAccountSelections(platforms: string[], selectedAccounts: Record<string, string>): PlatformAccountSelections {
  return platforms.reduce<PlatformAccountSelections>((acc, platform) => {
    const accountId = selectedAccounts[platform];
    if (accountId) acc[platform] = accountId;
    return acc;
  }, {});
}

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  // Single-file fields
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [textFileName, setTextFileName] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  // Multi-file batch
  const [batchEntries, setBatchEntries] = useState<BatchEntry[]>([]);
  const [intensityMinutes, setIntensityMinutes] = useState(10);

  // Account selection per platform
  const [selectedAccounts, setSelectedAccounts] = useState<Record<string, string>>({});

  const isMultiFile = batchEntries.length > 1;

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  const { accountsByPlatform, getDefaultAccountId, needsPicker } = useAccountsForPlatforms(['youtube', 'tiktok', 'instagram']);

  const platformStatuses = getPlatformStatuses(settings, accountsByPlatform);

  useEffect(() => {
    if (!settings) return;
    const ready = Object.entries(platformStatuses)
      .filter(([, s]) => s.ready)
      .map(([name]) => name);
    setSelectedPlatforms(ready);
    // Initialize default account selections
    const defaults: Record<string, string> = {};
    for (const p of ready) {
      const defId = getDefaultAccountId(p);
      if (defId) defaults[p] = defId;
    }
    setSelectedAccounts((prev) => ({ ...defaults, ...prev }));
  }, [settings?.youtube.enabled, settings?.tiktok.enabled, settings?.instagram.enabled,
      settings?.youtube.email, settings?.tiktok.email, settings?.instagram.email,
      JSON.stringify(accountsByPlatform)]);

  const handleVideoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    if (files.length === 1) {
      // Single file mode
      const file = files[0];
      setVideoFile(file);
      setBatchEntries([]);
      if (!title) {
        setTitle(cleanVideoTitle(file.name));
      }
      toast({ title: `Video selected: ${file.name}` });
    } else {
      // Multi-file mode: sort by series number (lowest first), create batch entries
      setVideoFile(null);
      const sorted = sortFilesBySeriesNumber(files);
      const entries: BatchEntry[] = sorted.map(f => ({
        videoFile: f,
        title: cleanVideoTitle(f.name),
        description: '',
        tags: [],
      }));
      setBatchEntries(entries);
      setTitle('');
      setDescription('');
      setTagsInput('');
      setTextFileName(null);
      toast({ title: `${files.length} videos selected`, description: 'Now optionally select matching .txt files' });
    }
  };

  const handleTextSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    if (isMultiFile || batchEntries.length > 0) {
      // Match text files to batch entries by name
      const textMap = new Map<string, File>();
      for (const tf of files) {
        const stem = tf.name.replace(/\.[^.]+$/, '').toLowerCase();
        textMap.set(stem, tf);
      }

      const updatedEntries = [...batchEntries];
      let matched = 0;
      for (const entry of updatedEntries) {
        const stem = entry.videoFile.name.replace(/\.[^.]+$/, '').toLowerCase();
        const matchedText = textMap.get(stem);
        if (matchedText) {
          entry.textFile = matchedText;
          const text = await matchedText.text();
          const parsed = parseTextContent(text);
          if (parsed.title) entry.title = parsed.title;
          if (parsed.description) entry.description = parsed.description;
          if (parsed.tags?.length) entry.tags = parsed.tags;
          matched++;
        }
      }
      setBatchEntries(updatedEntries);
      toast({ title: `Matched ${matched} of ${files.length} text files` });
    } else {
      // Single file text import
      const file = files[0];
      try {
        const text = await file.text();
        const parsed = parseTextContent(text);
        setTextFileName(file.name);
        if (parsed.title) setTitle(parsed.title);
        if (parsed.description) setDescription(parsed.description);
        if (parsed.tags?.length) setTagsInput(parsed.tags.join(', '));
        if (parsed.platforms?.length) {
          const readyFromText = parsed.platforms.filter(p => platformStatuses[p]?.ready);
          if (readyFromText.length > 0) setSelectedPlatforms(readyFromText);
        }
        toast({ title: `Text file loaded: ${file.name}` });
      } catch {
        toast({ title: 'Could not read text file', variant: 'destructive' });
      }
    }
  };

  const clearTextFile = () => {
    setTextFileName(null);
    if (textInputRef.current) textInputRef.current.value = '';
  };

  const clearBatch = () => {
    setBatchEntries([]);
    setVideoFile(null);
    setTitle('');
    setDescription('');
    setTagsInput('');
    setTextFileName(null);
    if (videoInputRef.current) videoInputRef.current.value = '';
    if (textInputRef.current) textInputRef.current.value = '';
  };

  const handleUpload = async () => {
    const readyPlatforms = selectedPlatforms.filter(p => platformStatuses[p]?.ready);
    if (readyPlatforms.length === 0) {
      toast({ title: 'No platforms ready', description: 'Configure credentials in Settings first.', variant: 'destructive' });
      return;
    }

    setUploading(true);
    try {
      if (isMultiFile) {
        // Batch upload with intensity spacing
        const immediateIds: string[] = [];
        for (let i = 0; i < batchEntries.length; i++) {
          const entry = batchEntries[i];
          setUploadProgress(`Uploading video ${i + 1}/${batchEntries.length}...`);

          const storagePath = await uploadVideoFile(entry.videoFile);
          const metadata: VideoMetadata = {
            title: entry.title,
            description: entry.description,
            tags: entry.tags,
            platforms: readyPlatforms,
          };
          const accountSelections = buildPlatformAccountSelections(readyPlatforms, selectedAccounts);
          const primaryAccountId = readyPlatforms.map((platform) => accountSelections[platform]).find(Boolean);

          if (i === 0) {
            // First video: immediate
            const job = await createUploadJob(entry.videoFile.name, storagePath, metadata, readyPlatforms, primaryAccountId);
            try {
              await saveLocalJobAccountSelections(job.id, accountSelections);
            } catch (error) {
              console.warn('Failed to save local account selections for job', error);
            }
            immediateIds.push(job.id);
          } else {
            // Subsequent videos: scheduled with intensity spacing
            const scheduledAt = new Date(Date.now() + i * intensityMinutes * 60_000).toISOString();
            const scheduled = await createScheduledUpload(entry.videoFile.name, storagePath, metadata, readyPlatforms, scheduledAt, primaryAccountId);
            try {
              await saveLocalScheduledAccountSelections(scheduled.id, accountSelections);
            } catch (error) {
              console.warn('Failed to save local account selections for scheduled upload', error);
            }
          }
        }

        // Trigger local server for immediate job
        if (immediateIds.length > 0) {
          try {
            await Promise.all(immediateIds.map(id =>
              fetch(`http://localhost:3001/api/process/${id}`, { method: 'POST', signal: AbortSignal.timeout(5000) })
            ));
            await fetch('http://localhost:3001/api/process-pending', { method: 'POST', signal: AbortSignal.timeout(5000) });
          } catch { /* local server might not be running */ }
        }

        toast({
          title: `${batchEntries.length} uploads queued!`,
          description: `1 now, ${batchEntries.length - 1} scheduled every ${intensityMinutes} min`,
        });
      } else {
        // Single file upload
        if (!videoFile || !title.trim()) return;
        setUploadProgress('Uploading video...');
        const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
        const metadata: VideoMetadata = {
          title: title.trim(),
          description: description.trim(),
          tags,
          platforms: readyPlatforms,
        };
        const storagePath = await uploadVideoFile(videoFile);
        const accountSelections = buildPlatformAccountSelections(readyPlatforms, selectedAccounts);
        const primaryAccountId = readyPlatforms.map((platform) => accountSelections[platform]).find(Boolean);
        const job = await createUploadJob(videoFile.name, storagePath, metadata, readyPlatforms, primaryAccountId);
        try {
          await saveLocalJobAccountSelections(job.id, accountSelections);
        } catch (error) {
          console.warn('Failed to save local account selections for job', error);
        }

        const uploadMode = settings?.uploadMode || 'local';
        if (uploadMode === 'local') {
          try {
            await fetch(`http://localhost:3001/api/process/${job.id}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
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
          description: `Uploading to ${readyPlatforms.join(', ')}.`,
        });
      }

      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['scheduled_uploads'] });
      clearBatch();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setUploading(false);
      setUploadProgress('');
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

  const canUpload = isMultiFile
    ? batchEntries.length > 0 && selectedPlatforms.length > 0
    : !!videoFile && title.trim().length > 0 && selectedPlatforms.length > 0;

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
            Upload
          </TabsTrigger>
          <TabsTrigger value="campaign" className="gap-2">
            <CalendarClock className="w-3.5 h-3.5" />
            Campaign
          </TabsTrigger>
        </TabsList>

        <TabsContent value="single" className="space-y-5 mt-6">
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
            multiple
            className="hidden"
            onChange={handleVideoSelect}
          />
          <button
            type="button"
            onClick={() => videoInputRef.current?.click()}
            className={`w-full flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] ${
              (videoFile || isMultiFile) ? 'border-primary/50 bg-primary/5' : 'border-border'
            }`}
          >
            {isMultiFile ? (
              <>
                <CheckCircle2 className="w-6 h-6 text-primary" />
                <span className="text-sm font-medium">{batchEntries.length} videos selected</span>
                <span className="text-xs text-muted-foreground">Tap to change selection</span>
              </>
            ) : videoFile ? (
              <>
                <CheckCircle2 className="w-6 h-6 text-primary" />
                <span className="text-sm font-medium truncate max-w-full">{videoFile.name}</span>
                <span className="text-xs text-muted-foreground">{(videoFile.size / 1024 / 1024).toFixed(1)} MB — tap to change</span>
              </>
            ) : (
              <>
                <FileVideo className="w-6 h-6 text-primary" />
                <span className="text-sm font-medium">Select Video File(s)</span>
                <span className="text-xs text-muted-foreground">Select multiple videos for batch upload</span>
              </>
            )}
          </button>

          {/* Multi-file batch list */}
          {isMultiFile && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span>Batch Queue ({batchEntries.length} videos)</span>
                  <Button variant="ghost" size="sm" onClick={clearBatch} className="text-xs h-7">
                    <X className="w-3 h-3 mr-1" /> Clear
                  </Button>
                </CardTitle>
                <CardDescription>Matched by filename. Select .txt files to auto-fill metadata.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {batchEntries.map((entry, idx) => (
                  <div key={idx} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
                    <span className="text-xs font-mono text-muted-foreground w-6 shrink-0">{idx + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{entry.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {entry.videoFile.name}
                        {entry.textFile && <span className="text-primary ml-1">· {entry.textFile.name}</span>}
                      </p>
                    </div>
                    {idx === 0 ? (
                      <Badge variant="default" className="text-[10px] shrink-0">Now</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        +{idx * intensityMinutes}m
                      </Badge>
                    )}
                  </div>
                ))}

                {/* Intensity selector */}
                <div className="pt-3 border-t space-y-2">
                  <Label className="text-xs flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" /> Upload Intensity
                  </Label>
                  <Select value={String(intensityMinutes)} onValueChange={v => setIntensityMinutes(Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INTENSITY_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    First video uploads immediately, rest spaced by {intensityMinutes} minutes each.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Single file metadata */}
          {!isMultiFile && (
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
              </CardContent>
            </Card>
          )}

          {/* Text file import */}
          <div className="flex items-center gap-2">
            <input
              ref={textInputRef}
              type="file"
              accept=".txt,text/plain"
              multiple
              className="hidden"
              onChange={handleTextSelect}
            />
            {textFileName && !isMultiFile ? (
              <Badge variant="secondary" className="gap-1 text-xs">
                <FileText className="w-3 h-3" />
                {textFileName}
                <button onClick={clearTextFile} className="ml-1 hover:text-destructive"><X className="w-3 h-3" /></button>
              </Badge>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="text-xs gap-1.5" onClick={() => textInputRef.current?.click()}>
                <FileText className="w-3.5 h-3.5" />
                {isMultiFile ? 'Import matching .txt files' : 'Import from .txt file'}
              </Button>
            )}
          </div>

          {/* Platforms */}
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
                {/* Account pickers — only shown when multiple accounts exist */}
                {needsPicker && selectedPlatforms.length > 0 && (
                  <div className="flex flex-wrap gap-3 pt-2 border-t">
                    {selectedPlatforms.map((p) => (
                      <AccountPicker
                        key={p}
                        platform={p}
                        selectedAccountId={selectedAccounts[p]}
                        onSelect={(id) => setSelectedAccounts((prev) => ({ ...prev, [p]: id }))}
                      />
                    ))}
                  </div>
                )}
              </div>
              <Button onClick={handleUpload} disabled={!canUpload || uploading} className="w-full gap-2" size="lg">
                <UploadCloud className="w-4 h-4" />
                {uploading ? (uploadProgress || 'Uploading…') : isMultiFile ? `Queue ${batchEntries.length} Uploads` : 'Queue Upload Now'}
              </Button>
              {!canUpload && !uploading && (
                <p className="text-xs text-muted-foreground text-center">
                  {isMultiFile
                    ? 'Select at least one platform'
                    : !videoFile ? 'Select a video file' : !title.trim() ? 'Enter a title' : 'Select at least one platform'}
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
