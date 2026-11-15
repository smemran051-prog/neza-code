const { memoryAPI } = require('../api');

module.exports = {
    name: 'search_vault',
    description: 'Search the Layer 3 Knowledge Vault using native TF-IDF keyword and tag scoring to retrieve the top 3 most relevant chunks.',
    category: 'memory_block',
    riskLevel: 'READ',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Search keywords, technical phrase, or filename to look up in the Knowledge Vault.'
            },
            topK: {
                type: 'number',
                description: 'Maximum number of matching chunks to return (default is 3).'
            }
        },
        required: ['query']
    },
    async execute(args = {}, ctx = {}) {
        try {
            const query = args.query || args.q || args.keyword || '';
            const topK = Number(args.topK || args.limit) || 3;
            const matches = memoryAPI.searchVault(query, topK);

            return {
                success: true,
                tool: 'search_vault',
                query: query,
                count: matches.length,
                results: matches
            };
        } catch (err) {
            return {
                success: false,
                tool: 'search_vault',
                error: err.message,
                results: []
            };
        }
    }
};