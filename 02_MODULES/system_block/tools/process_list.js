'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'process_list',
  description: 'List top active background tasks and running programs on Windows.',
  tags: ['process', 'running', 'apps', 'tasks', 'tasklist'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'Process name keyword to search (optional).' }
    },
  },
  async execute(args) {
    try {
      const raw = execSync('tasklist /NH /FO CSV', { timeout: 4000 }).toString();
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const filter = (args?.filter || '').toLowerCase();
      
      const list = lines
        .map(line => {
          const parts = line.split('","').map(p => p.replace(/"/g, ''));
          return { name: parts[0], pid: parts[1], memory: parts[4] };
        })
        .filter(p => !filter || p.name.toLowerCase().includes(filter))
        .slice(0, 15);

      return { count: list.length, processes: list };
    } catch (e) {
      return { error: 'process_list_failed' };
    }
  },
};