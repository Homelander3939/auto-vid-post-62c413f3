const express = require('express');
const cors = require('cors');
const { scanFolder } = require('./folderWatcher');
const { parseTextFile } = require('./textParser');
const { uploadToYouTube } = require('./uploaders/youtube');
const { uploadToTikTok } = require('./uploaders/tiktok');
const { uploadToInstagram } = require('./uploaders/instagram');
const { sendTelegram } = require('./telegram');
const { setupCron, getCronStatus, updateCron } = require('./scheduler');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const QUEUE_FILE = path.join(__dirname, 'data', 'queue.json');
const SCHEDULE_FILE = path.join(__dirname, 'data', 'schedule.json');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const defaultSettings = {
  folderPath: '',
  youtube: { email: '', password: '', enabled: false },
  tiktok: { email: '', password: '', enabled: false },
  instagram: { email: '', password: '', enabled: false },
  telegram: { botToken: '', chatId: '', enabled: false },
};

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
  res.json(readJSON(SETTINGS_FILE, defaultSettings));
});

app.post('/api/settings', (req, res) => {
  writeJSON(SETTINGS_FILE, req.body);
  res.json(req.body);
});

// --- Scan Folder ---
app.get('/api/scan', async (req, res) => {
  try {
    const settings = readJSON(SETTINGS_FILE, defaultSettings);
    if (!settings.folderPath) {
      return res.json({ videoFile: null, textFile: null, metadata: null });
    }
    const { videoFile, textFile } = scanFolder(settings.folderPath);
    let metadata = null;
    if (textFile) {
      const fullPath = path.join(settings.folderPath, textFile);
      metadata = parseTextFile(fullPath);
    }
    res.json({ videoFile, textFile, metadata });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- Upload ---
const uploaders = { youtube: uploadToYouTube, tiktok: uploadToTikTok, instagram: uploadToInstagram };

app.post('/api/upload', async (req, res) => {
  const settings = readJSON(SETTINGS_FILE, defaultSettings);
  const { platforms } = req.body;

  const { videoFile, textFile } = scanFolder(settings.folderPath);
  if (!videoFile) return res.status(400).json({ message: 'No video file found' });

  let metadata = null;
  if (textFile) {
    metadata = parseTextFile(path.join(settings.folderPath, textFile));
  }

  const job = {
    id: uuidv4(),
    videoFile,
    metadata,
    platforms: platforms.map(p => ({ name: p, status: 'pending' })),
    createdAt: new Date().toISOString(),
  };

  const queue = readJSON(QUEUE_FILE, []);
  queue.unshift(job);
  writeJSON(QUEUE_FILE, queue);

  // Process uploads in background
  processJob(job, settings).catch(console.error);

  res.json(job);
});

async function processJob(job, settings) {
  const queue = readJSON(QUEUE_FILE, []);
  const jobIndex = queue.findIndex(j => j.id === job.id);

  for (let i = 0; i < job.platforms.length; i++) {
    const platform = job.platforms[i];
    if (!uploaders[platform.name]) continue;

    platform.status = 'uploading';
    queue[jobIndex] = job;
    writeJSON(QUEUE_FILE, queue);

    try {
      const videoPath = path.join(settings.folderPath, job.videoFile);
      const result = await uploaders[platform.name](videoPath, job.metadata, settings[platform.name]);
      platform.status = 'success';
      platform.url = result.url || '';

      if (settings.telegram.enabled) {
        await sendTelegram(
          settings.telegram.botToken,
          settings.telegram.chatId,
          `✅ Upload successful!\nPlatform: ${platform.name}\nTitle: ${job.metadata?.title || job.videoFile}\nURL: ${platform.url || 'N/A'}`
        );
      }
    } catch (err) {
      platform.status = 'error';
      platform.error = err.message;

      if (settings.telegram.enabled) {
        await sendTelegram(
          settings.telegram.botToken,
          settings.telegram.chatId,
          `❌ Upload failed!\nPlatform: ${platform.name}\nTitle: ${job.metadata?.title || job.videoFile}\nError: ${err.message}`
        ).catch(console.error);
      }
    }

    queue[jobIndex] = job;
    writeJSON(QUEUE_FILE, queue);
  }

  job.completedAt = new Date().toISOString();
  queue[jobIndex] = job;
  writeJSON(QUEUE_FILE, queue);
}

// --- Queue ---
app.get('/api/queue', (req, res) => {
  res.json(readJSON(QUEUE_FILE, []));
});

app.post('/api/queue/:id/retry', async (req, res) => {
  const queue = readJSON(QUEUE_FILE, []);
  const job = queue.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ message: 'Job not found' });

  const settings = readJSON(SETTINGS_FILE, defaultSettings);
  const failedPlatforms = job.platforms.filter(p => p.status === 'error');
  failedPlatforms.forEach(p => { p.status = 'pending'; p.error = undefined; });
  writeJSON(QUEUE_FILE, queue);

  processJob(job, settings).catch(console.error);
  res.json(job);
});

// --- Schedule ---
app.get('/api/schedule', (req, res) => {
  res.json(readJSON(SCHEDULE_FILE, { enabled: false, cronExpression: '0 9 * * *', platforms: ['youtube', 'tiktok', 'instagram'] }));
});

app.post('/api/schedule', (req, res) => {
  writeJSON(SCHEDULE_FILE, req.body);
  updateCron(req.body, readJSON(SETTINGS_FILE, defaultSettings));
  res.json(req.body);
});

// Initialize cron
const scheduleConfig = readJSON(SCHEDULE_FILE, { enabled: false, cronExpression: '0 9 * * *', platforms: [] });
const settingsData = readJSON(SETTINGS_FILE, defaultSettings);
setupCron(scheduleConfig, settingsData, scanFolder, parseTextFile, processJob);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { processJob };
