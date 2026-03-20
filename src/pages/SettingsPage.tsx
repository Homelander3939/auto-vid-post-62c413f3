import { getSettings, saveSettings, type AppSettings } from '@/lib/storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect } from 'react';
import { FolderOpen, Eye, EyeOff, Send, Cloud, Monitor, ExternalLink } from 'lucide-react';
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
  const [mode, setMode] = useState<'cloud' | 'local'>('cloud');

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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure platform credentials and notifications
        </p>
      </div>

      {/* Mode Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload Mode</CardTitle>
          <CardDescription>Choose how videos are uploaded to platforms</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMode('cloud')}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 text-center transition-all active:scale-[0.98] ${
                mode === 'cloud' ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <Cloud className="w-6 h-6 text-primary" />
              <span className="text-sm font-medium">Cloud (API)</span>
              <span className="text-xs text-muted-foreground">Uses official platform APIs. Works from anywhere.</span>
            </button>
            <button
              onClick={() => setMode('local')}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 p-4 text-center transition-all active:scale-[0.98] ${
                mode === 'local' ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <Monitor className="w-6 h-6 text-muted-foreground" />
              <span className="text-sm font-medium">Local (Browser)</span>
              <span className="text-xs text-muted-foreground">Uses Playwright browser automation on your PC.</span>
            </button>
          </div>
        </CardContent>
      </Card>

      {mode === 'cloud' ? (
        <>
          {/* YouTube API */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">YouTube (API)</CardTitle>
                  <CardDescription>
                    Uses YouTube Data API v3 for uploads.{' '}
                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                      Google Cloud Console <ExternalLink className="w-3 h-3" />
                    </a>
                  </CardDescription>
                </div>
                <Switch
                  checked={settings.youtube.enabled}
                  onCheckedChange={(v) => updatePlatform('youtube', 'enabled', v)}
                />
              </div>
            </CardHeader>
            {settings.youtube.enabled && (
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground bg-secondary p-3 rounded-lg">
                  1. Create a project in Google Cloud Console<br />
                  2. Enable YouTube Data API v3<br />
                  3. Create OAuth 2.0 credentials (Desktop app type)<br />
                  4. Use OAuth Playground to get a refresh token with <code>youtube.upload</code> scope
                </p>
                <div className="space-y-2">
                  <Label>OAuth Client ID</Label>
                  <Input
                    value={settings.youtube.email}
                    onChange={(e) => updatePlatform('youtube', 'email', e.target.value)}
                    placeholder="xxxx.apps.googleusercontent.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label>OAuth Client Secret</Label>
                  <PasswordInput
                    value={settings.youtube.password}
                    onChange={(v) => updatePlatform('youtube', 'password', v)}
                    placeholder="GOCSPX-..."
                  />
                </div>
              </CardContent>
            )}
          </Card>

          {/* TikTok API */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">TikTok (API)</CardTitle>
                  <CardDescription>
                    Uses TikTok Content Posting API.{' '}
                    <a href="https://developers.tiktok.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                      TikTok Developers <ExternalLink className="w-3 h-3" />
                    </a>
                  </CardDescription>
                </div>
                <Switch
                  checked={settings.tiktok.enabled}
                  onCheckedChange={(v) => updatePlatform('tiktok', 'enabled', v)}
                />
              </div>
            </CardHeader>
            {settings.tiktok.enabled && (
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground bg-secondary p-3 rounded-lg">
                  1. Create a TikTok Developer app<br />
                  2. Apply for Content Posting API access<br />
                  3. Get your access token after OAuth authorization
                </p>
                <div className="space-y-2">
                  <Label>Access Token</Label>
                  <PasswordInput
                    value={settings.tiktok.email}
                    onChange={(v) => updatePlatform('tiktok', 'email', v)}
                    placeholder="act.xxxx..."
                  />
                </div>
              </CardContent>
            )}
          </Card>

          {/* Instagram API */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Instagram (API)</CardTitle>
                  <CardDescription>
                    Uses Instagram Graph API for Reels.{' '}
                    <a href="https://developers.facebook.com/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                      Meta Developers <ExternalLink className="w-3 h-3" />
                    </a>
                  </CardDescription>
                </div>
                <Switch
                  checked={settings.instagram.enabled}
                  onCheckedChange={(v) => updatePlatform('instagram', 'enabled', v)}
                />
              </div>
            </CardHeader>
            {settings.instagram.enabled && (
              <CardContent className="space-y-4">
                <p className="text-xs text-muted-foreground bg-secondary p-3 rounded-lg">
                  1. Create a Meta/Facebook Developer app<br />
                  2. Connect your Instagram Business account<br />
                  3. Generate a long-lived access token<br />
                  4. Find your Instagram Business Account ID
                </p>
                <div className="space-y-2">
                  <Label>Access Token</Label>
                  <PasswordInput
                    value={settings.instagram.email}
                    onChange={(v) => updatePlatform('instagram', 'email', v)}
                    placeholder="EAAxxxxxxx..."
                  />
                </div>
                <div className="space-y-2">
                  <Label>Business Account ID</Label>
                  <Input
                    value={settings.instagram.password}
                    onChange={(e) => updatePlatform('instagram', 'password', e.target.value)}
                    placeholder="17841400..."
                  />
                </div>
              </CardContent>
            )}
          </Card>
        </>
      ) : (
        <>
          {/* Local Mode: Folder Path */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FolderOpen className="w-4 h-4" />
                Video Folder
              </CardTitle>
              <CardDescription>
                Path to the folder where videos and text files are placed
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

          {/* Local Mode: Platform Login Credentials */}
          {(['youtube', 'tiktok', 'instagram'] as const).map((platform) => (
            <Card key={platform}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base capitalize">{platform} (Browser Login)</CardTitle>
                    <CardDescription>Login credentials for {platform} studio — used by local Playwright automation</CardDescription>
                  </div>
                  <Switch
                    checked={settings[platform].enabled}
                    onCheckedChange={(v) => updatePlatform(platform, 'enabled', v)}
                  />
                </div>
              </CardHeader>
              {settings[platform].enabled && (
                <CardContent className="space-y-4">
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
        </>
      )}

      {/* Telegram */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Telegram Notifications</CardTitle>
              <CardDescription>Get notified on upload success or failure</CardDescription>
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
              <Input
                value={settings.telegram.chatId}
                onChange={(e) =>
                  setSettings((p) => ({
                    ...p,
                    telegram: { ...p.telegram, chatId: e.target.value },
                  }))
                }
                placeholder="Your Telegram chat ID"
              />
              <p className="text-xs text-muted-foreground">
                Message @userinfobot on Telegram to get your chat ID.
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
                      chat_id: settings.telegram.chatId,
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
