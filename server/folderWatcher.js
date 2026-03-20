const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

function scanFolder(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { videoFile: null, textFile: null };
  }

  const files = fs.readdirSync(folderPath);

  // Find latest video file by modification time
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

module.exports = { scanFolder };
