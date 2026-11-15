'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'create_directory',
  description: 'Create a new folder/directory inside the JARVIS project directory.',
  tags: ['mkdir', 'create folder', 'new directory', 'folder'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      folder_path: { type: 'string', description: 'Relative path of directory to create.' },
    },
    required: ['folder_path'],
  },
  async execute(args) {
    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const target = path.resolve(root, args.folder_path);
    if (!target.startsWith(root)) return { error: 'path_outside_allowed_root' };
    try {
      fs.mkdirSync(target, { recursive: true });
      return { success: true, created_directory: target };
    } catch (e) {
      return { error: String(e.message) };
    }
  },
};