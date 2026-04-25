// Deterministic local browser research with screenshots + page text extraction.
// Used by the cloud agent (queued via pending_commands.command='browser_research') to
// actually open the user's local Chromium, navigate to top sources, capture screenshots,
// extract readable text, and return structured results that can be rendered in the
// Job Queue UI and previewed in Telegram.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { launchPersistent, safeClose } = require('./uploaders/social-post-base');

const SCREENSHOT_DIR = path.join(__dirname, 'data', 'browser-research');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function safeStem(text, max = 60) {
  return String(text || 'capture')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'capture';
}

async function fetchSearchResults(query, count) {
  // Reuse the local /api/research/search endpoint via loopback so we benefit from the
  // existing Brave/DuckDuckGo/Google fallback chain.
  const port = process.env.PORT || 3001;
  try {
    const r = await fetch(`http://localhost:${port}/api/research/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count }),
    });
    const data = await r.json().catch(() => ({}));
    return Array.isArray(data?.results) ? data.results : [];
  } catch (e) {
    console.warn('[BrowserResearch] search loopback failed:', e.message);
    return [];
  }
}

async function captureSourcePage(page, url, label) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const stem = safeStem(label || url);
  const filename = `${Date.now()}-${stem}.jpg`;
  const filePath = path.join(SCREENSHOT_DIR, filename);

  let buffer = null;
  try {
    buffer = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
    fs.writeFileSync(filePath, buffer);
  } catch (e) {
    console.warn(`[BrowserResearch] screenshot failed for ${url}:`, e.message);
  }

  let title = '';
  let bodyText = '';
  try {
    title = await page.title();
  } catch { }
  try {
    bodyText = await page.evaluate(() => {
      const main = document.querySelector('article, main, [role="main"]') || document.body;
      return (main?.innerText || '').slice(0, 4000);
    });
  } catch { }

  return {
    url,
    title: title || label || url,
    text: bodyText,
    screenshotPath: buffer ? filePath : null,
    screenshotFile: buffer ? filename : null,
    screenshotBase64: buffer ? buffer.toString('base64') : null,
  };
}

async function maybeSendTelegramScreenshot(settings, sendTelegramPhoto, capture, label) {
  if (!settings?.telegram?.enabled || !settings?.telegram?.chatId) return;
  if (!capture?.screenshotBase64) return;
  try {
    const buf = Buffer.from(capture.screenshotBase64, 'base64');
    const caption = `🌐 ${label}\n${capture.title}\n${capture.url}`.slice(0, 1000);
    await sendTelegramPhoto(
      settings.telegram.botToken,
      settings.telegram.chatId,
      buf,
      caption,
      settings.backend,
    );
  } catch (e) {
    console.warn('[BrowserResearch] Telegram photo send failed:', e.message);
  }
}

/**
 * Run a research-style browser task on the local PC.
 *  args: { query, count?, depth?, send_screenshots?, max_screenshots? }
 *  returns a structured result that gets stored on pending_commands.result and
 *  is rendered as openable links in the Job Queue UI.
 */
async function runBrowserResearch(args = {}, { settings, sendTelegram, sendTelegramPhoto } = {}) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required for browser_research');

  const requestedCount = Math.max(2, Math.min(8, Number(args.count) || 5));
  const maxScreenshots = Math.max(1, Math.min(5, Number(args.max_screenshots) || 3));
  const sendScreenshots = args.send_screenshots !== false;

  if (settings && sendTelegram) {
    await sendTelegram(settings, `🔎 Researching "${query.slice(0, 100)}" — opening local browser…`).catch(() => { });
  }

  const sources = await fetchSearchResults(query, requestedCount);
  if (!sources.length) {
    return {
      ok: false,
      summary: `No search results found for "${query}".`,
      query,
      sources: [],
      links: [],
      screenshots: [],
    };
  }

  const captures = [];
  const context = await launchPersistent('research', {});
  try {
    const page = await context.newPage();
    const targets = sources.slice(0, maxScreenshots);
    for (let i = 0; i < targets.length; i++) {
      const src = targets[i];
      const capture = await captureSourcePage(page, src.url, src.title || `Source ${i + 1}`);
      captures.push({ ...capture, snippet: src.snippet || '' });
      if (sendScreenshots) {
        await maybeSendTelegramScreenshot(settings, sendTelegramPhoto, capture, `Source ${i + 1}`);
      }
    }
  } finally {
    await safeClose(context);
  }

  const summary = `Read ${captures.length} of ${sources.length} sources for "${query}".`;
  const links = sources.map((s) => ({ kind: 'source', label: s.title || s.url, url: s.url }));
  const screenshots = captures
    .filter((c) => c.screenshotFile)
    .map((c) => ({
      label: c.title,
      file: c.screenshotFile,
      path: c.screenshotPath,
      pageUrl: c.url,
    }));

  // Trim heavy fields out of the persisted result so we don't blow up
  // pending_commands.result with huge base64 blobs.
  const persistedCaptures = captures.map((c) => ({
    url: c.url,
    title: c.title,
    snippet: c.snippet,
    text: (c.text || '').slice(0, 1500),
    screenshotFile: c.screenshotFile,
  }));

  return {
    ok: true,
    summary,
    query,
    sources,
    captures: persistedCaptures,
    links,
    screenshots,
  };
}

module.exports = {
  runBrowserResearch,
  SCREENSHOT_DIR,
};
