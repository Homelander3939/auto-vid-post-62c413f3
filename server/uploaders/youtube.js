const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { requestTelegramApproval, tryFillVerificationCode } = require('./approval');
const { smartClick, smartFill, waitForStateChange } = require('./smart-agent');

const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-sessions', 'youtube');
const YT_STUDIO_URL = 'https://studio.youtube.com';
const YT_UPLOAD_URL = 'https://studio.youtube.com/upload';

async function inspectGoogleAuthState(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const emailInput = document.querySelector('#identifierId, input[type="email"], input[name="identifier"]');
    const passwordInput = document.querySelector('input[type="password"]:not([aria-hidden="true"])');
    const codeInput = document.querySelector('input[type="tel"], input[name*="code" i], input[autocomplete="one-time-code"]');

    const accountChips = Array.from(document.querySelectorAll('[data-identifier], [data-email], div[role="link"], li[role="link"]'));
    const accountEmails = accountChips
      .map((el) => (el.getAttribute('data-identifier') || el.getAttribute('data-email') || el.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 8);

    const continueBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find((btn) => {
      const t = (btn.textContent || '').toLowerCase().trim();
      return t === 'continue' || t.includes('continue as') || t === 'yes' || t.includes('i agree') || t.includes('next');
    });

    const matchNumber = (() => {
      const bigNumbers = document.querySelectorAll('[data-number], .vdE7Oc, .eKnrVb');
      for (const el of bigNumbers) {
        const v = (el.textContent || '').trim();
        if (/^\d{1,3}$/.test(v)) return v;
      }
      const textMatch = text.match(/tap\s+(\d{1,3})/i) || text.match(/number\s*[:=]?\s*(\d{1,3})/i);
      return textMatch?.[1] || '';
    })();

    return {
      hasEmailInput: isVisible(emailInput),
      hasPasswordInput: isVisible(passwordInput),
      hasCodeInput: isVisible(codeInput),
      hasPhonePrompt: text.includes('check your phone') || text.includes('tap yes') || text.includes('confirm it') || text.includes('approve sign-in'),
      hasNumberMatchPrompt: text.includes('choose a number') || text.includes('match the number') || text.includes('try another way'),
      isChooseAccount: text.includes('choose an account') || text.includes('select an account'),
      hasCaptcha: text.includes('not a robot') || text.includes('captcha') || text.includes('unusual traffic'),
      hasContinueButton: !!continueBtn,
      accountEmails,
      emailValue: (emailInput && 'value' in emailInput) ? String(emailInput.value || '') : '',
      matchNumber,
    };
  });
}

async function clickByText(page, texts) {
  return page.evaluate((labels) => {
    const wanted = labels.map((t) => t.toLowerCase());
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div[role="link"], li[role="link"], a, span'));
    for (const node of nodes) {
      const text = (node.textContent || '').trim().toLowerCase();
      if (!text) continue;
      if (wanted.some((w) => text === w || text.includes(w))) {
        node.click();
        return true;
      }
    }
    return false;
  }, texts);
}

async function chooseGoogleAccount(page, email) {
  const clickedByData = await page.evaluate((targetEmail) => {
    const normalized = String(targetEmail || '').toLowerCase().trim();
    const nodes = Array.from(document.querySelectorAll('[data-identifier], [data-email], div[role="link"], li[role="link"]'));
    for (const node of nodes) {
      const text = ((node.getAttribute('data-identifier') || node.getAttribute('data-email') || node.textContent || '')).toLowerCase();
      if (normalized && text.includes(normalized)) {
        node.click();
        return true;
      }
    }
    return false;
  }, email);

  if (clickedByData) return true;
  return clickByText(page, ['use another account', 'another account']);
}

async function submitGoogleEmail(page, email) {
  console.log('[YouTube] Entering email...');
  const urlBefore = page.url();
  const filled = await smartFill(page, ['#identifierId', 'input[type="email"]', 'input[name="identifier"]'], email);
  if (!filled) return false;

  await page.waitForTimeout(300);
  const clickedNext = await smartClick(page, ['#identifierNext button', '#identifierNext', 'button:has-text("Next")'], 'Next');
  if (!clickedNext) {
    await page.keyboard.press('Enter').catch(() => {});
  }

  await waitForStateChange(page, urlBefore, 8000);
  await page.waitForTimeout(1200);
  return true;
}

async function submitGooglePassword(page, password) {
  console.log('[YouTube] Entering password...');
  const urlBefore = page.url();
  const filled = await smartFill(page, [
    'input[type="password"]:not([aria-hidden="true"])',
    'input[name="Passwd"]',
  ], password);
  if (!filled) return false;

  await page.waitForTimeout(300);
  const clickedNext = await smartClick(page, ['#passwordNext button', '#passwordNext', 'button:has-text("Next")'], 'Next');
  if (!clickedNext) {
    await page.keyboard.press('Enter').catch(() => {});
  }

  await waitForStateChange(page, urlBefore, 9000);
  await page.waitForTimeout(1400);
  return true;
}

async function getYouTubeFileInput(page) {
  return page.$('input[type="file"]');
}

async function ensureStudioUploadPage(page) {
  await page.goto(YT_UPLOAD_URL, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2500);
  const fileInput = await getYouTubeFileInput(page);
  if (fileInput) return fileInput;

  await page.goto(YT_STUDIO_URL, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2000);
  return getYouTubeFileInput(page);
}

async function uploadToYouTube(videoPath, metadata, credentials) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[YouTube] Starting upload...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // ===== PHASE 1: LOGIN =====
    await page.goto(YT_STUDIO_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    let loginAttempts = 0;
    const MAX_LOGIN_ATTEMPTS = 40;
    let verificationRequested = false;
    let lastStateKey = '';
    let repeatedStateCount = 0;
    let loggedIn = false;

    while (loginAttempts++ < MAX_LOGIN_ATTEMPTS) {
      const url = page.url();

      // Success: we're on YouTube Studio
      if (url.includes('studio.youtube.com') && !url.includes('accounts.google.com')) {
        console.log('[YouTube] Logged in to YouTube Studio');
        loggedIn = true;
        break;
      }

      // Google login flow
      if (url.includes('accounts.google.com')) {
        const auth = await inspectGoogleAuthState(page);
        const stateKey = [
          auth.hasEmailInput ? 'email' : '',
          auth.hasPasswordInput ? 'password' : '',
          auth.hasCodeInput ? 'code' : '',
          auth.hasPhonePrompt ? 'phone' : '',
          auth.isChooseAccount ? 'choose' : '',
          auth.hasContinueButton ? 'continue' : '',
        ].filter(Boolean).join('|') || 'unknown';

        if (stateKey === lastStateKey) repeatedStateCount += 1;
        else repeatedStateCount = 0;
        lastStateKey = stateKey;

        if (auth.hasPasswordInput) {
          verificationRequested = false;
          await submitGooglePassword(page, credentials.password);
          continue;
        }

        if (auth.hasEmailInput) {
          verificationRequested = false;
          await submitGoogleEmail(page, credentials.email);
          continue;
        }

        if (auth.isChooseAccount || auth.accountEmails.length > 0) {
          console.log('[YouTube] Choosing Google account...');
          const chose = await chooseGoogleAccount(page, credentials.email);
          if (chose) {
            await page.waitForTimeout(2500);
            continue;
          }
        }

        if (auth.hasContinueButton) {
          const clicked = await clickByText(page, ['continue', 'continue as', 'yes', 'i agree', 'next']);
          if (clicked) {
            await page.waitForTimeout(2500);
            continue;
          }
        }

        // 2FA / Verification — only request Telegram help when credentials are not requested
        if (!auth.hasEmailInput && !auth.hasPasswordInput && (auth.hasCodeInput || auth.hasPhonePrompt || auth.hasNumberMatchPrompt)) {
          if (verificationRequested && repeatedStateCount < 3) {
            await page.waitForTimeout(2500);
            continue;
          }

          console.log('[YouTube] Verification detected — requesting Telegram help...');
          verificationRequested = true;

          let verificationMessage = `🔐 <b>YouTube verification needed</b>\n`;
          if (auth.matchNumber) {
            verificationMessage += `Tap number <b>${auth.matchNumber}</b> on your phone.\nThen reply APPROVED`;
          } else if (auth.hasPhonePrompt) {
            verificationMessage += `Check your phone and approve the sign-in.\nThen reply APPROVED`;
          } else {
            verificationMessage += `Enter the verification code.\nReply with: CODE 123456`;
          }

          const approval = await requestTelegramApproval({
            telegram: credentials.telegram,
            platform: 'YouTube',
            customMessage: verificationMessage,
          });

          if (!approval) throw new Error('Verification required but no response received. Check Telegram.');
          if (approval.code) {
            await tryFillVerificationCode(page, approval.code);
            await page.waitForTimeout(6000);
          } else {
            await page.waitForTimeout(9000);
          }

          await page.goto(YT_STUDIO_URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
          await page.waitForTimeout(2000);
          continue;
        }

        if (auth.hasCaptcha) {
          throw new Error('Google asked for CAPTCHA/unusual-traffic check. Complete it manually once, then retry upload.');
        }

        if (repeatedStateCount >= 2) {
          console.log('[YouTube] Auth state stuck, retrying via YouTube Studio route...');
          await page.goto(YT_STUDIO_URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
          await page.waitForTimeout(2500);
          continue;
        }

        console.log('[YouTube] Waiting on Google auth page...');
        await page.waitForTimeout(2500);
        continue;
      }

      if (url.includes('youtube.com')) {
        await page.goto(YT_STUDIO_URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2500);
        continue;
      }

      await page.goto(YT_STUDIO_URL, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    if (!loggedIn) {
      const recoveredInput = await ensureStudioUploadPage(page).catch(() => null);
      if (recoveredInput) {
        loggedIn = true;
      }
    }

    if (!loggedIn) {
      throw new Error('Login did not complete — still blocked on Google sign-in flow after multiple attempts.');
    }

    // ===== PHASE 2: OPEN UPLOAD DIALOG =====
    console.log('[YouTube] Opening upload dialog...');

    let fileInput = await ensureStudioUploadPage(page);

    if (!fileInput) {
      // Try clicking Create button
      let createClicked = await smartClick(page, [
        '#create-icon',
        'ytcp-button#create-icon',
        '[aria-label="Create"]',
        'button[aria-label="Create"]',
      ], 'Create');

      if (!createClicked) {
        await page.evaluate(() => {
          const btn = document.querySelector('#create-icon') ||
                      document.querySelector('[aria-label="Create"]') ||
                      document.querySelector('ytcp-button#create-icon');
          if (btn) { btn.click(); return true; }
          return false;
        });
      }
      await page.waitForTimeout(1800);

      // Click "Upload videos" from dropdown
      let uploadMenuClicked = await smartClick(page, [
        '#text-item-0',
        'tp-yt-paper-item:first-child',
        '[test-id="upload-icon"]',
      ], 'Upload video');

      if (!uploadMenuClicked) {
        await page.evaluate(() => {
          const items = document.querySelectorAll('tp-yt-paper-item, ytcp-text-menu a, [role="menuitem"], [role="option"]');
          for (const item of items) {
            if (item.textContent?.toLowerCase().includes('upload video')) { item.click(); return; }
          }
          if (items.length > 0) items[0].click();
        });
      }
      await page.waitForTimeout(2500);
      fileInput = await getYouTubeFileInput(page);
    }

    if (!fileInput) {
      console.log('[YouTube] Upload dialog not found, trying direct navigation...');
      await page.goto(YT_UPLOAD_URL, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);
      fileInput = await getYouTubeFileInput(page);
    }

    if (!fileInput) {
      // Last resort: try clicking Create again with a different strategy
      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      // Click using page coordinates — Create button is usually top-right area
      await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('button, ytcp-button'));
        for (const btn of allButtons) {
          const text = btn.textContent?.toLowerCase() || '';
          const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
          if (text.includes('create') || label.includes('create') || text.includes('upload')) {
            btn.click();
            break;
          }
        }
      });
      await page.waitForTimeout(2000);
      // Now try to find Upload videos option
      await page.evaluate(() => {
        const items = document.querySelectorAll('tp-yt-paper-item, [role="menuitem"], [role="option"], a');
        for (const item of items) {
          if (item.textContent?.toLowerCase().includes('upload')) { item.click(); return; }
        }
      });
      await page.waitForTimeout(3000);
      fileInput = await page.$('input[type="file"]');
    }

    if (!fileInput) {
      throw new Error('Could not open YouTube upload dialog. Try logging in manually first at https://studio.youtube.com');
    }

    // ===== PHASE 3: UPLOAD VIDEO FILE =====
    console.log('[YouTube] Setting video file...');
    await fileInput.setInputFiles(videoPath);
    console.log('[YouTube] Video file set, waiting for processing...');
    await page.waitForTimeout(8000);

    // ===== PHASE 4: FILL TITLE & DESCRIPTION =====
    if (metadata?.title) {
      console.log('[YouTube] Setting title...');
      // YouTube Studio uses a contenteditable div with id="textbox"
      const titleFilled = await page.evaluate((title) => {
        // Find the title textbox (first #textbox element)
        const textboxes = document.querySelectorAll('#textbox');
        const titleBox = textboxes[0];
        if (!titleBox) return false;
        titleBox.focus();
        titleBox.click();
        // Select all and replace
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, title);
        return true;
      }, metadata.title);

      if (!titleFilled) {
        // Fallback: try keyboard approach
        const titleBox = await page.$('#textbox');
        if (titleBox) {
          await titleBox.click({ clickCount: 3 });
          await page.waitForTimeout(200);
          await page.keyboard.press('Control+a');
          await page.keyboard.type(metadata.title, { delay: 20 });
        }
      }
    }

    if (metadata?.description) {
      console.log('[YouTube] Setting description...');
      await page.evaluate((desc) => {
        const textboxes = document.querySelectorAll('#textbox');
        if (textboxes.length > 1) {
          const descBox = textboxes[1];
          descBox.focus();
          descBox.click();
          document.execCommand('insertText', false, desc);
          return true;
        }
        return false;
      }, metadata.description);
    }
    await page.waitForTimeout(2000);

    // ===== PHASE 5: NAVIGATE WIZARD (Next × 3) =====
    console.log('[YouTube] Navigating upload wizard...');
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1500);
      const clicked = await smartClick(page, ['#next-button', '#step-badge-' + (i + 1)], 'Next');
      if (!clicked) {
        await page.evaluate(() => {
          const btn = document.querySelector('#next-button');
          if (btn) btn.click();
        });
      }
      await page.waitForTimeout(2000);
    }

    // ===== PHASE 6: SET VISIBILITY TO PUBLIC =====
    console.log('[YouTube] Setting visibility to Public...');
    await smartClick(page, [
      'tp-yt-paper-radio-button[name="PUBLIC"]',
      '#radioLabel:has-text("Public")',
      '[name="PUBLIC"]',
    ], 'Public');

    // Also try clicking by evaluating
    await page.evaluate(() => {
      const radios = document.querySelectorAll('tp-yt-paper-radio-button, [role="radio"]');
      for (const r of radios) {
        if (r.textContent?.toLowerCase().includes('public') && !r.textContent?.toLowerCase().includes('unlisted')) {
          r.click();
          break;
        }
      }
    });
    await page.waitForTimeout(1500);

    // ===== PHASE 7: PUBLISH =====
    console.log('[YouTube] Publishing...');
    await smartClick(page, ['#done-button', '#publish-button'], 'Publish');

    // Also try JS click
    await page.evaluate(() => {
      const btn = document.querySelector('#done-button') || document.querySelector('#publish-button');
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);

    // ===== PHASE 8: EXTRACT VIDEO URL =====
    let videoUrl = '';
    try {
      videoUrl = await page.evaluate(() => {
        const link = document.querySelector('a.style-scope.ytcp-video-info[href*="youtu"]') ||
                     document.querySelector('a[href*="youtu.be"]') ||
                     document.querySelector('a[href*="youtube.com/watch"]') ||
                     document.querySelector('.video-url-fadeable a');
        return link?.href || link?.textContent || '';
      });
    } catch {}

    console.log(`[YouTube] Upload complete! URL: ${videoUrl || 'not captured'}`);
    await context.close();
    return { url: videoUrl || undefined };
  } catch (err) {
    console.error('[YouTube] Upload failed:', err.message);
    await context.close();
    throw err;
  }
}

module.exports = { uploadToYouTube };
