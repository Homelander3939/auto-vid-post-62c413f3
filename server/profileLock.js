// Per-userDataDir mutex + retry wrapper for chromium.launchPersistentContext.
// Prevents "browserType.launchPersistentContext: ... ProcessSingleton" errors
// when two scheduled uploads try to open the same profile concurrently.
const fs = require('fs');
const path = require('path');

const locks = new Map(); // userDataDir -> Promise chain tail

function withProfileLock(userDataDir, fn) {
  const key = path.resolve(userDataDir);
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  // Keep chain alive even on rejection so subsequent waiters still run
  locks.set(key, next.catch(() => {}));
  next.finally(() => {
    if (locks.get(key) === next || locks.get(key) === next.catch(() => {})) {
      // best-effort cleanup; safe to leave the resolved promise
    }
  });
  return next;
}

function clearStaleSingletonLocks(userDataDir) {
  // Chromium leaves SingletonLock/SingletonCookie/SingletonSocket symlinks
  // behind if a previous run was killed. They block new launches.
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(userDataDir, name);
    try { fs.lstatSync(p); fs.unlinkSync(p); } catch {}
  }
}

async function launchWithRetry(chromium, userDataDir, options, { attempts = 3, waitMs = 60000, label = 'profile' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launchPersistentContext(userDataDir, options);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isLockIssue = /launchPersistentContext|ProcessSingleton|SingletonLock|user data directory is already in use|Failed to create/i.test(msg);
      console.warn(`[ProfileLock] ${label} launch attempt ${i + 1}/${attempts} failed: ${msg.slice(0, 200)}`);
      if (!isLockIssue || i === attempts - 1) break;
      // Try to clear stale lock files, then wait before retry
      clearStaleSingletonLocks(userDataDir);
      console.log(`[ProfileLock] ${label} waiting ${Math.round(waitMs / 1000)}s before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Convenience: lock + retry in one call
async function launchPersistentSafe(chromium, userDataDir, options, opts = {}) {
  return withProfileLock(userDataDir, () => launchWithRetry(chromium, userDataDir, options, opts));
}

module.exports = { withProfileLock, launchWithRetry, launchPersistentSafe, clearStaleSingletonLocks };
