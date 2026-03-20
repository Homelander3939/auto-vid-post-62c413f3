import {
  getSettings,
  saveSettings,
  getDemoFiles,
  setDemoFiles,
  clearDemoFiles,
  type AppSettings,
  type DemoFiles,
} from '@/lib/storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect, useRef } from 'react';
import { FolderOpen, Eye, EyeOff, FlaskConical, Trash2, UploadCloud, FileVideo, FileText } from 'lucide-react';

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

const sampleTextContent = `Title: My Amazing Video
Description: Check out this awesome content I made!
Tags: vlog, tutorial, howto, trending
Platforms: youtube, tiktok, instagram`;

export default function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: savedSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettings(),
  });

  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [demoVideoName, setDemoVideoName] = useState('');
  const [demoTextContent, setDemoTextContent] = useState('');
  const [demoVideoFile, setDemoVideoFile] = useState<File | null>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (savedSettings) setSettings(savedSettings);
    const demo = getDemoFiles();
    if (demo) {
      setDemoVideoName(demo.videoFileName);
      setDemoTextContent(demo.textContent);
    }
  }, [savedSettings]);

  const handleSaveSettings = () => {
    saveSettings(settings);
    queryClient.invalidateQueries({ queryKey: ['settings'] });
    toast({ title: 'Settings saved' });
  };

  const handleSaveDemo = () => {
    if (!demoVideoName.trim()) {
      toast({ title: 'Enter a video filename', variant: 'destructive' });
      return;
    }
    setDemoFiles({ videoFileName: demoVideoName, textContent: demoTextContent });
    queryClient.invalidateQueries({ queryKey: ['scan'] });
    toast({ title: 'Demo files saved', description: 'Go to Dashboard to see detected files.' });
  };

  const handleClearDemo = () => {
    clearDemoFiles();
    setDemoVideoName('');
    setDemoTextContent('');
    queryClient.invalidateQueries({ queryKey: ['scan'] });
    toast({ title: 'Demo files cleared' });
  };

  const handleLoadSample = () => {
    setDemoVideoName('my_awesome_video.mp4');
    setDemoTextContent(sampleTextContent);
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
          Configure folder, credentials, notifications, and demo files
        </p>
      </div>

      {/* Demo Files — show first since this is needed for preview testing */}
      <Card className="border-primary/20">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-primary" />
            Demo Files (Preview Mode)
          </CardTitle>
          <CardDescription>
            Simulate video and text files to test the full flow without a local server
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Video Filename</Label>
            <Input
              value={demoVideoName}
              onChange={(e) => setDemoVideoName(e.target.value)}
              placeholder="my_video.mp4"
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label>Text File Content</Label>
            <Textarea
              value={demoTextContent}
              onChange={(e) => setDemoTextContent(e.target.value)}
              placeholder={`Title: My Video\nDescription: ...\nTags: tag1, tag2\nPlatforms: youtube, tiktok, instagram`}
              className="font-mono text-sm min-h-[120px]"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSaveDemo} size="sm">
              Save Demo Files
            </Button>
            <Button variant="outline" size="sm" onClick={handleLoadSample}>
              Load Sample
            </Button>
            {getDemoFiles() && (
              <Button variant="ghost" size="sm" onClick={handleClearDemo} className="text-destructive">
                <Trash2 className="w-3.5 h-3.5 mr-1" />
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Folder Path */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Video Folder
          </CardTitle>
          <CardDescription>
            Path to the folder where videos and text files are placed (used when running locally)
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

      <Button onClick={handleSaveSettings} size="lg">
        Save All Settings
      </Button>
    </div>
  );
}
