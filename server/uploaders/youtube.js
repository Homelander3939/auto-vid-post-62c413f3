const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'youtube');

// Try to use Stagehand if available, otherwise fall back to manual Playwright
let Stagehand;
try {
  Stagehand = require('@browserbasehq/stagehand').Stagehand;
} catch {
  Stagehand = null;
}

async function uploadToYouTube(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  if (Stagehand && credentials?.stagehandApiKey) {
    return uploadWithStagehand(videoPath, metadata, credentials);
  }
  return uploadWithPlaywright(videoPath, metadata, credentials);
}

// ========== Stagehand (AI-driven) ==========
async function uploadWithStagehand(videoPath, metadata, credentials) {
  console.log('[YouTube/Stagehand] Starting AI-driven upload...');

  const stagehand = new Stagehand({
    env: 'LOCAL',
    modelName: 'google/gemini-2.5-flash',
    modelClientOptions: {
      apiKey: credentials.stagehandApiKey,
      baseURL: 'https://ai.gateway.lovable.dev/v1',
    },
    headless: false,
    browserbaseSessionCreateParams: {
      projectId: credentials.browserbaseProjectId,
    },
    localBrowserLaunchOptions: {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      userDataDir: USER_DATA_DIR,
    },
  });

  await stagehand.init();
  const page = stagehand.page;

  try {
    // Navigate to YouTube Studio
    await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Check if login is needed
    const needsLogin = await page.evaluate(() => {
      return window.location.href.includes('accounts.google.com') ||
             !!document.querySelector('a[href*="accounts.google.com"]');
    });

    if (needsLogin) {
      if (!credentials?.email || !credentials?.password) {
        throw new Error('YouTube credentials missing. Add email and password in Settings.');
      }

      console.log('[YouTube/Stagehand] Logging in...');
      await stagehand.act('Enter the email address in the email input field: ' + credentials.email);
      await stagehand.act('Click the Next button to proceed');
      await page.waitForTimeout(3000);

      await stagehand.act('Enter the password: ' + credentials.password);
      await stagehand.act('Click the Next button to submit the password');
      await page.waitForTimeout(6000);

      // Check for verification
      const stillOnGoogle = await page.evaluate(() => window.location.href.includes('accounts.google.com'));
      if (stillOnGoogle) {
        console.log('[YouTube/Stagehand] Verification needed...');
        const approval = await requestTelegramApproval({
          telegram: credentials.telegram,
          platform: 'YouTube',
        });

        if (!approval) throw new Error('Google verification required but no Telegram approval received.');
        if (approval.code) {
          await stagehand.act('Enter the verification code: ' + approval.code);
          await stagehand.act('Click verify or next to submit the code');
          await page.waitForTimeout(6000);
        } else {
          await page.waitForTimeout(15000); // Wait for external approval
        }
      }

      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60000 });
    }

    // Upload flow
    await stagehand.act('Click the Create button (camera icon with plus) in the top right area');
    await page.waitForTimeout(1500);
    await stagehand.act('Click "Upload videos" from the dropdown menu');
    await page.waitForTimeout(2000);

    // Set file on input
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(videoPath);
    } else {
      throw new Error('Could not find file input on YouTube Studio');
    }
    await page.waitForTimeout(5000);

    // Fill metadata
    if (metadata?.title) {
      await stagehand.act('Clear the title field and type the title: ' + metadata.title);
    }
    if (metadata?.description) {
      await stagehand.act('Click the description field and type: ' + metadata.description);
    }
    await page.waitForTimeout(1500);

    // Navigate wizard
    await stagehand.act('Click the Next button');
    await page.waitForTimeout(2000);
    await stagehand.act('Click the Next button');
    await page.waitForTimeout(2000);
    await stagehand.act('Click the Next button');
    await page.waitForTimeout(2000);

    // Set public visibility
    await stagehand.act('Select the Public visibility option');
    await page.waitForTimeout(1000);

    // Publish
    await stagehand.act('Click the Publish or Done button');
    await page.waitForTimeout(7000);

    // Extract video URL
    let videoUrl = '';
    try {
      const extracted = await stagehand.extract('Extract the published video URL or link shown on the page');
      videoUrl = extracted?.url || extracted?.text || '';
    } catch {
      videoUrl = '';
    }

    if (!videoUrl) {
      try {
        const linkEl = await page.$('a.style-scope.ytcp-video-info[href*="youtu"]');
        if (linkEl) videoUrl = await linkEl.getAttribute('href') || '';
      } catch {}
    }

    console.log(`[YouTube/Stagehand] Upload complete: ${videoUrl}`);
    await stagehand.close();
    return { url: videoUrl || undefined };
  } catch (err) {
    await stagehand.close();
    throw err;
  }
}

// ========== Playwright Fallback ==========
async function uploadWithPlaywright(videoPath, metadata, credentials) {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60000 });

    const needsLogin = await page.$('a[href*="accounts.google.com"]');
    if (needsLogin) {
      if (!credentials?.email || !credentials?.password) {
        throw new Error('YouTube credentials missing in Settings.');
      }

      await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle' });
      await page.fill('input[type="email"]', credentials.email);
      await page.click('#identifierNext');
      await page.waitForTimeout(3000);
      await page.fill('input[type="password"]', credentials.password);
      await page.click('#passwordNext');
      await page.waitForTimeout(6000);

      if (page.url().includes('accounts.google.com')) {
        const approval = await requestTelegramApproval({ telegram: credentials.telegram, platform: 'YouTube' });
        if (!approval) throw new Error('Google verification required but no Telegram approval received.');
        if (approval.code) {
          await tryFillVerificationCode(page, approval.code);
          await page.waitForTimeout(6000);
        }
      }

      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60000 });
      if (page.url().includes('accounts.google.com')) {
        throw new Error('Still on Google login. Approve in Telegram and retry.');
      }
    }

    await page.click('#create-icon', { timeout: 10000 });
    await page.waitForTimeout(1000);
    await page.click('#text-item-0', { timeout: 5000 });
    await page.waitForTimeout(2000);

    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(videoPath);
    } else {
      throw new Error('Could not find file input on YouTube Studio');
    }

    await page.waitForTimeout(5000);

    if (metadata?.title) {
      const titleInput = await page.$('#textbox[aria-label*="title" i], #textbox');
      if (titleInput) {
        await titleInput.click({ clickCount: 3 });
        await titleInput.fill(metadata.title);
      }
    }

    if (metadata?.description) {
      const descBoxes = await page.$$('#textbox');
      if (descBoxes.length > 1) {
        await descBoxes[1].click();
        await descBoxes[1].fill(metadata.description);
      }
    }

    for (let i = 0; i < 3; i++) {
      await page.click('#next-button', { timeout: 10000 });
      await page.waitForTimeout(2000);
    }

    await page.click('tp-yt-paper-radio-button[name="PUBLIC"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.click('#done-button', { timeout: 10000 });
    await page.waitForTimeout(5000);

    let videoUrl = '';
    try {
      const linkEl = await page.$('a.style-scope.ytcp-video-info');
      if (linkEl) {
        videoUrl = await linkEl.getAttribute('href') || '';
        if (videoUrl && !videoUrl.startsWith('http')) videoUrl = `https://studio.youtube.com${videoUrl}`;
      }
    } catch {}

    console.log(`[YouTube] Upload complete: ${videoUrl}`);
    await context.close();
    return { url: videoUrl };
  } catch (err) {
    await context.close();
    throw err;
  }
}

module.exports = { uploadToYouTube };
