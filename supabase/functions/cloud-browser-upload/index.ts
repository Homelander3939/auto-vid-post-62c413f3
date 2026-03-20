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
      .eq('id', 1).single();

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
        enabled: Boolean(appSettings?.telegram_enabled && appSettings?.telegram_chat_id && TELEGRAM_API_KEY),
        chatId: appSettings?.telegram_chat_id || null,
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

const SYSTEM_PROMPT = `You are a fast, precise browser automation agent. You analyze screenshots AND DOM info to decide the single best next action.

RESPOND ONLY with a JSON object via the browser_action tool call. No markdown, no extra text.

## Available actions:
- **click_xy**: Click at pixel coordinates (x, y) on the 1280x900 viewport. Use when you can see the element but don't have a CSS selector.
- **click_element**: Click element by CSS selector. PREFERRED over click_xy. Use the DOM info provided.
- **focus_and_type**: Focus an input by CSS selector AND type text into it. This CLEARS the field first then types. Use for filling forms.
- **press_key**: Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp).
- **navigate**: Go to a URL.
- **wait**: Wait N milliseconds (max 10000).
- **scroll**: Scroll by pixels (positive=down, negative=up).
- **run_js**: Execute JavaScript in the page. Use for complex DOM manipulations.
- **upload_file**: Signal that a file input is ready for video upload (we handle it programmatically).
- **need_verification**: Platform is asking for 2FA/security verification — triggers Telegram notification.
- **done**: Task is complete. Include result with any URLs.

## CRITICAL RULES:
1. USE CSS SELECTORS (click_element, focus_and_type) whenever possible. They are 10x more reliable than click_xy coordinates.
2. On Google Sign-In: The email field selector is 'input[type="email"]'. After typing email, press Enter or click_element on '#identifierNext'.
3. On Google Password: The password field selector is 'input[type="password"]'. After typing password, press Enter or click_element on '#passwordNext'.
4. NEVER type credentials using click_xy. ALWAYS use focus_and_type with the correct selector.
5. After typing in a form field, you usually need to press Enter or click a Next/Submit button.
6. If a page hasn't fully loaded (blank/white), use "wait" with 3000ms.
7. If stuck (same screenshot 3+ times), try a completely different approach.
8. Maximum 50 actions before you MUST return "done".`;

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
  if (!telegram.enabled || !telegram.chatId || !telegram.lovableApiKey || !telegram.telegramApiKey) return false;
  const response = await fetch('https://connector-gateway.lovable.dev/telegram/sendMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${telegram.lovableApiKey}`,
      'X-Connection-Api-Key': telegram.telegramApiKey!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
  return response.ok;
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
    ? `\n\nCredentials:\n- Email: ${params.email}\n- Password: ${params.password}\n\nIMPORTANT: Use focus_and_type with CSS selector to enter credentials. For Google login:\n1. focus_and_type selector='input[type="email"]' text='${params.email}'\n2. click_element selector='#identifierNext' OR press_key 'Enter'\n3. Wait 3s for password page\n4. focus_and_type selector='input[type="password"]' text='${params.password}'\n5. click_element selector='#passwordNext' OR press_key 'Enter'`
    : '\n\nNo credentials provided. If login required, return need_verification.';

  const meta = `\n\nVideo metadata:\n- Title: ${params.title}\n- Description: ${params.description}\n- Tags: ${params.tags.join(', ')}`;

  switch (platform) {
    case 'youtube':
      return `Upload a video to YouTube Studio (studio.youtube.com).

STEP-BY-STEP PLAN:
1. If on Google login page → enter email via focus_and_type on input[type="email"], then click #identifierNext
2. Wait for password page → enter password via focus_and_type on input[type="password"], then click #passwordNext  
3. If 2FA/verification appears → return need_verification
4. Once on YouTube Studio → click the Create button (look for button with "Upload" or camera+ icon, usually top-right)
5. Click "Upload videos" from dropdown
6. When file input appears → return upload_file
7. After file loads → fill title (clear existing text first, use the textbox element)
8. Fill description
9. Click Next 3 times to go through wizard
10. Select "Public" visibility
11. Click "Publish" / "Save" / "Done"
12. Extract the video URL and return done${cred}${meta}`;

    case 'tiktok':
      return `Upload a video to TikTok.

STEP-BY-STEP PLAN:
1. Navigate to tiktok.com/creator#/upload
2. If login needed → enter credentials
3. If verification → return need_verification
4. When file upload area visible → return upload_file
5. Fill caption with title + hashtags from tags
6. Click Post
7. Return done with URL${cred}${meta}`;

    case 'instagram':
      return `Upload a video as a Reel on Instagram.

STEP-BY-STEP PLAN:
1. Navigate to instagram.com
2. If login needed → focus_and_type on input[name="username"] and input[name="password"]
3. If verification → return need_verification
4. Dismiss any popups (Not Now buttons)
5. Click Create/New post (+ icon)
6. When file input visible → return upload_file
7. Navigate through crop/filter → click Next
8. Fill caption
9. Click Share
10. Return done${cred}${meta}`;

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
          if (params.telegram.enabled && params.telegram.chatId && params.telegram.lovableApiKey && params.telegram.telegramApiKey) {
            await fetch('https://connector-gateway.lovable.dev/telegram/sendMessage', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${params.telegram.lovableApiKey}`,
                'X-Connection-Api-Key': params.telegram.telegramApiKey!,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                chat_id: params.telegram.chatId,
                text: `✅ ${platform.toUpperCase()} upload complete!\n📹 ${params.title}\n${resultUrl ? `🔗 ${resultUrl}` : 'URL not captured'}`,
                parse_mode: 'HTML',
              }),
            }).catch(() => {});
          }

          return { url: resultUrl, message: action.result || `${platform} upload completed.` };
        }

        default:
          await wait(1500);
      }
    } catch (actionErr: any) {
      console.error(`[Agent] Action ${action.action} failed:`, actionErr.message);
      history.push({ action: 'system', reasoning: `Action failed: ${actionErr.message}. Try a different approach.` });
      await wait(2000);
    }
  }

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
