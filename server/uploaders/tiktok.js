const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill, analyzePage, waitForStateChange } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok');

// TikTok Studio upload URL (updated — old /creator-center/upload no longer works)
const TIKTOK_UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';
const TIKTOK_UPLOAD_URL_ALT = 'https://www.tiktok.com/creator-center/upload';

async function extractTikTokVideoUrl(page) {
  return page.evaluate(() => {
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
    let fileInput = await page.$('input[type="file"]');
    
    // If no file input found, try to trigger it
    if (!fileInput) {
      console.log('[TikTok] No file input found, trying to trigger upload dialog...');
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, div[role="button"], label');
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('select video') || text.includes('select file') || text.includes('upload')) {
            btn.click();
            return;
          }
        }
      });
      await page.waitForTimeout(2000);
      fileInput = await page.$('input[type="file"]');
    }

    if (!fileInput) throw new Error('TikTok upload page not found. Try logging in manually at https://www.tiktok.com/tiktokstudio/upload first.');

    await fileInput.setInputFiles(videoPath);
    console.log('[TikTok] Video file set, waiting for processing...');
    
    // Wait for video to process - TikTok needs more time
    await page.waitForTimeout(10000);

    // Wait for upload progress to complete
    let uploadWaitAttempts = 0;
    while (uploadWaitAttempts++ < 30) {
      const uploadState = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const isUploading = text.includes('uploading') || text.includes('processing') || text.includes('% uploaded');
        const uploadDone = text.includes('post') || text.includes('caption') || text.includes('description') || text.includes('cover');
        return { isUploading, uploadDone };
      });
      if (uploadState.uploadDone && !uploadState.isUploading) break;
      if (!uploadState.isUploading && uploadWaitAttempts > 3) break;
      console.log(`[TikTok] Video still processing... (attempt ${uploadWaitAttempts})`);
      await page.waitForTimeout(5000);
    }

    // ===== PHASE 3: FILL CAPTION =====
    if (metadata?.title || metadata?.description) {
      const caption = `${metadata.title || ''}${metadata.description ? '\n\n' + metadata.description : ''}${metadata.tags?.length ? '\n\n' + metadata.tags.map(t => '#' + t).join(' ') : ''}`;
      console.log('[TikTok] Setting caption...');
      
      // Try multiple approaches for the caption editor
      const filled = await page.evaluate((text) => {
        // Try contenteditable editors (TikTok Studio uses DraftJS or similar)
        const editors = document.querySelectorAll(
          '[contenteditable="true"], [data-e2e="caption-editor"], .public-DraftEditor-content, ' +
          '[class*="caption"] [contenteditable], [class*="editor"] [contenteditable], ' +
          '.DraftEditor-root [contenteditable]'
        );
        for (const editor of editors) {
          editor.focus();
          editor.click();
          // Clear existing content
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          return true;
        }
        
        // Try textarea
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
      
      if (!filled) {
        // Keyboard-based fallback
        const editorEl = await page.$('[contenteditable="true"]') || await page.$('textarea');
        if (editorEl) {
          await editorEl.click();
          await page.waitForTimeout(300);
          await page.keyboard.press('Control+a');
          await page.keyboard.type(caption.slice(0, 2200), { delay: 10 });
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
      '[class*="post"] button',
      'button[type="submit"]',
    ], 'Post');
    
    if (!postClicked) {
      postClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'post' || text === 'publish') {
            btn.click();
            return true;
          }
        }
        return false;
      });
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
    
    await page.waitForTimeout(10000);

    // ===== PHASE 5: CHECK COMPLETION =====
    let completion = await assessTikTokCompletion(page);
    let videoUrl = await extractTikTokVideoUrl(page);

    // Wait longer if still uploading/processing
    if (!completion.success && !completion.needsHuman) {
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(5000);
        completion = await assessTikTokCompletion(page);
        videoUrl = videoUrl || await extractTikTokVideoUrl(page);
        if (completion.success) break;
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
      completion = await assessTikTokCompletion(page);
      videoUrl = videoUrl || await extractTikTokVideoUrl(page);
    }

    if (!completion.success) {
      throw new Error(`TikTok publish was not confirmed. ${completion.reason}`);
    }

    console.log('[TikTok] Upload complete!');

    // ===== POST-UPLOAD: SCRAPE STATS =====
    let recentStats = [];
    try {
      const { scrapeTikTokStats } = require('./stats-scraper');
      recentStats = await scrapeTikTokStats(page, { maxVideos: 10 });
    } catch (statsErr) {
      console.warn('[TikTok] Stats scraping failed (non-fatal):', statsErr.message);
    }

    await context.close();
    return { url: videoUrl || 'https://www.tiktok.com', recentStats };
  } catch (err) {
    console.error('[TikTok] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToTikTok };
