// Stats scraper — scrapes video stats from YouTube Shorts, TikTok, and Instagram Reels
// using an existing Playwright page/context (reuses browser session from uploaders).

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ─── YouTube Shorts Stats ───────────────────────────────────

async function scrapeYouTubeShortsStats(page, { maxVideos = 10 } = {}) {
  console.log('[Stats] Scraping YouTube Shorts stats...');
  try {
    // Navigate to YouTube Studio
    await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Extract the channel ID from the Studio URL (format: /channel/UCXXXXXXX)
    const studioChannelId = await page.evaluate(() => {
      const m = window.location.href.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
      return m ? m[1] : '';
    }).catch(() => '');

    // Grab the @handle for the public Shorts page fallback
    const channelHandle = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="youtube.com/@"], a[href*="/@"]'));
      for (const link of links) {
        const m = (link.getAttribute('href') || '').match(/\/@([^/?&]+)/);
        if (m) return '@' + m[1];
      }
      return '';
    }).catch(() => '');

    // ── STRATEGY 1: YouTube Studio Innertube API (most reliable) ─────────────
    // Studio is an SPA that uses the Innertube API internally. Since the page
    // already holds a valid session, we can call the same endpoint directly.
    const apiResult = await page.evaluate(async () => {
      try {
        const apiKey = (window.ytcfg && window.ytcfg.get('INNERTUBE_API_KEY')) || '';
        const clientVer = (window.ytcfg && window.ytcfg.get('INNERTUBE_CLIENT_VERSION')) || '1.20250101.00.00';
        if (!apiKey) return null;

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
              context: {
                client: { clientName: 'CREATOR_STUDIO', clientVersion: clientVer },
              },
            }),
          }
        );
        if (!resp.ok) return null;
        return await resp.json();
      } catch (_) { return null; }
    }).catch(() => null);

    if (apiResult) {
      // Try multiple response shapes the Studio API may use
      const videoList =
        apiResult.videos ||
        apiResult.items ||
        apiResult.videoItems ||
        apiResult.videoList?.videoItems ||
        [];

      if (videoList.length > 0) {
        function isDurStr(t) { return /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(t || '').trim()); }

        const seenIds = new Set();
        const apiStats = [];

        for (const v of videoList) {
          if (apiStats.length >= maxVideos) break;

          // Video ID — try multiple field names
          const videoId = v.videoId || v.id || v.video?.videoId || '';
          if (!videoId || seenIds.has(videoId)) continue;
          seenIds.add(videoId);

          // Title — try multiple field shapes
          let title = '';
          if (typeof v.title === 'string' && v.title) title = v.title;
          else if (v.title?.simpleText) title = v.title.simpleText;
          else if (v.title?.runs?.length) title = v.title.runs.map(r => r.text || '').join('');
          else if (typeof v.videoTitle === 'string' && v.videoTitle) title = v.videoTitle;
          else if (v.snippet?.title) title = v.snippet.title;
          else if (v.video?.videoTitle) title = v.video.videoTitle;

          // Skip items whose title is actually a duration string
          if (!title || isDurStr(title)) continue;

          let views = '—', likes = '—', comments = '—';
          const m = v.metrics || v.statistics || {};
          if (m.viewCount !== undefined) {
            views = typeof m.viewCount === 'object'
              ? String(m.viewCount.views ?? m.viewCount.displayValue ?? '—')
              : String(m.viewCount);
          }
          if (m.likeCount !== undefined) {
            likes = typeof m.likeCount === 'object'
              ? String(m.likeCount.likes ?? m.likeCount.displayValue ?? '—')
              : String(m.likeCount);
          }
          if (m.commentCount !== undefined) {
            comments = typeof m.commentCount === 'object'
              ? String(m.commentCount.comments ?? m.commentCount.displayValue ?? '—')
              : String(m.commentCount);
          }

          apiStats.push({ title, videoId, url: `https://youtube.com/shorts/${videoId}`, views, likes, comments });
        }

        if (apiStats.length > 0) {
          console.log(`[Stats] Found ${apiStats.length} YouTube Shorts via Studio Innertube API`);
          return apiStats;
        }
      }
    }

    // ── STRATEGY 2: Navigate to Studio Shorts content page + DOM scraping ────
    if (studioChannelId) {
      await page.goto(
        `https://studio.youtube.com/channel/${studioChannelId}/videos?filter=%5B%7B%22name%22%3A%22VIDEO_TYPE%22%2C%22value%22%3A%22VIDEO_TYPE_SHORT%22%7D%5D`,
        { waitUntil: 'networkidle', timeout: 30000 }
      ).catch(async () => {
        await page.goto(`https://studio.youtube.com/channel/${studioChannelId}/videos`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      });
    } else {
      await page.goto('https://studio.youtube.com/videos', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    }
    await page.waitForTimeout(4000);

    // Click the Shorts tab if visible
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"], tp-yt-paper-tab, a');
      for (const tab of tabs) {
        if ((tab.textContent || '').toLowerCase().trim() === 'shorts') { tab.click(); return; }
      }
    });
    await page.waitForTimeout(3000);

    // DOM scraping with shadow-DOM traversal and deduplication
    const domStats = await page.evaluate((max) => {
      // ── helpers (re-defined inside evaluate so they're serialisable) ─────
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

      // Robust duration check: strip non-visible unicode whitespace before testing
      function isDur(t) {
        const cleaned = String(t || '').replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ').trim();
        return /^\d{1,2}:\d{2}(:\d{2})?$/.test(cleaned);
      }

      function isInsideThumbnail(el) {
        let p = el;
        // 15 levels to reliably traverse nested shadow-DOM roots in YouTube Studio's
        // Polymer component tree (ytcp-video-thumbnail may be several layers deep).
        for (let i = 0; i < 15; i++) {
          if (!p) break;
          const tag = (p.tagName || '').toLowerCase();
          const cls = (p.className || '').toString().toLowerCase();
          const id = (p.id || '').toLowerCase();
          if (
            tag === 'ytcp-video-thumbnail' ||
            cls.includes('thumbnail') ||
            id.includes('thumbnail')
          ) return true;
          p = p.parentElement || (p.getRootNode && p.getRootNode() !== document && p.getRootNode().host) || null;
        }
        return false;
      }

      const results = [];
      const seenIds = new Set();

      // Find video rows (try multiple selectors; shadow DOM included)
      let rows = deepAll(document, 'ytcp-video-row');
      if (rows.length === 0) rows = deepAll(document, 'tr.video-row, [class*="video-row"]');

      for (const row of rows) {
        if (results.length >= max) break;

        // ── Video ID ──────────────────────────────────────────────────────
        let videoId = '';
        for (const link of deepAll(row, 'a[href*="/video/"]')) {
          const m = (link.getAttribute('href') || '').match(/\/video\/([a-zA-Z0-9_-]+)/);
          if (m) { videoId = m[1]; break; }
        }
        if (!videoId || seenIds.has(videoId)) continue;
        seenIds.add(videoId);

        // ── Title ─────────────────────────────────────────────────────────
        // Priority 1: aria-label of the row itself (YouTube Studio sets this to the video title)
        let title = '';
        const rowLabel = (row.getAttribute('aria-label') || '').trim();
        if (rowLabel && !isDur(rowLabel) && rowLabel.length > 2) {
          title = rowLabel;
        }

        // Priority 2: edit/details link aria-label or text (most reliable non-DOM source)
        if (!title) {
          for (const link of deepAll(row, 'a[href*="/edit"], a[href*="/details"]')) {
            const t = (link.getAttribute('aria-label') || link.textContent || '').trim();
            if (!isDur(t) && t.length > 2) { title = t; break; }
          }
        }

        // Priority 3: specific title elements NOT inside the thumbnail
        if (!title) {
          const titleCandidates = deepAll(row, '#video-title, [id="video-title"], [class*="title-text"], h3');
          for (const el of titleCandidates) {
            if (isInsideThumbnail(el)) continue;
            const t = (el.textContent || '').trim();
            if (!isDur(t) && t.length > 2) { title = t; break; }
          }
        }

        // Priority 4: longest leaf-node text that isn't a duration or plain number
        if (!title) {
          let best = '';
          for (const el of deepAll(row, 'span, div')) {
            if (el.childElementCount > 0) continue;
            if (isInsideThumbnail(el)) continue;
            const t = (el.textContent || '').trim();
            if (!isDur(t) && !/^\d+$/.test(t) && t.length > best.length && t.length > 5) best = t;
          }
          title = best;
        }

        if (!title || isDur(title)) continue;

        // ── Stats: aria-label first, positional fallback ──────────────────
        let views = '—', likes = '—', comments = '—';

        for (const el of deepAll(row, '[aria-label]')) {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          const numMatch = (el.textContent || '').trim().match(/[\d,.]+[KMBkmb]?/);
          if (!numMatch) continue;
          const val = numMatch[0].replace(/,/g, '');
          if (/view/i.test(label) && views === '—') views = val;
          else if (/like/i.test(label) && likes === '—') likes = val;
          else if (/comment/i.test(label) && comments === '—') comments = val;
        }

        if (views === '—' || likes === '—' || comments === '—') {
          const nums = [];
          for (const cell of deepAll(row, 'td, [class*="stat"], ytcp-uploads-table-data-for-visibility')) {
            const t = (cell.textContent || '').trim().replace(/,/g, '');
            if (/^\d+(\.\d+)?[KMBkmb]?$/.test(t) && !isDur(t)) nums.push(t);
          }
          if (views === '—' && nums[0]) views = nums[0];
          if (comments === '—' && nums[1]) comments = nums[1];
          if (likes === '—' && nums[2]) likes = nums[2];
        }

        results.push({
          title: title.slice(0, 100),
          url: `https://youtube.com/shorts/${videoId}`,
          views,
          likes,
          comments,
        });
      }
      return results;
    }, maxVideos);

    if (domStats.length > 0) {
      console.log(`[Stats] Found ${domStats.length} YouTube videos (Studio DOM)`);
      return domStats;
    }

    // ── STRATEGY 3: Public channel Shorts page ────────────────────────────
    return await scrapeYouTubeShortsPublic(page, maxVideos, channelHandle, studioChannelId);
  } catch (err) {
    console.error('[Stats] YouTube scrape error:', err.message);
    return [];
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
      // Last resort: navigate to Studio and pick up the channel link from the page
      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 20000 });
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
    await page.goto(shortsUrl, { waitUntil: 'networkidle', timeout: 30000 });
    // Wait for video items to appear
    await page.waitForSelector('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const results = await page.evaluate((max) => {
      // Robust duration check that handles unicode whitespace
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

        // Extract video ID first — require a valid ID to avoid duplicates
        const allLinks = Array.from(item.querySelectorAll('a[href*="/shorts/"], a[href*="/watch?"]'));
        let href = '';
        let shortId = '';
        for (const a of allLinks) {
          const h = a.getAttribute('href') || '';
          const sid = h.match(/\/shorts\/([a-zA-Z0-9_-]+)/)?.[1] || h.match(/[?&]v=([a-zA-Z0-9_-]+)/)?.[1] || '';
          if (sid) { href = h; shortId = sid; break; }
        }
        // Skip items without a valid video ID (prevents duplicates from empty IDs)
        if (!shortId) continue;
        if (seenIds.has(shortId)) continue;
        seenIds.add(shortId);

        const url = href.startsWith('http') ? href : `https://www.youtube.com${href}`;

        // Title: prefer #video-title element text, then title attribute, then link text
        let title = '';
        const titleEl = item.querySelector('a#video-title, h3 a#video-title, yt-formatted-string#video-title, span#video-title');
        if (titleEl) {
          const t = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
          if (t && !isDur(t)) title = t;
        }
        if (!title) {
          // Try title attribute on any anchor link with the shortId
          for (const a of allLinks) {
            const t = (a.getAttribute('title') || a.getAttribute('aria-label') || '').trim();
            if (t && !isDur(t) && t.length > 2) { title = t; break; }
          }
        }
        if (!title) {
          // Fall back to link text, but only if it's not a duration
          for (const a of allLinks) {
            const t = (a.textContent || '').trim();
            if (t && !isDur(t) && t.length > 2) { title = t; break; }
          }
        }
        if (!title || isDur(title)) continue;

        // Views: first metadata span that contains a view count
        let views = '—';
        const metaSpans = item.querySelectorAll('#metadata-line span, .inline-metadata-item, ytd-video-meta-block span, [class*="metadata"] span');
        for (const span of metaSpans) {
          const t = (span.textContent || '').trim();
          if (/\d/.test(t) && (t.toLowerCase().includes('view') || /^\d[\d,.KMBkmb ]*$/i.test(t))) {
            views = t.replace(/\s*views?/i, '').trim() || t;
            break;
          }
        }

        out.push({ title, url, views, comments: '—', likes: '—' });
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
  console.log('[Stats] Scraping TikTok stats...');
  try {
    // Navigate to TikTok analytics/profile
    await page.goto('https://www.tiktok.com/creator-center/analytics', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // If analytics page loaded, try to get video stats
    let stats = await page.evaluate((max) => {
      const results = [];
      // Try analytics content tab
      const videoItems = document.querySelectorAll('[class*="video-card"], [class*="VideoCard"], [data-e2e*="video"]');
      
      for (const item of videoItems) {
        if (results.length >= max) break;
        const title = (item.querySelector('[class*="title"], [class*="desc"], p, span')?.textContent || '').trim();
        const viewsEl = item.querySelector('[class*="views"], [class*="play"]');
        const views = (viewsEl?.textContent || '').trim();
        
        if (title || views) {
          results.push({ title: title || '(untitled)', views: views || '—', likes: '—', comments: '—', url: '' });
        }
      }
      return results;
    }, maxVideos);

    // Fallback: go to profile page
    if (stats.length === 0) {
      await page.goto('https://www.tiktok.com/profile', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);

      stats = await page.evaluate((max) => {
        const results = [];
        const videoItems = document.querySelectorAll('[data-e2e="user-post-item"], [class*="DivItemContainer"], [class*="video-feed-item"]');
        
        for (const item of videoItems) {
          if (results.length >= max) break;
          const desc = (item.getAttribute('aria-label') || item.querySelector('[class*="desc"]')?.textContent || '').trim();
          const viewsEl = item.querySelector('[data-e2e="video-views"], [class*="video-count"], strong');
          const views = (viewsEl?.textContent || '').trim();
          const link = item.querySelector('a')?.getAttribute('href') || '';
          const url = link.startsWith('http') ? link : link ? `https://www.tiktok.com${link}` : '';

          results.push({ title: desc || '(untitled)', views: views || '—', likes: '—', comments: '—', url });
        }
        return results;
      }, maxVideos);
    }

    console.log(`[Stats] Found ${stats.length} TikTok videos`);
    return stats;
  } catch (err) {
    console.error('[Stats] TikTok scrape error:', err.message);
    return [];
  }
}

// ─── Instagram Reels Stats ──────────────────────────────────
async function scrapeInstagramReelsStats(page, { maxVideos = 10 } = {}) {
  console.log('[Stats] Scraping Instagram Reels stats...');
  try {
    // Navigate to profile reels tab
    // First get username
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Click profile
    await page.evaluate(() => {
      const profileLink = document.querySelector('a[href*="/"][role="link"] img[alt*="profile"]')?.closest('a') 
        || document.querySelector('[aria-label="Profile"]')
        || Array.from(document.querySelectorAll('a[role="link"]')).find(a => {
          const svg = a.querySelector('svg[aria-label="Profile"]');
          return !!svg;
        });
      if (profileLink) profileLink.click();
    });
    await page.waitForTimeout(3000);

    // Click Reels tab
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('a[role="tab"], a[href*="/reels/"]');
      for (const tab of tabs) {
        const text = (tab.textContent || '').toLowerCase();
        const href = tab.getAttribute('href') || '';
        if (text.includes('reels') || href.includes('/reels')) {
          tab.click();
          return true;
        }
      }
      // Also try SVG-based tab
      const svgTab = document.querySelector('svg[aria-label="Reels"]')?.closest('a');
      if (svgTab) svgTab.click();
      return false;
    });
    await page.waitForTimeout(3000);

    const stats = await page.evaluate((max) => {
      const results = [];
      const items = document.querySelectorAll('article a[href*="/reel/"], div[class*="reel"] a, a[href*="/p/"]');
      
      for (const item of items) {
        if (results.length >= max) break;
        const href = item.getAttribute('href') || '';
        if (!href.includes('/reel/') && !href.includes('/p/')) continue;
        
        const url = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
        
        // Instagram shows play count on hover - try to get from aria/overlay
        const overlay = item.querySelector('[class*="overlay"], [class*="count"]');
        const views = (overlay?.textContent || '').trim();
        
        const img = item.querySelector('img');
        const title = img?.getAttribute('alt') || '(reel)';

        results.push({ title: title.slice(0, 80), url, views: views || '—', likes: '—', comments: '—' });
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

  // If the dedicated stats session doesn't exist yet, try to copy cookies from the
  // main upload session so the user doesn't have to log in again.
  const uploadSessionDir = path.join(__dirname, '..', 'data', 'browser-sessions', platform);
  if (!fs.existsSync(sessionDir) && fs.existsSync(uploadSessionDir)) {
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      // Skip Chromium lock / socket / temporary files that must not be copied
      const SKIP_FILES = new Set([
        'SingletonLock', 'SingletonSocket', 'SingletonCookie',
        'lockfile', '.lock',
      ]);
      const files = fs.readdirSync(uploadSessionDir).filter(f => !SKIP_FILES.has(f) && !f.endsWith('.tmp'));
      for (const file of files) {
        const src = path.join(uploadSessionDir, file);
        const dst = path.join(sessionDir, file);
        try {
          const stat = fs.statSync(src);
          if (stat.isFile()) {
            fs.copyFileSync(src, dst);
          } else if (stat.isDirectory()) {
            fs.cpSync(src, dst, { recursive: true });
          }
        } catch (_) {}
      }
      console.log(`[Stats] Copied browser session from ${platform} to ${platform}-stats`);
    } catch (copyErr) {
      console.warn(`[Stats] Could not copy session: ${copyErr.message}`);
    }
  }

  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`[Stats] Opening browser for ${platform} stats check...`);
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    let stats = [];

    if (platform === 'youtube') {
      stats = await scrapeYouTubeShortsStats(page, { maxVideos: 20 });
    } else if (platform === 'tiktok') {
      stats = await scrapeTikTokStats(page, { maxVideos: 20 });
    } else if (platform === 'instagram') {
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

module.exports = {
  scrapeYouTubeShortsStats,
  scrapeTikTokStats,
  scrapeInstagramReelsStats,
  checkPlatformStats,
  formatStatsForTelegram,
};
