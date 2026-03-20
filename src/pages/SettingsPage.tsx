import { getSettings, saveSettings, type AppSettings } from '@/lib/storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect } from 'react';
import { FolderOpen, Eye, EyeOff, Send } from 'lucide-react';
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
          Configure folder path, platform credentials, and Telegram notifications
        </p>
      </div>

      {/* Folder Path */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Video Folder (Local Mode)
          </CardTitle>
          <CardDescription>
            Path to the folder where videos and text files are placed when running locally
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

      {/* Platform Credentials */}
      {(['youtube', 'tiktok', 'instagram'] as const).map((platform) => (
        <Card key={platform}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base capitalize">{platform}</CardTitle>
                <CardDescription>Login credentials for {platform} studio</CardDescription>
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
              <Label>Bot Token</Label>
              <PasswordInput
                value={settings.telegram.botToken}
                onChange={(v) =>
                  setSettings((p) => ({ ...p, telegram: { ...p.telegram, botToken: v } }))
                }
                placeholder="123456:ABC-DEF..."
              />
            </div>
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
            </div>
          </CardContent>
        )}
      </Card>

      <Button onClick={handleSave} disabled={saving} size="lg">
        {saving ? 'Saving…' : 'Save All Settings'}
      </Button>
    </div>
  );
}
