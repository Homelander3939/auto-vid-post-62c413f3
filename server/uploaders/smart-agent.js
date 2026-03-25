// Smart browser agent helper for local Playwright uploaders.
// Takes screenshots, analyzes page state with AI, and decides next action.
// This gives the local server the same intelligence as the cloud version.
//
// ─────────────────────────────────────────────────────────────────────────────
// Agentic capabilities (page-agent-style, adapted for server-side Playwright)
// ─────────────────────────────────────────────────────────────────────────────
// page-agent (https://github.com/alibaba/page-agent) is a *client-side*
// library designed to run inside browser JavaScript context.  It cannot be
// used directly here because our automation runs from a Node.js server that
// controls Chromium through Playwright's remote protocol.
//
// Instead we implement the same core concept natively:
//   1. extractPageContext() – lightweight, text-based DOM snapshot (no screenshot
//      required, mirrors page-agent's DOM-first approach).
//   2. planNextAction()     – sends context + natural-language goal to the LLM
//      and receives a concrete Playwright action to execute.
//   3. executeAgentAction() – executes the LLM-chosen action via Playwright.
//   4. runAgentTask()       – iterative plan → execute loop until goal is
//      reached, failed, or the maximum step budget is exhausted.
//
// All four functions are exported and can be used directly by the uploaders
// (youtube.js, tiktok.js, instagram.js) for complex sequences that are hard
// to hard-code, or from any new agentic flow.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// LM Studio local model configuration
// Override with env vars: LM_STUDIO_URL, LM_STUDIO_MODEL, LM_STUDIO_API_KEY
const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234';
const DEFAULT_LM_STUDIO_MODEL = 'google/gemma-3-27b';

function getLmStudioUrl() {
  return (process.env.LM_STUDIO_URL || DEFAULT_LM_STUDIO_URL).replace(/\/$/, '') + '/v1/chat/completions';
}

function getLmStudioModel() {
  return process.env.LM_STUDIO_MODEL || DEFAULT_LM_STUDIO_MODEL;
}

// LM Studio does not require authentication; key is optional
function getApiKey() {
  return process.env.LM_STUDIO_API_KEY || process.env.LOVABLE_API_KEY || 'lm-studio';
}

// Vision is enabled by default — set LM_STUDIO_VISION=false to disable
function isVisionEnabled() {
  const val = (process.env.LM_STUDIO_VISION || 'true').toLowerCase();
  return val !== 'false' && val !== '0';
}

/**
 * Take a screenshot and return as base64
 */
async function takeScreenshot(page) {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 60 });
  return buffer.toString('base64');
}

/**
 * Analyze the current page state using LM Studio AI (with optional vision)
 */
async function analyzePage(page, context) {
  const url = page.url();
  const title = await page.title();

  const ctx = await extractPageContext(page).catch(() => ({ url, title, interactive: [], bodyText: '' }));
  const interactiveSummary = ctx.interactive.slice(0, 40)
    .map(e => `  [${e.tag}] selector="${e.selector}" text="${e.text}"`)
    .join('\n');

  const textPart = `Page body text (truncated):\n${ctx.bodyText}\n\nInteractive elements:\n${interactiveSummary}`;

  // Build user message — include screenshot if vision is enabled
  let userContent;
  if (isVisionEnabled()) {
    try {
      const screenshotB64 = await takeScreenshot(page);
      userContent = [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}` } },
        { type: 'text', text: textPart },
      ];
    } catch {
      userContent = textPart;
    }
  } else {
    userContent = textPart;
  }

  try {
    const response = await fetch(getLmStudioUrl(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getLmStudioModel(),
        messages: [
          {
            role: 'system',
            content: `You are a browser automation expert. Analyze the page DOM${isVisionEnabled() ? ' and the screenshot' : ''} and tell me the current state.

Context: ${context}
Current URL: ${url}
Page title: ${title}

Respond ONLY with a JSON object:
{
  "state": "login_email" | "login_password" | "verification_2fa" | "verification_code" | "logged_in" | "upload_page" | "upload_dialog" | "uploading" | "fill_details" | "processing" | "success" | "error" | "unknown",
  "description": "Brief description of what you see",
  "needs_human": false,
  "next_action": "Description of what to do next",
  "selector_hint": "CSS selector if obvious, or null"
}`,
          },
          {
            role: 'user',
            content: userContent,
          }
        ],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.error('[SmartAgent] AI analysis failed:', response.status);
      return analyzeDOMOnly(page, context);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        console.log('[SmartAgent] Failed to parse AI response, using DOM analysis');
      }
    }
  } catch (err) {
    console.warn('[SmartAgent] LM Studio request failed, using DOM analysis:', err.message);
  }

  return analyzeDOMOnly(page, context);
}

/**
 * Fallback: analyze page using DOM signals only
 */
async function analyzeDOMOnly(page, context) {
  const url = page.url();
  const info = await page.evaluate(() => {
    const text = (document.body?.innerText || '').substring(0, 2000).toLowerCase();
    return {
      hasEmailInput: !!document.querySelector('input[type="email"], input[name="username"], input[id="identifierId"]'),
      hasPasswordInput: !!document.querySelector('input[type="password"]:not([aria-hidden="true"])'),
      hasCodeInput: !!document.querySelector('input[type="tel"][autocomplete="one-time-code"], input[name*="code" i]'),
      hasFileInput: !!document.querySelector('input[type="file"]'),
      hasCreateButton: !!document.querySelector('#create-icon, [aria-label="Create"], [aria-label="New post"]'),
      hasCaptcha: !!(
        document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], iframe[title*="recaptcha" i]') ||
        document.querySelector('.g-recaptcha, .h-captcha, #captcha, [data-sitekey]') ||
        document.querySelector('[class*="captcha" i], [id*="captcha" i]')
      ),
      hasRobotCheck: text.includes('not a robot') || text.includes('are you a robot') ||
                     text.includes('verify you are human') || text.includes('unusual traffic') ||
                     text.includes('automated queries') || text.includes('bot detection') ||
                     text.includes('security check') || text.includes('prove you') ||
                     text.includes('confirm you are not') || text.includes('human verification'),
      hasCheckbox: !!(
        document.querySelector('iframe[src*="recaptcha"] + div, .recaptcha-checkbox') ||
        document.querySelector('[role="checkbox"]')
      ),
      bodyText: text,
      title: document.title,
    };
  });

  // CAPTCHA / robot detection — use LLM vision to try to solve
  if (info.hasCaptcha || info.hasRobotCheck) {
    return {
      state: 'captcha',
      description: info.hasRobotCheck ? 'Robot/human verification challenge detected' : 'CAPTCHA challenge detected',
      needs_human: false,
      next_action: 'Attempt to solve the challenge using vision analysis',
      has_checkbox: info.hasCheckbox,
    };
  }

  if (url.includes('accounts.google.com')) {
    if (info.hasPasswordInput) return { state: 'login_password', description: 'Google password entry', needs_human: false, next_action: 'Enter password' };
    if (info.hasEmailInput) return { state: 'login_email', description: 'Google email entry', needs_human: false, next_action: 'Enter email' };
    if (info.hasCodeInput) return { state: 'verification_code', description: '2FA code entry', needs_human: true, next_action: 'Enter verification code' };
    if (info.bodyText.includes('check your phone') || info.bodyText.includes('tap yes')) {
      return { state: 'verification_2fa', description: 'Phone approval needed', needs_human: true, next_action: 'Approve on phone' };
    }
    return { state: 'verification_2fa', description: 'Unknown Google auth state', needs_human: true, next_action: 'Check verification' };
  }

  if (url.includes('login') || url.includes('signin')) {
    if (info.hasPasswordInput && info.hasEmailInput) return { state: 'login_email', description: 'Login form', needs_human: false, next_action: 'Fill credentials' };
    if (info.hasPasswordInput) return { state: 'login_password', description: 'Password entry', needs_human: false, next_action: 'Enter password' };
    return { state: 'login_email', description: 'Login page', needs_human: false, next_action: 'Fill credentials' };
  }

  if (info.hasCreateButton) return { state: 'logged_in', description: 'Dashboard ready', needs_human: false, next_action: 'Click create/upload button' };
  if (info.hasFileInput) return { state: 'upload_dialog', description: 'Upload dialog visible', needs_human: false, next_action: 'Set file on input' };

  if (url.includes('studio.youtube.com') && !url.includes('accounts.google.com')) {
    return { state: 'logged_in', description: 'YouTube Studio dashboard', needs_human: false, next_action: 'Click Create button' };
  }

  if (url.includes('tiktok.com/creator') || url.includes('tiktok.com/upload')) {
    return { state: 'upload_page', description: 'TikTok creator page', needs_human: false, next_action: 'Upload video' };
  }

  if (url.includes('instagram.com') && !url.includes('login')) {
    return { state: 'logged_in', description: 'Instagram feed', needs_human: false, next_action: 'Click create post' };
  }

  return { state: 'unknown', description: 'Unknown page state', needs_human: false, next_action: 'Navigate to platform' };
}

/**
 * Wait for navigation/state change with smart polling
 */
async function waitForStateChange(page, previousUrl, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1000);
    const currentUrl = page.url();
    if (currentUrl !== previousUrl) return true;
    // Check if page finished loading
    const ready = await page.evaluate(() => document.readyState === 'complete').catch(() => false);
    if (ready && Date.now() - start > 3000) return true;
  }
  return false;
}

/**
 * Robust element click with multiple strategies
 */
async function smartClick(page, selectors, fallbackText) {
  // Try each selector
  for (const sel of (Array.isArray(selectors) ? selectors : [selectors])) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          await el.click();
          return true;
        }
      }
    } catch {}
  }

  // Fallback: find by text content
  if (fallbackText) {
    try {
      const el = await page.locator(`text="${fallbackText}"`).first();
      if (await el.isVisible()) {
        await el.click();
        return true;
      }
    } catch {}
    
    // Try role-based
    try {
      const el = await page.getByRole('button', { name: new RegExp(fallbackText, 'i') }).first();
      if (await el.isVisible()) {
        await el.click();
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Robust text input with native value setting
 */
async function smartFill(page, selectors, value) {
  for (const sel of (Array.isArray(selectors) ? selectors : [selectors])) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      
      await el.click();
      await page.waitForTimeout(200);
      
      // Triple-click to select all, then type
      await el.click({ clickCount: 3 });
      await page.waitForTimeout(100);
      await page.keyboard.type(value, { delay: 30 });
      return true;
    } catch {}
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENTIC LOOP  (page-agent concept adapted for server-side Playwright)
// ─────────────────────────────────────────────────────────────────────────────

// Configuration constants for the agentic loop
const MAX_BODY_TEXT_LENGTH = 1500;
const MAX_INTERACTIVE_ELEMENTS = 60;
const SELECTOR_WAIT_TIMEOUT = 5000;

/**
 * Extract a lightweight, text-based snapshot of the page that can be sent to
 * an LLM without a screenshot.  The snapshot includes:
 *  - Current URL and page title
 *  - All interactive elements (buttons, inputs, selects, links, contenteditable)
 *    with their text, aria-label, name, id, type, placeholder, href attributes
 *  - First 1,500 characters of visible body text
 *
 * This mirrors page-agent's "DOM-first, no multi-modal" philosophy and keeps
 * token counts low while giving the model enough context to decide what to do.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{url:string, title:string, interactive:object[], bodyText:string}>}
 */
async function extractPageContext(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');

  const interactive = await page.evaluate((maxBodyLen) => {
    const TAG_SELECTORS = [
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'a[href]',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="tab"]',
      '[contenteditable="true"]',
      '[contenteditable=""]',
    ].join(',');

    /**
     * Return a stable CSS selector for an element so the agent can click/fill it.
     * Prefers id, then name, then aria-label, then nth-of-type index.
     */
    function selectorFor(el) {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `${tag}[name="${el.name}"]`;
      const label = el.getAttribute('aria-label');
      if (label) return `${tag}[aria-label="${label}"]`;
      // Fallback: position-based selector within parent
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.querySelectorAll(tag));
        const idx = siblings.indexOf(el) + 1;
        return `${tag}:nth-of-type(${idx})`;
      }
      return tag;
    }

    const elements = [];
    const seen = new Set();
    document.querySelectorAll(TAG_SELECTORS).forEach((el) => {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 &&
        window.getComputedStyle(el).visibility !== 'hidden' &&
        window.getComputedStyle(el).display !== 'none';
      if (!visible) return;

      const sel = selectorFor(el);
      if (seen.has(sel)) return;
      seen.add(sel);

      const obj = {
        tag: el.tagName.toLowerCase(),
        selector: sel,
        text: (el.textContent || '').trim().substring(0, 80),
        type: el.getAttribute('type') || null,
        placeholder: el.getAttribute('placeholder') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        href: el.getAttribute('href') || null,
        role: el.getAttribute('role') || null,
        disabled: el.disabled || false,
      };
      elements.push(obj);
    });

    const bodyText = (document.body?.innerText || '').substring(0, maxBodyLen);
    return { interactive: elements, bodyText };
  }, MAX_BODY_TEXT_LENGTH).catch(() => ({ interactive: [], bodyText: '' }));

  return {
    url,
    title,
    interactive: interactive.interactive,
    bodyText: interactive.bodyText,
  };
}

/**
 * Ask the LLM for the single best next Playwright action to advance toward
 * `goal`, given the current page context and the history of prior steps.
 *
 * The LLM returns a structured action object:
 * {
 *   action:    "click" | "fill" | "select" | "navigate" | "scroll" | "wait" | "done" | "failed",
 *   selector:  string | null,   // CSS selector (for click/fill/select)
 *   value:     string | null,   // text to type (fill) or option value (select)
 *   url:       string | null,   // destination URL (navigate)
 *   direction: "up" | "down",   // scroll direction
 *   amount:    number,          // pixels to scroll
 *   ms:        number,          // milliseconds to wait
 *   reason:    string,          // brief explanation
 *   goalReached: boolean        // true if the goal is already achieved
 * }
 *
 * @param {import('playwright').Page} page
 * @param {string} goal
 * @param {object[]} history   Previous action objects (for loop-prevention)
 * @param {{ useVision?: boolean }} [opts]
 * @returns {Promise<object>}
 */
async function planNextAction(page, goal, history = [], opts = {}) {
  const ctx = await extractPageContext(page);
  const useVision = opts.useVision !== undefined ? opts.useVision : isVisionEnabled();

  // Trim history to last 10 steps to keep prompts manageable
  const recentHistory = history.slice(-10).map((h, i) => `  Step ${i + 1}: ${h.action} → ${h.reason || ''}`).join('\n');

  const systemPrompt = `You are a Playwright browser automation agent.
Your job is to advance toward the following goal by choosing ONE action per turn.

GOAL: ${goal}

PAGE CONTEXT
  URL   : ${ctx.url}
  Title : ${ctx.title}
  Body (truncated): ${ctx.bodyText}

INTERACTIVE ELEMENTS (visible only):
${ctx.interactive.slice(0, MAX_INTERACTIVE_ELEMENTS).map(e =>
    `  [${e.tag}] selector="${e.selector}" text="${e.text}" type="${e.type}" placeholder="${e.placeholder}" ariaLabel="${e.ariaLabel}"`
  ).join('\n')}

PREVIOUS STEPS:
${recentHistory || '  (none yet)'}

Respond with a JSON object and nothing else:
{
  "action":    "click|fill|select|navigate|scroll|wait|upload_file|done|failed",
  "selector":  "<CSS selector or null>",
  "value":     "<text to type or option value, or null>",
  "url":       "<full URL for navigate, or null>",
  "direction": "up|down",
  "amount":    300,
  "ms":        1000,
  "reason":    "<one-sentence explanation>",
  "goalReached": false
}

Rules:
- Use "done" when you are confident the goal has been fully achieved.
- Use "failed" only when no progress is possible (e.g., captcha, blocked).
- Prefer selectors from the INTERACTIVE ELEMENTS list above.
- Never repeat the exact same action twice in a row.
- Use "upload_file" when you need to trigger a file upload (click the upload/select button and set the file).`;

  // Build user content with optional vision
  let userContent;
  if (useVision) {
    try {
      const screenshotB64 = await takeScreenshot(page);
      userContent = [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}` } },
        { type: 'text', text: 'What is the next action? Look at the screenshot and the interactive elements listed above.' },
      ];
    } catch {
      userContent = 'What is the next action?';
    }
  } else {
    userContent = 'What is the next action?';
  }

  try {
    const response = await fetch(getLmStudioUrl(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getLmStudioModel(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 400,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.error('[SmartAgent] planNextAction API error:', response.status);
      return { action: 'failed', reason: `API error ${response.status}`, goalReached: false };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed;
    }
  } catch (err) {
    console.error('[SmartAgent] planNextAction error:', err.message);
  }

  return { action: 'failed', reason: 'Could not parse LLM response', goalReached: false };
}

/**
 * Execute a single agent action returned by `planNextAction`.
 *
 * @param {import('playwright').Page} page
 * @param {object} action  Action object from planNextAction
 * @returns {Promise<boolean>}  true if the action was applied successfully
 */
async function executeAgentAction(page, action) {
  const { action: type, selector, value, url, direction, amount, ms } = action;

  try {
    switch (type) {
      case 'click': {
        if (!selector) return false;
        await page.waitForSelector(selector, { timeout: SELECTOR_WAIT_TIMEOUT, state: 'visible' }).catch(() => {});
        const el = await page.$(selector);
        if (!el) {
          // Fallback: try text-based click using action.value or action.reason
          const fallbackText = value || '';
          return smartClick(page, [selector], fallbackText);
        }
        await el.click();
        return true;
      }
      case 'fill': {
        if (!selector) return false;
        await page.waitForSelector(selector, { timeout: SELECTOR_WAIT_TIMEOUT, state: 'visible' }).catch(() => {});
        return smartFill(page, [selector], value || '');
      }
      case 'select': {
        if (!selector || !value) return false;
        await page.selectOption(selector, value);
        return true;
      }
      case 'navigate': {
        if (!url) return false;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return true;
      }
      case 'scroll': {
        const px = amount || 300;
        const sign = direction === 'up' ? -1 : 1;
        await page.evaluate((delta) => window.scrollBy(0, delta), sign * px);
        return true;
      }
      case 'wait': {
        await page.waitForTimeout(ms || 1000);
        return true;
      }
      case 'upload_file': {
        // Trigger file chooser by clicking the upload button, then set the file
        if (!value) {
          console.warn('[SmartAgent] upload_file action requires value (file path)');
          return false;
        }
        try {
          const clickTarget = selector || 'text=Select video';
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 10000 }),
            page.click(clickTarget).catch((clickErr) =>
              page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.click();
              }, clickTarget).catch((evalErr) => {
                console.warn('[SmartAgent] upload_file click fallback failed:', evalErr.message);
              })
            ),
          ]);
          await fileChooser.setFiles(value);
          return true;
        } catch (e) {
          console.warn('[SmartAgent] upload_file fallback to setInputFiles:', e.message);
          const fi = await page.$('input[type="file"]');
          if (fi) { await fi.setInputFiles(value); return true; }
          return false;
        }
      }
      case 'done':
      case 'failed':
        return true; // Caller checks action.action to decide whether to stop
      default:
        console.warn('[SmartAgent] Unknown action type:', type);
        return false;
    }
  } catch (err) {
    console.warn(`[SmartAgent] executeAgentAction(${type}) error:`, err.message);
    return false;
  }
}

/**
 * Detect and attempt to solve CAPTCHA/robot challenges on the current page.
 * Uses LLM vision to analyze the challenge and decide how to interact with it.
 * 
 * Handles:
 * - reCAPTCHA "I'm not a robot" checkbox
 * - Cloudflare "Verify you are human" challenges
 * - Generic "are you a robot" text challenges
 * - Cookie/security consent screens that block progress
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{detected:boolean, handled:boolean, reason:string}>}
 */
async function detectAndHandleCaptcha(page) {
  const info = await page.evaluate(() => {
    const text = (document.body?.innerText || '').substring(0, 3000).toLowerCase();
    const hasCaptchaFrame = !!(
      document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], iframe[title*="recaptcha" i]') ||
      document.querySelector('.g-recaptcha, .h-captcha, #captcha, [data-sitekey]') ||
      document.querySelector('[class*="captcha" i], [id*="captcha" i]')
    );
    const hasRobotText = text.includes('not a robot') || text.includes('are you a robot') ||
                         text.includes('verify you are human') || text.includes('unusual traffic') ||
                         text.includes('automated queries') || text.includes('bot detection') ||
                         text.includes('security check') || text.includes('prove you') ||
                         text.includes('confirm you are not') || text.includes('human verification') ||
                         text.includes('verify you\'re human') || text.includes('verification challenge');
    const hasCheckbox = !!(
      document.querySelector('[role="checkbox"]') ||
      document.querySelector('input[type="checkbox"]') ||
      document.querySelector('.recaptcha-checkbox-border')
    );
    const hasVerifyButton = !!(
      Array.from(document.querySelectorAll('button, [role="button"], a')).find(el => {
        const t = (el.textContent || '').toLowerCase();
        return t.includes('verify') || t.includes('continue') || t.includes('confirm') || t.includes('i am human');
      })
    );
    return { hasCaptchaFrame, hasRobotText, hasCheckbox, hasVerifyButton };
  }).catch(() => ({ hasCaptchaFrame: false, hasRobotText: false, hasCheckbox: false, hasVerifyButton: false }));

  if (!info.hasCaptchaFrame && !info.hasRobotText) {
    return { detected: false, handled: false, reason: 'No CAPTCHA detected' };
  }

  console.log('[SmartAgent] CAPTCHA/robot challenge detected, attempting to solve...');

  // Strategy 1: Click "I'm not a robot" checkbox (reCAPTCHA v2)
  if (info.hasCheckbox) {
    try {
      const clicked = await page.evaluate(() => {
        const checkbox = document.querySelector('[role="checkbox"], input[type="checkbox"], .recaptcha-checkbox-border');
        if (checkbox) { checkbox.click(); return true; }
        return false;
      });
      if (clicked) {
        await page.waitForTimeout(3000);
        console.log('[SmartAgent] Clicked CAPTCHA checkbox');
        return { detected: true, handled: true, reason: 'Clicked CAPTCHA checkbox' };
      }

      // Try clicking inside reCAPTCHA iframe
      for (const frame of page.frames()) {
        const frameCheckbox = await frame.$('[role="checkbox"], .recaptcha-checkbox-border, #recaptcha-anchor').catch(() => null);
        if (frameCheckbox) {
          await frameCheckbox.click();
          await page.waitForTimeout(3000);
          console.log('[SmartAgent] Clicked CAPTCHA checkbox in iframe');
          return { detected: true, handled: true, reason: 'Clicked CAPTCHA checkbox in iframe' };
        }
      }
    } catch (e) {
      console.warn('[SmartAgent] Checkbox click failed:', e.message);
    }
  }

  // Strategy 2: Click verify/continue button
  if (info.hasVerifyButton) {
    try {
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], a');
        for (const btn of buttons) {
          const t = (btn.textContent || '').trim().toLowerCase();
          if (t.includes('verify') || t.includes('continue') || t.includes('confirm') || t.includes('i am human')) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        await page.waitForTimeout(3000);
        console.log('[SmartAgent] Clicked verify/continue button');
        return { detected: true, handled: true, reason: 'Clicked verify button' };
      }
    } catch (e) {
      console.warn('[SmartAgent] Verify button click failed:', e.message);
    }
  }

  // Strategy 3: Use LLM vision to analyze the CAPTCHA and decide what to do
  if (isVisionEnabled()) {
    try {
      const screenshotB64 = await takeScreenshot(page);
      const ctx = await extractPageContext(page).catch(() => ({ url: page.url(), title: '', interactive: [], bodyText: '' }));
      
      const response = await fetch(getLmStudioUrl(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: getLmStudioModel(),
          messages: [
            {
              role: 'system',
              content: `You are a browser automation expert helping to navigate past CAPTCHA/robot verification challenges.
Analyze the screenshot and page content. Determine the best action to take to pass this verification.

Interactive elements on page:
${ctx.interactive.slice(0, 30).map(e => `  [${e.tag}] selector="${e.selector}" text="${e.text}"`).join('\n')}

Respond ONLY with JSON:
{
  "action": "click|wait|failed",
  "selector": "<CSS selector to click, or null>",
  "reason": "brief explanation",
  "canSolve": true
}

If you see a simple checkbox ("I'm not a robot"), provide the selector to click it.
If you see a Cloudflare challenge, try clicking the checkbox or verify button.
If the challenge requires solving visual puzzles (image selection), respond with action "failed" and canSolve false.`,
            },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotB64}` } },
                { type: 'text', text: 'What should I do to pass this verification challenge?' },
              ],
            },
          ],
          max_tokens: 300,
          temperature: 0.1,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.action === 'click' && parsed.selector) {
            try {
              await page.click(parsed.selector, { timeout: 5000 });
              await page.waitForTimeout(3000);
              console.log(`[SmartAgent] LLM-guided CAPTCHA click: ${parsed.selector} — ${parsed.reason}`);
              return { detected: true, handled: true, reason: `LLM solved: ${parsed.reason}` };
            } catch (clickErr) {
              console.warn('[SmartAgent] LLM CAPTCHA click failed:', clickErr.message);
            }
          }
          if (!parsed.canSolve) {
            console.warn('[SmartAgent] LLM says CAPTCHA cannot be auto-solved:', parsed.reason);
            return { detected: true, handled: false, reason: `Cannot auto-solve: ${parsed.reason}` };
          }
        }
      }
    } catch (e) {
      console.warn('[SmartAgent] LLM CAPTCHA analysis failed:', e.message);
    }
  }

  // Strategy 4: Wait and hope it auto-resolves (some challenges just need time)
  await page.waitForTimeout(5000);
  const stillBlocked = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    return text.includes('not a robot') || text.includes('verify you are human') || text.includes('captcha');
  }).catch(() => true);

  if (!stillBlocked) {
    return { detected: true, handled: true, reason: 'Challenge resolved after waiting' };
  }

  return { detected: true, handled: false, reason: 'Could not automatically solve CAPTCHA challenge' };
}

/**
 *
 * This is the equivalent of page-agent's `agent.execute()` method, adapted for
 * server-side Playwright where we control the browser externally rather than
 * injecting scripts into the page.
 *
 * @example
 * const { success, steps } = await runAgentTask(page,
 *   'Log in to YouTube Studio using the stored session, then click Upload');
 *
 * @param {import('playwright').Page} page
 * @param {string} goal          Natural-language description of the desired outcome
 * @param {object} [options]
 * @param {number}  [options.maxSteps=15]     Maximum plan→execute iterations
 * @param {number}  [options.stepDelayMs=800] Pause between steps (ms)
 * @param {boolean} [options.useVision=false] Attach screenshot to each LLM call
 * @param {boolean} [options.verbose=true]    Log each step to console
 * @returns {Promise<{success:boolean, steps:object[], finalState:string}>}
 */
async function runAgentTask(page, goal, options = {}) {
  const {
    maxSteps = 15,
    stepDelayMs = 800,
    useVision = isVisionEnabled(),
    verbose = true,
  } = options;

  const history = [];
  let success = false;
  let finalState = 'incomplete';

  if (verbose) console.log(`[AgentTask] Goal: "${goal}"`);

  for (let step = 1; step <= maxSteps; step++) {
    // Give the page a moment to settle before planning
    await page.waitForTimeout(stepDelayMs).catch(() => {});

    // Check for CAPTCHA/robot challenges before planning the next action
    let captchaHandled = false;
    try {
      const captchaCheck = await detectAndHandleCaptcha(page);
      if (captchaCheck.detected) {
        if (verbose) console.log(`[AgentTask] Step ${step}: CAPTCHA/robot check detected — attempting to solve...`);
        captchaHandled = captchaCheck.handled;
        if (captchaHandled) {
          if (verbose) console.log('[AgentTask] CAPTCHA challenge resolved, continuing...');
          history.push({ action: 'captcha_solve', reason: 'Solved CAPTCHA/robot challenge', step });
          await page.waitForTimeout(2000);
          continue;
        }
      }
    } catch (err) {
      if (verbose) console.warn('[AgentTask] CAPTCHA detection error:', err.message);
    }

    let action;
    try {
      action = await planNextAction(page, goal, history, { useVision });
    } catch (err) {
      console.error('[AgentTask] planNextAction threw:', err.message);
      finalState = 'error';
      break;
    }

    if (verbose) {
      console.log(`[AgentTask] Step ${step}/${maxSteps}: ${action.action}` +
        (action.selector ? ` selector="${action.selector}"` : '') +
        (action.value ? ` value="${action.value}"` : '') +
        (action.url ? ` url="${action.url}"` : '') +
        ` | ${action.reason || ''}`);
    }

    history.push({ ...action, step });

    if (action.action === 'done' || action.goalReached) {
      success = true;
      finalState = 'done';
      if (verbose) console.log('[AgentTask] Goal reached!');
      break;
    }

    if (action.action === 'failed') {
      finalState = 'failed';
      if (verbose) console.log('[AgentTask] Agent reported failure:', action.reason);
      break;
    }

    const ok = await executeAgentAction(page, action);
    if (!ok) {
      if (verbose) console.warn(`[AgentTask] Step ${step} action could not be executed, continuing…`);
    }
  }

  if (finalState === 'incomplete') {
    if (verbose) console.warn(`[AgentTask] Step budget (${maxSteps}) exhausted without completion.`);
  }

  return { success, steps: history, finalState };
}

module.exports = {
  takeScreenshot,
  analyzePage,
  analyzeDOMOnly,
  waitForStateChange,
  smartClick,
  smartFill,
  getApiKey,
  isVisionEnabled,
  // Agentic loop API
  extractPageContext,
  planNextAction,
  executeAgentAction,
  runAgentTask,
  detectAndHandleCaptcha,
};
