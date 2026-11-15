'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'system_beep',
  description: 'Play a notification audio beep through the PC motherboard or speakers.',
  tags: ['beep', 'sound', 'alert', 'notify', 'buzzer'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      frequency: { type: 'number', description: 'Beep frequency in Hz (default 800).' },
      duration_ms: { type: 'number', description: 'Duration in ms (default 300).' },
    },
  },
  async execute(args) {
    const freq = Math.max(200, Math.min(3000, Number(args?.frequency) || 800));
    const dur = Math.max(100, Math.min(2000, Number(args?.duration_ms) || 300));
    try {
      execSync(`powershell -Command "[console]::beep(${freq}, ${dur})"`, { timeout: 3000 });
      return { success: true, sound: 'played' };
    } catch (_) {
      return { error: 'beep_failed' };
    }
  },
};