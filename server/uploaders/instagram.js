const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram');

async function uploadToInstagram(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);

  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto('https://www.instagram.com/', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    await page.waitForTimeout(3000);

    // Dismiss cookie banner if present
    const cookieBtn = await page.$('button:has-text("Allow"), button:has-text("Accept")');
    if (cookieBtn) await cookieBtn.click();

    // Check if login needed
    const loginForm = await page.$('input[name="username"]');
    if (loginForm) {
      console.log('[Instagram] Logging in...');
      await page.fill('input[name="username"]', credentials.email);
      await page.fill('input[name="password"]', credentials.password);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(8000);

      // Handle "Save Your Login Info?" dialog
      const notNow = await page.$('button:has-text("Not Now"), button:has-text("Not now")');
      if (notNow) await notNow.click();
      await page.waitForTimeout(2000);

      // Handle notifications dialog
      const notNow2 = await page.$('button:has-text("Not Now"), button:has-text("Not now")');
      if (notNow2) await notNow2.click();
    }

    // Click "New post" / create button
    const createBtn = await page.$('[aria-label="New post"], svg[aria-label="New post"]');
    if (createBtn) {
      await createBtn.click();
    } else {
      // Try the + icon in nav
      const plusBtn = await page.$('a[href="/create/style/"], svg[aria-label="New Post"]');
      if (plusBtn) await plusBtn.click();
    }
    await page.waitForTimeout(2000);

    // Upload the file
    const fileInput = await page.$('input[type="file"][accept*="video"]');
    if (!fileInput) {
      const anyFileInput = await page.$('input[type="file"]');
      if (anyFileInput) {
        await anyFileInput.setInputFiles(videoPath);
      } else {
        throw new Error('Could not find file input on Instagram');
      }
    } else {
      await fileInput.setInputFiles(videoPath);
    }

    await page.waitForTimeout(8000);

    // Click through: crop -> filters -> caption
    // Click "Next" twice
    for (let i = 0; i < 2; i++) {
      const nextBtn = await page.$('button:has-text("Next"), div[role="button"]:has-text("Next")');
      if (nextBtn) await nextBtn.click();
      await page.waitForTimeout(2000);
    }

    // Fill caption
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

    // Click "Share"
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
