// Per-userDataDir mutex + retry wrapper for chromium.launchPersistentContext.
// Prevents "browserType.launchPersistentContext: ... ProcessSingleton" errors
// when two scheduled uploads try to open the same profile concurrently.
//
// Behavior:
//  - Acquires a per-userDataDir lock BEFORE launching.
//  - Releases the lock when the returned context emits 'close'
//    (or when launch itself throws).
//  - Retries lock-related launch failures with a configurable wait.
//  - Cleans stale Chromium SingletonLock symlinks left from killed runs.
const fs = require('fs');
const path = require('path');

const locks = new Map(); // key -> { promise, resolve }

function acquire(key) {
  const prev = locks.get(key);
  let release;
  const ticket = new Promise((r) => { release = r; });
  const wait = prev ? prev.promise.catch(() => {}) : Promise.resolve();
  const entry = { promise: ticket };
  locks.set(key, entry);
  return wait.then(() => ({ release, entry }));
}

function clearStaleSingletonLocks(userDataDir) {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(userDataDir, name);
    try { fs.lstatSync(p); fs.unlinkSync(p); } catch {}
  }
}

async function launchPersistentSafe(chromium, userDataDir, options, opts = {}) {
  const { attempts = 3, waitMs = 90000, label = 'profile' } = opts;
  const key = path.resolve(userDataDir);
  const { release, entry } = await acquire(key);

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const context = await chromium.launchPersistentContext(userDataDir, options);
      // Release lock when this context is fully closed
      const cleanup = () => {
        try { release(); } catch {}
        if (locks.get(key) === entry) {
          // best-effort cleanup of map entry
          locks.delete(key);
        }
      };
      context.once('close', cleanup);
      return context;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isLockIssue = /launchPersistentContext|ProcessSingleton|SingletonLock|user data directory is already in use|Failed to create|Target page, context or browser has been closed/i.test(msg);
      console.warn(`[ProfileLock] ${label} launch attempt ${i + 1}/${attempts} failed: ${msg.slice(0, 200)}`);
      if (!isLockIssue || i === attempts - 1) break;
      clearStaleSingletonLocks(userDataDir);
      console.log(`[ProfileLock] ${label} waiting ${Math.round(waitMs / 1000)}s before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  // Launch failed terminally — release lock
  try { release(); } catch {}
  if (locks.get(key) === entry) locks.delete(key);
  throw lastErr;
}

module.exports = { launchPersistentSafe, clearStaleSingletonLocks };
