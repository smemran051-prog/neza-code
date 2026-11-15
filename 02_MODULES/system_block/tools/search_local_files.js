'use strict';

/**
 * Tool: search_local_files
 * Purpose: Search for files by keyword across JARVIS root or Desktop.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  name: 'search_local_files',
  description: 'C1. Find and search files by name keyword inside JARVIS root or Desktop folder.',
  tags: ['search', 'find', 'locate', 'file', 'filename', 'desktop', 'folder', 'scan', 'lookup'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: 'Keyword to match against file names (case-insensitive).',
      },
      scope: {
        type: 'string',
        enum: ['jarvis', 'desktop'],
        description: 'Where to search: "jarvis" for JARVIS_ROOT or "desktop" for User Desktop.',
      },
    },
    required: ['keyword'],
  },
  async execute(args) {
    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const desktop = path.join(os.homedir(), 'Desktop');
    const baseDir = args.scope === 'desktop' && fs.existsSync(desktop) ? desktop : root;
    const kw = String(args.keyword || '').toLowerCase().trim();

    if (!kw) return { error: 'keyword_required' };

    const matches = [];
    function walk(dir, depth) {
      if (depth > 3 || matches.length >= 30) return;
      let list = [];
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of list) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.name.toLowerCase().includes(kw)) {
          matches.push({ name: ent.name, type: ent.isDirectory() ? 'dir' : 'file', path: full });
          if (matches.length >= 30) return;
        }
        if (ent.isDirectory()) walk(full, depth + 1);
      }
    }

    walk(baseDir, 0);
    return { scope: baseDir, keyword: kw, count: matches.length, matches };
  },
};