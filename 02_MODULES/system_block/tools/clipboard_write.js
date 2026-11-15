'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'clipboard_write',
  description: 'Copy specified text into the Windows OS clipboard.',
  tags: ['copy to clipboard', 'clipboard write', 'set clipboard', 'paste'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to copy into clipboard.' },
    },
    required: ['text'],
  },
  async execute(args) {
    const str = String(args.text || '');
    try {
      execSync('clip', { input: str, timeout: 3000 });
      return { success: true, copied_length: str.length };
    } catch (_) {
      return { error: 'clipboard_write_failed' };
    }
  },
};