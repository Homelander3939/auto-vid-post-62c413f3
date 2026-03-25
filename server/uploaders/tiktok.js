const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill, analyzePage, waitForStateChange, runAgentTask } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok');

// TikTok Studio upload URL (updated — old /creator-center/upload no longer works)
const TIKTOK_UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';
const TIKTOK_UPLOAD_URL_ALT = 'https://www.tiktok.com/creator-center/upload';
const MAX_CAPTION_LENGTH = 2200;

async function extractTikTokVideoUrl(page) {
  // First try: look for direct video links in page
  const url = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') || '')
      .filter(Boolean);

    for (const href of candidates) {
      if (href.includes('/video/')) {
        if (href.startsWith('http')) return href;
        return `https://www.tiktok.com${href}`;
      }
    }
    return '';
  }).catch(() => '');

  if (url) return url;

  // Second try: check for video ID in URL or page content
  const pageUrl = page.url();
  const videoMatch = pageUrl.match(/\/video\/(\d+)/);
  if (videoMatch) return pageUrl;

  // Third try: scan for success message with video link or profile link
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const urlMatch = text.match(/tiktok\.com\/@[\w.-]+\/video\/\d+/);
    if (urlMatch) return `https://www.${urlMatch[0]}`;

    // Check for any tiktok profile link (video was posted to this profile)
    const profileLinks = Array.from(document.querySelectorAll('a[href*="tiktok.com/@"]'))
      .map(a => a.getAttribute('href') || '')
      .filter(h => h.includes('/@'));
    if (profileLinks.length > 0) {
      const link = profileLinks[0];
      return link.startsWith('http') ? link : `https://www.tiktok.com${link}`;
    }
    return '';
  }).catch(() => '');
}

async function assessTikTokCompletion(page) {
  const dom = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const success =
      text.includes('posted') ||
      text.includes('your video is being uploaded') ||
      text.includes('your video is being processed') ||
      text.includes('video uploaded') ||
      text.includes('successfully') ||
      text.includes('upload complete') ||
      text.includes('your video has been') ||
      text.includes('published');
    const hardError =
      text.includes('upload failed') ||
      text.includes('couldn\'t upload') ||
      text.includes('try again later');
    return { success, hardError, summary: text.slice(0, 1200) };
  }).catch(() => ({ success: false, hardError: false, summary: '' }));

  if (dom.success) return { success: true, reason: 'TikTok UI shows upload/post completion.' };
  if (dom.hardError) return { success: false, needsHuman: true, reason: 'TikTok UI shows an upload/post error.' };

  try {
    const ai = await analyzePage(page, 'TikTok post-completion check. Decide if upload succeeded/processing, or needs manual help.');
    const state = String(ai?.state || '').toLowerCase();
    if (['success', 'processing', 'uploading'].includes(state)) {
      return { success: true, reason: ai?.description || 'AI detected successful upload processing state.' };
    }
    return {
      success: false,
      needsHuman: Boolean(ai?.needs_human),
      reason: ai?.description || 'No clear TikTok completion signal found.',
    };
  } catch {
    return { success: false, needsHuman: false, reason: 'No clear TikTok completion signal found.' };
  }
}

async function navigateToTikTokUpload(page) {
  // Try new TikTok Studio URL first
  console.log('[TikTok] Navigating to TikTok Studio upload page...');
  try {
    await page.goto(TIKTOK_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const hasFileInput = await page.$('input[type="file"]');
    if (hasFileInput) return true;
    // Check if we landed on the upload page by looking for upload-related elements
    const isUploadPage = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return text.includes('select video') || text.includes('upload') || text.includes('drag');
    });
    if (isUploadPage) return true;
  } catch (e) {
    console.warn('[TikTok] Primary URL failed:', e.message);
  }

  // Fallback to old creator-center URL
  console.log('[TikTok] Trying fallback upload URL...');
  try {
    await page.goto(TIKTOK_UPLOAD_URL_ALT, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    return true;
  } catch (e) {
    console.warn('[TikTok] Fallback URL also failed:', e.message);
  }

  return false;
}

async function dismissExitDialog(page) {
  // TikTok shows a custom modal "Are you sure that you want to exit?" with Exit/Cancel buttons.
  // Always click Cancel to stay on the page and let the upload finish.
  try {
    const dismissed = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      if (text.includes('are you sure') && (text.includes('exit') || text.includes('leave'))) {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          const btnText = (btn.textContent || '').trim().toLowerCase();
          if (btnText === 'cancel' || btnText === 'stay' || btnText === 'keep editing') {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });
    if (dismissed) console.log('[TikTok] Dismissed exit confirmation dialog');
    return dismissed;
  } catch { return false; }
}

async function waitForVideoProcessing(page, maxWaitSeconds = 180) {
  // Wait for TikTok to finish processing the uploaded video file before attempting to post.
  // Checks for "Uploaded" indicator and absence of progress/uploading text.
  console.log('[TikTok] Waiting for video processing to complete...');
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  for (let attempt = 0; attempt < Math.ceil(maxWaitSeconds / 5); attempt++) {
    if (Date.now() - startTime > maxWaitMs) break;

    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const isUploading = text.includes('uploading') || text.includes('% uploaded') || 
                          text.includes('processing video');
      const uploadDone = text.includes('uploaded') && !text.includes('uploading');
      const hasPostBtn = !!(
        document.querySelector('button[data-e2e="post-button"]') ||
        Array.from(document.querySelectorAll('button, div[role="button"]')).find(
          b => /^(post|publish)$/i.test((b.textContent || '').trim())
        )
      );
      const hasCaption = !!(
        document.querySelector('[contenteditable="true"]') ||
        document.querySelector('textarea')
      );
      return { isUploading, uploadDone, hasPostBtn, hasCaption };
    }).catch(() => ({ isUploading: false, uploadDone: false, hasPostBtn: false, hasCaption: false }));

    // Dismiss any exit dialog that may appear
    await dismissExitDialog(page);

    if (state.uploadDone || (state.hasPostBtn && state.hasCaption && !state.isUploading)) {
      console.log(`[TikTok] Video processing complete (${Math.round((Date.now() - startTime) / 1000)}s)`);
      return true;
    }

    if (state.isUploading) {
      console.log(`[TikTok] Video still uploading... (${Math.round((Date.now() - startTime) / 1000)}s)`);
    }

    await page.waitForTimeout(5000);
  }

  console.warn('[TikTok] Video processing wait timed out, proceeding anyway');
  return false;
}

async function waitForPublishConfirmation(page, maxWaitSeconds = 120) {
  // After clicking Post, wait for TikTok to confirm the video is published.
  // This is critical — the old code exited too early, triggering "Are you sure you want to exit?"
  console.log('[TikTok] Waiting for publish confirmation...');
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  for (let attempt = 0; attempt < Math.ceil(maxWaitSeconds / 5); attempt++) {
    if (Date.now() - startTime > maxWaitMs) break;

    // Dismiss any exit dialog that may appear
    await dismissExitDialog(page);

    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const isPublishing = text.includes('posting') || text.includes('publishing') ||
                           text.includes('sharing') || text.includes('uploading to tiktok') ||
                           text.includes('your video is being uploaded to tiktok');
      const isPublished = text.includes('your video has been published') ||
                          text.includes('post published') ||
                          text.includes('uploaded successfully') ||
                          text.includes('your post is now live') ||
                          text.includes('manage your posts');
      // Check if we're back on the upload page (TikTok redirects after successful publish)
      const backToUpload = text.includes('select video to upload') || text.includes('select video');
      // Check for the success checkmark or redirect to manage page
      const url = window.location.href;
      const onManagePage = url.includes('/content') || url.includes('/manage');
      return { isPublishing, isPublished, backToUpload, onManagePage, url };
    }).catch(() => ({ isPublishing: false, isPublished: false, backToUpload: false, onManagePage: false, url: '' }));

    if (state.isPublished || state.backToUpload || state.onManagePage) {
      console.log(`[TikTok] Video published! (${Math.round((Date.now() - startTime) / 1000)}s)`);
      return true;
    }

    if (state.isPublishing) {
      console.log(`[TikTok] Still publishing... (${Math.round((Date.now() - startTime) / 1000)}s)`);
    }

    await page.waitForTimeout(5000);
  }

  console.warn('[TikTok] Publish confirmation timed out');
  return false;
}

async function uploadToTikTok(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[TikTok] Starting upload...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  // Handle native browser beforeunload dialogs (auto-dismiss to stay on page)
  page.on('dialog', async (dialog) => {
    console.log(`[TikTok] Browser dialog: "${dialog.message()}" — dismissing to stay on page`);
    await dialog.dismiss().catch(() => {});
  });

  try {
    // ===== PHASE 1: NAVIGATE TO UPLOAD PAGE =====
    const navigated = await navigateToTikTokUpload(page);
    if (!navigated) throw new Error('Could not navigate to TikTok upload page.');
    await page.waitForTimeout(2000);

    // ===== PHASE 1b: LOGIN IF NEEDED =====
    let loginAttempts = 0;
    while (loginAttempts++ < 15) {
      const url = page.url();

      // Check if we have a file input (means we're logged in and on upload page)
      const hasFileInput = await page.$('input[type="file"]');
      if (hasFileInput) {
        console.log('[TikTok] Logged in, upload page ready');
        break;
      }

      // Check if we're on the upload page without file input (page still loading)
      if ((url.includes('tiktokstudio/upload') || url.includes('creator-center/upload')) && !url.includes('login')) {
        // Wait a bit more for the page to fully render
        await page.waitForTimeout(3000);
        const retryInput = await page.$('input[type="file"]');
        if (retryInput) {
          console.log('[TikTok] Upload page loaded after wait');
          break;
        }
        // Try clicking "Select video" button which might reveal file input
        await page.evaluate(() => {
          const buttons = document.querySelectorAll('button, div[role="button"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase();
            if (text.includes('select') || text.includes('upload') || text.includes('video')) {
              btn.click();
              return;
            }
          }
        });
        await page.waitForTimeout(2000);
        const retryInput2 = await page.$('input[type="file"]');
        if (retryInput2) break;
      }

      // Check for login page
      if (url.includes('login') || url.includes('passport')) {
        const pageState = await page.evaluate(() => {
          const hasEmail = !!document.querySelector('input[name="username"], input[type="email"], input[type="text"][placeholder*="email" i], input[type="text"][placeholder*="phone" i]');
          const hasPassword = !!document.querySelector('input[type="password"]');
          const hasCode = !!document.querySelector('input[type="tel"], input[name*="code" i]');
          return { hasEmail, hasPassword, hasCode };
        });

        // Try to switch to email/password login
        await page.evaluate(() => {
          const links = document.querySelectorAll('a, div[role="link"], span, p');
          for (const link of links) {
            const text = link.textContent?.toLowerCase() || '';
            if (text.includes('email') || text.includes('password') || text.includes('log in with email')) {
              link.click(); return;
            }
          }
        });
        await page.waitForTimeout(1500);

        if (pageState.hasEmail || pageState.hasPassword) {
          console.log('[TikTok] Filling login credentials...');
          await smartFill(page, [
            'input[name="username"]', 'input[type="email"]',
            'input[type="text"][placeholder*="email" i]', 'input[type="text"]',
          ], credentials.email);
          await page.waitForTimeout(500);

          if (pageState.hasPassword) {
            await smartFill(page, ['input[type="password"]'], credentials.password);
            await page.waitForTimeout(500);
            await smartClick(page, ['button[type="submit"]', 'button[data-e2e="submit-button"]'], 'Log in');
            await page.waitForTimeout(5000);
          }
          continue;
        }

        if (pageState.hasCode) {
          console.log('[TikTok] Verification code needed...');
          const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
          const approval = await requestTelegramApproval({
            telegram: credentials.telegram,
            platform: 'TikTok',
            backend: credentials.backend,
            screenshotBuffer,
            customMessage: '🔐 <b>TikTok verification needed</b>\nReply with APPROVED after device confirmation or CODE 123456 if a code is required.',
          });
          if (approval?.code) {
            await tryFillVerificationCode(page, approval.code);
            await page.waitForTimeout(5000);
          }
          continue;
        }
      }

      await page.waitForTimeout(3000);
    }

    // ===== PHASE 2: UPLOAD VIDEO =====
    console.log('[TikTok] Setting video file...');
    let fileUploaded = false;

    // Strategy 1: Direct setInputFiles on existing file input (works for hidden inputs)
    let fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      // Also check all frames (TikTok may embed upload in iframe)
      try {
        for (const frame of page.frames()) {
          fileInput = await frame.$('input[type="file"]').catch(() => null);
          if (fileInput) break;
        }
      } catch (e) {
        console.warn('[TikTok] Frame search for file input failed:', e.message);
      }
    }

    if (fileInput) {
      try {
        await fileInput.setInputFiles(videoPath);
        fileUploaded = true;
        console.log('[TikTok] Video set via direct file input');
      } catch (e) {
        console.warn('[TikTok] Direct setInputFiles failed:', e.message);
      }
    }

    // Strategy 2: Use fileChooser event + click "Select video" button
    if (!fileUploaded) {
      console.log('[TikTok] Trying fileChooser event pattern...');
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          (async () => {
            // Try clicking the Select video button
            const clicked = await smartClick(page, [
              'button:has-text("Select video")',
              'button:has-text("Select file")',
              'button:has-text("Upload")',
              'div[role="button"]:has-text("Select")',
              'label:has-text("Select")',
            ], 'Select video');
            if (!clicked) {
              // DOM-based button click
              await page.evaluate(() => {
                const btns = document.querySelectorAll('button, div[role="button"], label');
                for (const btn of btns) {
                  const t = (btn.textContent || '').toLowerCase();
                  if (t.includes('select video') || t.includes('select file') || t.includes('upload video')) {
                    btn.click();
                    return;
                  }
                }
                // Click the upload area itself
                const area = document.querySelector('[class*="upload"], [class*="Upload"]');
                if (area) area.click();
              });
            }
          })(),
        ]);
        await fileChooser.setFiles(videoPath);
        fileUploaded = true;
        console.log('[TikTok] Video set via fileChooser event');
      } catch (e) {
        console.warn('[TikTok] fileChooser pattern failed:', e.message);
      }
    }

    // Strategy 3: Force-find and make file input accept files
    if (!fileUploaded) {
      console.log('[TikTok] Trying force file input discovery...');
      const discovered = await page.evaluate(() => {
        // Find ANY file input, even deeply hidden ones
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length > 0) {
          // Make it interactable
          inputs[0].style.display = 'block';
          inputs[0].style.opacity = '1';
          inputs[0].style.position = 'fixed';
          inputs[0].style.top = '0';
          inputs[0].style.left = '0';
          inputs[0].style.zIndex = '999999';
          return true;
        }
        return false;
      });
      if (discovered) {
        fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(videoPath);
          fileUploaded = true;
          console.log('[TikTok] Video set via forced file input');
        }
      }
    }

    if (!fileUploaded) throw new Error('TikTok upload failed: could not set video file. Try logging in manually at https://www.tiktok.com/tiktokstudio/upload first.');

    console.log('[TikTok] Video file set, waiting for processing...');
    
    // Wait for video to fully upload and process before proceeding
    await waitForVideoProcessing(page, 180);

    // ===== PHASE 3: FILL CAPTION =====
    if (metadata?.title || metadata?.description) {
      const caption = `${metadata.title || ''}${metadata.description ? '\n\n' + metadata.description : ''}${metadata.tags?.length ? '\n\n' + metadata.tags.map(t => '#' + t).join(' ') : ''}`;
      console.log('[TikTok] Setting caption...');
      
      let captionFilled = false;

      // Strategy 1: Find the caption editor and use keyboard approach (most reliable)
      const editorSelectors = [
        '[contenteditable="true"][data-text]',
        '[data-e2e="caption-editor"] [contenteditable="true"]',
        '.public-DraftEditor-content[contenteditable="true"]',
        '[class*="caption"] [contenteditable="true"]',
        '[class*="editor"] [contenteditable="true"]',
        '.DraftEditor-root [contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea',
      ];

      for (const sel of editorSelectors) {
        if (captionFilled) break;
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;

          await el.click();
          await page.waitForTimeout(300);
          // Select all existing text and replace
          await page.keyboard.press('Control+a');
          await page.waitForTimeout(100);
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(100);
          await page.keyboard.type(caption.slice(0, MAX_CAPTION_LENGTH), { delay: 5 });
          captionFilled = true;
          console.log(`[TikTok] Caption filled via ${sel}`);
        } catch {}
      }

      // Strategy 2: DOM-based execCommand (may work for some DraftJS editors)
      if (!captionFilled) {
        captionFilled = await page.evaluate((text) => {
          const editors = document.querySelectorAll('[contenteditable="true"]');
          for (const editor of editors) {
            if (editor.offsetHeight === 0) continue;
            editor.focus();
            editor.click();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
            return true;
          }
          const textareas = document.querySelectorAll('textarea');
          for (const ta of textareas) {
            if (ta.offsetHeight > 0) {
              ta.focus();
              ta.value = text;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        }, caption);
      }
      
      if (!captionFilled) {
        console.warn('[TikTok] Could not fill caption with standard methods, trying agent...');
        try {
          await runAgentTask(page, `Fill the caption/description field with: "${caption.slice(0, 300)}"`, { maxSteps: 5, stepDelayMs: 500 });
        } catch (e) {
          console.warn('[TikTok] Agent caption fill failed:', e.message);
        }
      }
    }
    await page.waitForTimeout(2000);

    // ===== PHASE 4: POST =====
    console.log('[TikTok] Posting...');
    
    // Try multiple strategies to find and click the Post button
    let postClicked = await smartClick(page, [
      'button[data-e2e="post-button"]',
      'button:has-text("Post")',
      'button:has-text("Publish")',
      '[class*="post"] button',
      'button[type="submit"]',
    ], 'Post');
    
    if (!postClicked) {
      postClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'post' || text === 'publish' || text === 'upload') {
            btn.click();
            return true;
          }
        }
        return false;
      });
    }

    // Agent fallback: use LLM to find and click the Post button
    if (!postClicked) {
      console.log('[TikTok] Standard Post button not found, trying agent...');
      try {
        const agentResult = await runAgentTask(page, 
          'Find and click the Post or Publish button to publish this TikTok video. Look for a prominent button at the bottom of the form.', 
          { maxSteps: 5, stepDelayMs: 500 });
        postClicked = agentResult.success;
      } catch (e) {
        console.warn('[TikTok] Agent post-click failed:', e.message);
      }
    }
    
    if (!postClicked) {
      console.warn('[TikTok] Could not find Post button, requesting human help...');
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      await requestTelegramApproval({
        telegram: credentials.telegram,
        platform: 'TikTok',
        backend: credentials.backend,
        screenshotBuffer,
        screenshotCaption: '📸 <b>TikTok upload ready</b> — click Post button and reply APPROVED',
        customMessage: '🚧 <b>TikTok uploader needs help</b>\nPlease click the Post/Publish button and reply APPROVED.',
      });
    }
    
    // Wait for the publish to fully complete — this is critical to avoid the "exit" dialog
    await waitForPublishConfirmation(page, 120);

    // ===== PHASE 5: CHECK COMPLETION =====
    let completion = await assessTikTokCompletion(page);
    let videoUrl = await extractTikTokVideoUrl(page);

    // Wait longer if still uploading/processing
    if (!completion.success && !completion.needsHuman) {
      for (let i = 0; i < 12; i++) {
        await dismissExitDialog(page);
        await page.waitForTimeout(5000);
        completion = await assessTikTokCompletion(page);
        videoUrl = videoUrl || await extractTikTokVideoUrl(page);
        if (completion.success) break;
      }
    }

    // If still no URL, try navigating to the profile to get the latest video URL
    if (!videoUrl || videoUrl === 'https://www.tiktok.com') {
      try {
        // Navigate to TikTok profile/manage page to find the published video
        await page.goto('https://www.tiktok.com/tiktokstudio/content', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        videoUrl = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            if (href.includes('/video/')) {
              return href.startsWith('http') ? href : `https://www.tiktok.com${href}`;
            }
          }
          return '';
        }).catch(() => '');
        if (videoUrl) console.log(`[TikTok] Found published video URL from content page: ${videoUrl}`);
      } catch (e) {
        console.warn('[TikTok] Could not navigate to content page for URL:', e.message);
      }
    }

    if (!completion.success && completion.needsHuman) {
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      await requestTelegramApproval({
        telegram: credentials.telegram,
        platform: 'TikTok',
        backend: credentials.backend,
        screenshotBuffer,
        screenshotCaption: '📸 <b>TikTok obstacle screen</b> — reply APPROVED after you resolve the step',
        customMessage: `🚧 <b>TikTok uploader needs your help</b>\n${completion.reason}\n\nResolve the on-screen step and reply APPROVED.`,
      });

      await page.waitForTimeout(8000);
      await dismissExitDialog(page);
      completion = await assessTikTokCompletion(page);
      videoUrl = videoUrl || await extractTikTokVideoUrl(page);
    }

    if (!completion.success) {
      throw new Error(`TikTok publish was not confirmed. ${completion.reason}`);
    }

    console.log(`[TikTok] Upload complete! URL: ${videoUrl || '(no URL extracted)'}`);

    // ===== POST-UPLOAD: SCRAPE STATS =====
    let recentStats = [];
    try {
      const { scrapeTikTokStats } = require('./stats-scraper');
      recentStats = await scrapeTikTokStats(page, { maxVideos: 10 });
    } catch (statsErr) {
      console.warn('[TikTok] Stats scraping failed (non-fatal):', statsErr.message);
    }

    // Dismiss any exit dialog before closing
    await dismissExitDialog(page);
    await context.close();
    return { url: videoUrl || 'https://www.tiktok.com', recentStats };
  } catch (err) {
    console.error('[TikTok] Upload failed:', err.message);
    try { await dismissExitDialog(page); } catch {}
    await context.close();
    throw err;
  }
}

module.exports = { uploadToTikTok };
