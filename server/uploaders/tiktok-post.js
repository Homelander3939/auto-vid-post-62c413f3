// TikTok photo post uploader using a persistent Chrome profile.
// Uses TikTok Studio "Upload" → photo flow.
const { launchPersistent, safeClose } = require('./social-post-base');

const TIKTOK_UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=upload&lang=en';

async function uploadToTikTokPost(imagePath, { description, hashtags = [] }, opts = {}) {
  const context = await launchPersistent('tiktok-post', opts);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(TIKTOK_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const url = page.url();
    if (url.includes('/login')) {
      throw new Error('TikTok requires login. Use Prepare in Settings to log in once.');
    }

    if (imagePath) {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.waitFor({ state: 'attached', timeout: 30000 });
      await fileInput.setInputFiles(imagePath);
      await page.waitForTimeout(6000);
    }

    const fullText = hashtags.length
      ? `${description}\n\n${hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
      : description;

    // TikTok caption is a contenteditable
    const caption = page.locator('div[contenteditable="true"], div[role="textbox"]').first();
    await caption.waitFor({ state: 'visible', timeout: 30000 });
    await caption.click();
    // Clear default placeholder text
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.keyboard.insertText(fullText);
    await page.waitForTimeout(2000);

    // Post button: enabled after upload
    const postBtn = page.locator('button:has-text("Post"), button:has-text("Publish")').last();
    for (let i = 0; i < 30; i++) {
      if (await postBtn.isEnabled().catch(() => false)) break;
      await page.waitForTimeout(2000);
    }
    await postBtn.click();
    await page.waitForTimeout(6000);
    return { url: page.url() };
  } finally {
    await safeClose(context);
  }
}

module.exports = { uploadToTikTokPost };
