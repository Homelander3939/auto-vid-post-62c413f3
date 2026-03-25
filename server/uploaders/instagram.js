const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill, analyzePage, waitForStateChange, runAgentTask } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram');
const MAX_CAPTION_LENGTH = 2200;
// How long to wait for the user's reels grid to load after navigating to their profile
const PROFILE_REELS_LOAD_WAIT_MS = 6000;

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
          return href.startsWith('http') ? href : `https://www.instagram.com${href}`;
        }
      }
    }
    return '';
  }).catch(() => '');
}

async function assessInstagramCompletion(page) {
  const dom = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const url = window.location.href;
    
    const success =
      text.includes('your post has been shared') ||
      text.includes('your reel has been shared') ||
      text.includes('post shared') ||
      text.includes('reel shared') ||
      text.includes('your video has been shared') ||
      text.includes('shared successfully') ||
      // Instagram redirects to feed after a successful share
      (url === 'https://www.instagram.com/' && !text.includes('create new post'));
    
    const isStillInDialog = text.includes('sharing...') || text.includes('processing');
    
    const hardError =
      text.includes('couldn\'t share') ||
      text.includes('try again') ||
      text.includes('upload failed') ||
      text.includes('something went wrong');
    
    return { success, isStillInDialog, hardError, summary: text.slice(0, 1200), url };
  }).catch(() => ({ success: false, isStillInDialog: false, hardError: false, summary: '', url: '' }));

  if (dom.success) return { success: true, reason: 'Instagram UI confirms share/upload completion.' };
  if (dom.isStillInDialog) return { success: false, needsHuman: false, reason: 'Instagram is still processing the share.' };
  if (dom.hardError) return { success: false, needsHuman: true, reason: 'Instagram UI shows a blocking share/upload error.' };

  // Only treat a redirect to the homepage as success — do NOT treat other non-create
  // pages (e.g., the profile/reels page we navigate to for URL extraction) as success.
  const currentUrl = page.url();
  if (currentUrl === 'https://www.instagram.com/') {
    return { success: true, reason: 'Instagram redirected to home feed after share (success).' };
  }

  try {
    const ai = await analyzePage(page, 'Instagram post completion check. Decide whether posting succeeded or needs manual action.');
    const state = String(ai?.state || '').toLowerCase();
    if (['success', 'processing', 'uploading'].includes(state)) {
      return { success: true, reason: ai?.description || 'AI detected successful/processing completion state.' };
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
    await page.waitForTimeout(5000);

    // Wait for the upload dialog/modal to appear and transition past the file-select state.
    // Instagram shows a popup with a "Next" button at the top of the dialog (not a page scroll).
    // We must click within the dialog — NOT scroll the background page.
    const dialogAppeared = await page.waitForSelector('[role="dialog"], [aria-label*="create" i], [aria-label*="post" i]', { timeout: 15000 })
      .then(() => true).catch(() => false);
    if (dialogAppeared) {
      console.log('[Instagram] Upload dialog detected');
    } else {
      console.log('[Instagram] Dialog not detected by selector, proceeding anyway');
    }

    // Use LLM vision to understand the current dialog state
    try {
      const dialogCheck = await analyzePage(page,
        'Instagram post creation: A dialog/popup is visible. Describe what step we are on (crop, filter, caption, or file select). Is there a "Next" button visible at the top of the dialog?');
      console.log(`[Instagram] Dialog state check: ${dialogCheck?.description || 'no response'}`);
    } catch (e) {
      console.warn('[Instagram] Dialog vision check failed (non-fatal):', e.message);
    }

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

    if (metadata?.title || metadata?.description) {
      const captionParts = [];
      if (metadata.title) captionParts.push(metadata.title);
      if (metadata.description) captionParts.push(metadata.description);
      if (metadata.tags?.length) captionParts.push(metadata.tags.map(t => '#' + t).join(' '));
      const caption = captionParts.join('\n\n').trim();
      console.log(`[Instagram] Setting caption (${caption.length} chars)...`);
      
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

    // Click Share within the dialog (scoped to avoid background interactions)
    let shareClicked = await page.evaluate(() => {
      const dialogEl = document.querySelector('[role="dialog"]') || document.body;
      const buttons = dialogEl.querySelectorAll('button, div[role="button"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text === 'share' || text === 'post' || text === 'publish' || label === 'share') {
          btn.click();
          return true;
        }
      }
      return false;
    });

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

    // Agent fallback: use LLM with vision to find Share button in dialog
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
    
    // Wait for Instagram to process and share the post
    console.log('[Instagram] Waiting for share to complete...');
    await page.waitForTimeout(5000);

    // Capture URL from the success dialog as early as possible — the dialog may close quickly.
    let postUrl = await extractInstagramPostUrl(page);

    // Wait for Instagram to process and confirm the share (up to 120 seconds).
    // Do NOT break early based on absence of "sharing..." text — Instagram often
    // silently processes without displaying any progress text.
    let shareWaitAttempts = 0;
    while (shareWaitAttempts++ < 24) {
      // Try to grab the URL from the success dialog on every iteration
      if (!postUrl) {
        postUrl = await extractInstagramPostUrl(page);
      }

      const shareState = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const url = window.location.href;
        const isSharing = text.includes('sharing...') || text.includes('processing') || text.includes('posting');
        const isShared =
          text.includes('your reel has been shared') ||
          text.includes('your post has been shared') ||
          text.includes('post shared') ||
          text.includes('reel shared') ||
          text.includes('your video has been shared') ||
          text.includes('shared successfully');
        // Instagram often redirects to feed after a successful share
        const redirectedToFeed = url === 'https://www.instagram.com/';
        return { isSharing, isShared, redirectedToFeed };
      }).catch(() => ({ isSharing: false, isShared: false, redirectedToFeed: false }));

      if (shareState.isShared) {
        // The success dialog is still visible — try once more to grab the URL
        postUrl = postUrl || await extractInstagramPostUrl(page);
        console.log(`[Instagram] Post shared! (${shareWaitAttempts * 5}s)`);
        break;
      }
      if (shareState.redirectedToFeed) {
        console.log(`[Instagram] Redirected to feed after share (${shareWaitAttempts * 5}s)`);
        break;
      }
      if (shareState.isSharing) {
        console.log(`[Instagram] Still sharing... (${shareWaitAttempts * 5}s)`);
      }
      await page.waitForTimeout(5000);
    }

    // ===== PHASE 7: CHECK COMPLETION AND EXTRACT URL =====
    let completion = await assessInstagramCompletion(page);

    // Wait longer if still processing
    if (!completion.success && !completion.needsHuman) {
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(5000);
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

    if (!completion.success) {
      throw new Error(`Instagram publish was not confirmed. ${completion.reason}`);
    }

    // Navigate to the user's own profile/reels page to get the authoritative URL of the
    // newly-uploaded post — only if we don't already have a URL from the success dialog.
    // Skip this if we already have a reliable URL (from the share confirmation dialog).
    if (!postUrl) {
      try {
        // Extract the logged-in username from the Instagram left-sidebar profile link.
        // Instagram renders a nav link like <a href="/username/" aria-label="Profile">
        const username = await page.evaluate(() => {
          // Strategy 1: profile nav link (most reliable — always present when logged in)
          const navSelectors = [
            'nav a[href^="/"][aria-label*="Profile" i]',
            'nav a[href^="/"][role="link"]',
            'a[href^="/"][aria-label*="Profile" i]',
          ];
          for (const sel of navSelectors) {
            const el = document.querySelector(sel);
            if (el) {
              const href = (el.getAttribute('href') || '').replace(/\/$/, '');
              const m = href.match(/^\/([a-zA-Z0-9._]+)$/);
              if (m && !['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'create', 'stories'].includes(m[1])) {
                return m[1];
              }
            }
          }
          // Strategy 2: scan all sidebar / nav links for a short username-like path
          const allLinks = Array.from(document.querySelectorAll('a[href]'));
          for (const link of allLinks) {
            const href = (link.getAttribute('href') || '').replace(/\/$/, '');
            const m = href.match(/^\/([a-zA-Z0-9._]{3,30})$/);
            if (m && !['explore', 'reels', 'direct', 'accounts', 'p', 'reel', 'create', 'stories', 'inbox'].includes(m[1])) {
              return m[1];
            }
          }
          return '';
        }).catch(() => '');

        if (username) {
          console.log(`[Instagram] Navigating to @${username}/reels/ to find the published reel...`);
          await page.goto(`https://www.instagram.com/${username}/reels/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          // Wait for the reels grid to load and show the newly uploaded reel
          await page.waitForTimeout(PROFILE_REELS_LOAD_WAIT_MS);

          // Pick the first (newest) reel from the main content grid, not sidebar/header links
          const profileUrl = await page.evaluate(() => {
            // Instagram reels grid: the main article/section contains <a href="/reel/…"> tiles
            // Collect all reel/post links then take the one with the shortest surrounding element
            // depth from the main content area to avoid sidebar duplicates.
            const mainEl = document.querySelector('main, [role="main"]');
            const scope = mainEl || document;
            const reelLinks = Array.from(scope.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
            if (reelLinks.length > 0) {
              const href = reelLinks[0].getAttribute('href') || '';
              return href.startsWith('http') ? href : `https://www.instagram.com${href}`;
            }
            return '';
          }).catch(() => '');

          if (profileUrl) {
            postUrl = profileUrl;
            console.log(`[Instagram] Found published reel URL from profile: ${postUrl}`);
          }
        }
      } catch (e) {
        console.warn('[Instagram] Could not navigate to profile for URL:', e.message);
      }
    } else {
      console.log(`[Instagram] Using URL captured from share dialog: ${postUrl}`);
    }

    console.log(`[Instagram] Upload complete! URL: ${postUrl || '(no URL extracted)'}`);

    // ===== POST-UPLOAD: SCRAPE STATS =====
    let recentStats = [];
    try {
      const { scrapeInstagramReelsStats } = require('./stats-scraper');
      recentStats = await scrapeInstagramReelsStats(page, { maxVideos: 10 });
    } catch (statsErr) {
      console.warn('[Instagram] Stats scraping failed (non-fatal):', statsErr.message);
    }

    await context.close();
    return { url: postUrl || 'https://www.instagram.com', recentStats };
  } catch (err) {
    console.error('[Instagram] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToInstagram };
