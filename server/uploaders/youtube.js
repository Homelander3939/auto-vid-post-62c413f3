const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { analyzePage, smartClick, smartFill, takeScreenshot, waitForStateChange } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'youtube');

async function uploadToYouTube(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[YouTube] Starting upload...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // ===== PHASE 1: LOGIN =====
    await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    let loginAttempts = 0;
    const MAX_LOGIN_ATTEMPTS = 20;

    while (loginAttempts++ < MAX_LOGIN_ATTEMPTS) {
      const url = page.url();

      // Success: we're on YouTube Studio
      if (url.includes('studio.youtube.com') && !url.includes('accounts.google.com')) {
        console.log('[YouTube] Logged in to YouTube Studio');
        break;
      }

      // Google login flow
      if (url.includes('accounts.google.com')) {
        // Check what's on the page
        const pageState = await page.evaluate(() => {
          const body = (document.body?.innerText || '').toLowerCase();
          const hasEmail = !!document.querySelector('input[type="email"], #identifierId');
          const hasPassword = !!document.querySelector('input[type="password"]:not([aria-hidden="true"])');
          const hasCodeInput = !!document.querySelector('input[type="tel"], input[name*="code" i], input[autocomplete="one-time-code"]');
          const hasPhonePrompt = body.includes('check your phone') || body.includes('tap yes') || body.includes('confirm it');
          const hasNumberMatch = body.includes('try another way') || body.includes('choose a number') || body.includes('match the number');
          // Look for the number to tap on phone
          const bigNumbers = document.querySelectorAll('[data-number], .vdE7Oc, .eKnrVb');
          let matchNumber = '';
          bigNumbers.forEach(el => { if (el.textContent?.trim().match(/^\d{1,3}$/)) matchNumber = el.textContent.trim(); });
          // Also check for prominent number display
          if (!matchNumber) {
            const allText = body;
            const numMatch = allText.match(/tap (\d{1,3})/i) || allText.match(/number:\s*(\d{1,3})/i);
            if (numMatch) matchNumber = numMatch[1];
          }
          return { hasEmail, hasPassword, hasCodeInput, hasPhonePrompt, hasNumberMatch, matchNumber, bodySnippet: body.substring(0, 500) };
        });

        if (pageState.hasEmail && !pageState.hasPassword) {
          // Email entry
          console.log('[YouTube] Entering email...');
          const filled = await smartFill(page, ['#identifierId', 'input[type="email"]', 'input[name="identifier"]'], credentials.email);
          if (filled) {
            await page.waitForTimeout(500);
            await smartClick(page, ['#identifierNext button', '#identifierNext', 'button:has-text("Next")'], 'Next');
            await page.waitForTimeout(4000);
          }
          continue;
        }

        if (pageState.hasPassword) {
          // Password entry
          console.log('[YouTube] Entering password...');
          const filled = await smartFill(page, [
            'input[type="password"]:not([aria-hidden="true"])',
            'input[name="Passwd"]',
          ], credentials.password);
          if (filled) {
            await page.waitForTimeout(500);
            await smartClick(page, ['#passwordNext button', '#passwordNext', 'button:has-text("Next")'], 'Next');
            await page.waitForTimeout(5000);
          }
          continue;
        }

        // 2FA / Verification — only request Telegram help here
        if (pageState.hasCodeInput || pageState.hasPhonePrompt || pageState.hasNumberMatch) {
          console.log('[YouTube] Verification detected — requesting Telegram help...');

          // Take screenshot and send description
          let verificationMessage = `🔐 <b>YouTube verification needed</b>\n`;
          if (pageState.matchNumber) {
            verificationMessage += `Tap number <b>${pageState.matchNumber}</b> on your phone.\nThen reply APPROVED`;
          } else if (pageState.hasPhonePrompt) {
            verificationMessage += `Check your phone and approve the sign-in.\nThen reply APPROVED`;
          } else {
            verificationMessage += `Enter the verification code.\nReply with: CODE 123456`;
          }

          const approval = await requestTelegramApproval({
            telegram: credentials.telegram,
            platform: 'YouTube',
            customMessage: verificationMessage,
          });

          if (!approval) throw new Error('Verification required but no response received. Check Telegram.');
          if (approval.code) {
            await tryFillVerificationCode(page, approval.code);
            await page.waitForTimeout(6000);
          } else {
            // User approved on phone
            await page.waitForTimeout(15000);
          }
          continue;
        }

        // Unknown Google state — wait and retry
        console.log('[YouTube] Waiting on Google auth page...');
        await page.waitForTimeout(3000);
        continue;
      }

      // Not on Google or Studio — wait
      await page.waitForTimeout(3000);
    }

    // Verify login succeeded
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com')) {
      throw new Error('Login failed — still on Google accounts page. Check credentials or approve verification via Telegram.');
    }

    // Navigate to studio if needed
    if (!currentUrl.includes('studio.youtube.com')) {
      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // ===== PHASE 2: OPEN UPLOAD DIALOG =====
    console.log('[YouTube] Opening upload dialog...');

    // Try clicking Create button
    let createClicked = await smartClick(page, [
      '#create-icon',
      'ytcp-button#create-icon',
      '[aria-label="Create"]',
      'button[aria-label="Create"]',
    ], 'Create');

    if (!createClicked) {
      // Try JS click
      await page.evaluate(() => {
        const btn = document.querySelector('#create-icon') ||
                    document.querySelector('[aria-label="Create"]') ||
                    document.querySelector('ytcp-button#create-icon');
        if (btn) { btn.click(); return true; }
        return false;
      });
    }
    await page.waitForTimeout(2000);

    // Click "Upload videos" from dropdown
    let uploadMenuClicked = await smartClick(page, [
      '#text-item-0',
      'tp-yt-paper-item:first-child',
      '[test-id="upload-icon"]',
    ], 'Upload video');

    if (!uploadMenuClicked) {
      await page.evaluate(() => {
        const items = document.querySelectorAll('tp-yt-paper-item, ytcp-text-menu a, [role="menuitem"], [role="option"]');
        for (const item of items) {
          if (item.textContent?.toLowerCase().includes('upload video')) { item.click(); return; }
        }
        if (items.length > 0) items[0].click();
      });
    }
    await page.waitForTimeout(3000);

    // Verify upload dialog opened — check for file input
    let fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      // Maybe Create menu didn't open. Try direct URL approach
      console.log('[YouTube] Upload dialog not found, trying direct navigation...');
      await page.goto('https://studio.youtube.com/channel/UC/videos/upload?d=ud', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      fileInput = await page.$('input[type="file"]');
    }

    if (!fileInput) {
      // Last resort: try clicking Create again with a different strategy
      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      // Click using page coordinates — Create button is usually top-right area
      await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('button, ytcp-button'));
        for (const btn of allButtons) {
          const text = btn.textContent?.toLowerCase() || '';
          const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
          if (text.includes('create') || label.includes('create') || text.includes('upload')) {
            btn.click();
            break;
          }
        }
      });
      await page.waitForTimeout(2000);
      // Now try to find Upload videos option
      await page.evaluate(() => {
        const items = document.querySelectorAll('tp-yt-paper-item, [role="menuitem"], [role="option"], a');
        for (const item of items) {
          if (item.textContent?.toLowerCase().includes('upload')) { item.click(); return; }
        }
      });
      await page.waitForTimeout(3000);
      fileInput = await page.$('input[type="file"]');
    }

    if (!fileInput) {
      throw new Error('Could not open YouTube upload dialog. Try logging in manually first at https://studio.youtube.com');
    }

    // ===== PHASE 3: UPLOAD VIDEO FILE =====
    console.log('[YouTube] Setting video file...');
    await fileInput.setInputFiles(videoPath);
    console.log('[YouTube] Video file set, waiting for processing...');
    await page.waitForTimeout(8000);

    // ===== PHASE 4: FILL TITLE & DESCRIPTION =====
    if (metadata?.title) {
      console.log('[YouTube] Setting title...');
      // YouTube Studio uses a contenteditable div with id="textbox"
      const titleFilled = await page.evaluate((title) => {
        // Find the title textbox (first #textbox element)
        const textboxes = document.querySelectorAll('#textbox');
        const titleBox = textboxes[0];
        if (!titleBox) return false;
        titleBox.focus();
        titleBox.click();
        // Select all and replace
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, title);
        return true;
      }, metadata.title);

      if (!titleFilled) {
        // Fallback: try keyboard approach
        const titleBox = await page.$('#textbox');
        if (titleBox) {
          await titleBox.click({ clickCount: 3 });
          await page.waitForTimeout(200);
          await page.keyboard.press('Control+a');
          await page.keyboard.type(metadata.title, { delay: 20 });
        }
      }
    }

    if (metadata?.description) {
      console.log('[YouTube] Setting description...');
      await page.evaluate((desc) => {
        const textboxes = document.querySelectorAll('#textbox');
        if (textboxes.length > 1) {
          const descBox = textboxes[1];
          descBox.focus();
          descBox.click();
          document.execCommand('insertText', false, desc);
          return true;
        }
        return false;
      }, metadata.description);
    }
    await page.waitForTimeout(2000);

    // ===== PHASE 5: NAVIGATE WIZARD (Next × 3) =====
    console.log('[YouTube] Navigating upload wizard...');
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1500);
      const clicked = await smartClick(page, ['#next-button', '#step-badge-' + (i + 1)], 'Next');
      if (!clicked) {
        await page.evaluate(() => {
          const btn = document.querySelector('#next-button');
          if (btn) btn.click();
        });
      }
      await page.waitForTimeout(2000);
    }

    // ===== PHASE 6: SET VISIBILITY TO PUBLIC =====
    console.log('[YouTube] Setting visibility to Public...');
    await smartClick(page, [
      'tp-yt-paper-radio-button[name="PUBLIC"]',
      '#radioLabel:has-text("Public")',
      '[name="PUBLIC"]',
    ], 'Public');

    // Also try clicking by evaluating
    await page.evaluate(() => {
      const radios = document.querySelectorAll('tp-yt-paper-radio-button, [role="radio"]');
      for (const r of radios) {
        if (r.textContent?.toLowerCase().includes('public') && !r.textContent?.toLowerCase().includes('unlisted')) {
          r.click();
          break;
        }
      }
    });
    await page.waitForTimeout(1500);

    // ===== PHASE 7: PUBLISH =====
    console.log('[YouTube] Publishing...');
    await smartClick(page, ['#done-button', '#publish-button'], 'Publish');

    // Also try JS click
    await page.evaluate(() => {
      const btn = document.querySelector('#done-button') || document.querySelector('#publish-button');
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);

    // ===== PHASE 8: EXTRACT VIDEO URL =====
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
