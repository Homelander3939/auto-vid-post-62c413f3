const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { chromium } = require('playwright');

const DATA_DIR = path.join(__dirname, 'data');
const SHARED_PROFILES_DIR = path.join(DATA_DIR, 'browser-profiles', 'shared');
const LEGACY_SESSIONS_DIR = path.join(DATA_DIR, 'browser-sessions');
const STATE_FILE = path.join(DATA_DIR, 'browser-profiles.json');

const PROFILE_URLS = {
  youtube: 'https://studio.youtube.com',
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  instagram: 'https://www.instagram.com',
  'social-x': 'https://x.com/compose/post',
  'social-linkedin': 'https://www.linkedin.com/feed/',
  'social-facebook': 'https://www.facebook.com/',
};

const openContexts = new Map();

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function emptyState() {
  return {
    profiles: [],
    accountLinks: {},
    jobSelections: {},
    scheduledSelections: {},
  };
}

function sanitizeSelections(selections = {}) {
  const allowedPlatforms = new Set(['youtube', 'tiktok', 'instagram', 'x', 'linkedin', 'facebook']);
  return Object.fromEntries(
    Object.entries(selections || {}).filter(([platform, accountId]) => {
      return allowedPlatforms.has(platform) && typeof accountId === 'string' && accountId.trim().length > 0;
    }),
  );
}

function normalizeState(raw = {}) {
  return {
    profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    accountLinks: raw.accountLinks && typeof raw.accountLinks === 'object' ? raw.accountLinks : {},
    jobSelections: raw.jobSelections && typeof raw.jobSelections === 'object' ? raw.jobSelections : {},
    scheduledSelections: raw.scheduledSelections && typeof raw.scheduledSelections === 'object' ? raw.scheduledSelections : {},
  };
}

function readState() {
  ensureDir(DATA_DIR);
  ensureDir(SHARED_PROFILES_DIR);

  if (!fs.existsSync(STATE_FILE)) {
    const initial = emptyState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')));
  } catch {
    const initial = emptyState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function writeState(state) {
  const normalized = normalizeState(state);
  ensureDir(DATA_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function listBrowserProfiles() {
  const state = readState();
  return {
    profiles: [...state.profiles].sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()),
    accountLinks: state.accountLinks,
  };
}

function upsertBrowserProfile({ profileId, label }) {
  const state = readState();
  const normalizedLabel = String(label || '').trim() || 'Browser Profile';
  let profile = state.profiles.find((item) => item.id === profileId);

  if (!profile) {
    profile = {
      id: profileId || randomUUID(),
      label: normalizedLabel,
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
    };
    state.profiles.push(profile);
  } else {
    profile.label = normalizedLabel;
  }

  writeState(state);
  return profile;
}

function linkAccountToBrowserProfile(accountId, profileId) {
  const state = readState();
  state.accountLinks[String(accountId)] = String(profileId);
  writeState(state);
}

function getBrowserProfileForAccount(accountId) {
  const state = readState();
  const profileId = state.accountLinks[String(accountId)];
  if (!profileId) return null;
  const profile = state.profiles.find((item) => item.id === profileId);
  return profile ? { ...profile, directory: getSharedBrowserProfileDir(profile.id) } : null;
}

function getSharedBrowserProfileDir(profileId) {
  return path.join(SHARED_PROFILES_DIR, String(profileId));
}

function hasLegacyPlatformProfile(platform, accountId) {
  try {
    const dirPath = path.join(LEGACY_SESSIONS_DIR, String(platform), String(accountId));
    return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function saveJobAccountSelections(jobId, selections) {
  const state = readState();
  state.jobSelections[String(jobId)] = sanitizeSelections(selections);
  writeState(state);
  return state.jobSelections[String(jobId)];
}

function getJobAccountSelections(jobId) {
  const state = readState();
  return sanitizeSelections(state.jobSelections[String(jobId)]);
}

function saveScheduledAccountSelections(scheduledId, selections) {
  const state = readState();
  state.scheduledSelections[String(scheduledId)] = sanitizeSelections(selections);
  writeState(state);
  return state.scheduledSelections[String(scheduledId)];
}

function getScheduledAccountSelections(scheduledId) {
  const state = readState();
  return sanitizeSelections(state.scheduledSelections[String(scheduledId)]);
}

function copyScheduledSelectionsToJob(scheduledId, jobId) {
  const state = readState();
  const selections = sanitizeSelections(state.scheduledSelections[String(scheduledId)]);
  if (Object.keys(selections).length > 0) {
    state.jobSelections[String(jobId)] = selections;
    writeState(state);
  }
  return selections;
}

async function getOrCreateOpenContext(profileId) {
  const existing = openContexts.get(profileId);
  if (existing) return existing;

  const userDataDir = getSharedBrowserProfileDir(profileId);
  ensureDir(userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  context.on('close', () => openContexts.delete(profileId));
  openContexts.set(profileId, context);
  return context;
}

async function openBrowserProfileSession({ profileId, platform }) {
  const context = await getOrCreateOpenContext(profileId);
  const page = context.pages()[0] || await context.newPage();
  const url = PROFILE_URLS[platform] || PROFILE_URLS.youtube;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.bringToFront().catch(() => {});

  const state = readState();
  const profile = state.profiles.find((item) => item.id === profileId);
  if (profile) {
    profile.lastOpenedAt = new Date().toISOString();
    writeState(state);
  }

  return { profileId, url, userDataDir: getSharedBrowserProfileDir(profileId) };
}

module.exports = {
  copyScheduledSelectionsToJob,
  getBrowserProfileForAccount,
  getJobAccountSelections,
  getScheduledAccountSelections,
  getSharedBrowserProfileDir,
  hasLegacyPlatformProfile,
  linkAccountToBrowserProfile,
  listBrowserProfiles,
  openBrowserProfileSession,
  saveJobAccountSelections,
  saveScheduledAccountSelections,
  upsertBrowserProfile,
};