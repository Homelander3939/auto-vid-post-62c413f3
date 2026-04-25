// AI agent that researches a topic, finds/generates an image, and writes per-platform posts.
// Streams every reasoning + tool step via SSE so the UI can show a true agentic timeline.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { resolveChatProviderConfig } from '../_shared/ai-provider.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TELEGRAM_GATEWAY = 'https://connector-gateway.lovable.dev/telegram';

interface Body {
  prompt: string;
  platforms: string[];
  includeImage?: boolean;
  stream?: boolean;
}

const PLATFORM_RULES: Record<string, string> = {
  x: 'X (Twitter): MAX 270 chars total INCLUDING hashtags. Hook in first 7 words. Punchy, scroll-stopping. 1-3 hashtags max, integrated naturally. No emoji-spam (1-2 max).',
  facebook: 'Facebook: 80-300 words. Conversational, story-driven, like talking to a friend. Use line breaks for readability. Hashtags optional at the end (3-6). Emojis OK but tasteful.',
  linkedin: 'LinkedIn: 150-400 words. Professional but human voice. Lead with a strong insight or hook in line 1, then 2-4 short paragraphs (use blank lines). End with a question or call-to-action. 3-6 relevant business/industry hashtags at the end. Minimal emojis.',
};

type Variant = { description: string; hashtags: string[] };
type Variants = Record<string, Variant>;
type Source = { title: string; url: string; note?: string; snippet?: string; favicon?: string; publishedAt?: string };

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function sseEvent(event: string, data: any): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function faviconFor(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?sz=32&domain=${u.hostname}`;
  } catch { return ''; }
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function trimSnippet(s: string, n = 280): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function truncateText(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, Math.max(1, n - 1)).trimEnd() + '…' : t;
}

// ─────────────────────────────────────────────────────────────
// Telegram notify — mirrors the video-upload notification pattern
// so the user gets a generated-post preview (image + description +
// hashtags + sources + per-platform variants) right in Telegram.
// ─────────────────────────────────────────────────────────────
async function fetchImageBase64(supabase: any, imagePath: string | null): Promise<{ base64: string; mime: string } | null> {
  if (!imagePath) return null;
  try {
    const { data, error } = await supabase.storage.from('social-media').download(imagePath);
    if (error || !data) return null;
    const buf = new Uint8Array(await data.arrayBuffer());
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    return { base64: btoa(bin), mime: (data as any).type || 'image/png' };
  } catch { return null; }
}

function escapeHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds a SHORT caption that always fits inside Telegram's 1024-char photo
// caption limit. Used as the first message attached to the image.
function buildGenerationCaption(input: {
  prompt: string;
  primaryDescription: string;
  primaryHashtags: string[];
  variants: Variants;
  platforms: string[];
  sources: Source[];
  postId: string | null;
  imageCredit?: string;
  sourceImageCredit?: string;
}): string {
  const { prompt, primaryDescription, primaryHashtags, postId, imageCredit, sourceImageCredit } = input;
  const head = `✨ <b>New AI post generated</b>\nPrompt: ${escapeHtml(truncateText(prompt, 220))}`;
  const preview = primaryDescription
    ? `\n\n${escapeHtml(truncateText(primaryDescription, 380))}`
    : '';
  const tags = (primaryHashtags || []).slice(0, 4)
    .map((tag) => `#${tag.replace(/^#/, '')}`).join(' ');
  const tagLine = tags ? `\n${escapeHtml(tags)}` : '';
  const footer = [
    imageCredit ? `🎨 ${escapeHtml(truncateText(imageCredit, 80))}` : '',
    sourceImageCredit ? `🖼️ ${escapeHtml(truncateText(sourceImageCredit, 80))}` : '',
    postId ? `📝 <code>${postId}</code>` : '',
    `(Full post & sources in next messages…)`,
  ].filter(Boolean).join('\n');
  let caption = [head + preview + tagLine, footer].join('\n\n');
  if (caption.length > 1020) caption = caption.slice(0, 1018) + '…';
  return caption;
}

// Builds the FULL detailed body (per-platform variants + sources + footer) to
// be sent as one or more follow-up text messages (4096-char Telegram limit each).
function buildGenerationDetailMessages(input: {
  variants: Variants;
  platforms: string[];
  sources: Source[];
  postId: string | null;
}): string[] {
  const { variants, platforms, sources, postId } = input;
  const blocks: string[] = [];

  // Each platform = its own block (full text, no truncation).
  for (const platform of platforms) {
    const variant = variants[platform];
    if (!variant) continue;
    const desc = escapeHtml(variant.description || '');
    const tags = (variant.hashtags || [])
      .map((tag) => `#${tag.replace(/^#/, '')}`)
      .join(' ');
    blocks.push(`— <b>${platform.toUpperCase()}</b> —\n${desc}${tags ? `\n\n${escapeHtml(tags)}` : ''}`);
  }

  if (sources.length) {
    const sourceLines = sources.slice(0, 6).map((source, i) =>
      `${i + 1}. <a href="${escapeHtml(source.url)}">${escapeHtml(truncateText(source.title || hostnameOf(source.url), 80))}</a>`
    ).join('\n');
    blocks.push(`🔎 <b>Sources</b>\n${sourceLines}`);
  }

  blocks.push([
    postId ? `📝 Post ID: <code>${postId}</code>` : '',
    `Reply: <b>post</b> / <b>edit &lt;text&gt;</b> / <b>skip</b>`,
  ].filter(Boolean).join('\n'));

  // Pack blocks into <=3800-char chunks (safety margin under 4096).
  const MAX = 3800;
  const messages: string[] = [];
  let current = '';
  for (const block of blocks) {
    const piece = block.length > MAX ? block.slice(0, MAX - 1) + '…' : block;
    if (!current) { current = piece; continue; }
    if (current.length + 2 + piece.length <= MAX) {
      current += '\n\n' + piece;
    } else {
      messages.push(current);
      current = piece;
    }
  }
  if (current) messages.push(current);
  return messages;
}

type TelegramPreviewImage = { path: string; base64: string; mime: string };

function buildTelegramMultipart(parts: Uint8Array[]): Uint8Array {
  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

async function loadTelegramPreviewImages(supabase: any, imagePaths: string[]): Promise<TelegramPreviewImage[]> {
  const uniquePaths = [...new Set((imagePaths || []).filter(Boolean))].slice(0, 2);
  const loaded = await Promise.all(uniquePaths.map(async (path) => {
    const photo = await fetchImageBase64(supabase, path);
    return photo ? { path, base64: photo.base64, mime: photo.mime || 'image/png' } : null;
  }));
  return loaded.filter(Boolean) as TelegramPreviewImage[];
}

async function mirrorTgBot(chatId: number, text: string, source: string) {
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key || !chatId || !text) return;
    const sb = createClient(url, key);
    const updateId = -Math.floor(Date.now() * 1000 + Math.random() * 1000);
    await sb.from('telegram_messages').insert({
      update_id: updateId,
      chat_id: Number(chatId),
      text: text.slice(0, 4000),
      is_bot: true,
      raw_update: { source, synthetic: true },
    });
  } catch (e) {
    console.error('[generate-social-post] mirrorTgBot failed:', e);
  }
}

async function sendTelegramText(opts: {
  lovableApiKey: string; telegramApiKey: string; chatId: number; text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.lovableApiKey}`,
      'X-Connection-Api-Key': opts.telegramApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: opts.chatId,
      text: opts.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) {
    return { ok: false, error: `sendMessage ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
  }
  await mirrorTgBot(opts.chatId, opts.text, 'generate-social-post');
  return { ok: true };
}

async function sendTelegramGenerationPreview(opts: {
  supabase: any;
  lovableApiKey: string;
  telegramApiKey: string;
  chatId: number;
  imagePaths: string[];
  caption: string;
  detailMessages?: string[];
}): Promise<{ ok: boolean; error?: string }> {
  const { supabase, lovableApiKey, telegramApiKey, chatId, imagePaths, caption, detailMessages = [] } = opts;
  try {
    const photos = await loadTelegramPreviewImages(supabase, imagePaths);
    let imageSent: { ok: boolean; error?: string } = { ok: true };

    if (photos.length > 1) {
      const boundary = `----lovable-${crypto.randomUUID()}`;
      const enc = new TextEncoder();
      const parts: Uint8Array[] = [];
      const media = photos.map((photo, index) => {
        const ext = photo.mime.split('/')[1]?.split(';')[0] || 'png';
        return index === 0
          ? { type: 'photo', media: `attach://preview_${index}.${ext}`, caption, parse_mode: 'HTML' }
          : { type: 'photo', media: `attach://preview_${index}.${ext}` };
      });
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="media"\r\n\r\n${JSON.stringify(media)}\r\n`));
      for (let index = 0; index < photos.length; index++) {
        const photo = photos[index];
        const ext = photo.mime.split('/')[1]?.split(';')[0] || 'png';
        const bytes = Uint8Array.from(atob(photo.base64), (c) => c.charCodeAt(0));
        parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="preview_${index}.${ext}"; filename="preview_${index}.${ext}"\r\nContent-Type: ${photo.mime || 'image/png'}\r\n\r\n`));
        parts.push(bytes);
        parts.push(enc.encode(`\r\n`));
      }
      parts.push(enc.encode(`--${boundary}--\r\n`));
      const r = await fetch(`${TELEGRAM_GATEWAY}/sendMediaGroup`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          'X-Connection-Api-Key': telegramApiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: buildTelegramMultipart(parts),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        imageSent = { ok: false, error: `sendMediaGroup ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
      }
    } else if (photos.length === 1) {
      const photo = photos[0];
      const captionShort = caption.length > 1020 ? caption.slice(0, 1018) + '…' : caption;
      const boundary = `----lovable-${crypto.randomUUID()}`;
      const enc = new TextEncoder();
      const bytes = Uint8Array.from(atob(photo.base64), (c) => c.charCodeAt(0));
      const parts: Uint8Array[] = [];
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${captionShort}\r\n`));
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`));
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="post.png"\r\nContent-Type: ${photo.mime || 'image/png'}\r\n\r\n`));
      parts.push(bytes);
      parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
      const r = await fetch(`${TELEGRAM_GATEWAY}/sendPhoto`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          'X-Connection-Api-Key': telegramApiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: buildTelegramMultipart(parts),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        imageSent = { ok: false, error: `sendPhoto ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
      }
    } else {
      imageSent = await sendTelegramText({ lovableApiKey, telegramApiKey, chatId, text: caption });
    }

    if (!imageSent.ok) return imageSent;

    // Follow-up text messages with the FULL per-platform variants + sources.
    for (const chunk of detailMessages) {
      if (!chunk?.trim()) continue;
      const sent = await sendTelegramText({ lovableApiKey, telegramApiKey, chatId, text: chunk });
      if (!sent.ok) return sent;
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'unknown' };
  }
}

// ─────────────────────────────────────────────────────────────
// Web search providers
// ─────────────────────────────────────────────────────────────

async function searchBrave(apiKey: string, query: string, count = 6): Promise<Source[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&freshness=pw`, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Brave ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const results = data?.web?.results || [];
  return results.slice(0, count).map((x: any) => ({
    title: x.title, url: x.url, snippet: trimSnippet(x.description || ''),
    favicon: faviconFor(x.url), publishedAt: x.age || x.page_age,
  }));
}

async function searchTavily(apiKey: string, query: string, count = 6): Promise<Source[]> {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: 'advanced', include_answer: false, days: 7 }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data?.results || []).slice(0, count).map((x: any) => ({
    title: x.title, url: x.url, snippet: trimSnippet(x.content || ''),
    favicon: faviconFor(x.url), publishedAt: x.published_date,
  }));
}

async function searchSerper(apiKey: string, query: string, count = 6): Promise<Source[]> {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: count, tbs: 'qdr:w' }),
  });
  if (!r.ok) throw new Error(`Serper ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data?.organic || []).slice(0, count).map((x: any) => ({
    title: x.title, url: x.link, snippet: trimSnippet(x.snippet || ''),
    favicon: faviconFor(x.link), publishedAt: x.date,
  }));
}

async function searchFirecrawl(apiKey: string, query: string, count = 6): Promise<Source[]> {
  const r = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: count, tbs: 'qdr:w' }),
  });
  if (!r.ok) throw new Error(`Firecrawl ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const list = data?.data || data?.web || [];
  return list.slice(0, count).map((x: any) => ({
    title: x.title, url: x.url, snippet: trimSnippet(x.description || x.markdown || ''),
    favicon: faviconFor(x.url),
  }));
}

// Local browser fallback — routed through pending_commands so the user's local Playwright
// worker (which polls Supabase) can do the actual DuckDuckGo/Google scraping. This works
// from cloud edge functions where localhost:3001 is unreachable.
async function searchLocalViaCommand(supabase: any, query: string, count = 6, timeoutMs = 25000): Promise<Source[]> {
  const { data: inserted, error } = await supabase
    .from('pending_commands')
    .insert({ command: 'research_search', args: { query, count } })
    .select('id')
    .single();
  if (error || !inserted?.id) throw new Error(`Could not queue local research: ${error?.message || 'unknown'}`);
  const cmdId = inserted.id;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data: row } = await supabase
      .from('pending_commands')
      .select('status, result')
      .eq('id', cmdId)
      .single();
    if (!row) continue;
    if (row.status === 'completed') {
      try {
        const parsed = JSON.parse(row.result || '{}');
        const list = Array.isArray(parsed?.results) ? parsed.results : [];
        return list.slice(0, count).map((x: any) => ({
          title: x.title, url: x.url, snippet: trimSnippet(x.snippet || ''),
          favicon: faviconFor(x.url),
        }));
      } catch { return []; }
    }
    if (row.status === 'failed') throw new Error(row.result || 'Local research failed');
  }
  throw new Error('Local research timed out (worker offline?)');
}

type LocalImageCandidate = { url: string; source?: string; pageUrl?: string; title?: string; alt?: string };

async function searchLocalImagesViaCommand(
  supabase: any,
  query: string,
  sourceUrls: string[] = [],
  count = 5,
  timeoutMs = 25000,
): Promise<{ provider: string; images: LocalImageCandidate[] }> {
  const urls = [...new Set((sourceUrls || []).filter(Boolean))].slice(0, 4);
  const { data: inserted, error } = await supabase
    .from('pending_commands')
    .insert({ command: 'image_search', args: { query, count, urls } })
    .select('id')
    .single();
  if (error || !inserted?.id) throw new Error(`Could not queue local image search: ${error?.message || 'unknown'}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { data: row } = await supabase
      .from('pending_commands')
      .select('status, result')
      .eq('id', inserted.id)
      .single();
    if (!row) continue;
    if (row.status === 'completed') {
      try {
        const parsed = JSON.parse(row.result || '{}');
        const images = Array.isArray(parsed?.images) ? parsed.images : [];
        return { provider: parsed?.provider || 'none', images };
      } catch {
        return { provider: 'none', images: [] };
      }
    }
    if (row.status === 'failed') throw new Error(row.result || 'Local image search failed');
  }

  throw new Error('Local image search timed out (worker offline?)');
}

async function runSearch(opts: {
  provider: string; key: string; query: string; count?: number; supabase: any;
}): Promise<{ sources: Source[]; usedProvider: string }> {
  const { provider, key, query, count = 6, supabase } = opts;
  const order: string[] = [];
  if (provider && provider !== 'auto' && provider !== 'local') order.push(provider);
  // Always try local browser fallback last (via pending_commands queue)
  order.push('local');

  let lastErr: any = null;
  for (const p of order) {
    try {
      let sources: Source[] = [];
      if (p === 'brave' && key) sources = await searchBrave(key, query, count);
      else if (p === 'tavily' && key) sources = await searchTavily(key, query, count);
      else if (p === 'serper' && key) sources = await searchSerper(key, query, count);
      else if (p === 'firecrawl' && key) sources = await searchFirecrawl(key, query, count);
      else if (p === 'local') sources = await searchLocalViaCommand(supabase, query, count);
      else continue;
      if (sources.length) return { sources, usedProvider: p === 'local' ? 'local-browser' : p };
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return { sources: [], usedProvider: 'none' };
}

// Fetch & extract main text (cheap, no rendering)
async function scrapeUrl(url: string): Promise<string> {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LovableAgent/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return '';
    const html = await r.text();
    // Strip scripts/styles and tags
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 4000);
  } catch { return ''; }
}

// ─────────────────────────────────────────────────────────────
// Image providers
// ─────────────────────────────────────────────────────────────

async function findUnsplashImage(key: string, query: string): Promise<{ url: string; credit: string } | null> {
  try {
    const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=squarish`, {
      headers: { Authorization: `Client-ID ${key}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const img = d?.results?.[0];
    if (!img) return null;
    return { url: img.urls?.regular || img.urls?.full, credit: `Photo by ${img.user?.name || 'Unsplash'}` };
  } catch { return null; }
}

async function findPexelsImage(key: string, query: string): Promise<{ url: string; credit: string } | null> {
  try {
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
      headers: { Authorization: key },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const img = d?.photos?.[0];
    if (!img) return null;
    return { url: img.src?.large || img.src?.original, credit: `Photo by ${img.photographer || 'Pexels'}` };
  } catch { return null; }
}

// Quota/rate-limit detection — used by the multi-key fallback chain.
function isQuotaError(status: number, errText: string): boolean {
  if (status === 429 || status === 402 || status === 403) return true;
  const t = (errText || '').toLowerCase();
  return /quota|rate.?limit|exceed|insufficient|billing|payment|too.many.requests/.test(t);
}

const GOOGLE_IMAGE_MODEL_PREFERENCE = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
];

function normalizeGoogleImageModel(model?: string): string {
  return (model || '').replace(/^models\//, '').trim();
}

function isGoogleAIStudioImageModel(model?: string): boolean {
  const m = normalizeGoogleImageModel(model).toLowerCase();
  return /^gemini-.*image/.test(m) || /nano.?banana/.test(m);
}

function dedupeGoogleImageModels(models: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const model = normalizeGoogleImageModel(raw);
    if (!model || seen.has(model) || !isGoogleAIStudioImageModel(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

async function listGoogleAIStudioImageModels(apiKey: string): Promise<string[]> {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) return [];
    const j = await r.json();
    const all = (j?.models || []) as any[];
    return dedupeGoogleImageModels(
      all
        .filter((m) => {
          const supportsGenerateContent = (m.supportedGenerationMethods || []).includes('generateContent');
          const looksImageCapable =
            /gemini.*image/i.test(m.name || '') ||
            /gemini.*image/i.test(m.displayName || '') ||
            /nano.?banana/i.test(m.displayName || '') ||
            /generates? images?/i.test(m.description || '');
          return supportsGenerateContent && looksImageCapable;
        })
        .map((m) => normalizeGoogleImageModel(m.name)),
    );
  } catch {
    return [];
  }
}

function buildGoogleImageAttemptOrder(configuredModel?: string, discoveredModels: string[] = []): string[] {
  const preferred = normalizeGoogleImageModel(configuredModel);
  return dedupeGoogleImageModels([
    preferred,
    ...GOOGLE_IMAGE_MODEL_PREFERENCE,
    ...discoveredModels,
  ]);
}

interface AIImageResult { dataUrl: string | null; error?: string; status?: number }

async function generateAIImage(provider: string, key: string, prompt: string, model?: string): Promise<AIImageResult> {
  try {
    if (provider === 'openai' && key) {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
      });
      if (!r.ok) return { dataUrl: null, error: (await r.text()).slice(0, 200), status: r.status };
      const d = await r.json();
      const b64 = d?.data?.[0]?.b64_json;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : (d?.data?.[0]?.url || null) };
    }
    if (provider === 'google' && key) {
      const m = normalizeGoogleImageModel(model) || 'gemini-2.5-flash-image';
      if (!isGoogleAIStudioImageModel(m)) {
        return {
          dataUrl: null,
          error: `${m} is not a supported Google AI Studio image model in this app. Use a Gemini image model instead.`,
          status: 400,
        };
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 1500) }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        }),
      });
      if (!r.ok) {
        const errTxt = (await r.text()).slice(0, 300);
        return { dataUrl: null, error: `Google ${m} ${r.status}: ${errTxt}`, status: r.status };
      }
      const d = await r.json();
      const parts = d?.candidates?.[0]?.content?.parts || [];
      const inline = parts.find((p: any) => p?.inlineData?.data || p?.inline_data?.data);
      const data = inline?.inlineData?.data || inline?.inline_data?.data;
      const mime = inline?.inlineData?.mimeType || inline?.inline_data?.mime_type || 'image/png';
      if (!data) {
        const finishReason = d?.candidates?.[0]?.finishReason || 'unknown';
        const safety = JSON.stringify(d?.candidates?.[0]?.safetyRatings || []).slice(0, 150);
        return { dataUrl: null, error: `Google ${m}: no image (finish=${finishReason}, safety=${safety})` };
      }
      return { dataUrl: `data:${mime};base64,${data}` };
    }
    if (provider === 'nvidia' && key) {
      // NVIDIA NIM uses model-specific invoke URLs under ai.api.nvidia.com/v1/genai
      // for image models like FLUX/SDXL. The OpenAI-compatible /v1/images/generations
      // endpoint does NOT exist on integrate.api.nvidia.com — that's only for chat.
      const m = model || 'black-forest-labs/flux.1-schnell';
      const url = `https://ai.api.nvidia.com/v1/genai/${m}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          prompt: prompt.slice(0, 1500),
          width: 1024, height: 1024, samples: 1, steps: 4, seed: 0,
          cfg_scale: 3.5,
        }),
      });
      if (!r.ok) {
        return { dataUrl: null, error: `NVIDIA ${r.status}: ${(await r.text()).slice(0, 200)}`, status: r.status };
      }
      const d = await r.json();
      const b64 = d?.image || d?.artifacts?.[0]?.base64 || d?.data?.[0]?.b64_json || d?.images?.[0];
      const u = d?.data?.[0]?.url;
      if (!b64 && !u) return { dataUrl: null, error: `NVIDIA: no image in response (keys: ${Object.keys(d).join(',')})`, status: 200 };
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : (u || null) };
    }
    if (provider === 'xai' && key) {
      const m = model || 'grok-2-image-1212';
      const r = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, prompt: prompt.slice(0, 1500), n: 1, response_format: 'b64_json' }),
      });
      if (!r.ok) return { dataUrl: null, error: (await r.text()).slice(0, 200), status: r.status };
      const d = await r.json();
      const b64 = d?.data?.[0]?.b64_json;
      const url = d?.data?.[0]?.url;
      return { dataUrl: b64 ? `data:image/png;base64,${b64}` : (url || null) };
    }
    // Lovable AI Gateway (default — Nano Banana family, key auto-injected)
    const lk = Deno.env.get('LOVABLE_API_KEY');
    if (!lk) return { dataUrl: null, error: 'LOVABLE_API_KEY not configured' };
    const r = await fetch(LOVABLE_GATEWAY, {
      method: 'POST', headers: { Authorization: `Bearer ${lk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'google/gemini-2.5-flash-image',
        messages: [{ role: 'user', content: prompt.slice(0, 1500) }],
        modalities: ['image', 'text'],
      }),
    });
    if (!r.ok) return { dataUrl: null, error: (await r.text()).slice(0, 200), status: r.status };
    const d = await r.json();
    return { dataUrl: d?.choices?.[0]?.message?.images?.[0]?.image_url?.url || null };
  } catch (e: any) {
    return { dataUrl: null, error: e?.message || 'unknown error' };
  }
}

// Try a chain of {provider, key, model} entries in order; rotate to next on quota/rate errors.
interface ImageKeyEntry { provider: string; apiKey: string; model: string; label?: string }
async function generateWithFallbackChain(
  chain: ImageKeyEntry[],
  prompt: string,
  onAttempt: (entry: ImageKeyEntry, idx: number) => void,
  onFail: (entry: ImageKeyEntry, idx: number, reason: string) => void,
): Promise<{ dataUrl: string | null; usedEntry?: ImageKeyEntry; usedIndex?: number }> {
  // Try every configured key/model first; only then add Google alternates.
  const primary: ImageKeyEntry[] = [];
  const alternates: ImageKeyEntry[] = [];
  for (const e of chain) {
    if (e.provider === 'google' && e.apiKey) {
      const discovered = await listGoogleAIStudioImageModels(e.apiKey);
      const ordered = buildGoogleImageAttemptOrder(e.model, discovered);
      const first = ordered[0] || GOOGLE_IMAGE_MODEL_PREFERENCE[0];
      primary.push({ ...e, model: first });
      for (const alt of ordered.slice(1)) {
        alternates.push({ ...e, model: alt, label: `${e.label || 'google'} → ${alt}` });
      }
    } else {
      primary.push(e);
    }
  }
  const expanded = [...primary, ...alternates];
  for (let i = 0; i < expanded.length; i++) {
    const e = expanded[i];
    onAttempt(e, i);
    const res = await generateAIImage(e.provider, e.apiKey, prompt, e.model);
    if (res.dataUrl) return { dataUrl: res.dataUrl, usedEntry: e, usedIndex: i };
    const reason = res.error || 'no image returned';
    onFail(e, i, `${res.status || ''} ${reason}`.trim());
    void isQuotaError(res.status || 0, reason);
  }
  return { dataUrl: null };
}

async function uploadImageToBucket(supabase: any, urlOrDataUrl: string): Promise<{ url: string; path: string } | null> {
  try {
    let bytes: Uint8Array, mime = 'image/jpeg', ext = 'jpg';
    if (urlOrDataUrl.startsWith('data:image/')) {
      const [meta, b64] = urlOrDataUrl.split(',');
      mime = meta.match(/data:(image\/\w+)/)?.[1] || 'image/png';
      ext = mime.split('/')[1] || 'png';
      bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } else {
      const r = await fetch(urlOrDataUrl);
      if (!r.ok) return null;
      mime = r.headers.get('content-type') || 'image/jpeg';
      ext = mime.split('/')[1]?.split(';')[0] || 'jpg';
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    const storagePath = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from('social-media').upload(storagePath, bytes, { contentType: mime, upsert: false });
    if (error) return null;
    const { data: pub } = supabase.storage.from('social-media').getPublicUrl(storagePath);
    return { url: pub.publicUrl, path: storagePath };
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// LLM helpers
// ─────────────────────────────────────────────────────────────

interface LLMOpts { endpoint: string; apiKey: string; model: string; googleMode: boolean }

async function callLLMJson(opts: LLMOpts & { systemPrompt: string; userPrompt: string; schema: any; toolName: string }): Promise<any> {
  const { endpoint, apiKey, model, systemPrompt, userPrompt, schema, googleMode, toolName } = opts;
  if (googleMode) {
    const modelName = model.replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
      }),
    });
    if (!resp.ok) throw new Error(`Google API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const txt = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '{}';
    return JSON.parse(txt);
  }
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      tools: [{ type: 'function', function: { name: toolName, description: 'Return structured output', parameters: schema } }],
      tool_choice: { type: 'function', function: { name: toolName } },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    if (resp.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 });
    if (resp.status === 402) throw Object.assign(new Error('Credits exhausted'), { status: 402 });
    throw new Error(`AI API ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  const args = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (args) return JSON.parse(args);
  return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
}

// ─────────────────────────────────────────────────────────────
// Prompts & schemas for the agent stages
// ─────────────────────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', description: 'One sentence: what the post should accomplish' },
    needsResearch: { type: 'boolean' },
    queries: { type: 'array', items: { type: 'string' }, description: '2-4 focused web search queries' },
    imageStrategy: { type: 'string', enum: ['real_photo', 'generated', 'none'] },
    imageQuery: { type: 'string', description: 'For real_photo: stock photo search query. For generated: image prompt. Empty for none.' },
    angle: { type: 'string', description: 'The angle/hook the post should take' },
  },
  required: ['intent', 'needsResearch', 'queries', 'imageStrategy', 'imageQuery', 'angle'],
};

const REPLAN_SCHEMA = {
  type: 'object',
  properties: {
    haveEnough: { type: 'boolean', description: 'True if current sources are sufficient to write a great post' },
    followUpQuery: { type: 'string', description: 'If not enough, ONE more focused search query to fill gaps. Empty if haveEnough.' },
    keyFacts: { type: 'array', items: { type: 'string' }, description: '3-6 specific facts/quotes/numbers extracted from sources to use in the post' },
  },
  required: ['haveEnough', 'followUpQuery', 'keyFacts'],
};

function writeSchema(platforms: string[]) {
  const variantProps: Record<string, any> = {};
  for (const p of platforms) {
    variantProps[p] = {
      type: 'object',
      properties: {
        description: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' } },
      },
      required: ['description', 'hashtags'],
    };
  }
  return {
    type: 'object',
    properties: { variants: { type: 'object', properties: variantProps, required: platforms } },
    required: ['variants'],
  };
}

function nowContext(): string {
  const now = new Date();
  const iso = now.toISOString();
  const human = now.toUTCString();
  const date = iso.slice(0, 10);
  return `CURRENT DATE/TIME (UTC): ${human} (ISO ${iso}).
Today's date is ${date}. The current year is ${now.getUTCFullYear()}.
You ARE running inside an autonomous agent that HAS live internet access via web-search tools and a local browser.
Never refuse with "I don't have real-time data" — the orchestrator runs the searches FOR you and feeds the results back. Your job is to plan what to search and then USE the returned facts.`;
}

function planPrompt() {
  return `You are an autonomous research+social-media agent (OpenClaw-style). Plan how to fulfill the user goal.

${nowContext()}

PLANNING RULES:
- needsResearch: TRUE for any topic that benefits from current information (news, trends, products, events, prices, releases, "latest", "recent", time-bounded asks like "last 24 hours"/"this week"). Default to TRUE unless the prompt is purely creative/timeless.
- queries: 2-4 SHARP, SPECIFIC search queries. Embed the CURRENT YEAR and time qualifiers ("${new Date().getUTCFullYear()}", "this week", "today", explicit month names) when freshness matters. Vary angles (broad → narrow, different keywords).
- imageStrategy:
  • "real_photo" — news, real events, products, places, real people. Use 2-5 word stock photo query.
  • "generated" — abstract concepts, illustrations, "imagine if" posts. Provide a vivid, concrete AI image prompt (subject + setting + style + lighting, no text overlays).
  • "none" — only if user explicitly says no image.
- angle: the editorial hook (curiosity, contrast, FOMO, contrarian take, surprising stat).

Return via the plan tool. Do NOT refuse — planning is always possible.`;
}

function replanPrompt(originalGoal: string, sources: Source[]) {
  const summarised = sources.map((s, i) => `[${i + 1}] ${s.title} — ${hostnameOf(s.url)}\n   ${s.snippet || ''}`).join('\n\n');
  return `${nowContext()}

Original goal: "${originalGoal}"

Current research collected (real, just now):
${summarised}

Decide: do we have enough specific, factual material to write an excellent, NON-generic post? Or do we need ONE more focused search to fill a gap?
Also extract 3-6 KEY FACTS (specific quotes, numbers, names, dates, links) we should weave into the post.`;
}

function writePromptSystem(platforms: string[]) {
  const rules = platforms.map((p) => `- ${PLATFORM_RULES[p] || p}`).join('\n');
  return `You are a senior social-media manager writing posts based on REAL researched facts the orchestrator already gathered for you.

${nowContext()}

PER-PLATFORM RULES:
${rules}

GLOBAL RULES:
- The user provides a goal. The agent ALREADY ran web searches and scraped pages — the FACTS section below is real, current data. USE IT. Never reply with "I can't access real-time information" or ask the user to provide facts — they are already provided.
- If the FACTS section is sparse, still write the best post you can from what's there + the goal/angle. Never refuse.
- Write a SEPARATE variant for EVERY requested platform, even if the topic is hard. No empty variants, no apologies.
- Sound like a real person, not a brand bot. No "in today's fast-paced world", no "unlock the power of", no "game-changer".
- Lead with a hook — curiosity, contrast, a question, a bold claim, or a stat.
- Weave in the SPECIFIC FACTS (numbers, names, dates) — do NOT invent facts that weren't given.
- Active voice. Short sentences mixed with longer ones. Cut filler.
- Hashtags must be lowercased single words or short phrases (no spaces, no #, no leading punctuation).
- DO NOT include source URLs in the post text — they are for the user's reference only.

Return via the compose_post tool with one entry PER requested platform.`;
}

function writePromptUser(goal: string, angle: string, facts: string[], sources: Source[], platforms: string[]) {
  return `User goal: ${goal}
Target platforms (return one variant for EACH): ${platforms.join(', ')}

Editorial angle: ${angle}

Key facts to use (from real research, gathered just now):
${facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(no extracted facts — synthesize from sources below + your knowledge of the angle)'}

Sources used (DO NOT cite URLs in post, just for your context):
${sources.length ? sources.map((s, i) => `[${i + 1}] ${s.title} (${hostnameOf(s.url)}) — ${s.snippet || ''}`).join('\n') : '(no sources — write based on the goal + angle alone)'}

Now write a SEPARATE tailored variant for EACH platform listed above. Never skip a platform.`;
}

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
  if (!body?.prompt || !Array.isArray(body.platforms) || body.platforms.length === 0) {
    return new Response(JSON.stringify({ error: 'prompt and platforms are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: settings } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  const s: any = settings || {};

  const config = resolveChatProviderConfig({
    provider: s.ai_provider,
    apiKey: s.ai_api_key,
    model: s.ai_model,
    baseUrl: s.ai_base_url,
  }, Deno.env.get('LOVABLE_API_KEY') || '');
  if (config.fallbackReason) {
    console.warn('generate-social-post provider fallback:', config.fallbackReason);
  }
  const apiKey = config.key;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'No AI API key. Configure one in Settings.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Named for use in the SSE event labels below.
  const provider = config.requestedProvider;
  const textModel = config.model;

  const llm: LLMOpts = { endpoint: config.url, apiKey, model: config.model, googleMode: config.googleMode };
  const researchProvider = s.research_provider || 'auto';
  const researchKey = s.research_api_key || '';
  const imageProvider = s.image_provider || 'auto';
  const imageKey = s.image_api_key || '';
  const imageModel = s.image_model || '';
  const imageKeysChain: { id?: string; provider: string; apiKey: string; model: string; label?: string; enabled?: boolean }[] =
    Array.isArray(s.image_keys) ? s.image_keys : [];
  const localUrl = s.local_agent_url || 'http://localhost:3001';

  const wantsStream = body.stream !== false;

  // ── Serialization guard ──
  // Auto-cancel any stale running job (>10 min) so the queue self-heals.
  // Then refuse if a fresh job is still actively running — only one agentic task at a time.
  // EXCEPTION: when an `existingJobId` is supplied (the orchestrator, e.g. ai-chat tool,
  // already created the row and validated there's no conflict), reuse it directly.
  try { await supabase.rpc('cancel_stale_generation_jobs'); } catch { /* best-effort */ }

  let jobId: string | null = null;
  const existingJobId: string | undefined = body.existingJobId;
  if (existingJobId) {
    // Trust the orchestrator's row — just verify it exists and is still running.
    const { data: existing } = await supabase
      .from('generation_jobs')
      .select('id, status')
      .eq('id', existingJobId)
      .maybeSingle();
    if (existing && (existing as any).status === 'running') {
      jobId = (existing as any).id;
    }
  }

  if (!jobId) {
    const { data: liveJobs } = await supabase
      .from('generation_jobs')
      .select('id, prompt, created_at')
      .eq('status', 'running')
      .order('created_at', { ascending: false })
      .limit(1);
    if (liveJobs && liveJobs.length > 0) {
      return new Response(JSON.stringify({
        error: 'Another generation is already running. Cancel it first or wait for it to finish.',
        busyJobId: liveJobs[0].id,
        busyPrompt: liveJobs[0].prompt,
      }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Persist a generation_jobs row so the UI can resume after navigating away and the
    // Job Queue can show live progress without holding the browser SSE stream open.
    const { data: jobRow } = await supabase.from('generation_jobs').insert({
      prompt: body.prompt,
      platforms: body.platforms,
      include_image: !!body.includeImage,
      status: 'running',
      events: [],
    }).select('id').single();
    jobId = jobRow?.id || null;
  }

  // ── Cancellation polling ──
  // Periodically check the job row; if user marked it 'cancelled', abort the agent loop.
  let cancelRequested = false;
  let cancelTimer: number | undefined;
  if (jobId) {
    const checkCancel = async () => {
      try {
        const { data } = await supabase.from('generation_jobs').select('status').eq('id', jobId).single();
        if (data && (data as any).status === 'cancelled') cancelRequested = true;
      } catch {}
      if (!cancelRequested) cancelTimer = setTimeout(checkCancel, 2000) as any;
    };
    cancelTimer = setTimeout(checkCancel, 2000) as any;
  }
  const throwIfCancelled = () => { if (cancelRequested) throw new Error('Cancelled by user'); };

  // Buffered DB writer — flushes events to generation_jobs.events at most every 500ms
  // to avoid hammering the DB. Stream still emits in real time over SSE.
  const eventBuffer: any[] = [];
  let pendingFlush = false;
  const flushEvents = async () => {
    if (!jobId || eventBuffer.length === 0) return;
    const toWrite = eventBuffer.splice(0, eventBuffer.length);
    try {
      // Append-only: read current then update (RLS allows; small payload)
      const { data: cur } = await supabase.from('generation_jobs').select('events').eq('id', jobId).single();
      const merged = [...((cur?.events as any[]) || []), ...toWrite];
      await supabase.from('generation_jobs').update({ events: merged }).eq('id', jobId);
    } catch (e) { console.error('flushEvents failed', e); }
  };
  const scheduleFlush = () => {
    if (pendingFlush) return;
    pendingFlush = true;
    setTimeout(async () => { pendingFlush = false; await flushEvents(); }, 500);
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        try { controller.enqueue(sseEvent(event, data)); } catch {}
        if (jobId) { eventBuffer.push({ type: event, ...data, _ts: Date.now() }); scheduleFlush(); }
      };
      const heartbeat = setInterval(() => { try { controller.enqueue(new TextEncoder().encode(`: ping\n\n`)); } catch {} }, 1500);

      // Send the jobId first so the client can persist it and resume on reload.
      if (jobId) send('job', { id: jobId });

      try {
        // ── 1. Connect ──
        send('step', { id: 'init', emoji: '🚀', label: `Connecting to ${provider}…`, status: 'active' });
        send('step', { id: 'init', emoji: '✅', label: `Connected · ${textModel}`, status: 'done' });
        send('tool', { kind: 'llm', name: provider, detail: textModel });

        // ── 2. Plan ──
        send('step', { id: 'plan', emoji: '🧠', label: 'Planning research strategy…', status: 'active' });
        const plan = await callLLMJson({
          ...llm, toolName: 'plan', schema: PLAN_SCHEMA,
          systemPrompt: planPrompt(),
          userPrompt: `User request: "${body.prompt}"\nTarget platforms: ${body.platforms.join(', ')}`,
        });
        send('step', { id: 'plan', emoji: '🧠', label: `Plan: ${plan.angle || plan.intent}`, status: 'done' });
        send('plan', { queries: plan.queries || [], imageStrategy: plan.imageStrategy, angle: plan.angle });

        // ── 3. Research loop (deep) ──
        const allSources: Source[] = [];
        const seen = new Set<string>();
        const queries: string[] = (plan.needsResearch ? (plan.queries || []) : []).slice(0, 4);

        for (let i = 0; i < queries.length; i++) {
          throwIfCancelled();
          const q = queries[i];
          const stepId = `search-${i}`;
          send('step', { id: stepId, emoji: '🔎', label: `Searching: "${q}"`, status: 'active' });
          try {
            const { sources, usedProvider } = await runSearch({ provider: researchProvider, key: researchKey, supabase, query: q, count: 5 });
            send('tool', { kind: 'research', name: usedProvider, detail: q });
            const fresh = sources.filter((src) => { if (!src.url || seen.has(src.url)) return false; seen.add(src.url); return true; });
            allSources.push(...fresh);
            send('step', { id: stepId, emoji: '🔎', label: `Found ${fresh.length} new sources via ${usedProvider}`, status: 'done' });
            // Stream sources live as cards
            for (const src of fresh) send('source', src);
          } catch (e: any) {
            send('step', { id: stepId, emoji: '⚠️', label: `Search failed: ${e.message?.slice(0, 80) || 'unknown'}`, status: 'error' });
          }
        }

        // ── 4. Scrape top 3 sources for deeper context ──
        const toScrape = allSources.slice(0, 3);
        const scraped: { source: Source; text: string }[] = [];
        for (let i = 0; i < toScrape.length; i++) {
          throwIfCancelled();
          const src = toScrape[i];
          const stepId = `scrape-${i}`;
          send('step', { id: stepId, emoji: '📖', label: `Reading ${hostnameOf(src.url)}…`, status: 'active' });
          const text = await scrapeUrl(src.url);
          if (text) {
            scraped.push({ source: src, text });
            send('tool', { kind: 'scrape', name: 'fetch', detail: hostnameOf(src.url) });
            send('step', { id: stepId, emoji: '📖', label: `Read ${hostnameOf(src.url)} (${text.length} chars)`, status: 'done' });
          } else {
            send('step', { id: stepId, emoji: '⚠️', label: `Couldn't read ${hostnameOf(src.url)}`, status: 'error' });
          }
        }

        // Merge scraped text into snippets so the LLM has more context
        const enrichedSources = allSources.map((src) => {
          const sc = scraped.find((x) => x.source.url === src.url);
          return sc ? { ...src, snippet: trimSnippet(sc.text, 600) } : src;
        });

        // ── 5. Re-plan: do we have enough? Maybe one more search ──
        let keyFacts: string[] = [];
        if (enrichedSources.length > 0) {
          send('step', { id: 'reflect', emoji: '🤔', label: 'Reviewing research, extracting key facts…', status: 'active' });
          try {
            const decision = await callLLMJson({
              ...llm, toolName: 'reflect', schema: REPLAN_SCHEMA,
              systemPrompt: 'You are a research analyst deciding whether the gathered evidence is sufficient and pulling out specific facts to use.',
              userPrompt: replanPrompt(body.prompt, enrichedSources),
            });
            keyFacts = decision.keyFacts || [];
            if (!decision.haveEnough && decision.followUpQuery) {
              send('step', { id: 'reflect', emoji: '🤔', label: `Need more on: "${decision.followUpQuery}"`, status: 'done' });
              const stepId = `search-followup`;
              send('step', { id: stepId, emoji: '🔎', label: `Follow-up search: "${decision.followUpQuery}"`, status: 'active' });
              try {
                const { sources, usedProvider } = await runSearch({ provider: researchProvider, key: researchKey, supabase, query: decision.followUpQuery, count: 4 });
                send('tool', { kind: 'research', name: usedProvider, detail: decision.followUpQuery });
                const fresh = sources.filter((src) => { if (!src.url || seen.has(src.url)) return false; seen.add(src.url); return true; });
                enrichedSources.push(...fresh);
                send('step', { id: stepId, emoji: '🔎', label: `Found ${fresh.length} more via ${usedProvider}`, status: 'done' });
                for (const src of fresh) send('source', src);
              } catch (e: any) {
                send('step', { id: stepId, emoji: '⚠️', label: `Follow-up failed: ${e.message?.slice(0, 80)}`, status: 'error' });
              }
            } else {
              send('step', { id: 'reflect', emoji: '✅', label: `Extracted ${keyFacts.length} key facts`, status: 'done' });
            }
          } catch (e: any) {
            send('step', { id: 'reflect', emoji: '⚠️', label: `Reflection skipped: ${e.message?.slice(0, 60)}`, status: 'error' });
          }
        }

        // ── 6. Image (parallel with writing) ──
        const imagePromise: Promise<{
          url: string | null;
          path: string | null;
          credit?: string;
          strategy: string;
          sourceImageUrl?: string | null;
          sourceImagePath?: string | null;
          sourceImageCredit?: string;
        }> = (async () => {
          if (!body.includeImage || plan.imageStrategy === 'none') return { url: null, path: null, strategy: 'none' };
          const strategy = plan.imageStrategy;
          const query = plan.imageQuery || body.prompt;
          // Rich AI image prompt: subject + context + style + composition. Stock photo searches use the short query.
          const richAIPrompt = [
            query,
            plan.angle ? `Editorial angle: ${plan.angle}.` : '',
            `User goal: ${body.prompt.slice(0, 200)}.`,
            'Photographic, vibrant, modern, eye-catching social media visual. Square 1:1 framing. Strong subject in focus. Cinematic lighting. NO text, NO watermarks, NO logos, NO captions overlayed.',
          ].filter(Boolean).join(' ');
          send('step', { id: 'image-plan', emoji: '🎨', label: `Strategy: ${strategy === 'real_photo' ? 'finding real photo' : 'generating with AI'} — "${query.slice(0, 60)}"`, status: 'active' });
          let raw: string | null = null;
          let credit = '';
          let preparedImage: { url: string; path: string } | null = null;
          let sourceImageUrl: string | null = null;
          let sourceImagePath: string | null = null;
          let sourceImageCredit = '';

          if (enrichedSources.length) {
            send('step', { id: 'image-source', emoji: '🖼️', label: 'Checking researched source pages for a relevant image…', status: 'active' });
            try {
              const sourceSearch = await searchLocalImagesViaCommand(
                supabase,
                query,
                enrichedSources.slice(0, 3).map((source) => source.url),
                4,
                25000,
              );
              const firstSourceImage = sourceSearch.images[0];
              const sourceUrl = typeof firstSourceImage === 'string' ? firstSourceImage : (firstSourceImage?.url || null);
              if (sourceUrl) {
                const storedSource = await uploadImageToBucket(supabase, sourceUrl);
                if (storedSource) {
                  sourceImageUrl = storedSource.url;
                  sourceImagePath = storedSource.path;
                  sourceImageCredit = `Source image from ${hostnameOf((firstSourceImage as LocalImageCandidate)?.pageUrl || enrichedSources[0]?.url || sourceUrl)}`;
                  if (strategy === 'real_photo') {
                    raw = storedSource.url;
                    preparedImage = storedSource;
                    credit = sourceImageCredit;
                  }
                  send('step', { id: 'image-source', emoji: '🖼️', label: `Found source image via ${sourceSearch.provider}`, status: 'done' });
                } else {
                  send('step', { id: 'image-source', emoji: '⚠️', label: 'Found a source image but could not store it', status: 'error' });
                }
              } else {
                send('step', { id: 'image-source', emoji: '⚠️', label: 'No usable image found on researched source pages', status: 'error' });
              }
            } catch (e: any) {
              send('step', { id: 'image-source', emoji: '⚠️', label: `Source-image search failed: ${e?.message?.slice(0, 80) || 'unknown'}`, status: 'error' });
            }
          }

          // Build the AI fallback chain. The user-saved `image_keys` array (up to 10) wins;
          // we append the legacy primary entry, then `lovable` as the always-on safety net.
          const aiChain: { provider: string; apiKey: string; model: string; label?: string }[] = [];
          for (const k of imageKeysChain) {
            if (k.enabled === false) continue;
            // Only AI-generation providers belong in the chain.
            if (!['openai', 'google', 'nvidia', 'xai', 'lovable'].includes(k.provider)) continue;
            aiChain.push({ provider: k.provider, apiKey: k.apiKey || '', model: k.model || '', label: k.label });
          }
          // Legacy single-provider primary (only if it's an AI generator and not already chained)
          const legacyAiProvider = imageProvider === 'openai' ? 'openai'
            : imageProvider === 'google' ? 'google'
            : imageProvider === 'nvidia' ? 'nvidia'
            : imageProvider === 'xai' ? 'xai'
            : (imageProvider === 'lovable' || imageProvider === 'auto') ? 'lovable'
            : null;
          if (legacyAiProvider && !aiChain.some((c) => c.provider === legacyAiProvider && c.apiKey === imageKey)) {
            aiChain.push({ provider: legacyAiProvider, apiKey: imageKey, model: imageModel, label: 'primary' });
          }
          // Always end with Lovable AI (no key needed) as the ultimate fallback.
          if (!aiChain.some((c) => c.provider === 'lovable')) {
            aiChain.push({ provider: 'lovable', apiKey: '', model: 'google/gemini-2.5-flash-image', label: 'lovable-ai (always on)' });
          }

          if (strategy === 'real_photo') {
            const tryUnsplash = imageProvider === 'unsplash' || (imageProvider === 'auto' && imageKey);
            const tryPexels = imageProvider === 'pexels';
            if (tryUnsplash && imageKey) { const r = await findUnsplashImage(imageKey, query); if (r) { raw = r.url; credit = r.credit; send('tool', { kind: 'image', name: 'unsplash', detail: query }); } }
            if (!raw && tryPexels && imageKey) { const r = await findPexelsImage(imageKey, query); if (r) { raw = r.url; credit = r.credit; send('tool', { kind: 'image', name: 'pexels', detail: query }); } }
          }

          // AI generation with multi-key fallback chain (also used as fallback when stock search fails).
          if (!raw && aiChain.length) {
            const result = await generateWithFallbackChain(
              aiChain,
              richAIPrompt,
              (e, i) => {
                const keyHint = e.apiKey ? `${e.apiKey.slice(0, 6)}…${e.apiKey.slice(-4)}` : 'no-key';
                const label = e.label ? `${e.label} · ` : '';
                send('tool', { kind: 'image', name: `${e.provider}${e.model ? ' · ' + e.model.split('/').pop() : ''}`, detail: `${label}key ${keyHint} · attempt #${i + 1}` });
              },
              (e, i, reason) => {
                const keyHint = e.apiKey ? `${e.apiKey.slice(0, 6)}…${e.apiKey.slice(-4)}` : 'no-key';
                send('step', { id: `image-try-${i}`, emoji: '↪️', label: `${e.provider}/${e.model?.split('/').pop() || '?'} (${keyHint}) failed — ${reason.slice(0, 70)}. Trying next…`, status: 'error' });
              },
            );
            if (result.dataUrl) {
              raw = result.dataUrl;
              if (result.usedEntry) credit = `Generated by ${result.usedEntry.provider}${result.usedEntry.model ? ' · ' + result.usedEntry.model.split('/').pop() : ''}`;
            }
          }

          // Final fallback: ask the local browser worker to scrape an image from the web
          // (DuckDuckGo Images → Bing Images). The worker polls pending_commands every 5s.
          if (!raw) {
            send('step', { id: 'image-local', emoji: '🌐', label: `All AI providers failed — asking local browser to find a "${query.slice(0, 40)}" image…`, status: 'active' });
            try {
              const localSearch = await searchLocalImagesViaCommand(supabase, query, [], 5, 25000);
              const first = localSearch.images[0];
              const imgUrl = typeof first === 'string' ? first : (first?.url || null);
              if (imgUrl) {
                raw = imgUrl;
                credit = localSearch.provider === 'source-pages'
                  ? `Source image from ${hostnameOf((first as LocalImageCandidate)?.pageUrl || imgUrl)}`
                  : 'Local browser scrape';
                send('step', { id: 'image-local', emoji: '🌐', label: `Local browser found an image via ${localSearch.provider} ✓`, status: 'done' });
              } else {
                send('step', { id: 'image-local', emoji: '⚠️', label: 'Local browser did not return any usable image', status: 'error' });
              }
            } catch (e: any) {
              send('step', { id: 'image-local', emoji: '⚠️', label: `Local browser fallback failed: ${e?.message?.slice(0, 80) || 'unknown'}`, status: 'error' });
            }
          }

          if (!raw) {
            send('step', { id: 'image-plan', emoji: '⚠️', label: 'No image found/generated (all sources exhausted)', status: 'error' });
            return { url: null, path: null, strategy, sourceImageUrl, sourceImagePath, sourceImageCredit };
          }
          send('step', { id: 'image-plan', emoji: '🎨', label: `Image acquired (${strategy === 'real_photo' ? 'real photo' : 'AI generated'})`, status: 'done' });
          const stored = preparedImage || await (async () => {
            send('step', { id: 'image-upload', emoji: '⬆️', label: 'Uploading to media library…', status: 'active' });
            return uploadImageToBucket(supabase, raw as string);
          })();
          if (!stored) { send('step', { id: 'image-upload', emoji: '⚠️', label: 'Upload failed', status: 'error' }); return { url: null, path: null, strategy }; }
          send('step', { id: 'image-upload', emoji: '🖼️', label: 'Image ready', status: 'done' });
          send('image', { imageUrl: stored.url, imagePath: stored.path, credit });
          return { url: stored.url, path: stored.path, credit, strategy, sourceImageUrl, sourceImagePath, sourceImageCredit };
        })();

        // ── 7. Write platform-tailored variants (with real facts) ──
        send('step', { id: 'write', emoji: '✍️', label: `Writing ${body.platforms.length} tailored variant${body.platforms.length === 1 ? '' : 's'}…`, status: 'active' });
        const writeResult = await callLLMJson({
          ...llm, toolName: 'compose_post', schema: writeSchema(body.platforms),
          systemPrompt: writePromptSystem(body.platforms),
          userPrompt: writePromptUser(body.prompt, plan.angle || plan.intent, keyFacts, enrichedSources.slice(0, 8), body.platforms),
        });
        const variants: Variants = writeResult.variants || {};
        send('step', { id: 'write', emoji: '✨', label: `Wrote ${Object.keys(variants).length} platform variant${Object.keys(variants).length === 1 ? '' : 's'}`, status: 'done' });

        for (const p of body.platforms) {
          const v = variants[p];
          if (v) send('variant', { platform: p, description: v.description, hashtags: v.hashtags });
        }

        // Final sources event with snippets+favicons
        const finalSources: Source[] = enrichedSources.slice(0, 8).map((src) => ({
          title: src.title || hostnameOf(src.url),
          url: src.url,
          note: src.snippet ? trimSnippet(src.snippet, 200) : undefined,
          snippet: src.snippet,
          favicon: src.favicon || faviconFor(src.url),
          publishedAt: src.publishedAt,
        }));
        send('sources', { sources: finalSources });

        // ── 8. Wait for image and finish ──
        const imgResult = await imagePromise;

        // ── 8b. Auto-save as draft so the post appears on /social even if the user navigates away.
        // The Compose tab can re-load and edit it; on Post Now/Schedule it gets re-created or its
        // status flipped to pending. This is the "every successful generation lands on Social Posts" UX.
        let savedPostId: string | null = null;
        try {
          const primary = variants[body.platforms[0]] || Object.values(variants)[0];
          if (primary) {
            const platformResults = body.platforms.map((name) => ({ name, status: 'pending' as const }));
            const { data: savedRow } = await supabase.from('social_posts').insert({
              description: primary.description,
              image_path: imgResult.path,
              hashtags: primary.hashtags || [],
              target_platforms: body.platforms,
              account_selections: {},
              scheduled_at: null,
              ai_prompt: body.prompt,
              ai_sources: finalSources,
              status: 'draft',
              platform_results: platformResults,
              platform_variants: variants,
            } as any).select('id').single();
            if (savedRow?.id) { savedPostId = savedRow.id; send('saved', { id: savedRow.id, status: 'draft' }); }
          }
        } catch (e) {
          console.error('auto-save draft failed', e);
        }

        send('step', { id: 'done', emoji: '🎉', label: 'All done — saved as draft on Social Posts!', status: 'done' });
        const finalResult = {
          variants, sources: finalSources,
          imageUrl: imgResult.url, imagePath: imgResult.path,
          sourceImageUrl: imgResult.sourceImageUrl,
          sourceImagePath: imgResult.sourceImagePath,
          provider, model: textModel,
        };
        send('done', finalResult);

        // ── 8c. Telegram preview — mirrors the video-upload notification flow.
        // Sends the rendered image + every per-platform variant + key sources so
        // the user can review, give feedback, or skip without opening the app.
        try {
          const tgEnabled = !!s.telegram_enabled;
          const tgChatRaw = String(s.telegram_chat_id || '').trim();
          const tgChatId = tgChatRaw && Number.isFinite(Number(tgChatRaw)) ? Number(tgChatRaw) : null;
          const tgKey = Deno.env.get('TELEGRAM_API_KEY');
          const lvKey = Deno.env.get('LOVABLE_API_KEY');
          if (tgEnabled && tgChatId && tgKey && lvKey) {
            send('step', { id: 'telegram', emoji: '✈️', label: 'Sending preview to Telegram…', status: 'active' });
            const primary = variants[body.platforms[0]] || Object.values(variants)[0] || { description: '', hashtags: [] };
            const caption = buildGenerationCaption({
              prompt: body.prompt,
              primaryDescription: primary.description,
              primaryHashtags: primary.hashtags || [],
              variants,
              platforms: body.platforms,
              sources: finalSources,
              postId: savedPostId,
              imageCredit: imgResult.credit,
              sourceImageCredit: imgResult.sourceImageCredit,
            });
            const detailMessages = buildGenerationDetailMessages({
              variants,
              platforms: body.platforms,
              sources: finalSources,
              postId: savedPostId,
            });
            const tg = await sendTelegramGenerationPreview({
              supabase,
              lovableApiKey: lvKey,
              telegramApiKey: tgKey,
              chatId: tgChatId,
              imagePaths: [imgResult.sourceImagePath, imgResult.path].filter(Boolean) as string[],
              caption,
              detailMessages,
            });
            send('step', {
              id: 'telegram',
              emoji: tg.ok ? '✈️' : '⚠️',
              label: tg.ok ? 'Preview sent to Telegram' : `Telegram failed: ${(tg.error || '').slice(0, 80)}`,
              status: tg.ok ? 'done' : 'error',
            });
          }
        } catch (e) {
          console.error('telegram preview failed', e);
        }

        if (jobId) {
          await flushEvents();
          await supabase.from('generation_jobs').update({
            status: 'completed', result: finalResult, saved_post_id: savedPostId,
            completed_at: new Date().toISOString(),
          }).eq('id', jobId);
        }
      } catch (e: any) {
        const isCancel = cancelRequested || /cancelled by user/i.test(e?.message || '');
        if (isCancel) {
          console.log('agent cancelled by user');
          send('error', { error: 'Cancelled by user' });
        } else {
          console.error('agent error', e);
          send('error', { error: e?.message || 'Unknown error', status: e?.status || 500 });
        }
        if (jobId) {
          await flushEvents();
          await supabase.from('generation_jobs').update({
            status: isCancel ? 'cancelled' : 'failed',
            error: isCancel ? 'Cancelled by user' : (e?.message || 'Unknown error'),
            completed_at: new Date().toISOString(),
          }).eq('id', jobId);
        }
      } finally {
        if (cancelTimer) { try { clearTimeout(cancelTimer); } catch {} }
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
  });

  if (!wantsStream) {
    // Non-streaming clients still get a JSON shape — we collect events into a single response.
    // Simpler: tell them streaming is required.
    return new Response(JSON.stringify({ error: 'Set stream:true; agent emits SSE events.' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
