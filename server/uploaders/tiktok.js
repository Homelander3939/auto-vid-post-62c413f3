const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok');

async function uploadToTikTok(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);

  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto('https://www.tiktok.com/creator#/upload?scene=creator_center', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    await page.waitForTimeout(3000);

    // Check if login is needed
    const loginButton = await page.$('[data-e2e="top-login-button"], button:has-text("Log in")');
    if (loginButton) {
      console.log('[TikTok] Needs login — opening login page');
      await loginButton.click();
      await page.waitForTimeout(2000);

      // Try email/password login
      const emailLogin = await page.$('div[data-e2e="channel-item"]:has-text("email"), a:has-text("email")');
      if (emailLogin) await emailLogin.click();
      await page.waitForTimeout(1000);

      await page.fill('input[name="username"], input[placeholder*="email" i]', credentials.email);
      await page.fill('input[type="password"]', credentials.password);
      await page.click('button[type="submit"], button:has-text("Log in")');
      await page.waitForTimeout(8000);

      // Navigate to upload page
      await page.goto('https://www.tiktok.com/creator#/upload?scene=creator_center', {
        waitUntil: 'networkidle',
        timeout: 60000,
      });
    }

    // Upload the video file
    const fileInput = await page.$('input[type="file"][accept*="video"]');
    if (fileInput) {
      await fileInput.setInputFiles(videoPath);
    } else {
      // Try iframe
      const iframe = page.frameLocator('iframe');
      const iframeInput = await iframe.locator('input[type="file"]').first();
      await iframeInput.setInputFiles(videoPath);
    }

    await page.waitForTimeout(10000);

    // Fill caption
    if (metadata?.title || metadata?.description) {
      const caption = metadata.title + (metadata.description ? '\n' + metadata.description : '');
      const captionEditor = await page.$('[contenteditable="true"], .DraftEditor-root [contenteditable]');
      if (captionEditor) {
        await captionEditor.click();
        await page.keyboard.selectAll();
        await page.keyboard.type(caption.slice(0, 2200)); // TikTok caption limit
      }
    }

    // Add tags as hashtags
    if (metadata?.tags?.length) {
      const captionEditor = await page.$('[contenteditable="true"]');
      if (captionEditor) {
        for (const tag of metadata.tags) {
          await page.keyboard.type(` #${tag}`);
          await page.waitForTimeout(500);
        }
      }
    }

    await page.waitForTimeout(3000);

    // Click post button
    const postButton = await page.$('button:has-text("Post"), button[data-e2e="upload-btn"]');
    if (postButton) {
      await postButton.click();
    }

    await page.waitForTimeout(10000);

    console.log('[TikTok] Upload complete');
    await context.close();

    return { url: 'https://www.tiktok.com/@' + (credentials.email || 'user') };
  } catch (err) {
    await context.close();
    throw err;
  }
}

module.exports = { uploadToTikTok };
