// Local server that reads settings/jobs from Supabase and performs actual Playwright uploads.
// This only runs on your local machine — it's the bridge between the web UI and browser automation.

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { scanFolder } = require('./folderWatcher');
const { parseTextFile } = require('./textParser');
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
// These are the same keys used by the frontend (publishable/anon key)
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

const uploaders = { youtube: uploadToYouTube, tiktok: uploadToTikTok, instagram: uploadToInstagram };

async function processJob(jobId) {
  const { data: job } = await supabase.from('upload_jobs').select('*').eq('id', jobId).single();
  if (!job) return;

  const settings = await getSettings();
  const results = job.platform_results || [];

  // Determine video path — either from storage download or local folder
  let videoPath;
  if (job.video_storage_path) {
    // Download from Supabase storage to temp
    const { data: fileData, error } = await supabase.storage
      .from('videos')
      .download(job.video_storage_path);

    if (error || !fileData) {
      console.error('Failed to download video from storage:', error);
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
    return;
  }

  const metadata = { title: job.title, description: job.description, tags: job.tags };

  await supabase.from('upload_jobs').update({ status: 'processing', platform_results: results }).eq('id', jobId);

  for (let i = 0; i < results.length; i++) {
    const platform = results[i];
    if (platform.status !== 'pending') continue;
    if (!uploaders[platform.name]) continue;
    if (!settings[platform.name]?.enabled) {
      platform.status = 'error';
      platform.error = `${platform.name} is not enabled in settings`;
      await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);
      continue;
    }

    platform.status = 'uploading';
    await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);

    try {
      const result = await uploaders[platform.name](videoPath, metadata, settings[platform.name]);
      platform.status = 'success';
      platform.url = result.url || '';

      if (settings.telegram.enabled) {
        await sendTelegram(
          settings.telegram.botToken,
          settings.telegram.chatId,
          `✅ Upload successful!\nPlatform: ${platform.name}\nTitle: ${metadata.title || job.video_file_name}\nURL: ${platform.url || 'N/A'}`
        ).catch(console.error);
      }
    } catch (err) {
      platform.status = 'error';
      platform.error = err.message;

      if (settings.telegram.enabled) {
        await sendTelegram(
          settings.telegram.botToken,
          settings.telegram.chatId,
          `❌ Upload failed!\nPlatform: ${platform.name}\nTitle: ${metadata.title || job.video_file_name}\nError: ${err.message}`
        ).catch(console.error);
      }
    }

    await supabase.from('upload_jobs').update({ platform_results: [...results] }).eq('id', jobId);
  }

  const anyError = results.some(r => r.status === 'error');
  await supabase.from('upload_jobs').update({
    status: anyError ? 'failed' : 'completed',
    platform_results: results,
    completed_at: new Date().toISOString(),
  }).eq('id', jobId);
}

// --- API Endpoints ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', mode: 'local' }));

// Process a specific job (called from frontend or cron)
app.post('/api/process/:id', async (req, res) => {
  try {
    processJob(req.params.id).catch(console.error);
    res.json({ started: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Process all pending jobs
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
  // Find scheduled uploads whose time has come
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
      // Mark as processing
      await supabase.from('scheduled_uploads').update({ status: 'processing' }).eq('id', item.id);

      // Create an upload job from the scheduled item
      const platformResults = item.target_platforms.map(name => ({
        name,
        status: 'pending',
      }));

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
        console.error('[Scheduler] Failed to create job for scheduled upload:', error);
        await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
        continue;
      }

      // Link the job and process it
      await supabase.from('scheduled_uploads').update({ upload_job_id: job.id }).eq('id', item.id);
      await processJob(job.id);

      // Mark scheduled upload as completed
      await supabase.from('scheduled_uploads').update({ status: 'completed' }).eq('id', item.id);
    } catch (err) {
      console.error('[Scheduler] Error processing scheduled upload:', err.message);
      await supabase.from('scheduled_uploads').update({ status: 'error' }).eq('id', item.id);
    }
  }
}

async function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }

  // Always run a per-minute check for scheduled uploads
  cronJob = cron.schedule('* * * * *', async () => {
    console.log(`[Cron] Tick at ${new Date().toISOString()}`);

    // Process scheduled uploads that are due
    await processScheduledUploads();

    // Process any pending immediate jobs
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

// Refresh cron when schedule changes
app.post('/api/refresh-cron', async (req, res) => {
  await setupCron();
  res.json({ ok: true });
});

// --- Start ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Local server running on http://localhost:${PORT}`);
  console.log(`Connected to Supabase: ${SUPABASE_URL}`);
  await setupCron();
});
