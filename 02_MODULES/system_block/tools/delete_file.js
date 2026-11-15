'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'delete_file',
  description: 'Delete a non-core temporary or work file.',
  tags: ['delete', 'remove', 'unlink', 'trash'],
  risk: 'RISKY',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Relative path of the file to remove.' },
    },
    required: ['file_path'],
  },
  async execute(args) {
    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const target = path.resolve(root, args.file_path);
    if (!target.startsWith(root)) return { error: 'path_outside_allowed_root' };
    if (target.includes('00_ENGINE') || target.includes('01_CONFIG')) {
      return { error: 'deleting_core_files_is_forbidden' };
    }
    try {
      fs.unlinkSync(target);
      return { success: true, deleted: target };
    } catch (e) {
      return { error: String(e.message) };
    }
  },
};