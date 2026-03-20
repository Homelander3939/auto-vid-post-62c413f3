const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok');

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
    // ===== PHASE 1: LOGIN =====
    await page.goto('https://www.tiktok.com/creator-center/upload', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    let loginAttempts = 0;
    while (loginAttempts++ < 15) {
      const url = page.url();

      // Check if we're on the upload page (logged in)
      if (url.includes('creator-center/upload') || url.includes('tiktok.com/upload')) {
        const hasFileInput = await page.$('input[type="file"]');
        if (hasFileInput) {
          console.log('[TikTok] Logged in, upload page ready');
          break;
        }
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
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('TikTok upload page not found. Try logging in manually first.');

    await fileInput.setInputFiles(videoPath);
    await page.waitForTimeout(8000);

    // ===== PHASE 3: FILL CAPTION =====
    if (metadata?.title || metadata?.description) {
      const caption = `${metadata.title || ''}${metadata.description ? '\n\n' + metadata.description : ''}${metadata.tags?.length ? '\n\n' + metadata.tags.map(t => '#' + t).join(' ') : ''}`;
      console.log('[TikTok] Setting caption...');
      const filled = await page.evaluate((text) => {
        const editors = document.querySelectorAll('[contenteditable="true"], [data-e2e="caption-editor"], .public-DraftEditor-content');
        for (const editor of editors) {
          editor.focus(); editor.click();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          return true;
        }
        return false;
      }, caption);
      if (!filled) {
        await smartFill(page, ['textarea[placeholder*="caption" i]', '[data-e2e="caption-editor"]'], caption);
      }
    }
    await page.waitForTimeout(2000);

    // ===== PHASE 4: POST =====
    console.log('[TikTok] Posting...');
    await smartClick(page, ['button[data-e2e="post-button"]', 'button:has-text("Post")'], 'Post');
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.trim().toLowerCase() === 'post') { btn.click(); return; }
      }
    });
    await page.waitForTimeout(10000);

    console.log('[TikTok] Upload complete!');
    await context.close();
    return { url: 'https://www.tiktok.com' };
  } catch (err) {
    console.error('[TikTok] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToTikTok };
