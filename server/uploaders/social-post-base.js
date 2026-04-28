// Shared helpers for social post uploaders (X, Facebook, TikTok-photo).
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { getSharedBrowserProfileDir } = require('../browserProfiles');
const { launchPersistentSafe } = require('../profileLock');

function resolveUserDataDir(platform, browserProfileId, accountId) {
  if (browserProfileId) return getSharedBrowserProfileDir(browserProfileId);
  const base = path.join(__dirname, '..', 'data', 'browser-sessions', `social-${platform}`);
  return accountId ? path.join(base, accountId) : base;
}

async function launchPersistent(platform, opts = {}) {
  const userDataDir = resolveUserDataDir(platform, opts.browserProfileId, opts.accountId);
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await launchPersistentSafe(chromium, userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  }, { label: `social-${platform}:${opts.browserProfileId || opts.accountId || 'default'}` });
  return context;
}

async function safeClose(context) {
  try { await context?.close(); } catch {}
}

async function fileExistsLocally(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

module.exports = { resolveUserDataDir, launchPersistent, safeClose, fileExistsLocally };
