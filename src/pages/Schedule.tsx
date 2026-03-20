import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSchedule, saveSchedule, type ScheduleConfig } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect, useMemo } from 'react';
import { Clock, CalendarDays, Repeat, Save, FolderOpen, Timer } from 'lucide-react';
import CampaignScheduler from '@/components/CampaignScheduler';

type FrequencyMode = 'hourly' | 'daily' | 'weekly' | 'custom';
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
    case 'hourly':
      return interval === 1 ? `${minute} * * * *` : `${minute} */${interval} * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekdays.sort().join(',')}`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

export default function Schedule() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['schedule'],
    queryFn: () => getSchedule(),
  });

  const [config, setConfig] = useState<ScheduleConfig>({
    enabled: false,
    cronExpression: '0 9 * * *',
    platforms: ['youtube', 'tiktok', 'instagram'],
    folderPath: '',
    endAt: null,
  });

  const [mode, setMode] = useState<FrequencyMode>('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [interval, setInterval] = useState(1);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);

  // Duration controls
  const [useDuration, setUseDuration] = useState(false);
  const [durationAmount, setDurationAmount] = useState(7);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('days');

  const localTimeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time',
    []
  );

  useEffect(() => {
    if (data) {
      setConfig(data);
      const parsed = cronToState(data.cronExpression);
      setMode(parsed.mode);
      setHour(parsed.hour);
      setMinute(parsed.minute);
      setWeekdays(parsed.weekdays);
      setInterval(parsed.interval);
      setUseDuration(!!data.endAt);
    }
  }, [data]);

  // Update cron when UI changes
  useEffect(() => {
    const cron = stateToCron(mode, hour, minute, weekdays, interval);
    setConfig((prev) => ({ ...prev, cronExpression: cron }));
  }, [mode, hour, minute, weekdays, interval]);

  // Compute endAt from duration
  useEffect(() => {
    if (!useDuration) {
      setConfig((prev) => ({ ...prev, endAt: null }));
      return;
    }
    const now = new Date();
    const ms = durationUnit === 'hours' ? durationAmount * 3600000
      : durationUnit === 'days' ? durationAmount * 86400000
      : durationAmount * 604800000;
    setConfig((prev) => ({ ...prev, endAt: new Date(now.getTime() + ms).toISOString() }));
  }, [useDuration, durationAmount, durationUnit]);

  const toggleWeekday = (day: number) => {
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  const togglePlatform = (p: string) => {
    setConfig((prev) => ({
      ...prev,
      platforms: prev.platforms.includes(p)
        ? prev.platforms.filter((x) => x !== p)
        : [...prev.platforms, p],
    }));
  };

  const handleMinuteInput = (value: string) => {
    setMinute(clampMinute(parseInt(value, 10)));
  };

  const handleSave = async () => {
    await saveSchedule(config);
    queryClient.invalidateQueries({ queryKey: ['schedule'] });
    toast({
      title: 'Schedule saved',
      description: config.enabled
        ? `Active: ${humanReadable}`
        : 'Schedule disabled',
    });
  };

  const humanReadable = useMemo(() => {
    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    switch (mode) {
      case 'hourly':
        return interval === 1 ? `Every hour at :${minute.toString().padStart(2, '0')}` : `Every ${interval} hours at :${minute.toString().padStart(2, '0')}`;
      case 'daily':
        return `Daily at ${timeStr}`;
      case 'weekly':
        const dayNames = weekdays.sort().map((d) => DAYS_OF_WEEK[d]).join(', ');
        return `${dayNames} at ${timeStr}`;
      default:
        return config.cronExpression;
    }
  }, [mode, hour, minute, weekdays, interval, config.cronExpression]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scheduled Uploads</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Set automatic recurring schedules or plan individual uploads
        </p>
      </div>

      {/* ===== RECURRING SCHEDULE SECTION ===== */}
      <div className="space-y-4">
        <h2 className="text-lg font-medium">Recurring Schedule</h2>

        {/* Enable toggle */}
        <Card>
          <CardContent className="flex items-center justify-between py-4 px-5">
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${config.enabled ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30'}`} />
              <div>
                <p className="text-sm font-medium">{config.enabled ? 'Schedule Active' : 'Schedule Disabled'}</p>
                <p className="text-xs text-muted-foreground">{humanReadable}</p>
              </div>
            </div>
            <Switch
              checked={config.enabled}
              onCheckedChange={(enabled) => setConfig((p) => ({ ...p, enabled }))}
            />
          </CardContent>
        </Card>

        {/* Frequency mode */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Repeat className="w-4 h-4" /> Frequency
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {(['hourly', 'daily', 'weekly'] as FrequencyMode[]).map((m) => (
                <Button
                  key={m}
                  variant={mode === m ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMode(m)}
                  className="capitalize"
                >
                  {m}
                </Button>
              ))}
            </div>

            {mode === 'hourly' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Every N hours</Label>
                  <Select value={String(interval)} onValueChange={(v) => setInterval(Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                        <SelectItem key={n} value={String(n)}>{n} {n === 1 ? 'hour' : 'hours'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">At minute (0-59)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(e) => handleMinuteInput(e.target.value)}
                  />
                </div>
              </div>
            )}

            {mode === 'daily' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Hour</Label>
                  <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {HOURS.map((h) => (
                        <SelectItem key={h} value={String(h)}>{h.toString().padStart(2, '0')}:00</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Minute (0-59)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(e) => handleMinuteInput(e.target.value)}
                  />
                </div>
              </div>
            )}

            {mode === 'weekly' && (
              <div className="space-y-4">
                <div>
                  <Label className="text-xs mb-2 block">Days</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS_OF_WEEK.map((name, i) => (
                      <Button
                        key={i}
                        variant={weekdays.includes(i) ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => toggleWeekday(i)}
                        className="w-11 h-9 text-xs px-0"
                      >
                        {name}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Hour</Label>
                    <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {HOURS.map((h) => (
                          <SelectItem key={h} value={String(h)}>{h.toString().padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Minute (0-59)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={59}
                      value={minute}
                      onChange={(e) => handleMinuteInput(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Scheduler uses your local machine time zone: <span className="font-medium">{localTimeZone}</span>
            </p>
          </CardContent>
        </Card>

        {/* Calendar preview for weekly */}
        {mode === 'weekly' && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarDays className="w-4 h-4" /> Calendar Preview
              </CardTitle>
              <CardDescription className="text-xs">
                Highlighted days show when uploads run
              </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-center">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={setSelectedDate}
                className="pointer-events-auto"
                modifiers={{
                  scheduled: (date) => weekdays.includes(date.getDay()),
                }}
                modifiersClassNames={{
                  scheduled: 'bg-primary/15 text-primary font-medium',
                }}
              />
            </CardContent>
          </Card>
        )}

        {/* Folder Path for recurring */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FolderOpen className="w-4 h-4" /> Source Folder
            </CardTitle>
            <CardDescription className="text-xs">
              When the cron fires, the server will pick the latest video + .txt from this folder
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              value={config.folderPath}
              onChange={(e) => setConfig((p) => ({ ...p, folderPath: e.target.value }))}
              placeholder="C:\Videos\scheduled or /home/user/videos"
              className="font-mono text-xs"
            />
          </CardContent>
        </Card>

        {/* Duration */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Timer className="w-4 h-4" /> Duration
            </CardTitle>
            <CardDescription className="text-xs">
              How long should the recurring schedule run?
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <Switch checked={useDuration} onCheckedChange={setUseDuration} />
              <span className="text-sm">{useDuration ? 'Runs for a set duration' : 'Runs indefinitely'}</span>
            </div>
            {useDuration && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Amount</Label>
                  <Input
                    type="number"
                    min={1}
                    value={durationAmount}
                    onChange={(e) => setDurationAmount(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Unit</Label>
                  <Select value={durationUnit} onValueChange={(v) => setDurationUnit(v as DurationUnit)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hours">Hours</SelectItem>
                      <SelectItem value="days">Days</SelectItem>
                      <SelectItem value="weeks">Weeks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Platforms */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Target Platforms</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {['youtube', 'tiktok', 'instagram'].map((p) => (
                <Button
                  key={p}
                  variant={config.platforms.includes(p) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => togglePlatform(p)}
                  className="capitalize"
                >
                  {p}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Summary + Save */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-5 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-primary" />
              <span className="font-medium">{humanReadable}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Platforms: {config.platforms.join(', ')} · Cron: <code className="font-mono bg-muted px-1 rounded">{config.cronExpression}</code>
              {config.folderPath && <> · Folder: <code className="font-mono bg-muted px-1 rounded">{config.folderPath}</code></>}
              {config.endAt && <> · Ends: {new Date(config.endAt).toLocaleDateString()}</>}
              {` · Time zone: ${localTimeZone}`}
            </p>
            <Button onClick={handleSave} className="w-full gap-2" size="lg">
              <Save className="w-4 h-4" />
              Save Recurring Schedule
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* ===== INDIVIDUAL SCHEDULED UPLOADS ===== */}
      <div className="space-y-4">
        <h2 className="text-lg font-medium">Individual Scheduled Uploads</h2>
        <CampaignScheduler />
      </div>
    </div>
  );
}
