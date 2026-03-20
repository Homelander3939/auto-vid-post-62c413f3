const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { analyzePage, smartClick, smartFill, waitForStateChange, takeScreenshot } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'youtube');

async function uploadToYouTube(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[YouTube] Starting smart upload...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // === STEP 1: Navigate to YouTube Studio ===
    console.log('[YouTube] Navigating to YouTube Studio...');
    await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // === STEP 2: Handle login if needed ===
    let maxLoginAttempts = 15;
    while (maxLoginAttempts-- > 0) {
      const state = await analyzePage(page, 'Trying to log into YouTube Studio to upload a video');
      console.log(`[YouTube] State: ${state.state} — ${state.description}`);

      if (state.state === 'logged_in' || state.state === 'upload_page') {
        console.log('[YouTube] Successfully on YouTube Studio dashboard');
        break;
      }

      if (state.state === 'login_email') {
        if (!credentials?.email) throw new Error('YouTube email not configured in Settings');
        console.log('[YouTube] Entering email...');
        const filled = await smartFill(page, [
          'input[type="email"]',
          'input#identifierId',
          'input[name="identifier"]',
        ], credentials.email);
        if (filled) {
          await page.waitForTimeout(500);
          await smartClick(page, ['#identifierNext button', '#identifierNext'], 'Next');
          await page.waitForTimeout(4000);
        }
        continue;
      }

      if (state.state === 'login_password') {
        if (!credentials?.password) throw new Error('YouTube password not configured in Settings');
        console.log('[YouTube] Entering password...');
        const filled = await smartFill(page, [
          'input[type="password"]:not([aria-hidden="true"])',
          'input[name="Passwd"]',
        ], credentials.password);
        if (filled) {
          await page.waitForTimeout(500);
          await smartClick(page, ['#passwordNext button', '#passwordNext'], 'Next');
          await page.waitForTimeout(5000);
        }
        continue;
      }

      if (state.state === 'verification_2fa' || state.state === 'verification_code') {
        console.log('[YouTube] Verification needed — requesting Telegram approval...');
        const approval = await requestTelegramApproval({
          telegram: credentials.telegram,
          platform: 'YouTube',
        });
        if (!approval) throw new Error('YouTube verification required but no approval received within timeout.');
        if (approval.code) {
          await tryFillVerificationCode(page, approval.code);
          await page.waitForTimeout(6000);
        } else {
          // User approved on phone, wait for redirect
          await page.waitForTimeout(15000);
        }
        continue;
      }

      // Unknown state — wait and retry
      await page.waitForTimeout(3000);
    }

    // Verify we're on YouTube Studio
    const finalUrl = page.url();
    if (finalUrl.includes('accounts.google.com')) {
      throw new Error('Login failed — still on Google accounts page. Check credentials or approve verification.');
    }

    // If URL isn't studio, navigate there
    if (!finalUrl.includes('studio.youtube.com')) {
      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // === STEP 3: Click Create → Upload videos ===
    console.log('[YouTube] Clicking Create button...');
    
    // Try multiple selectors for the Create button
    let createClicked = await smartClick(page, [
      '#create-icon',
      'ytcp-button#create-icon',
      '[aria-label="Create"]',
      'button[aria-label="Create"]',
    ], 'Create');
    
    if (!createClicked) {
      // Try via JS injection
      await page.evaluate(() => {
        const btn = document.querySelector('#create-icon') || 
                    document.querySelector('[aria-label="Create"]') ||
                    document.querySelector('ytcp-button#create-icon');
        if (btn) btn.click();
      });
      createClicked = true;
    }
    await page.waitForTimeout(2000);

    // Click "Upload videos" from dropdown
    console.log('[YouTube] Clicking Upload videos...');
    let uploadClicked = await smartClick(page, [
      '#text-item-0',
      'tp-yt-paper-item:first-child',
      '[test-id="upload-icon"]',
    ], 'Upload videos');

    if (!uploadClicked) {
      await page.evaluate(() => {
        const items = document.querySelectorAll('tp-yt-paper-item, ytcp-text-menu a, [role="menuitem"]');
        for (const item of items) {
          if (item.textContent?.toLowerCase().includes('upload video')) {
            item.click();
            return;
          }
        }
        // Fallback: click first menu item
        if (items.length > 0) items[0].click();
      });
    }
    await page.waitForTimeout(3000);

    // === STEP 4: Set video file ===
    console.log('[YouTube] Setting video file...');
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      // Try to find hidden file input
      const hiddenInput = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="file"]');
        return inputs.length;
      });
      if (hiddenInput === 0) {
        throw new Error('No file input found on YouTube Studio upload page. The Create menu may not have opened correctly.');
      }
    }
    
    await (fileInput || await page.$('input[type="file"]')).setInputFiles(videoPath);
    console.log('[YouTube] Video file set, waiting for upload to begin...');
    await page.waitForTimeout(8000);

    // === STEP 5: Fill title and description ===
    if (metadata?.title) {
      console.log('[YouTube] Setting title...');
      const titleBox = await page.$('#textbox[aria-label*="title" i]') || await page.$('#textbox');
      if (titleBox) {
        await titleBox.click({ clickCount: 3 });
        await page.waitForTimeout(200);
        await page.keyboard.press('Control+a');
        await page.keyboard.type(metadata.title, { delay: 20 });
      }
    }

    if (metadata?.description) {
      console.log('[YouTube] Setting description...');
      const textboxes = await page.$$('#textbox');
      if (textboxes.length > 1) {
        await textboxes[1].click();
        await page.waitForTimeout(200);
        await page.keyboard.type(metadata.description, { delay: 20 });
      }
    }
    await page.waitForTimeout(2000);

    // === STEP 6: Click through the wizard (Next × 3) ===
    console.log('[YouTube] Navigating upload wizard...');
    for (let i = 0; i < 3; i++) {
      const clicked = await smartClick(page, ['#next-button', '#step-badge-' + (i + 1)], 'Next');
      if (!clicked) {
        await page.evaluate(() => {
          const btn = document.querySelector('#next-button');
          if (btn) btn.click();
        });
      }
      await page.waitForTimeout(2500);
    }

    // === STEP 7: Set visibility to Public ===
    console.log('[YouTube] Setting visibility to Public...');
    await smartClick(page, [
      'tp-yt-paper-radio-button[name="PUBLIC"]',
      '#radioLabel:has-text("Public")',
      '[name="PUBLIC"]',
    ], 'Public');
    await page.waitForTimeout(1500);

    // === STEP 8: Publish ===
    console.log('[YouTube] Publishing...');
    await smartClick(page, ['#done-button', '#publish-button'], 'Publish');
    await page.waitForTimeout(8000);

    // === STEP 9: Extract video URL ===
    let videoUrl = '';
    try {
      videoUrl = await page.evaluate(() => {
        const link = document.querySelector('a.style-scope.ytcp-video-info[href*="youtu"]') ||
                     document.querySelector('a[href*="youtu.be"]') ||
                     document.querySelector('a[href*="youtube.com/watch"]') ||
                     document.querySelector('.video-url-fadeable a');
        return link?.href || link?.textContent || '';
      });
    } catch {}

    console.log(`[YouTube] Upload complete! URL: ${videoUrl || 'not captured'}`);
    await context.close();
    return { url: videoUrl || undefined };
  } catch (err) {
    console.error('[YouTube] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToYouTube };
