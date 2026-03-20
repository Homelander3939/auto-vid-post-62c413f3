const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram');

async function uploadToInstagram(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[Instagram] Starting upload...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // ===== PHASE 1: LOGIN =====
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie dialog
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('allow') || text.includes('accept') || text.includes('decline optional')) { btn.click(); break; }
      }
    });
    await page.waitForTimeout(1000);

    let loginAttempts = 0;
    while (loginAttempts++ < 15) {
      const isLoggedIn = await page.evaluate(() => {
        return !!(document.querySelector('[aria-label="New post"]') ||
                  document.querySelector('svg[aria-label="New post"]') ||
                  document.querySelector('[aria-label="Home"]') ||
                  document.querySelector('a[href="/direct/inbox/"]'));
      });
      if (isLoggedIn) { console.log('[Instagram] Logged in'); break; }

      const url = page.url();
      if (url.includes('login') || url.includes('accounts')) {
        const pageState = await page.evaluate(() => ({
          hasUsername: !!document.querySelector('input[name="username"]'),
          hasPassword: !!document.querySelector('input[name="password"]'),
          hasCode: !!document.querySelector('input[name="verificationCode"], input[name="security_code"]'),
        }));

        if (pageState.hasUsername && pageState.hasPassword) {
          console.log('[Instagram] Filling login...');
          await smartFill(page, ['input[name="username"]'], credentials.email);
          await page.waitForTimeout(300);
          await smartFill(page, ['input[name="password"]'], credentials.password);
          await page.waitForTimeout(300);
          await smartClick(page, ['button[type="submit"]'], 'Log In');
          await page.waitForTimeout(5000);

          // Dismiss popups
          for (let i = 0; i < 2; i++) {
            await page.evaluate(() => {
              const buttons = document.querySelectorAll('button');
              for (const btn of buttons) {
                if (btn.textContent?.toLowerCase().includes('not now')) { btn.click(); break; }
              }
            });
            await page.waitForTimeout(1500);
          }
          continue;
        }

        if (pageState.hasCode) {
          console.log('[Instagram] Verification code needed...');
          const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
          const approval = await requestTelegramApproval({
            telegram: credentials.telegram,
            platform: 'Instagram',
            backend: credentials.backend,
            screenshotBuffer,
            customMessage: '🔐 <b>Instagram verification needed</b>\nReply with APPROVED after device confirmation or CODE 123456 if a code is required.',
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

    const loggedIn = await page.evaluate(() => {
      return !!(document.querySelector('[aria-label="New post"]') ||
                document.querySelector('svg[aria-label="New post"]') ||
                document.querySelector('[aria-label="Home"]'));
    });
    if (!loggedIn) throw new Error('Instagram login failed. Try logging in manually first.');

    // ===== PHASE 2: CREATE NEW POST =====
    console.log('[Instagram] Creating new post...');
    let newPostClicked = await smartClick(page, ['[aria-label="New post"]', 'svg[aria-label="New post"]'], 'New post');
    if (!newPostClicked) {
      await page.evaluate(() => {
        const svgs = document.querySelectorAll('svg[aria-label="New post"]');
        for (const svg of svgs) {
          const parent = svg.closest('a, button, div[role="button"]');
          if (parent) { parent.click(); return; }
        }
      });
    }
    await page.waitForTimeout(3000);

    // ===== PHASE 3: SELECT VIDEO FILE =====
    console.log('[Instagram] Setting video file...');
    let fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      await smartClick(page, ['button:has-text("Select from computer")'], 'Select from computer');
      await page.waitForTimeout(2000);
      fileInput = await page.$('input[type="file"]');
    }
    if (!fileInput) throw new Error('Instagram upload dialog not found.');

    await fileInput.setInputFiles(videoPath);
    await page.waitForTimeout(5000);

    // Click through crop/adjust screens
    for (let i = 0; i < 3; i++) {
      const clicked = await smartClick(page, ['button:has-text("Next")', '[aria-label="Next"]'], 'Next');
      if (!clicked) break;
      await page.waitForTimeout(2000);
    }

    // ===== PHASE 4: ADD CAPTION =====
    if (metadata?.title || metadata?.description) {
      const caption = `${metadata.title || ''}\n\n${metadata.description || ''}\n\n${(metadata.tags || []).map(t => '#' + t).join(' ')}`.trim();
      console.log('[Instagram] Setting caption...');
      await page.evaluate((text) => {
        const editors = document.querySelectorAll('[contenteditable="true"], textarea[aria-label*="caption" i], [aria-label="Write a caption..."]');
        for (const editor of editors) {
          editor.focus(); editor.click();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          return true;
        }
      }, caption);
    }
    await page.waitForTimeout(2000);

    // ===== PHASE 5: SHARE =====
    console.log('[Instagram] Sharing...');
    await smartClick(page, ['button:has-text("Share")', '[aria-label="Share"]'], 'Share');
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, div[role="button"]');
      for (const btn of buttons) {
        if (btn.textContent?.trim().toLowerCase() === 'share') { btn.click(); return; }
      }
    });
    await page.waitForTimeout(10000);

    console.log('[Instagram] Upload complete!');
    await context.close();
    return { url: 'https://www.instagram.com' };
  } catch (err) {
    console.error('[Instagram] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToInstagram };
