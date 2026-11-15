'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'read_json_file',
  description: 'Read and parse a JSON file safely.',
  tags: ['json', 'parse', 'read config', 'data'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Relative path of the JSON file.' },
    },
    required: ['file_path'],
  },
  async execute(args) {
    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const target = path.resolve(root, args.file_path);
    try {
      const raw = fs.readFileSync(target, 'utf8');
      return { parsed: JSON.parse(raw) };
    } catch (e) {
      return { error: String(e.message) };
    }
  },
};