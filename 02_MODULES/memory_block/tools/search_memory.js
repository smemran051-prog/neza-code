'use strict';
const memoryAPI = require('../api');

module.exports = {
  name: 'search_memory',
  description: 'Search long-term memory for past events, preferences, or facts.',
  tags: ['memory', 'search', 'recall', 'remember'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword to search for.' },
      limit: { type: 'number', description: 'Max results to return (default 5).', default: 5 }
    },
    required: ['query']
  },
  async execute(args, ctx) {
    const query = args.query || '';
    const limit = Number(args.limit) || 5;
    const results = memoryAPI.searchMemory(query, limit);
    return { ok: true, query, results };
  }
};