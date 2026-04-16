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
const { processTelegramAIResponse, streamLMStudio, LM_STUDIO_URL } = require('./ai-handler');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

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

async function notifyTelegram(settings, message) {
  if (!settings.telegram?.enabled || !settings.telegram?.chatId) return;
  try {
    await sendTelegram(settings.telegram.botToken, settings.telegram.chatId, message, settings.backend);
  } catch (e) {
    console.error('[Telegram] Notification failed:', e.message);
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
    .replace(/^\[folder\]\s*/i, '')
    .replace(/^"(.+)"$/, '$1')
    .replace(/^'(.+)'$/, '$1')
    .trim();
}

function getReadyPlatforms(settings, requestedPlatforms = []) {
  return (Array.isArray(requestedPlatforms) ? requestedPlatforms : []).filter((platform) => {
    const config = settings?.[platform];
    return Boolean(config?.enabled && config?.email && config?.password);
  });
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

    // === RESOLVE ACCOUNT CREDENTIALS ===
    // If job has account_id, look up platform_accounts for credentials
    let accountCredentials = null;
    if (job.account_id) {
      const { data: account } = await supabase
        .from('platform_accounts')
        .select('*')
        .eq('id', job.account_id)
        .single();
      if (account) {
        accountCredentials = account;
        console.log(`[Worker] Using account "${account.label}" (${account.platform}) for job ${jobId}`);
      }
    }

    const folderPathOverride = normalizeFolderPath(options.folderPath);
    const results = job.platform_results || [];

    // === CREDENTIAL VALIDATION: Skip platforms without credentials ===
    // If accountCredentials exists, use those for the matching platform
    for (const platform of results) {
      if (platform.status !== 'pending') continue;
      
      // Resolve credentials: account_id override > app_settings fallback
      let ps;
      if (accountCredentials && accountCredentials.platform === platform.name) {
        ps = { email: accountCredentials.email, password: accountCredentials.password, enabled: accountCredentials.enabled };
      } else {
        ps = settings[platform.name];
      }
      
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
    } else if (typeof job.video_file_name === 'string' && job.video_file_name.startsWith('[folder] ')) {
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
        // Use account credentials if available for this platform, otherwise app_settings
        const platformCreds = (accountCredentials && accountCredentials.platform === platform.name)
          ? { email: accountCredentials.email, password: accountCredentials.password, enabled: true }
          : settings[platform.name];
        const result = await uploaders[platform.name](videoPath, metadata, {
          ...platformCreds,
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

app.post('/api/process/:id', async (req, res) => {
  processJob(req.params.id).catch(e => console.error('[Worker] Job error:', e.message));
  res.json({ started: true });
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
      if (videoFileName.startsWith('[folder] ')) {
        const folderPath = normalizeFolderPath(videoFileName);
        const { videoFile, textFile } = scanFolder(folderPath);
        if (!videoFile) {
          console.error(`[Scheduler] No video found in folder: ${folderPath}`);
          await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
          await notifyTelegram(settings, `❌ Scheduled upload failed: no video found in folder ${folderPath}`);
          continue;
        }
        videoFileName = videoFile;
        folderPathForJob = folderPath;
        videoStoragePath = null; // Will be read from folder directly

        // Parse text file metadata if found
        if (textFile) {
          const meta = parseTextFile(path.join(folderPath, textFile));
          if (!itemTitle || itemTitle === '(auto from folder)') itemTitle = meta.title || videoFile;
          if (!itemDescription) itemDescription = meta.description || '';
          if (!itemTags?.length) itemTags = meta.tags || [];
        }
      }

      const requestedPlatforms = Array.isArray(item.target_platforms) ? item.target_platforms : [];
      const readyPlatforms = getReadyPlatforms(settings, requestedPlatforms);

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
            const settings = await getSettings();

            console.log(`[Commands] open_browser: task="${task}"${startUrl ? `, url="${startUrl}"` : ''}`);
            const { summary } = await runBrowserTask(task, startUrl);
            await notifyTelegram(settings, summary);
            await supabase.from('pending_commands').update({
              status: 'completed', result: 'done', completed_at: new Date().toISOString(),
            }).eq('id', cmd.id);
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
function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  if (commandPollInterval) { clearInterval(commandPollInterval); commandPollInterval = null; }
  if (uploadPollInterval) { clearInterval(uploadPollInterval); uploadPollInterval = null; }

  // Fast poll: check pending uploads every 5 seconds for near-immediate browser start.
  uploadPollInterval = setInterval(async () => {
    try { await triggerPendingUploadProcessing(5); } catch (e) { console.error('[Uploads] Poll error:', e.message); }
  }, 5000);

  // Fast poll: check pending_commands every 15 seconds for responsive bot
  commandPollInterval = setInterval(async () => {
    try { await processPendingCommands(); } catch (e) { console.error('[Commands] Poll error:', e.message); }
  }, 15000);

  // Kick once immediately on startup/reload so new jobs don't wait for first interval tick.
  triggerPendingUploadProcessing(5).catch((e) => console.error('[Uploads] Initial trigger failed:', e.message));

  cronJob = cron.schedule('* * * * *', async () => {
    try {
      await fixStaleJobs();
      await processScheduledUploads();
      await processRecurringSchedule();
    } catch (e) {
      console.error('[Cron] Error:', e.message);
    }
  });
  console.log('[Cron] Active: uploads every 5s, schedules every minute, commands every 15s');
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
