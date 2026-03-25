const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill, analyzePage, waitForStateChange, runAgentTask } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'instagram');
const MAX_CAPTION_LENGTH = 2200;

async function extractInstagramPostUrl(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') || '')
      .filter(Boolean);

    for (const href of links) {
      if (href.includes('/p/') || href.includes('/reel/')) {
        if (href.startsWith('http')) return href;
        return `https://www.instagram.com${href}`;
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
      // Instagram often redirects to feed after successful share
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

  // Check if we've been redirected away from the create flow (success indicator)
  const currentUrl = page.url();
  if (currentUrl === 'https://www.instagram.com/' || (!currentUrl.includes('create') && !currentUrl.includes('upload'))) {
    // If we were in the create flow and now we're not, likely succeeded
    return { success: true, reason: 'Instagram redirected away from create flow (likely successful share).' };
  }

  try {
    const ai = await analyzePage(page, 'Instagram post completion check. Decide whether posting succeeded or needs manual action.');
    const state = String(ai?.state || '').toLowerCase();
    if (['success', 'processing', 'uploading', 'logged_in'].includes(state)) {
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

    console.log('[Instagram] Video file set, waiting for processing...');
    await page.waitForTimeout(5000);

    // ===== PHASE 4: CLICK THROUGH CROP/ADJUST SCREENS =====
    // Instagram shows: Crop → Filter → Caption screens
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(2000);
      
      let clicked = await smartClick(page, [
        'button:has-text("Next")',
        '[aria-label="Next"]',
        'div[role="button"]:has-text("Next")',
        'button:has-text("Continue")',
      ], 'Next');
      
      if (!clicked) {
        // Try via DOM evaluation
        clicked = await page.evaluate(() => {
          const buttons = document.querySelectorAll('button, div[role="button"]');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'next' || text === 'continue') { btn.click(); return true; }
          }
          return false;
        });
      }
      
      // Agent fallback for Next button
      if (!clicked) {
        try {
          const result = await runAgentTask(page,
            'Click the "Next" button in the Instagram post creation dialog to advance to the next step.',
            { maxSteps: 3, stepDelayMs: 500 });
          clicked = result.success;
        } catch {}
      }
      
      if (!clicked) break;
      await page.waitForTimeout(2000);
    }

    // ===== PHASE 5: ADD CAPTION =====
    if (metadata?.title || metadata?.description) {
      const caption = `${metadata.title || ''}\n\n${metadata.description || ''}\n\n${(metadata.tags || []).map(t => '#' + t).join(' ')}`.trim();
      console.log('[Instagram] Setting caption...');
      
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
          await page.waitForTimeout(300);
          await page.keyboard.press('Control+a');
          await page.waitForTimeout(100);
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(100);
          await page.keyboard.type(caption.slice(0, MAX_CAPTION_LENGTH), { delay: 5 });
          captionFilled = true;
          console.log(`[Instagram] Caption filled via ${sel}`);
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
            return true;
          }
          return false;
        }, caption);
      }

      // Strategy 3: Agent fallback
      if (!captionFilled) {
        console.warn('[Instagram] Could not fill caption with standard methods, trying agent...');
        try {
          await runAgentTask(page,
            `Fill the caption field with: "${caption.slice(0, 300)}"`,
            { maxSteps: 5, stepDelayMs: 500 });
        } catch (e) {
          console.warn('[Instagram] Agent caption fill failed:', e.message);
        }
      }
    }
    await page.waitForTimeout(2000);

    // ===== PHASE 6: SHARE =====
    console.log('[Instagram] Sharing...');
    let shareClicked = await smartClick(page, [
      'button:has-text("Share")',
      '[aria-label="Share"]',
      'div[role="button"]:has-text("Share")',
      'button:has-text("Post")',
      'button:has-text("Publish")',
    ], 'Share');
    
    if (!shareClicked) {
      shareClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'share' || text === 'post' || text === 'publish') { btn.click(); return true; }
        }
        return false;
      });
    }

    // Agent fallback: use LLM to find Share button
    if (!shareClicked) {
      console.log('[Instagram] Standard Share button not found, trying agent...');
      try {
        const agentResult = await runAgentTask(page,
          'Find and click the "Share" button to publish this Instagram post/reel. It should be a blue button in the dialog.',
          { maxSteps: 5, stepDelayMs: 500 });
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
    
    await page.waitForTimeout(10000);

    // ===== PHASE 7: CHECK COMPLETION =====
    let completion = await assessInstagramCompletion(page);
    let postUrl = await extractInstagramPostUrl(page);

    // Wait longer if still processing
    if (!completion.success && !completion.needsHuman) {
      for (let i = 0; i < 6; i++) {
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

    console.log('[Instagram] Upload complete!');

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
