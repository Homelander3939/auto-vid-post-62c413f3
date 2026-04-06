const fs = require('fs');

function parseTextFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  const metadata = {
    title: '',
    description: '',
    tags: [],
    platforms: ['youtube', 'tiktok', 'instagram'],
  };

  let activeMultilineKey = null;

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      if (activeMultilineKey === 'description') {
        metadata.description = metadata.description
          ? `${metadata.description}\n${line}`
          : line;
      }
      continue;
    }

    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();
    activeMultilineKey = null;

    switch (key) {
      case 'title':
      case 'header':
      case 'headline':
        metadata.title = value;
        break;
      case 'description':
      case 'caption':
      case 'details':
        metadata.description = value;
        activeMultilineKey = 'description';
        break;
      case 'tags':
      case 'keywords':
      case 'hashtags':
        metadata.tags = splitTags(value);
        break;
      case 'platforms':
        metadata.platforms = value.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
        break;
    }
  }

  return metadata;
}

/**
 * Split a tags/hashtags string into individual tags.
 * Supports both comma-separated ("tag1, tag2") and space-separated hashtags ("#tag1 #tag2").
 */
function splitTags(value) {
  if (!value) return [];
  // If the value contains commas, split by comma
  if (value.includes(',')) {
    return value.split(',').map(t => t.trim()).filter(Boolean);
  }
  // Otherwise, split by spaces (handles "#tag1 #tag2 #tag3" format)
  return value.split(/\s+/).map(t => t.trim()).filter(Boolean);
}

module.exports = { parseTextFile };
