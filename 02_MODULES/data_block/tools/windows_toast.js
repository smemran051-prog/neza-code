'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'windows_toast',
  description: 'Display a native Windows notification banner.',
  tags: ['notification', 'toast', 'popup alert', 'message box'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title of the notification.' },
      message: { type: 'string', description: 'Body text of the notification.' },
    },
    required: ['title', 'message'],
  },
  async execute(args) {
    const t = String(args.title || 'JARVIS').replace(/["`$]/g, '');
    const m = String(args.message || '').replace(/["`$]/g, '');
    const script = `powershell -Command "[reflection.assembly]::loadwithpartialname('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('${m}', '${t}')"`;
    try {
      execSync(script, { timeout: 10000 });
      return { success: true };
    } catch (_) {
      return { error: 'toast_failed' };
    }
  },
};