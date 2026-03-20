const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram');

let Stagehand;
try {
  Stagehand = require('@browserbasehq/stagehand').Stagehand;
} catch {
  Stagehand = null;
}

async function uploadToInstagram(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  if (Stagehand && credentials?.stagehandApiKey) {
    return uploadWithStagehand(videoPath, metadata, credentials);
  }
  return uploadWithPlaywright(videoPath, metadata, credentials);
}

// ========== Stagehand (AI-driven) ==========
async function uploadWithStagehand(videoPath, metadata, credentials) {
  console.log('[Instagram/Stagehand] Starting AI-driven upload...');

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
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie banner
    try {
      await stagehand.act('Click the Allow or Accept cookies button if visible');
    } catch {}
    await page.waitForTimeout(1000);

    // Check login
    const hasLoginForm = await page.evaluate(() => !!document.querySelector('input[name="username"]'));
    if (hasLoginForm) {
      if (!credentials?.email || !credentials?.password) {
        throw new Error('Instagram credentials missing. Add email and password in Settings.');
      }

      console.log('[Instagram/Stagehand] Logging in...');
      await stagehand.act('Enter the username or email: ' + credentials.email);
      await stagehand.act('Enter the password: ' + credentials.password);
      await stagehand.act('Click the Log In button');
      await page.waitForTimeout(8000);

      const needsVerification = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return text.includes('security code') || text.includes('confirmation code') ||
               text.includes('verify your account') || text.includes('suspicious login');
      });

      if (needsVerification) {
        const approval = await requestTelegramApproval({ telegram: credentials.telegram, platform: 'Instagram' });
        if (!approval) throw new Error('Instagram verification required but no Telegram approval received.');
        if (approval.code) {
          await stagehand.act('Enter the security/confirmation code: ' + approval.code);
          await stagehand.act('Click confirm or submit');
          await page.waitForTimeout(5000);
        }
      }

      // Dismiss dialogs
      try { await stagehand.act('Click "Not Now" if a save login info dialog is shown'); } catch {}
      await page.waitForTimeout(1000);
      try { await stagehand.act('Click "Not Now" if a notifications dialog is shown'); } catch {}
    }

    // Create new post
    await stagehand.act('Click the Create or New Post button (the plus icon in the navigation)');
    await page.waitForTimeout(2000);

    // Upload file
    const fileInput = await page.$('input[type="file"][accept*="video"]') || await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(videoPath);
    } else {
      throw new Error('Could not find file input on Instagram');
    }
    await page.waitForTimeout(8000);

    // Click Next (crop)
    await stagehand.act('Click the Next button');
    await page.waitForTimeout(2000);
    // Click Next (filter)
    await stagehand.act('Click the Next button');
    await page.waitForTimeout(2000);

    // Fill caption
    const caption = (metadata?.title || '') + '\n\n' + (metadata?.description || '');
    const tags = (metadata?.tags || []).map(t => `#${t}`).join(' ');
    const fullCaption = `${caption}\n\n${tags}`.trim();
    await stagehand.act('Click the caption text area and type: ' + fullCaption.slice(0, 2200));
    await page.waitForTimeout(2000);

    // Share
    await stagehand.act('Click the Share button to publish');
    await page.waitForTimeout(10000);

    console.log('[Instagram/Stagehand] Upload complete');
    await stagehand.close();
    return { url: 'https://www.instagram.com/' + (credentials.email || 'user') };
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
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const cookieBtn = await page.$('button:has-text("Allow"), button:has-text("Accept")');
    if (cookieBtn) await cookieBtn.click();

    const loginForm = await page.$('input[name="username"]');
    if (loginForm) {
      if (!credentials?.email || !credentials?.password) {
        throw new Error('Instagram credentials missing in Settings.');
      }

      await page.fill('input[name="username"]', credentials.email);
      await page.fill('input[name="password"]', credentials.password);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(8000);

      const needsVerification = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return text.includes('security code') || text.includes('confirmation code') ||
               text.includes('verify your account') || text.includes('suspicious login');
      });

      if (needsVerification) {
        const approval = await requestTelegramApproval({ telegram: credentials.telegram, platform: 'Instagram' });
        if (!approval) throw new Error('Instagram verification required but no approval received.');
        if (approval.code) {
          await tryFillVerificationCode(page, approval.code);
          await page.waitForTimeout(5000);
        }
      }

      const notNow = await page.$('button:has-text("Not Now"), button:has-text("Not now")');
      if (notNow) await notNow.click();
      await page.waitForTimeout(2000);
      const notNow2 = await page.$('button:has-text("Not Now"), button:has-text("Not now")');
      if (notNow2) await notNow2.click();
    }

    const createBtn = await page.$('[aria-label="New post"], svg[aria-label="New post"]');
    if (createBtn) {
      await createBtn.click();
    } else {
      const plusBtn = await page.$('a[href="/create/style/"], svg[aria-label="New Post"]');
      if (plusBtn) await plusBtn.click();
    }
    await page.waitForTimeout(2000);

    const fileInput = await page.$('input[type="file"][accept*="video"]');
    if (!fileInput) {
      const anyFileInput = await page.$('input[type="file"]');
      if (anyFileInput) await anyFileInput.setInputFiles(videoPath);
      else throw new Error('Could not find file input on Instagram');
    } else {
      await fileInput.setInputFiles(videoPath);
    }
    await page.waitForTimeout(8000);

    for (let i = 0; i < 2; i++) {
      const nextBtn = await page.$('button:has-text("Next"), div[role="button"]:has-text("Next")');
      if (nextBtn) await nextBtn.click();
      await page.waitForTimeout(2000);
    }

    if (metadata?.title || metadata?.description) {
      const caption = (metadata.title || '') + '\n\n' + (metadata.description || '');
      const tags = metadata?.tags?.map(t => `#${t}`).join(' ') || '';
      const fullCaption = `${caption}\n\n${tags}`.trim();

      const captionInput = await page.$('textarea[aria-label*="caption" i], div[contenteditable="true"][role="textbox"]');
      if (captionInput) {
        await captionInput.click();
        await page.keyboard.type(fullCaption.slice(0, 2200));
      }
    }

    await page.waitForTimeout(2000);

    const shareBtn = await page.$('button:has-text("Share"), div[role="button"]:has-text("Share")');
    if (shareBtn) await shareBtn.click();

    await page.waitForTimeout(10000);
    console.log('[Instagram] Upload complete');
    await context.close();
    return { url: 'https://www.instagram.com/' + (credentials.email || 'user') };
  } catch (err) {
    await context.close();
    throw err;
  }
}

module.exports = { uploadToInstagram };
