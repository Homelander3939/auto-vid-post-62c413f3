import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Send, Bot, User, Loader2, MessageCircle, Paperclip,
  Mic, MicOff, File as FileIcon, X, Download, Video,
  Sparkles, Cpu, Workflow, AlertTriangle,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import ReactMarkdown from 'react-markdown';
import AgentRunPanel from '@/components/AgentRunPanel';
import { buildAgentRunPrompt, shouldLaunchAgentRun } from '@/lib/agentChat';

/* ── Types ───────────────────────────────────────────── */

interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: string;
  url: string;
  textContent?: string;
  isImage: boolean;
}

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  source?: 'app' | 'telegram';
  timestamp?: string;
  files?: FileAttachment[];
  images?: { url: string }[];
}

interface AgentRunPreview {
  id: string;
  prompt: string;
  status: string;
  error?: string | null;
  created_at: string;
  events?: Array<{ type: string; summary?: string; label?: string; message?: string; text?: string }>;
}

interface TelegramMediaItem {
  name?: string;
  type?: string;
  size?: number;
  url?: string;
}

interface TelegramRawUpdate {
  source?: string;
  update_id?: number;
  media?: {
    images?: TelegramMediaItem[];
    files?: TelegramMediaItem[];
  };
}

interface TelegramMessageRecord {
  chat_id?: number;
  created_at?: string;
  is_bot?: boolean;
  text?: string;
  raw_update?: TelegramRawUpdate;
}

interface ChatContextMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: { url: string }[];
  files?: Array<{ name: string; type: string; size: string; textContent?: string }>;
}

const APP_CHAT_STORAGE_KEY = 'ai-chat-browser-history-v1';
const MAX_STORED_MESSAGES = 200;
const BROWSER_MIRROR_SOURCE = 'browser-mirror';
const MAX_TEXT_ATTACHMENT_LENGTH = 10_000;
const AGENT_RUN_MARKER_PREFIX = '__AGENT_RUN__:';
const SUGGESTED_PROMPTS = [
  'Check queued jobs',
  'Show scheduled uploads',
  'Build me a landing page with agentic flow',
  'Research a niche and create a content plan',
];

function isStoredMessage(value: unknown): value is Msg {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Msg>;
  return (record.role === 'user' || record.role === 'assistant')
    && typeof record.content === 'string';
}

/* ── Stream helper — routes to cloud ai-chat edge function (Lovable AI Gateway) ── */

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`;

async function streamChat({
  messages,
  onDelta,
  onDone,
  onError,
}: {
  messages: ChatContextMessage[];
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
}) {
  const resp = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ messages }),
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({ error: 'Request failed' }));
    if (resp.status === 429) onError('Rate limit exceeded. Please wait a moment.');
    else if (resp.status === 402) onError('AI credits exhausted. Add credits in workspace settings.');
    else onError(data.error || `Error ${resp.status}`);
    return;
  }

  if (!resp.body) { onError('No response stream'); return; }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith(':') || line.trim() === '') continue;
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') break;
      try {
        const parsed = JSON.parse(jsonStr);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) onDelta(content);
      } catch {
        buffer = line + '\n' + buffer;
        break;
      }
    }
  }
  onDone();
}

/* ── Telegram indicator ──────────────────────────────── */

function TelegramIndicator({ connected, count }: { connected: boolean; count: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary/60">
      {connected ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-xs font-medium text-emerald-600">Telegram synced</span>
          {count > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 ml-1">
              {count}
            </Badge>
          )}
        </>
      ) : (
        <>
          <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
          <span className="text-xs text-muted-foreground">Telegram offline</span>
        </>
      )}
    </div>
  );
}

/* ── Voice recorder hook ─────────────────────────────── */

function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
      setDuration(0);
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch (err) {
      console.error('Microphone access denied:', err);
      throw err;
    }
  }, []);

  const stop = useCallback((): Promise<Blob> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) return;
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        recorder.stream.getTracks().forEach((t) => t.stop());
        clearInterval(timerRef.current);
        setRecording(false);
        setDuration(0);
        resolve(blob);
      };
      recorder.stop();
    });
  }, []);

  return { recording, duration, start, stop };
}

/* ── Main component ──────────────────────────────────── */

export default function AIChat() {
  const { toast } = useToast();
  const [appMessages, setAppMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voice = useVoiceRecorder();

  /* ── Telegram status ───────────────── */
  const { data: settings } = useQuery({
    queryKey: ['settings-telegram'],
    queryFn: async () => {
      const { data } = await supabase.from('app_settings').select('telegram_enabled, telegram_chat_id').eq('id', 1).single();
      return data;
    },
  });
  const telegramEnabled = !!(settings?.telegram_enabled && settings?.telegram_chat_id);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(APP_CHAT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setAppMessages(parsed.filter(isStoredMessage).slice(-MAX_STORED_MESSAGES));
    } catch (error) {
      console.error('Failed to restore browser chat history:', error);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(APP_CHAT_STORAGE_KEY, JSON.stringify(appMessages.slice(-MAX_STORED_MESSAGES)));
    } catch (error) {
      console.error('Failed to persist browser chat history:', error);
    }
  }, [appMessages]);

  /* ── Telegram history (polls every 4s) ── */
  const { data: telegramMessages } = useQuery({
    queryKey: ['telegram-history', settings?.telegram_chat_id || 'all'],
    queryFn: async () => {
      let query = supabase
        .from('telegram_messages')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(MAX_STORED_MESSAGES);
      if (settings?.telegram_chat_id) {
        query = query.eq('chat_id', Number(settings.telegram_chat_id));
      }
      const { data, error } = await query;
      if (error) console.error('Telegram fetch error:', error);
      return data || [];
    },
    refetchInterval: 2000,
  });

  const telegramSynced = telegramEnabled && (telegramMessages?.length ?? 0) > 0;

  const { data: recentAgentRuns } = useQuery({
    queryKey: ['chat-agent-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_runs')
        .select('id,prompt,status,error,created_at,events')
        .in('source', ['ai-chat', 'telegram', 'skill'])
        .order('created_at', { ascending: false })
        .limit(4);
      if (error) throw error;
      return (data || []) as AgentRunPreview[];
    },
    refetchInterval: 2000,
  });

  /* ── Resolve numeric chat_id from telegram_messages ── */
  const resolvedChatId = useMemo(() => {
    if (settings?.telegram_chat_id) return String(settings.telegram_chat_id);
    if (!telegramMessages?.length) return undefined;
    const latest = [...telegramMessages].reverse().find((m: TelegramMessageRecord) => m.chat_id);
    return latest ? String(latest.chat_id) : undefined;
  }, [settings?.telegram_chat_id, telegramMessages]);

  const activeAgentRuns = (recentAgentRuns || []).filter((run) => run.status === 'running');
  const failedAgentRuns = (recentAgentRuns || []).filter((run) => run.status === 'failed');
  const latestAgentRun = recentAgentRuns?.[0] || null;

  /* ── Mirror helper: send text to Telegram ── */
  const mirrorToTelegram = useCallback(async (text: string) => {
    if (!telegramEnabled || !resolvedChatId || !text.trim()) return;
    try {
      await supabase.functions.invoke('send-telegram', {
        body: { chat_id: resolvedChatId, text: text.slice(0, 3900) },
      });
    } catch (e) {
      console.error('Mirror to Telegram failed:', e);
    }
  }, [telegramEnabled, resolvedChatId]);

  const mirrorImageToTelegram = useCallback(async (file: FileAttachment, caption?: string) => {
    if (!telegramEnabled || !resolvedChatId || !file.url) return;
    try {
      const response = await fetch(file.url);
      const blob = await response.blob();
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
            reject(new Error('Invalid image data'));
            return;
          }
          const [, data] = reader.result.split(',', 2);
          if (!data) {
            reject(new Error('Invalid image data'));
            return;
          }
          resolve(data);
        };
        reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
        reader.readAsDataURL(blob);
      });
      await supabase.functions.invoke('send-telegram', {
        body: {
          chat_id: resolvedChatId,
          text: caption?.slice(0, 1000),
          photo_base64: base64,
          photo_mime_type: file.type || blob.type || 'image/png',
        },
      });
    } catch (error) {
      console.error('Mirror image to Telegram failed:', error);
    }
  }, [telegramEnabled, resolvedChatId]);

  const mirrorBrowserMessage = useCallback(async (speaker: 'You' | 'AI', text: string, files: FileAttachment[] = []) => {
    if (!telegramEnabled || !resolvedChatId) return;
    const imageFiles = files.filter((file) => file.isImage);
    const otherFiles = files.filter((file) => !file.isImage);
    const attachmentLines = otherFiles.map((file) => `• ${file.name}${file.url ? ` — ${file.url}` : ''}`);
    const summary = [
      `${speaker}: ${text.trim() || (files.length > 0 ? '[sent attachment]' : '')}`.trim(),
      attachmentLines.length > 0 ? `Attachments:\n${attachmentLines.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    if (summary) await mirrorToTelegram(summary);
    for (const [index, image] of imageFiles.entries()) {
      await mirrorImageToTelegram(image, index === 0 && !summary ? `${speaker} image: ${image.name}` : undefined);
    }
  }, [mirrorImageToTelegram, mirrorToTelegram, resolvedChatId, telegramEnabled]);

  /* ── Merge app + telegram messages by timestamp ── */
  const mapTelegramMediaToFiles = useCallback((rawUpdate?: TelegramRawUpdate): FileAttachment[] => {
    const media = rawUpdate?.media;
    if (!media) return [];

    const imageFiles: FileAttachment[] = (media.images || []).map((img, idx) => ({
      id: `${rawUpdate?.update_id || Date.now()}-img-${idx}`,
      name: img.name || `telegram-image-${idx + 1}.jpg`,
      type: img.type || 'image/jpeg',
      size: img.size ? `${Math.max(1, Math.round(img.size / 1024))} KB` : 'image',
      url: img.url,
      isImage: true,
    }));

    const otherFiles: FileAttachment[] = (media.files || [])
      .filter((f) => f.url)
      .map((f, idx) => ({
        id: `${rawUpdate?.update_id || Date.now()}-file-${idx}`,
        name: f.name || `telegram-file-${idx + 1}`,
        type: f.type || 'application/octet-stream',
        size: f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : 'file',
        url: f.url,
        isImage: (f.type || '').startsWith('image/'),
      }));

    return [...imageFiles, ...otherFiles];
  }, []);

  const messages = useMemo(() => {
    const tgMsgs: Msg[] = (telegramMessages || []).map((m: TelegramMessageRecord) => {
      const mediaFiles = mapTelegramMediaToFiles(m.raw_update);
      const source = m.raw_update?.source === BROWSER_MIRROR_SOURCE ? 'app' : 'telegram';
      return {
        role: m.is_bot ? 'assistant' as const : 'user' as const,
        content: m.text || '',
        source,
        timestamp: m.created_at,
        files: mediaFiles.length > 0 ? mediaFiles : undefined,
        images: mediaFiles.some((f) => f.isImage)
          ? mediaFiles.filter((f) => f.isImage).map((f) => ({ url: f.url }))
          : undefined,
      };
    });

    const all = [...appMessages, ...tgMsgs];
    all.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return ta - tb;
    });
    return all;
  }, [appMessages, telegramMessages, mapTelegramMediaToFiles]);

  /* ── Auto-scroll ───────────────────── */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ── File handling ─────────────────── */
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/');
      const sizeStr = file.size < 1024 * 1024
        ? `${(file.size / 1024).toFixed(0)} KB`
        : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
      const ext = file.name.split('.').pop() || 'bin';
      const storagePath = `chat/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const { error } = await supabase.storage.from('videos').upload(storagePath, file);
      if (error) { toast({ title: 'Upload failed', description: error.message, variant: 'destructive' }); continue; }
      const { data: urlData } = supabase.storage.from('videos').getPublicUrl(storagePath);
      let textContent: string | undefined;
      if (file.type.startsWith('text/') || /\.(txt|md|csv|json)$/.test(file.name)) {
        try {
          textContent = await file.text();
          if (textContent.length > MAX_TEXT_ATTACHMENT_LENGTH) {
            textContent = textContent.slice(0, MAX_TEXT_ATTACHMENT_LENGTH) + '\n... (truncated)';
          }
        } catch {
          textContent = undefined;
        }
      }
      setPendingFiles((prev) => [...prev, { id: storagePath, name: file.name, type: file.type, size: sizeStr, url: urlData.publicUrl, textContent, isImage }]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removePendingFile = (id: string) => setPendingFiles((prev) => prev.filter((f) => f.id !== id));

  /* ── Voice handling ────────────────── */
  const handleVoiceToggle = async () => {
    if (voice.recording) {
      try {
        const blob = await voice.stop();
        const storagePath = `chat/voice-${Date.now()}.webm`;
        await supabase.storage.from('videos').upload(storagePath, blob);
        const { data: urlData } = supabase.storage.from('videos').getPublicUrl(storagePath);
        setPendingFiles((prev) => [...prev, {
          id: storagePath, name: `Voice message (${voice.duration}s)`, type: 'audio/webm',
          size: `${(blob.size / 1024).toFixed(0)} KB`, url: urlData.publicUrl, isImage: false,
        }]);
        setInput((prev) => prev || '🎤 Voice message — please listen and respond');
      } catch { toast({ title: 'Voice recording failed', variant: 'destructive' }); }
    } else {
      try { await voice.start(); }
      catch { toast({ title: 'Microphone access denied', description: 'Please allow microphone access.', variant: 'destructive' }); }
    }
  };

  /* ── Send message ──────────────────── */
  const send = async () => {
    const text = input.trim();
    if ((!text && pendingFiles.length === 0) || isLoading) return;

    const imageFiles = pendingFiles.filter((f) => f.isImage);
    const otherFiles = pendingFiles.filter((f) => !f.isImage);

    const userMsg: Msg = {
      role: 'user', content: text, source: 'app', timestamp: new Date().toISOString(),
      files: pendingFiles.length > 0 ? [...pendingFiles] : undefined,
      images: imageFiles.length > 0 ? imageFiles.map((f) => ({ url: f.url })) : undefined,
    };

    setAppMessages((prev) => [...prev, userMsg]);
    setInput('');
    setPendingFiles([]);
    setIsLoading(true);

    // Mirror user message to Telegram + send typing indicator
    if (telegramEnabled && resolvedChatId) {
      void mirrorBrowserMessage('You', text, pendingFiles);
      // Show "typing..." in Telegram while AI thinks
      void supabase.functions.invoke('send-telegram', {
        body: { chat_id: resolvedChatId, action: 'typing' },
      });
    }

    let assistantSoFar = '';
    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setAppMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last?.source === 'app' && !last?.timestamp) {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantSoFar } : m));
        }
        return [...prev, { role: 'assistant', content: assistantSoFar, source: 'app' }];
      });
    };

    const contextMsgs: ChatContextMessage[] = appMessages.slice(-20).map((m) => {
      const base: ChatContextMessage = { role: m.role, content: m.content };
      if (m.images) base.images = m.images;
      if (m.files?.some((f) => !f.isImage)) {
        base.files = m.files.filter((f) => !f.isImage).map((f) => ({ name: f.name, type: f.type, size: f.size, textContent: f.textContent }));
      }
      return base;
    });

    const newMsg: ChatContextMessage = { role: 'user', content: text || 'Please analyze the attached file(s).' };
    if (imageFiles.length > 0) newMsg.images = imageFiles.map((f) => ({ url: f.url }));
    if (otherFiles.length > 0) newMsg.files = otherFiles.map((f) => ({ name: f.name, type: f.type, size: f.size, textContent: f.textContent }));
    contextMsgs.push(newMsg);

    if (shouldLaunchAgentRun(text, pendingFiles)) {
      try {
        const agentPrompt = buildAgentRunPrompt(text, pendingFiles);
        const { data, error } = await supabase.functions.invoke('agent-run', {
          body: { prompt: agentPrompt, source: 'ai-chat' },
        });
        if (error || data?.error || !data?.runId) {
          throw new Error(data?.error || error?.message || 'Agent run did not start');
        }

        const startedMessage = `${AGENT_RUN_MARKER_PREFIX}${data.runId}
🚀 Real agent run started.

I switched this request from normal chat mode into autonomous execution so you can watch the real plan, tools, progress, and any errors live in this tab.

Open the activity panel on the right if you want to follow the process flow while it runs.`;
        setAppMessages((prev) => [...prev, {
          role: 'assistant',
          content: startedMessage,
          source: 'app',
          timestamp: new Date().toISOString(),
        }]);
        if (telegramEnabled && resolvedChatId) {
          void mirrorBrowserMessage('AI', '🚀 Real agent run started. Watch the live progress feed in the app.');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const failureMessage = `⚠️ I could not start the autonomous agent.\n\nReason: ${message}`;
        setAppMessages((prev) => [...prev, {
          role: 'assistant',
          content: failureMessage,
          source: 'app',
          timestamp: new Date().toISOString(),
        }]);
        toast({ title: 'Agent start failed', description: message, variant: 'destructive' });
      } finally {
        setIsLoading(false);
      }
      return;
    }

    try {
      await streamChat({
        messages: contextMsgs,
        onDelta: upsert,
        onDone: () => {
          setIsLoading(false);
          setAppMessages((prev) =>
            prev.map((m, i) =>
              i === prev.length - 1 && m.role === 'assistant' && !m.timestamp
                ? { ...m, timestamp: new Date().toISOString() } : m
            )
          );
          // Mirror AI response to Telegram
          if (telegramEnabled && resolvedChatId && assistantSoFar.trim()) {
            void mirrorBrowserMessage('AI', assistantSoFar);
          }
        },
        onError: (err) => {
          toast({ title: 'AI Error', description: err, variant: 'destructive' });
          setIsLoading(false);
        },
      });
    } catch {
      toast({ title: 'Connection error', variant: 'destructive' });
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const formatTime = (ts?: string) => {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  /* ── Render ────────────────────────── */
  return (
    <div className="h-[calc(100dvh-4rem)] flex flex-col gap-4 px-4 py-4 md:h-[100dvh] md:px-6 md:py-6">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="border-0 bg-gradient-to-br from-primary/12 via-background to-secondary/60 shadow-sm">
          <div className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-[11px] font-medium text-primary shadow-sm">
                <Sparkles className="h-3.5 w-3.5" />
                Autonomous chat + live process flow
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">AI Assistant</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Chat here or via Telegram — complex requests now launch a real agent run with visible progress, tool steps, and errors.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => setInput(prompt)}
                    className="rounded-full border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 self-start">
              <TelegramIndicator connected={telegramSynced} count={telegramMessages?.length ?? 0} />
            </div>
          </div>
        </Card>

        <Card className="border shadow-sm">
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              <Workflow className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-medium">Run health</h2>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl border bg-secondary/40 p-3">
                <div className="text-[11px] text-muted-foreground">Running</div>
                <div className="mt-1 text-lg font-semibold">{activeAgentRuns.length}</div>
              </div>
              <div className="rounded-xl border bg-secondary/40 p-3">
                <div className="text-[11px] text-muted-foreground">Failed</div>
                <div className="mt-1 text-lg font-semibold">{failedAgentRuns.length}</div>
              </div>
              <div className="rounded-xl border bg-secondary/40 p-3">
                <div className="text-[11px] text-muted-foreground">Seen</div>
                <div className="mt-1 text-lg font-semibold">{recentAgentRuns?.length ?? 0}</div>
              </div>
            </div>
            {latestAgentRun ? (
              <div className={`rounded-xl border p-3 text-xs ${
                latestAgentRun.status === 'failed'
                  ? 'border-destructive/30 bg-destructive/5 text-destructive'
                  : latestAgentRun.status === 'running'
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-emerald-500/30 bg-emerald-500/5'
              }`}>
                <div className="flex items-center gap-2 font-medium">
                  {latestAgentRun.status === 'failed'
                    ? <AlertTriangle className="h-3.5 w-3.5" />
                    : <Cpu className={`h-3.5 w-3.5 ${latestAgentRun.status === 'running' ? 'animate-pulse' : ''}`} />}
                  Latest run: {latestAgentRun.status}
                </div>
                <p className="mt-1 line-clamp-2 text-muted-foreground">{latestAgentRun.prompt}</p>
                {latestAgentRun.error && <p className="mt-2 line-clamp-3">{latestAgentRun.error}</p>}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
                Ask for a complex workflow, app build, deep research, or agentic flow and the live run will appear here.
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="flex min-h-0 flex-col overflow-hidden border shadow-sm">
          <div className="flex-1 overflow-y-auto p-3 sm:p-5" ref={scrollRef}>
            <div className="mx-auto max-w-4xl space-y-5">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                    <Bot className="h-8 w-8 text-primary" />
                  </div>
                  <p className="font-medium text-foreground">How can I help you today?</p>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    Simple prompts stay conversational. Bigger requests automatically switch into a real autonomous run so you can watch the exact process live.
                    {telegramSynced && ' Your Telegram messages also appear here.'}
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    {SUGGESTED_PROMPTS.map((q) => (
                      <button key={q} onClick={() => setInput(q)}
                        className="rounded-full border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                  )}
                  <div className={`flex flex-col max-w-[90%] lg:max-w-[82%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                    {msg.source === 'telegram' && (
                      <div className="mb-1 flex items-center gap-1">
                        <MessageCircle className="h-3 w-3 text-sky-500" />
                        <span className="text-[10px] font-medium text-sky-500">Telegram</span>
                      </div>
                    )}

                    {msg.files && msg.files.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {msg.files.filter((f) => f.isImage).map((f) => (
                          <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                            className="block max-w-[280px] overflow-hidden rounded-xl border shadow-sm transition-shadow hover:shadow-md">
                            <img src={f.url} alt={f.name} className="h-auto max-h-48 w-full object-cover" />
                          </a>
                        ))}
                        {msg.files.filter((f) => !f.isImage && f.type?.startsWith('video/')).map((f) => (
                          <div key={f.id} className="max-w-[320px] overflow-hidden rounded-xl border shadow-sm">
                            <video src={f.url} controls preload="metadata" className="max-h-52 w-full rounded-t-xl" />
                            <div className="flex items-center gap-2 bg-secondary/50 px-3 py-1.5">
                              <Video className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <p className="flex-1 truncate text-xs font-medium">{f.name}</p>
                              <a href={f.url} target="_blank" rel="noopener noreferrer">
                                <Download className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                              </a>
                            </div>
                          </div>
                        ))}
                        {msg.files.filter((f) => !f.isImage && !f.type?.startsWith('video/')).map((f) => (
                          <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-2 rounded-lg border bg-secondary/50 px-3 py-2 transition-colors hover:bg-secondary">
                            <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium">{f.name}</p>
                              <p className="text-[10px] text-muted-foreground">{f.size}</p>
                            </div>
                            <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
                          </a>
                        ))}
                      </div>
                    )}

                    {msg.role === 'assistant' && msg.content && (msg.content.match(new RegExp(`${AGENT_RUN_MARKER_PREFIX}([0-9a-f-]+)`, 'g')) || []).map((m, idx) => {
                      const id = m.replace(AGENT_RUN_MARKER_PREFIX, '');
                      return <div key={idx} className="mb-2 w-full"><AgentRunPanel runId={id} /></div>;
                    })}

                    {msg.content && (
                      <div className={`rounded-2xl px-4 py-2.5 text-sm ${
                        msg.role === 'user'
                          ? msg.source === 'telegram'
                          ? 'bg-sky-100 text-sky-900 dark:bg-sky-900/30 dark:text-sky-100'
                          : 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-secondary-foreground'
                      }`}>
                        {msg.role === 'assistant' ? (
                          <div className="prose prose-sm max-w-none prose-neutral dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_code]:text-xs [&_pre]:rounded-lg [&_pre]:bg-muted">
                            <ReactMarkdown>{msg.content.replace(new RegExp(`${AGENT_RUN_MARKER_PREFIX}[0-9a-f-]+\\n?`, 'g'), '')}</ReactMarkdown>
                          </div>
                        ) : (
                          <span className="whitespace-pre-wrap break-words">{msg.content}</span>
                        )}
                      </div>
                    )}

                    {msg.timestamp && (
                      <span className={`mt-1 px-1 text-[10px] text-muted-foreground/50 ${msg.role === 'user' ? 'text-right' : ''}`}>
                        {formatTime(msg.timestamp)}
                      </span>
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                      msg.source === 'telegram' ? 'bg-sky-100 dark:bg-sky-900/30' : 'bg-muted'
                    }`}>
                      {msg.source === 'telegram' ? (
                        <MessageCircle className="h-4 w-4 text-sky-500" />
                      ) : (
                        <User className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  )}
                </div>
              ))}

              {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                  <div className="rounded-2xl bg-secondary px-4 py-3">
                    <div className="flex gap-1.5">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:0ms]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:150ms]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t bg-secondary/30 px-4 py-2">
              {pendingFiles.map((f) => (
                <div key={f.id} className="group relative">
                  {f.isImage ? (
                    <div className="h-16 w-16 overflow-hidden rounded-lg border shadow-sm">
                      <img src={f.url} alt={f.name} className="h-full w-full object-cover" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 shadow-sm">
                      <FileIcon className="h-4 w-4 text-muted-foreground" />
                      <span className="max-w-[120px] truncate text-xs">{f.name}</span>
                    </div>
                  )}
                  <button onClick={() => removePendingFile(f.id)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-1.5 border-t p-2 sm:gap-2 sm:p-3">
            <input ref={fileInputRef} type="file" accept="image/*,video/*,.txt,.md,.csv,.json,.pdf,.doc,.docx" multiple className="hidden" onChange={handleFileSelect} />
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground sm:h-10 sm:w-10"
              onClick={() => fileInputRef.current?.click()} disabled={isLoading}>
              <Paperclip className="h-4 w-4 sm:h-5 sm:w-5" />
            </Button>

            <Button variant={voice.recording ? 'destructive' : 'ghost'} size="icon"
              className={`hidden h-9 w-9 shrink-0 sm:flex sm:h-10 sm:w-10 ${!voice.recording ? 'text-muted-foreground hover:text-foreground' : ''}`}
              onClick={handleVoiceToggle} disabled={isLoading}>
              {voice.recording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </Button>

            {voice.recording && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
                <span className="tabular-nums text-xs font-medium text-destructive">{voice.duration}s</span>
              </div>
            )}

            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder={voice.recording ? 'Recording… click mic to stop' : 'Type a message…'}
              className="min-h-[40px] max-h-32 flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 sm:px-4 sm:py-2.5"
              rows={1} disabled={voice.recording} />

            <Button onClick={send} disabled={(!input.trim() && pendingFiles.length === 0) || isLoading || voice.recording}
              size="icon" className="h-9 w-9 shrink-0 rounded-xl sm:h-10 sm:w-10">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </Card>

        <div className="min-h-0 space-y-4">
          <Card className="border shadow-sm">
            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-medium">Live agent activity</h2>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  {activeAgentRuns.length > 0 ? `${activeAgentRuns.length} running` : 'idle'}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Complex prompts appear here as real autonomous runs. If a process cannot start or fails, the exact error will stay visible in this panel.
              </p>
            </div>
          </Card>

          <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
            {(recentAgentRuns || []).length === 0 ? (
              <Card className="border-dashed p-4 text-sm text-muted-foreground">
                No agent runs yet. Ask for a workflow, research task, or app build and this sidebar will turn into a live execution feed.
              </Card>
            ) : (
              recentAgentRuns?.map((run) => <AgentRunPanel key={run.id} runId={run.id} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
