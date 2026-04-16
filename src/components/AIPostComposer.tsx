import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sparkles, RefreshCw, Wand2, ExternalLink, CheckCircle2, AlertTriangle, Loader2, Cpu } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQuery } from '@tanstack/react-query';
import {
  generatePostStream,
  getAISettings,
  type AIGenerateOutput,
  type AISource,
  type AIStreamEvent,
  type PlatformVariant,
} from '@/lib/socialPosts';

const PLATFORM_LABELS: Record<string, string> = { x: 'X', tiktok: 'TikTok', facebook: 'Facebook' };
const PLATFORM_LIMITS: Record<string, number> = { x: 280, tiktok: 180, facebook: 2200 };

interface Step {
  id: string;
  emoji: string;
  label: string;
  status: 'active' | 'done' | 'error';
}

interface Props {
  platforms: string[];
  onUse: (output: AIGenerateOutput, prompt: string) => void;
}

export default function AIPostComposer({ platforms, onUse }: Props) {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState('');
  const [includeImage, setIncludeImage] = useState(true);
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [variants, setVariants] = useState<Record<string, PlatformVariant>>({});
  const [sources, setSources] = useState<AISource[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('');
  const [meta, setMeta] = useState<{ provider?: string; model?: string }>({});

  const { data: aiSettings } = useQuery({ queryKey: ['ai_settings'], queryFn: getAISettings });

  // Reset active tab when platforms change
  useEffect(() => {
    if (platforms.length && !platforms.includes(activeTab)) setActiveTab(platforms[0]);
  }, [platforms, activeTab]);

  const upsertStep = (s: Step) => {
    setSteps((prev) => {
      const idx = prev.findIndex((x) => x.id === s.id);
      if (idx === -1) return [...prev, s];
      const copy = [...prev];
      copy[idx] = s;
      return copy;
    });
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) { toast({ title: 'Enter a prompt first', variant: 'destructive' }); return; }
    if (platforms.length === 0) { toast({ title: 'Select at least one platform', variant: 'destructive' }); return; }

    setLoading(true);
    setSteps([]);
    setVariants({});
    setSources([]);
    setImageUrl(null);
    setImagePath(null);
    setMeta({});

    try {
      await generatePostStream({ prompt, platforms, includeImage }, (e) => {
        if (e.type === 'step') upsertStep({ id: e.id, emoji: e.emoji, label: e.label, status: e.status });
        else if (e.type === 'variant') setVariants((v) => ({ ...v, [e.platform]: { description: e.description, hashtags: e.hashtags } }));
        else if (e.type === 'sources') setSources(e.sources);
        else if (e.type === 'image') { setImageUrl(e.imageUrl); setImagePath(e.imagePath); }
        else if (e.type === 'done') {
          setVariants(e.variants);
          setSources(e.sources);
          if (e.imageUrl) { setImageUrl(e.imageUrl); setImagePath(e.imagePath); }
          setMeta({ provider: e.provider, model: e.model });
        }
        else if (e.type === 'error') {
          toast({ title: 'AI generation failed', description: e.error, variant: 'destructive' });
        }
      });
    } catch (e: any) {
      toast({ title: 'AI generation failed', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const useVariant = (platform: string) => {
    const v = variants[platform];
    if (!v) return;
    const out: AIGenerateOutput = {
      description: v.description,
      hashtags: v.hashtags,
      variants,
      imageUrl,
      imagePath,
      sources,
      provider: meta.provider,
      model: meta.model,
    };
    onUse(out, prompt);
    toast({ title: `Loaded ${PLATFORM_LABELS[platform] || platform} variant`, description: 'Review and post.' });
  };

  const useAll = () => {
    if (!Object.keys(variants).length) return;
    const primary = variants[platforms[0]] || Object.values(variants)[0];
    const out: AIGenerateOutput = {
      description: primary.description,
      hashtags: primary.hashtags,
      variants,
      imageUrl,
      imagePath,
      sources,
      provider: meta.provider,
      model: meta.model,
    };
    onUse(out, prompt);
    toast({ title: 'All variants loaded', description: 'Each platform will use its own tailored caption.' });
  };

  const currentAi = meta.model || aiSettings?.model || 'google/gemini-3-flash-preview';
  const currentProvider = meta.provider || aiSettings?.provider || 'lovable';

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" /> AI Post Generator
            </CardTitle>
            <CardDescription className="mt-1">
              Describe what you want to post. AI researches, writes platform-tailored captions, and optionally creates an image.
            </CardDescription>
          </div>
          <Badge variant="outline" className="gap-1.5 text-[11px] font-mono">
            <Cpu className="w-3 h-3 text-primary" />
            {currentProvider} · {currentAi.split('/').pop()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Prompt</Label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Last 24h tech news in Web3 + AI — find sources, generate an image, casual tone"
            rows={3}
          />
        </div>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label className="text-sm flex items-center gap-2 cursor-pointer">
            <Switch checked={includeImage} onCheckedChange={setIncludeImage} disabled={loading} />
            Generate image
          </Label>
          <Button onClick={handleGenerate} disabled={loading} className="gap-2">
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {loading ? 'Generating…' : 'Generate'}
          </Button>
        </div>

        {/* Live step feed */}
        {steps.length > 0 && (
          <div className="rounded-lg border bg-card/50 p-3 space-y-1.5">
            {steps.map((s) => (
              <div
                key={s.id}
                className={`flex items-center gap-2 text-sm transition-all duration-300 ${
                  s.status === 'done' ? 'opacity-90' :
                  s.status === 'error' ? 'text-destructive' :
                  'text-foreground'
                }`}
              >
                <span className="text-base w-5 text-center">{s.emoji}</span>
                <span className="flex-1">{s.label}</span>
                {s.status === 'active' && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
                {s.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                {s.status === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-destructive" />}
              </div>
            ))}
          </div>
        )}

        {/* Per-platform variants */}
        {Object.keys(variants).length > 0 && (
          <div className="space-y-3 rounded-lg border bg-card p-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <Label className="text-xs uppercase text-muted-foreground">Tailored variants</Label>
              <Button size="sm" variant="secondary" onClick={useAll} className="gap-1.5 h-7 text-xs">
                <Sparkles className="w-3 h-3" /> Use all (per platform)
              </Button>
            </div>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="h-8">
                {platforms.map((p) => (
                  <TabsTrigger key={p} value={p} className="text-xs h-6 px-2.5">
                    {PLATFORM_LABELS[p] || p}
                    {variants[p] && <CheckCircle2 className="w-3 h-3 ml-1 text-emerald-500" />}
                  </TabsTrigger>
                ))}
              </TabsList>
              {platforms.map((p) => {
                const v = variants[p];
                if (!v) {
                  return (
                    <TabsContent key={p} value={p} className="mt-3 text-sm text-muted-foreground">
                      Waiting for {PLATFORM_LABELS[p] || p} variant…
                    </TabsContent>
                  );
                }
                const charCount = v.description.length + (v.hashtags.length ? v.hashtags.reduce((a, h) => a + h.length + 2, 0) : 0);
                const limit = PLATFORM_LIMITS[p] || 2200;
                const overLimit = charCount > limit;
                return (
                  <TabsContent key={p} value={p} className="mt-3 space-y-2.5">
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{v.description}</p>
                    {v.hashtags.length > 0 && (
                      <p className="text-sm text-primary leading-relaxed">{v.hashtags.map((h) => `#${h}`).join(' ')}</p>
                    )}
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className={`text-[11px] ${overLimit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                        {charCount} / {limit} chars
                      </span>
                      <Button size="sm" onClick={() => useVariant(p)} className="gap-1.5 h-7 text-xs">
                        Use this for {PLATFORM_LABELS[p] || p}
                      </Button>
                    </div>
                  </TabsContent>
                );
              })}
            </Tabs>
          </div>
        )}

        {imageUrl && (
          <div className="rounded-lg border bg-card p-4 space-y-2 animate-in fade-in duration-500">
            <Label className="text-xs uppercase text-muted-foreground">Generated image</Label>
            <img src={imageUrl} alt="AI-generated" className="rounded-lg max-h-72 object-contain bg-muted w-full" />
          </div>
        )}

        {sources.length > 0 && (
          <div className="rounded-lg border bg-card p-4 space-y-2 animate-in fade-in duration-500">
            <Label className="text-xs uppercase text-muted-foreground flex items-center gap-1.5">
              📚 Research sources
              <span className="font-normal normal-case text-muted-foreground/70">
                (NOT included in post — for your reference)
              </span>
            </Label>
            <ul className="space-y-1.5 mt-1">
              {sources.map((s, i) => (
                <li key={i} className="text-sm">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
                  >
                    {s.title || s.url}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  {s.note && <p className="text-xs text-muted-foreground ml-0 mt-0.5">{s.note}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {Object.keys(variants).length > 0 && !loading && (
          <Button size="sm" variant="outline" onClick={handleGenerate} className="w-full">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Regenerate
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
