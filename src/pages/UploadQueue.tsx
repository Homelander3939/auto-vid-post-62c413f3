import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getQueue, getSettings, getScheduledUploads, getSchedules, deleteScheduledUpload, retryJob, deleteJob, clearQueue, stopJob, getVideoUrl, type UploadJob, type PlatformResult, type ScheduledUpload, type ScheduleConfig } from '@/lib/storage';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { RefreshCw, ExternalLink, Inbox, Trash2, Video, Monitor, Cloud, Pencil, Save, X, ChevronDown, ChevronUp, StopCircle, CalendarClock, Repeat, Eye } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import AITasksPanel from '@/components/AITasksPanel';

const statusColors: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  uploading: 'bg-blue-100 text-blue-700',
  processing: 'bg-blue-100 text-blue-700',
  success: 'bg-emerald-100 text-emerald-700',
  completed: 'bg-emerald-100 text-emerald-700',
  partial: 'bg-orange-100 text-orange-700',
  error: 'bg-destructive/10 text-destructive',
  failed: 'bg-destructive/10 text-destructive',
};

const statusLabels: Record<string, string> = {
  pending: 'queued',
  uploading: 'uploading…',
  processing: 'processing…',
  success: 'uploaded',
  completed: 'completed',
  partial: 'partial',
  error: 'failed',
  failed: 'failed',
};

/* ── Edit Dialog ─────────────────────────── */

function EditJobDialog({
  job,
  open,
  onClose,
}: {
  job: UploadJob;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(job.title);
  const [description, setDescription] = useState(job.description);
  const [tags, setTags] = useState(job.tags.join(', '));
  const [platforms, setPlatforms] = useState(job.target_platforms);
  const [saving, setSaving] = useState(false);

  const allPlatforms = ['youtube', 'tiktok', 'instagram'];

  const togglePlatform = (p: string) => {
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    const newTags = tags.split(',').map((t) => t.trim()).filter(Boolean);
    const platformResults = platforms.map((p) => {
      const existing = job.platform_results.find((r) => r.name === p);
      return existing || { name: p, status: 'pending' as const };
    });

    const { error } = await supabase
      .from('upload_jobs')
      .update({
        title,
        description,
        tags: newTags,
        target_platforms: platforms,
        platform_results: platformResults as any,
      })
      .eq('id', job.id);

    setSaving(false);
    if (error) {
      toast({ title: 'Save failed', description: error.message, variant: 'destructive' });
    } else {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      toast({ title: 'Job updated' });
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Upload Job</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Tags (comma separated)</label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag1, tag2, tag3" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Platforms</label>
            <div className="flex gap-2">
              {allPlatforms.map((p) => (
                <button
                  key={p}
                  onClick={() => togglePlatform(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors capitalize ${
                    platforms.includes(p)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-secondary text-muted-foreground border-border hover:bg-secondary/80'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="gap-1.5">
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Job Card ─────────────────────────────── */

function JobCard({ job }: { job: UploadJob }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

  const overallStatus = job.status || 'pending';
  const overallColor = statusColors[overallStatus] || 'bg-secondary text-secondary-foreground';

  const handleRetry = async () => {
    await retryJob(job.id);
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    toast({ title: 'Retrying upload' });
  };

  const handleDelete = async () => {
    await deleteJob(job.id);
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    toast({ title: 'Job deleted' });
  };

  const handleStop = async () => {
    await stopJob(job.id);
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    toast({ title: 'Job stopped', description: 'Browser session terminated.' });
  };

  const isActive = ['pending', 'processing', 'uploading'].includes(overallStatus);

  const videoUrl = job.video_storage_path ? getVideoUrl(job.video_storage_path) : null;
  const isVideo = job.video_file_name?.match(/\.(mp4|mov|avi|mkv|webm)$/i);

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <CardTitle className="text-sm font-medium truncate">
                {job.title || job.video_file_name}
              </CardTitle>
              <Badge className={overallColor} variant="secondary">
                {statusLabels[overallStatus] || overallStatus}
              </Badge>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[11px] text-muted-foreground tabular-nums mr-2 hidden sm:inline">
                {new Date(job.created_at).toLocaleString()}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}
                className="h-7 px-1.5 text-muted-foreground">
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}
                className="h-7 px-1.5 text-muted-foreground hover:text-primary">
                <Pencil className="w-3 h-3" />
              </Button>
              {(overallStatus === 'failed' || overallStatus === 'error') && (
                <Button variant="ghost" size="sm" onClick={handleRetry}
                  className="h-7 px-1.5 text-muted-foreground hover:text-primary">
                  <RefreshCw className="w-3 h-3" />
                </Button>
              )}
              {isActive && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm"
                      className="h-7 px-1.5 text-muted-foreground hover:text-amber-600">
                      <StopCircle className="w-3 h-3" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Stop this upload?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will cancel the upload and terminate the browser session. Credits for the session will stop being used.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep Running</AlertDialogCancel>
                      <AlertDialogAction onClick={handleStop} className="bg-amber-600 hover:bg-amber-700">Stop Upload</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm"
                    className="h-7 px-1.5 text-muted-foreground hover:text-destructive">
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this job?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. {isActive && 'The active browser session will also be terminated.'}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-0 space-y-3">
          {/* Video preview */}
          {videoUrl && isVideo && (
            <div className="rounded-lg overflow-hidden border bg-black/5 max-w-sm">
              <video src={videoUrl} controls preload="metadata" className="w-full max-h-48" />
              <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary/50 text-xs">
                <Video className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="truncate flex-1 text-muted-foreground">{job.video_file_name}</span>
                <a href={videoUrl} target="_blank" rel="noopener noreferrer"
                  className="text-primary hover:underline flex items-center gap-1">
                  Open <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}

          {videoUrl && !isVideo && (
            <a href={videoUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-xs text-primary hover:underline">
              <Video className="w-3.5 h-3.5" /> {job.video_file_name} <ExternalLink className="w-3 h-3" />
            </a>
          )}

          {/* Platform results */}
          {job.platform_results.length > 0 && (
            <div className="space-y-2">
              {job.platform_results.map((p: PlatformResult) => (
                <div key={p.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="capitalize text-sm font-medium w-20">{p.name}</span>
                    <Badge className={statusColors[p.status] || ''} variant="secondary">
                      {statusLabels[p.status] || p.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {Array.isArray(p.recentStats) && p.recentStats.length > 0 && (
                      <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                        <Eye className="w-3 h-3" />
                        {p.recentStats[0]?.views || '—'}
                      </span>
                    )}
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noopener noreferrer"
                        className="text-primary hover:underline text-xs flex items-center gap-1">
                        View <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {p.error && <span className="text-xs text-destructive truncate max-w-48">{p.error}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {job.platform_results.length === 0 && job.target_platforms.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Platforms: {job.target_platforms.join(', ')}
            </p>
          )}

          {/* Expanded details */}
          {expanded && (
            <div className="border-t pt-3 space-y-2 text-xs">
              {job.title && (
                <div><span className="font-medium text-muted-foreground">Title:</span> {job.title}</div>
              )}
              {job.description && (
                <div><span className="font-medium text-muted-foreground">Description:</span> {job.description}</div>
              )}
              {job.tags.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="font-medium text-muted-foreground">Tags:</span>
                  {job.tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-[10px] px-1.5 py-0 h-5">{t}</Badge>
                  ))}
                </div>
              )}
              <div><span className="font-medium text-muted-foreground">File:</span> {job.video_file_name}</div>
              <div><span className="font-medium text-muted-foreground">ID:</span> <code className="text-[10px] text-muted-foreground">{job.id}</code></div>
              {job.completed_at && (
                <div><span className="font-medium text-muted-foreground">Completed:</span> {new Date(job.completed_at).toLocaleString()}</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {editing && <EditJobDialog job={job} open={editing} onClose={() => setEditing(false)} />}
    </>
  );
}

/* ── Scheduled Upload Card ────────────────── */

function ScheduledCard({ item, onDelete }: { item: ScheduledUpload; onDelete: () => void }) {
  const scheduledDate = new Date(item.scheduled_at);
  const now = new Date();
  const isOverdue = scheduledDate < now;
  const timeStr = scheduledDate.toLocaleString();

  return (
    <Card className="overflow-hidden border-dashed">
      <CardContent className="py-3 px-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <CalendarClock className="w-4 h-4 text-primary shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{item.title || item.video_file_name}</p>
              <p className="text-xs text-muted-foreground">
                {isOverdue ? 'Processing soon' : `Scheduled: ${timeStr}`} · {item.target_platforms.join(', ')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Badge className={isOverdue ? 'bg-blue-100 text-blue-700' : 'bg-violet-100 text-violet-700'} variant="secondary">
              {isOverdue ? 'due' : 'upcoming'}
            </Badge>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-1.5 text-muted-foreground hover:text-destructive">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel this scheduled upload?</AlertDialogTitle>
                  <AlertDialogDescription>This will remove the scheduled upload permanently.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Cancel Upload</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Main Queue Page ──────────────────────── */

export default function UploadQueue() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['queue'],
    queryFn: () => getQueue(),
    refetchInterval: 3000,
  });

  const { data: scheduledUploads = [] } = useQuery({
    queryKey: ['scheduled_uploads'],
    queryFn: () => getScheduledUploads(),
    refetchInterval: 5000,
  });

  const { data: recurringSchedules = [] } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => getSchedules(),
    refetchInterval: 10000,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const isCloud = settings?.uploadMode === 'cloud';
  const upcomingUploads = scheduledUploads.filter(s => s.status === 'scheduled');
  const activeRecurring = recurringSchedules.filter(s => s.enabled);

  const handleClear = async () => {
    for (const job of jobs) {
      if (['pending', 'processing', 'uploading'].includes(job.status)) {
        await stopJob(job.id);
      }
    }
    await clearQueue();
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    toast({ title: 'Queue cleared' });
  };

  const handleDeleteScheduled = async (id: string) => {
    await deleteScheduledUpload(id);
    queryClient.invalidateQueries({ queryKey: ['scheduled_uploads'] });
    toast({ title: 'Scheduled upload cancelled' });
  };

  const hasPending = jobs.some((j) =>
    j.platform_results.some((p: PlatformResult) => p.status === 'pending')
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Job Queue</h1>
          <p className="text-sm text-muted-foreground mt-1">Track and manage upload jobs</p>
        </div>
        {jobs.length > 0 && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 text-muted-foreground">
                <Trash2 className="w-3.5 h-3.5" />
                Clear All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear entire queue?</AlertDialogTitle>
                <AlertDialogDescription>
                  All jobs will be deleted and any active browser sessions will be stopped. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleClear} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Clear All</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Top section: AI agent tasks (post generations, research, image-search) */}
      <AITasksPanel />

      {hasPending && (
        <div className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${
          isCloud
            ? 'border-emerald-200 bg-emerald-50'
            : 'border-amber-200 bg-amber-50'
        }`}>
          {isCloud ? (
            <Cloud className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <Monitor className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          )}
          <div>
            <p className={`font-medium ${isCloud ? 'text-emerald-800' : 'text-amber-800'}`}>
              {isCloud ? 'Cloud upload queued' : 'Waiting for local server'}
            </p>
            <p className={`mt-0.5 ${isCloud ? 'text-emerald-700' : 'text-amber-700'}`}>
              {isCloud
                ? 'Pending jobs will be uploaded via Browserbase cloud browser automatically.'
                : 'Pending jobs will be processed when your local server is running.'}
            </p>
          </div>
        </div>
      )}

      {/* Active recurring schedules */}
      {activeRecurring.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <Repeat className="w-4 h-4" /> Active Recurring Schedules ({activeRecurring.length})
          </h2>
          {activeRecurring.map((sched) => (
            <Card key={sched.id} className="overflow-hidden border-dashed">
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Repeat className="w-4 h-4 text-primary shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{sched.name || 'Recurring Schedule'}</p>
                      <p className="text-xs text-muted-foreground">
                        Cron: {sched.cronExpression} · {sched.platforms.join(', ')}
                        {sched.folderPath && ` · ${sched.folderPath}`}
                        {sched.endAt && ` · ends ${new Date(sched.endAt).toLocaleDateString()}`}
                      </p>
                    </div>
                  </div>
                  <Badge className="bg-emerald-100 text-emerald-700" variant="secondary">active</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Upcoming scheduled uploads */}
      {upcomingUploads.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <CalendarClock className="w-4 h-4" /> Upcoming Scheduled ({upcomingUploads.length})
          </h2>
          {upcomingUploads.map((item) => (
            <ScheduledCard key={item.id} item={item} onDelete={() => handleDeleteScheduled(item.id)} />
          ))}
        </div>
      )}

      {jobs.length === 0 && upcomingUploads.length === 0 && activeRecurring.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Inbox className="w-10 h-10 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">Queue is empty</h2>
          <p className="text-sm text-muted-foreground">
            Upload a video from the Dashboard or AI Chat to see jobs here.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </div>
    </div>
  );
}
