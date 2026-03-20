// Local server that reads settings/jobs from Supabase and performs actual Playwright uploads.
// This only runs on your local machine — it's the bridge between the web UI and browser automation.

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { uploadToYouTube } = require('./uploaders/youtube');
const { uploadToTikTok } = require('./uploaders/tiktok');
const { uploadToInstagram } = require('./uploaders/instagram');
const { sendTelegram } = require('./telegram');
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

// --- Helpers ---
async function getSettings() {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  if (!data) throw new Error('No settings found');
  return {
    folderPath: data.folder_path,
    youtube: { email: data.youtube_email, password: data.youtube_password, enabled: data.youtube_enabled },
    tiktok: { email: data.tiktok_email, password: data.tiktok_password, enabled: data.tiktok_enabled },
    instagram: { email: data.instagram_email, password: data.instagram_password, enabled: data.instagram_enabled },
    telegram: { botToken: data.telegram_bot_token, chatId: data.telegram_chat_id, enabled: data.telegram_enabled },
  };
}

async function notifyTelegram(settings, message) {
  if (!settings.telegram?.enabled) return;
  try {
    await sendTelegram(settings.telegram.botToken, settings.telegram.chatId, message);
  } catch (e) {
    console.error('[Telegram] Notification failed:', e.message);
  }
}

const uploaders = { youtube: uploadToYouTube, tiktok: uploadToTikTok, instagram: uploadToInstagram };

async function processJob(jobId) {
  const { data: job } = await supabase.from('upload_jobs').select('*').eq('id', jobId).single();
  if (!job) return;

  const settings = await getSettings();
  const results = job.platform_results || [];

  // === CREDENTIAL VALIDATION: Skip platforms without credentials ===
  for (let i = 0; i < results.length; i++) {
    const platform = results[i];
    if (platform.status !== 'pending') continue;
    
    const platformSettings = settings[platform.name];
    if (!platformSettings?.enabled) {
      platform.status = 'error';
      platform.error = `${platform.name} is not enabled in Settings`;
      continue;
    }
    if (!platformSettings?.email || !platformSettings?.password) {
      platform.status = 'error';
      platform.error = `${platform.name} credentials not configured. Add email & password in Settings.`;
      continue;
    }
  }

  // Check if any platforms are still actionable
  const actionable = results.filter(r => r.status === 'pending');
  if (actionable.length === 0) {
    const errorMessages = results.filter(r => r.status === 'error').map(r => `${r.name}: ${r.error}`);
    await supabase.from('upload_jobs').update({
      status: 'failed',
      platform_results: results,
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    
    await notifyTelegram(settings,
      `❌ Upload job failed\nTitle: ${job.title || job.video_file_name}\n\n${errorMessages.join('\n')}`
    );
    return;
  }

  // Determine video path
  let videoPath;
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
  } else if (settings.folderPath) {
    videoPath = path.join(settings.folderPath, job.video_file_name);
  }

  if (!videoPath || !fs.existsSync(videoPath)) {
    console.error('Video file not found:', videoPath);
    await supabase.from('upload_jobs').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', jobId);
    await notifyTelegram(settings, `❌ Video file not found: ${job.video_file_name}`);
    return;
  }

  const metadata = { title: job.title, description: job.description, tags: job.tags };
  await supabase.from('upload_jobs').update({ status: 'processing', platform_results: results }).eq('id', jobId);

  for (let i = 0; i < results.length; i++) {
    const platform = results[i];
    if (platform.status !== 'pending') continue;
    if (!uploaders[platform.name]) continue;

    platform.status = 'uploading';
    await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);

    try {
      const result = await uploaders[platform.name](videoPath, metadata, {
        ...settings[platform.name],
        telegram: settings.telegram,
      });
      platform.status = 'success';
      platform.url = result.url || '';
    } catch (err) {
      platform.status = 'error';
      platform.error = err.message;
    }

    await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);
  }

  // Final status
  const successCount = results.filter(r => r.status === 'success').length;
  const errorCount = results.filter(r => r.status === 'error').length;
  const finalStatus = errorCount > 0 && successCount === 0 ? 'failed' : errorCount > 0 ? 'partial' : 'completed';

  await supabase.from('upload_jobs').update({
    status: finalStatus,
    platform_results: results,
    completed_at: new Date().toISOString(),
  }).eq('id', jobId);

  // === SEND FINAL TELEGRAM SUMMARY ===
  const lines = results.map(r => {
    if (r.status === 'success') return `✅ ${r.name}: Success${r.url ? ' — ' + r.url : ''}`;
    if (r.status === 'error') return `❌ ${r.name}: ${r.error}`;
    return `⚪ ${r.name}: ${r.status}`;
  });

  const emoji = finalStatus === 'completed' ? '🎉' : finalStatus === 'partial' ? '⚠️' : '❌';
  await notifyTelegram(settings,
    `${emoji} Upload ${finalStatus}\nTitle: ${metadata.title || job.video_file_name}\n\n${lines.join('\n')}`
  );
}

// --- API Endpoints ---

// Root route — shows server status
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    mode: 'local',
    name: 'Auto Vid Post — Local Server',
    endpoints: {
      health: 'GET /api/health',
      processJob: 'POST /api/process/:id',
      processPending: 'POST /api/process-pending',
      refreshCron: 'POST /api/refresh-cron',
    },
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', mode: 'local' }));

app.post('/api/process/:id', async (req, res) => {
  try {
    processJob(req.params.id).catch(console.error);
    res.json({ started: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/process-pending', async (req, res) => {
  try {
    const { data: jobs } = await supabase
      .from('upload_jobs')
      .select('id')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    const ids = (jobs || []).map(j => j.id);
    for (const id of ids) {
      await processJob(id);
    }
    res.json({ processed: ids.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- Cron: poll for pending jobs AND scheduled uploads ---
let cronJob = null;

async function processScheduledUploads() {
  const now = new Date().toISOString();
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
      const platformResults = item.target_platforms.map(name => ({ name, status: 'pending' }));
      const { data: job, error } = await supabase
        .from('upload_jobs')
        .insert({
          video_file_name: item.video_file_name,
          video_storage_path: item.video_storage_path,
          title: item.title,
          description: item.description,
          tags: item.tags,
          target_platforms: item.target_platforms,
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
      await processJob(job.id);
      await supabase.from('scheduled_uploads').update({ status: 'completed' }).eq('id', item.id);
    } catch (err) {
      console.error('[Scheduler] Error:', err.message);
      await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
    }
  }
}

async function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  cronJob = cron.schedule('* * * * *', async () => {
    console.log(`[Cron] Tick at ${new Date().toISOString()}`);
    await processScheduledUploads();
    const { data: jobs } = await supabase
      .from('upload_jobs')
      .select('id')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    for (const job of (jobs || [])) {
      await processJob(job.id);
    }
  });
  console.log('[Cron] Active: checking every minute for pending jobs and scheduled uploads');
}

app.post('/api/refresh-cron', async (req, res) => {
  await setupCron();
  res.json({ ok: true });
});

// --- Start ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n🚀 Auto Vid Post — Local Server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Connected to backend: ${SUPABASE_URL}`);
  console.log(`   Mode: Local Playwright automation\n`);
  await setupCron();
});
