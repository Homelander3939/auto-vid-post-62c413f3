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

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    switch (key) {
      case 'title':
        metadata.title = value;
        break;
      case 'description':
        metadata.description = value;
        break;
      case 'tags':
      case 'keywords':
      case 'hashtags':
        metadata.tags = value.split(',').map(t => t.trim()).filter(Boolean);
        break;
      case 'platforms':
        metadata.platforms = value.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
        break;
    }
  }

  return metadata;
}

module.exports = { parseTextFile };
