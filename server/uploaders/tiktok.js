const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok');

let Stagehand;
try {
  Stagehand = require('@browserbasehq/stagehand').Stagehand;
} catch {
  Stagehand = null;
}

async function uploadToTikTok(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  if (Stagehand && credentials?.stagehandApiKey) {
    return uploadWithStagehand(videoPath, metadata, credentials);
  }
  return uploadWithPlaywright(videoPath, metadata, credentials);
}

// ========== Stagehand (AI-driven) ==========
async function uploadWithStagehand(videoPath, metadata, credentials) {
  console.log('[TikTok/Stagehand] Starting AI-driven upload...');

  const stagehand = new Stagehand({
    env: 'LOCAL',
    modelName: 'google/gemini-2.5-flash',
    modelClientOptions: {
      apiKey: credentials.stagehandApiKey,
      baseURL: 'https://ai.gateway.lovable.dev/v1',
    },
    headless: false,
    localBrowserLaunchOptions: {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      userDataDir: USER_DATA_DIR,
    },
  });

  await stagehand.init();
  const page = stagehand.page;

  try {
    await page.goto('https://www.tiktok.com/creator#/upload?scene=creator_center', {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await page.waitForTimeout(3000);

    // Check if login needed
    const needsLogin = await page.evaluate(() => {
      const href = window.location.href.toLowerCase();
      return href.includes('login') || href.includes('signin');
    });

    if (needsLogin) {
      if (!credentials?.email || !credentials?.password) {
        throw new Error('TikTok credentials missing. Add email and password in Settings.');
      }

      console.log('[TikTok/Stagehand] Logging in...');
      await stagehand.act('Click on the option to log in with email or username and password');
      await page.waitForTimeout(2000);
      await stagehand.act('Enter the email or username: ' + credentials.email);
      await stagehand.act('Enter the password: ' + credentials.password);
      await stagehand.act('Click the Log in button');
      await page.waitForTimeout(8000);

      const needsVerification = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return text.includes('verification code') || text.includes('security check') || text.includes('verify');
      });

      if (needsVerification) {
        const approval = await requestTelegramApproval({ telegram: credentials.telegram, platform: 'TikTok' });
        if (!approval) throw new Error('TikTok verification required but no Telegram approval received.');
        if (approval.code) {
          await stagehand.act('Enter the verification code: ' + approval.code);
          await stagehand.act('Click verify or submit');
          await page.waitForTimeout(5000);
        }
      }

      await page.goto('https://www.tiktok.com/creator#/upload?scene=creator_center', {
        waitUntil: 'networkidle', timeout: 60000,
      });
    }

    // Upload file
    const fileInput = await page.$('input[type="file"][accept*="video"]') || await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(videoPath);
    } else {
      throw new Error('Could not find file input on TikTok');
    }
    await page.waitForTimeout(10000);

    // Fill caption
    const caption = (metadata?.title || '') + (metadata?.description ? '\n' + metadata.description : '');
    const tags = (metadata?.tags || []).map(t => ` #${t}`).join('');
    await stagehand.act('Click on the caption/description editor and clear it');
    await stagehand.act('Type the caption: ' + (caption + tags).slice(0, 2200));
    await page.waitForTimeout(3000);

    await stagehand.act('Click the Post button to publish the video');
    await page.waitForTimeout(10000);

    console.log('[TikTok/Stagehand] Upload complete');
    await stagehand.close();
    return { url: 'https://www.tiktok.com/@' + (credentials.email || 'user') };
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
    await page.goto('https://www.tiktok.com/creator#/upload?scene=creator_center', {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await page.waitForTimeout(3000);

    const loginButton = await page.$('[data-e2e="top-login-button"], button:has-text("Log in")');
    if (loginButton) {
      if (!credentials?.email || !credentials?.password) {
        throw new Error('TikTok credentials missing in Settings.');
      }

      await loginButton.click();
      await page.waitForTimeout(2000);

      const emailLogin = await page.$('div[data-e2e="channel-item"]:has-text("email"), a:has-text("email")');
      if (emailLogin) await emailLogin.click();
      await page.waitForTimeout(1000);

      await page.fill('input[name="username"], input[placeholder*="email" i]', credentials.email);
      await page.fill('input[type="password"]', credentials.password);
      await page.click('button[type="submit"], button:has-text("Log in")');
      await page.waitForTimeout(8000);

      const needsVerification = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return window.location.href.toLowerCase().includes('login') ||
          text.includes('verification code') || text.includes('security check') || text.includes('verify');
      });

      if (needsVerification) {
        const approval = await requestTelegramApproval({ telegram: credentials.telegram, platform: 'TikTok' });
        if (!approval) throw new Error('TikTok verification required but no approval received.');
        if (approval.code) {
          await tryFillVerificationCode(page, approval.code);
          await page.waitForTimeout(5000);
        }
      }

      await page.goto('https://www.tiktok.com/creator#/upload?scene=creator_center', {
        waitUntil: 'networkidle', timeout: 60000,
      });
    }

    const fileInput = await page.$('input[type="file"][accept*="video"]');
    if (fileInput) {
      await fileInput.setInputFiles(videoPath);
    } else {
      const iframe = page.frameLocator('iframe');
      const iframeInput = await iframe.locator('input[type="file"]').first();
      await iframeInput.setInputFiles(videoPath);
    }
    await page.waitForTimeout(10000);

    if (metadata?.title || metadata?.description) {
      const caption = metadata.title + (metadata.description ? '\n' + metadata.description : '');
      const captionEditor = await page.$('[contenteditable="true"], .DraftEditor-root [contenteditable]');
      if (captionEditor) {
        await captionEditor.click();
        await page.keyboard.selectAll();
        await page.keyboard.type(caption.slice(0, 2200));
      }
    }

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

    const postButton = await page.$('button:has-text("Post"), button[data-e2e="upload-btn"]');
    if (postButton) await postButton.click();

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
