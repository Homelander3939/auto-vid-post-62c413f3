import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Send, Bot, User, Loader2, MessageCircle, Wifi } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import ReactMarkdown from 'react-markdown';

type Msg = { role: 'user' | 'assistant'; content: string; source?: 'app' | 'telegram'; timestamp?: string };

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`;

async function streamChat({
  messages,
  onDelta,
  onDone,
  onError,
}: {
  messages: { role: string; content: string }[];
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

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith(':') || line.trim() === '') continue;
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') break;
      try {
        const parsed = JSON.parse(jsonStr);
        const content = parsed.choices?.[0]?.delta?.content as string | undefined;
        if (content) onDelta(content);
      } catch {
        buffer = line + '\n' + buffer;
        break;
      }
    }
  }
  onDone();
}

function TelegramIndicator({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {connected ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-xs text-emerald-600 font-medium">Telegram connected</span>
        </>
      ) : (
        <>
          <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
          <span className="text-xs text-muted-foreground">Telegram not configured</span>
        </>
      )}
    </div>
  );
}

export default function AIChat() {
  const { toast } = useToast();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Check if telegram is configured
  const { data: settings } = useQuery({
    queryKey: ['settings-telegram'],
    queryFn: async () => {
      const { data } = await supabase.from('app_settings').select('telegram_enabled, telegram_chat_id').eq('id', 1).single();
      return data;
    },
  });

  const telegramConnected = !!(settings?.telegram_enabled && settings?.telegram_chat_id);

  // Load telegram message history
  const { data: telegramMessages } = useQuery({
    queryKey: ['telegram-history'],
    queryFn: async () => {
      const { data } = await supabase
        .from('telegram_messages')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(100);
      return data || [];
    },
    refetchInterval: 5000,
  });

  // Merge telegram history into chat on first load
  useEffect(() => {
    if (telegramMessages && telegramMessages.length > 0 && !historyLoaded) {
      const tgMsgs: Msg[] = telegramMessages.map((m: any) => ({
        role: m.is_bot ? 'assistant' as const : 'user' as const,
        content: m.text || '',
        source: 'telegram' as const,
        timestamp: m.created_at,
      }));
      setMessages(tgMsgs);
      setHistoryLoaded(true);
    }
  }, [telegramMessages, historyLoaded]);

  // Subscribe to new telegram messages in realtime
  useEffect(() => {
    const channel = supabase
      .channel('telegram-live')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'telegram_messages',
      }, (payload: any) => {
        const m = payload.new;
        if (!m?.text) return;
        const newMsg: Msg = {
          role: m.is_bot ? 'assistant' : 'user',
          content: m.text,
          source: 'telegram',
          timestamp: m.created_at,
        };
        setMessages(prev => {
          // Avoid duplicates
          if (prev.some(p => p.source === 'telegram' && p.content === newMsg.content && p.timestamp === newMsg.timestamp)) return prev;
          return [...prev, newMsg];
        });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMsg: Msg = { role: 'user', content: text, source: 'app', timestamp: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    let assistantSoFar = '';
    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last?.source === 'app' && !last?.timestamp) {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantSoFar } : m));
        }
        return [...prev, { role: 'assistant', content: assistantSoFar, source: 'app' }];
      });
    };

    // Build context from recent messages
    const contextMsgs = messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
    contextMsgs.push({ role: 'user', content: text });

    try {
      await streamChat({
        messages: contextMsgs,
        onDelta: upsert,
        onDone: () => {
          setIsLoading(false);
          // Mark the assistant message with a timestamp
          setMessages(prev => prev.map((m, i) =>
            i === prev.length - 1 && m.role === 'assistant' && !m.timestamp
              ? { ...m, timestamp: new Date().toISOString() }
              : m
          ));
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const formatTime = (ts?: string) => {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-4 h-[calc(100vh-8rem)] flex flex-col">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Assistant</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Chat here or via Telegram — conversation syncs between both
          </p>
        </div>
        <div className="flex items-center gap-3 mt-1">
          <TelegramIndicator connected={telegramConnected} />
          {telegramMessages && telegramMessages.length > 0 && (
            <Badge variant="secondary" className="text-xs gap-1">
              <MessageCircle className="w-3 h-3" />
              {telegramMessages.length} messages
            </Badge>
          )}
        </div>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4" ref={scrollRef}>
          <div className="space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Bot className="w-12 h-12 text-muted-foreground/40 mb-4" />
                <p className="text-sm font-medium text-muted-foreground">Start a conversation</p>
                <p className="text-xs text-muted-foreground/70 mt-1 max-w-sm">
                  Ask for help with video titles, descriptions, tags, scheduling, or content strategy.
                  {telegramConnected && ' Your Telegram messages will also appear here.'}
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-primary" />
                  </div>
                )}
                <div className="flex flex-col max-w-[80%]">
                  {/* Source badge */}
                  {msg.source === 'telegram' && (
                    <div className="flex items-center gap-1 mb-1">
                      <MessageCircle className="w-3 h-3 text-blue-500" />
                      <span className="text-[10px] text-blue-500 font-medium">via Telegram</span>
                    </div>
                  )}
                  <div
                    className={`rounded-2xl px-4 py-2.5 text-sm ${
                      msg.role === 'user'
                        ? msg.source === 'telegram'
                          ? 'bg-blue-100 text-blue-900'
                          : 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    )}
                  </div>
                  {msg.timestamp && (
                    <span className={`text-[10px] text-muted-foreground/60 mt-0.5 ${msg.role === 'user' ? 'text-right' : ''}`}>
                      {formatTime(msg.timestamp)}
                    </span>
                  )}
                </div>
                {msg.role === 'user' && (
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                    msg.source === 'telegram' ? 'bg-blue-100' : 'bg-muted'
                  }`}>
                    {msg.source === 'telegram' ? (
                      <MessageCircle className="w-4 h-4 text-blue-500" />
                    ) : (
                      <User className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>
            ))}

            {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
                <div className="bg-secondary rounded-2xl px-4 py-2.5">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="border-t p-3 flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about video titles, descriptions, scheduling..."
            className="min-h-[44px] max-h-32 resize-none"
            rows={1}
          />
          <Button
            onClick={send}
            disabled={!input.trim() || isLoading}
            size="icon"
            className="shrink-0 h-11 w-11"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </Card>
    </div>
  );
}
