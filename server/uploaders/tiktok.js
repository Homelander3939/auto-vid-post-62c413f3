const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { analyzePage, smartClick, smartFill, waitForStateChange } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok');

async function uploadToTikTok(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[TikTok] Starting smart upload...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // === STEP 1: Navigate to TikTok Creator Center ===
    console.log('[TikTok] Navigating to TikTok Creator Center...');
    await page.goto('https://www.tiktok.com/creator#/upload?scene=creator_center', {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await page.waitForTimeout(3000);

    // === STEP 2: Handle login if needed ===
    let maxAttempts = 12;
    while (maxAttempts-- > 0) {
      const url = page.url().toLowerCase();
      const hasLoginSignals = url.includes('login') || url.includes('signin');
      
      const pageInfo = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return {
          hasLoginForm: !!document.querySelector('input[name="username"], input[placeholder*="email" i], input[placeholder*="phone" i]'),
          hasPasswordInput: !!document.querySelector('input[type="password"]'),
          hasCodeInput: !!document.querySelector('input[type="tel"], input[name*="code" i]'),
          hasFileInput: !!document.querySelector('input[type="file"]'),
          hasLoginButton: !!document.querySelector('[data-e2e="top-login-button"], button:has-text("Log in")'),
          bodyText: text.substring(0, 1000),
        };
      });

      // If we can see file input or upload area, we're logged in
      if (pageInfo.hasFileInput || url.includes('/upload') || url.includes('/creator')) {
        if (!hasLoginSignals && !pageInfo.hasLoginButton) {
          console.log('[TikTok] Successfully on upload page');
          break;
        }
      }

      if (pageInfo.hasLoginButton && !pageInfo.hasLoginForm) {
        console.log('[TikTok] Clicking login button...');
        await smartClick(page, ['[data-e2e="top-login-button"]'], 'Log in');
        await page.waitForTimeout(3000);
        continue;
      }

      if (pageInfo.hasLoginForm || hasLoginSignals) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('TikTok credentials not configured in Settings');
        }

        console.log('[TikTok] Filling login credentials...');
        // Click email/username login option
        await smartClick(page, [
          'div[data-e2e="channel-item"]:has-text("email")',
          'a:has-text("email")',
          'div:has-text("Use phone / email")',
        ], 'email');
        await page.waitForTimeout(1500);
        
        // Sometimes need to click "Log in with email or username"
        await smartClick(page, ['a:has-text("Log in with email or username")'], 'Log in with email');
        await page.waitForTimeout(1000);

        await smartFill(page, [
          'input[name="username"]',
          'input[placeholder*="email" i]',
          'input[placeholder*="username" i]',
          'input[type="text"]',
        ], credentials.email);

        await smartFill(page, ['input[type="password"]'], credentials.password);
        await page.waitForTimeout(500);

        await smartClick(page, ['button[type="submit"]', 'button[data-e2e="login-button"]'], 'Log in');
        await page.waitForTimeout(8000);
        continue;
      }

      if (pageInfo.hasCodeInput || pageInfo.bodyText.includes('verification') || pageInfo.bodyText.includes('security check')) {
        console.log('[TikTok] Verification needed...');
        const approval = await requestTelegramApproval({ telegram: credentials.telegram, platform: 'TikTok' });
        if (!approval) throw new Error('TikTok verification required but no approval received.');
        if (approval.code) {
          await tryFillVerificationCode(page, approval.code);
          await page.waitForTimeout(5000);
        }
        continue;
      }

      await page.waitForTimeout(3000);
    }

    // Navigate to upload page if needed
    if (!page.url().includes('/upload') && !page.url().includes('/creator')) {
      await page.goto('https://www.tiktok.com/creator#/upload?scene=creator_center', {
        waitUntil: 'networkidle', timeout: 30000,
      });
      await page.waitForTimeout(3000);
    }

    // === STEP 3: Upload video file ===
    console.log('[TikTok] Uploading video file...');
    let fileInput = await page.$('input[type="file"][accept*="video"]') || await page.$('input[type="file"]');
    
    if (!fileInput) {
      // Try iframe
      try {
        const iframe = page.frameLocator('iframe');
        const iframeInput = iframe.locator('input[type="file"]').first();
        await iframeInput.setInputFiles(videoPath);
        console.log('[TikTok] File set via iframe');
      } catch {
        throw new Error('Could not find file input on TikTok upload page');
      }
    } else {
      await fileInput.setInputFiles(videoPath);
    }
    await page.waitForTimeout(10000);

    // === STEP 4: Fill caption ===
    console.log('[TikTok] Filling caption...');
    const caption = (metadata?.title || '') + (metadata?.description ? '\n' + metadata.description : '');
    const tags = (metadata?.tags || []).map(t => ` #${t}`).join('');
    const fullCaption = (caption + tags).slice(0, 2200);

    const captionEditor = await page.$('[contenteditable="true"], .DraftEditor-root [contenteditable], div[data-e2e="upload-caption-input"]');
    if (captionEditor) {
      await captionEditor.click();
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(200);
      await page.keyboard.type(fullCaption, { delay: 15 });
    }
    await page.waitForTimeout(3000);

    // === STEP 5: Post ===
    console.log('[TikTok] Clicking Post...');
    await smartClick(page, [
      'button[data-e2e="upload-btn"]',
      'button:has-text("Post")',
      'div[data-e2e="upload-btn"]',
    ], 'Post');
    await page.waitForTimeout(12000);

    console.log('[TikTok] Upload complete!');
    await context.close();
    return { url: 'https://www.tiktok.com/@' + (credentials.email || 'user') };
  } catch (err) {
    console.error('[TikTok] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToTikTok };
