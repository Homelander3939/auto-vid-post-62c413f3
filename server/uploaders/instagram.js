const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill, analyzePage, waitForStateChange, runAgentTask } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram');
const MAX_CAPTION_LENGTH = 2200;
// How long to wait for the user's reels grid to load after navigating to their profile
const PROFILE_REELS_LOAD_WAIT_MS = 6000;
const INSTAGRAM_SHARE_READY_MAX_WAIT_MS = 180000;
const INSTAGRAM_SHARE_PROCESSING_MAX_WAIT_MS = 180000;
const INSTAGRAM_PROFILE_PUBLISH_WAIT_ATTEMPTS = 12;
const INSTAGRAM_PROFILE_PUBLISH_WAIT_INTERVAL_MS = 3000;
const INSTAGRAM_QUICK_PROFILE_LOAD_WAIT_MS = 1200;

function normalizeInstagramPostUrl(candidate = '') {
  const raw = String(candidate || '').trim();
  if (!raw) return '';

  let absolute = raw;
  if (raw.startsWith('/')) {
    absolute = `https://www.instagram.com${raw}`;
  } else if (!/^https?:\/\//i.test(raw)) {
    absolute = `https://${raw.replace(/^\/+/, '')}`;
  }

  try {
    const parsed = new URL(absolute);
    const mediaMatch = parsed.pathname.match(/^\/(p|reel)\/([A-Za-z0-9_-]+)/i);
    if (!parsed.hostname.includes('instagram.com') || !mediaMatch) return '';
    return `https://www.instagram.com/${mediaMatch[1].toLowerCase()}/${mediaMatch[2]}/`;
  } catch {
    return '';
  }
}

async function resolveInstagramUsername(page) {
  return page.evaluate(() => {
    const blacklist = new Set(['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'create', 'stories', 'inbox']);

    const navSelectors = [
      'nav a[href^="/"][aria-label*="Profile" i]',
      'nav a[href^="/"][role="link"]',
      'a[href^="/"][aria-label*="Profile" i]',
    ];
    for (const sel of navSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const href = (el.getAttribute('href') || '').replace(/\/$/, '');
      const match = href.match(/^\/([a-zA-Z0-9._]+)$/);
      if (match && !blacklist.has(match[1])) return match[1];
    }

    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    for (const link of allLinks) {
      const href = (link.getAttribute('href') || '').replace(/\/$/, '');
      const match = href.match(/^\/([a-zA-Z0-9._]{3,30})$/);
      if (match && !blacklist.has(match[1])) return match[1];
    }

    return '';
  }).catch(() => '');
}

async function fetchRecentInstagramPostUrlsFromProfile(page, username, attempts = 4, limit = 8) {
  if (!username) return [];

  const profileUrls = [
    `https://www.instagram.com/${username}/reels/`,
    `https://www.instagram.com/${username}/`,
  ];

  for (const profileUrl of profileUrls) {
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch {
      continue;
    }

    for (let retry = 0; retry < attempts; retry++) {
      await page.waitForTimeout(retry === 0 ? PROFILE_REELS_LOAD_WAIT_MS : 10000);
      await page.evaluate(() => window.scrollTo({ top: 420, behavior: 'smooth' })).catch(() => {});
      await page.waitForTimeout(1000);

      const urls = await page.evaluate((maxItems) => {
        const scope = document.querySelector('main, [role="main"]') || document;
        const links = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
        const collected = [];
        const seen = new Set();

        for (const link of links) {
          const href = (link.getAttribute('href') || '').trim();
          if (!href) continue;
          const absolute = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          if (seen.has(absolute)) continue;
          seen.add(absolute);
          collected.push(absolute);
          if (collected.length >= maxItems) break;
        }

        return collected;
      }, limit).catch(() => []);

      const normalized = (Array.isArray(urls) ? urls : [])
        .map((url) => normalizeInstagramPostUrl(url))
        .filter(Boolean);

      if (normalized.length > 0) {
        return Array.from(new Set(normalized));
      }
    }
  }

  return [];
}

async function fetchLatestInstagramPostUrlFromProfile(page, username, attempts = 4) {
  const urls = await fetchRecentInstagramPostUrlsFromProfile(page, username, attempts, 1);
  return urls[0] || '';
}

async function fetchRecentInstagramPostUrlsQuick(page, username, limit = 8) {
  if (!username) return [];

  const profileUrls = [
    `https://www.instagram.com/${username}/reels/`,
    `https://www.instagram.com/${username}/`,
  ];

  for (const profileUrl of profileUrls) {
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(INSTAGRAM_QUICK_PROFILE_LOAD_WAIT_MS);

      let urls = await page.evaluate((maxItems) => {
        const scope = document.querySelector('main, [role="main"]') || document;
        const links = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
        const seen = new Set();
        const collected = [];

        for (const link of links) {
          const href = (link.getAttribute('href') || '').trim();
          if (!href) continue;
          const absolute = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          if (seen.has(absolute)) continue;
          seen.add(absolute);
          collected.push(absolute);
          if (collected.length >= maxItems) break;
        }

        return collected;
      }, limit).catch(() => []);

      if (!urls.length) {
        await page.evaluate(() => window.scrollTo({ top: 420, behavior: 'smooth' })).catch(() => {});
        await page.waitForTimeout(1000);
        urls = await page.evaluate((maxItems) => {
          const scope = document.querySelector('main, [role="main"]') || document;
          const links = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
          const seen = new Set();
          const collected = [];

          for (const link of links) {
            const href = (link.getAttribute('href') || '').trim();
            if (!href) continue;
            const absolute = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
            if (seen.has(absolute)) continue;
            seen.add(absolute);
            collected.push(absolute);
            if (collected.length >= maxItems) break;
          }

          return collected;
        }, limit).catch(() => []);
      }

      const normalized = (Array.isArray(urls) ? urls : [])
        .map((url) => normalizeInstagramPostUrl(url))
        .filter(Boolean);

      if (normalized.length > 0) {
        return Array.from(new Set(normalized));
      }
    } catch {}
  }

  return [];
}

async function waitForInstagramShareButtonReady(page, maxWaitMs = INSTAGRAM_SHARE_READY_MAX_WAIT_MS) {
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const scope = dialog || document;
      const text = (scope.textContent || '').toLowerCase();

      const buttons = Array.from(scope.querySelectorAll('button, div[role="button"]'));
      const shareBtn = buttons.find((btn) => {
        const label = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        const btnText = (btn.textContent || '').trim().toLowerCase();
        return btnText === 'share' || btnText === 'post' || btnText === 'publish' || label === 'share' || label === 'post' || label === 'publish';
      });

      const style = shareBtn ? window.getComputedStyle(shareBtn) : null;
      const rect = shareBtn ? shareBtn.getBoundingClientRect() : null;
      const visible = !!(
        shareBtn &&
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        style &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );

      const enabled = !!(
        visible &&
        shareBtn &&
        !shareBtn.disabled &&
        shareBtn.getAttribute('aria-disabled') !== 'true' &&
        !String(shareBtn.className || '').toLowerCase().includes('disabled') &&
        (!style || style.pointerEvents !== 'none')
      );

      const isProcessing =
        text.includes('processing') ||
        text.includes('sharing...') ||
        text.includes('posting') ||
        text.includes('uploading') ||
        text.includes('preparing');

      const isShared =
        text.includes('your post has been shared') ||
        text.includes('your reel has been shared') ||
        text.includes('post shared') ||
        text.includes('reel shared');

      return {
        hasDialog: !!dialog,
        visible,
        enabled,
        isProcessing,
        isShared,
      };
    }).catch(() => ({ hasDialog: false, visible: false, enabled: false, isProcessing: false, isShared: false }));

    if (state.enabled) {
      return { ready: true, reason: 'Share button is visible and enabled.' };
    }
    if (state.isShared) {
      return { ready: false, alreadyShared: true, reason: 'Instagram already shows shared confirmation.' };
    }

    console.log('[Instagram] Waiting for Share button to become enabled...');
    await page.waitForTimeout(3000);
  }

  return { ready: false, alreadyShared: false, reason: 'Share button did not become enabled in time.' };
}

async function openLatestInstagramPostAndCaptureUrl(page, username, options = {}) {
  if (!username) return '';

  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 2500;
  const afterClickMs = Number.isFinite(options.afterClickMs) ? options.afterClickMs : 2000;
  const captureTimeoutMs = Number.isFinite(options.captureTimeoutMs) ? options.captureTimeoutMs : 8000;

  const profileUrls = [
    `https://www.instagram.com/${username}/reels/`,
    `https://www.instagram.com/${username}/`,
  ];

  for (const profileUrl of profileUrls) {
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(settleMs);

      const clickedHref = await page.evaluate(() => {
        const scope = document.querySelector('main, [role="main"]') || document;
        const links = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
        const first = links[0];
        if (!first) return '';

        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return first.getAttribute('href') || '';
      }).catch(() => '');

      await page.waitForTimeout(afterClickMs);

      const openedMediaUrl = await page.waitForFunction(() => {
        const href = window.location.href;
        if (/\/\/(?:www\.)?instagram\.com\/(?:reel|p)\//i.test(href)) return href;

        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          const mediaLink = dialog.querySelector('a[href*="/reel/"], a[href*="/p/"]');
          if (mediaLink) {
            const mediaHref = mediaLink.getAttribute('href') || '';
            return mediaHref.startsWith('http') ? mediaHref : `https://www.instagram.com${mediaHref}`;
          }
        }

        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
        if (/\/\/(?:www\.)?instagram\.com\/(?:reel|p)\//i.test(canonical)) return canonical;

        return '';
      }, { timeout: captureTimeoutMs }).then((handle) => handle.jsonValue()).catch(() => '');

      const normalized = normalizeInstagramPostUrl(openedMediaUrl)
        || normalizeInstagramPostUrl(clickedHref)
        || normalizeInstagramPostUrl(page.url());

      if (normalized) {
        console.log(`[Instagram] Opened latest reel/post and captured URL: ${normalized}`);
        return normalized;
      }
    } catch {}
  }

  return '';
}

async function clickInstagramShareButton(page) {
  let shareClicked = await page.evaluate(() => {
    const dialogEl = document.querySelector('[role="dialog"]') || document.body;
    const buttons = dialogEl.querySelectorAll('button, div[role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const disabled =
        btn.disabled ||
        btn.getAttribute('aria-disabled') === 'true' ||
        String(btn.className || '').toLowerCase().includes('disabled');
      if (disabled) continue;
      if (text === 'share' || text === 'post' || text === 'publish' || label === 'share' || label === 'post' || label === 'publish') {
        btn.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);

  if (!shareClicked) {
    shareClicked = await smartClick(page, [
      '[role="dialog"] button:has-text("Share")',
      '[role="dialog"] [aria-label="Share"]',
      'button:has-text("Share")',
      '[aria-label="Share"]',
      'div[role="button"]:has-text("Share")',
      'button:has-text("Post")',
      'button:has-text("Publish")',
    ], 'Share');
  }

  if (!shareClicked) {
    console.log('[Instagram] Standard Share button not found, trying agent with vision...');
    try {
      const agentResult = await runAgentTask(page,
        'Find and click the blue "Share" button inside the Instagram post creation dialog to publish this reel. Do NOT scroll the page background — only interact with the dialog popup.',
        { maxSteps: 5, stepDelayMs: 600, useVision: true });
      shareClicked = agentResult.success;
    } catch (e) {
      console.warn('[Instagram] Agent share-click failed:', e.message);
    }
  }

  return shareClicked;
}

async function closeInstagramShareResultPopup(page) {
  const closed = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;

    const closeSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label*="close" i]',
      'div[role="button"][aria-label="Close"]',
      'svg[aria-label="Close"]',
    ];

    for (const sel of closeSelectors) {
      const node = dialog.querySelector(sel);
      if (!node) continue;
      const clickable = node.closest('button, [role="button"], a') || node;
      clickable.click();
      return true;
    }

    const buttons = Array.from(dialog.querySelectorAll('button, div[role="button"]'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text === 'done' || text === 'close' || text === 'not now') {
        btn.click();
        return true;
      }
    }

    return false;
  }).catch(() => false);

  if (!closed) {
    await page.keyboard.press('Escape').catch(() => {});
  }

  if (closed) {
    await page.waitForTimeout(800);
  }

  return closed;
}

async function waitForNewInstagramPostUrl(page, username, baselineUrls = [], attempts = INSTAGRAM_PROFILE_PUBLISH_WAIT_ATTEMPTS) {
  if (!username) return '';

  const baselineSet = new Set(
    (Array.isArray(baselineUrls) ? baselineUrls : [])
      .map((url) => normalizeInstagramPostUrl(url))
      .filter(Boolean),
  );

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await closeInstagramShareResultPopup(page);

    // Primary strategy requested by user behavior:
    // after share confirmation, open profile -> open latest reel tile -> capture URL.
    const openedLatestUrl = await openLatestInstagramPostAndCaptureUrl(page, username, {
      settleMs: INSTAGRAM_QUICK_PROFILE_LOAD_WAIT_MS,
      afterClickMs: 900,
      captureTimeoutMs: 3500,
    });
    if (openedLatestUrl && !baselineSet.has(openedLatestUrl)) {
      return openedLatestUrl;
    }

    // Quick profile-grid poll for a newly appeared reel/post.
    const quickRecentUrls = await fetchRecentInstagramPostUrlsQuick(page, username, 8);
    const quickNewUrl = quickRecentUrls.find((url) => url && !baselineSet.has(url)) || '';
    if (quickNewUrl) {
      return quickNewUrl;
    }

    // Periodic deep fallback in case quick DOM sampling misses a delayed grid refresh.
    if (attempt % 4 === 0) {
      const deepRecentUrls = await fetchRecentInstagramPostUrlsFromProfile(page, username, 1, 8);
      const deepNewUrl = deepRecentUrls.find((url) => url && !baselineSet.has(url)) || '';
      if (deepNewUrl) {
        return deepNewUrl;
      }
    }

    console.log(`[Instagram] Waiting for new published post URL on profile... (${attempt}/${attempts})`);
    if (attempt < attempts) {
      await page.waitForTimeout(INSTAGRAM_PROFILE_PUBLISH_WAIT_INTERVAL_MS);
    }
  }

  return '';
}

async function waitForInstagramSharingToFinish(page, maxWaitMs = INSTAGRAM_SHARE_PROCESSING_MAX_WAIT_MS) {
  const started = Date.now();
  let seenProcessing = false;

  while (Date.now() - started < maxWaitMs) {
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const scope = dialog || document;
      const text = (scope.textContent || '').toLowerCase();
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const url = window.location.href;

      const isProcessing =
        text.includes('sharing...') ||
        text.includes('processing') ||
        text.includes('posting') ||
        text.includes('uploading') ||
        bodyText.includes('sharing...') ||
        bodyText.includes('processing') ||
        bodyText.includes('posting') ||
        bodyText.includes('uploading');

      const isShared =
        text.includes('your post has been shared') ||
        text.includes('your reel has been shared') ||
        text.includes('post shared') ||
        text.includes('reel shared') ||
        text.includes('shared successfully') ||
        bodyText.includes('your post has been shared') ||
        bodyText.includes('your reel has been shared') ||
        bodyText.includes('post shared') ||
        bodyText.includes('reel shared') ||
        bodyText.includes('shared successfully');

      return {
        hasDialog: !!dialog,
        isProcessing,
        isShared,
        redirectedToFeed: url === 'https://www.instagram.com/' || url === 'https://instagram.com/',
      };
    }).catch(() => ({ hasDialog: false, isProcessing: false, isShared: false, redirectedToFeed: false }));

    if (state.isProcessing) {
      seenProcessing = true;
      console.log('[Instagram] Share popup still processing...');
      await page.waitForTimeout(2000);
      continue;
    }

    if (state.isShared) {
      return { finished: true, reason: 'Instagram shows a shared confirmation.' };
    }

    if (seenProcessing && !state.isProcessing) {
      return {
        finished: true,
        reason: state.redirectedToFeed
          ? 'Instagram returned to feed after processing.'
          : 'Instagram processing state disappeared.',
      };
    }

    if (!state.hasDialog && state.redirectedToFeed) {
      return { finished: true, reason: 'Instagram closed popup and returned to feed.' };
    }

    await page.waitForTimeout(2000);
  }

  return { finished: false, reason: 'Instagram sharing/loading did not finish in time.' };
}

async function extractInstagramPostUrl(page) {
  // Only look for post/reel links inside a success-confirmation context (dialog, notification,
  // "View" button area).  Do NOT scan the whole page — the homepage/feed contains links from
  // other users that would be returned as false positives.
  return page.evaluate(() => {
    const successSelectors = [
      '[role="dialog"]',
      '[aria-label*="Post shared" i]',
      '[aria-label*="Reel shared" i]',
      '[aria-label*="Shared" i]',
    ];

    for (const containerSel of successSelectors) {
      const container = document.querySelector(containerSel);
      if (!container) continue;
      const text = (container.textContent || '').toLowerCase();
      const isSuccessContext =
        text.includes('shared') ||
        text.includes('published') ||
        text.includes('your post') ||
        text.includes('your reel') ||
        text.includes('view');
      if (!isSuccessContext) continue;

      for (const a of container.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/p/') || href.includes('/reel/')) {
          const normalized = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          return normalized;
        }
      }
    }
    return '';
  }).then((url) => normalizeInstagramPostUrl(url)).catch(() => '');
}

async function assessInstagramCompletion(page) {
  const dom = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    
    const success =
      text.includes('your post has been shared') ||
      text.includes('your reel has been shared') ||
      text.includes('post shared') ||
      text.includes('reel shared') ||
      text.includes('your video has been shared') ||
      text.includes('shared successfully');
    
    const isStillInDialog = text.includes('sharing...') || text.includes('processing');
    
    const hardError =
      text.includes('couldn\'t share') ||
      text.includes('try again') ||
      text.includes('upload failed') ||
      text.includes('something went wrong');
    
    return { success, isStillInDialog, hardError, summary: text.slice(0, 1200) };
  }).catch(() => ({ success: false, isStillInDialog: false, hardError: false, summary: '' }));

  if (dom.success) return { success: true, reason: 'Instagram UI confirms share/upload completion.' };
  if (dom.isStillInDialog) return { success: false, needsHuman: false, reason: 'Instagram is still processing the share.' };
  if (dom.hardError) return { success: false, needsHuman: true, reason: 'Instagram UI shows a blocking share/upload error.' };

  try {
    const ai = await analyzePage(page, 'Instagram post completion check. Decide whether posting succeeded or needs manual action.');
    const state = String(ai?.state || '').toLowerCase();
    if (['success', 'shared', 'completed', 'published', 'done'].includes(state)) {
      return { success: true, reason: ai?.description || 'AI detected successful/processing completion state.' };
    }
    if (['processing', 'uploading', 'pending'].includes(state)) {
      return { success: false, needsHuman: false, reason: ai?.description || 'Instagram is still processing the share.' };
    }
    return {
      success: false,
      needsHuman: Boolean(ai?.needs_human),
      reason: ai?.description || 'No clear Instagram completion signal found.',
    };
  } catch {
    return { success: false, needsHuman: false, reason: 'No clear Instagram completion signal found.' };
  }
}

async function uploadToInstagram(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[Instagram] Starting upload...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  // Handle native browser beforeunload dialogs
  page.on('dialog', async (dialog) => {
    console.log(`[Instagram] Browser dialog: "${dialog.message()}" — dismissing`);
    await dialog.dismiss().catch(() => {});
  });

  try {
    // ===== PHASE 1: LOGIN =====
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie dialog
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('allow') || text.includes('accept') || text.includes('decline optional')) { btn.click(); break; }
      }
    });
    await page.waitForTimeout(1000);

    let loginAttempts = 0;
    while (loginAttempts++ < 15) {
      const isLoggedIn = await page.evaluate(() => {
        return !!(document.querySelector('[aria-label="New post"]') ||
                  document.querySelector('svg[aria-label="New post"]') ||
                  document.querySelector('[aria-label="Home"]') ||
                  document.querySelector('a[href="/direct/inbox/"]') ||
                  document.querySelector('[aria-label="Search"]'));
      });
      if (isLoggedIn) { console.log('[Instagram] Logged in'); break; }

      const url = page.url();
      if (url.includes('login') || url.includes('accounts')) {
        const pageState = await page.evaluate(() => ({
          hasUsername: !!document.querySelector('input[name="username"]'),
          hasPassword: !!document.querySelector('input[name="password"]'),
          hasCode: !!document.querySelector('input[name="verificationCode"], input[name="security_code"]'),
        }));

        if (pageState.hasUsername && pageState.hasPassword) {
          console.log('[Instagram] Filling login...');
          await smartFill(page, ['input[name="username"]'], credentials.email);
          await page.waitForTimeout(300);
          await smartFill(page, ['input[name="password"]'], credentials.password);
          await page.waitForTimeout(300);
          await smartClick(page, ['button[type="submit"]'], 'Log In');
          await page.waitForTimeout(5000);

          // Dismiss popups ("Not Now" for save login, notifications, etc.)
          for (let i = 0; i < 3; i++) {
            await page.evaluate(() => {
              const buttons = document.querySelectorAll('button');
              for (const btn of buttons) {
                if (btn.textContent?.toLowerCase().includes('not now')) { btn.click(); break; }
              }
            });
            await page.waitForTimeout(1500);
          }
          continue;
        }

        if (pageState.hasCode) {
          console.log('[Instagram] Verification code needed...');
          const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
          const approval = await requestTelegramApproval({
            telegram: credentials.telegram,
            platform: 'Instagram',
            backend: credentials.backend,
            screenshotBuffer,
            customMessage: '🔐 <b>Instagram verification needed</b>\nReply with APPROVED after device confirmation or CODE 123456 if a code is required.',
          });
          if (approval?.code) {
            await tryFillVerificationCode(page, approval.code);
            await page.waitForTimeout(5000);
          }
          continue;
        }
      }
      await page.waitForTimeout(3000);
    }

    const loggedIn = await page.evaluate(() => {
      return !!(document.querySelector('[aria-label="New post"]') ||
                document.querySelector('svg[aria-label="New post"]') ||
                document.querySelector('[aria-label="Home"]') ||
                document.querySelector('[aria-label="Search"]'));
    });
    if (!loggedIn) throw new Error('Instagram login failed. Try logging in manually first.');

    // Capture baseline latest post URL before starting a new upload to prevent false-success
    // links (old posts from profile grid).
    let profileUsername = '';
    let baselineProfilePostUrls = [];
    let latestPostBeforeUpload = '';
    try {
      profileUsername = await resolveInstagramUsername(page);
      if (profileUsername) {
        baselineProfilePostUrls = await fetchRecentInstagramPostUrlsFromProfile(page, profileUsername, 2, 8);
        latestPostBeforeUpload = baselineProfilePostUrls[0] || '';
        if (latestPostBeforeUpload) {
          console.log(`[Instagram] Baseline latest post URL before upload: ${latestPostBeforeUpload}`);
        }
      }
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    } catch (baselineErr) {
      console.warn('[Instagram] Could not capture baseline latest post URL (non-fatal):', baselineErr.message);
    }

    // ===== PHASE 2: CREATE NEW POST =====
    console.log('[Instagram] Creating new post...');
    
    // Try multiple ways to open new post dialog
    let newPostClicked = await smartClick(page, [
      '[aria-label="New post"]',
      'svg[aria-label="New post"]',
      '[aria-label="Create"]',
      'svg[aria-label="Create"]',
      '[aria-label="New Post"]',
      'svg[aria-label="New Post"]',
      'a[href="/create/style/"]',
      'a[href="/create/select/"]',
    ], 'New post');
    
    if (!newPostClicked) {
      newPostClicked = await page.evaluate(() => {
        // Try SVG-based icons with various labels
        const svgLabels = ['New post', 'Create', 'New Post', 'Новая публикация', 'Crear'];
        for (const label of svgLabels) {
          const svg = document.querySelector(`svg[aria-label="${label}"]`);
          if (svg) {
            const parent = svg.closest('a, button, div[role="button"], span[role="link"]');
            if (parent) { parent.click(); return true; }
            svg.click();
            return true;
          }
        }
        // Try nav links with create-related paths
        const navLinks = document.querySelectorAll('a[href*="create"], a[href*="new"]');
        for (const link of navLinks) {
          link.click();
          return true;
        }
        // Try finding the create/plus icon by its typical position (left sidebar)
        const sidebarLinks = document.querySelectorAll('nav a, nav div[role="button"], [role="navigation"] a');
        for (const link of sidebarLinks) {
          const text = (link.textContent || '').trim().toLowerCase();
          const label = (link.getAttribute('aria-label') || '').toLowerCase();
          if (text.includes('create') || text.includes('new post') ||
              label.includes('create') || label.includes('new post')) {
            link.click();
            return true;
          }
        }
        return false;
      });
    }
    
    // Agent fallback: use LLM with vision to find the Create button
    if (!newPostClicked) {
      console.log('[Instagram] Standard selectors failed, trying agent to find Create button...');
      try {
        const agentResult = await runAgentTask(page,
          'On Instagram\'s main page, find and click the "Create" or "New post" button in the left sidebar navigation. It usually has a plus (+) icon.',
          { maxSteps: 5, stepDelayMs: 500 });
        newPostClicked = agentResult.success;
      } catch (e) {
        console.warn('[Instagram] Agent create-button click failed:', e.message);
      }
    }
    
    if (!newPostClicked) {
      throw new Error('Instagram: Could not find Create/New post button. Make sure you are logged in.');
    }

    await page.waitForTimeout(3000);

    // ===== PHASE 3: SELECT VIDEO FILE =====
    console.log('[Instagram] Setting video file...');
    let fileUploaded = false;

    // Strategy 1: Direct file input (may already be visible from the dialog)
    let fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      try {
        await fileInput.setInputFiles(videoPath);
        fileUploaded = true;
        console.log('[Instagram] Video set via direct file input');
      } catch (e) {
        console.warn('[Instagram] Direct setInputFiles failed:', e.message);
      }
    }

    // Strategy 2: Click "Select from computer" then use fileChooser
    if (!fileUploaded) {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          (async () => {
            const clicked = await smartClick(page, [
              'button:has-text("Select from computer")',
              'button:has-text("Select From Computer")',
              'button:has-text("Select from Computer")',
              'button:has-text("Select")',
              'button:has-text("Choose")',
            ], 'Select from computer');
            if (!clicked) {
              await page.evaluate(() => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                  const text = (btn.textContent || '').toLowerCase();
                  if (text.includes('select') || text.includes('computer') || text.includes('choose')) {
                    btn.click();
                    return;
                  }
                }
              });
            }
          })(),
        ]);
        await fileChooser.setFiles(videoPath);
        fileUploaded = true;
        console.log('[Instagram] Video set via fileChooser + Select from computer');
      } catch (e) {
        console.warn('[Instagram] fileChooser with Select button failed:', e.message);
      }
    }

    // Strategy 3: Force-discover hidden file inputs
    if (!fileUploaded) {
      const discovered = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length > 0) {
          inputs[0].style.display = 'block';
          inputs[0].style.opacity = '1';
          inputs[0].style.position = 'fixed';
          inputs[0].style.top = '0';
          inputs[0].style.left = '0';
          inputs[0].style.zIndex = '999999';
          return true;
        }
        return false;
      });
      if (discovered) {
        fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          try {
            await fileInput.setInputFiles(videoPath);
            fileUploaded = true;
            console.log('[Instagram] Video set via forced file input');
          } catch {}
        }
      }
    }

    // Strategy 4: Agent fallback
    if (!fileUploaded) {
      console.log('[Instagram] Trying agent to find file upload...');
      try {
        const agentResult = await runAgentTask(page,
          'Find and click the "Select from computer" or similar button to open a file upload dialog on Instagram\'s create post dialog.',
          { maxSteps: 5, stepDelayMs: 500 });
        if (agentResult.success) {
          // Try file input again after agent interaction
          fileInput = await page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.setInputFiles(videoPath);
            fileUploaded = true;
          }
        }
      } catch {}
    }
    
    if (!fileUploaded) throw new Error('Instagram upload dialog not found. Try creating a post manually first to verify your session.');

    console.log('[Instagram] Video file set, waiting for upload dialog to render...');
    await page.waitForTimeout(3000);

    // Wait for the upload dialog/modal to appear
    const dialogAppeared = await page.waitForSelector('[role="dialog"], [aria-label*="create" i], [aria-label*="post" i]', { timeout: 10000 })
      .then(() => true).catch(() => false);
    if (dialogAppeared) {
      console.log('[Instagram] Upload dialog detected');
    } else {
      console.log('[Instagram] Dialog not detected by selector, proceeding anyway');
    }

    // ===== PHASE 3.5: SELECT PORTRAIT (9:16) ASPECT RATIO ON CROP SCREEN =====
    // Instagram defaults to square/4:3 crop — we MUST select 9:16 for vertical Reels
    console.log('[Instagram] Selecting 9:16 portrait aspect ratio for Reels...');
    let aspectRatioSet = false;

    for (let attempt = 0; attempt < 3 && !aspectRatioSet; attempt++) {
      try {
        if (attempt > 0) await page.waitForTimeout(2000);

        // Step A: Find ALL icon-like buttons in the bottom area of the dialog
        // and click the crop/resize toggle (typically bottom-left, small SVG icon)
        const cropToggleResult = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return { error: 'no dialog' };
          const dialogRect = dialog.getBoundingClientRect();

          // Gather all clickable elements with SVGs inside the dialog
          const candidates = [];
          const clickables = dialog.querySelectorAll('button, div[role="button"], [role="button"], span[role="button"]');
          for (const el of clickables) {
            const svg = el.querySelector('svg');
            if (!svg) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) continue;
            // Must be in the bottom 30% of the dialog
            const relTop = rect.top - dialogRect.top;
            const relLeft = rect.left - dialogRect.left;
            const inBottomArea = relTop > dialogRect.height * 0.65;
            const inLeftHalf = relLeft < dialogRect.width * 0.5;
            candidates.push({
              el,
              rect,
              relTop,
              relLeft,
              inBottomArea,
              inLeftHalf,
              width: rect.width,
              height: rect.height,
              pathCount: svg.querySelectorAll('path, line, polyline, polygon, rect, circle').length
            });
          }

          // Log what we found for debugging
          const debugInfo = candidates.map((c, i) => 
            `btn${i}: ${Math.round(c.relLeft)}x${Math.round(c.relTop)} size=${Math.round(c.width)}x${Math.round(c.height)} bottom=${c.inBottomArea} left=${c.inLeftHalf} paths=${c.pathCount}`
          );

          // Filter to bottom-left candidates (the crop toggle area)
          const bottomLeftBtns = candidates.filter(c => c.inBottomArea && c.inLeftHalf && c.width < 80 && c.height < 80);
          
          if (bottomLeftBtns.length > 0) {
            // Click the leftmost bottom button (crop/resize toggle)
            bottomLeftBtns.sort((a, b) => a.relLeft - b.relLeft);
            bottomLeftBtns[0].el.click();
            return { clicked: 'bottom-left-icon', debug: debugInfo };
          }

          // Broader fallback: any small SVG button in bottom area
          const bottomBtns = candidates.filter(c => c.inBottomArea && c.width < 80 && c.height < 80);
          if (bottomBtns.length > 0) {
            bottomBtns.sort((a, b) => a.relLeft - b.relLeft);
            bottomBtns[0].el.click();
            return { clicked: 'bottom-any-icon', debug: debugInfo };
          }

          return { clicked: null, debug: debugInfo };
        }).catch(e => ({ error: e.message }));

        console.log(`[Instagram] Crop toggle attempt ${attempt + 1}:`, JSON.stringify(cropToggleResult));

        if (!cropToggleResult?.clicked) continue;

        // Wait for the aspect ratio options panel to appear
        await page.waitForTimeout(1200);

        // Step B: In the expanded panel, find ratio option icons by SVG geometry
        // 9:16 portrait = tallest/narrowest rectangle icon, Original = first option
        const ratioResult = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return { error: 'no dialog' };
          const dialogRect = dialog.getBoundingClientRect();

          // After clicking crop toggle, a row of ratio icons should appear
          // These are typically small buttons/divs in the bottom-left area arranged horizontally
          const allClickables = dialog.querySelectorAll('button, div[role="button"], [role="button"], span[role="button"], div[tabindex]');
          const ratioOptions = [];

          for (const el of allClickables) {
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) continue;
            const relTop = rect.top - dialogRect.top;
            const relLeft = rect.left - dialogRect.left;
            // Ratio options appear in the bottom portion
            if (relTop < dialogRect.height * 0.6) continue;
            
            // Check for SVG content to analyze icon shape
            const svg = el.querySelector('svg');
            let iconAspect = null;
            if (svg) {
              // Analyze the SVG's visual shape — look at viewBox or actual rendered size
              const viewBox = svg.getAttribute('viewBox');
              const svgRect = svg.getBoundingClientRect();
              // Also look at rect elements inside SVG that represent the aspect ratio shape
              const rects = svg.querySelectorAll('rect');
              const paths = svg.querySelectorAll('path');
              
              // Check for rect elements that indicate the aspect ratio visually
              for (const r of rects) {
                const w = parseFloat(r.getAttribute('width') || r.getAttribute('x2') || '0') - parseFloat(r.getAttribute('x') || r.getAttribute('x1') || '0');
                const h = parseFloat(r.getAttribute('height') || r.getAttribute('y2') || '0') - parseFloat(r.getAttribute('y') || r.getAttribute('y1') || '0');
                const rW = parseFloat(r.getAttribute('width') || '0');
                const rH = parseFloat(r.getAttribute('height') || '0');
                if (rW > 2 && rH > 2) {
                  iconAspect = rH / rW; // >1 = portrait, <1 = landscape, ~1 = square
                }
              }

              // If no rect, try path bounding box
              if (iconAspect === null && paths.length > 0) {
                const svgBBox = svgRect;
                if (svgBBox.width > 0 && svgBBox.height > 0) {
                  iconAspect = svgBBox.height / svgBBox.width;
                }
              }
            }

            // Also check for text content like "Original", "1:1", "4:5", "9:16"
            const text = (el.textContent || '').trim().toLowerCase();
            
            ratioOptions.push({
              el,
              relLeft,
              relTop,
              width: rect.width,
              height: rect.height,
              iconAspect,
              text,
              hasSvg: !!svg
            });
          }

          const debugRatios = ratioOptions.map((r, i) =>
            `opt${i}: ${Math.round(r.relLeft)}x${Math.round(r.relTop)} size=${Math.round(r.width)}x${Math.round(r.height)} aspect=${r.iconAspect?.toFixed(2)} text="${r.text}" svg=${r.hasSvg}`
          );

          // Strategy 1: Find by text "original" or "9:16"
          for (const opt of ratioOptions) {
            if (opt.text.includes('original')) {
              opt.el.click();
              return { selected: 'original-text', debug: debugRatios };
            }
          }
          for (const opt of ratioOptions) {
            if (opt.text.includes('9:16')) {
              opt.el.click();
              return { selected: '9:16-text', debug: debugRatios };
            }
          }

          // Strategy 2: Find by SVG icon shape — portrait icon has iconAspect > 1.3
          const portraitIcons = ratioOptions.filter(r => r.iconAspect && r.iconAspect > 1.3 && r.hasSvg);
          if (portraitIcons.length > 0) {
            // Pick the one with highest aspect ratio (tallest/narrowest = 9:16)
            portraitIcons.sort((a, b) => (b.iconAspect || 0) - (a.iconAspect || 0));
            portraitIcons[0].el.click();
            return { selected: 'portrait-icon', aspect: portraitIcons[0].iconAspect, debug: debugRatios };
          }

          // Strategy 3: Click the first option (usually "Original" which preserves source ratio)
          const svgOptions = ratioOptions.filter(r => r.hasSvg);
          if (svgOptions.length > 0) {
            svgOptions.sort((a, b) => a.relLeft - b.relLeft);
            svgOptions[0].el.click();
            return { selected: 'first-option-fallback', debug: debugRatios };
          }

          // Strategy 4: Click any option in the ratio area
          if (ratioOptions.length > 0) {
            ratioOptions.sort((a, b) => a.relLeft - b.relLeft);
            ratioOptions[0].el.click();
            return { selected: 'any-first-fallback', debug: debugRatios };
          }

          return { selected: null, debug: debugRatios };
        }).catch(e => ({ error: e.message }));

        console.log(`[Instagram] Ratio selection attempt ${attempt + 1}:`, JSON.stringify(ratioResult));

        if (ratioResult?.selected) {
          aspectRatioSet = true;

          // Verify: check preview container dimensions
          await page.waitForTimeout(500);
          const previewCheck = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return null;
            // The main preview area is usually a large div/img/video in the dialog
            const media = dialog.querySelector('video, img[style*="object"], div[style*="padding-bottom"]');
            if (media) {
              const r = media.getBoundingClientRect();
              return { width: Math.round(r.width), height: Math.round(r.height), ratio: (r.height / r.width).toFixed(2) };
            }
            return null;
          }).catch(() => null);
          console.log('[Instagram] Preview after ratio change:', JSON.stringify(previewCheck));
        }
      } catch (e) {
        console.warn(`[Instagram] Aspect ratio attempt ${attempt + 1} error:`, e.message);
      }
    }

    // --- AI Agent fallback (if DOM approach failed) ---
    if (!aspectRatioSet) {
      console.log('[Instagram] DOM approach failed, using AI agent for aspect ratio...');
      try {
        const agentResult = await runAgentTask(page,
          'In the Instagram post creation dialog, I need to change the video aspect ratio to portrait/vertical. ' +
          'Look at the BOTTOM-LEFT corner of the video preview area. There should be a small icon that looks like ' +
          'two corner brackets or a resize/expand symbol. Click that icon first. ' +
          'After clicking, a row of small icons should appear — these are aspect ratio options. ' +
          'Look for the TALLEST/NARROWEST rectangle icon (this represents 9:16 portrait) and click it. ' +
          'If you see text options, click "Original" or "9:16". ' +
          'Do NOT click "Next" or any other navigation button.',
          { maxSteps: 6, stepDelayMs: 800, useVision: true });
        
        if (agentResult.success) {
          console.log('[Instagram] Agent set aspect ratio successfully');
          aspectRatioSet = true;
        }
      } catch (e) {
        console.warn('[Instagram] Agent aspect ratio failed:', e.message);
      }
    }

    if (!aspectRatioSet) {
      console.warn('[Instagram] WARNING: Could not set 9:16 aspect ratio — video may be cropped');
    }
    await page.waitForTimeout(800);

    // ===== PHASE 4: CLICK THROUGH CROP/ADJUST SCREENS =====
    // Instagram shows: Crop → Filter → Caption screens
    // The "Next" button is at the TOP of the dialog popup — do NOT scroll the page background.
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(2000);

      // Stop early if we've reached the caption/share screen
      const alreadyOnCaption = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        return text.includes('write a caption') || text.includes('caption') ||
               !!document.querySelector('[aria-label*="caption" i], textarea[placeholder*="caption" i]');
      }).catch(() => false);
      if (alreadyOnCaption) {
        console.log('[Instagram] Already on caption screen, stopping Next clicks');
        break;
      }

      // Strategy 1: Scope the click to within the dialog to avoid background page interactions
      let clicked = await page.evaluate(() => {
        // Look for Next button specifically inside the dialog/modal
        const dialogEl = document.querySelector('[role="dialog"]') || document.body;
        const buttons = dialogEl.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (text === 'next' || text === 'continue' || label === 'next' || label === 'continue') {
            btn.click();
            return true;
          }
        }
        return false;
      });

      // Strategy 2: Playwright-level click with dialog-scoped selector
      if (!clicked) {
        clicked = await smartClick(page, [
          '[role="dialog"] button:has-text("Next")',
          '[role="dialog"] [aria-label="Next"]',
          '[role="dialog"] div[role="button"]:has-text("Next")',
          'button:has-text("Next")',
          '[aria-label="Next"]',
          'div[role="button"]:has-text("Next")',
          'button:has-text("Continue")',
        ], 'Next');
      }

      // Agent fallback — instruct it NOT to scroll the page background
      if (!clicked) {
        try {
          const result = await runAgentTask(page,
            'There is an Instagram post creation dialog/popup open. Click the "Next" button that is visible at the TOP of the dialog to advance to the next step. Do NOT scroll the page background. Only interact with the dialog popup.',
            { maxSteps: 4, stepDelayMs: 600, useVision: true });
          clicked = result.success;
        } catch {}
      }
      
      if (!clicked) break;
      await page.waitForTimeout(2000);
    }

    // ===== PHASE 5: ADD CAPTION =====
    // First verify we're on the caption/share screen
    const onCaptionScreen = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return text.includes('caption') || text.includes('write a caption') || 
             text.includes('share') || text.includes('create new post') ||
             !!document.querySelector('[aria-label*="caption" i], textarea[placeholder*="caption" i], [contenteditable="true"]');
    }).catch(() => false);

    if (!onCaptionScreen) {
      console.log('[Instagram] Not on caption screen yet, trying to advance...');
      await smartClick(page, [
        '[role="dialog"] button:has-text("Next")',
        'button:has-text("Next")',
        '[aria-label="Next"]',
        'div[role="button"]:has-text("Next")',
      ], 'Next');
      await page.waitForTimeout(2000);
    }

    if (metadata?.title || metadata?.description || (metadata?.tags && metadata.tags.length > 0)) {
      const captionParts = [];
      if (metadata.title) captionParts.push(metadata.title);
      if (metadata.description) captionParts.push(metadata.description);
      if (metadata.tags?.length) captionParts.push(metadata.tags.map(t => t.startsWith('#') ? t : '#' + t).join(' '));
      const caption = captionParts.join('\n\n').trim();
      console.log(`[Instagram] Caption to fill (${caption.length} chars): ${caption.slice(0, 200)}...`);
      
      let captionFilled = false;

      // Strategy 1: Keyboard-based approach (most reliable for contenteditable)
      const captionSelectors = [
        '[aria-label="Write a caption..."]',
        '[aria-label*="Write a caption"]',
        '[aria-label*="caption" i]',
        'textarea[aria-label*="caption" i]',
        'textarea[placeholder*="caption" i]',
        '[contenteditable="true"]',
        'textarea',
      ];

      for (const sel of captionSelectors) {
        if (captionFilled) break;
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;
          
          await el.click();
          await page.waitForTimeout(500);
          // Select all existing text and replace
          await page.keyboard.press('Control+a');
          await page.waitForTimeout(200);
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(200);
          // Type the caption character by character for reliability
          await page.keyboard.type(caption.slice(0, MAX_CAPTION_LENGTH), { delay: 10 });
          await page.waitForTimeout(500);
          
          // Verify the caption was actually typed
          const typed = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return '';
            return el.textContent || el.value || '';
          }, sel).catch(() => '');
          
          if (typed.length > 0) {
            captionFilled = true;
            console.log(`[Instagram] Caption filled via ${sel} (${typed.length} chars written)`);
          } else {
            console.log(`[Instagram] Caption via ${sel} may not have been applied, trying next method...`);
          }
        } catch {}
      }

      // Strategy 2: DOM execCommand
      if (!captionFilled) {
        captionFilled = await page.evaluate((text) => {
          const editors = document.querySelectorAll(
            '[contenteditable="true"], textarea[aria-label*="caption" i], ' +
            '[aria-label="Write a caption..."], [aria-label*="Write a caption"],' +
            'textarea[placeholder*="caption" i], textarea'
          );
          for (const editor of editors) {
            if (editor.offsetHeight === 0) continue;
            editor.focus();
            editor.click();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
            // Verify text was set
            const content = editor.textContent || editor.value || '';
            if (content.length > 0) return true;
          }
          return false;
        }, caption);
        if (captionFilled) console.log('[Instagram] Caption filled via execCommand');
      }

      // Strategy 3: Agent fallback
      if (!captionFilled) {
        console.warn('[Instagram] Could not fill caption with standard methods, trying agent...');
        try {
          await runAgentTask(page,
            `Find the caption text field (it may say "Write a caption...") and type the following text into it: "${caption.slice(0, 300)}"`,
            { maxSteps: 5, stepDelayMs: 500 });
          captionFilled = true;
        } catch (e) {
          console.warn('[Instagram] Agent caption fill failed:', e.message);
        }
      }

      if (!captionFilled) {
        console.warn('[Instagram] WARNING: Caption could not be filled. The post will be shared without a description.');
      }
    }
    await page.waitForTimeout(2000);

    // ===== PHASE 6: SHARE =====
    console.log('[Instagram] Sharing...');

    // Use LLM vision to confirm we are on the caption/share screen before clicking Share
    try {
      const shareCheck = await analyzePage(page,
        'Instagram post creation dialog: Are we on the final "Share" step where the caption has been filled? Is the blue "Share" button visible in the dialog? Describe the current state.');
      console.log(`[Instagram] Pre-share vision check: ${shareCheck?.description || 'no response'}`);
    } catch (e) {
      console.warn('[Instagram] Pre-share vision check failed (non-fatal):', e.message);
    }

    const shareReady = await waitForInstagramShareButtonReady(page, INSTAGRAM_SHARE_READY_MAX_WAIT_MS);
    if (!shareReady.ready && !shareReady.alreadyShared) {
      console.warn(`[Instagram] Share button readiness timeout: ${shareReady.reason}`);
    }

    // Click Share within the dialog once it's truly ready.
    let shareClicked = shareReady.alreadyShared ? true : false;
    if (!shareClicked) {
      for (let shareClickAttempt = 1; shareClickAttempt <= 4; shareClickAttempt++) {
        shareClicked = await clickInstagramShareButton(page);
        if (shareClicked) {
          const postClickStateChanged = await page.waitForFunction(() => {
            const text = (document.body?.innerText || '').toLowerCase();
            const url = window.location.href;
            const sharingOrShared =
              text.includes('sharing...') ||
              text.includes('processing') ||
              text.includes('your reel has been shared') ||
              text.includes('your post has been shared') ||
              text.includes('post shared') ||
              text.includes('reel shared') ||
              text.includes('shared successfully');
            const redirectedToFeed = url === 'https://www.instagram.com/';
            return sharingOrShared || redirectedToFeed;
          }, { timeout: 10000 }).then(() => true).catch(() => false);

          if (postClickStateChanged) {
            break;
          }
          console.log(`[Instagram] Share click attempt ${shareClickAttempt} did not trigger state change, retrying...`);
        }

        await page.waitForTimeout(1500);
      }
    }
    
    if (!shareClicked) {
      console.warn('[Instagram] Could not find Share button, requesting human help...');
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      await requestTelegramApproval({
        telegram: credentials.telegram,
        platform: 'Instagram',
        backend: credentials.backend,
        screenshotBuffer,
        screenshotCaption: '📸 <b>Instagram upload ready</b> — click Share and reply APPROVED',
        customMessage: '🚧 <b>Instagram uploader needs help</b>\nPlease click the Share button and reply APPROVED.',
      });
    }
    
    // Wait for Instagram share animation to finish, then immediately hand off to profile capture.
    console.log('[Instagram] Waiting for share animation/result to finish...');
    let postUrl = await extractInstagramPostUrl(page);

    const sharingWait = await waitForInstagramSharingToFinish(page, INSTAGRAM_SHARE_PROCESSING_MAX_WAIT_MS);
    if (!sharingWait.finished) {
      console.warn(`[Instagram] Share-processing wait timeout: ${sharingWait.reason}`);
    } else {
      console.log(`[Instagram] Share-processing completed: ${sharingWait.reason}`);
    }

    postUrl = postUrl || await extractInstagramPostUrl(page);

    // ===== PHASE 7: CHECK COMPLETION AND EXTRACT URL =====
    let completion = await assessInstagramCompletion(page);

    // If explicit success text wasn't detected but share-processing phase already completed,
    // proceed to profile verification instead of waiting a long extra window on this screen.
    if (!completion.success && sharingWait.finished) {
      completion = { success: true, needsHuman: false, reason: sharingWait.reason };
    }

    // Only do short retries when we still suspect upload is processing.
    if (!completion.success && !completion.needsHuman) {
      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(3000);
        completion = await assessInstagramCompletion(page);
        postUrl = postUrl || await extractInstagramPostUrl(page);
        if (completion.success) break;
      }
    }

    if (!completion.success && completion.needsHuman) {
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      await requestTelegramApproval({
        telegram: credentials.telegram,
        platform: 'Instagram',
        backend: credentials.backend,
        screenshotBuffer,
        screenshotCaption: '📸 <b>Instagram obstacle screen</b> — reply APPROVED once the step is completed',
        customMessage: `🚧 <b>Instagram uploader needs your help</b>\n${completion.reason}\n\nResolve the visible step and reply APPROVED.`,
      });

      await page.waitForTimeout(8000);
      completion = await assessInstagramCompletion(page);
      postUrl = postUrl || await extractInstagramPostUrl(page);
    }

    postUrl = normalizeInstagramPostUrl(postUrl);

    if (!profileUsername) {
      profileUsername = await resolveInstagramUsername(page);
    }

    // Always wait for a genuinely new URL on profile when possible (YouTube-like publish polling).
    // This prevents false positives where Share was clicked but publish had not finalized yet.
    if (profileUsername) {
      const newlyPublishedUrl = await waitForNewInstagramPostUrl(
        page,
        profileUsername,
        baselineProfilePostUrls,
        INSTAGRAM_PROFILE_PUBLISH_WAIT_ATTEMPTS,
      );
      if (!newlyPublishedUrl) {
        throw new Error('Instagram share popup completed, but no new reel/post appeared on profile yet. Upload was not confirmed as finished.');
      }

      postUrl = newlyPublishedUrl;
      completion = { success: true, needsHuman: false, reason: 'Verified new Instagram URL appeared on profile.' };
      console.log(`[Instagram] Verified new reel/post URL from profile: ${postUrl}`);
    }

    if (!completion.success && !postUrl) {
      throw new Error(`Instagram publish was not confirmed. ${completion.reason}`);
    }

    const baselineUrlSet = new Set((baselineProfilePostUrls || []).map((url) => normalizeInstagramPostUrl(url)).filter(Boolean));

    if (postUrl && baselineUrlSet.has(postUrl)) {
      throw new Error('Instagram publish was not confirmed as a new post. Captured URL already existed before upload.');
    }

    if (postUrl && latestPostBeforeUpload && postUrl === latestPostBeforeUpload) {
      throw new Error('Instagram publish was not confirmed as a new post. Latest profile post URL remained unchanged.');
    }

    if (postUrl) {
      console.log(`[Instagram] Using verified URL: ${postUrl}`);
    }

    postUrl = normalizeInstagramPostUrl(postUrl);
    if (!postUrl) {
      throw new Error('Instagram publish could not be verified with a real post URL. No /p/ or /reel/ link was found.');
    }
    if (latestPostBeforeUpload && postUrl === latestPostBeforeUpload) {
      throw new Error('Instagram publish was not confirmed as a new post. Latest profile post URL remained unchanged.');
    }

    console.log(`[Instagram] Upload complete! URL: ${postUrl || '(no URL extracted)'}`);

    await context.close();
    return { url: postUrl || '' };
  } catch (err) {
    console.error('[Instagram] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToInstagram };
