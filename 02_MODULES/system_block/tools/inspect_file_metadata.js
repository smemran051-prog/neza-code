'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'inspect_file_metadata',
  description: 'Check size, created date, and last modified date of any file.',
  tags: ['file size', 'modified date', 'stat', 'metadata', 'file info'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Relative path to inspect.' },
    },
    required: ['file_path'],
  },
  async execute(args) {
    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const target = path.resolve(root, args.file_path);
    try {
      const s = fs.statSync(target);
      return {
        path: target,
        is_file: s.isFile(),
        size_bytes: s.size,
        size_kb: Math.round(s.size / 1024),
        created_at: s.birthtime,
        modified_at: s.mtime,
      };
    } catch (e) {
      return { error: 'file_not_found' };
    }
  },
};