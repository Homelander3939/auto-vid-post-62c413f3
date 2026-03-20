import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  createUploadJob,
  parseTextContent,
  uploadVideoFile,
  type VideoMetadata,
} from '@/lib/storage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileVideo, FileText, UploadCloud, CheckCircle2, CalendarClock, Zap, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import CampaignScheduler from '@/components/CampaignScheduler';

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(['youtube', 'tiktok', 'instagram']);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textFileName, setTextFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  // Manual metadata fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    // Auto-fill title from filename if empty
    if (!title) {
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
      setTitle(name);
    }
    toast({ title: `Video selected: ${file.name}` });
  };

  const handleTextSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setTextContent(text);
      setTextFileName(file.name);
      const parsed = parseTextContent(text);
      if (parsed.title) setTitle(parsed.title);
      if (parsed.description) setDescription(parsed.description);
      if (parsed.tags?.length) setTagsInput(parsed.tags.join(', '));
      if (parsed.platforms?.length) setSelectedPlatforms(parsed.platforms);
      toast({ title: `Text file loaded: ${file.name}` });
    } catch {
      toast({ title: 'Could not read text file', variant: 'destructive' });
    }
  };

  const clearTextFile = () => {
    setTextContent(null);
    setTextFileName(null);
    if (textInputRef.current) textInputRef.current.value = '';
  };

  const handleUpload = async () => {
    if (!videoFile || !title.trim()) return;
    setUploading(true);

    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const metadata: VideoMetadata = {
        title: title.trim(),
        description: description.trim(),
        tags,
        platforms: selectedPlatforms,
      };

      const storagePath = await uploadVideoFile(videoFile);
      await createUploadJob(videoFile.name, storagePath, metadata, selectedPlatforms);

      toast({
        title: 'Job queued!',
        description: 'Video stored. Upload will begin automatically.',
      });

      queryClient.invalidateQueries({ queryKey: ['queue'] });

      setVideoFile(null);
      setTextContent(null);
      setTextFileName(null);
      setTitle('');
      setDescription('');
      setTagsInput('');
      setSelectedPlatforms(['youtube', 'tiktok', 'instagram']);
      if (videoInputRef.current) videoInputRef.current.value = '';
      if (textInputRef.current) textInputRef.current.value = '';
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const togglePlatform = (p: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  const canUpload = !!videoFile && title.trim().length > 0 && selectedPlatforms.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload now or schedule a campaign
        </p>
      </div>

      <Tabs defaultValue="single" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="single" className="gap-2">
            <Zap className="w-3.5 h-3.5" />
            Single Upload
          </TabsTrigger>
          <TabsTrigger value="campaign" className="gap-2">
            <CalendarClock className="w-3.5 h-3.5" />
            Campaign
          </TabsTrigger>
        </TabsList>

        <TabsContent value="single" className="space-y-5 mt-6">
          {/* Video file selector */}
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
            className="hidden"
            onChange={handleVideoSelect}
          />
          <button
            type="button"
            onClick={() => videoInputRef.current?.click()}
            className={`w-full flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] ${
              videoFile ? 'border-primary/50 bg-primary/5' : 'border-border'
            }`}
          >
            {videoFile ? (
              <>
                <CheckCircle2 className="w-6 h-6 text-primary" />
                <span className="text-sm font-medium truncate max-w-full">{videoFile.name}</span>
                <span className="text-xs text-muted-foreground">
                  {(videoFile.size / 1024 / 1024).toFixed(1)} MB — tap to change
                </span>
              </>
            ) : (
              <>
                <FileVideo className="w-6 h-6 text-primary" />
                <span className="text-sm font-medium">Select Video File</span>
                <span className="text-xs text-muted-foreground">.mp4, .mov, .avi, .mkv, .webm</span>
              </>
            )}
          </button>

          {/* Metadata fields */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Video Details</CardTitle>
              <CardDescription>Title is required. Other fields are optional.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">
                  Title <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="My awesome video"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="desc">Description</Label>
                <Textarea
                  id="desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description…"
                  rows={3}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tags">Tags</Label>
                <Input
                  id="tags"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="tag1, tag2, tag3"
                />
                <p className="text-xs text-muted-foreground">Comma-separated</p>
              </div>

              {/* Optional text file import */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  ref={textInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  className="hidden"
                  onChange={handleTextSelect}
                />
                {textFileName ? (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <FileText className="w-3 h-3" />
                    {textFileName}
                    <button onClick={clearTextFile} className="ml-1 hover:text-destructive">
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs gap-1.5"
                    onClick={() => textInputRef.current?.click()}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Import from .txt file
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Platforms + Upload button — always visible */}
          <Card>
            <CardContent className="pt-5 space-y-4">
              <div className="space-y-2">
                <Label>Platforms</Label>
                <div className="flex flex-wrap gap-2">
                  {['youtube', 'tiktok', 'instagram'].map((p) => (
                    <Button
                      key={p}
                      variant={selectedPlatforms.includes(p) ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => togglePlatform(p)}
                      className="capitalize"
                    >
                      {p}
                    </Button>
                  ))}
                </div>
              </div>
              <Button
                onClick={handleUpload}
                disabled={!canUpload || uploading}
                className="w-full gap-2"
                size="lg"
              >
                <UploadCloud className="w-4 h-4" />
                {uploading ? 'Uploading…' : 'Queue Upload Now'}
              </Button>
              {!canUpload && !uploading && (
                <p className="text-xs text-muted-foreground text-center">
                  {!videoFile ? 'Select a video file' : !title.trim() ? 'Enter a title' : 'Select at least one platform'}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="campaign" className="mt-6">
          <CampaignScheduler />
        </TabsContent>
      </Tabs>
    </div>
  );
}
