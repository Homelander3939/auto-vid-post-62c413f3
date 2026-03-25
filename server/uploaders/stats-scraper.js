// Stats scraper — scrapes video stats from YouTube Shorts, TikTok, and Instagram Reels
// using an existing Playwright page/context (reuses browser session from uploaders).
// Agentic approach: navigates to each video's Studio analytics page for real data.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { runAgentTask } = require('./smart-agent');

// ─── Helpers ────────────────────────────────────────────────

function isDurStr(t) {
  const cleaned = String(t || '').replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ').trim();
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(cleaned);
}

// ─── Copy upload session to stats session directory ─────────
// Always refreshes the stats session from the main upload session so login
// cookies stay fresh. Files that must not be copied (lock files, sockets) are skipped.
function syncSessionFromUpload(uploadDir, statsDir) {
  if (!fs.existsSync(uploadDir)) return;
  const SKIP = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', '.lock']);
  try {
    fs.mkdirSync(statsDir, { recursive: true });
    const files = fs.readdirSync(uploadDir).filter(f => !SKIP.has(f) && !f.endsWith('.tmp'));
    for (const file of files) {
      const src = path.join(uploadDir, file);
      const dst = path.join(statsDir, file);
      try {
        const stat = fs.statSync(src);
        if (stat.isFile()) {
          fs.copyFileSync(src, dst);
        } else if (stat.isDirectory()) {
          fs.cpSync(src, dst, { recursive: true });
        }
      } catch (_) {}
    }
    console.log(`[Stats] Synced session: ${path.basename(uploadDir)} → ${path.basename(statsDir)}`);
  } catch (err) {
    console.warn(`[Stats] Session sync failed: ${err.message}`);
  }
}

// ─── YouTube login (when session is expired) ─────────────────
async function ensureYouTubeLogin(page, credentials = {}) {
  const { email = '', password = '' } = credentials;

  // Navigate to YouTube Studio
  await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
    console.warn('[Stats] YouTube Studio navigation error:', e.message);
  });
  await page.waitForTimeout(3000);

  const rawUrl = page.url();
  let hostname = '';
  try { hostname = new URL(rawUrl).hostname; } catch (_) {}
  // If we're already in Studio, we're logged in
  if (hostname === 'studio.youtube.com') {
    console.log('[Stats] YouTube session active');
    return true;
  }

  if (!email || !password) {
    console.warn('[Stats] YouTube session expired and no credentials provided for re-login');
    return false;
  }

  console.log('[Stats] YouTube session expired, attempting login...');
  try {
    // Wait for email input
    await page.waitForSelector('#identifierId, input[type="email"]', { timeout: 10000 }).catch(e => {
      console.warn('[Stats] YouTube email selector timeout:', e.message);
    });
    const emailInput = await page.$('#identifierId, input[type="email"], input[name="identifier"]');
    if (!emailInput) { console.warn('[Stats] No email input found'); return false; }

    await emailInput.fill(email);
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    // Enter password
    await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(e => {
      console.warn('[Stats] YouTube password selector timeout:', e.message);
    });
    const passwordInput = await page.$('input[type="password"]:not([aria-hidden="true"])');
    if (!passwordInput) { console.warn('[Stats] No password input found'); return false; }

    await passwordInput.fill(password);
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);

    // Check if we landed in Studio
    let afterHostname = '';
    try { afterHostname = new URL(page.url()).hostname; } catch (_) {}
    if (afterHostname === 'studio.youtube.com') {
      console.log('[Stats] YouTube login successful');
      return true;
    }
    console.warn(`[Stats] YouTube login may need 2FA or additional steps (url: ${page.url()})`);
    // Wait a bit more in case of redirect
    await page.waitForTimeout(4000);
    let finalHostname = '';
    try { finalHostname = new URL(page.url()).hostname; } catch (_) {}
    return finalHostname === 'studio.youtube.com';
  } catch (err) {
    console.error('[Stats] YouTube login error:', err.message);
    return false;
  }
}

// ─── TikTok login (when session is expired) ──────────────────
async function ensureTikTokLogin(page, credentials = {}) {
  const { email = '', password = '' } = credentials;

  await page.goto('https://www.tiktok.com/profile', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => {
    console.warn('[Stats] TikTok profile navigation error:', e.message);
  });
  await page.waitForTimeout(3000);

  const url = page.url();
  if (!url.includes('login')) {
    console.log('[Stats] TikTok session active');
    return true;
  }

  if (!email || !password) {
    console.warn('[Stats] TikTok session expired and no credentials provided for re-login');
    return false;
  }

  console.log('[Stats] TikTok session expired, attempting login...');
  try {
    // Navigate to login with email
    await page.goto('https://www.tiktok.com/login/phone-or-email/email', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => {
      console.warn('[Stats] TikTok login page navigation error:', e.message);
    });
    await page.waitForTimeout(2500);

    const emailInput = await page.$('input[name="username"], input[type="email"], input[placeholder*="email" i], input[placeholder*="phone" i]');
    if (!emailInput) { console.warn('[Stats] No TikTok email input found'); return false; }

    await emailInput.fill(email);
    await page.waitForTimeout(300);

    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) { console.warn('[Stats] No TikTok password input found'); return false; }

    await passwordInput.fill(password);
    await page.waitForTimeout(300);

    // Click login button
    const loginBtn = await page.$('button[type="submit"], button:has-text("Log in"), [data-e2e="login-button"]');
    if (loginBtn) await loginBtn.click();
    else await page.keyboard.press('Enter');

    await page.waitForTimeout(5000);
    const newUrl = page.url();
    const loggedIn = !newUrl.includes('login');
    console.log(`[Stats] TikTok login ${loggedIn ? 'successful' : 'may need manual step'} (url: ${newUrl})`);
    return loggedIn;
  } catch (err) {
    console.error('[Stats] TikTok login error:', err.message);
    return false;
  }
}

// ─── Instagram login (when session is expired) ───────────────
async function ensureInstagramLogin(page, credentials = {}) {
  const { email = '', password = '' } = credentials;

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => {
    console.warn('[Stats] Instagram navigation error:', e.message);
  });
  await page.waitForTimeout(3000);

  const url = page.url();
  // Logged in if we see the main feed (not the accounts login page)
  const onLogin = url.includes('/accounts/login') || url.includes('/accounts/emailsignup');
  if (!onLogin) {
    console.log('[Stats] Instagram session active');
    return true;
  }

  if (!email || !password) {
    console.warn('[Stats] Instagram session expired and no credentials provided for re-login');
    return false;
  }

  console.log('[Stats] Instagram session expired, attempting login...');
  try {
    const emailInput = await page.$('input[name="username"], input[type="email"]');
    if (!emailInput) { console.warn('[Stats] No Instagram email input found'); return false; }

    await emailInput.fill(email);
    await page.waitForTimeout(300);

    const passwordInput = await page.$('input[type="password"], input[name="password"]');
    if (!passwordInput) { console.warn('[Stats] No Instagram password input found'); return false; }

    await passwordInput.fill(password);
    await page.waitForTimeout(300);

    const loginBtn = await page.$('button[type="submit"]');
    if (loginBtn) await loginBtn.click();
    else await page.keyboard.press('Enter');

    await page.waitForTimeout(5000);
    const newUrl = page.url();
    const loggedIn = !newUrl.includes('/accounts/login');
    console.log(`[Stats] Instagram login ${loggedIn ? 'successful' : 'may need manual step'} (url: ${newUrl})`);
    return loggedIn;
  } catch (err) {
    console.error('[Stats] Instagram login error:', err.message);
    return false;
  }
}

// Extract title from raw Innertube API video object — tries all known field shapes.
function extractTitleFromApiItem(v) {
  const candidates = [
    // Standard YouTube Data API v3
    v.snippet?.title,
    // Innertube Creator Studio variants
    v.titleFormattedString?.content,
    v.titleFormattedString?.runs?.[0]?.text,
    v.titleAndDescDetails?.basicDetails?.title,
    v.titleAndDescDetails?.creatorVideo?.title,
    v.titleAndDesc?.title,
    v.videoDetails?.title,
    v.metadata?.title,
    v.title?.content,
    // Simple string
    typeof v.title === 'string' ? v.title : undefined,
    // Nested text objects
    v.title?.simpleText,
    v.title?.runs?.map?.(r => r.text || '').join(''),
    // Other known shapes
    typeof v.videoTitle === 'string' ? v.videoTitle : undefined,
    v.video?.videoTitle,
    v.video?.title?.simpleText,
    v.basicDetails?.title,
  ];
  for (const c of candidates) {
    const s = String(c || '').trim();
    if (s && !isDurStr(s) && s.length > 1) return s;
  }
  return '';
}

// Extract view/like/comment counts from raw Innertube API video object.
function extractStatsFromApiItem(v) {
  let views = '—', likes = '—', comments = '—';

  // Try every known metrics wrapper
  const metricsWrappers = [
    v.metrics,
    v.statistics,
    v.metricsDetails,
    v.stats,
    v.analyticsStats,
    v.videoStats,
    v.videoAnalytics,
  ];

  for (const m of metricsWrappers) {
    if (!m) continue;

    if (views === '—' && m.viewCount !== undefined) {
      views = typeof m.viewCount === 'object'
        ? String(m.viewCount.views ?? m.viewCount.value ?? m.viewCount.displayValue ?? '—')
        : String(m.viewCount);
    }
    if (likes === '—' && m.likeCount !== undefined) {
      likes = typeof m.likeCount === 'object'
        ? String(m.likeCount.likes ?? m.likeCount.value ?? m.likeCount.displayValue ?? '—')
        : String(m.likeCount);
    }
    if (comments === '—' && m.commentCount !== undefined) {
      comments = typeof m.commentCount === 'object'
        ? String(m.commentCount.comments ?? m.commentCount.value ?? m.commentCount.displayValue ?? '—')
        : String(m.commentCount);
    }

    // Flat numeric string fields
    if (views === '—' && m.views) views = String(m.views);
    if (likes === '—' && m.likes) likes = String(m.likes);
    if (comments === '—' && m.comments) comments = String(m.comments);
  }

  // Try videoSummaryItems array (another Innertube shape)
  const summaryItems = v.metricsDetails?.videoSummaryItems || v.videoSummaryItems || [];
  for (const item of summaryItems) {
    const label = String(item.label || item.labelText || item.title || '').toLowerCase();
    const value = String(item.value || item.count || item.formattedValue || '').replace(/,/g, '');
    if (/view/.test(label) && views === '—' && value) views = value;
    if (/like/.test(label) && likes === '—' && value) likes = value;
    if (/comment/.test(label) && comments === '—' && value) comments = value;
  }

  return { views, likes, comments };
}

// ─── YouTube Shorts Stats ───────────────────────────────────

async function scrapeYouTubeShortsStats(page, { maxVideos = 10 } = {}) {
  console.log('[Stats] Starting agentic YouTube Shorts stats collection...');

  // Use a decent viewport for full Studio rendering
  try { await page.setViewportSize({ width: 1440, height: 900 }); } catch (_) {}

  // ── Step 1: Navigate to YouTube Studio and collect session info ──────────
  console.log('[Stats] Navigating to YouTube Studio...');
  await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const studioInfo = await page.evaluate(() => {
    const apiKey = (window.ytcfg && window.ytcfg.get('INNERTUBE_API_KEY')) || '';
    const clientVer = (window.ytcfg && window.ytcfg.get('INNERTUBE_CLIENT_VERSION')) || '1.20250101.00.00';
    const m = window.location.href.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
    const channelId = m ? m[1] : '';
    const handleLinks = Array.from(document.querySelectorAll('a[href*="/@"]'));
    let channelHandle = '';
    for (const link of handleLinks) {
      const hm = (link.getAttribute('href') || '').match(/\/@([^/?&]+)/);
      if (hm) { channelHandle = '@' + hm[1]; break; }
    }
    return { apiKey, clientVer, channelId, channelHandle };
  }).catch(() => ({ apiKey: '', clientVer: '1.20250101.00.00', channelId: '', channelHandle: '' }));

  console.log(`[Stats] channelId=${studioInfo.channelId || 'unknown'}, apiKey=${studioInfo.apiKey ? 'found' : 'missing'}`);

  // ── Step 2: Get video IDs via Innertube API ──────────────────────────────
  let videoIds = [];
  const apiVideoDataMap = {}; // videoId → raw API item

  if (studioInfo.apiKey) {
    try {
      const rawJson = await page.evaluate(async ({ apiKey, clientVer }) => {
        try {
          const resp = await fetch(
            `/youtubei/v1/creator/list_creator_videos?key=${apiKey}&prettyPrint=false`,
            {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'X-Goog-AuthUser': '0' },
              body: JSON.stringify({
                filter: { videoType: { type: 'VIDEO_TYPE_SHORT' } },
                order: 'VIDEO_ORDER_DISPLAY_DATE_DESC',
                pageSize: 30,
                context: { client: { clientName: 'CREATOR_STUDIO', clientVersion: clientVer } },
              }),
            }
          );
          if (!resp.ok) return null;
          return await resp.text();
        } catch (_) { return null; }
      }, { apiKey: studioInfo.apiKey, clientVer: studioInfo.clientVer });

      if (rawJson) {
        const data = JSON.parse(rawJson);
        // Log first 500 chars of response to help with debugging
        console.log('[Stats] Innertube API raw snippet:', rawJson.slice(0, 500));

        const videoList =
          data.videos ||
          data.items ||
          data.videoItems ||
          data.videoList?.videoItems ||
          data.content?.itemSectionRenderer?.contents ||
          [];

        const seenIds = new Set();
        for (const v of videoList) {
          const vid = v.videoId || v.id || v.video?.videoId ||
                      v.videoRenderer?.videoId || v.reel?.reelId || '';
          if (vid && !seenIds.has(vid)) {
            seenIds.add(vid);
            videoIds.push(vid);
            apiVideoDataMap[vid] = v;
          }
        }
        console.log(`[Stats] Innertube API returned ${videoIds.length} video IDs`);
      }
    } catch (e) {
      console.warn('[Stats] Innertube API failed:', e.message);
    }
  }

  // ── Step 3: Fall back to Studio DOM to collect video IDs ────────────────
  if (videoIds.length === 0) {
    console.log('[Stats] Falling back to Studio DOM scrape for video IDs...');
    videoIds = await getVideoIdsFromStudioContentPage(page, studioInfo.channelId, maxVideos);
    console.log(`[Stats] Studio DOM found ${videoIds.length} video IDs`);
  }

  // ── Step 4: Last-resort fallback to public Shorts page ──────────────────
  if (videoIds.length === 0) {
    console.log('[Stats] Falling back to public Shorts page...');
    return scrapeYouTubeShortsPublic(page, maxVideos, studioInfo.channelHandle, studioInfo.channelId);
  }

  // ── Step 5: For each video ID get real stats (agentic per-video approach) ─
  console.log(`[Stats] Fetching stats for up to ${Math.min(videoIds.length, maxVideos)} videos...`);
  const stats = [];

  for (const videoId of videoIds.slice(0, maxVideos)) {
    // First try: parse from the Innertube API data if available
    let entry = null;
    if (apiVideoDataMap[videoId]) {
      const t = extractTitleFromApiItem(apiVideoDataMap[videoId]);
      if (t) {
        const s = extractStatsFromApiItem(apiVideoDataMap[videoId]);
        entry = { title: t.slice(0, 100), url: `https://youtube.com/shorts/${videoId}`, ...s };
        console.log(`[Stats] API data for ${videoId}: "${t}" views=${s.views}`);
      }
    }

    // Second try: navigate to Studio analytics page for this video (agentic)
    if (!entry) {
      console.log(`[Stats] Opening analytics page for video ${videoId}...`);
      entry = await getVideoStatsFromStudioAnalytics(page, videoId);
    }

    if (entry) stats.push(entry);
  }

  console.log(`[Stats] Collected stats for ${stats.length} YouTube Shorts`);
  return stats;
}

// ── Get video IDs by navigating to Studio content page and scraping DOM ─────
async function getVideoIdsFromStudioContentPage(page, channelId, maxVideos) {
  try {
    const url = channelId
      ? `https://studio.youtube.com/channel/${channelId}/videos?filter=%5B%7B%22name%22%3A%22VIDEO_TYPE%22%2C%22value%22%3A%22VIDEO_TYPE_SHORT%22%7D%5D`
      : 'https://studio.youtube.com/videos';

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // Wait for video rows to appear
    await page.waitForSelector('ytcp-video-row, tr.video-row, [class*="video-row"]', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Click Shorts filter tab if it exists (for non-pre-filtered URL)
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"], tp-yt-paper-tab, a[role="tab"]');
      for (const tab of tabs) {
        if ((tab.textContent || '').toLowerCase().trim() === 'shorts') {
          tab.click();
          return;
        }
      }
    });
    await page.waitForTimeout(2500);

    // Scroll down to trigger lazy-loading of more videos
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    // Extract video IDs via deep shadow-DOM traversal
    return await page.evaluate((max) => {
      function deepAll(root, selector) {
        const found = [];
        try { found.push(...Array.from(root.querySelectorAll(selector))); } catch (_) {}
        try {
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) found.push(...deepAll(el.shadowRoot, selector));
          }
        } catch (_) {}
        return found;
      }

      const ids = [];
      const seenIds = new Set();

      // Primary: links inside ytcp-video-row elements
      const rows = deepAll(document, 'ytcp-video-row');
      for (const row of rows) {
        if (ids.length >= max) break;
        for (const link of deepAll(row, 'a[href*="/video/"]')) {
          const m = (link.getAttribute('href') || '').match(/\/video\/([a-zA-Z0-9_-]+)/);
          if (m && !seenIds.has(m[1])) {
            seenIds.add(m[1]);
            ids.push(m[1]);
            break;
          }
        }
      }

      // Secondary: any /video/ link in the entire page DOM
      if (ids.length === 0) {
        for (const link of deepAll(document, 'a[href*="/video/"]')) {
          const m = (link.getAttribute('href') || '').match(/\/video\/([a-zA-Z0-9_-]+)/);
          if (m && !seenIds.has(m[1])) {
            seenIds.add(m[1]);
            ids.push(m[1]);
            if (ids.length >= max) break;
          }
        }
      }

      return ids;
    }, maxVideos);
  } catch (err) {
    console.error('[Stats] Studio DOM ID scrape error:', err.message);
    return [];
  }
}

// ── Navigate to a video's Studio analytics page and extract title + stats ───
// This is the most reliable approach: the analytics page labels metrics clearly
// and the page <title> always contains the video title.
async function getVideoStatsFromStudioAnalytics(page, videoId) {
  const analyticsUrl = `https://studio.youtube.com/video/${videoId}/analytics/tab-overview/period-default`;
  try {
    await page.goto(analyticsUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    // Wait for the analytics chart area or stats bars to render
    await page.waitForSelector(
      'ytcp-analytics-stats-bar, ytcp-analytics-chart-stats, [class*="stats-bar"], ytcp-analytics-main',
      { timeout: 10000 }
    ).catch(() => {});
    await page.waitForTimeout(3000);

    // Scroll a bit to trigger rendering of all metric cards
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 0));

    return await page.evaluate((videoId) => {
      // ── Title: most reliable source is the HTML <title> element ──────────
      let title = (document.title || '')
        .replace(/\s*[-–|]\s*YouTube Studio.*$/i, '')
        .replace(/^YouTube Studio\s*[-–|]\s*/i, '')
        .trim();

      // Also try prominent heading elements as fallback
      if (!title || title.toLowerCase() === 'youtube studio') {
        const headingCandidates = [
          document.querySelector('.ytcp-video-info-bar-details .title'),
          document.querySelector('[slot="title"]'),
          document.querySelector('yt-formatted-string.ytcp-analytics-identifiers-link'),
          document.querySelector('[class*="video-title"] yt-formatted-string'),
          document.querySelector('ytcp-ve[class*="title"] yt-formatted-string'),
          document.querySelector('h2'),
        ];
        for (const el of headingCandidates) {
          const t = (el ? el.textContent || '' : '').trim();
          if (t && t.length > 2 && t.toLowerCase() !== 'youtube studio') {
            title = t;
            break;
          }
        }
      }

      // ── Stats: scan all stats-bar items for labeled metrics ───────────────
      let views = '—', likes = '—', comments = '—';

      // Helper: extract a clean number from a string
      function cleanNum(s) {
        const m = String(s || '').replace(/,/g, '').match(/([\d.]+\s*[KMBTkmbt]?)/);
        return m ? m[1].trim() : '';
      }

      // Method 1: ytcp-analytics-stats-bar-item elements (Studio standard)
      const statItems = document.querySelectorAll(
        'ytcp-analytics-stats-bar-item, [class*="stats-bar-item"], ytcp-analytics-chart-stats-value'
      );
      for (const item of statItems) {
        const labelEl = item.querySelector(
          '[class*="label"], [class*="title"], [class*="header"], yt-formatted-string'
        );
        const valueEl = item.querySelector(
          '[class*="value"], [class*="count"], [class*="formatted"], [class*="number"]'
        );
        const label = (labelEl ? labelEl.textContent : item.getAttribute('label') || '').toLowerCase();
        const value = cleanNum(valueEl ? valueEl.textContent : item.getAttribute('value') || '');
        if (!value) continue;
        if (/\bviews?\b/.test(label) && views === '—') views = value;
        else if (/\blikes?\b/.test(label) && likes === '—') likes = value;
        else if (/\bcomments?\b/.test(label) && comments === '—') comments = value;
        else if (/\bwatch\s*time\b/.test(label)) { /* skip watch time */ }
      }

      // Method 2: scan the entire innerText for "Metric\nValue" or "Value\nMetric" pairs
      if (views === '—' || likes === '—' || comments === '—') {
        const bodyText = (document.body ? document.body.innerText : '') || '';

        // Match patterns like "Views\n1,234" or "1,234\nViews" or "Views 1,234"
        const viewsM = bodyText.match(/\bviews?\b[\s\n:]*([0-9][0-9,. KMBTkmbt]*)/i)
          || bodyText.match(/([0-9][0-9,. KMBTkmbt]*)\s*\n\s*\bviews?\b/i);
        const likesM = bodyText.match(/\blikes?\b[\s\n:]*([0-9][0-9,. KMBTkmbt]*)/i)
          || bodyText.match(/([0-9][0-9,. KMBTkmbt]*)\s*\n\s*\blikes?\b/i);
        const commentsM = bodyText.match(/\bcomments?\b[\s\n:]*([0-9][0-9,. KMBTkmbt]*)/i)
          || bodyText.match(/([0-9][0-9,. KMBTkmbt]*)\s*\n\s*\bcomments?\b/i);

        if (views === '—' && viewsM) views = cleanNum(viewsM[1]);
        if (likes === '—' && likesM) likes = cleanNum(likesM[1]);
        if (comments === '—' && commentsM) comments = cleanNum(commentsM[1]);
      }

      return {
        title: title ? title.slice(0, 100) : '(untitled)',
        views,
        likes,
        comments,
        url: `https://youtube.com/shorts/${videoId}`,
      };
    }, videoId);
  } catch (err) {
    console.error(`[Stats] Analytics page failed for ${videoId}:`, err.message);
    return null;
  }
}

async function scrapeYouTubeShortsPublic(page, maxVideos = 10, channelHandle = '', channelId = '') {
  try {
    let shortsUrl = '';

    if (channelHandle) {
      shortsUrl = `https://www.youtube.com/${channelHandle}/shorts`;
    } else if (channelId) {
      shortsUrl = `https://www.youtube.com/channel/${channelId}/shorts`;
    } else {
      await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);

      const detected = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="youtube.com/@"], a[href*="/@"]'));
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (href.startsWith('https://www.youtube.com/') || href.startsWith('https://studio.youtube.com/') || href.startsWith('/')) return href;
        }
        const chanLinks = document.querySelectorAll('a[href*="youtube.com/channel/"], a[href*="/channel/UC"]');
        for (const link of chanLinks) {
          const href = link.getAttribute('href') || '';
          if (href) return href;
        }
        return '';
      });

      if (detected) {
        const base = detected.startsWith('http') ? detected : `https://www.youtube.com${detected}`;
        shortsUrl = base.replace(/\/?$/, '/shorts');
      }
    }

    if (!shortsUrl) {
      console.warn('[Stats] Could not determine channel URL for public Shorts page');
      return [];
    }

    console.log(`[Stats] Navigating to public Shorts page: ${shortsUrl}`);
    await page.goto(shortsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForSelector(
      'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, ytd-shorts-item-renderer',
      { timeout: 10000 }
    ).catch(() => {});
    await page.waitForTimeout(2500);

    // Scroll to load more videos
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    const results = await page.evaluate((max) => {
      function isDur(t) {
        const cleaned = String(t || '').replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ').trim();
        return /^\d{1,2}:\d{2}(:\d{2})?$/.test(cleaned);
      }

      const seenIds = new Set();
      const out = [];

      const items = document.querySelectorAll(
        'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, ytd-shorts-item-renderer'
      );

      for (const item of items) {
        if (out.length >= max) break;

        const allLinks = Array.from(item.querySelectorAll('a[href*="/shorts/"], a[href*="/watch?"]'));
        let href = '';
        let shortId = '';
        for (const a of allLinks) {
          const h = a.getAttribute('href') || '';
          const sid = h.match(/\/shorts\/([a-zA-Z0-9_-]+)/)?.[1] || h.match(/[?&]v=([a-zA-Z0-9_-]+)/)?.[1] || '';
          if (sid) { href = h; shortId = sid; break; }
        }
        if (!shortId) continue;
        if (seenIds.has(shortId)) continue;
        seenIds.add(shortId);

        const url = href.startsWith('http') ? href : `https://www.youtube.com${href}`;

        let title = '';
        const titleEl = item.querySelector(
          'a#video-title, h3 a#video-title, yt-formatted-string#video-title, span#video-title'
        );
        if (titleEl) {
          const t = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
          if (t && !isDur(t)) title = t;
        }
        if (!title) {
          for (const a of allLinks) {
            const t = (a.getAttribute('title') || a.getAttribute('aria-label') || '').trim();
            if (t && !isDur(t) && t.length > 2) { title = t; break; }
          }
        }
        if (!title) {
          for (const a of allLinks) {
            const t = (a.textContent || '').trim();
            if (t && !isDur(t) && t.length > 2) { title = t; break; }
          }
        }
        if (!title || isDur(title)) continue;

        let views = '—';
        const metaSpans = item.querySelectorAll(
          '#metadata-line span, .inline-metadata-item, ytd-video-meta-block span, [class*="metadata"] span'
        );
        for (const span of metaSpans) {
          const t = (span.textContent || '').trim();
          if (/\d/.test(t) && (t.toLowerCase().includes('view') || /^\d[\d,.KMBkmb ]*$/i.test(t))) {
            views = t.replace(/\s*views?/i, '').trim() || t;
            break;
          }
        }

        out.push({ title: title.slice(0, 100), url, views, comments: '—', likes: '—' });
      }
      return out;
    }, maxVideos);

    console.log(`[Stats] Found ${results.length} YouTube videos (public Shorts page)`);
    return results;
  } catch (err) {
    console.error('[Stats] YouTube public scrape error:', err.message);
    return [];
  }
}

// ─── TikTok Stats ───────────────────────────────────────────
async function scrapeTikTokStats(page, { maxVideos = 10 } = {}) {
  console.log('[Stats] Scraping TikTok stats (agentic mode)...');
  try {
    try { await page.setViewportSize({ width: 1440, height: 900 }); } catch (_) {}

    // Step 1: Try to get username from current session or profile redirect
    await page.goto('https://www.tiktok.com/profile', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // If redirected to login, we're not authenticated — try creator-center
    const currentUrl = page.url();
    let profileUrl = currentUrl;

    if (currentUrl.includes('login')) {
      // Not logged in or profile URL unknown — try creator center
      await page.goto('https://www.tiktok.com/creator-center/analytics', {
        waitUntil: 'domcontentloaded', timeout: 20000,
      }).catch(() => {});
      await page.waitForTimeout(3000);
    } else {
      // On the profile page — wait for the video grid to load
      await page.waitForSelector(
        '[data-e2e="user-post-item"], [data-e2e="user-post-item-list"]',
        { timeout: 10000 }
      ).catch(() => {});
    }

    // Scroll down to load more videos
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    const stats = await page.evaluate((max) => {
      const results = [];
      const seenIds = new Set();

      // Try profile video grid items
      const videoItems = document.querySelectorAll(
        '[data-e2e="user-post-item"], [class*="DivItemContainer"], [class*="video-feed-item"]'
      );

      for (const item of videoItems) {
        if (results.length >= max) break;

        const link = item.querySelector('a[href*="/video/"]') || item.querySelector('a');
        const href = link?.getAttribute('href') || '';
        const vidMatch = href.match(/\/video\/(\d+)/);
        const videoId = vidMatch ? vidMatch[1] : '';
        if (videoId && seenIds.has(videoId)) continue;
        if (videoId) seenIds.add(videoId);

        const url = href.startsWith('http') ? href : href ? `https://www.tiktok.com${href}` : '';

        // Description as title (aria-label or desc element)
        const desc = (
          item.getAttribute('aria-label') ||
          item.querySelector('[data-e2e="video-desc"], [class*="desc"], [class*="caption"]')?.textContent ||
          item.querySelector('img')?.getAttribute('alt') ||
          ''
        ).trim();

        // View count overlay
        const viewsEl = item.querySelector(
          '[data-e2e="video-views"], strong[class*="count"], [class*="video-count"], [class*="play-count"]'
        );
        const views = (viewsEl?.textContent || '').trim();

        results.push({
          title: (desc || '(untitled)').slice(0, 100),
          views: views || '—',
          likes: '—',
          comments: '—',
          url,
        });
      }

      // Also try creator center analytics video cards
      if (results.length === 0) {
        const analyticsItems = document.querySelectorAll(
          '[class*="video-card"], [class*="VideoCard"], [class*="content-item"]'
        );
        for (const item of analyticsItems) {
          if (results.length >= max) break;
          const titleEl = item.querySelector('[class*="title"], [class*="desc"], p');
          const title = (titleEl?.textContent || '').trim();
          const viewsEl = item.querySelector('[class*="views"], [class*="play"], [class*="count"]');
          const views = (viewsEl?.textContent || '').trim();
          const link = item.querySelector('a')?.getAttribute('href') || '';
          const url = link.startsWith('http') ? link : link ? `https://www.tiktok.com${link}` : '';
          if (title || views) {
            results.push({ title: title ? title.slice(0, 100) : '(untitled)', views: views || '—', likes: '—', comments: '—', url });
          }
        }
      }

      return results;
    }, maxVideos);

    console.log(`[Stats] Found ${stats.length} TikTok videos`);
    return stats;
  } catch (err) {
    console.error('[Stats] TikTok scrape error:', err.message);
    return [];
  }
}

// ─── Instagram Reels Stats ──────────────────────────────────
async function scrapeInstagramReelsStats(page, { maxVideos = 10 } = {}) {
  console.log('[Stats] Scraping Instagram Reels stats (agentic mode)...');
  try {
    try { await page.setViewportSize({ width: 1440, height: 900 }); } catch (_) {}

    // Navigate to Instagram home to detect the logged-in username
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // Get the profile username from the sidebar nav
    const username = await page.evaluate(() => {
      // Try to find the profile link in the nav (contains the username in href)
      const profileAnchors = Array.from(document.querySelectorAll('a[href^="/"][href$="/"][role="link"]'));
      for (const a of profileAnchors) {
        const href = (a.getAttribute('href') || '').replace(/\//g, '');
        if (href && href.length > 2 && !href.includes('.') && !/^(explore|reels|home|accounts|direct|stories)$/.test(href)) {
          return href;
        }
      }
      // Also try aria-label containing "profile" which often has the username
      const profileLabel = document.querySelector('[aria-label*="profile" i][href]')?.getAttribute('href') || '';
      return profileLabel.replace(/\//g, '') || '';
    }).catch(() => '');

    // Navigate directly to the Reels tab
    const profileReelsUrl = username
      ? `https://www.instagram.com/${username}/reels/`
      : null;

    if (profileReelsUrl) {
      await page.goto(profileReelsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    } else {
      // Try clicking the profile icon and then the Reels tab
      await page.evaluate(() => {
        const profileLink = document.querySelector('a[href*="/"][role="link"] img[alt*="profile"]')?.closest('a')
          || document.querySelector('[aria-label="Profile"]')
          || Array.from(document.querySelectorAll('a[role="link"]')).find(a => !!a.querySelector('svg[aria-label="Profile"]'));
        if (profileLink) profileLink.click();
      });
      await page.waitForTimeout(2500);

      await page.evaluate(() => {
        const tabs = document.querySelectorAll('a[role="tab"], a[href*="/reels/"]');
        for (const tab of tabs) {
          const text = (tab.textContent || '').toLowerCase();
          const href = tab.getAttribute('href') || '';
          if (text.includes('reels') || href.includes('/reels')) { tab.click(); return; }
        }
        const svgTab = document.querySelector('svg[aria-label="Reels"]')?.closest('a');
        if (svgTab) svgTab.click();
      });
    }

    await page.waitForTimeout(3000);

    // Scroll to load more reels
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    const stats = await page.evaluate((max) => {
      const results = [];
      const seenIds = new Set();

      // Collect all reel links in the grid
      const reelLinks = Array.from(document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));

      for (const link of reelLinks) {
        if (results.length >= max) break;
        const href = link.getAttribute('href') || '';
        if (!href.includes('/reel/') && !href.includes('/p/')) continue;

        const reelIdMatch = href.match(/\/(reel|p)\/([A-Za-z0-9_-]+)/);
        const reelId = reelIdMatch ? reelIdMatch[2] : href;
        if (seenIds.has(reelId)) continue;
        seenIds.add(reelId);

        const url = href.startsWith('http') ? href : `https://www.instagram.com${href}`;

        // Title from image alt or aria-label
        const img = link.querySelector('img');
        const title = (img?.getAttribute('alt') || link.getAttribute('aria-label') || '(reel)').trim();

        // Play/view count: Instagram shows this as an overlay on the thumbnail
        const container = link.closest('div, article, li') || link;
        const overlayEls = container.querySelectorAll('[class*="overlay"], [class*="count"], [class*="play"], [class*="view"]');
        let views = '—';
        for (const el of overlayEls) {
          const t = (el.textContent || '').trim();
          if (/\d/.test(t) && t.length <= 15) { views = t; break; }
        }
        // Also check span elements that are numeric near the link
        if (views === '—') {
          for (const span of container.querySelectorAll('span')) {
            const t = (span.textContent || '').trim();
            if (/^\d[\d,. KMBTkmbt]*$/.test(t)) { views = t; break; }
          }
        }

        results.push({ title: title.slice(0, 80), url, views, likes: '—', comments: '—' });
      }
      return results;
    }, maxVideos);

    console.log(`[Stats] Found ${stats.length} Instagram reels`);
    return stats;
  } catch (err) {
    console.error('[Stats] Instagram scrape error:', err.message);
    return [];
  }
}

// ─── Format stats for Telegram message ──────────────────────
function formatStatsForTelegram(platform, stats) {
  if (!stats || stats.length === 0) return `📊 ${platform}: No videos found`;

  const sectionName = platform === 'YouTube' ? 'Shorts' : platform === 'Instagram' ? 'Reels' : 'Videos';
  let msg = `📊 <b>${platform} ${sectionName} (last ${stats.length})</b>\n\n`;

  stats.forEach((v, i) => {
    const rawTitle = (v.title || '(untitled)');
    // Truncate at 60 chars (57 + '...')
    const title = rawTitle.length > 60 ? rawTitle.slice(0, 57) + '...' : rawTitle;
    msg += `${i + 1}. <b>${title}</b>\n`;
    msg += `   👁 ${v.views} | ❤️ ${v.likes} | 💬 ${v.comments}`;
    msg += '\n';
    if (v.url) msg += `   🔗 ${v.url}\n`;
    msg += '\n';
  });

  return msg.trim();
}

// ─── Standalone stats checker (opens its own browser) ───────
async function checkPlatformStats(platform, credentials) {
  // Use dedicated *-stats session directories to avoid conflicting with active
  // upload browser sessions which use the bare platform name directory.
  const sessionDirs = {
    youtube: path.join(__dirname, '..', 'data', 'browser-sessions', 'youtube-stats'),
    tiktok: path.join(__dirname, '..', 'data', 'browser-sessions', 'tiktok-stats'),
    instagram: path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram-stats'),
  };

  const sessionDir = sessionDirs[platform];
  if (!sessionDir) throw new Error(`Unknown platform: ${platform}`);

  // Always sync session from the main upload session so login cookies stay fresh.
  const uploadSessionDir = path.join(__dirname, '..', 'data', 'browser-sessions', platform);
  syncSessionFromUpload(uploadSessionDir, sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`[Stats] Opening browser for ${platform} stats check...`);
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    viewport: { width: 1440, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    let stats = [];
    const creds = credentials || {};

    if (platform === 'youtube') {
      await ensureYouTubeLogin(page, creds);
      stats = await scrapeYouTubeShortsStats(page, { maxVideos: 20 });
    } else if (platform === 'tiktok') {
      await ensureTikTokLogin(page, creds);
      stats = await scrapeTikTokStats(page, { maxVideos: 20 });
    } else if (platform === 'instagram') {
      await ensureInstagramLogin(page, creds);
      stats = await scrapeInstagramReelsStats(page, { maxVideos: 20 });
    }

    await context.close();
    return stats;
  } catch (err) {
    console.error(`[Stats] ${platform} stats check failed:`, err.message);
    await context.close();
    throw err;
  }
}

// ─── General browser task runner ────────────────────────────
// Opens a fresh browser session and performs an arbitrary natural-language
// task using the AI-guided agentic loop from smart-agent.js.
async function runBrowserTask(task, startUrl) {
  const sessionDir = path.join(__dirname, '..', 'data', 'browser-sessions', 'general-browser');
  fs.mkdirSync(sessionDir, { recursive: true });

  const url = startUrl || 'https://www.google.com';
  console.log(`[Browser] Opening browser for task: "${task}" starting at ${url}`);

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    viewport: { width: 1440, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    let success = false;
    let finalState = 'open';

    try {
      const result = await runAgentTask(page, task, { maxSteps: 15, verbose: true });
      success = result.success;
      finalState = result.finalState;
    } catch (agentErr) {
      console.warn(`[Browser] runAgentTask unavailable: ${agentErr.message}. Browser opened at ${url}.`);
      success = true;
      finalState = 'open';
    }

    const finalUrl = page.url();
    const finalTitle = await page.title().catch(() => 'Unknown');

    let summary;
    if (finalState === 'done') {
      summary = `✅ Browser task completed!\n\nTask: ${task}\nFinal page: ${finalTitle}\nURL: ${finalUrl}`;
    } else if (finalState === 'open') {
      summary = `🌐 Browser opened on your computer!\n\nTask: ${task}\nPage: ${finalTitle}\nURL: ${finalUrl}`;
    } else {
      summary = `⚠️ Browser task ended (${finalState}).\n\nTask: ${task}\nLast page: ${finalTitle}\nURL: ${finalUrl}`;
    }

    await context.close();
    return { success, summary, finalUrl, finalTitle };
  } catch (err) {
    console.error(`[Browser] Task failed:`, err.message);
    await context.close().catch((e) => console.warn('[Browser] context.close failed:', e.message));
    throw err;
  }
}

module.exports = {
  scrapeYouTubeShortsStats,
  scrapeTikTokStats,
  scrapeInstagramReelsStats,
  checkPlatformStats,
  formatStatsForTelegram,
  runBrowserTask,
};
