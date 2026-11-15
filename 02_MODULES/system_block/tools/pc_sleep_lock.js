'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'pc_sleep_lock',
  description: 'Lock Windows workstation immediately.',
  tags: ['lock', 'lock screen', 'sleep', 'secure'],
  risk: 'RISKY',
  parameters: { type: 'object', properties: {} },
  async execute() {
    try {
      execSync('rundll32.exe user32.dll,LockWorkStation', { timeout: 3000 });
      return { success: true, message: 'Workstation locked' };
    } catch (e) {
      return { error: 'lock_workstation_failed' };
    }
  },
};