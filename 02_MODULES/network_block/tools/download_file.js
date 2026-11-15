'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

module.exports = {
  name: 'download_file',
  description: 'Download a remote file from an HTTPS URL into work/downloads directory.',
  tags: ['download', 'get file', 'save url', 'fetch file'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTPS URL to download.' },
      filename: { type: 'string', description: 'Local destination filename.' },
    },
    required: ['url', 'filename'],
  },
  async execute(args) {
    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const dlDir = path.join(root, 'work', 'downloads');
    fs.mkdirSync(dlDir, { recursive: true });
    const target = path.join(dlDir, String(args.filename).replace(/[^a-zA-Z0-9._-]/g, ''));

    return new Promise((resolve) => {
      https.get(args.url, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) return resolve({ error: `http_${res.statusCode}` });
        const fileStream = fs.createWriteStream(target);
        res.pipe(fileStream);
        fileStream.on('finish', () => resolve({ success: true, saved_to: target }));
      }).on('error', (e) => resolve({ error: String(e.message) }));
    });
  },
};