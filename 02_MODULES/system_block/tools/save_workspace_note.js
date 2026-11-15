'use strict';

/**
 * Tool: save_workspace_note
 * Purpose: Save quick notes, logs, or reports into the JARVIS work/notes folder.
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'save_workspace_note',
  description: 'B1. Create and save a text or markdown note inside the JARVIS work/notes directory.',
  tags: ['note', 'save', 'report', 'markdown', 'log', 'memo', 'draft', 'workspace', 'summary'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'File name for the note (e.g. job_summary.txt or report.md)',
      },
      content: {
        type: 'string',
        description: 'Full text content to write into the note.',
      },
    },
    required: ['filename', 'content'],
  },
  async execute(args, ctx) {
    const root = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
    const notesDir = path.join(root, 'work', 'notes');
    fs.mkdirSync(notesDir, { recursive: true });

    const safeName = String(args.filename || 'note.txt').replace(/[^A-Za-z0-9_.\-]/g, '_');
    const finalPath = path.join(notesDir, safeName);
    const text = String(args.content || '');

    fs.writeFileSync(finalPath, text, 'utf8');
    if (ctx && typeof ctx.audit === 'function') {
      ctx.audit('info', 'tool_workspace_note_saved', { file: finalPath, bytes: Buffer.byteLength(text, 'utf8') });
    }

    return {
      success: true,
      saved_to: finalPath,
      bytes_written: Buffer.byteLength(text, 'utf8'),
    };
  },
};