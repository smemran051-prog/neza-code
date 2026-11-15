'use strict';

const https = require('https');

module.exports = {
  name: 'fetch_web_text',
  description: 'Fetch readable HTML/text content from a public URL.',
  tags: ['curl', 'fetch', 'scrape', 'web page', 'read url'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full HTTPS URL to fetch.' },
    },
    required: ['url'],
  },
  async execute(args) {
    const url = String(args.url || '');
    if (!url.startsWith('https://')) return { error: 'https_only_allowed' };
    return new Promise((resolve) => {
      https.get(url, { timeout: 8000, headers: { 'User-Agent': 'JarvisCore/3.0' } }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, content: raw.slice(0, 4000) }));
      }).on('error', (e) => resolve({ error: String(e.message) }));
    });
  },
};