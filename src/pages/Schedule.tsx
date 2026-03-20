import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSchedules, saveSchedule, deleteScheduleConfig, type ScheduleConfig } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect, useMemo } from 'react';
import { Clock, CalendarDays, Repeat, Save, FolderOpen, Timer, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import CampaignScheduler from '@/components/CampaignScheduler';

type FrequencyMode = 'hourly' | 'daily' | 'weekly';
type DurationUnit = 'hours' | 'days' | 'weeks';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clampMinute(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(59, value));
}

function cronToState(cron: string) {
  const parts = cron.split(' ');
  if (parts.length !== 5) return { mode: 'daily' as FrequencyMode, minute: 0, hour: 9, weekdays: [1, 2, 3, 4, 5], interval: 1 };
  const [min, hr, , , dow] = parts;
  const minute = min === '*' ? 0 : parseInt(min) || 0;
  const hour = hr === '*' ? 0 : parseInt(hr.replace('*/', '')) || 9;
  if (hr === '*' || hr.startsWith('*/')) {
    const interval = hr === '*' ? 1 : parseInt(hr.replace('*/', '')) || 1;
    return { mode: 'hourly' as FrequencyMode, minute, hour: interval, weekdays: [1, 2, 3, 4, 5], interval };
  }
  if (dow !== '*') {
    const weekdays = dow.split(',').map(Number).filter((n) => !isNaN(n));
    return { mode: 'weekly' as FrequencyMode, minute, hour, weekdays, interval: 1 };
  }
  return { mode: 'daily' as FrequencyMode, minute, hour, weekdays: [1, 2, 3, 4, 5], interval: 1 };
}

function stateToCron(mode: FrequencyMode, hour: number, minute: number, weekdays: number[], interval: number) {
  switch (mode) {
    case 'hourly': return interval === 1 ? `${minute} * * * *` : `${minute} */${interval} * * *`;
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekly': return `${minute} ${hour} * * ${weekdays.sort().join(',')}`;
  }
}

function humanReadableCron(cron: string) {
  const s = cronToState(cron);
  const timeStr = `${s.hour.toString().padStart(2, '0')}:${s.minute.toString().padStart(2, '0')}`;
  switch (s.mode) {
    case 'hourly': return s.interval === 1 ? `Every hour at :${s.minute.toString().padStart(2, '0')}` : `Every ${s.interval}h at :${s.minute.toString().padStart(2, '0')}`;
    case 'daily': return `Daily at ${timeStr}`;
    case 'weekly': return `${s.weekdays.sort().map(d => DAYS_OF_WEEK[d]).join(', ')} at ${timeStr}`;
  }
}

const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';

// ---- Single schedule editor ----
function ScheduleEditor({ config, onSave, onDelete }: { config: ScheduleConfig; onSave: (c: ScheduleConfig) => void; onDelete?: () => void }) {
  const [expanded, setExpanded] = useState(!config.id); // new ones start expanded
  const [name, setName] = useState(config.name);
  const [enabled, setEnabled] = useState(config.enabled);
  const [folderPath, setFolderPath] = useState(config.folderPath);
  const [platforms, setPlatforms] = useState(config.platforms);
  const [endAt, setEndAt] = useState(config.endAt);

  const parsed = cronToState(config.cronExpression);
  const [mode, setMode] = useState<FrequencyMode>(parsed.mode);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [weekdays, setWeekdays] = useState(parsed.weekdays);
  const [interval, setInterval] = useState(parsed.interval);
  const [useDuration, setUseDuration] = useState(!!config.endAt);
  const [durationAmount, setDurationAmount] = useState(7);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('days');

  const cronExpression = useMemo(() => stateToCron(mode, hour, minute, weekdays, interval), [mode, hour, minute, weekdays, interval]);
  const summary = humanReadableCron(cronExpression);

  useEffect(() => {
    if (!useDuration) { setEndAt(null); return; }
    const ms = durationUnit === 'hours' ? durationAmount * 3600000 : durationUnit === 'days' ? durationAmount * 86400000 : durationAmount * 604800000;
    setEndAt(new Date(Date.now() + ms).toISOString());
  }, [useDuration, durationAmount, durationUnit]);

  const handleSave = () => {
    onSave({ ...config, name, enabled, cronExpression, platforms, folderPath, endAt });
  };

  const togglePlatform = (p: string) => setPlatforms(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);
  const toggleWeekday = (d: number) => setWeekdays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);

  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        {/* Header row */}
        <div className="flex items-center justify-between gap-2">
          <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${enabled ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30'}`} />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{name || 'Untitled Schedule'}</p>
              <p className="text-xs text-muted-foreground">{summary} · {platforms.join(', ')}</p>
            </div>
            {expanded ? <ChevronUp className="w-4 h-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />}
          </button>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {expanded && (
          <div className="space-y-4 pt-2 border-t">
            {/* Name */}
            <div className="space-y-1.5">
              <Label className="text-xs">Schedule Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daily YouTube Upload" />
            </div>

            {/* Frequency */}
            <div className="space-y-3">
              <Label className="text-xs flex items-center gap-1.5"><Repeat className="w-3.5 h-3.5" /> Frequency</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['hourly', 'daily', 'weekly'] as FrequencyMode[]).map(m => (
                  <Button key={m} variant={mode === m ? 'default' : 'outline'} size="sm" onClick={() => setMode(m)} className="capitalize">{m}</Button>
                ))}
              </div>

              {mode === 'hourly' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Every N hours</Label>
                    <Select value={String(interval)} onValueChange={v => setInterval(Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{[1, 2, 3, 4, 6, 8, 12].map(n => <SelectItem key={n} value={String(n)}>{n}h</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">At minute (0-59)</Label>
                    <Input type="number" min={0} max={59} value={minute} onChange={e => setMinute(clampMinute(parseInt(e.target.value, 10)))} />
                  </div>
                </div>
              )}

              {mode === 'daily' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Hour</Label>
                    <Select value={String(hour)} onValueChange={v => setHour(Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{HOURS.map(h => <SelectItem key={h} value={String(h)}>{h.toString().padStart(2, '0')}:00</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Minute (0-59)</Label>
                    <Input type="number" min={0} max={59} value={minute} onChange={e => setMinute(clampMinute(parseInt(e.target.value, 10)))} />
                  </div>
                </div>
              )}

              {mode === 'weekly' && (
                <>
                  <div>
                    <Label className="text-xs mb-2 block">Days</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {DAYS_OF_WEEK.map((d, i) => (
                        <Button key={i} variant={weekdays.includes(i) ? 'default' : 'outline'} size="sm" onClick={() => toggleWeekday(i)} className="w-11 h-9 text-xs px-0">{d}</Button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Hour</Label>
                      <Select value={String(hour)} onValueChange={v => setHour(Number(v))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{HOURS.map(h => <SelectItem key={h} value={String(h)}>{h.toString().padStart(2, '0')}:00</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Minute (0-59)</Label>
                      <Input type="number" min={0} max={59} value={minute} onChange={e => setMinute(clampMinute(parseInt(e.target.value, 10)))} />
                    </div>
                  </div>
                </>
              )}

              <p className="text-xs text-muted-foreground">Time zone: <span className="font-medium">{localTimeZone}</span></p>
            </div>

            {/* Folder */}
            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1.5"><FolderOpen className="w-3.5 h-3.5" /> Source Folder</Label>
              <Input value={folderPath} onChange={e => setFolderPath(e.target.value)} placeholder="D:\AI Video" className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">Picks latest video + .txt automatically. If no .txt, metadata is generated from filename.</p>
            </div>

            {/* Duration */}
            <div className="space-y-2">
              <Label className="text-xs flex items-center gap-1.5"><Timer className="w-3.5 h-3.5" /> Duration</Label>
              <div className="flex items-center gap-3">
                <Switch checked={useDuration} onCheckedChange={setUseDuration} />
                <span className="text-xs">{useDuration ? 'Runs for set duration' : 'Runs indefinitely'}</span>
              </div>
              {useDuration && (
                <div className="grid grid-cols-2 gap-3">
                  <Input type="number" min={1} value={durationAmount} onChange={e => setDurationAmount(Math.max(1, parseInt(e.target.value) || 1))} />
                  <Select value={durationUnit} onValueChange={v => setDurationUnit(v as DurationUnit)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hours">Hours</SelectItem>
                      <SelectItem value="days">Days</SelectItem>
                      <SelectItem value="weeks">Weeks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Platforms */}
            <div>
              <Label className="text-xs mb-2 block">Platforms</Label>
              <div className="flex flex-wrap gap-2">
                {['youtube', 'tiktok', 'instagram'].map(p => (
                  <Button key={p} variant={platforms.includes(p) ? 'default' : 'outline'} size="sm" onClick={() => togglePlatform(p)} className="capitalize">{p}</Button>
                ))}
              </div>
            </div>

            {/* Summary + actions */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground border-t pt-3">
              <Clock className="w-3.5 h-3.5 text-primary" />
              <span>{summary}</span>
              <code className="bg-muted px-1 rounded font-mono">{cronExpression}</code>
              {endAt && <span>· Ends {new Date(endAt).toLocaleDateString()}</span>}
            </div>

            <div className="flex gap-2">
              <Button onClick={handleSave} className="flex-1 gap-2" size="sm">
                <Save className="w-3.5 h-3.5" /> Save
              </Button>
              {onDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="text-destructive hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
                      <AlertDialogDescription>"{name}" will be permanently removed.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onDelete} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Main page ----
export default function Schedule() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: schedules = [] } = useQuery({
    queryKey: ['schedules'],
    queryFn: getSchedules,
  });

  const [newSchedules, setNewSchedules] = useState<ScheduleConfig[]>([]);

  const handleSave = async (config: ScheduleConfig) => {
    const saved = await saveSchedule(config);
    // If it was a new unsaved one, remove from newSchedules
    if (!config.id) {
      setNewSchedules(prev => prev.filter(s => s !== config));
    }
    qc.invalidateQueries({ queryKey: ['schedules'] });
    toast({ title: 'Schedule saved', description: saved.enabled ? humanReadableCron(saved.cronExpression) : 'Disabled' });
  };

  const handleDelete = async (id: number) => {
    await deleteScheduleConfig(id);
    qc.invalidateQueries({ queryKey: ['schedules'] });
    toast({ title: 'Schedule deleted' });
  };

  const addNew = () => {
    setNewSchedules(prev => [...prev, {
      name: `Schedule ${schedules.length + prev.length + 1}`,
      enabled: false,
      cronExpression: '0 9 * * *',
      platforms: ['youtube'],
      folderPath: '',
      endAt: null,
    }]);
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scheduled Uploads</h1>
        <p className="text-sm text-muted-foreground mt-1">Create multiple recurring schedules or plan individual uploads</p>
      </div>

      {/* Recurring schedules */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Recurring Schedules</h2>
          <Button onClick={addNew} variant="outline" size="sm" className="gap-1.5">
            <Plus className="w-3.5 h-3.5" /> New Schedule
          </Button>
        </div>

        {schedules.map(s => (
          <ScheduleEditor key={s.id} config={s} onSave={handleSave} onDelete={() => handleDelete(s.id!)} />
        ))}
        {newSchedules.map((s, i) => (
          <ScheduleEditor key={`new-${i}`} config={s} onSave={handleSave} onDelete={() => setNewSchedules(prev => prev.filter((_, j) => j !== i))} />
        ))}

        {schedules.length === 0 && newSchedules.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No recurring schedules yet. Click "New Schedule" to create one.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Individual scheduled uploads */}
      <div className="space-y-4">
        <h2 className="text-lg font-medium">Individual Scheduled Uploads</h2>
        <CampaignScheduler />
      </div>
    </div>
  );
}
