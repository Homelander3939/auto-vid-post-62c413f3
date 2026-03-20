// Smart browser agent helper for local Playwright uploaders.
// Takes screenshots, analyzes page state with AI, and decides next action.
// This gives the local server the same intelligence as the cloud version.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const LOVABLE_AI_URL = 'https://ai.gateway.lovable.dev/v1/chat/completions';

// Get the API key from env or fall back to the Supabase edge function
function getApiKey() {
  return process.env.LOVABLE_API_KEY || null;
}

/**
 * Take a screenshot and return as base64
 */
async function takeScreenshot(page) {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 60 });
  return buffer.toString('base64');
}

/**
 * Analyze the current page state using AI vision
 */
async function analyzePage(page, context) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('[SmartAgent] No LOVABLE_API_KEY, falling back to DOM analysis');
    return analyzeDOMOnly(page, context);
  }

  const screenshot = await takeScreenshot(page);
  const url = page.url();
  const title = await page.title();

  const response = await fetch(LOVABLE_AI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        {
          role: 'system',
          content: `You are a browser automation expert. Analyze the screenshot and tell me:
1. What page/state is the browser showing?
2. Is there a login form, verification challenge, error, or success state?
3. What is the single best next action to take?

Context: ${context}
Current URL: ${url}
Page title: ${title}

Respond in JSON format:
{
  "state": "login_email" | "login_password" | "verification_2fa" | "verification_code" | "logged_in" | "upload_page" | "upload_dialog" | "uploading" | "fill_details" | "processing" | "success" | "error" | "unknown",
  "description": "Brief description of what you see",
  "needs_human": false,
  "next_action": "Description of what to do next",
  "selector_hint": "CSS selector if obvious, or null"
}`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Analyze this browser screenshot. Context: ${context}` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } }
          ]
        }
      ],
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    console.error('[SmartAgent] AI analysis failed:', response.status);
    return analyzeDOMOnly(page, context);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  
  // Parse JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      console.log('[SmartAgent] Failed to parse AI response, using DOM analysis');
    }
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
      bodyText: text,
      title: document.title,
    };
  });

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

module.exports = {
  takeScreenshot,
  analyzePage,
  analyzeDOMOnly,
  waitForStateChange,
  smartClick,
  smartFill,
  getApiKey,
};
