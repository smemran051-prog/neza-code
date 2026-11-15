'use strict';

const https = require('https');

module.exports = {
  name: 'fetch_public_ip',
  description: 'Lookup external public IPv4 address of this machine.',
  tags: ['public ip', 'my ip', 'external ip', 'network address'],
  risk: 'READ',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return new Promise((resolve) => {
      https.get('https://api.ipify.org?format=json', { timeout: 4000 }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch (_) { resolve({ error: 'parse_failed' }); }
        });
      }).on('error', () => resolve({ error: 'ip_lookup_failed' }));
    });
  },
};