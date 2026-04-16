import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Sparkles, RefreshCw, Wand2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { generatePostWithAI, type AIGenerateOutput } from '@/lib/socialPosts';

interface Props {
  platforms: string[];
  onUse: (output: AIGenerateOutput, prompt: string) => void;
}

export default function AIPostComposer({ platforms, onUse }: Props) {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState('');
  const [includeImage, setIncludeImage] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AIGenerateOutput | null>(null);

  const handleGenerate = async () => {
    if (!prompt.trim()) { toast({ title: 'Enter a prompt first', variant: 'destructive' }); return; }
    if (platforms.length === 0) { toast({ title: 'Select at least one platform', variant: 'destructive' }); return; }
    setLoading(true); setResult(null);
    try {
      const out = await generatePostWithAI({ prompt, platforms, includeImage });
      setResult(out);
    } catch (e: any) {
      toast({ title: 'AI generation failed', description: e.message, variant: 'destructive' });
    } finally { setLoading(false); }
  };

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-primary" /> AI Post Generator
        </CardTitle>
        <CardDescription>
          Describe what you want to post. AI researches, writes a human-sounding caption with hashtags, and optionally creates an image.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Prompt</Label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Announce our new summer collection — fun, beachy vibe, mention free shipping"
            rows={3}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-sm flex items-center gap-2 cursor-pointer">
            <Switch checked={includeImage} onCheckedChange={setIncludeImage} />
            Generate image
          </Label>
          <Button onClick={handleGenerate} disabled={loading} className="gap-2">
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {loading ? 'Generating…' : 'Generate'}
          </Button>
        </div>
        {result && (
          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div>
              <Label className="text-xs uppercase text-muted-foreground">Description</Label>
              <p className="mt-1 text-sm whitespace-pre-wrap">{result.description}</p>
            </div>
            {result.hashtags.length > 0 && (
              <div>
                <Label className="text-xs uppercase text-muted-foreground">Hashtags</Label>
                <p className="mt-1 text-sm text-primary">{result.hashtags.map((h) => `#${h}`).join(' ')}</p>
              </div>
            )}
            {result.imageUrl && (
              <div>
                <Label className="text-xs uppercase text-muted-foreground">Image</Label>
                <img src={result.imageUrl} alt="Generated" className="mt-2 rounded-lg max-h-72 object-contain bg-muted" />
              </div>
            )}
            {result.sources && result.sources.length > 0 && (
              <div>
                <Label className="text-xs uppercase text-muted-foreground">Sources</Label>
                <ul className="mt-1 text-xs text-muted-foreground space-y-0.5">
                  {result.sources.map((s, i) => (
                    <li key={i}>• {s.title || s.url}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={() => onUse(result, prompt)} className="gap-1.5">
                <Sparkles className="w-3.5 h-3.5" /> Use this
              </Button>
              <Button size="sm" variant="outline" onClick={handleGenerate} disabled={loading}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" /> Regenerate
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
