import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const BB_API = 'https://api.browserbase.com/v1';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const BROWSERBASE_API_KEY = Deno.env.get('BROWSERBASE_API_KEY');
  const BROWSERBASE_PROJECT_ID = Deno.env.get('BROWSERBASE_PROJECT_ID');

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

    // Get the job details
    const { data: job, error: jobErr } = await supabase
      .from('upload_jobs')
      .select('*')
      .eq('id', job_id)
      .single();

    if (jobErr || !job) {
      return new Response(JSON.stringify({ success: false, error: 'Job not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get video public URL
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
        browserSettings: {
          blockAds: true,
        },
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

    // Store session ID on the job
    await supabase.from('upload_jobs').update({ browserbase_session_id: sessionId }).eq('id', job_id);

    // Connect via Playwright-style CDP using the connect URL
    const connectWsUrl = `wss://connect.browserbase.com?apiKey=${BROWSERBASE_API_KEY}&sessionId=${sessionId}`;

    const result = await runBrowserAutomation(connectWsUrl, platform, {
      videoUrl,
      title: job.title || 'Untitled Video',
      description: job.description || '',
      tags: job.tags || [],
      email: credentials?.email || '',
      password: credentials?.password || '',
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

// CDP WebSocket automation with proper Target management
async function runBrowserAutomation(
  connectUrl: string,
  platform: string,
  params: {
    videoUrl: string;
    title: string;
    description: string;
    tags: string[];
    email: string;
    password: string;
  }
): Promise<{ url?: string; message: string }> {
  return new Promise((resolve, reject) => {
    let cmdId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    let timeoutHandle: number;
    let cdpSessionId: string | null = null;

    const ws = new WebSocket(connectUrl);

    // Send CDP command — if we have a sessionId from Target.attachToTarget, include it
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

    // Send browser-level command (no sessionId)
    const sendBrowserCmd = (method: string, cmdParams?: any): Promise<any> => {
      return new Promise((res, rej) => {
        const id = cmdId++;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params: cmdParams || {} }));
      });
    };

    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

    ws.onopen = async () => {
      try {
        console.log('WebSocket connected, discovering targets...');

        // Set global timeout (5 min for video uploads)
        timeoutHandle = setTimeout(() => {
          ws.close();
          reject(new Error('Browser automation timed out after 300s'));
        }, 300000);

        // Get available targets
        const targetsResult = await sendBrowserCmd('Target.getTargets');
        console.log('Targets:', JSON.stringify(targetsResult));

        let pageTargetId: string | null = null;

        if (targetsResult?.targetInfos) {
          const pageTarget = targetsResult.targetInfos.find((t: any) => t.type === 'page');
          if (pageTarget) {
            pageTargetId = pageTarget.targetId;
            console.log(`Found existing page target: ${pageTargetId}`);
          }
        }

        if (!pageTargetId) {
          // Create a new page target
          console.log('Creating new page target...');
          const newTarget = await sendBrowserCmd('Target.createTarget', { url: 'about:blank' });
          pageTargetId = newTarget.targetId;
          console.log(`Created page target: ${pageTargetId}`);
        }

        // Attach to the target in flatten mode to get a sessionId
        const attachResult = await sendBrowserCmd('Target.attachToTarget', {
          targetId: pageTargetId,
          flatten: true,
        });
        cdpSessionId = attachResult.sessionId;
        console.log(`Attached to target, sessionId: ${cdpSessionId}`);

        // Now enable Page and Runtime on the attached session
        await sendCmd('Page.enable');
        await sendCmd('Runtime.enable');
        await sendCmd('Network.enable');

        console.log(`Starting ${platform} automation...`);

        let result: { url?: string; message: string };

        switch (platform) {
          case 'youtube':
            result = await automateYouTube(sendCmd, wait, params);
            break;
          case 'tiktok':
            result = await automateTikTok(sendCmd, wait, params);
            break;
          case 'instagram':
            result = await automateInstagram(sendCmd, wait, params);
            break;
          default:
            throw new Error(`Unsupported platform: ${platform}`);
        }

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

type SendCmd = (method: string, params?: any) => Promise<any>;
type Wait = (ms: number) => Promise<void>;

async function navigateTo(sendCmd: SendCmd, wait: Wait, url: string): Promise<void> {
  await sendCmd('Page.navigate', { url });
  // Wait for load event
  await wait(5000);
}

async function evaluateJS(sendCmd: SendCmd, expression: string): Promise<any> {
  // Wrap in IIFE to avoid variable redeclaration errors in page context
  const wrapped = `(() => { ${expression} })()`;
  const result = await sendCmd('Runtime.evaluate', {
    expression: wrapped,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    console.error('JS eval error:', JSON.stringify(result.exceptionDetails));
  }
  return result?.result?.value;
}

// Helper to safely escape strings for JS injection
function escJS(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

// --- YouTube Studio Automation ---
async function automateYouTube(
  sendCmd: SendCmd,
  wait: Wait,
  params: { videoUrl: string; title: string; description: string; tags: string[]; email: string; password: string }
): Promise<{ url?: string; message: string }> {
  console.log('[YouTube] Navigating to YouTube Studio...');
  await navigateTo(sendCmd, wait, 'https://studio.youtube.com');
  await wait(3000);

  // Check if we need to log in
  const currentUrl = await evaluateJS(sendCmd, 'window.location.href');
  console.log('[YouTube] Current URL:', currentUrl);

  if (currentUrl && (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin'))) {
    if (!params.email || !params.password) {
      throw new Error('YouTube login required but no credentials provided. Add YouTube email and password in Settings.');
    }

    console.log('[YouTube] Logging in...');
    // Type email
    await evaluateJS(sendCmd, `
      const emailInput = document.querySelector('input[type="email"]');
      if (emailInput) {
        emailInput.focus();
        emailInput.value = '${escJS(params.email)}';
        emailInput.dispatchEvent(new Event('input', {bubbles: true}));
        emailInput.dispatchEvent(new Event('change', {bubbles: true}));
      }
    `);
    await wait(1000);
    await evaluateJS(sendCmd, `
      const nextBtn = document.querySelector('#identifierNext button');
      if (nextBtn) nextBtn.click();
    `);
    await wait(4000);

    // Type password
    await evaluateJS(sendCmd, `
      const passInput = document.querySelector('input[type="password"]');
      if (passInput) {
        passInput.focus();
        passInput.value = '${escJS(params.password)}';
        passInput.dispatchEvent(new Event('input', {bubbles: true}));
        passInput.dispatchEvent(new Event('change', {bubbles: true}));
      }
    `);
    await wait(1000);
    await evaluateJS(sendCmd, `
      const passNext = document.querySelector('#passwordNext button');
      if (passNext) passNext.click();
    `);
    await wait(6000);

    // Navigate to studio after login
    await navigateTo(sendCmd, wait, 'https://studio.youtube.com');
    await wait(3000);
  }

  // Click "Create" button
  console.log('[YouTube] Clicking Create button...');
  await evaluateJS(sendCmd, `
    const createBtn = document.querySelector('#create-icon, ytcp-button#create-icon');
    if (createBtn) createBtn.click();
  `);
  await wait(2000);

  // Click "Upload videos"
  await evaluateJS(sendCmd, `
    const uploadItem = document.querySelector('#text-item-0, tp-yt-paper-item#text-item-0');
    if (uploadItem) uploadItem.click();
  `);
  await wait(3000);

  // Download video and trigger file input
  console.log('[YouTube] Uploading video file...');
  await evaluateJS(sendCmd, `
    (async () => {
      try {
        const resp = await fetch('${escJS(params.videoUrl)}');
        const blob = await resp.blob();
        const file = new File([blob], 'video.mp4', { type: 'video/mp4' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.querySelector('input[type="file"]');
        if (input) {
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return 'file-set';
        }
        return 'no-input-found';
      } catch(e) {
        return 'error: ' + e.message;
      }
    })()
  `);
  await wait(10000);

  // Fill title
  console.log('[YouTube] Filling title...');
  await evaluateJS(sendCmd, `
    const titleBox = document.querySelector('#textbox[aria-label*="title" i], ytcp-social-suggestions-textbox #textbox, #title-textarea #textbox');
    if (titleBox) {
      titleBox.focus();
      titleBox.textContent = '';
      document.execCommand('selectAll');
      document.execCommand('insertText', false, '${escJS(params.title)}');
    }
  `);
  await wait(1000);

  // Fill description
  if (params.description) {
    console.log('[YouTube] Filling description...');
    await evaluateJS(sendCmd, `
      const descBoxes = document.querySelectorAll('#textbox');
      const descBox = descBoxes.length > 1 ? descBoxes[1] : null;
      if (descBox) {
        descBox.focus();
        descBox.textContent = '';
        document.execCommand('insertText', false, '${escJS(params.description)}');
      }
    `);
  }
  await wait(2000);

  // Click through wizard: Next x3
  console.log('[YouTube] Clicking through wizard...');
  for (let i = 0; i < 3; i++) {
    await evaluateJS(sendCmd, `
      const nextBtn = document.querySelector('#next-button button, ytcp-button#next-button');
      if (nextBtn) nextBtn.click();
    `);
    await wait(2500);
  }

  // Set to Public visibility
  console.log('[YouTube] Setting visibility to Public...');
  await evaluateJS(sendCmd, `
    const publicRadio = document.querySelector('tp-yt-paper-radio-button[name="PUBLIC"]');
    if (publicRadio) publicRadio.click();
  `);
  await wait(1500);

  // Click Done/Publish
  console.log('[YouTube] Publishing...');
  await evaluateJS(sendCmd, `
    const doneBtn = document.querySelector('#done-button button, ytcp-button#done-button');
    if (doneBtn) doneBtn.click();
  `);
  await wait(8000);

  // Try to grab the video URL from the success dialog
  const videoLink = await evaluateJS(sendCmd, `
    const link = document.querySelector('a.style-scope.ytcp-video-info[href*="youtu"]');
    if (link) link.href;
    else {
      const anyLink = document.querySelector('.video-url-fadeable a');
      anyLink ? anyLink.href : '';
    }
  `);

  console.log('[YouTube] Upload complete, link:', videoLink);

  return {
    url: videoLink || undefined,
    message: videoLink ? `YouTube upload complete: ${videoLink}` : 'YouTube upload initiated — check Studio for status.',
  };
}

// --- TikTok Automation ---
async function automateTikTok(
  sendCmd: SendCmd,
  wait: Wait,
  params: { videoUrl: string; title: string; description: string; tags: string[]; email: string; password: string }
): Promise<{ url?: string; message: string }> {
  console.log('[TikTok] Navigating to TikTok Creator Center...');
  await navigateTo(sendCmd, wait, 'https://www.tiktok.com/creator#/upload?scene=creator_center');
  await wait(5000);

  const currentUrl = await evaluateJS(sendCmd, 'window.location.href');
  console.log('[TikTok] Current URL:', currentUrl);

  // Check if login is needed
  if (currentUrl && (currentUrl.includes('login') || currentUrl.includes('signin'))) {
    if (!params.email || !params.password) {
      throw new Error('TikTok login required but no credentials provided. Add TikTok email and password in Settings.');
    }

    console.log('[TikTok] Logging in...');
    // Click email/password login option
    await evaluateJS(sendCmd, `
      const emailOpt = document.querySelector('div[data-e2e="channel-item"]:has(div:contains("email"))') ||
        Array.from(document.querySelectorAll('a, div[role="link"]')).find(el => el.textContent?.toLowerCase().includes('email'));
      if (emailOpt) emailOpt.click();
    `);
    await wait(2000);

    await evaluateJS(sendCmd, `
      const userInput = document.querySelector('input[name="username"], input[placeholder*="email" i], input[type="text"]');
      if (userInput) {
        userInput.focus();
        userInput.value = '${escJS(params.email)}';
        userInput.dispatchEvent(new Event('input', {bubbles: true}));
      }
    `);
    await wait(500);

    await evaluateJS(sendCmd, `
      const passInput = document.querySelector('input[type="password"]');
      if (passInput) {
        passInput.focus();
        passInput.value = '${escJS(params.password)}';
        passInput.dispatchEvent(new Event('input', {bubbles: true}));
      }
    `);
    await wait(500);

    await evaluateJS(sendCmd, `
      const loginBtn = document.querySelector('button[type="submit"]') ||
        Array.from(document.querySelectorAll('button')).find(b => b.textContent?.toLowerCase().includes('log in'));
      if (loginBtn) loginBtn.click();
    `);
    await wait(8000);

    // Navigate to upload after login
    await navigateTo(sendCmd, wait, 'https://www.tiktok.com/creator#/upload?scene=creator_center');
    await wait(5000);
  }

  // Upload video file
  console.log('[TikTok] Uploading video...');
  const uploadResult = await evaluateJS(sendCmd, `
    (async () => {
      try {
        const resp = await fetch('${escJS(params.videoUrl)}');
        const blob = await resp.blob();
        const file = new File([blob], 'video.mp4', { type: 'video/mp4' });
        const dt = new DataTransfer();
        dt.items.add(file);
        let input = document.querySelector('input[type="file"][accept*="video"]');
        if (!input) {
          const iframe = document.querySelector('iframe');
          if (iframe && iframe.contentDocument) {
            input = iframe.contentDocument.querySelector('input[type="file"]');
          }
        }
        if (!input) input = document.querySelector('input[type="file"]');
        if (input) {
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return 'file-set';
        }
        return 'no-input-found';
      } catch(e) {
        return 'error: ' + e.message;
      }
    })()
  `);
  console.log('[TikTok] Upload result:', uploadResult);
  await wait(12000);

  // Fill caption
  const caption = `${params.title} ${params.description} ${params.tags.map(t => `#${t}`).join(' ')}`.trim();
  console.log('[TikTok] Filling caption...');
  await evaluateJS(sendCmd, `
    const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('.DraftEditor-root [contenteditable]');
    if (editor) {
      editor.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, '${escJS(caption.slice(0, 2200))}');
    }
  `);
  await wait(3000);

  // Click post
  console.log('[TikTok] Clicking Post...');
  await evaluateJS(sendCmd, `
    const postBtn = document.querySelector('button[data-e2e="post_video_button"]') ||
      Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Post');
    if (postBtn) postBtn.click();
  `);
  await wait(8000);

  return { message: 'TikTok upload initiated — check your TikTok profile for the new video.' };
}

// --- Instagram Automation ---
async function automateInstagram(
  sendCmd: SendCmd,
  wait: Wait,
  params: { videoUrl: string; title: string; description: string; tags: string[]; email: string; password: string }
): Promise<{ url?: string; message: string }> {
  console.log('[Instagram] Navigating to Instagram...');
  await navigateTo(sendCmd, wait, 'https://www.instagram.com/');
  await wait(4000);

  // Dismiss cookie banner
  await evaluateJS(sendCmd, `
    const cookieBtn = Array.from(document.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Allow') || b.textContent?.includes('Accept'));
    if (cookieBtn) cookieBtn.click();
  `);
  await wait(1000);

  const currentUrl = await evaluateJS(sendCmd, 'window.location.href');
  console.log('[Instagram] Current URL:', currentUrl);

  // Check for login
  const hasLoginForm = await evaluateJS(sendCmd, `!!document.querySelector('input[name="username"]')`);
  if (hasLoginForm) {
    if (!params.email || !params.password) {
      throw new Error('Instagram login required but no credentials provided. Add Instagram email and password in Settings.');
    }

    console.log('[Instagram] Logging in...');
    await evaluateJS(sendCmd, `
      const u = document.querySelector('input[name="username"]');
      if (u) { u.focus(); u.value = '${escJS(params.email)}'; u.dispatchEvent(new Event('input', {bubbles: true})); }
    `);
    await wait(500);
    await evaluateJS(sendCmd, `
      const p = document.querySelector('input[name="password"]');
      if (p) { p.focus(); p.value = '${escJS(params.password)}'; p.dispatchEvent(new Event('input', {bubbles: true})); }
    `);
    await wait(500);
    await evaluateJS(sendCmd, `
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    `);
    await wait(8000);

    // Dismiss "Not Now" dialogs
    await evaluateJS(sendCmd, `
      const notNow = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Not Now') || b.textContent?.includes('Not now'));
      if (notNow) notNow.click();
    `);
    await wait(2000);
    await evaluateJS(sendCmd, `
      const notNow = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Not Now') || b.textContent?.includes('Not now'));
      if (notNow) notNow.click();
    `);
    await wait(1000);
  }

  // Click Create / New Post button
  console.log('[Instagram] Clicking New Post...');
  await evaluateJS(sendCmd, `
    const createBtn = document.querySelector('[aria-label="New post"]') ||
      document.querySelector('svg[aria-label="New post"]')?.closest('a, div[role="button"]') ||
      document.querySelector('svg[aria-label="New Post"]')?.closest('a, div[role="button"]');
    if (createBtn) createBtn.click();
  `);
  await wait(3000);

  // Upload file
  console.log('[Instagram] Uploading video...');
  await evaluateJS(sendCmd, `
    (async () => {
      const resp = await fetch('${escJS(params.videoUrl)}');
      const blob = await resp.blob();
      const file = new File([blob], 'video.mp4', { type: 'video/mp4' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('input[type="file"][accept*="video"]') || document.querySelector('input[type="file"]');
      if (input) {
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await wait(10000);

  // Click Next (crop)
  console.log('[Instagram] Clicking Next (crop)...');
  await evaluateJS(sendCmd, `
    const nextBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => b.textContent?.trim() === 'Next');
    if (nextBtn) nextBtn.click();
  `);
  await wait(3000);

  // Click Next (filter)
  console.log('[Instagram] Clicking Next (filter)...');
  await evaluateJS(sendCmd, `
    const nextBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => b.textContent?.trim() === 'Next');
    if (nextBtn) nextBtn.click();
  `);
  await wait(3000);

  // Fill caption
  const caption = `${params.title}\n\n${params.description}\n\n${params.tags.map(t => `#${t}`).join(' ')}`.trim();
  console.log('[Instagram] Filling caption...');
  await evaluateJS(sendCmd, `
    const captionArea = document.querySelector('textarea[aria-label*="caption" i], div[contenteditable="true"][role="textbox"]');
    if (captionArea) {
      captionArea.focus();
      document.execCommand('insertText', false, '${escJS(caption.slice(0, 2200))}');
    }
  `);
  await wait(2000);

  // Click Share
  console.log('[Instagram] Clicking Share...');
  await evaluateJS(sendCmd, `
    const shareBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => b.textContent?.trim() === 'Share');
    if (shareBtn) shareBtn.click();
  `);
  await wait(10000);

  return { message: 'Instagram upload initiated — check your Instagram profile for the new reel.' };
}
