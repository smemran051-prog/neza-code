'use strict';
const memoryAPI = require('../api');

module.exports = {
  name: 'save_memory',
  description: 'Save a piece of information to long-term memory.',
  tags: ['memory', 'save', 'remember'],
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The exact information to remember.' },
      type: { type: 'string', description: 'Memory type (episodic, semantic, preference)', default: 'general' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Keywords for searching later.' }
    },
    required: ['content']
  },
  async execute(args, ctx) {
    try {
      const res = memoryAPI.saveMemory(args);
      return res;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
};