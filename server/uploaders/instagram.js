const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { analyzePage, smartClick, smartFill } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram');

async function uploadToInstagram(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[Instagram] Starting smart upload...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // === STEP 1: Navigate to Instagram ===
    console.log('[Instagram] Navigating to Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie banner
    await smartClick(page, [
      'button:has-text("Allow essential and optional cookies")',
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept")',
      'button:has-text("Allow")',
    ]).catch(() => {});
    await page.waitForTimeout(1000);

    // === STEP 2: Handle login if needed ===
    let maxAttempts = 12;
    while (maxAttempts-- > 0) {
      const hasLoginForm = await page.$('input[name="username"]');
      const url = page.url().toLowerCase();

      if (!hasLoginForm && !url.includes('login') && !url.includes('challenge')) {
        console.log('[Instagram] Already logged in');
        break;
      }

      if (hasLoginForm) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Instagram credentials not configured in Settings');
        }

        console.log('[Instagram] Filling login credentials...');
        await smartFill(page, ['input[name="username"]'], credentials.email);
        await smartFill(page, ['input[name="password"]'], credentials.password);
        await page.waitForTimeout(500);
        await smartClick(page, ['button[type="submit"]'], 'Log in');
        await page.waitForTimeout(8000);
        continue;
      }

      // Check for verification
      const pageText = await page.evaluate(() => (document.body?.innerText || '').toLowerCase().substring(0, 1500));
      if (pageText.includes('security code') || pageText.includes('confirmation code') ||
          pageText.includes('verify your account') || pageText.includes('suspicious login') ||
          url.includes('challenge')) {
        console.log('[Instagram] Verification needed...');
        const approval = await requestTelegramApproval({ telegram: credentials.telegram, platform: 'Instagram' });
        if (!approval) throw new Error('Instagram verification required but no approval received.');
        if (approval.code) {
          await tryFillVerificationCode(page, approval.code);
          await page.waitForTimeout(5000);
        }
        continue;
      }

      // Dismiss "Save login info" and "Notifications" dialogs
      await smartClick(page, ['button:has-text("Not Now")', 'button:has-text("Not now")']);
      await page.waitForTimeout(2000);
    }

    // Dismiss any remaining "Not Now" dialogs
    for (let i = 0; i < 2; i++) {
      await smartClick(page, ['button:has-text("Not Now")', 'button:has-text("Not now")']).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // === STEP 3: Click Create / New Post ===
    console.log('[Instagram] Opening new post dialog...');
    let createClicked = await smartClick(page, [
      '[aria-label="New post"]',
      'svg[aria-label="New post"]',
      '[aria-label="New Post"]',
      'a[href="/create/style/"]',
      'a[href="/create/select/"]',
    ], 'New post');

    if (!createClicked) {
      // Try by matching the + icon in nav
      await page.evaluate(() => {
        const links = document.querySelectorAll('a, div[role="button"], span[role="link"]');
        for (const el of links) {
          const label = el.getAttribute('aria-label') || el.textContent || '';
          if (label.toLowerCase().includes('new post') || label.toLowerCase().includes('create')) {
            el.click();
            return;
          }
        }
      });
    }
    await page.waitForTimeout(3000);

    // === STEP 4: Upload video file ===
    console.log('[Instagram] Selecting video file...');
    let fileInput = await page.$('input[type="file"][accept*="video"]') || await page.$('input[type="file"]');
    if (!fileInput) {
      // Click "Select from computer" button if visible
      await smartClick(page, ['button:has-text("Select from computer")', 'button:has-text("Select From Computer")']);
      await page.waitForTimeout(1500);
      fileInput = await page.$('input[type="file"]');
    }

    if (!fileInput) throw new Error('Could not find file input on Instagram');
    await fileInput.setInputFiles(videoPath);
    await page.waitForTimeout(8000);

    // Handle "OK" for reel crop dialog if visible
    await smartClick(page, ['button:has-text("OK")']).catch(() => {});
    await page.waitForTimeout(1500);

    // === STEP 5: Click Next (crop → filter → details) ===
    console.log('[Instagram] Navigating post wizard...');
    for (let i = 0; i < 2; i++) {
      await smartClick(page, [
        'button:has-text("Next")',
        'div[role="button"]:has-text("Next")',
      ], 'Next');
      await page.waitForTimeout(2500);
    }

    // === STEP 6: Fill caption ===
    console.log('[Instagram] Filling caption...');
    const caption = (metadata?.title || '') + '\n\n' + (metadata?.description || '');
    const tags = (metadata?.tags || []).map(t => `#${t}`).join(' ');
    const fullCaption = `${caption}\n\n${tags}`.trim().slice(0, 2200);

    const captionInput = await page.$('textarea[aria-label*="caption" i], div[contenteditable="true"][role="textbox"]');
    if (captionInput) {
      await captionInput.click();
      await page.keyboard.type(fullCaption, { delay: 15 });
    }
    await page.waitForTimeout(2000);

    // === STEP 7: Share ===
    console.log('[Instagram] Sharing post...');
    await smartClick(page, [
      'button:has-text("Share")',
      'div[role="button"]:has-text("Share")',
    ], 'Share');
    await page.waitForTimeout(12000);

    console.log('[Instagram] Upload complete!');
    await context.close();
    return { url: 'https://www.instagram.com/' + (credentials.email || 'user') };
  } catch (err) {
    console.error('[Instagram] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToInstagram };
