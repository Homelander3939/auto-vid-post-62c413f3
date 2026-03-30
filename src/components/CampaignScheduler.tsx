import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createScheduledUpload,
  createUploadJob,
  getScheduledUploads,
  deleteScheduledUpload,
  parseTextContent,
  uploadVideoFile,
  getVideoUrl,
  getSettings,
  type VideoMetadata,
  type ScheduledUpload,
} from '@/lib/storage';
import { cleanVideoTitle, matchVideoTextFiles, INTENSITY_OPTIONS } from '@/lib/titleUtils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  FileVideo,
  FileText,
  CalendarClock,
  Plus,
  Trash2,
  CheckCircle2,
  Clock,
  Video,
  Info,
  FolderOpen,
  X,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';

interface ScheduleEntry {
  videoFile?: File;
  folderPath?: string;
  title: string;
  description: string;
  tags: string[];
  scheduledAt: string;
  platforms: string[];
}

function toLocalDateTimeInputValue(date: Date) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export default function CampaignScheduler() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState('');
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  // Source mode: manual file upload or folder path (local only)
  const [sourceMode, setSourceMode] = useState<'file' | 'folder'>('file');
  const [uploadMode, setUploadMode] = useState<'local' | 'cloud'>('local');

  // Current entry fields
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoFiles, setVideoFiles] = useState<File[]>([]);
  const [folderPath, setFolderPath] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [textFileName, setTextFileName] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<string[]>(['youtube', 'tiktok', 'instagram']);
  const [scheduledAt, setScheduledAt] = useState('');
  const [intensityMinutes, setIntensityMinutes] = useState(60);

  const isMultiFile = videoFiles.length > 1;

  // Load current upload mode
  useEffect(() => {
    getSettings().then((s) => setUploadMode(s.uploadMode));
  }, []);

  const { data: scheduled = [] } = useQuery({
    queryKey: ['scheduled_uploads'],
    queryFn: getScheduledUploads,
    refetchInterval: 5000,
  });

  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    if (files.length === 1) {
      setVideoFile(files[0]);
      setVideoFiles([]);
      if (!title) {
        setTitle(cleanVideoTitle(files[0].name));
      }
    } else {
      setVideoFile(null);
      setVideoFiles(files);
      setTitle('');
      setDescription('');
      setTagsInput('');
      setTextFileName(null);
      toast({ title: `${files.length} videos selected`, description: 'Select matching .txt files for metadata' });
    }
  };

  const handleTextSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseTextContent(text);
      setTextFileName(file.name);
      if (parsed.title) setTitle(parsed.title);
      if (parsed.description) setDescription(parsed.description);
      if (parsed.tags?.length) setTagsInput(parsed.tags.join(', '));
      if (parsed.platforms?.length) setPlatforms(parsed.platforms);
      toast({ title: `Imported from ${file.name}` });
    } catch {
      toast({ title: 'Could not read text file', variant: 'destructive' });
    }
  };

  const clearTextFile = () => {
    setTextFileName(null);
    if (textInputRef.current) textInputRef.current.value = '';
  };

  const togglePlatform = (p: string) => {
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  const canAdd = sourceMode === 'folder'
    ? folderPath.trim().length > 0 && scheduledAt
    : !!videoFile && title.trim().length > 0 && scheduledAt;

  const addEntry = () => {
    if (!canAdd) {
      toast({ title: 'Fill in required fields', variant: 'destructive' });
      return;
    }

    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);

    const entry: ScheduleEntry = {
      ...(sourceMode === 'file' ? { videoFile: videoFile! } : { folderPath: folderPath.trim() }),
      title: title.trim() || (sourceMode === 'folder' ? '(auto from folder)' : ''),
      description: description.trim(),
      tags,
      scheduledAt,
      platforms,
    };

    setEntries((prev) => [...prev, entry]);

    // Reset form
    setVideoFile(null);
    setFolderPath('');
    setTitle('');
    setDescription('');
    setTagsInput('');
    setTextFileName(null);
    setScheduledAt('');
    setPlatforms(['youtube', 'tiktok', 'instagram']);
    if (videoInputRef.current) videoInputRef.current.value = '';
    if (textInputRef.current) textInputRef.current.value = '';
    toast({ title: 'Added to campaign' });
  };

  const removeEntry = (idx: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
  };

  const saveAll = async () => {
    if (entries.length === 0) {
      toast({ title: 'Add at least one entry', variant: 'destructive' });
      return;
    }
    setSaving(true);
    let immediateJobIds: string[] = [];
    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        setSaveProgress(`Processing ${i + 1}/${entries.length}...`);

        let storagePath: string | null = null;
        let fileName = '';

        if (entry.videoFile) {
          setSaveProgress(`Uploading video ${i + 1}/${entries.length}...`);
          storagePath = await uploadVideoFile(entry.videoFile);
          fileName = entry.videoFile.name;
        } else if (entry.folderPath) {
          fileName = `[folder] ${entry.folderPath}`;
        }

        const metadata: VideoMetadata = {
          title: entry.title,
          description: entry.description,
          tags: entry.tags,
          platforms: entry.platforms,
        };

        const scheduledAtIso = new Date(entry.scheduledAt).toISOString();
        const scheduledTime = new Date(scheduledAtIso).getTime();
        // If scheduled time is in the past or within 1 minute, create an upload_job immediately
        const isImmediate = scheduledTime <= Date.now() + 60_000;

        if (isImmediate) {
          setSaveProgress(`Creating job ${i + 1}/${entries.length}...`);
          const job = await createUploadJob(fileName, storagePath, metadata, entry.platforms);
          immediateJobIds.push(job.id);
        } else {
          setSaveProgress(`Scheduling ${i + 1}/${entries.length}...`);
          await createScheduledUpload(fileName, storagePath, metadata, entry.platforms, scheduledAtIso);
        }
      }

      // Trigger local server for immediate jobs
      if (immediateJobIds.length > 0) {
        try {
          await Promise.all(
            immediateJobIds.map((id) =>
              fetch(`http://localhost:3001/api/process/${id}`, {
                method: 'POST',
                signal: AbortSignal.timeout(5000),
              }),
            ),
          );
          await fetch('http://localhost:3001/api/process-pending', {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
          });
        } catch { /* local server might not be running */ }
      }

      const immCount = immediateJobIds.length;
      const schedCount = entries.length - immCount;
      const parts = [];
      if (immCount) parts.push(`${immCount} queued now`);
      if (schedCount) parts.push(`${schedCount} scheduled`);

      toast({
        title: `${entries.length} upload(s) saved!`,
        description: parts.join(', '),
      });
      setEntries([]);
      queryClient.invalidateQueries({ queryKey: ['scheduled_uploads'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
      setSaveProgress('');
    }
  };

  const handleDeleteScheduled = async (id: string) => {
    await deleteScheduledUpload(id);
    queryClient.invalidateQueries({ queryKey: ['scheduled_uploads'] });
    toast({ title: 'Removed' });
  };

  const minDateTime = toLocalDateTimeInputValue(new Date(Date.now() + 5 * 60000));

  return (
    <div className="space-y-6">
      {/* New entry form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="w-4 h-4" />
            Schedule a New Upload
          </CardTitle>
          <CardDescription>
            Upload a file or point to a local folder for auto-pickup
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Source mode toggle — folder only available in local mode */}
          {uploadMode === 'local' && (
            <Tabs value={sourceMode} onValueChange={(v) => setSourceMode(v as 'file' | 'folder')} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="file" className="gap-1.5 text-xs">
                  <FileVideo className="w-3.5 h-3.5" />
                  Upload File
                </TabsTrigger>
                <TabsTrigger value="folder" className="gap-1.5 text-xs">
                  <FolderOpen className="w-3.5 h-3.5" />
                  Local Folder
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          {/* FILE mode */}
          {sourceMode === 'file' && (
            <>
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
                className={`w-full flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-5 text-center transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] ${
                  videoFile ? 'border-primary/50 bg-primary/5' : 'border-border'
                }`}
              >
                {videoFile ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-primary" />
                    <span className="text-xs font-medium truncate max-w-full">{videoFile.name}</span>
                  </>
                ) : (
                  <>
                    <FileVideo className="w-5 h-5 text-muted-foreground" />
                    <span className="text-xs font-medium">Select Video</span>
                  </>
                )}
              </button>
            </>
          )}

          {/* FOLDER mode */}
          {sourceMode === 'folder' && (
            <div className="space-y-2">
              <Label className="text-xs">Folder Path</Label>
              <Input
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="C:\Videos\uploads or /home/user/videos"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                System will auto-pick the latest video + matching .txt file from this folder at scheduled time.
              </p>
            </div>
          )}

          {/* Metadata fields */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="camp-title" className="text-xs">
                Title {sourceMode === 'file' && <span className="text-destructive">*</span>}
                {sourceMode === 'folder' && <span className="text-muted-foreground">(optional, auto from .txt)</span>}
              </Label>
              <Input
                id="camp-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={sourceMode === 'folder' ? 'Auto-filled from .txt if available' : 'Video title'}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="camp-desc" className="text-xs">Description</Label>
              <Textarea
                id="camp-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description…"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="camp-tags" className="text-xs">Tags</Label>
              <Input
                id="camp-tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="tag1, tag2, tag3"
              />
            </div>

            {/* Optional txt import */}
            <div className="flex items-center gap-2">
              <input
                ref={textInputRef}
                type="file"
                accept=".txt,text/plain"
                className="hidden"
                onChange={handleTextSelect}
              />
              {textFileName ? (
                <Badge variant="secondary" className="gap-1 text-xs">
                  <FileText className="w-3 h-3" />
                  {textFileName}
                  <button onClick={clearTextFile} className="ml-1 hover:text-destructive">
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1.5 h-7"
                  onClick={() => textInputRef.current?.click()}
                >
                  <FileText className="w-3.5 h-3.5" />
                  Import from .txt
                </Button>
              )}
            </div>
          </div>

          {/* Platforms */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">Platforms</Label>
            <div className="flex flex-wrap gap-2">
              {['youtube', 'tiktok', 'instagram'].map((p) => (
                <Button
                  key={p}
                  variant={platforms.includes(p) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => togglePlatform(p)}
                  className="capitalize"
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>

          {/* Date/time */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">
              Scheduled Date & Time
            </Label>
            <Input
              type="datetime-local"
              min={minDateTime}
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </div>

          {/* Add button */}
          <Button
            onClick={addEntry}
            disabled={!canAdd}
            variant="outline"
            className="w-full gap-2"
          >
            <Plus className="w-4 h-4" />
            Add to Campaign
          </Button>
        </CardContent>
      </Card>

      {/* Pending entries */}
      {entries.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Campaign Queue ({entries.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {entries.map((entry, idx) => (
              <div key={idx} className="flex items-center justify-between rounded-lg border p-3 gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {entry.folderPath ? (
                      <span className="flex items-center gap-1">
                        <FolderOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        {entry.folderPath}
                      </span>
                    ) : (
                      entry.title || entry.videoFile?.name
                    )}
                  </p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                    <Clock className="w-3 h-3 shrink-0" />
                    <span>{format(new Date(entry.scheduledAt), 'PPp')}</span>
                    <span>·</span>
                    <span className="capitalize">{entry.platforms.join(', ')}</span>
                  </div>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1.5 text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove from campaign?</AlertDialogTitle>
                      <AlertDialogDescription>This entry will be removed from the campaign queue.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => removeEntry(idx)} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Remove</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
            <Button onClick={saveAll} disabled={saving} className="w-full gap-2 mt-2">
              <CalendarClock className="w-4 h-4" />
              {saving ? (saveProgress || 'Saving…') : `Schedule ${entries.length} Upload${entries.length > 1 ? 's' : ''}`}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Already scheduled */}
      {scheduled.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Scheduled Uploads</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {scheduled.map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-lg border p-3 gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{item.title || item.video_file_name}</p>
                    {item.video_storage_path && (
                      <a
                        href={getVideoUrl(item.video_storage_path)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0"
                      >
                        <Video className="w-3.5 h-3.5 text-muted-foreground hover:text-primary" />
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground flex-wrap">
                    <Clock className="w-3 h-3 shrink-0" />
                    <span>{format(new Date(item.scheduled_at), 'PPp')}</span>
                    <span>·</span>
                    <span className="capitalize">{item.target_platforms.join(', ')}</span>
                    <span>·</span>
                    <Badge
                      variant="secondary"
                      className={`text-[10px] px-1.5 py-0 ${
                        item.status === 'scheduled'
                          ? 'bg-amber-100 text-amber-700'
                          : item.status === 'completed'
                          ? 'bg-emerald-100 text-emerald-700'
                          : item.status === 'processing'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-destructive/10 text-destructive'
                      }`}
                    >
                      {item.status}
                    </Badge>
                  </div>
                </div>
                {item.status === 'scheduled' && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-1.5 text-muted-foreground hover:text-destructive shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete scheduled upload?</AlertDialogTitle>
                        <AlertDialogDescription>This scheduled upload will be permanently removed.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => handleDeleteScheduled(item.id)} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Delete</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Info */}
      {entries.length === 0 && scheduled.length === 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
          <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-muted-foreground">
            <p className="font-medium text-foreground mb-1">How campaigns work</p>
            <ol className="list-decimal list-inside space-y-1 text-xs">
              <li>Add videos with scheduled times (upload file or set folder path)</li>
              <li>For folder mode, the system picks the latest video + matching .txt automatically</li>
              <li>Uploads are processed at their scheduled times</li>
              <li>You get Telegram notifications for each completed upload</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
