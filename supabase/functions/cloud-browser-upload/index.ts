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

  if (!BROWSERBASE_API_KEY) {
    return new Response(JSON.stringify({ success: false, error: 'BROWSERBASE_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!BROWSERBASE_PROJECT_ID) {
    return new Response(JSON.stringify({ success: false, error: 'BROWSERBASE_PROJECT_ID not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ success: false, error: 'LOVABLE_API_KEY not configured' }), {
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
      .from('upload_jobs')
      .select('*')
      .eq('id', job_id)
      .single();

    const { data: appSettings } = await supabase
      .from('app_settings')
      .select('telegram_enabled, telegram_chat_id')
      .eq('id', 1)
      .single();

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

    // Create Browserbase session
    console.log(`Creating Browserbase session for ${platform}...`);
    const sessionResp = await fetch(`${BB_API}/sessions`, {
      method: 'POST',
      headers: {
        'x-bb-api-key': BROWSERBASE_API_KEY,
        'Content-Type': 'application/json',
      },
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
        enabled: Boolean(appSettings?.telegram_enabled && appSettings?.telegram_chat_id && LOVABLE_API_KEY && TELEGRAM_API_KEY),
        chatId: appSettings?.telegram_chat_id || null,
        lovableApiKey: LOVABLE_API_KEY || undefined,
        telegramApiKey: TELEGRAM_API_KEY || undefined,
      },
    });

    // Release the session
    try {
      await fetch(`${BB_API}/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'x-bb-api-key': BROWSERBASE_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
      });
    } catch (e) {
      console.error('Failed to release session:', e);
    }

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
  action: 'click' | 'type' | 'navigate' | 'wait' | 'scroll' | 'done' | 'need_verification' | 'upload_file';
  x?: number;
  y?: number;
  text?: string;
  url?: string;
  ms?: number;
  scrollY?: number;
  reasoning: string;
  result?: string;
};

// ========== AI Agent Core ==========

async function askAI(
  lovableApiKey: string,
  screenshot: string,
  taskPrompt: string,
  history: { action: string; reasoning: string }[],
): Promise<AgentAction> {
  const historyText = history.length > 0
    ? `\n\nPrevious actions taken:\n${history.map((h, i) => `${i + 1}. [${h.action}] ${h.reasoning}`).join('\n')}`
    : '';

  const response = await fetch(AI_GATEWAY, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${lovableApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-pro',
      messages: [
        {
          role: 'system',
          content: `You are a browser automation agent. You look at screenshots and decide what action to take next to complete a task.

You MUST respond with a JSON object (no markdown, no code fences) with these fields:
- action: one of "click", "type", "navigate", "wait", "scroll", "done", "need_verification", "upload_file"
- reasoning: brief explanation of what you see and why you chose this action
- For "click": include "x" and "y" (pixel coordinates on the 1280x900 viewport)
- For "type": include "text" (the text to type). The text will be typed into the currently focused element.
- For "navigate": include "url"
- For "wait": include "ms" (milliseconds to wait, max 10000)
- For "scroll": include "scrollY" (positive = down, negative = up, in pixels)
- For "done": include "result" (summary of what was accomplished, include any URLs)
- For "need_verification": the platform is asking for 2FA/verification, we need to ask user via Telegram
- For "upload_file": the file upload input is visible and ready (we will handle the file programmatically)

IMPORTANT RULES:
- Look carefully at the screenshot to identify UI elements, buttons, text fields, etc.
- If you see a login page and have credentials, type them in the appropriate fields
- Click coordinates should be the CENTER of the element you want to click
- After typing text, you often need to click a button to submit
- If the page seems stuck or nothing changed after an action, try a different approach
- Maximum 40 actions before you must return "done"
- If you see a success message or confirmation, return "done" with the result`,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `TASK: ${taskPrompt}${historyText}\n\nWhat action should I take next based on this screenshot?`,
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
            description: 'Execute a browser action based on the screenshot',
            parameters: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['click', 'type', 'navigate', 'wait', 'scroll', 'done', 'need_verification', 'upload_file'],
                },
                x: { type: 'number', description: 'X coordinate for click' },
                y: { type: 'number', description: 'Y coordinate for click' },
                text: { type: 'string', description: 'Text to type' },
                url: { type: 'string', description: 'URL to navigate to' },
                ms: { type: 'number', description: 'Milliseconds to wait' },
                scrollY: { type: 'number', description: 'Pixels to scroll (positive=down)' },
                reasoning: { type: 'string', description: 'Why this action' },
                result: { type: 'string', description: 'Result summary for done action' },
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

  // Extract tool call result
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      return JSON.parse(toolCall.function.arguments) as AgentAction;
    } catch {
      console.error('Failed to parse AI tool call:', toolCall.function.arguments);
    }
  }

  // Fallback: try parsing message content as JSON
  const content = data.choices?.[0]?.message?.content || '';
  try {
    const cleaned = content.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as AgentAction;
  } catch {
    console.error('Failed to parse AI response:', content);
    return { action: 'wait', ms: 3000, reasoning: 'Could not parse AI response, waiting...' };
  }
}

// ========== CDP Helpers ==========

async function captureScreenshot(sendCmd: SendCmd): Promise<string> {
  const result = await sendCmd('Page.captureScreenshot', {
    format: 'png',
    quality: 80,
    clip: { x: 0, y: 0, width: 1280, height: 900, scale: 1 },
  });
  return result?.data || '';
}

async function cdpClick(sendCmd: SendCmd, x: number, y: number): Promise<void> {
  await sendCmd('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x, y,
    button: 'left',
    clickCount: 1,
  });
  await sendCmd('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x, y,
    button: 'left',
    clickCount: 1,
  });
}

async function cdpType(sendCmd: SendCmd, text: string): Promise<void> {
  for (const char of text) {
    await sendCmd('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      key: char,
      code: `Key${char.toUpperCase()}`,
      unmodifiedText: char,
    });
    await sendCmd('Input.dispatchKeyEvent', {
      type: 'keyUp',
      text: char,
      key: char,
      code: `Key${char.toUpperCase()}`,
    });
  }
}

async function cdpNavigate(sendCmd: SendCmd, url: string): Promise<void> {
  await sendCmd('Page.navigate', { url });
}

async function cdpScroll(sendCmd: SendCmd, deltaY: number): Promise<void> {
  await sendCmd('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 640,
    y: 450,
    deltaX: 0,
    deltaY,
  });
}

async function evaluateJS(sendCmd: SendCmd, expression: string): Promise<any> {
  const wrapped = `(() => { ${expression} })()`;
  const result = await sendCmd('Runtime.evaluate', {
    expression: wrapped,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value;
}

function escJS(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

// ========== Telegram Helpers ==========

async function sendTelegramPrompt(
  telegram: { enabled: boolean; chatId: string | number | null; lovableApiKey?: string; telegramApiKey?: string },
  platform: string,
  jobId: string,
): Promise<boolean> {
  if (!telegram.enabled || !telegram.chatId || !telegram.lovableApiKey || !telegram.telegramApiKey) return false;

  const response = await fetch('https://connector-gateway.lovable.dev/telegram/sendMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${telegram.lovableApiKey}`,
      'X-Connection-Api-Key': telegram.telegramApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text:
        `🔐 ${platform} login needs verification for job ${jobId}.\n` +
        `Please approve sign-in on your phone.\n` +
        `Then reply with:\n` +
        `• APPROVED\n` +
        `or\n` +
        `• CODE 123456`,
      parse_mode: 'HTML',
    }),
  });
  return response.ok;
}

type ApprovalResult = { approved: boolean; code?: string };

function parseApprovalText(text: string): ApprovalResult | null {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase();
  if (['approve', 'approved', 'ok', 'done', 'yes', 'continue'].some((word) => normalized === word || normalized.startsWith(`${word} `))) {
    return { approved: true };
  }

  const codePatterns = [
    /\bcode\s*[:=\-]?\s*([a-zA-Z0-9\-]{4,12})\b/i,
    /\botp\s*[:=\-]?\s*([0-9]{4,8})\b/i,
    /\b([0-9]{4,8})\b/,
  ];

  for (const pattern of codePatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return { approved: true, code: match[1] };
  }

  return null;
}

async function waitForTelegramApproval(
  supabase: any,
  chatId: string | number,
  sinceIso: string,
  timeoutMs = 240000,
): Promise<ApprovalResult | null> {
  const start = Date.now();
  const normalizedChat = Number.isFinite(Number(chatId)) ? Number(chatId) : String(chatId);

  while (Date.now() - start < timeoutMs) {
    let query = supabase
      .from('telegram_messages')
      .select('text, created_at')
      .eq('is_bot', false)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(30);

    query = query.eq('chat_id', normalizedChat as any);

    const { data } = await query;
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const parsed = parseApprovalText(row.text || '');
      if (parsed) return parsed;
    }

    await new Promise((r) => setTimeout(r, 4000));
  }

  return null;
}

// ========== File Upload via CDP ==========

async function uploadVideoFile(sendCmd: SendCmd, wait: Wait, videoUrl: string): Promise<boolean> {
  // Use JavaScript in the browser to fetch the video and set it on the file input
  const result = await evaluateJS(sendCmd, `
    return (async () => {
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
        return 'file-set';
      } catch (e) {
        return 'error:' + (e?.message || e);
      }
    })();
  `);

  console.log('[Upload] File upload result:', result);
  return result === 'file-set';
}

// ========== Log AI Steps to DB ==========

async function logAgentStep(
  supabase: any,
  jobId: string,
  step: number,
  action: AgentAction,
) {
  try {
    // Store AI decision log as part of platform_results metadata
    const { data: job } = await supabase
      .from('upload_jobs')
      .select('platform_results')
      .eq('id', jobId)
      .single();

    const results = (job?.platform_results as any[]) || [];
    // Find or create an ai_log entry
    let aiLog = results.find((r: any) => r.name === '_ai_log');
    if (!aiLog) {
      aiLog = { name: '_ai_log', steps: [] };
      results.push(aiLog);
    }
    aiLog.steps = aiLog.steps || [];
    aiLog.steps.push({
      step,
      action: action.action,
      reasoning: action.reasoning,
      timestamp: new Date().toISOString(),
    });

    await supabase.from('upload_jobs').update({ platform_results: results }).eq('id', jobId);
  } catch (e) {
    console.error('Failed to log agent step:', e);
  }
}

// ========== Main Agentic Loop ==========

function buildTaskPrompt(platform: string, params: AutomationParams): string {
  const credInfo = params.email && params.password
    ? `\n\nLogin credentials if needed:\n- Email: ${params.email}\n- Password: ${params.password}`
    : '\n\nNo login credentials provided. If login is required, return need_verification.';

  const metaInfo = `\n\nVideo metadata:\n- Title: ${params.title}\n- Description: ${params.description}\n- Tags: ${params.tags.join(', ')}`;

  switch (platform) {
    case 'youtube':
      return `Upload a video to YouTube Studio.

Steps:
1. You should be on YouTube Studio (studio.youtube.com). If you see a Google login page, enter the email and password.
2. If Google asks for verification/2FA, return "need_verification" so we can ask the user via Telegram.
3. Once logged in to YouTube Studio, click the "Create" button (camera icon with +) in the top right area.
4. Click "Upload videos" from the dropdown menu.
5. When you see the upload dialog with a file input, return "upload_file" so we can programmatically set the video file.
6. Wait for the video to process. Fill in the title field with the provided title.
7. Fill in the description field.
8. Click "Next" through the wizard steps (3 times).
9. On the visibility page, select "Public".
10. Click "Publish" or "Done".
11. After publishing, look for the video URL/link and return "done" with the URL.${credInfo}${metaInfo}`;

    case 'tiktok':
      return `Upload a video to TikTok Creator Center.

Steps:
1. Navigate to TikTok creator upload page. If you see a login page, enter email/password.
2. If TikTok asks for verification, return "need_verification".
3. When you see the upload area/button, return "upload_file" so we can set the video file.
4. After upload, fill the caption/description with the title and tags as hashtags.
5. Click "Post" to publish.
6. Return "done" when complete.${credInfo}${metaInfo}`;

    case 'instagram':
      return `Upload a video as a Reel on Instagram.

Steps:
1. Go to Instagram. If you see a login page, enter username/email and password.
2. If Instagram asks for verification or security code, return "need_verification".
3. Dismiss any "Not Now" dialogs (notifications, save login info).
4. Click the "Create" or "New post" button (+ icon in the sidebar/nav).
5. When the file input appears, return "upload_file" so we can set the video file.
6. Click "Next" through crop and filter steps.
7. Fill in the caption with title, description, and hashtags.
8. Click "Share" to publish.
9. Return "done" when complete.${credInfo}${metaInfo}`;

    default:
      return `Navigate ${platform} and upload a video.${credInfo}${metaInfo}`;
  }
}

async function agenticUpload(
  sendCmd: SendCmd,
  wait: Wait,
  platform: string,
  params: AutomationParams,
): Promise<{ url?: string; message: string }> {
  const taskPrompt = buildTaskPrompt(platform, params);
  const history: { action: string; reasoning: string }[] = [];
  const MAX_STEPS = 40;
  let fileUploaded = false;

  // Navigate to initial URL
  const startUrls: Record<string, string> = {
    youtube: 'https://studio.youtube.com',
    tiktok: 'https://www.tiktok.com/creator#/upload?scene=creator_center',
    instagram: 'https://www.instagram.com/',
  };

  const startUrl = startUrls[platform] || `https://www.${platform}.com`;
  console.log(`[Agent] Starting ${platform} upload, navigating to ${startUrl}...`);
  await cdpNavigate(sendCmd, startUrl);
  await wait(5000);

  for (let step = 0; step < MAX_STEPS; step++) {
    console.log(`[Agent] Step ${step + 1}/${MAX_STEPS} — capturing screenshot...`);

    let screenshot: string;
    try {
      screenshot = await captureScreenshot(sendCmd);
    } catch (e) {
      console.error('[Agent] Screenshot failed:', e);
      await wait(3000);
      continue;
    }

    if (!screenshot) {
      console.error('[Agent] Empty screenshot, waiting...');
      await wait(3000);
      continue;
    }

    console.log(`[Agent] Asking AI for next action...`);
    let action: AgentAction;
    try {
      action = await askAI(params.lovableApiKey, screenshot, taskPrompt, history);
    } catch (e) {
      console.error('[Agent] AI call failed:', e);
      await wait(5000);
      continue;
    }

    console.log(`[Agent] Step ${step + 1}: ${action.action} — ${action.reasoning}`);
    await logAgentStep(params.supabase, params.jobId, step + 1, action);
    history.push({ action: action.action, reasoning: action.reasoning });

    switch (action.action) {
      case 'click':
        if (action.x != null && action.y != null) {
          await cdpClick(sendCmd, action.x, action.y);
          await wait(2000);
        }
        break;

      case 'type':
        if (action.text) {
          await cdpType(sendCmd, action.text);
          await wait(1000);
        }
        break;

      case 'navigate':
        if (action.url) {
          await cdpNavigate(sendCmd, action.url);
          await wait(5000);
        }
        break;

      case 'wait':
        await wait(Math.min(action.ms || 3000, 10000));
        break;

      case 'scroll':
        await cdpScroll(sendCmd, action.scrollY || 300);
        await wait(1500);
        break;

      case 'upload_file':
        if (!fileUploaded) {
          console.log('[Agent] Uploading video file...');
          const uploaded = await uploadVideoFile(sendCmd, wait, params.videoUrl);
          if (uploaded) {
            fileUploaded = true;
            history.push({ action: 'upload_file', reasoning: 'Video file successfully set on file input' });
            await wait(10000); // Wait for upload to start processing
          } else {
            history.push({ action: 'upload_file', reasoning: 'Failed to find file input, will retry' });
            await wait(3000);
          }
        } else {
          history.push({ action: 'upload_file', reasoning: 'File already uploaded, skipping' });
        }
        break;

      case 'need_verification':
        console.log('[Agent] Verification needed, asking via Telegram...');
        if (!params.telegram.enabled || !params.telegram.chatId) {
          throw new Error(`${platform} verification required but Telegram is not configured.`);
        }

        const sinceIso = new Date().toISOString();
        await sendTelegramPrompt(params.telegram, platform, params.jobId);
        const approval = await waitForTelegramApproval(params.supabase, params.telegram.chatId, sinceIso);

        if (!approval) {
          throw new Error(`${platform} verification timed out. Reply APPROVED or CODE 123456 in Telegram.`);
        }

        if (approval.code) {
          // Type the verification code
          await cdpType(sendCmd, approval.code);
          await wait(2000);
          // Try to click a submit/verify/next button
          const nextScreenshot = await captureScreenshot(sendCmd);
          const nextAction = await askAI(params.lovableApiKey, nextScreenshot,
            'A verification code was just typed. Click the submit/verify/next button to proceed.',
            history);
          if (nextAction.action === 'click' && nextAction.x != null && nextAction.y != null) {
            await cdpClick(sendCmd, nextAction.x, nextAction.y);
          }
          await wait(5000);
        } else {
          // User approved externally (e.g., phone), just wait
          await wait(10000);
        }
        history.push({ action: 'need_verification', reasoning: 'Verification handled via Telegram' });
        break;

      case 'done':
        console.log(`[Agent] Done: ${action.result || action.reasoning}`);

        // Try to extract URL from the result
        const urlMatch = action.result?.match(/https?:\/\/[^\s"'<>]+/);
        const resultUrl = urlMatch?.[0];

        // Send success notification via Telegram
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
          });
        }

        return {
          url: resultUrl,
          message: action.result || `${platform} upload completed successfully.`,
        };

      default:
        console.log(`[Agent] Unknown action: ${action.action}`);
        await wait(2000);
    }
  }

  throw new Error(`${platform} upload did not complete within ${MAX_STEPS} steps. Check Browser Sessions for details.`);
}

// ========== WebSocket CDP Runner ==========

async function runBrowserAutomation(
  connectUrl: string,
  platform: string,
  params: AutomationParams
): Promise<{ url?: string; message: string }> {
  return new Promise((resolve, reject) => {
    let cmdId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    let timeoutHandle: number;
    let cdpSessionId: string | null = null;

    const ws = new WebSocket(connectUrl);

    const sendCmd = (method: string, cmdParams?: any): Promise<any> => {
      return new Promise((res, rej) => {
        const id = cmdId++;
        pending.set(id, { resolve: res, reject: rej });
        const msg: any = { id, method, params: cmdParams || {} };
        if (cdpSessionId) {
          msg.sessionId = cdpSessionId;
        }
        ws.send(JSON.stringify(msg));
      });
    };

    const sendBrowserCmd = (method: string, cmdParams?: any): Promise<any> => {
      return new Promise((res, rej) => {
        const id = cmdId++;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params: cmdParams || {} }));
      });
    };

    const wait: Wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    ws.onopen = async () => {
      try {
        console.log('WebSocket connected, discovering targets...');

        // 8 min timeout for AI-driven automation (needs more time)
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

        const attachResult = await sendBrowserCmd('Target.attachToTarget', {
          targetId: pageTargetId,
          flatten: true,
        });
        cdpSessionId = attachResult.sessionId;
        console.log(`Attached to target, sessionId: ${cdpSessionId}`);

        await sendCmd('Page.enable');
        await sendCmd('Runtime.enable');
        await sendCmd('Network.enable');

        // Run the AI agentic loop
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
          if (msg.error) {
            p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = (e: any) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`WebSocket error: ${e?.message || e}`));
    };

    ws.onclose = () => {
      clearTimeout(timeoutHandle);
      for (const [, p] of pending) {
        p.reject(new Error('WebSocket closed'));
      }
      pending.clear();
    };
  });
}
