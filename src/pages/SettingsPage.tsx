import { getSettings, saveSettings, type AppSettings } from '@/lib/storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect } from 'react';
import { FolderOpen, Eye, EyeOff, Send, Info, Cloud, Monitor } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

const defaultSettings: AppSettings = {
  folderPath: '',
  uploadMode: 'local',
  youtube: { email: '', password: '', enabled: false },
  tiktok: { email: '', password: '', enabled: false },
  instagram: { email: '', password: '', enabled: false },
  telegram: { botToken: '', chatId: '', enabled: false },
};

export default function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: savedSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (savedSettings) setSettings(savedSettings);
  }, [savedSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveSettings(settings);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({ title: 'Settings saved' });
    } catch (err: any) {
      toast({ title: 'Error saving', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const updatePlatform = (
    platform: 'youtube' | 'tiktok' | 'instagram',
    field: string,
    value: any
  ) => {
    setSettings((prev) => ({
      ...prev,
      [platform]: { ...prev[platform], [field]: value },
    }));
  };

  const isCloud = settings.uploadMode === 'cloud';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure platform logins, upload mode, and notifications
        </p>
      </div>

      {/* Upload Mode Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload Mode</CardTitle>
          <CardDescription>
            Choose how videos are uploaded to platforms
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setSettings((p) => ({ ...p, uploadMode: 'local' }))}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-all ${
                !isCloud
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/40'
              }`}
            >
              <Monitor className={`w-6 h-6 ${!isCloud ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className={`font-medium text-sm ${!isCloud ? 'text-primary' : 'text-muted-foreground'}`}>Local Mode</span>
              <span className="text-xs text-muted-foreground text-center">
                Uses Playwright on your PC. Requires local server running.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setSettings((p) => ({ ...p, uploadMode: 'cloud' }))}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-all ${
                isCloud
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/40'
              }`}
            >
              <Cloud className={`w-6 h-6 ${isCloud ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className={`font-medium text-sm ${isCloud ? 'text-primary' : 'text-muted-foreground'}`}>Cloud Mode</span>
              <span className="text-xs text-muted-foreground text-center">
                Uses Browserbase remote browser. No local server needed.
              </span>
            </button>
          </div>
          {isCloud && (
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
              <Cloud className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
              <div className="text-green-800">
                <p className="font-medium">Cloud mode active</p>
                <p className="text-green-700 mt-0.5">
                  Browserbase credentials are configured. Uploads will run in a remote browser — no local server needed.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* How it works */}
      <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
        <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
        <div className="text-blue-800">
          <p className="font-medium">How uploads work</p>
          <p className="text-blue-700 mt-0.5">
            {isCloud
              ? 'Cloud mode uses a remote Browserbase browser to log into each platform and upload videos automatically. Sessions persist so you only log in once.'
              : 'Your local server uses Playwright to open a real browser, log into each platform with your credentials below, and upload videos automatically. You only need to log in manually the first time — sessions are saved.'}
          </p>
        </div>
      </div>

      {/* Folder Path — local mode only */}
      {!isCloud && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FolderOpen className="w-4 h-4" />
              Video Watch Folder
            </CardTitle>
            <CardDescription>
              Drop .mp4 + .txt pairs here — the local server picks them up automatically
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              value={settings.folderPath}
              onChange={(e) => setSettings((p) => ({ ...p, folderPath: e.target.value }))}
              placeholder="C:\Users\You\Videos\uploads"
              className="font-mono"
            />
          </CardContent>
        </Card>
      )}

      {/* Platform Credentials */}
      {(['youtube', 'tiktok', 'instagram'] as const).map((platform) => (
        <Card key={platform}>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base capitalize">{platform}</CardTitle>
                <CardDescription>
                  {platform === 'youtube' && 'YouTube Studio login — browser opens studio.youtube.com'}
                  {platform === 'tiktok' && 'TikTok Creator login — browser opens tiktok.com/creator'}
                  {platform === 'instagram' && 'Instagram login — browser opens instagram.com'}
                </CardDescription>
              </div>
              <Switch
                checked={settings[platform].enabled}
                onCheckedChange={(v) => updatePlatform(platform, 'enabled', v)}
              />
            </div>
          </CardHeader>
          {settings[platform].enabled && (
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground bg-secondary p-3 rounded-lg">
                💡 First upload will open a browser window. Log in manually if needed — the session is saved for all future uploads.
              </p>
              <div className="space-y-2">
                <Label>Email / Username</Label>
                <Input
                  value={settings[platform].email}
                  onChange={(e) => updatePlatform(platform, 'email', e.target.value)}
                  placeholder={`${platform}@example.com`}
                />
              </div>
              <div className="space-y-2">
                <Label>Password</Label>
                <PasswordInput
                  value={settings[platform].password}
                  onChange={(v) => updatePlatform(platform, 'password', v)}
                  placeholder="••••••••"
                />
              </div>
            </CardContent>
          )}
        </Card>
      ))}

      {/* Telegram */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Telegram Notifications</CardTitle>
              <CardDescription>Get alerts when uploads succeed or fail + chat with AI</CardDescription>
            </div>
            <Switch
              checked={settings.telegram.enabled}
              onCheckedChange={(v) =>
                setSettings((p) => ({ ...p, telegram: { ...p.telegram, enabled: v } }))
              }
            />
          </div>
        </CardHeader>
        {settings.telegram.enabled && (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Chat ID</Label>
              <div className="flex gap-2">
                <Input
                  value={settings.telegram.chatId}
                  onChange={(e) =>
                    setSettings((p) => ({
                      ...p,
                      telegram: { ...p.telegram, chatId: e.target.value },
                    }))
                  }
                  placeholder="Your numeric chat ID (e.g. 848868115)"
                />
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={async () => {
                    try {
                      const { data, error } = await supabase
                        .from('telegram_messages')
                        .select('chat_id')
                        .eq('is_bot', false)
                        .order('created_at', { ascending: false })
                        .limit(1);
                      if (error) throw error;
                      if (data && data.length > 0) {
                        const detectedId = String(data[0].chat_id);
                        setSettings((p) => ({
                          ...p,
                          telegram: { ...p.telegram, chatId: detectedId },
                        }));
                        toast({ title: `Chat ID detected: ${detectedId}` });
                      } else {
                        toast({ title: 'No messages found', description: 'Send a message to your bot first, then try again.', variant: 'destructive' });
                      }
                    } catch (err: any) {
                      toast({ title: 'Detection failed', description: err.message, variant: 'destructive' });
                    }
                  }}
                >
                  Auto-detect
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Enter your <b>numeric</b> chat ID (not bot username). Send any message to your bot, then click "Auto-detect", or message @userinfobot on Telegram to find it.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={!settings.telegram.chatId}
              onClick={async () => {
                try {
                  const { data, error } = await supabase.functions.invoke('send-telegram', {
                    body: {
                      chat_id: Number(settings.telegram.chatId),
                      text: '✅ <b>Video Uploader</b> — Telegram notifications are working!',
                    },
                  });
                  if (error) throw error;
                  if (data?.success) {
                    toast({ title: 'Test message sent to Telegram!' });
                  } else {
                    toast({ title: 'Telegram error', description: data?.error || 'Unknown error', variant: 'destructive' });
                  }
                } catch (err: any) {
                  toast({ title: 'Failed to send', description: err.message, variant: 'destructive' });
                }
              }}
            >
              <Send className="w-3.5 h-3.5" />
              Send Test Message
            </Button>
          </CardContent>
        )}
      </Card>

      <Button onClick={handleSave} disabled={saving} size="lg">
        {saving ? 'Saving…' : 'Save All Settings'}
      </Button>
    </div>
  );
}
