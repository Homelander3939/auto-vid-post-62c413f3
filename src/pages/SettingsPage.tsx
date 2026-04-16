import { getSettings, saveSettings, type AppSettings, getPlatformAccounts, savePlatformAccount, deletePlatformAccount, setDefaultAccount, type PlatformAccount } from '@/lib/storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect } from 'react';
import { FolderOpen, Eye, EyeOff, Send, Info, Cloud, Monitor, Plus, Trash2, Star, Pencil, X, Check, Wand2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { openLocalBrowserProfileSession } from '@/lib/localBrowserProfiles';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import SocialAccountCard from '@/components/SocialAccountCard';
import { getSocialAccounts, getAISettings, saveAISettings, listAIModels, SOCIAL_PLATFORMS, type AISettings, type AIModel } from '@/lib/socialPosts';

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

interface AccountFormData {
  label: string;
  email: string;
  password: string;
}

function PlatformAccountCard({
  platform,
  accounts,
  onRefresh,
  localMode,
}: {
  platform: string;
  accounts: PlatformAccount[];
  onRefresh: () => void;
  localMode: boolean;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AccountFormData>({ label: '', email: '', password: '' });
  const [saving, setSaving] = useState(false);
  const [preparingId, setPreparingId] = useState<string | null>(null);

  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const hasAccounts = platformAccounts.length > 0;

  const descriptions: Record<string, string> = {
    youtube: 'YouTube Studio login — browser opens studio.youtube.com',
    tiktok: 'TikTok Creator login — browser opens tiktok.com/creator',
    instagram: 'Instagram login — browser opens instagram.com',
  };

  const resetForm = () => {
    setForm({ label: '', email: '', password: '' });
    setAdding(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    if (!form.email.trim()) {
      toast({ title: 'Email is required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        platform,
        label: form.label.trim() || form.email.split('@')[0],
        email: form.email.trim(),
        password: form.password,
        enabled: true,
      };

      if (editingId) {
        payload.id = editingId;
      } else if (!hasAccounts) {
        payload.is_default = true;
      }

      await savePlatformAccount(payload);
      toast({ title: editingId ? 'Account updated' : 'Account added' });
      resetForm();
      onRefresh();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePlatformAccount(id);
      toast({ title: 'Account removed' });
      onRefresh();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await setDefaultAccount(id, platform);
      toast({ title: 'Default account updated' });
      onRefresh();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const handleToggleEnabled = async (account: PlatformAccount) => {
    try {
      await savePlatformAccount({ id: account.id, platform, enabled: !account.enabled });
      onRefresh();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const startEdit = (account: PlatformAccount) => {
    setEditingId(account.id);
    setForm({ label: account.label, email: account.email, password: account.password });
    setAdding(true);
  };

  const handlePrepareProfile = async (account: PlatformAccount) => {
    setPreparingId(account.id);
    try {
      const result = await openLocalBrowserProfileSession({
        platform,
        accountId: account.id,
        label: account.label || account.email,
      });
      const linkedCount = result.linkedAccountIds.length;
      toast({
        title: 'Browser profile opened',
        description: linkedCount > 1
          ? `Log in once in the opened browser. This profile is now shared with ${linkedCount} matching accounts.`
          : 'Log in once in the opened browser. This profile will now be reused for future uploads.',
      });
    } catch (err: any) {
      toast({
        title: 'Could not open local browser profile',
        description: err.message || 'Make sure your local server is running on port 3001.',
        variant: 'destructive',
      });
    } finally {
      setPreparingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base capitalize">{platform}</CardTitle>
            <CardDescription>{descriptions[platform]}</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={() => {
              resetForm();
              setAdding(true);
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasAccounts && !adding && (
          <p className="text-sm text-muted-foreground text-center py-3">
            No accounts configured. Add one to enable {platform} uploads.
          </p>
        )}

        {/* Account list */}
        {platformAccounts.map((account) => (
          <div
            key={account.id}
            className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
              account.enabled ? 'border-border' : 'border-border/50 opacity-60'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{account.label || account.email}</span>
                {account.is_default && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 shrink-0">
                    <Star className="w-2.5 h-2.5 fill-current" />
                    Default
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">{account.email}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Switch
                checked={account.enabled}
                onCheckedChange={() => handleToggleEnabled(account)}
                className="scale-75"
              />
              {localMode && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => handlePrepareProfile(account)}
                  disabled={preparingId === account.id}
                >
                  <Monitor className="w-3.5 h-3.5 mr-1" />
                  {preparingId === account.id ? 'Opening…' : 'Prepare'}
                </Button>
              )}
              {!account.is_default && platformAccounts.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-muted-foreground hover:text-amber-600"
                  title="Set as default"
                  onClick={() => handleSetDefault(account.id)}
                >
                  <Star className="w-3.5 h-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => startEdit(account)}
              >
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove account?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove the {platform} account "{account.label || account.email}".
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => handleDelete(account.id)}
                      className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                    >
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))}

        {/* Add/Edit form */}
        {adding && (
          <div className="rounded-lg border-2 border-dashed border-primary/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{editingId ? 'Edit Account' : 'New Account'}</p>
              <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={resetForm}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Label (optional)</Label>
              <Input
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Main Channel, Gaming, Personal"
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Email / Username</Label>
              <Input
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder={`${platform}@example.com`}
                className="h-9"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Password</Label>
              <PasswordInput
                value={form.password}
                onChange={(v) => setForm((f) => ({ ...f, password: v }))}
                placeholder="••••••••"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
                <Check className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : editingId ? 'Update' : 'Add Account'}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground bg-secondary p-2.5 rounded-lg">
              💡 Use Prepare once per account to open its Chrome profile and save the login. Future uploads will reuse that same saved profile.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
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

  const { data: accounts = [] } = useQuery({
    queryKey: ['platform_accounts'],
    queryFn: getPlatformAccounts,
  });

  const { data: socialAccounts = [] } = useQuery({
    queryKey: ['social_accounts'],
    queryFn: getSocialAccounts,
  });

  const { data: savedAi } = useQuery({
    queryKey: ['ai_settings'],
    queryFn: getAISettings,
  });

  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);
  const [aiSettings, setAiSettings] = useState<AISettings>({ provider: 'lovable', apiKey: '', model: 'google/gemini-3-flash-preview' });
  const [savingAI, setSavingAI] = useState(false);
  const [aiModels, setAiModels] = useState<AIModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const loadModels = async (provider: string, apiKey: string) => {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const models = await listAIModels(provider, apiKey);
      setAiModels(models);
    } catch (e: any) {
      setModelsError(e.message || 'Failed to load models');
      setAiModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (savedSettings) setSettings(savedSettings);
  }, [savedSettings]);

  useEffect(() => {
    if (savedAi) setAiSettings(savedAi);
  }, [savedAi]);

  // Auto-load models when provider changes (or API key for non-lovable providers)
  useEffect(() => {
    if (aiSettings.provider === 'lovable') {
      loadModels('lovable', '');
    } else if (aiSettings.apiKey) {
      loadModels(aiSettings.provider, aiSettings.apiKey);
    } else {
      setAiModels([]);
      setModelsError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSettings.provider]);

  const refreshAccounts = () => {
    queryClient.invalidateQueries({ queryKey: ['platform_accounts'] });
  };

  const refreshSocialAccounts = () => {
    queryClient.invalidateQueries({ queryKey: ['social_accounts'] });
  };

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

  const handleSaveAI = async () => {
    setSavingAI(true);
    try {
      await saveAISettings(aiSettings);
      queryClient.invalidateQueries({ queryKey: ['ai_settings'] });
      toast({ title: 'AI settings saved' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSavingAI(false);
    }
  };

  const isCloud = settings.uploadMode === 'cloud';

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure platform accounts, upload mode, and notifications
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

      {/* Platform Accounts */}
      {(['youtube', 'tiktok', 'instagram'] as const).map((platform) => (
        <PlatformAccountCard
          key={platform}
          platform={platform}
          accounts={accounts}
          onRefresh={refreshAccounts}
          localMode={!isCloud}
        />
      ))}

      {/* Social Post Accounts */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 pt-2">
          <Wand2 className="w-4 h-4 text-primary" />
          <h2 className="text-lg font-semibold">Social Post Accounts</h2>
          <Badge variant="secondary" className="text-[10px]">For text/image posts</Badge>
        </div>
        <p className="text-sm text-muted-foreground -mt-2">
          Configure X, TikTok, and Facebook accounts for the AI-powered post manager. Each account uses its own saved Chrome profile.
        </p>
        {SOCIAL_PLATFORMS.map((p) => (
          <SocialAccountCard
            key={p}
            platform={p}
            accounts={socialAccounts}
            onRefresh={refreshSocialAccounts}
            localMode={!isCloud}
          />
        ))}
      </div>

      {/* AI Provider */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-primary" />
            AI Post Generator
          </CardTitle>
          <CardDescription>
            Powers the AI Post Generator. Default uses Lovable AI Gateway (no key needed). Add your own provider key to override.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-xs">Provider</Label>
              <Select value={aiSettings.provider} onValueChange={(v) => setAiSettings((s) => ({ ...s, provider: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lovable">Lovable AI (default)</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Model</Label>
              <Input
                value={aiSettings.model}
                onChange={(e) => setAiSettings((s) => ({ ...s, model: e.target.value }))}
                placeholder="google/gemini-3-flash-preview"
              />
            </div>
          </div>
          {aiSettings.provider !== 'lovable' && (
            <div className="space-y-2">
              <Label className="text-xs">API Key</Label>
              <PasswordInput
                value={aiSettings.apiKey}
                onChange={(v) => setAiSettings((s) => ({ ...s, apiKey: v }))}
                placeholder="sk-..."
              />
            </div>
          )}
          <Button size="sm" onClick={handleSaveAI} disabled={savingAI} className="gap-1.5">
            <Check className="w-3.5 h-3.5" />
            {savingAI ? 'Saving…' : 'Save AI Settings'}
          </Button>
        </CardContent>
      </Card>


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
