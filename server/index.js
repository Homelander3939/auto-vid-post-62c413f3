// Local server — autonomous browser automation worker.
// Reads jobs from Supabase, downloads videos, and uploads via Playwright.

// Load .env file if present (for LOVABLE_API_KEY and other env vars)
const dotenvPath = require('path').join(__dirname, '.env');
if (require('fs').existsSync(dotenvPath)) {
  const envContent = require('fs').readFileSync(dotenvPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
  console.log('[Server] Loaded .env file');
}

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { uploadToYouTube } = require('./uploaders/youtube');
const { uploadToTikTok } = require('./uploaders/tiktok');
const { uploadToInstagram } = require('./uploaders/instagram');
const { checkPlatformStats, formatStatsForTelegram, runBrowserTask } = require('./uploaders/stats-scraper');
const { sendTelegram } = require('./telegram');
const { scanFolder, scanAllFiles } = require('./folderWatcher');
const { parseTextFile } = require('./textParser');
const { processTelegramAIResponse, streamLMStudio, LM_STUDIO_URL, discoverLMStudioModels, refreshLMStudioConfigFromSettings, testLMStudioConnection } = require('./ai-handler');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const {
  copyScheduledSelectionsToJob,
  getBrowserProfileForAccount,
  getJobAccountSelections,
  getScheduledAccountSelections,
  linkAccountToBrowserProfile,
  listBrowserProfiles,
  openBrowserProfileSession,
  saveJobAccountSelections,
  saveScheduledAccountSelections,
  upsertBrowserProfile,
} = require('./browserProfiles');

const app = express();
app.use(cors());
app.use(express.json());

// --- Supabase client ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mgcfeddzbgpcnzdgxzfp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nY2ZlZGR6YmdwY256ZGd4emZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDM3MDMsImV4cCI6MjA4OTU3OTcwM30.-EuZuspd55AdbVfpY5pFSw8Wuk_56iYbtOgCOMDOLhE';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Track jobs currently being processed to prevent duplicates
const processingJobs = new Set();

// --- Helpers ---
async function getSettings() {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  if (!data) throw new Error('No settings found. Configure settings in the web UI first.');

  let resolvedChatId = data.telegram_chat_id ? String(data.telegram_chat_id).trim() : '';
  if (data.telegram_enabled && !resolvedChatId) {
    const { data: latestMessage } = await supabase
      .from('telegram_messages')
      .select('chat_id')
      .eq('is_bot', false)
      .order('created_at', { ascending: false })
      .limit(1);

    const fallbackChatId = latestMessage?.[0]?.chat_id;
    if (fallbackChatId !== null && fallbackChatId !== undefined && String(fallbackChatId).trim()) {
      resolvedChatId = String(fallbackChatId).trim();
      await supabase.from('app_settings').update({ telegram_chat_id: resolvedChatId }).eq('id', 1);
    }
  }

  return {
    folderPath: data.folder_path,
    youtube: { email: data.youtube_email, password: data.youtube_password, enabled: data.youtube_enabled },
    tiktok: { email: data.tiktok_email, password: data.tiktok_password, enabled: data.tiktok_enabled },
    instagram: { email: data.instagram_email, password: data.instagram_password, enabled: data.instagram_enabled },
    telegram: { botToken: data.telegram_bot_token, chatId: resolvedChatId, enabled: data.telegram_enabled },
    backend: { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY },
  };
}

// Strip leaked LLM "thinking process" sections (common with Qwen/Gemma) so Telegram + chat
// only see the useful result. Mirrors the sanitization done in the cloud edge functions.
function sanitizeOutgoingMessage(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  const leakMarkers = [
    /(?:^|\n)\s*(?:here'?s\s+(?:a\s+)?)?thinking process\s*:/i,
    /(?:^|\n)\s*\d+\.\s*\*\*(?:analy[sz]e user input|check context|formulate response|self-correction|verification)\b/i,
    /(?:^|\n)\s*(?:draft|self-correction\/verification)\s*:/i,
  ];
  if (leakMarkers.some((re) => re.test(s))) {
    const next = s.match(/Next action\s*:\s*([^\n]+)/i)?.[1];
    s = next ? `Done. Next action: ${next.trim()}` : 'Done.';
  }
  return s.slice(0, 3900);
}

async function notifyTelegram(settings, message) {
  const text = sanitizeOutgoingMessage(message);
  if (!text) return;
  if (!settings.telegram?.enabled || !settings.telegram?.chatId) return;
  try {
    await sendTelegram(settings.telegram.botToken, settings.telegram.chatId, text, settings.backend);
  } catch (e) {
    console.error('[Telegram] Notification failed:', e.message);
  }
  // Mirror into telegram_messages so AI Chat (web) shows the same bot reply that the
  // user sees in Telegram. getUpdates does not return our own outgoing messages, so
  // without this mirror the chat UI never reflects worker-side notifications
  // (Instagram/social posts, browser results, stats summaries, etc.).
  try {
    const numericChat = Number(settings.telegram.chatId);
    if (Number.isFinite(numericChat)) {
      await supabase.from('telegram_messages').insert({
        update_id: -Math.floor(Date.now() + Math.random() * 1000),
        chat_id: numericChat,
        text: text.slice(0, 3000),
        is_bot: true,
        raw_update: { source: 'local-worker' },
      });
    }
  } catch (e) {
    // Non-fatal; logging only.
    console.warn('[Telegram] Mirror to chat history failed:', e.message);
  }
}

const uploaders = { youtube: uploadToYouTube, tiktok: uploadToTikTok, instagram: uploadToInstagram };

function resolveMetadataForVideo(baseDir, videoFileName, fallbackTitle = '', fallbackDescription = '', fallbackTags = []) {
  let resolvedTitle = fallbackTitle;
  let resolvedDescription = fallbackDescription;
  let resolvedTags = Array.isArray(fallbackTags) ? fallbackTags : [];

  if (!baseDir || !videoFileName) {
    return { title: resolvedTitle, description: resolvedDescription, tags: resolvedTags };
  }

  const stem = path.basename(videoFileName, path.extname(videoFileName));
  const candidates = [
    path.join(baseDir, `${stem}.txt`),
    path.join(baseDir, `${stem}.TXT`),
  ];

  const matchedTextPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!matchedTextPath) {
    return { title: resolvedTitle, description: resolvedDescription, tags: resolvedTags };
  }

  try {
    const parsed = parseTextFile(matchedTextPath);
    if (parsed.title) resolvedTitle = parsed.title;
    if (parsed.description) resolvedDescription = parsed.description;
    if (Array.isArray(parsed.tags) && parsed.tags.length > 0) resolvedTags = parsed.tags;
    console.log(`[Worker] Matched metadata file for ${videoFileName}: ${path.basename(matchedTextPath)}`);
  } catch (err) {
    console.warn(`[Worker] Failed to parse metadata file for ${videoFileName}: ${err.message}`);
  }

  return { title: resolvedTitle, description: resolvedDescription, tags: resolvedTags };
}

function normalizeFolderPath(folderPath) {
  return String(folderPath || '')
    .replace(/^\[folder(?:\|\d+)?\]\s*/i, '')
    .replace(/^"(.+)"$/, '$1')
    .replace(/^'(.+)'$/, '$1')
    .trim();
}

function parseFolderIntensity(marker) {
  const m = String(marker || '').match(/^\[folder\|(\d+)\]/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getReadyPlatforms(settings, requestedPlatforms = []) {
  return (Array.isArray(requestedPlatforms) ? requestedPlatforms : []).filter((platform) => {
    const config = settings?.[platform];
    return Boolean(config?.enabled && config?.email && config?.password);
  });
}

function normalizeAccountGroupKey(account = {}) {
  const label = String(account.label || '').trim().toLowerCase();
  if (label) return `label:${label}`;
  const emailPrefix = String(account.email || '').trim().toLowerCase().split('@')[0];
  return emailPrefix ? `email:${emailPrefix}` : '';
}

function getRelatedAccounts(accounts = [], seedAccount) {
  if (!seedAccount) return [];
  const key = normalizeAccountGroupKey(seedAccount);
  if (!key) return [seedAccount];
  return accounts.filter((account) => normalizeAccountGroupKey(account) === key);
}

function findLinkedSiblingBrowserProfile(account, accounts = []) {
  const siblings = getRelatedAccounts(accounts, account);
  for (const sibling of siblings) {
    const profile = getBrowserProfileForAccount(sibling.id);
    if (profile) return profile;
  }
  return null;
}

async function getAccountsByIds(accountIds = []) {
  const uniqueIds = [...new Set(accountIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const { data } = await supabase.from('platform_accounts').select('*').in('id', uniqueIds);
  return data || [];
}

async function getAllPlatformAccounts() {
  const { data } = await supabase.from('platform_accounts').select('*');
  return data || [];
}

async function getReadyPlatformsForSelections(settings, requestedPlatforms = [], selections = {}) {
  const selectedAccounts = await getAccountsByIds(Object.values(selections || {}));
  const selectedAccountsById = new Map(selectedAccounts.map((account) => [account.id, account]));

  return (Array.isArray(requestedPlatforms) ? requestedPlatforms : []).filter((platform) => {
    const selectedAccountId = selections?.[platform];
    const selectedAccount = selectedAccountId ? selectedAccountsById.get(selectedAccountId) : null;
    if (selectedAccount) {
      return Boolean(selectedAccount.enabled && selectedAccount.email && selectedAccount.password);
    }

    const config = settings?.[platform];
    return Boolean(config?.enabled && config?.email && config?.password);
  });
}

async function loadJobAccountContext(job) {
  const selections = getJobAccountSelections(job.id);
  const accountIds = new Set(Object.values(selections || {}).filter(Boolean));
  if (job.account_id) accountIds.add(job.account_id);

  const accounts = await getAccountsByIds([...accountIds]);
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const normalizedSelections = { ...selections };

  if (job.account_id) {
    const legacyAccount = accountsById.get(job.account_id);
    if (legacyAccount && !normalizedSelections[legacyAccount.platform]) {
      normalizedSelections[legacyAccount.platform] = legacyAccount.id;
    }
  }

  return {
    selections: normalizedSelections,
    accounts,
    accountsById,
  };
}

async function processJob(jobId, options = {}) {
  // Prevent duplicate processing
  if (processingJobs.has(jobId)) {
    console.log(`[Worker] Job ${jobId} already being processed, skipping`);
    return;
  }
  processingJobs.add(jobId);

  try {
    const { data: job } = await supabase.from('upload_jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'pending') {
      processingJobs.delete(jobId);
      return;
    }

    const settings = await getSettings();

    const accountContext = await loadJobAccountContext(job);

    const folderPathOverride = normalizeFolderPath(options.folderPath);
    const results = job.platform_results || [];

    // === CREDENTIAL VALIDATION: Skip platforms without credentials ===
    // If accountCredentials exists, use those for the matching platform
    for (const platform of results) {
      if (platform.status !== 'pending') continue;
      
      const selectedAccountId = accountContext.selections[platform.name];
      const selectedAccount = selectedAccountId ? accountContext.accountsById.get(selectedAccountId) : null;
      const ps = selectedAccount
        ? { email: selectedAccount.email, password: selectedAccount.password, enabled: selectedAccount.enabled }
        : settings[platform.name];
      
      if (!ps?.enabled) {
        platform.status = 'error';
        platform.error = `${platform.name} is not enabled in Settings`;
        continue;
      }
      if (!ps?.email || !ps?.password) {
        platform.status = 'error';
        platform.error = `${platform.name} credentials not configured. Add email & password in Settings.`;
        continue;
      }
    }

    const actionable = results.filter(r => r.status === 'pending');
    if (actionable.length === 0) {
      const errorMessages = results.filter(r => r.status === 'error').map(r => `❌ ${r.name}: ${r.error}`);
      await supabase.from('upload_jobs').update({
        status: 'failed', platform_results: results, completed_at: new Date().toISOString(),
      }).eq('id', jobId);
      await notifyTelegram(settings, `❌ <b>Upload Failed</b>\n📹 ${job.title || job.video_file_name}\n\n${errorMessages.join('\n')}`);
      return;
    }

    // Determine video path
    let videoPath;
    let resolvedTitle = job.title;
    let resolvedDescription = job.description;
    let resolvedTags = job.tags;

    if (job.video_storage_path) {
      const { data: fileData, error } = await supabase.storage.from('videos').download(job.video_storage_path);
      if (error || !fileData) {
        console.error('Failed to download video from storage:', error);
        await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
        await notifyTelegram(settings, `❌ Failed to download video: ${job.video_file_name}`);
        return;
      }
      const tempDir = path.join(__dirname, 'data', 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      videoPath = path.join(tempDir, job.video_file_name);
      const buffer = Buffer.from(await fileData.arrayBuffer());
      fs.writeFileSync(videoPath, buffer);
    } else if (typeof job.video_file_name === 'string' && /^\[folder(?:\|\d+)?\]\s/i.test(job.video_file_name)) {
      const folderPath = normalizeFolderPath(job.video_file_name);
      const { videoFile, textFile } = scanFolder(folderPath);

      if (!videoFile) {
        console.error(`Video file not found in folder: ${folderPath}`);
        await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
        await notifyTelegram(settings, `❌ No video file found in folder: ${folderPath}`);
        return;
      }

      videoPath = path.join(folderPath, videoFile);

      if (textFile) {
        const parsed = parseTextFile(path.join(folderPath, textFile));
        if (!resolvedTitle || resolvedTitle === '(auto from folder)') resolvedTitle = parsed.title || videoFile;
        if (!resolvedDescription) resolvedDescription = parsed.description || '';
        if (!Array.isArray(resolvedTags) || resolvedTags.length === 0) resolvedTags = parsed.tags || [];
      } else if (!resolvedTitle || resolvedTitle === '(auto from folder)') {
        const generated = generateMetadataFromFilename(videoFile);
        resolvedTitle = generated.title;
        if (!resolvedDescription) resolvedDescription = generated.description;
        if (!Array.isArray(resolvedTags) || resolvedTags.length === 0) resolvedTags = generated.tags;
      }
    } else if (path.isAbsolute(job.video_file_name)) {
      videoPath = job.video_file_name;
    } else {
      const baseFolder = folderPathOverride || normalizeFolderPath(settings.folderPath);
      if (baseFolder) {
        videoPath = path.join(baseFolder, job.video_file_name);
      }
    }

    if (!videoPath || !fs.existsSync(videoPath)) {
      console.error('Video file not found:', videoPath);
      await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
      await notifyTelegram(settings, `❌ Video file not found: ${job.video_file_name}`);
      return;
    }

    const metadataBaseDir = path.dirname(videoPath);
    const matchedMetadata = resolveMetadataForVideo(
      metadataBaseDir,
      path.basename(videoPath),
      resolvedTitle,
      resolvedDescription,
      resolvedTags,
    );
    resolvedTitle = matchedMetadata.title;
    resolvedDescription = matchedMetadata.description;
    resolvedTags = matchedMetadata.tags;

    const metadata = { title: resolvedTitle, description: resolvedDescription, tags: resolvedTags };
    console.log(`[Worker] Job ${jobId} metadata — title: "${metadata.title}", desc: "${(metadata.description || '').slice(0, 80)}", tags: [${(metadata.tags || []).join(', ')}]`);
    await supabase.from('upload_jobs').update({ status: 'uploading', platform_results: results }).eq('id', jobId);

    for (const platform of results) {
      if (platform.status !== 'pending') continue;
      if (!uploaders[platform.name]) continue;

      platform.status = 'uploading';
      await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);

      try {
        console.log(`[Worker] Uploading to ${platform.name}...`);
        const selectedAccountId = accountContext.selections[platform.name];
        const selectedAccount = selectedAccountId ? accountContext.accountsById.get(selectedAccountId) : null;
        const platformCreds = selectedAccount
          ? { email: selectedAccount.email, password: selectedAccount.password, enabled: true }
          : settings[platform.name];
        const browserProfile = selectedAccount
          ? getBrowserProfileForAccount(selectedAccount.id) || findLinkedSiblingBrowserProfile(selectedAccount, accountContext.accounts)
          : null;
        const accountId = selectedAccount && (!selectedAccount.is_default || browserProfile?.id)
          ? selectedAccount.id
          : undefined;

        if (selectedAccount) {
          console.log(`[Worker] Using account "${selectedAccount.label || selectedAccount.email}" for ${platform.name}${browserProfile?.id ? ` via shared profile ${browserProfile.id}` : ''}`);
        }

        const result = await uploaders[platform.name](videoPath, metadata, {
          ...platformCreds,
          accountId,
          browserProfileId: browserProfile?.id,
          telegram: settings.telegram,
          backend: settings.backend,
        });
        platform.status = 'success';
        platform.url = result.url || '';
        platform.recentStats = [];
        console.log(`[Worker] ${platform.name} upload SUCCESS`);
      } catch (err) {
        platform.status = 'error';
        platform.error = err.message;
        console.error(`[Worker] ${platform.name} upload FAILED:`, err.message);
      }

      await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);
    }

    // Final status
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const finalStatus = errorCount > 0 && successCount === 0 ? 'failed' : errorCount > 0 ? 'partial' : 'completed';

    await supabase.from('upload_jobs').update({
      status: finalStatus, platform_results: results, completed_at: new Date().toISOString(),
    }).eq('id', jobId);

    // === SEND FINAL TELEGRAM SUMMARY WITH STATS ===
    const lines = results.map(r => {
      if (r.status === 'success') return `✅ ${r.name}: Success${r.url ? ' — ' + r.url : ''}`;
      if (r.status === 'error') return `❌ ${r.name}: ${r.error}`;
      return `⚪ ${r.name}: ${r.status}`;
    });
    const emoji = finalStatus === 'completed' ? '🎉' : finalStatus === 'partial' ? '⚠️' : '❌';
    const summaryMsg = `${emoji} <b>Upload ${finalStatus}</b>\n📹 ${metadata.title || job.video_file_name}\n\n${lines.join('\n')}`;

    await notifyTelegram(settings, summaryMsg);

    // Cleanup temp file
    if (job.video_storage_path && videoPath) {
      try { fs.unlinkSync(videoPath); } catch {}
    }
  } finally {
    processingJobs.delete(jobId);
  }
}

// --- API Endpoints ---
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    mode: 'local',
    name: 'Auto Vid Post — Local Server',
    endpoints: {
      health: 'GET /api/health',
      processJob: 'POST /api/process/:id',
      processPending: 'POST /api/process-pending',
    },
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', mode: 'local' }));

app.post('/api/ai/models', async (req, res) => {
  try {
    const { baseUrl, apiKey } = req.body || {};
    const config = await refreshLMStudioConfigFromSettings(supabase);
    const models = await discoverLMStudioModels(baseUrl || config.url, apiKey || config.apiKey);
    res.json({ models, provider: 'lmstudio', baseUrl: baseUrl || config.url });
  } catch (err) {
    console.error('[AI] LM Studio model discovery failed:', err.message);
    res.status(502).json({ error: err.message || 'Could not load LM Studio models' });
  }
});

app.post('/api/ai/test', async (req, res) => {
  try {
    const { baseUrl, apiKey, model } = req.body || {};
    const config = await refreshLMStudioConfigFromSettings(supabase);
    const result = await testLMStudioConnection({
      baseUrl: baseUrl || config.url,
      apiKey: apiKey || config.apiKey,
      model: model || config.model,
    });
    res.json(result);
  } catch (err) {
    console.error('[AI] LM Studio test failed:', err.message);
    res.status(502).json({ ok: false, error: err.message || 'LM Studio test failed' });
  }
});

// --- Research search endpoint (DuckDuckGo HTML → Brave/Google scrape via persistent browser) ---
// Used by the cloud AI agent when no research API key is configured.
// Strategy:
//   1) Cheap DuckDuckGo HTML scrape (no browser).
//   2) If empty/blocked, open a PERSISTENT Chromium context (shared profile, like uploads) and
//      try Brave Search → Google → DuckDuckGo, in that order. Visible by default so the user
//      can watch + intervene on captchas, matching the upload-flow behavior.
const { launchPersistent: launchPersistentSocial, safeClose: safeCloseSocial } = require('./uploaders/social-post-base');

async function scrapeWithLocalBrowser(query, count, { headless = false } = {}) {
  const context = await launchPersistentSocial('research', {});
  try {
    if (!headless) {
      // Visible mode is the default — but persistent context already shows. Nothing extra needed.
    }
    const page = await context.newPage();
    // 1) Brave (no captchas, often best results)
    try {
      await page.goto(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const r = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('div.snippet, div[data-type="web"], #results .snippet').forEach((el) => {
          if (out.length >= max) return;
          const a = el.querySelector('a[href^="http"]');
          const t = el.querySelector('.title, .snippet-title, h3, .url');
          const sn = el.querySelector('.snippet-description, .description, p');
          if (a && t) out.push({ title: (t.textContent || '').trim(), url: a.href, snippet: sn ? (sn.textContent || '').trim() : '' });
        });
        return out;
      }, count);
      if (r.length) return { provider: 'brave-local', results: r };
    } catch (e) { console.warn('[Research] Brave-local failed:', e.message); }

    // 2) DuckDuckGo via the visible browser (handles JS challenges DDG html sometimes shows)
    try {
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(800);
      const r = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('article[data-testid="result"], .react-results--main article').forEach((el) => {
          if (out.length >= max) return;
          const a = el.querySelector('a[data-testid="result-title-a"], h2 a');
          const sn = el.querySelector('[data-result="snippet"], .result__snippet');
          if (a) out.push({ title: (a.textContent || '').trim(), url: a.href, snippet: sn ? (sn.textContent || '').trim() : '' });
        });
        return out;
      }, count);
      if (r.length) return { provider: 'duckduckgo-local', results: r };
    } catch (e) { console.warn('[Research] DDG-local failed:', e.message); }

    // 3) Google as last resort (may show captcha — visible browser lets the user solve it)
    try {
      await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=${count}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const r = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('div.g, div.MjjYud').forEach((el) => {
          if (out.length >= max) return;
          const a = el.querySelector('a[href^="http"]');
          const h3 = el.querySelector('h3');
          const sn = el.querySelector('div[data-sncf], .VwiC3b, .yXK7lf');
          if (a && h3) out.push({ title: h3.textContent || '', url: a.href, snippet: sn ? (sn.textContent || '') : '' });
        });
        return out;
      }, count);
      if (r.length) return { provider: 'google-local', results: r };
    } catch (e) { console.warn('[Research] Google-local failed:', e.message); }

    return { provider: 'none', results: [] };
  } finally {
    await safeCloseSocial(context);
  }
}

async function searchImagesFromSourcePages(urls = [], count = 3) {
  const targets = [...new Set((Array.isArray(urls) ? urls : []).filter(Boolean))].slice(0, 4);
  if (targets.length === 0) return { provider: 'source-pages', images: [] };

  const context = await launchPersistentSocial('research', {});
  try {
    const page = await context.newPage();
    const images = [];
    const screenshotFallbacks = [];

    for (const targetUrl of targets) {
      if (images.length >= count) break;
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1200);

        const found = await page.evaluate(({ max, pageUrl }) => {
          const pushUnique = (list, item) => {
            if (!item?.url) return;
            if (list.some((entry) => entry.url === item.url)) return;
            list.push(item);
          };

          const absolutize = (value) => {
            if (!value) return '';
            try { return new URL(value, pageUrl).toString(); } catch { return ''; }
          };

          const isUsable = (value) => {
            const url = String(value || '').trim();
            if (!/^https?:/i.test(url)) return false;
            if (/sprite|icon|logo|avatar|1x1|blank|emoji/i.test(url)) return false;
            return true;
          };

          const out = [];

          const ogImage = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]')?.getAttribute('content');
          const ogAlt = document.querySelector('meta[property="og:image:alt"], meta[name="twitter:image:alt"]')?.getAttribute('content') || '';
          const ogUrl = absolutize(ogImage);
          if (isUsable(ogUrl)) {
            pushUnique(out, { url: ogUrl, source: 'source-page-meta', pageUrl, title: document.title || '', alt: ogAlt || '' });
          }

          document.querySelectorAll('article img, main img, figure img, img').forEach((img) => {
            if (out.length >= max) return;
            const width = Number(img.getAttribute('width') || img.naturalWidth || img.clientWidth || 0);
            const height = Number(img.getAttribute('height') || img.naturalHeight || img.clientHeight || 0);
            if (width < 220 || height < 180) return;

            const candidate = absolutize(
              img.getAttribute('src') ||
              img.getAttribute('data-src') ||
              img.getAttribute('data-lazy-src') ||
              img.currentSrc ||
              ''
            );
            if (!isUsable(candidate)) return;

            const alt = (img.getAttribute('alt') || '').trim();
            pushUnique(out, {
              url: candidate,
              source: 'source-page-dom',
              pageUrl,
              title: document.title || '',
              alt,
            });
          });

          return out.slice(0, max);
        }, { max: Math.max(1, count - images.length), pageUrl: targetUrl });

        if (found.length) {
          images.push(...found.filter((item) => item?.url));
          continue;
        }

        // ── SCREENSHOT FALLBACK ──
        // If a source page exposed no usable image (paywall / aggressive lazy-loading /
        // pure text article), capture the viewport itself as a data: URL so the cloud
        // edge function can still attach something visual to the post.
        try {
          const buf = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
          if (buf && buf.length) {
            const dataUrl = `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`;
            const titleText = await page.title().catch(() => '');
            screenshotFallbacks.push({
              url: dataUrl,
              source: 'source-page-screenshot',
              pageUrl: targetUrl,
              title: titleText || hostnameOf(targetUrl) || targetUrl,
              alt: `Screenshot of ${targetUrl}`,
            });
            console.log(`[Image] Captured screenshot fallback for ${targetUrl} (${buf.length} bytes)`);
          }
        } catch (e) {
          console.warn(`[Image] Screenshot fallback failed for ${targetUrl}:`, e.message);
        }
      } catch (e) {
        console.warn(`[Image] Source page scan failed for ${targetUrl}:`, e.message);
      }
    }

    // Prefer real images; only fall back to screenshots if no real images were found.
    const finalImages = images.length ? images.slice(0, count) : screenshotFallbacks.slice(0, count);
    return { provider: 'source-pages', images: finalImages };
  } finally {
    await safeCloseSocial(context);
  }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

app.post('/api/research/search', async (req, res) => {
  const { query, count = 6 } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query required' });

  const decode = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

  // 1) DuckDuckGo HTML (cheap, no browser)
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LovableAgent/1.0)' },
    });
    if (r.ok) {
      const html = await r.text();
      const results = [];
      const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = blockRe.exec(html)) && results.length < count) {
        let url = m[1];
        const uddg = url.match(/uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
        const title = decode(m[2].replace(/<[^>]+>/g, '').trim());
        const snippet = decode(m[3].replace(/<[^>]+>/g, '').trim());
        if (url && title) results.push({ title, url, snippet });
      }
      if (results.length) return res.json({ provider: 'duckduckgo', results });
    }
  } catch (e) { console.warn('[Research] DuckDuckGo HTML failed:', e.message); }

  // 2) Open a real persistent browser (visible) — same approach as video uploads.
  try {
    const out = await scrapeWithLocalBrowser(query, count, { headless: false });
    if (out.results.length) return res.json(out);
  } catch (e) { console.warn('[Research] Local browser scrape failed:', e.message); }

  return res.json({ provider: 'none', results: [] });
});

// Image search via local browser — DuckDuckGo Images (no captchas) → Bing Images fallback.
// Used by the cloud agent when stock providers (Unsplash/Pexels) are not configured.
app.post('/api/research/image-search', async (req, res) => {
  const { query, count = 5, urls = [] } = req.body || {};
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query required' });

  try {
    const sourcePageResults = await searchImagesFromSourcePages(urls, count);
    if (sourcePageResults.images.length) return res.json(sourcePageResults);
  } catch (e) {
    console.warn('[Image] Source-page image search failed:', e.message);
  }

  const context = await launchPersistentSocial('research', {});
  try {
    const page = await context.newPage();
    // 1) DuckDuckGo Images (uses XHR JSON under the hood, easy to parse from the page)
    try {
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
      const images = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('img.tile--img__img, .tile--img img, img[data-src*="http"]').forEach((el) => {
          if (out.length >= max) return;
          const url = el.getAttribute('data-src') || el.getAttribute('src');
          if (url && url.startsWith('http')) out.push({ url, source: 'duckduckgo' });
        });
        return out;
      }, count);
      if (images.length) return res.json({ provider: 'duckduckgo-images', images });
    } catch (e) { console.warn('[Image] DDG images failed:', e.message); }

    // 2) Bing Images
    try {
      await page.goto(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);
      const images = await page.evaluate((max) => {
        const out = [];
        document.querySelectorAll('a.iusc').forEach((el) => {
          if (out.length >= max) return;
          try {
            const m = JSON.parse(el.getAttribute('m') || '{}');
            if (m.murl) out.push({ url: m.murl, source: 'bing' });
          } catch {}
        });
        return out;
      }, count);
      if (images.length) return res.json({ provider: 'bing-images', images });
    } catch (e) { console.warn('[Image] Bing images failed:', e.message); }

    return res.json({ provider: 'none', images: [] });
  } finally {
    await safeCloseSocial(context);
  }
});

app.post('/api/process/:id', async (req, res) => {
  processJob(req.params.id).catch(e => console.error('[Worker] Job error:', e.message));
  res.json({ started: true });
});

// Serve screenshots captured by browser_research so the Job Queue UI can render
// openable preview links for each researched source page.
app.get('/api/browser-research/screenshot/:file', (req, res) => {
  try {
    const { SCREENSHOT_DIR } = require('./browserResearch');
    const file = String(req.params.file || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!file) return res.status(400).end('Bad filename');
    const full = path.join(SCREENSHOT_DIR, file);
    if (!full.startsWith(SCREENSHOT_DIR) || !fs.existsSync(full)) return res.status(404).end('Not found');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.status(500).end(String(e.message || e));
  }
});

async function triggerPendingUploadProcessing(limit = 5) {
  const { data: jobs } = await supabase
    .from('upload_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  const ids = (jobs || []).map(j => j.id).filter(id => !processingJobs.has(id));
  for (const id of ids) {
    processJob(id).catch((e) => console.error(`[Worker] Job ${id} error:`, e.message));
  }

  return ids.length;
}

app.post('/api/process-pending', async (req, res) => {
  try {
    const queued = await triggerPendingUploadProcessing(5);
    res.json({ queued });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/browser-profiles', (req, res) => {
  res.json(listBrowserProfiles());
});

app.get('/api/browser-profiles/account/:accountId', async (req, res) => {
  try {
    const accountId = String(req.params.accountId || '').trim();
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    const accounts = await getAllPlatformAccounts();
    const account = accounts.find((item) => item.id === accountId);
    const profile = getBrowserProfileForAccount(accountId) || (account ? findLinkedSiblingBrowserProfile(account, accounts) : null);
    res.json({ profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-profiles/job-selections', (req, res) => {
  try {
    const { jobId, selections } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    const saved = saveJobAccountSelections(jobId, selections || {});
    res.json({ selections: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-profiles/scheduled-selections', (req, res) => {
  try {
    const { scheduledId, selections } = req.body || {};
    if (!scheduledId) return res.status(400).json({ error: 'scheduledId is required' });
    const saved = saveScheduledAccountSelections(scheduledId, selections || {});
    res.json({ selections: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-profiles/open', async (req, res) => {
  try {
    const { accountId, label, platform, profileId } = req.body || {};
    const ALLOWED = ['youtube', 'tiktok', 'instagram', 'social-x', 'social-tiktok', 'social-facebook'];
    if (!platform || !ALLOWED.includes(platform)) {
      return res.status(400).json({ error: 'Valid platform is required' });
    }

    const isSocial = platform.startsWith('social-');
    const accountTable = isSocial ? 'social_post_accounts' : 'platform_accounts';
    const { data: rawAccounts } = await supabase.from(accountTable).select('*');
    const accounts = rawAccounts || [];
    const account = accountId ? accounts.find((item) => item.id === String(accountId)) : null;

    let profile = profileId
      ? upsertBrowserProfile({ profileId: String(profileId), label: label || account?.label || 'Browser Profile' })
      : account
        ? getBrowserProfileForAccount(account.id) || findLinkedSiblingBrowserProfile(account, accounts)
        : null;

    if (!profile) {
      profile = upsertBrowserProfile({
        label: label || account?.label || account?.email || 'Browser Profile',
      });
    }

    const linkedAccountIds = [];
    if (account) {
      const relatedAccounts = getRelatedAccounts(accounts, account);
      for (const relatedAccount of relatedAccounts) {
        linkAccountToBrowserProfile(relatedAccount.id, profile.id);
        linkedAccountIds.push(relatedAccount.id);
      }
    }

    await openBrowserProfileSession({ profileId: profile.id, platform });
    res.json({ profile, linkedAccountIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Social posts processing ---
const { processSocialPost, pollDueSocialPosts } = require('./socialPostProcessor');

app.post('/api/social-posts/process/:id', (req, res) => {
  const id = req.params.id;
  processSocialPost(supabase, id, async (msg) => {
    const settings = await getSettings().catch(() => null);
    if (settings) await notifyTelegram(settings, msg);
  }).catch((e) => console.error('[SocialPosts] Job error:', e.message));
  res.json({ started: true });
});

// --- Stats check endpoint ---
app.post('/api/check-stats', async (req, res) => {
  const { platform } = req.body || {};
  if (!platform || !['youtube', 'tiktok', 'instagram'].includes(platform)) {
    return res.status(400).json({ error: 'Provide platform: youtube, tiktok, or instagram' });
  }
  
  try {
    const settings = await getSettings();
    const creds = settings[platform];
    if (!creds?.enabled || !creds?.email) {
      return res.status(400).json({ error: `${platform} not configured` });
    }

    // Non-blocking: start stats check and send results via Telegram
    (async () => {
      try {
        const stats = await checkPlatformStats(platform, {
          ...creds,
          telegram: settings.telegram,
          backend: settings.backend,
        });
        const platformName = platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Instagram';
        const msg = formatStatsForTelegram(platformName, stats);
        await notifyTelegram(settings, msg);
      } catch (err) {
        console.error(`[Stats] ${platform} check failed:`, err.message);
        const settings2 = await getSettings().catch(() => null);
        if (settings2) await notifyTelegram(settings2, `❌ Stats check failed for ${platform}: ${err.message}`);
      }
    })();

    res.json({ started: true, platform });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Stats check all platforms ---
app.post('/api/check-all-stats', async (req, res) => {
  try {
    const settings = await getSettings();
    const platforms = ['youtube', 'tiktok', 'instagram'].filter(p => settings[p]?.enabled && settings[p]?.email);
    
    if (platforms.length === 0) {
      return res.status(400).json({ error: 'No platforms configured' });
    }

    (async () => {
      const allStats = [];
      for (const platform of platforms) {
        try {
          const stats = await checkPlatformStats(platform, {
            ...settings[platform],
            telegram: settings.telegram,
            backend: settings.backend,
          });
          const platformName = platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Instagram';
          allStats.push(formatStatsForTelegram(platformName, stats));
        } catch (err) {
          allStats.push(`❌ ${platform}: ${err.message}`);
        }
      }
      await notifyTelegram(settings, allStats.join('\n\n'));
    })();

    res.json({ started: true, platforms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI Chat endpoint (uses LM Studio locally instead of cloud AI) ---
app.post('/api/ai-chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    await refreshLMStudioConfigFromSettings(supabase);

    // Stream response from LM Studio
    const streamResp = await streamLMStudio(messages, supabase);
    if (!streamResp.ok) {
      const errText = await streamResp.text().catch(() => '');
      console.error('[AI-Chat] LM Studio error:', streamResp.status, errText);
      return res.status(500).json({ error: 'AI service error. Make sure LM Studio is running.' });
    }

    // Pipe the SSE stream through to the client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { Readable } = require('stream');
    if (streamResp.body && typeof streamResp.body.pipe === 'function') {
      streamResp.body.pipe(res);
    } else if (streamResp.body) {
      // node-fetch v2 returns a Node.js Readable
      streamResp.body.pipe(res);
    } else {
      const text = await streamResp.text();
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    console.error('[AI-Chat] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// --- Scheduled uploads ---
async function processScheduledUploads() {
  const now = new Date().toISOString();
  const settings = await getSettings();
  const { data: dueUploads } = await supabase
    .from('scheduled_uploads')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true });

  if (!dueUploads || dueUploads.length === 0) return;
  console.log(`[Scheduler] ${dueUploads.length} scheduled upload(s) due`);

  for (const item of dueUploads) {
    try {
      await supabase.from('scheduled_uploads').update({ status: 'processing' }).eq('id', item.id);

      let videoFileName = item.video_file_name;
      let videoStoragePath = item.video_storage_path;
      let itemTitle = item.title;
      let itemDescription = item.description;
      let itemTags = item.tags;
      let folderPathForJob = null;

      // Handle folder-based entries
      if (/^\[folder(?:\|\d+)?\]\s/i.test(videoFileName)) {
        const folderPath = normalizeFolderPath(videoFileName);
        const intensityMin = parseFolderIntensity(videoFileName);

        // If an intensity is set, fan out: scan ALL videos and schedule them spaced by intensity.
        if (intensityMin) {
          const allPairs = scanAllFiles(folderPath);
          if (allPairs.length === 0) {
            console.error(`[Scheduler] No videos found in folder: ${folderPath}`);
            await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
            await notifyTelegram(settings, `❌ Scheduled folder upload: no videos found in ${folderPath}`);
            continue;
          }

          const baseTime = new Date(item.scheduled_at).getTime();
          const fanoutRows = allPairs.map((pair, idx) => {
            let entryTitle = item.title;
            let entryDesc = item.description;
            let entryTags = item.tags;
            if (pair.textFile) {
              const meta = parseTextFile(path.join(folderPath, pair.textFile));
              if (!entryTitle || entryTitle === '(auto from folder)') entryTitle = meta.title || pair.videoFile;
              if (!entryDesc) entryDesc = meta.description || '';
              if (!entryTags?.length) entryTags = meta.tags || [];
            }
            return {
              video_file_name: pair.videoFile,
              video_storage_path: null,
              title: entryTitle || pair.videoFile,
              description: entryDesc || '',
              tags: entryTags || [],
              target_platforms: item.target_platforms,
              account_id: item.account_id,
              scheduled_at: new Date(baseTime + idx * intensityMin * 60_000).toISOString(),
              status: 'scheduled',
            };
          });

          const { data: inserted, error: fanErr } = await supabase
            .from('scheduled_uploads')
            .insert(fanoutRows)
            .select();
          if (fanErr) {
            console.error('[Scheduler] Fan-out insert failed:', fanErr.message);
            await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
            continue;
          }

          // Copy account selections from the parent to each fan-out child
          const parentSelections = getScheduledAccountSelections(item.id);
          for (const child of inserted || []) {
            try { saveScheduledAccountSelections(child.id, parentSelections); } catch {}
          }

          await supabase.from('scheduled_uploads').update({ status: 'completed' }).eq('id', item.id);
          await notifyTelegram(settings, `📅 Scheduled ${inserted?.length || 0} videos from ${folderPath}, every ${intensityMin}m starting ${new Date(baseTime).toLocaleString()}`);
          continue;
        }

        // No intensity → legacy behavior: pick the latest single video.
        const { videoFile, textFile } = scanFolder(folderPath);
        if (!videoFile) {
          console.error(`[Scheduler] No video found in folder: ${folderPath}`);
          await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
          await notifyTelegram(settings, `❌ Scheduled upload failed: no video found in folder ${folderPath}`);
          continue;
        }
        videoFileName = videoFile;
        folderPathForJob = folderPath;
        videoStoragePath = null;
        if (textFile) {
          const meta = parseTextFile(path.join(folderPath, textFile));
          if (!itemTitle || itemTitle === '(auto from folder)') itemTitle = meta.title || videoFile;
          if (!itemDescription) itemDescription = meta.description || '';
          if (!itemTags?.length) itemTags = meta.tags || [];
        }
      }

      const requestedPlatforms = Array.isArray(item.target_platforms) ? item.target_platforms : [];
      const scheduledSelections = getScheduledAccountSelections(item.id);
      const readyPlatforms = await getReadyPlatformsForSelections(settings, requestedPlatforms, scheduledSelections);
      const primaryAccountId = readyPlatforms.map((platform) => scheduledSelections[platform]).find(Boolean) || item.account_id || null;

      if (readyPlatforms.length === 0) {
        console.log('[Scheduler] No enabled platforms with credentials for scheduled upload');
        await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
        await notifyTelegram(settings, `⚠️ Scheduled upload skipped: no enabled platforms with credentials for ${itemTitle || item.video_file_name}`);
        continue;
      }

      const platformResults = readyPlatforms.map(name => ({ name, status: 'pending' }));
      const { data: job, error } = await supabase
        .from('upload_jobs')
        .insert({
          video_file_name: videoFileName,
          video_storage_path: videoStoragePath,
          title: itemTitle || videoFileName,
          description: itemDescription || '',
          tags: itemTags || [],
          target_platforms: readyPlatforms,
          account_id: primaryAccountId,
          status: 'pending',
          platform_results: platformResults,
        })
        .select()
        .single();

      if (error || !job) {
        console.error('[Scheduler] Failed to create job:', error);
        await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
        continue;
      }

      await supabase.from('scheduled_uploads').update({ upload_job_id: job.id }).eq('id', item.id);
      copyScheduledSelectionsToJob(item.id, job.id);
      await processJob(job.id, { folderPath: folderPathForJob });

      const { data: processedJob } = await supabase
        .from('upload_jobs')
        .select('status')
        .eq('id', job.id)
        .single();

      const scheduledStatus = processedJob?.status === 'completed' ? 'completed' : 'error';
      await supabase.from('scheduled_uploads').update({ status: scheduledStatus }).eq('id', item.id);
    } catch (err) {
      console.error('[Scheduler] Error:', err.message);
      await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
    }
  }
}

// --- Recurring schedule: process ALL schedule configs ---

function generateMetadataFromFilename(filename) {
  // Strip extension
  let name = filename.replace(/\.[^.]+$/, '');
  // Remove common prefixes like dates, numbers
  name = name.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_]?/, '');
  name = name.replace(/^\d+[-_\s]?/, '');
  // Replace separators with spaces
  const title = name.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Generate tags from words
  const words = title.toLowerCase().split(' ').filter(w => w.length > 2);
  const tags = [...new Set(words)].slice(0, 10).map(w => `#${w}`);
  // Generate description
  const description = `${title}\n\n${tags.join(' ')}\n\n#video #content`;
  return { title: title || filename, description, tags };
}

async function processRecurringSchedule() {
  try {
    const { data: configs } = await supabase.from('schedule_config').select('*').eq('enabled', true);
    if (!configs || configs.length === 0) return;
    const settings = await getSettings();
    const now = new Date();
    const currentMinute = now.getMinutes();
    const currentHour = now.getHours();
    const currentDow = now.getDay();

    for (const config of configs) {
      try {
        // Check end_at expiry
        if (config.end_at && new Date(config.end_at) < now) {
          console.log(`[Recurring] Schedule ${config.id} expired, disabling`);
          await supabase.from('schedule_config').update({ enabled: false }).eq('id', config.id);
          continue;
        }

        const folderPath = normalizeFolderPath(config.folder_path);
        if (!folderPath) continue;

        // Parse cron to check if NOW matches
        const [cronMin, cronHr, , , cronDow] = config.cron_expression.split(' ');
        const minuteMatch = cronMin === '*' || parseInt(cronMin) === currentMinute;
        const hourMatch = cronHr === '*'
          || (cronHr.startsWith('*/') ? currentHour % parseInt(cronHr.replace('*/', '')) === 0 : parseInt(cronHr) === currentHour);
        const dowMatch = cronDow === '*' || cronDow.split(',').map(Number).includes(currentDow);

        if (!minuteMatch || !hourMatch || !dowMatch) continue;

        // Prevent running multiple times in the same minute window — persisted in DB
        const nowMinuteStart = new Date(now);
        nowMinuteStart.setSeconds(0, 0);
        if (config.last_run_at) {
          const lastRun = new Date(config.last_run_at);
          // If last run was within the last 60 seconds, skip (already ran this minute)
          if (nowMinuteStart.getTime() - lastRun.getTime() < 60_000) continue;
        }

        // Persist last_run_at immediately to prevent duplicate runs on restart
        await supabase.from('schedule_config').update({ last_run_at: now.toISOString() }).eq('id', config.id);

        console.log(`[Recurring] Schedule ${config.id} (${config.name}) matched at ${now.toISOString()}, scanning: ${folderPath}`);

        // Scan ALL files in folder, matched by name
        const allPairs = scanAllFiles(folderPath);
        if (allPairs.length === 0) {
          console.log(`[Recurring] No videos found in ${folderPath}`);
          await notifyTelegram(settings, `⚠️ Schedule "${config.name}": no videos found in ${folderPath}`);
          continue;
        }

        const requestedPlatforms = Array.isArray(config.platforms) && config.platforms.length
          ? config.platforms
          : ['youtube', 'tiktok', 'instagram'];
        const platforms = getReadyPlatforms(settings, requestedPlatforms);

        if (platforms.length === 0) {
          console.log(`[Recurring] Schedule "${config.name}": no enabled platforms with credentials`);
          await notifyTelegram(settings, `⚠️ Schedule "${config.name}" skipped: no enabled platforms with credentials`);
          continue;
        }

        const intervalMinutes = config.upload_interval_minutes || 60;
        console.log(`[Recurring] Found ${allPairs.length} videos, uploading with ${intervalMinutes}min interval`);

        // Process first video immediately, schedule rest with intensity spacing
        for (let i = 0; i < allPairs.length; i++) {
          const pair = allPairs[i];
          let title, description, tags;

          if (pair.textFile) {
            const meta = parseTextFile(path.join(folderPath, pair.textFile));
            title = meta.title || pair.videoFile;
            description = meta.description || '';
            tags = meta.tags?.length ? meta.tags : [];
          }

          // Auto-generate metadata from filename if no .txt or empty metadata
          if (!title || !description || !tags?.length) {
            const generated = generateMetadataFromFilename(pair.videoFile);
            if (!title) title = generated.title;
            if (!description) description = generated.description;
            if (!tags?.length) tags = generated.tags;
          }

          const platformResults = platforms.map(name => ({ name, status: 'pending' }));

          if (i === 0) {
            // First video: create job and process immediately
            const { data: job, error } = await supabase
              .from('upload_jobs')
              .insert({
                video_file_name: pair.videoFile,
                video_storage_path: null,
                title, description, tags,
                target_platforms: platforms,
                status: 'pending',
                platform_results: platformResults,
              })
              .select()
              .single();

            if (error || !job) {
              console.error(`[Recurring] Failed to create job for ${pair.videoFile}:`, error);
              continue;
            }

            console.log(`[Recurring] Created immediate job ${job.id} for ${pair.videoFile}`);
            await processJob(job.id, { folderPath });
          } else {
            // Subsequent videos: create scheduled uploads with spacing
            const scheduledAt = new Date(now.getTime() + i * intervalMinutes * 60_000).toISOString();
            const { error } = await supabase
              .from('scheduled_uploads')
              .insert({
                video_file_name: pair.videoFile,
                video_storage_path: null,
                title, description, tags,
                target_platforms: platforms,
                scheduled_at: scheduledAt,
                status: 'scheduled',
              });

            if (error) {
              console.error(`[Recurring] Failed to schedule ${pair.videoFile}:`, error);
            } else {
              console.log(`[Recurring] Scheduled ${pair.videoFile} for ${scheduledAt}`);
            }
          }
        }

        await notifyTelegram(settings, `📋 Schedule "${config.name}": ${allPairs.length} video(s) queued (1 now, ${allPairs.length - 1} scheduled every ${intervalMinutes}min)`);
      } catch (e) {
        console.error(`[Recurring] Error processing schedule ${config.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Recurring] Error:', e.message);
  }
}

// --- Stale job cleanup ---
async function fixStaleJobs() {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: staleJobs } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('status', 'uploading')
    .lt('created_at', staleThreshold);

  if (!staleJobs?.length) return;
  for (const stale of staleJobs) {
    if (processingJobs.has(stale.id)) continue;
    const pr = stale.platform_results || [];
    let changed = false;
    for (const p of pr) {
      if (p.status === 'uploading') { p.status = 'error'; p.error = 'Timed out'; changed = true; }
    }
    if (changed) {
      const finalStatus = pr.every(p => p.status === 'success') ? 'completed' : pr.some(p => p.status === 'success') ? 'partial' : 'failed';
      await supabase.from('upload_jobs').update({
        platform_results: pr, status: finalStatus, completed_at: new Date().toISOString(),
      }).eq('id', stale.id);
    }
  }
}

// --- Pending commands (from Telegram bot via Supabase) ---
const runningCommands = new Set();

async function processPendingCommands() {
  try {
    const { data: commands } = await supabase
      .from('pending_commands')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5);

    for (const cmd of (commands || [])) {
      if (runningCommands.has(cmd.id)) continue;
      runningCommands.add(cmd.id);

      // Mark as processing immediately
      await supabase.from('pending_commands').update({ status: 'processing' }).eq('id', cmd.id);

      // Execute asynchronously so cron is not blocked
      (async () => {
        try {
          if (cmd.command === 'check_stats') {
            const platform = cmd.args?.platform || 'all';
            const settings = await getSettings();
            const platforms = platform === 'all'
              ? ['youtube', 'tiktok', 'instagram'].filter(p => settings[p]?.enabled && settings[p]?.email)
              : [platform];

            if (platforms.length === 0) {
              await notifyTelegram(settings, `⚠️ No configured platforms found for stats check.`);
              await supabase.from('pending_commands').update({
                status: 'failed', result: 'No configured platforms', completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              return;
            }

            const allStats = [];
            for (const p of platforms) {
              try {
                const stats = await checkPlatformStats(p, {
                  ...settings[p],
                  telegram: settings.telegram,
                  backend: settings.backend,
                });
                const pName = p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : 'Instagram';
                if (!stats || stats.length === 0) {
                  allStats.push(`📊 ${pName}: No videos found. The browser opened and checked your ${pName} account but found no recent videos/stats yet. Try again after uploading some content.`);
                } else {
                  allStats.push(formatStatsForTelegram(pName, stats));
                }
              } catch (err) {
                const pName = p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : 'Instagram';
                allStats.push(`❌ ${pName} stats check failed: ${err.message}\n\nMake sure you have logged into ${pName} at least once by uploading a video first (this saves the browser session). Then try again.`);
              }
            }

            await notifyTelegram(settings, allStats.join('\n\n'));
            await supabase.from('pending_commands').update({
              status: 'completed', result: 'sent', completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
          } else if (cmd.command === 'ai_response') {
            // Process Telegram AI response locally via LM Studio
            const settings = await getSettings();
            console.log(`[Commands] ai_response: processing Telegram message from chat ${cmd.args?.chat_id}`);
            await processTelegramAIResponse(supabase, cmd.args, sendTelegram, settings.backend);
            await supabase.from('pending_commands').update({
              status: 'completed', result: 'ai_reply_sent', completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
          } else if (cmd.command === 'open_browser') {
            const task = cmd.args?.task || 'Open the browser and navigate to Google';
            const startUrl = cmd.args?.url || null;
            const silent = cmd.args?.silent === true;
            const settings = await getSettings();

            console.log(`[Commands] open_browser: task="${task}"${startUrl ? `, url="${startUrl}"` : ''}`);
            const browserResult = await runBrowserTask(task, startUrl);
            const { summary } = browserResult;
            if (!silent) await notifyTelegram(settings, summary);
            await supabase.from('pending_commands').update({
              status: 'completed', result: JSON.stringify(browserResult), completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
          } else if (cmd.command === 'image_search') {
            const query = cmd.args?.query || '';
            const count = Number(cmd.args?.count) || 5;
            const urls = Array.isArray(cmd.args?.urls) ? cmd.args.urls.filter(Boolean) : [];
            console.log(`[Commands] image_search: "${query}" (count=${count}, urls=${urls.length})`);
            try {
              const r = await fetch(`http://localhost:${PORT}/api/research/image-search`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, count, urls }),
              });
              const data = await r.json().catch(() => ({}));
              await supabase.from('pending_commands').update({
                status: 'completed',
                result: JSON.stringify({ provider: data.provider || 'none', images: data.images || [] }),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              console.log(`[Commands] image_search done: ${(data.images || []).length} images via ${data.provider || 'none'}`);
            } catch (err) {
              await supabase.from('pending_commands').update({
                status: 'failed', result: err.message, completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
            }
          } else if (cmd.command === 'research_search') {
            // Cloud agent asked us to scrape DuckDuckGo/Google with the local browser.
            const query = cmd.args?.query || '';
            const count = Number(cmd.args?.count) || 6;
            console.log(`[Commands] research_search: "${query}" (count=${count})`);
            try {
              // Reuse the same logic as the /api/research/search endpoint by calling it via HTTP loopback.
              const r = await fetch(`http://localhost:${PORT}/api/research/search`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, count }),
              });
              const data = await r.json().catch(() => ({}));
              await supabase.from('pending_commands').update({
                status: 'completed',
                result: JSON.stringify({ provider: data.provider || 'none', results: data.results || [] }),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              console.log(`[Commands] research_search done: ${(data.results || []).length} results via ${data.provider || 'none'}`);
            } catch (err) {
              await supabase.from('pending_commands').update({
                status: 'failed', result: err.message, completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
            }
          } else if (cmd.command === 'browser_research') {
            // Deterministic local browser research: fetch sources, open the local browser,
            // capture screenshots + page text, optionally send screenshots to Telegram,
            // and persist a structured result for the Job Queue UI to render as openable links.
            try {
              const { runBrowserResearch } = require('./browserResearch');
              const settings = await getSettings();
              const { sendTelegramPhoto } = require('./telegram');
              const result = await runBrowserResearch(cmd.args || {}, {
                settings,
                sendTelegram: notifyTelegram,
                sendTelegramPhoto,
              });
              const screenshotLinks = (result.screenshots || []).map((s) => ({
                kind: 'screenshot',
                label: `📸 ${s.label || 'Screenshot'}`,
                url: `${settings.local_agent_url || 'http://localhost:3001'}/api/browser-research/screenshot/${encodeURIComponent(s.file)}`,
              }));
              const persisted = {
                provider: 'local-browser',
                summary: result.summary,
                query: result.query,
                sources: result.sources,
                captures: result.captures,
                links: [...(result.links || []), ...screenshotLinks],
              };
              await supabase.from('pending_commands').update({
                status: result.ok ? 'completed' : 'failed',
                result: JSON.stringify(persisted),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              const tgSummary = `🔎 Research done: "${result.query}"\n${result.summary}\n\n` +
                (result.sources || []).slice(0, 5).map((s, i) => `${i + 1}. ${s.title}\n${s.url}`).join('\n');
              await notifyTelegram(settings, tgSummary);
              console.log(`[Commands] browser_research done: ${(result.sources || []).length} sources, ${(result.screenshots || []).length} screenshots`);
            } catch (err) {
              await supabase.from('pending_commands').update({
                status: 'failed', result: JSON.stringify({ ok: false, error: err.message }),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
            }
          } else if (cmd.command && cmd.command.startsWith('agent_')) {
            // Agent workspace tools (write_file, read_file, list_files, run_shell, open_in_browser, serve_preview)
            try {
              const { handleAgentCommand } = require('./agentWorkspace');
              const result = await handleAgentCommand(cmd.command, cmd.args || {});
              await supabase.from('pending_commands').update({
                status: result && result.ok === false ? 'failed' : 'completed',
                result: JSON.stringify(result),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
              console.log(`[Commands] ${cmd.command} → ${result && result.ok === false ? 'failed' : 'ok'}`);
            } catch (err) {
              await supabase.from('pending_commands').update({
                status: 'failed', result: JSON.stringify({ ok: false, error: err.message }),
                completed_at: new Date().toISOString(),
              }).eq('id', cmd.id);
            }
          } else {
            await supabase.from('pending_commands').update({
              status: 'failed', result: `Unknown command: ${cmd.command}`, completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
          }
        } catch (err) {
          console.error(`[Commands] Command ${cmd.id} failed:`, err.message);
          const settingsForError = await getSettings().catch(() => null);
          if (settingsForError) {
            const isStats = cmd.command === 'check_stats';
            const errMsg = isStats
              ? `❌ Stats check failed: ${err.message}\n\nThis usually means:\n1. The browser could not open (Playwright not installed?)\n2. The platform session needs login — upload a video first to save the session\n3. The platform website changed its layout\n\nTip: Make sure smart-launcher.bat is running and you have uploaded at least one video to the platform.`
              : `❌ Browser task failed: ${err.message}\n\nTip: Make sure smart-launcher.bat is running and Playwright is installed (run install-browsers.bat).`;
            await notifyTelegram(settingsForError, errMsg);
          }
          await supabase.from('pending_commands').update({
            status: 'failed', result: err.message, completed_at: new Date().toISOString(),
          }).eq('id', cmd.id).catch(() => {});
        } finally {
          runningCommands.delete(cmd.id);
        }
      })();
    }
  } catch (e) {
    console.error('[Commands] Poll error:', e.message);
  }
}

// --- Cron: poll every minute for uploads, every 15s for commands ---
let cronJob = null;
let commandPollInterval = null;
let uploadPollInterval = null;
let socialPollInterval = null;
function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  if (commandPollInterval) { clearInterval(commandPollInterval); commandPollInterval = null; }
  if (uploadPollInterval) { clearInterval(uploadPollInterval); uploadPollInterval = null; }
  if (socialPollInterval) { clearInterval(socialPollInterval); socialPollInterval = null; }

  // Fast poll: check pending uploads every 5 seconds for near-immediate browser start.
  uploadPollInterval = setInterval(async () => {
    try { await triggerPendingUploadProcessing(5); } catch (e) { console.error('[Uploads] Poll error:', e.message); }
  }, 5000);

  // Fast poll: check pending_commands every 3 seconds for responsive bot + research
  commandPollInterval = setInterval(async () => {
    try { await processPendingCommands(); } catch (e) { console.error('[Commands] Poll error:', e.message); }
  }, 3000);

  // Kick once immediately on startup/reload so new jobs don't wait for first interval tick.
  triggerPendingUploadProcessing(5).catch((e) => console.error('[Uploads] Initial trigger failed:', e.message));

  // Fast poll: due social posts every 10s
  socialPollInterval = setInterval(async () => {
    try {
      await pollDueSocialPosts(supabase, async (msg) => {
        const settings = await getSettings().catch(() => null);
        if (settings) await notifyTelegram(settings, msg);
      });
    } catch (e) { console.error('[SocialPosts] Poll error:', e.message); }
  }, 10000);

  cronJob = cron.schedule('* * * * *', async () => {
    try {
      await fixStaleJobs();
      await processScheduledUploads();
      await processRecurringSchedule();
    } catch (e) {
      console.error('[Cron] Error:', e.message);
    }
  });
  console.log('[Cron] Active: uploads every 5s, social posts every 10s, schedules every minute, commands every 15s');
}

app.post('/api/refresh-cron', (req, res) => {
  setupCron();
  res.json({ ok: true });
});

// --- Start ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Auto Vid Post — Local Server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Connected to backend: ${SUPABASE_URL}`);
  console.log(`   AI: LM Studio at ${LM_STUDIO_URL}`);
  console.log(`   Mode: Local Playwright automation + Local AI\n`);
  setupCron();
});
