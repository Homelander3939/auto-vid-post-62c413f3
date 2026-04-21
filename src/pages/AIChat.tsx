import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Send, Bot, User, Loader2, MessageCircle, Paperclip,
  Mic, MicOff, Image as ImageIcon, File as FileIcon, X, Download, Video,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import ReactMarkdown from 'react-markdown';

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

/* ── Stream helper — routes to cloud ai-chat edge function (Lovable AI Gateway) ── */

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`;

async function streamChat({
  messages,
  onDelta,
  onDone,
  onError,
}: {
  messages: any[];
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

  /* ── Telegram history (polls every 4s) ── */
  const { data: telegramMessages } = useQuery({
    queryKey: ['telegram-history'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('telegram_messages')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) console.error('Telegram fetch error:', error);
      return data || [];
    },
    refetchInterval: 2000,
  });

  const telegramSynced = telegramEnabled && (telegramMessages?.length ?? 0) > 0;

  /* ── Resolve numeric chat_id from telegram_messages ── */
  const resolvedChatId = useMemo(() => {
    if (!telegramMessages?.length) return undefined;
    const latest = [...telegramMessages].reverse().find((m: any) => m.chat_id);
    return latest ? String(latest.chat_id) : undefined;
  }, [telegramMessages]);

  /* ── Mirror helper: send text to Telegram ── */
  const mirrorToTelegram = useCallback(async (text: string) => {
    if (!telegramEnabled || !resolvedChatId || !text.trim()) return;
    try {
      await supabase.functions.invoke('send-telegram', {
        body: { chat_id: resolvedChatId, text: text.slice(0, 3900), parse_mode: 'HTML' },
      });
    } catch (e) {
      console.error('Mirror to Telegram failed:', e);
    }
  }, [telegramEnabled, resolvedChatId]);

  /* ── Merge app + telegram messages by timestamp ── */
  const mapTelegramMediaToFiles = useCallback((rawUpdate: any): FileAttachment[] => {
    const media = rawUpdate?.media;
    if (!media) return [];

    const imageFiles: FileAttachment[] = (media.images || []).map((img: any, idx: number) => ({
      id: `${rawUpdate?.update_id || Date.now()}-img-${idx}`,
      name: img.name || `telegram-image-${idx + 1}.jpg`,
      type: img.type || 'image/jpeg',
      size: img.size ? `${Math.max(1, Math.round(img.size / 1024))} KB` : 'image',
      url: img.url,
      isImage: true,
    }));

    const otherFiles: FileAttachment[] = (media.files || [])
      .filter((f: any) => f.url)
      .map((f: any, idx: number) => ({
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
    const tgMsgs: Msg[] = (telegramMessages || []).map((m: any) => {
      const mediaFiles = mapTelegramMediaToFiles(m.raw_update);
      return {
        role: m.is_bot ? 'assistant' as const : 'user' as const,
        content: m.text || '',
        source: 'telegram' as const,
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
        try { textContent = await file.text(); if (textContent.length > 10000) textContent = textContent.slice(0, 10000) + '\n... (truncated)'; } catch {}
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
      if (text) void mirrorToTelegram(`💬 ${text}`);
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

    const contextMsgs = messages.slice(-20).map((m) => {
      const base: any = { role: m.role, content: m.content };
      if (m.images) base.images = m.images;
      if (m.files?.some((f) => !f.isImage)) {
        base.files = m.files.filter((f) => !f.isImage).map((f) => ({ name: f.name, type: f.type, size: f.size, textContent: f.textContent }));
      }
      return base;
    });

    const newMsg: any = { role: 'user', content: text || 'Please analyze the attached file(s).' };
    if (imageFiles.length > 0) newMsg.images = imageFiles.map((f) => ({ url: f.url }));
    if (otherFiles.length > 0) newMsg.files = otherFiles.map((f) => ({ name: f.name, type: f.type, size: f.size, textContent: f.textContent }));
    contextMsgs.push(newMsg);

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
            void mirrorToTelegram(`🤖 ${assistantSoFar.slice(0, 3900)}`);
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
    <div className="space-y-3 h-[calc(100dvh-8rem)] md:h-[calc(100dvh-8rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">AI Assistant</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
            Chat here or via Telegram — synced in real-time
          </p>
        </div>
        <TelegramIndicator connected={telegramSynced} count={telegramMessages?.length ?? 0} />
      </div>

      {/* Chat area */}
      <Card className="flex-1 flex flex-col overflow-hidden border shadow-sm">
        <div className="flex-1 overflow-y-auto p-3 sm:p-5" ref={scrollRef}>
          <div className="space-y-5 max-w-3xl mx-auto">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
                  <Bot className="w-8 h-8 text-primary" />
                </div>
                <p className="font-medium text-foreground">How can I help you today?</p>
                <p className="text-sm text-muted-foreground mt-2 max-w-md">
                  I can check your upload queue, scheduled jobs, help with titles/tags,
                  and analyze images or documents.
                  {telegramSynced && ' Your Telegram messages also appear here.'}
                </p>
                <div className="flex flex-wrap gap-2 mt-6 justify-center">
                  {['Check queued jobs', 'Show scheduled uploads', 'Write a YouTube title', 'Suggest hashtags'].map((q) => (
                    <button key={q} onClick={() => setInput(q)}
                      className="px-3 py-1.5 rounded-full border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-primary" />
                  </div>
                )}
                <div className={`flex flex-col max-w-[85%] sm:max-w-[78%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  {/* Source label */}
                  {msg.source === 'telegram' && (
                    <div className="flex items-center gap-1 mb-1">
                      <MessageCircle className="w-3 h-3 text-sky-500" />
                      <span className="text-[10px] font-medium text-sky-500">Telegram</span>
                    </div>
                  )}

                  {/* File attachments */}
                  {msg.files && msg.files.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {msg.files.filter((f) => f.isImage).map((f) => (
                        <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                          className="block rounded-xl overflow-hidden border shadow-sm hover:shadow-md transition-shadow max-w-[280px]">
                          <img src={f.url} alt={f.name} className="w-full h-auto max-h-48 object-cover" />
                        </a>
                      ))}
                      {msg.files.filter((f) => !f.isImage && f.type?.startsWith('video/')).map((f) => (
                        <div key={f.id} className="rounded-xl overflow-hidden border shadow-sm max-w-[320px]">
                          <video src={f.url} controls preload="metadata" className="w-full max-h-52 rounded-t-xl" />
                          <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary/50">
                            <Video className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <p className="text-xs font-medium truncate flex-1">{f.name}</p>
                            <a href={f.url} target="_blank" rel="noopener noreferrer">
                              <Download className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                            </a>
                          </div>
                        </div>
                      ))}
                      {msg.files.filter((f) => !f.isImage && !f.type?.startsWith('video/')).map((f) => (
                        <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-secondary/50 hover:bg-secondary transition-colors">
                          <FileIcon className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium truncate">{f.name}</p>
                            <p className="text-[10px] text-muted-foreground">{f.size}</p>
                          </div>
                          <Download className="w-3 h-3 text-muted-foreground shrink-0" />
                        </a>
                      ))}
                    </div>
                  )}

                  {/* Agent run panels — extract __AGENT_RUN__:<uuid> markers */}
                  {msg.role === 'assistant' && msg.content && (msg.content.match(/__AGENT_RUN__:([0-9a-f-]+)/g) || []).map((m, idx) => {
                    const id = m.replace('__AGENT_RUN__:', '');
                    return <div key={idx} className="w-full mb-2"><AgentRunPanel runId={id} /></div>;
                  })}

                  {/* Message bubble */}
                  {msg.content && (
                    <div className={`rounded-2xl px-4 py-2.5 text-sm ${
                      msg.role === 'user'
                        ? msg.source === 'telegram'
                          ? 'bg-sky-100 text-sky-900 dark:bg-sky-900/30 dark:text-sky-100'
                          : 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground'
                    }`}>
                      {msg.role === 'assistant' ? (
                        <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:bg-muted [&_pre]:rounded-lg [&_code]:text-xs">
                          <ReactMarkdown>{msg.content.replace(/__AGENT_RUN__:[0-9a-f-]+\n?/g, '')}</ReactMarkdown>
                        </div>
                      ) : (
                        <span className="whitespace-pre-wrap break-words">{msg.content}</span>
                      )}
                    </div>
                  )}

                  {msg.timestamp && (
                    <span className={`text-[10px] text-muted-foreground/50 mt-1 px-1 ${msg.role === 'user' ? 'text-right' : ''}`}>
                      {formatTime(msg.timestamp)}
                    </span>
                  )}
                </div>
                {msg.role === 'user' && (
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                    msg.source === 'telegram' ? 'bg-sky-100 dark:bg-sky-900/30' : 'bg-muted'
                  }`}>
                    {msg.source === 'telegram' ? (
                      <MessageCircle className="w-4 h-4 text-sky-500" />
                    ) : (
                      <User className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* Typing indicator */}
            {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
                <div className="bg-secondary rounded-2xl px-4 py-3">
                  <div className="flex gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Pending files */}
        {pendingFiles.length > 0 && (
          <div className="border-t px-4 py-2 flex gap-2 flex-wrap bg-secondary/30">
            {pendingFiles.map((f) => (
              <div key={f.id} className="relative group">
                {f.isImage ? (
                  <div className="w-16 h-16 rounded-lg overflow-hidden border shadow-sm">
                    <img src={f.url} alt={f.name} className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-background shadow-sm">
                    <FileIcon className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs truncate max-w-[120px]">{f.name}</span>
                  </div>
                )}
                <button onClick={() => removePendingFile(f.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input area */}
        <div className="border-t p-2 sm:p-3 flex items-end gap-1.5 sm:gap-2">
          <input ref={fileInputRef} type="file" accept="image/*,video/*,.txt,.md,.csv,.json,.pdf,.doc,.docx" multiple className="hidden" onChange={handleFileSelect} />
          <Button variant="ghost" size="icon" className="shrink-0 h-9 w-9 sm:h-10 sm:w-10 text-muted-foreground hover:text-foreground"
            onClick={() => fileInputRef.current?.click()} disabled={isLoading}>
            <Paperclip className="w-4 h-4 sm:w-5 sm:h-5" />
          </Button>

          <Button variant={voice.recording ? 'destructive' : 'ghost'} size="icon" 
            className={`shrink-0 h-9 w-9 sm:h-10 sm:w-10 hidden sm:flex ${!voice.recording ? 'text-muted-foreground hover:text-foreground' : ''}`}
            onClick={handleVoiceToggle} disabled={isLoading}>
            {voice.recording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </Button>

          {voice.recording && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20">
              <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
              <span className="text-xs font-medium text-destructive tabular-nums">{voice.duration}s</span>
            </div>
          )}

          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} 
            placeholder={voice.recording ? 'Recording… click mic to stop' : 'Type a message…'}
            className="flex-1 min-h-[40px] max-h-32 resize-none rounded-xl border bg-background px-3 sm:px-4 py-2 sm:py-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            rows={1} disabled={voice.recording} />

          <Button onClick={send} disabled={(!input.trim() && pendingFiles.length === 0) || isLoading || voice.recording}
            size="icon" className="shrink-0 h-9 w-9 sm:h-10 sm:w-10 rounded-xl">
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </Card>
    </div>
  );
}
