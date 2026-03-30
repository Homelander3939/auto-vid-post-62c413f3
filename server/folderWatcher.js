const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

function scanFolder(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { videoFile: null, textFile: null };
  }

  const files = fs.readdirSync(folderPath);

  let latestVideo = null;
  let latestVideoTime = 0;
  let latestText = null;
  let latestTextTime = 0;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const fullPath = path.join(folderPath, file);
    const stat = fs.statSync(fullPath);

    if (VIDEO_EXTENSIONS.includes(ext) && stat.mtimeMs > latestVideoTime) {
      latestVideo = file;
      latestVideoTime = stat.mtimeMs;
    }

    if (ext === '.txt' && stat.mtimeMs > latestTextTime) {
      latestText = file;
      latestTextTime = stat.mtimeMs;
    }
  }

  return { videoFile: latestVideo, textFile: latestText };
}

/**
 * Scan ALL video files in a folder, match each to a .txt file by name stem.
 * Returns array sorted by modification time (oldest first).
 */
function scanAllFiles(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return [];
  }

  const files = fs.readdirSync(folderPath);

  // Build text file map by stem
  const textMap = {};
  for (const file of files) {
    if (path.extname(file).toLowerCase() === '.txt') {
      const stem = file.replace(/\.[^.]+$/, '').toLowerCase();
      textMap[stem] = file;
    }
  }

  // Collect all videos with matched text files
  const pairs = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext)) continue;

    const fullPath = path.join(folderPath, file);
    const stat = fs.statSync(fullPath);
    const stem = file.replace(/\.[^.]+$/, '').toLowerCase();

    pairs.push({
      videoFile: file,
      textFile: textMap[stem] || null,
      mtimeMs: stat.mtimeMs,
    });
  }

  // Sort oldest first so they upload in order
  pairs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return pairs;
}

module.exports = { scanFolder, scanAllFiles };
