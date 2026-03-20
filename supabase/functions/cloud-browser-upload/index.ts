import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const BB_API = 'https://api.browserbase.com/v1';
const AI_GATEWAY = 'https://ai.gateway.lovable.dev/v1/chat/completions';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const BROWSERBASE_API_KEY = Deno.env.get('BROWSERBASE_API_KEY');
  const BROWSERBASE_PROJECT_ID = Deno.env.get('BROWSERBASE_PROJECT_ID');
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');

  if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID || !LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ success: false, error: 'Missing required secrets (BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, LOVABLE_API_KEY)' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const { job_id, platform, credentials } = body;

    if (!job_id || !platform) {
      return new Response(JSON.stringify({ success: false, error: 'job_id and platform required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: job, error: jobErr } = await supabase
      .from('upload_jobs').select('*').eq('id', job_id).single();

    const { data: appSettings } = await supabase
      .from('app_settings')
      .select('telegram_enabled, telegram_chat_id')
      .eq('id', 1)
      .single();

    async function resolveTelegramChatId(): Promise<number | null> {
      const configured = String(appSettings?.telegram_chat_id || '').trim();
      if (configured && Number.isFinite(Number(configured))) {
        return Number(configured);
      }

      const { data: latestMessage } = await supabase
        .from('telegram_messages')
        .select('chat_id')
        .eq('is_bot', false)
        .order('created_at', { ascending: false })
        .limit(1);

      const fallbackId = latestMessage?.[0]?.chat_id;
      if (!fallbackId || !Number.isFinite(Number(fallbackId))) {
        return null;
      }

      const numericFallbackId = Number(fallbackId);
      await supabase
        .from('app_settings')
        .update({ telegram_chat_id: String(numericFallbackId) })
        .eq('id', 1);

      return numericFallbackId;
    }

    const resolvedTelegramChatId = await resolveTelegramChatId();

    if (jobErr || !job) {
      return new Response(JSON.stringify({ success: false, error: 'Job not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const videoUrl = job.video_storage_path
      ? supabase.storage.from('videos').getPublicUrl(job.video_storage_path).data.publicUrl
      : null;

    if (!videoUrl) {
      return new Response(JSON.stringify({ success: false, error: 'No video file attached to job' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`Creating Browserbase session for ${platform}...`);
    const sessionResp = await fetch(`${BB_API}/sessions`, {
      method: 'POST',
      headers: { 'x-bb-api-key': BROWSERBASE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: BROWSERBASE_PROJECT_ID,
        browserSettings: { blockAds: true },
        keepAlive: true,
      }),
    });

    if (!sessionResp.ok) {
      const err = await sessionResp.text();
      throw new Error(`Browserbase session creation failed [${sessionResp.status}]: ${err}`);
    }

    const session = await sessionResp.json();
    const sessionId = session.id;
    console.log(`Session created: ${sessionId}`);

    await supabase.from('upload_jobs').update({ browserbase_session_id: sessionId }).eq('id', job_id);

    const connectWsUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;

    const result = await runBrowserAutomation(connectWsUrl, platform, {
      videoUrl,
      title: job.title || 'Untitled Video',
      description: job.description || '',
      tags: job.tags || [],
      email: credentials?.email || '',
      password: credentials?.password || '',
      jobId: job_id,
      supabase,
      lovableApiKey: LOVABLE_API_KEY,
      telegram: {
        enabled: Boolean(appSettings?.telegram_enabled && resolvedTelegramChatId && TELEGRAM_API_KEY),
        chatId: resolvedTelegramChatId,
        lovableApiKey: LOVABLE_API_KEY,
        telegramApiKey: TELEGRAM_API_KEY || undefined,
      },
    });

    // Release session
    try {
      await fetch(`${BB_API}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'x-bb-api-key': BROWSERBASE_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
      });
    } catch (e) { console.error('Failed to release session:', e); }

    return new Response(JSON.stringify({ success: true, sessionId, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Cloud browser upload error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message || 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ========== Types ==========

type SendCmd = (method: string, params?: any) => Promise<any>;
type Wait = (ms: number) => Promise<void>;

type AutomationParams = {
  videoUrl: string;
  title: string;
  description: string;
  tags: string[];
  email: string;
  password: string;
  jobId: string;
  supabase: any;
  lovableApiKey: string;
  telegram: {
    enabled: boolean;
    chatId: string | number | null;
    lovableApiKey?: string;
    telegramApiKey?: string;
  };
};

type AgentAction = {
  action: 'click_xy' | 'click_element' | 'focus_and_type' | 'press_key' | 'navigate' | 'wait' | 'scroll' | 'run_js' | 'upload_file' | 'need_verification' | 'done';
  x?: number;
  y?: number;
  selector?: string;
  text?: string;
  key?: string;
  url?: string;
  ms?: number;
  scrollY?: number;
  js?: string;
  reasoning: string;
  result?: string;
};

// ========== CDP Helpers ==========

async function captureScreenshot(sendCmd: SendCmd): Promise<string> {
  const result = await sendCmd('Page.captureScreenshot', {
    format: 'png', quality: 80,
    clip: { x: 0, y: 0, width: 1280, height: 900, scale: 1 },
  });
  return result?.data || '';
}

async function cdpClick(sendCmd: SendCmd, x: number, y: number): Promise<void> {
  // Move mouse first for realistic interaction
  await sendCmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await new Promise(r => setTimeout(r, 100));
  await sendCmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await sendCmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function cdpNavigate(sendCmd: SendCmd, url: string): Promise<void> {
  await sendCmd('Page.navigate', { url });
}

async function cdpScroll(sendCmd: SendCmd, deltaY: number): Promise<void> {
  await sendCmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 450, deltaX: 0, deltaY });
}

function escJS(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

async function evalJS(sendCmd: SendCmd, expression: string): Promise<any> {
  const result = await sendCmd('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value;
}

// Click an element by CSS selector using JS (much more reliable than coordinates)
async function clickElement(sendCmd: SendCmd, selector: string): Promise<boolean> {
  const result = await evalJS(sendCmd, `
    const el = document.querySelector('${escJS(selector)}');
    if (!el) return 'not-found';
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'clicked';
  `);
  return result === 'clicked';
}

// Focus an element and type text using JS (instant, reliable)
async function focusAndType(sendCmd: SendCmd, selector: string, text: string): Promise<boolean> {
  const result = await evalJS(sendCmd, `
    const el = document.querySelector('${escJS(selector)}');
    if (!el) return 'not-found';
    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.click();
    
    // For contenteditable elements
    if (el.contentEditable === 'true' || el.isContentEditable) {
      el.textContent = '';
      document.execCommand('insertText', false, '${escJS(text)}');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    }
    
    // For regular inputs
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, '${escJS(text)}');
    } else {
      el.value = '${escJS(text)}';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'typed';
  `);
  return result === 'typed';
}

// Press a special key (Enter, Tab, Escape, etc.)
async function pressKey(sendCmd: SendCmd, key: string): Promise<void> {
  const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  };
  const mapped = keyMap[key] || { key, code: key, keyCode: 0 };
  await sendCmd('Input.dispatchKeyEvent', { type: 'keyDown', ...mapped, text: key === 'Enter' ? '\r' : '' });
  await sendCmd('Input.dispatchKeyEvent', { type: 'keyUp', ...mapped });
}

// Get current page info for smarter decisions
async function getPageInfo(sendCmd: SendCmd): Promise<string> {
  const info = await evalJS(sendCmd, `
    const url = window.location.href;
    const title = document.title;
    const inputs = [...document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]')]
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        type: el.type || el.getAttribute('type') || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || el.getAttribute('aria-label') || '',
        visible: el.offsetParent !== null,
      }));
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .slice(0, 15)
      .map(el => ({
        text: (el.textContent || '').trim().substring(0, 50),
        id: el.id || '',
        visible: el.offsetParent !== null,
        ariaLabel: el.getAttribute('aria-label') || '',
      }))
      .filter(b => b.visible && b.text);
    return JSON.stringify({ url, title, inputs, buttons });
  `);
  try {
    return typeof info === 'string' ? info : JSON.stringify(info);
  } catch {
    return '{}';
  }
}

// Upload video file via JS fetch + DataTransfer
async function uploadVideoFile(sendCmd: SendCmd, wait: Wait, videoUrl: string): Promise<boolean> {
  const result = await evalJS(sendCmd, `
    try {
      var resp = await fetch('${escJS(videoUrl)}');
      if (!resp.ok) return 'download-failed-' + resp.status;
      var blob = await resp.blob();
      var file = new File([blob], 'video.mp4', { type: 'video/mp4' });
      var dt = new DataTransfer();
      dt.items.add(file);
      var input = document.querySelector('input[type="file"][accept*="video"]') ||
                  document.querySelector('input[type="file"]');
      if (!input) return 'no-input-found';
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'file-set';
    } catch (e) {
      return 'error:' + (e?.message || e);
    }
  `);
  console.log('[Upload] File upload result:', result);
  return result === 'file-set';
}

// ========== AI Agent Core ==========

const SYSTEM_PROMPT = `You are an expert browser automation agent that uploads videos to social media platforms. You are fast, decisive, and precise. You analyze screenshots AND DOM info to decide the single best next action.

RESPOND ONLY with a JSON object via the browser_action tool call. No markdown, no extra text.

## Available actions:
- **click_xy**: Click at pixel coordinates (x, y) on the 1280x900 viewport. Use when you can see the element but don't have a CSS selector.
- **click_element**: Click element by CSS selector. PREFERRED over click_xy. Use the DOM info provided.
- **focus_and_type**: Focus an input by CSS selector AND type text into it. This CLEARS the field first then types. Use for filling forms.
- **press_key**: Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp).
- **navigate**: Go to a URL.
- **wait**: Wait N milliseconds (max 10000).
- **scroll**: Scroll by pixels (positive=down, negative=up).
- **run_js**: Execute JavaScript in the page. Use for complex DOM manipulations or to find/click elements that are hard to target with CSS selectors.
- **upload_file**: Signal that a file input is ready for video upload (we handle it programmatically).
- **need_verification**: Platform is asking for 2FA/security verification — triggers Telegram notification to user.
- **done**: Task is complete. Include result with any URLs.

## CRITICAL RULES:
1. USE CSS SELECTORS (click_element, focus_and_type) whenever possible — 10x more reliable than click_xy coordinates.
2. If a CSS selector fails, use run_js to find and click elements by text content or aria-label.
3. NEVER hesitate. If you see the page loaded, ACT IMMEDIATELY. Don't wait unnecessarily.
4. After typing in a form field, you usually need to press Enter or click a Next/Submit button.
5. If a page hasn't fully loaded (blank/white), use "wait" with 2000-3000ms.
6. If stuck (same screenshot 3+ times), try run_js to inspect the DOM and find clickable elements.
7. Maximum 50 actions before you MUST return "done".
8. ALWAYS prefer run_js to find and click elements when click_element fails. Example: run_js with document.querySelector('[aria-label="Upload"]')?.click()

## GOOGLE LOGIN (CRITICAL — follow exactly):
1. Email page: focus_and_type selector='input[type="email"]' → then click_element '#identifierNext' or press_key 'Enter'
2. Wait 3 seconds for password page to load
3. Password page: focus_and_type selector='input[type="password"]' → then click_element '#passwordNext' or press_key 'Enter'
4. If you see a number to tap on phone, "Try another way", captcha, or any verification challenge → return need_verification
5. NEVER use click_xy for credential entry.

## YOUTUBE STUDIO (CRITICAL — follow exactly):
- The Create/Upload button: use run_js: document.querySelector('#create-icon')?.click() — if that fails: [...document.querySelectorAll('button, ytcp-button')].find(b => b.textContent?.includes('Create'))?.click()
- "Upload videos" menu: run_js: document.querySelector('#text-item-0')?.click() — if that fails: [...document.querySelectorAll('tp-yt-paper-item')].find(i => i.textContent?.includes('Upload'))?.click()
- File input: return upload_file
- Title: run_js targeting #textbox in #title-textarea
- Description: second #textbox element
- Next button: '#next-button'
- Public radio: tp-yt-paper-radio-button[name="PUBLIC"]
- Done button: '#done-button'

## TIKTOK: Navigate to tiktok.com/creator#/upload, login if needed, upload file, fill caption, click Post.
## INSTAGRAM: Login via input[name="username"]/input[name="password"], dismiss popups, click New post icon, upload, caption, Share.`;

async function askAI(
  lovableApiKey: string,
  screenshot: string,
  pageInfo: string,
  taskPrompt: string,
  history: { action: string; reasoning: string }[],
): Promise<AgentAction> {
  const recentHistory = history.slice(-15); // Keep last 15 for context window
  const historyText = recentHistory.length > 0
    ? `\n\nLast ${recentHistory.length} actions:\n${recentHistory.map((h, i) => `${i + 1}. [${h.action}] ${h.reasoning}`).join('\n')}`
    : '';

  const response = await fetch(AI_GATEWAY, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${lovableApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-3-flash-preview',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `TASK: ${taskPrompt}${historyText}\n\nCurrent page DOM info:\n${pageInfo}\n\nWhat is the single best next action?`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${screenshot}` },
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'browser_action',
            description: 'Execute a browser action',
            parameters: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['click_xy', 'click_element', 'focus_and_type', 'press_key', 'navigate', 'wait', 'scroll', 'run_js', 'upload_file', 'need_verification', 'done'],
                },
                x: { type: 'number', description: 'X coordinate for click_xy' },
                y: { type: 'number', description: 'Y coordinate for click_xy' },
                selector: { type: 'string', description: 'CSS selector for click_element or focus_and_type' },
                text: { type: 'string', description: 'Text to type for focus_and_type' },
                key: { type: 'string', description: 'Key name for press_key (Enter, Tab, Escape, etc.)' },
                url: { type: 'string', description: 'URL for navigate' },
                ms: { type: 'number', description: 'Milliseconds for wait' },
                scrollY: { type: 'number', description: 'Scroll pixels (positive=down)' },
                js: { type: 'string', description: 'JavaScript code for run_js' },
                reasoning: { type: 'string', description: 'Brief explanation' },
                result: { type: 'string', description: 'Result summary for done' },
              },
              required: ['action', 'reasoning'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'browser_action' } },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('AI Gateway error:', response.status, errText);
    throw new Error(`AI Gateway error [${response.status}]: ${errText}`);
  }

  const data = await response.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      return JSON.parse(toolCall.function.arguments) as AgentAction;
    } catch {
      console.error('Failed to parse tool call:', toolCall.function.arguments);
    }
  }

  // Fallback
  const content = data.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(content.replace(/```json?\s*/g, '').replace(/```/g, '').trim()) as AgentAction;
  } catch {
    return { action: 'wait', ms: 2000, reasoning: 'Could not parse AI response' };
  }
}

// ========== Telegram Helpers ==========

async function sendTelegramMessage(
  telegram: AutomationParams['telegram'], text: string,
): Promise<boolean> {
  if (!telegram.enabled || !telegram.chatId || !telegram.lovableApiKey || !telegram.telegramApiKey) {
    console.log('[Telegram] Message skipped — not configured. enabled:', telegram.enabled, 'chatId:', telegram.chatId);
    return false;
  }

  const numericChatId = Number(telegram.chatId);
  if (!Number.isFinite(numericChatId)) {
    console.log('[Telegram] Message skipped — invalid numeric chat ID:', telegram.chatId);
    return false;
  }

  try {
    console.log('[Telegram] Sending message to chat:', numericChatId, 'text:', text.substring(0, 80));
    const response = await fetch('https://connector-gateway.lovable.dev/telegram/sendMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${telegram.lovableApiKey}`,
        'X-Connection-Api-Key': telegram.telegramApiKey!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: numericChatId,
        text,
        parse_mode: 'HTML',
      }),
    });
    const data = await response.json();
    console.log('[Telegram] Response:', response.status, JSON.stringify(data).substring(0, 200));
    return response.ok;
  } catch (e) {
    console.error('[Telegram] Failed to send message:', e);
    return false;
  }
}

async function sendTelegramPhoto(
  telegram: AutomationParams['telegram'], photoBase64: string, caption: string,
): Promise<boolean> {
  if (!telegram.enabled || !telegram.chatId || !telegram.lovableApiKey || !telegram.telegramApiKey) return false;
  try {
    // Convert base64 to binary
    const binaryStr = atob(photoBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    // Build multipart form data
    const boundary = '----TelegramBoundary' + Date.now();
    const parts: Uint8Array[] = [];
    const enc = new TextEncoder();

    // chat_id field
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${telegram.chatId}\r\n`));
    // caption field
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    // parse_mode field
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`));
    // photo file
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`));
    parts.push(bytes);
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    // Combine all parts
    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const body = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) { body.set(p, offset); offset += p.length; }

    const response = await fetch('https://connector-gateway.lovable.dev/telegram/sendPhoto', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${telegram.lovableApiKey}`,
        'X-Connection-Api-Key': telegram.telegramApiKey!,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    return response.ok;
  } catch (e) {
    console.error('[Telegram] Failed to send photo:', e);
    return false;
  }
}

async function sendTelegramPrompt(
  telegram: AutomationParams['telegram'], platform: string, jobId: string, reason?: string,
): Promise<boolean> {
  const text = reason
    ? `🔐 <b>${platform}</b> needs your attention!\n\n${reason}\n\nPlease reply:\n• <b>APPROVED</b> — if you approved on your phone\n• <b>CODE 123456</b> — with the verification code\n• Any text the agent needs`
    : `🔐 ${platform} login needs verification for job ${jobId}.\nPlease approve on your phone, then reply:\n• APPROVED\n• CODE 123456`;
  return sendTelegramMessage(telegram, text);
}

function parseApprovalText(text: string): { approved: boolean; code?: string } | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const n = raw.toLowerCase();
  if (['approve', 'approved', 'ok', 'done', 'yes', 'continue'].some(w => n === w || n.startsWith(`${w} `))) {
    return { approved: true };
  }
  for (const p of [/\bcode\s*[:=\-]?\s*([a-zA-Z0-9\-]{4,12})\b/i, /\botp\s*[:=\-]?\s*([0-9]{4,8})\b/i, /\b([0-9]{4,8})\b/]) {
    const m = raw.match(p);
    if (m?.[1]) return { approved: true, code: m[1] };
  }
  return null;
}

async function waitForTelegramApproval(
  supabase: any, chatId: string | number, sinceIso: string, timeoutMs = 240000,
): Promise<{ approved: boolean; code?: string } | null> {
  const start = Date.now();
  const cid = Number.isFinite(Number(chatId)) ? Number(chatId) : String(chatId);
  while (Date.now() - start < timeoutMs) {
    const { data } = await supabase
      .from('telegram_messages').select('text, created_at')
      .eq('is_bot', false).eq('chat_id', cid as any)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false }).limit(30);
    for (const row of (data || [])) {
      const parsed = parseApprovalText(row.text || '');
      if (parsed) return parsed;
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  return null;
}

// ========== Log AI Steps ==========

async function logStep(supabase: any, jobId: string, step: number, action: AgentAction) {
  try {
    const { data: job } = await supabase.from('upload_jobs').select('platform_results').eq('id', jobId).single();
    const results = (job?.platform_results as any[]) || [];
    let aiLog = results.find((r: any) => r.name === '_ai_log');
    if (!aiLog) { aiLog = { name: '_ai_log', steps: [] }; results.push(aiLog); }
    aiLog.steps = aiLog.steps || [];
    aiLog.steps.push({
      step, action: action.action, reasoning: action.reasoning,
      timestamp: new Date().toISOString(),
    });
    await supabase.from('upload_jobs').update({ platform_results: results }).eq('id', jobId);
  } catch (e) { console.error('Log step failed:', e); }
}

// ========== Task Prompts ==========

function buildTaskPrompt(platform: string, params: AutomationParams): string {
  const cred = params.email && params.password
    ? `\n\nCredentials:\n- Email: ${params.email}\n- Password: ${params.password}\n\nFor Google login: focus_and_type on input[type="email"], then click #identifierNext. Wait for password page. focus_and_type on input[type="password"], then click #passwordNext. If any verification challenge appears, return need_verification immediately.`
    : '\n\nNo credentials provided. If login required, return need_verification.';

  const meta = `\n\nVideo metadata:\n- Title: ${params.title}\n- Description: ${params.description}\n- Tags: ${params.tags.join(', ')}`;

  switch (platform) {
    case 'youtube':
      return `Upload a video to YouTube Studio. You MUST complete ALL steps — do NOT stop or wait after reaching the dashboard.

STEP-BY-STEP PLAN (follow precisely, DO NOT SKIP ANY STEP):
1. If on Google login → enter email, click Next, wait 3s, enter password, click Next
2. If any verification/2FA → return need_verification
3. Once on YouTube Studio dashboard → IMMEDIATELY click Create button. Use run_js: document.querySelector('#create-icon')?.click() — if that returns null try: var btns = [...document.querySelectorAll('button, ytcp-button, [role="button"]')]; var cb = btns.find(b => (b.textContent||'').includes('Create') || (b.getAttribute('aria-label')||'').includes('Create') || (b.id||'').includes('create')); if(cb) cb.click();
4. From dropdown → click "Upload videos". Use run_js: setTimeout(()=>{ var items = [...document.querySelectorAll('tp-yt-paper-item, [role="menuitem"], #text-item-0')]; var ui = items.find(i => (i.textContent||'').includes('Upload')); if(ui) ui.click(); }, 500);
5. When upload dialog appears with file input → return upload_file
6. Wait 8s for file processing, then fill title using run_js: var tb = document.querySelector('#title-textarea #textbox') || document.querySelectorAll('#textbox')[0]; if(tb){tb.focus();tb.click();document.execCommand('selectAll');document.execCommand('insertText',false,'${params.title}');}
7. Fill description similarly using the second #textbox
8. Click Next button 3 times: run_js: document.querySelector('#next-button')?.click() — with 2s waits between
9. Select Public visibility: run_js: document.querySelector('tp-yt-paper-radio-button[name="PUBLIC"]')?.click()
10. Click Done/Publish: run_js: document.querySelector('#done-button')?.click()
11. Wait 5s, extract video URL, return done

CRITICAL: When you see YouTube Studio dashboard with the channel info, the VERY NEXT action must be clicking the Create button. Do NOT return wait or observe — ACT.${cred}${meta}`;

    case 'tiktok':
      return `Upload a video to TikTok. Complete ALL steps without stopping.

STEPS:
1. If login needed → enter credentials
2. If verification → return need_verification
3. When upload area visible → return upload_file
4. Fill caption with title + hashtags
5. Click Post
6. Return done with URL${cred}${meta}`;

    case 'instagram':
      return `Upload a Reel on Instagram. Complete ALL steps without stopping.

STEPS:
1. If login needed → fill username/password, click Log In
2. If verification → return need_verification
3. Dismiss popups ("Not Now")
4. Click New post (+) icon
5. When file input visible → return upload_file
6. Navigate through crop/filter → Next
7. Fill caption
8. Click Share → return done${cred}${meta}`;

    default:
      return `Upload a video to ${platform}.${cred}${meta}`;
  }
}

// ========== Main Agentic Loop ==========

async function agenticUpload(
  sendCmd: SendCmd, wait: Wait, platform: string, params: AutomationParams,
): Promise<{ url?: string; message: string }> {
  const taskPrompt = buildTaskPrompt(platform, params);
  const history: { action: string; reasoning: string }[] = [];
  const MAX_STEPS = 50;
  let fileUploaded = false;
  let consecutiveSameAction = 0;
  let lastActionKey = '';

  const startUrls: Record<string, string> = {
    youtube: 'https://studio.youtube.com',
    tiktok: 'https://www.tiktok.com/creator#/upload?scene=creator_center',
    instagram: 'https://www.instagram.com/',
  };

  console.log(`[Agent] Starting ${platform} upload...`);
  await cdpNavigate(sendCmd, startUrls[platform] || `https://www.${platform}.com`);
  await wait(4000);

  for (let step = 0; step < MAX_STEPS; step++) {
    // Capture screenshot AND page info in parallel for speed
    let screenshot: string;
    let pageInfo: string;
    try {
      const [ss, pi] = await Promise.all([
        captureScreenshot(sendCmd),
        getPageInfo(sendCmd),
      ]);
      screenshot = ss;
      pageInfo = pi;
    } catch (e) {
      console.error('[Agent] Screenshot/info failed:', e);
      await wait(2000);
      continue;
    }

    if (!screenshot) { await wait(2000); continue; }

    // Detect stuck loops
    const actionKey = `${step > 0 ? history[history.length - 1]?.action : ''}`;
    if (actionKey === lastActionKey && actionKey !== 'wait') {
      consecutiveSameAction++;
    } else {
      consecutiveSameAction = 0;
    }
    lastActionKey = actionKey;

    if (consecutiveSameAction >= 3) {
      history.push({ action: 'system', reasoning: 'STUCK DETECTED: Same action repeated 3 times. Try a completely different approach.' });
      consecutiveSameAction = 0;
    }

    console.log(`[Agent] Step ${step + 1}/${MAX_STEPS} — asking AI...`);
    let action: AgentAction;
    try {
      action = await askAI(params.lovableApiKey, screenshot, pageInfo, taskPrompt, history);
    } catch (e) {
      console.error('[Agent] AI call failed:', e);
      await wait(3000);
      continue;
    }

    console.log(`[Agent] → ${action.action}: ${action.reasoning}`);
    await logStep(params.supabase, params.jobId, step + 1, action);
    history.push({ action: action.action, reasoning: action.reasoning });

    try {
      switch (action.action) {
        case 'click_xy':
          if (action.x != null && action.y != null) {
            await cdpClick(sendCmd, action.x, action.y);
            await wait(1500);
          }
          break;

        case 'click_element':
          if (action.selector) {
            const clicked = await clickElement(sendCmd, action.selector);
            if (!clicked) {
              history.push({ action: 'system', reasoning: `click_element failed: selector '${action.selector}' not found. Try click_xy or a different selector.` });
            }
            await wait(1500);
          }
          break;

        case 'focus_and_type':
          if (action.selector && action.text != null) {
            const typed = await focusAndType(sendCmd, action.selector, action.text);
            if (!typed) {
              history.push({ action: 'system', reasoning: `focus_and_type failed: selector '${action.selector}' not found. Check DOM info for correct selector.` });
            }
            await wait(800);
          }
          break;

        case 'press_key':
          if (action.key) {
            await pressKey(sendCmd, action.key);
            await wait(1500);
          }
          break;

        case 'navigate':
          if (action.url) {
            await cdpNavigate(sendCmd, action.url);
            await wait(4000);
          }
          break;

        case 'wait':
          await wait(Math.min(action.ms || 2000, 10000));
          break;

        case 'scroll':
          await cdpScroll(sendCmd, action.scrollY || 300);
          await wait(1000);
          break;

        case 'run_js':
          if (action.js) {
            const jsResult = await evalJS(sendCmd, action.js);
            history.push({ action: 'system', reasoning: `JS result: ${JSON.stringify(jsResult)}` });
            await wait(1000);
          }
          break;

        case 'upload_file':
          if (!fileUploaded) {
            console.log('[Agent] Uploading video file...');
            const uploaded = await uploadVideoFile(sendCmd, wait, params.videoUrl);
            fileUploaded = uploaded;
            history.push({
              action: 'system',
              reasoning: uploaded ? 'Video file successfully set on file input. Wait for processing.' : 'File upload failed — no file input found.',
            });
            await wait(uploaded ? 8000 : 3000);
          } else {
            history.push({ action: 'system', reasoning: 'File already uploaded, skip.' });
          }
          break;

        case 'need_verification': {
          console.log('[Agent] Verification needed...');
          if (!params.telegram.enabled || !params.telegram.chatId) {
            throw new Error(`${platform} verification required but Telegram is not configured.`);
          }

          // Capture screenshot and send to Telegram so user can see what's on screen
          try {
            const verifyScreenshot = await captureScreenshot(sendCmd);
            if (verifyScreenshot) {
              await sendTelegramPhoto(
                params.telegram,
                verifyScreenshot,
                `🔐 <b>${platform}</b> verification screen — see what the browser is showing:`
              );
            }
          } catch (e) {
            console.error('[Agent] Failed to send verification screenshot:', e);
          }

          const sinceIso = new Date().toISOString();
          const reason = action.reasoning || 'Login verification or 2FA required';
          await sendTelegramPrompt(params.telegram, platform, params.jobId, reason);
          const approval = await waitForTelegramApproval(params.supabase, params.telegram.chatId, sinceIso);
          if (!approval) {
            // Send timeout message
            await sendTelegramMessage(params.telegram, `⏱ ${platform} verification timed out after 4 minutes. The upload has been cancelled.`);
            throw new Error(`${platform} verification timed out. Reply APPROVED or CODE 123456 in Telegram.`);
          }
          if (approval.code) {
            const codeTyped = await evalJS(sendCmd, `
              const inputs = document.querySelectorAll('input[type="tel"], input[type="text"], input[autocomplete="one-time-code"], input[name*="code" i], input[name*="pin" i]');
              for (const inp of inputs) {
                if (inp.offsetParent !== null) {
                  inp.focus();
                  inp.value = '${escJS(approval.code)}';
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                  inp.dispatchEvent(new Event('change', { bubbles: true }));
                  return 'code-entered';
                }
              }
              return 'no-input';
            `);
            console.log('[Agent] Verification code result:', codeTyped);
            await wait(1500);
            await pressKey(sendCmd, 'Enter');
            await wait(5000);
          } else {
            await wait(10000);
          }
          history.push({ action: 'system', reasoning: 'Verification handled via Telegram' });
          break;
        }

        case 'done': {
          console.log(`[Agent] Done: ${action.result || action.reasoning}`);
          const urlMatch = action.result?.match(/https?:\/\/[^\s"'<>]+/);
          const resultUrl = urlMatch?.[0];

          // Telegram success notification
          await sendTelegramMessage(
            params.telegram,
            `✅ <b>${platform.toUpperCase()}</b> upload complete!\n📹 ${params.title}\n${resultUrl ? `🔗 ${resultUrl}` : 'URL not captured'}`
          );

          return { url: resultUrl, message: action.result || `${platform} upload completed.` };
        }

        default:
          await wait(1500);
      }
    } catch (actionErr: any) {
      console.error(`[Agent] Action ${action.action} failed:`, actionErr.message);
      history.push({ action: 'system', reasoning: `Action failed: ${actionErr.message}. Try a different approach.` });

      // If we've had too many errors, notify via Telegram
      const errorCount = history.filter(h => h.action === 'system' && h.reasoning.startsWith('Action failed')).length;
      if (errorCount >= 5) {
        await sendTelegramMessage(
          params.telegram,
          `⚠️ <b>${platform}</b> upload is having trouble.\n\nMultiple actions failed. The agent will keep trying but may need your attention.\n\nLast error: ${actionErr.message}`
        );
      }
      await wait(2000);
    }
  }

  // Max steps reached — send failure notification
  await sendTelegramMessage(
    params.telegram,
    `❌ <b>${platform}</b> upload did not complete within ${MAX_STEPS} steps.\n📹 ${params.title}\n\nPlease check the Browser Sessions page for details.`
  );
  throw new Error(`${platform} upload did not complete within ${MAX_STEPS} steps.`);
}

// ========== WebSocket CDP Runner ==========

async function runBrowserAutomation(
  connectUrl: string, platform: string, params: AutomationParams,
): Promise<{ url?: string; message: string }> {
  return new Promise((resolve, reject) => {
    let cmdId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    let timeoutHandle: number;
    let cdpSessionId: string | null = null;

    const ws = new WebSocket(connectUrl);

    const sendCmd = (method: string, p?: any): Promise<any> => {
      return new Promise((res, rej) => {
        const id = cmdId++;
        pending.set(id, { resolve: res, reject: rej });
        const msg: any = { id, method, params: p || {} };
        if (cdpSessionId) msg.sessionId = cdpSessionId;
        ws.send(JSON.stringify(msg));
      });
    };

    const sendBrowserCmd = (method: string, p?: any): Promise<any> => {
      return new Promise((res, rej) => {
        const id = cmdId++;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params: p || {} }));
      });
    };

    const wait: Wait = (ms) => new Promise<void>(r => setTimeout(r, ms));

    ws.onopen = async () => {
      try {
        console.log('WebSocket connected, discovering targets...');
        timeoutHandle = setTimeout(() => {
          ws.close();
          reject(new Error('Browser automation timed out after 480s'));
        }, 480000);

        const targetsResult = await sendBrowserCmd('Target.getTargets');
        let pageTargetId: string | null = null;
        if (targetsResult?.targetInfos) {
          const pageTarget = targetsResult.targetInfos.find((t: any) => t.type === 'page');
          if (pageTarget) pageTargetId = pageTarget.targetId;
        }
        if (!pageTargetId) {
          const newTarget = await sendBrowserCmd('Target.createTarget', { url: 'about:blank' });
          pageTargetId = newTarget.targetId;
        }

        const attachResult = await sendBrowserCmd('Target.attachToTarget', { targetId: pageTargetId, flatten: true });
        cdpSessionId = attachResult.sessionId;
        console.log(`Attached to target, sessionId: ${cdpSessionId}`);

        await sendCmd('Page.enable');
        await sendCmd('Runtime.enable');
        await sendCmd('Network.enable');
        await sendCmd('DOM.enable');

        const result = await agenticUpload(sendCmd, wait, platform, params);
        clearTimeout(timeoutHandle);
        ws.close();
        resolve(result);
      } catch (e) {
        clearTimeout(timeoutHandle);
        ws.close();
        reject(e);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } catch {}
    };

    ws.onerror = (e: any) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`WebSocket error: ${e?.message || e}`));
    };

    ws.onclose = () => {
      clearTimeout(timeoutHandle);
      for (const [, p] of pending) p.reject(new Error('WebSocket closed'));
      pending.clear();
    };
  });
}
