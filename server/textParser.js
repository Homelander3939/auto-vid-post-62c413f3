const fs = require('fs');

function parseTextFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const metadata = {
    title: '',
    description: '',
    tags: [],
    platforms: ['youtube', 'tiktok', 'instagram'],
  };

  // Matches section headers like "--- Description ---" or "=== VIDEO METADATA ==="
  const dashSectionRegex = /^-{2,}\s*(.+?)\s*-{2,}$/;
  const equalsSectionRegex = /^={2,}\s*(.+?)\s*={2,}$/;

  let activeSection = null; // 'description' | 'keywords' | 'tags' | 'other' | null
  const descLines = [];
  const keywordLines = [];
  const tagLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // === ... === headers: reset to key:value mode (document-level marker)
    if (equalsSectionRegex.test(line)) {
      activeSection = null;
      continue;
    }

    // --- ... --- headers: enter named section
    const dashMatch = line.match(dashSectionRegex);
    if (dashMatch) {
      const sectionName = dashMatch[1].toLowerCase().trim();
      if (sectionName.includes('description') || sectionName.includes('caption')) {
        activeSection = 'description';
      } else if (sectionName.includes('keyword')) {
        activeSection = 'keywords';
      } else if (sectionName.includes('tag') || sectionName.includes('hashtag')) {
        activeSection = 'tags';
      } else {
        activeSection = 'other';
      }
      continue;
    }

    // Inside a named section: accumulate lines
    if (activeSection === 'description') {
      descLines.push(line);
      continue;
    } else if (activeSection === 'keywords') {
      // Skip lines that look like metadata key:value pairs (e.g., "Campaign: Romal History")
      if (!line.includes(':')) {
        keywordLines.push(line);
      }
      continue;
    } else if (activeSection === 'tags') {
      // Only collect lines that contain hashtags or are comma-separated tags
      if (line.includes('#') || (line.includes(',') && !line.includes(':'))) {
        tagLines.push(...splitTags(line));
      }
      continue;
    } else if (activeSection === 'other') {
      continue;
    }

    // No active section: parse key:value pairs
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    switch (key) {
      case 'title':
      case 'header':
      case 'headline':
        metadata.title = value;
        break;
      case 'description':
      case 'caption':
      case 'details':
        if (value) descLines.push(value);
        activeSection = 'description';
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

  // Apply accumulated section data
  if (descLines.length > 0) {
    metadata.description = descLines.join('\n');
  }
  if (tagLines.length > 0 && metadata.tags.length === 0) {
    metadata.tags = tagLines;
  }
  if (keywordLines.length > 0 && metadata.tags.length === 0) {
    metadata.tags = splitTags(keywordLines.join(', '));
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
