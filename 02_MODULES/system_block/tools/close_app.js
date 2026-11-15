'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'close_app',
  description: 'Terminate or kill a specific running program/process by name.',
  tags: ['kill', 'close', 'terminate', 'stop app', 'process'],
  risk: 'RISKY',
  parameters: {
    type: 'object',
    properties: {
      process_name: { type: 'string', description: 'Name of the executable (e.g. notepad.exe, chrome.exe).' },
    },
    required: ['process_name'],
  },
  async execute(args) {
    const proc = String(args.process_name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!proc) return { error: 'invalid_process_name' };
    try {
      execSync(`taskkill /IM ${proc} /F`, { timeout: 4000 });
      return { success: true, message: `Terminated process: ${proc}` };
    } catch (e) {
      return { error: `Failed to terminate ${proc}` };
    }
  },
};