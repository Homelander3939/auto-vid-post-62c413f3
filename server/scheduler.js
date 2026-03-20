const cron = require('node-cron');
const path = require('path');

let currentJob = null;

function setupCron(config, settings, scanFolder, parseTextFile, processJob) {
  if (currentJob) {
    currentJob.stop();
    currentJob = null;
  }

  if (!config.enabled || !config.cronExpression) return;

  try {
    currentJob = cron.schedule(config.cronExpression, async () => {
      console.log(`[Cron] Running scheduled upload at ${new Date().toISOString()}`);
      try {
        const { videoFile, textFile } = scanFolder(settings.folderPath);
        if (!videoFile) {
          console.log('[Cron] No video file found, skipping');
          return;
        }

        let metadata = null;
        if (textFile) {
          metadata = parseTextFile(path.join(settings.folderPath, textFile));
        }

        const { v4: uuidv4 } = require('uuid');
        const job = {
          id: uuidv4(),
          videoFile,
          metadata,
          platforms: config.platforms.map(p => ({ name: p, status: 'pending' })),
          createdAt: new Date().toISOString(),
        };

        await processJob(job, settings);
      } catch (err) {
        console.error('[Cron] Error:', err.message);
      }
    });

    console.log(`[Cron] Scheduled with expression: ${config.cronExpression}`);
  } catch (err) {
    console.error('[Cron] Invalid cron expression:', config.cronExpression);
  }
}

function updateCron(config, settings) {
  const { scanFolder } = require('./folderWatcher');
  const { parseTextFile } = require('./textParser');
  const { processJob } = require('./index');
  setupCron(config, settings, scanFolder, parseTextFile, processJob);
}

function getCronStatus() {
  return { running: !!currentJob };
}

module.exports = { setupCron, updateCron, getCronStatus };
