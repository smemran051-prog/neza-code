'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'network_ping_check',
  description: 'Ping an external host or IP to check network connectivity.',
  tags: ['internet', 'ping', 'network', 'connection', 'wifi'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: 'Host or IP to ping (default 8.8.8.8).' },
    },
  },
  async execute(args) {
    const host = (args?.host || '8.8.8.8').replace(/[^a-zA-Z0-9.-]/g, '');
    try {
      execSync(`ping -n 1 ${host}`, { timeout: 3000 });
      return { status: 'online', host, ok: true };
    } catch (_) {
      return { status: 'offline', host, ok: false };
    }
  },
};