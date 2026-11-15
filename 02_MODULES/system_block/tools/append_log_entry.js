'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'append_log_entry',
  description: 'Append a single text log entry to a designated text file.',
  tags: ['append', 'log', 'write line', 'record'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Relative path of the log file.' },
      entry: { type: 'string', description: 'Line of text to append.' },
    },
    required: ['file_path', 'entry'],
  },
  async execute(args) {
    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const target = path.resolve(root, args.file_path);
    try {
      fs.appendFileSync(target, `[${new Date().toISOString()}] ${args.entry}\n`, 'utf8');
      return { success: true };
    } catch (e) {
      return { error: String(e.message) };
    }
  },
};