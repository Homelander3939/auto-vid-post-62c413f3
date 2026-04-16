// One row in the Image Generation Fallback Chain editor.
// Mirrors the full UX of the primary image-provider block: provider select,
// API key with auto-detect, "Show models" → Select dropdown, and "Test connection".
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2, Loader2, Image as ImageIcon, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  detectProviderFromKey,
  listImageModels,
  testAgentConnection,
  type ImageKeyEntry,
  type ImageModelOption,
  type ConnectionTestResult,
} from '@/lib/socialPosts';

interface Props {
  index: number;
  entry: ImageKeyEntry;
  onChange: (next: ImageKeyEntry) => void;
  onRemove: () => void;
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-xs pr-8"
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

export default function ImageFallbackKeyRow({ index, entry, onChange, onRemove }: Props) {
  const { toast } = useToast();
  const [models, setModels] = useState<ImageModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);

  const handleShowModels = async () => {
    setLoadingModels(true);
    try {
      const { models: list, error } = await listImageModels(entry.provider, entry.apiKey);
      if (error) {
        toast({ title: 'Could not list models', description: error, variant: 'destructive' });
        setModels([]);
      } else {
        setModels(list);
        // Auto-pick recommended if no model is set yet
        if (!entry.model) {
          const rec = list.find((m) => m.recommended) || list[0];
          if (rec) onChange({ ...entry, model: rec.id });
        }
        toast({ title: '✅ Models loaded', description: `${list.length} model${list.length === 1 ? '' : 's'} available` });
      }
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' });
    } finally {
      setLoadingModels(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await testAgentConnection('image', entry.provider, entry.apiKey, undefined, entry.model);
      setTest(r);
      if (r.ok) toast({ title: '✅ Key works', description: `${entry.provider}${r.model ? ` · ${r.model.split('/').pop()}` : ''} · ${r.latency}ms` });
      else toast({ title: 'Test failed', description: r.error, variant: 'destructive' });
    } catch (e: any) {
      setTest({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const needsKey = entry.provider !== 'lovable';
  const supportsModels = ['google', 'openai', 'lovable', 'nvidia', 'xai'].includes(entry.provider);

  return (
    <div className="rounded-lg border bg-card p-2.5 space-y-2">
      {/* Header row: index, label, status, enable toggle, remove */}
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-[10px] font-mono shrink-0">#{index + 1}</Badge>
        <Input
          value={entry.label || ''}
          onChange={(e) => onChange({ ...entry, label: e.target.value })}
          placeholder="Label (e.g. Personal Google, Work OpenAI)"
          className="h-8 text-xs flex-1"
        />
        {test?.ok && (
          <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/15 text-[10px] shrink-0">
            <CheckCircle2 className="w-3 h-3" /> {test.latency}ms
          </Badge>
        )}
        {test && !test.ok && (
          <Badge variant="destructive" className="gap-1 text-[10px] shrink-0 max-w-[140px]">
            <XCircle className="w-3 h-3" /> <span className="truncate">{test.error?.slice(0, 40)}</span>
          </Badge>
        )}
        <Switch
          checked={entry.enabled !== false}
          onCheckedChange={(v) => onChange({ ...entry, enabled: v })}
        />
        <Button
          type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Provider + model picker */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Select
          value={entry.provider}
          onValueChange={(v) => { onChange({ ...entry, provider: v, model: '' }); setModels([]); setTest(null); }}
        >
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="lovable">✨ Lovable AI</SelectItem>
            <SelectItem value="google">🍌 Google Gemini</SelectItem>
            <SelectItem value="openai">🎨 OpenAI</SelectItem>
            <SelectItem value="nvidia">🟢 NVIDIA NIM</SelectItem>
            <SelectItem value="xai">⚡ xAI Grok</SelectItem>
          </SelectContent>
        </Select>

        {/* Either dropdown (after Show models) or free-text fallback */}
        {supportsModels && models.length > 0 ? (
          <Select value={entry.model || ''} onValueChange={(v) => { onChange({ ...entry, model: v }); setTest(null); }}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick a model" /></SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.recommended ? '⭐ ' : ''}{m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={entry.model || ''}
            onChange={(e) => onChange({ ...entry, model: e.target.value })}
            placeholder={
              entry.provider === 'google' ? 'gemini-3.1-flash-image-preview' :
              entry.provider === 'openai' ? 'gpt-image-1' :
              entry.provider === 'nvidia' ? 'black-forest-labs/flux.1-schnell' :
              entry.provider === 'xai' ? 'grok-2-image-1212' :
              'google/gemini-2.5-flash-image'
            }
            className="h-8 text-xs font-mono"
          />
        )}
      </div>

      {/* API key (with auto-detect) */}
      {needsKey && (
        <PasswordInput
          value={entry.apiKey}
          onChange={(v) => {
            const det = detectProviderFromKey(v);
            onChange({ ...entry, apiKey: v, provider: det.image || entry.provider });
            setTest(null);
          }}
          placeholder={
            entry.provider === 'google' ? 'AIza…' :
            entry.provider === 'nvidia' ? 'nvapi-…' :
            entry.provider === 'xai' ? 'xai-…' :
            'sk-…'
          }
        />
      )}

      {/* Action row: Show models + Test */}
      <div className="flex items-center gap-2 flex-wrap">
        {supportsModels && (
          <Button
            type="button" size="sm" variant="outline"
            onClick={handleShowModels}
            disabled={loadingModels || (needsKey && !entry.apiKey)}
            className="h-7 text-xs gap-1.5"
          >
            {loadingModels ? <Loader2 className="w-3 h-3 animate-spin" /> : <ImageIcon className="w-3 h-3" />}
            Show models
          </Button>
        )}
        <Button
          type="button" size="sm" variant="outline"
          onClick={handleTest}
          disabled={testing || (needsKey && !entry.apiKey)}
          className="h-7 text-xs gap-1.5"
        >
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : '🔌'}
          Test connection
        </Button>
        {test?.ok && test.sample && (
          <span className="text-[10px] text-muted-foreground italic truncate max-w-[200px]">
            → {test.sample}
          </span>
        )}
      </div>
    </div>
  );
}
