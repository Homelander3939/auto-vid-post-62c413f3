import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createScheduledUpload,
  getScheduledUploads,
  deleteScheduledUpload,
  parseTextContent,
  uploadVideoFile,
  getVideoUrl,
  type VideoMetadata,
  type ScheduledUpload,
} from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';

interface ScheduleEntry {
  videoFile: File;
  textContent: string;
  textFileName: string;
  metadata: VideoMetadata;
  scheduledAt: string;
  platforms: string[];
}

export default function CampaignScheduler() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [currentEntry, setCurrentEntry] = useState<Partial<ScheduleEntry>>({});
  const [saving, setSaving] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  const { data: scheduled = [] } = useQuery({
    queryKey: ['scheduled_uploads'],
    queryFn: getScheduledUploads,
    refetchInterval: 5000,
  });

  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCurrentEntry((prev) => ({ ...prev, videoFile: file }));
  };

  const handleTextSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseTextContent(text);
      setCurrentEntry((prev) => ({
        ...prev,
        textContent: text,
        textFileName: file.name,
        metadata: parsed,
        platforms: prev.platforms || parsed.platforms,
      }));
    } catch {
      toast({ title: 'Could not read text file', variant: 'destructive' });
    }
  };

  const togglePlatform = (p: string) => {
    setCurrentEntry((prev) => {
      const current = prev.platforms || ['youtube', 'tiktok', 'instagram'];
      const next = current.includes(p)
        ? current.filter((x) => x !== p)
        : [...current, p];
      return { ...prev, platforms: next };
    });
  };

  const addEntry = () => {
    if (!currentEntry.videoFile || !currentEntry.metadata || !currentEntry.scheduledAt) {
      toast({ title: 'Select video, text file, and schedule time', variant: 'destructive' });
      return;
    }
    const entry: ScheduleEntry = {
      videoFile: currentEntry.videoFile,
      textContent: currentEntry.textContent || '',
      textFileName: currentEntry.textFileName || '',
      metadata: currentEntry.metadata,
      scheduledAt: currentEntry.scheduledAt,
      platforms: currentEntry.platforms || ['youtube', 'tiktok', 'instagram'],
    };
    setEntries((prev) => [...prev, entry]);
    setCurrentEntry({});
    if (videoInputRef.current) videoInputRef.current.value = '';
    if (textInputRef.current) textInputRef.current.value = '';
    toast({ title: 'Entry added to campaign' });
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
    try {
      for (const entry of entries) {
        const storagePath = await uploadVideoFile(entry.videoFile);
        await createScheduledUpload(
          entry.videoFile.name,
          storagePath,
          entry.metadata,
          entry.platforms,
          entry.scheduledAt
        );
      }
      toast({
        title: `${entries.length} upload(s) scheduled!`,
        description: 'The local server will process them at their scheduled times.',
      });
      setEntries([]);
      queryClient.invalidateQueries({ queryKey: ['scheduled_uploads'] });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteScheduled = async (id: string) => {
    await deleteScheduledUpload(id);
    queryClient.invalidateQueries({ queryKey: ['scheduled_uploads'] });
    toast({ title: 'Scheduled upload removed' });
  };

  const activePlatforms = currentEntry.platforms || ['youtube', 'tiktok', 'instagram'];

  // Get minimum datetime (now + 5min)
  const minDateTime = new Date(Date.now() + 5 * 60000).toISOString().slice(0, 16);

  return (
    <div className="space-y-8">
      {/* Add new scheduled entry */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="w-4 h-4" />
            Schedule a New Upload
          </CardTitle>
          <CardDescription>
            Select files, pick platforms and a date/time, then add to the campaign
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* File selectors */}
          <div className="grid gap-3 sm:grid-cols-2">
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
              className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-5 text-center transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] ${
                currentEntry.videoFile ? 'border-primary/50 bg-primary/5' : 'border-border'
              }`}
            >
              {currentEntry.videoFile ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                  <span className="text-xs font-medium truncate max-w-full">{currentEntry.videoFile.name}</span>
                </>
              ) : (
                <>
                  <FileVideo className="w-5 h-5 text-muted-foreground" />
                  <span className="text-xs font-medium">Select Video</span>
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
              className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-5 text-center transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] ${
                currentEntry.textContent ? 'border-primary/50 bg-primary/5' : 'border-border'
              }`}
            >
              {currentEntry.textContent ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                  <span className="text-xs font-medium truncate max-w-full">{currentEntry.textFileName}</span>
                </>
              ) : (
                <>
                  <FileText className="w-5 h-5 text-muted-foreground" />
                  <span className="text-xs font-medium">Select Text File</span>
                </>
              )}
            </button>
          </div>

          {/* Metadata preview */}
          {currentEntry.metadata && (
            <div className="rounded-lg bg-muted/50 p-3 space-y-1 text-sm">
              <p><span className="font-medium">Title:</span> {currentEntry.metadata.title || '—'}</p>
              <p><span className="font-medium">Description:</span> {currentEntry.metadata.description?.slice(0, 100) || '—'}</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {currentEntry.metadata.tags?.map((t) => (
                  <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Platforms */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">Platforms</Label>
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
          </div>

          {/* Date/time picker */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">
              Scheduled Date & Time
            </Label>
            <Input
              type="datetime-local"
              min={minDateTime}
              value={currentEntry.scheduledAt || ''}
              onChange={(e) => setCurrentEntry((prev) => ({ ...prev, scheduledAt: e.target.value }))}
              className="max-w-xs"
            />
          </div>

          {/* Add button */}
          <Button
            onClick={addEntry}
            disabled={!currentEntry.videoFile || !currentEntry.metadata || !currentEntry.scheduledAt}
            variant="outline"
            className="gap-2"
          >
            <Plus className="w-4 h-4" />
            Add to Campaign
          </Button>
        </CardContent>
      </Card>

      {/* Pending campaign entries (not yet saved) */}
      {entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Campaign Queue ({entries.length} upload{entries.length > 1 ? 's' : ''})
            </CardTitle>
            <CardDescription>Review and save your scheduled uploads</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {entries.map((entry, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{entry.metadata.title || entry.videoFile.name}</p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span>{format(new Date(entry.scheduledAt), 'PPp')}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="capitalize">{entry.platforms.join(', ')}</span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeEntry(idx)}
                  className="h-7 px-1.5 text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
            <Button onClick={saveAll} disabled={saving} className="gap-2 mt-2">
              <CalendarClock className="w-4 h-4" />
              {saving ? 'Saving…' : `Schedule ${entries.length} Upload${entries.length > 1 ? 's' : ''}`}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Already scheduled uploads from database */}
      {scheduled.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scheduled Uploads</CardTitle>
            <CardDescription>
              These will be processed by the local server at their scheduled times
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scheduled.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-lg border p-3"
              >
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
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span>{format(new Date(item.scheduled_at), 'PPp')}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="capitalize">{item.target_platforms.join(', ')}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <Badge
                      variant="secondary"
                      className={
                        item.status === 'scheduled'
                          ? 'bg-amber-100 text-amber-700'
                          : item.status === 'completed'
                          ? 'bg-emerald-100 text-emerald-700'
                          : item.status === 'processing'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-destructive/10 text-destructive'
                      }
                    >
                      {item.status}
                    </Badge>
                  </div>
                </div>
                {item.status === 'scheduled' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteScheduled(item.id)}
                    className="h-7 px-1.5 text-muted-foreground hover:text-destructive shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Info box */}
      {entries.length === 0 && scheduled.length === 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
          <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-muted-foreground">
            <p className="font-medium text-foreground mb-1">How campaigns work</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Add multiple videos with different scheduled times</li>
              <li>Click "Schedule" to save them all to the database</li>
              <li>The local server checks for due uploads and processes them automatically</li>
              <li>You get Telegram notifications for each completed upload</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}