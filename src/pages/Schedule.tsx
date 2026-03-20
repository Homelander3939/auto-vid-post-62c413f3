import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSchedule, saveSchedule, type ScheduleConfig } from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';

const presets = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 9 AM', cron: '0 9 * * *' },
  { label: 'Daily at noon', cron: '0 12 * * *' },
];

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
  });

  useEffect(() => {
    if (data) setConfig(data);
  }, [data]);

  const handleSave = async () => {
    await saveSchedule(config);
    queryClient.invalidateQueries({ queryKey: ['schedule'] });
    toast({
      title: 'Schedule saved',
      description: config.enabled
        ? `Cron: ${config.cronExpression} (active when running locally)`
        : 'Schedule disabled',
    });
  };

  const togglePlatform = (p: string) => {
    setConfig((prev) => ({
      ...prev,
      platforms: prev.platforms.includes(p)
        ? prev.platforms.filter((x) => x !== p)
        : [...prev.platforms, p],
    }));
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scheduled Uploads</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Auto-upload videos on a schedule (cron runs on local server)
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Schedule Configuration</CardTitle>
              <CardDescription>Set when to automatically scan and upload</CardDescription>
            </div>
            <Switch
              checked={config.enabled}
              onCheckedChange={(enabled) => setConfig((p) => ({ ...p, enabled }))}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Cron Expression</Label>
            <Input
              value={config.cronExpression}
              onChange={(e) => setConfig((p) => ({ ...p, cronExpression: e.target.value }))}
              placeholder="0 9 * * *"
              className="font-mono"
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {presets.map((p) => (
                <Button
                  key={p.cron}
                  variant={config.cronExpression === p.cron ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => setConfig((prev) => ({ ...prev, cronExpression: p.cron }))}
                  className="text-xs"
                >
                  <Clock className="w-3 h-3 mr-1" />
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Platforms</Label>
            <div className="flex gap-2">
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
          </div>

          <Button onClick={handleSave}>Save Schedule</Button>
        </CardContent>
      </Card>
    </div>
  );
}
