'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'clipboard_read',
  description: 'Read currently copied plain text from the Windows OS clipboard.',
  tags: ['clipboard', 'copy', 'paste', 'copied', 'clip'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    try {
      const text = execSync('powershell -NoProfile -Command "Get-Clipboard"', { timeout: 3000 }).toString();
      return { text: text.trim() };
    } catch (e) {
      return { error: 'clipboard_empty_or_failed' };
    }
  },
};