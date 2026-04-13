/**
 * Clean a video filename into a presentable title.
 * Removes dates, numbers, underscores, dashes, and file extensions.
 */
export function cleanVideoTitle(filename: string): string {
  let name = filename.replace(/\.[^.]+$/, ''); // strip extension
  // Remove date patterns: 2024-01-15, 20240115, 2024_01_15
  name = name.replace(/[-_]\d{4}[-_]\d{2}[-_]\d{2}/g, '');
  // Remove timestamps: _123456, _1234567890
  name = name.replace(/[-_]\d{6,}/g, '');
  // Remove time patterns like _11-13-59
  name = name.replace(/[-_]\d{2}[-_]\d{2}[-_]\d{2}\b/g, '');
  // Replace separators with spaces
  name = name.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name || filename.replace(/\.[^.]+$/, '');
}

/**
 * Given arrays of video and text Files, match them by filename stem.
 * Returns pairs: { video, textFile? }[]
 */
export function matchVideoTextFiles(
  videoFiles: File[],
  textFiles: File[]
): { video: File; textFile?: File }[] {
  const textMap = new Map<string, File>();
  for (const tf of textFiles) {
    const stem = tf.name.replace(/\.[^.]+$/, '').toLowerCase();
    textMap.set(stem, tf);
  }

  return videoFiles.map((video) => {
    const stem = video.name.replace(/\.[^.]+$/, '').toLowerCase();
    return { video, textFile: textMap.get(stem) };
  });
}

export const INTENSITY_OPTIONS = [
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every 1 hour' },
  { value: 120, label: 'Every 2 hours' },
  { value: 180, label: 'Every 3 hours' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Every 24 hours' },
] as const;
