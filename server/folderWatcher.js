const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];

/** Extract trailing series number from filename for sorting (e.g. "Roman_History_38_2026-04-13.mp4" → 38).
 * Strips trailing date/time/timestamp suffixes from the *end* of the stem only,
 * then takes the trailing number. Anchored to $ so we never accidentally chew
 * through the series number (e.g. avoids matching "_69_08-03-11" as a date).
 */
function extractSeriesNum(filename) {
  let stem = filename.replace(/\.[^.]+$/, '');
  // Repeatedly peel trailing date/time/timestamp segments off the END.
  let prev;
  do {
    prev = stem;
    stem = stem
      // _YYYY-MM-DD or _YYYY_MM_DD at the very end
      .replace(/[\s._-]+\d{4}[-_.]\d{2}[-_.]\d{2}$/, '')
      // _HH-MM-SS at the very end
      .replace(/[\s._-]+\d{2}[-_.]\d{2}[-_.]\d{2}$/, '')
      // long unix-ish timestamp at the very end
      .replace(/[\s._-]+\d{6,}$/, '');
  } while (stem !== prev);
  const match = stem.match(/(\d+)\D*$/);
  return match ? parseInt(match[1], 10) : Infinity;
}

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

  // Sort by series number (lowest first), fallback to modification time
  pairs.sort((a, b) => {
    const numA = extractSeriesNum(a.videoFile);
    const numB = extractSeriesNum(b.videoFile);
    if (numA !== numB) return numA - numB;
    return a.videoFile.localeCompare(b.videoFile, undefined, { numeric: true, sensitivity: 'base' });
  });
  return pairs;
}

/**
 * Return video+txt pairs that are NEW (not in `alreadyQueued` set) and STABLE
 * (size unchanged since the previous observation in `sizeMap`). Mutates `sizeMap`
 * with the latest observed sizes so the caller can persist it.
 *
 * A pair is "ready" only when:
 *   - matching .txt exists for the video stem
 *   - both files exist on disk
 *   - both files' sizes match what was seen in the previous scan
 *     (i.e. the download has finished — size stable across one ~15s tick)
 *   - the video's absolute path is NOT already in `alreadyQueued`
 */
function getReadyPairs(folderPath, alreadyQueued, sizeMap) {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  const pairs = scanAllFiles(folderPath);
  const ready = [];

  for (const pair of pairs) {
    if (!pair.textFile) continue;
    const videoAbs = path.resolve(path.join(folderPath, pair.videoFile));
    const textAbs = path.resolve(path.join(folderPath, pair.textFile));
    if (alreadyQueued.has(videoAbs)) continue;

    let videoSize, textSize;
    try {
      videoSize = fs.statSync(videoAbs).size;
      textSize = fs.statSync(textAbs).size;
    } catch {
      continue;
    }

    const prevVideo = sizeMap[videoAbs];
    const prevText = sizeMap[textAbs];
    sizeMap[videoAbs] = videoSize;
    sizeMap[textAbs] = textSize;

    // Need at least one prior observation, and the size must match it.
    if (prevVideo === undefined || prevText === undefined) continue;
    if (prevVideo !== videoSize || prevText !== textSize) continue;
    if (videoSize === 0) continue;

    ready.push({ videoAbs, textAbs, videoFile: pair.videoFile, textFile: pair.textFile, folderPath });
  }

  return ready;
}

module.exports = { scanFolder, scanAllFiles, getReadyPairs };
