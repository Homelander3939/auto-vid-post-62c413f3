const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'youtube');

async function uploadToYouTube(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);

  // Ensure user data dir exists
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // Navigate to YouTube Studio
    await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60000 });

    // Check if logged in — if we see a sign-in button, we need to login
    const needsLogin = await page.$('a[href*="accounts.google.com"]');
    if (needsLogin) {
      if (!credentials?.email || !credentials?.password) {
        throw new Error('YouTube credentials missing in Settings. Add email and password first.');
      }

      console.log('[YouTube] Logging in...');
      await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle' });

      // Enter email
      await page.fill('input[type="email"]', credentials.email);
      await page.click('#identifierNext');
      await page.waitForTimeout(3000);

      // Enter password
      await page.fill('input[type="password"]', credentials.password);
      await page.click('#passwordNext');
      await page.waitForTimeout(6000);

      // If Google asks for extra verification, ask user via Telegram and keep going after approval/code
      if (page.url().includes('accounts.google.com')) {
        const approval = await requestTelegramApproval({
          telegram: credentials.telegram,
          platform: 'YouTube',
        });

        if (!approval) {
          throw new Error('Google verification required, but no Telegram approval/code was received in time.');
        }

        if (approval.code) {
          await tryFillVerificationCode(page, approval.code);
          await page.waitForTimeout(6000);
        }
      }

      // Navigate back to studio
      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60000 });

      if (page.url().includes('accounts.google.com')) {
        throw new Error('Google verification is still pending. Approve login in Telegram and retry upload.');
      }
    }

    // Click "Create" button then "Upload videos"
    await page.click('#create-icon', { timeout: 10000 });
    await page.waitForTimeout(1000);
    await page.click('#text-item-0', { timeout: 5000 }); // "Upload videos"
    await page.waitForTimeout(2000);

    // Upload file
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(videoPath);
    } else {
      throw new Error('Could not find file input on YouTube Studio');
    }

    await page.waitForTimeout(5000);

    // Fill title
    if (metadata?.title) {
      const titleInput = await page.$('#textbox[aria-label*="title" i], #textbox');
      if (titleInput) {
        await titleInput.click({ clickCount: 3 });
        await titleInput.fill(metadata.title);
      }
    }

    // Fill description
    if (metadata?.description) {
      const descBoxes = await page.$$('#textbox');
      if (descBoxes.length > 1) {
        await descBoxes[1].click();
        await descBoxes[1].fill(metadata.description);
      }
    }

    // Click through steps: Next -> Next -> Next -> Publish
    for (let i = 0; i < 3; i++) {
      await page.click('#next-button', { timeout: 10000 });
      await page.waitForTimeout(2000);
    }

    // Select "Public" visibility
    await page.click('tp-yt-paper-radio-button[name="PUBLIC"]', { timeout: 5000 }).catch(() => {
      console.log('[YouTube] Could not set public visibility, trying alternative...');
    });

    await page.waitForTimeout(1000);

    // Click "Publish" / "Done"
    await page.click('#done-button', { timeout: 10000 });
    await page.waitForTimeout(5000);

    // Try to get the video URL from the success dialog
    let videoUrl = '';
    try {
      const linkEl = await page.$('a.style-scope.ytcp-video-info');
      if (linkEl) {
        videoUrl = await linkEl.getAttribute('href') || '';
        if (videoUrl && !videoUrl.startsWith('http')) {
          videoUrl = `https://studio.youtube.com${videoUrl}`;
        }
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
