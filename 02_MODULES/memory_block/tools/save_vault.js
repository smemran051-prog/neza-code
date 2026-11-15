const path = require('path');
const { memoryAPI } = require('../api');

module.exports = {
    name: 'save_vault',
    description: 'Save text, code snippets, or local file contents into Layer 3 Knowledge Vault with tags for semantic/keyword retrieval.',
    category: 'memory_block',
    riskLevel: 'WRITE_SAFE',
    parameters: {
        type: 'object',
        properties: {
            filePath: {
                type: 'string',
                description: 'Optional absolute or relative path to a file (.txt, .js, .json, .md, .pdf) to ingest into the Knowledge Vault.'
            },
            content: {
                type: 'string',
                description: 'Raw text or source code content to store in the Knowledge Vault.'
            },
            type: {
                type: 'string',
                description: 'Content classification such as "text", "code", "doc", or "pdf". Defaults to "text".'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of keyword tags to index this knowledge entry under.'
            }
        },
        required: []
    },
    async execute(args = {}, ctx = {}) {
        try {
            const payload = {
                filePath: args.filePath ? path.resolve(String(args.filePath)) : undefined,
                content: args.content || args.text || '',
                type: args.type || 'text',
                tags: args.tags || []
            };

            const result = memoryAPI.saveVaultEntry(payload);
            return result;
        } catch (err) {
            return {
                success: false,
                tool: 'save_vault',
                error: err.message
            };
        }
    }
};