const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MemoryAPI {
    constructor(baseDir) {
        this.baseDir = baseDir || __dirname;
        this.storageDir = path.join(this.baseDir, 'storage');
        this.corePath = path.join(this.storageDir, 'core_memory.json');
        this.rulesPath = path.join(this.storageDir, 'behavior_rules.json');
        this.vaultPath = path.join(this.storageDir, 'vault_index.json');
        this.legacyPath = path.join(this.storageDir, 'memory.jsonl');

        this._ensureStorage();
    }

    _ensureStorage() {
        try {
            fs.mkdirSync(this.storageDir, { recursive: true });
        } catch (err) {
            console.error('[MemoryAPI] Directory creation error:', err.message);
        }

        if (!fs.existsSync(this.corePath)) {
            this._safeWriteJSON(this.corePath, {
                version: 1,
                updatedAt: new Date().toISOString(),
                profile: {
                    name: 'MD ASHIQUR RAHAMAN (Ashik)',
                    role: 'EEE Engineer & Systems Architect',
                    systemName: 'NEZA'
                },
                identity: {},
                goals: [],
                entries: []
            });
        }

        if (!fs.existsSync(this.rulesPath)) {
            this._safeWriteJSON(this.rulesPath, {
                version: 1,
                updatedAt: new Date().toISOString(),
                rules: [
                    {
                        id: 'rule_default_1',
                        category: 'system',
                        instruction: 'Prioritize modular, local-first execution and strict error handling.',
                        priority: 'high',
                        createdAt: new Date().toISOString()
                    }
                ]
            });
        }

        if (!fs.existsSync(this.vaultPath)) {
            this._safeWriteJSON(this.vaultPath, {
                version: 1,
                updatedAt: new Date().toISOString(),
                chunks: []
            });
        }
    }

    _safeReadJSON(filePath, fallbackObject) {
        try {
            if (!fs.existsSync(filePath)) {
                return fallbackObject;
            }
            const raw = fs.readFileSync(filePath, 'utf8');
            if (!raw || !raw.trim()) {
                return fallbackObject;
            }
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : fallbackObject;
        } catch (err) {
            console.error(`[MemoryAPI] Corrupted or unreadable JSON at ${filePath}, returning fallback:`, err.message);
            return fallbackObject;
        }
    }

    _safeWriteJSON(filePath, dataObject) {
        try {
            const dir = path.dirname(filePath);
            fs.mkdirSync(dir, { recursive: true });
            const tempPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
            const serialized = JSON.stringify(dataObject, null, 2);
            fs.writeFileSync(tempPath, serialized, 'utf8');
            fs.renameSync(tempPath, filePath);
            return true;
        } catch (err) {
            try {
                const dir = path.dirname(filePath);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, JSON.stringify(dataObject, null, 2), 'utf8');
                return true;
            } catch (fallbackErr) {
                console.error(`[MemoryAPI] Failed to write JSON to ${filePath}:`, fallbackErr.message);
                return false;
            }
        }
    }

    // ==========================================
    // LAYER 1: CORE MEMORY
    // ==========================================
    getCore() {
        const fallback = {
            version: 1,
            updatedAt: new Date().toISOString(),
            profile: {},
            identity: {},
            goals: [],
            entries: []
        };
        return this._safeReadJSON(this.corePath, fallback);
    }

    saveCore(data) {
        const current = this.getCore();
        const now = new Date().toISOString();

        if (!data || typeof data !== 'object') {
            data = { content: String(data || '') };
        }

        if (data.profile && typeof data.profile === 'object') {
            current.profile = Object.assign({}, current.profile || {}, data.profile);
        }

        if (data.identity && typeof data.identity === 'object') {
            current.identity = Object.assign({}, current.identity || {}, data.identity);
        }

        if (Array.isArray(data.goals)) {
            const existingGoals = new Set(current.goals || []);
            for (let i = 0; i < data.goals.length; i++) {
                if (data.goals[i]) {
                    existingGoals.add(String(data.goals[i]).trim());
                }
            }
            current.goals = Array.from(existingGoals);
        } else if (typeof data.goal === 'string' && data.goal.trim()) {
            current.goals = current.goals || [];
            if (!current.goals.includes(data.goal.trim())) {
                current.goals.push(data.goal.trim());
            }
        }

        const rawEntryText = data.content || data.fact || data.memory || data.text || data.value;
        const entryKey = data.key || data.category || 'general';

        if (rawEntryText) {
            current.entries = Array.isArray(current.entries) ? current.entries : [];
            const existingIndex = current.entries.findIndex(
                (item) => item.key === entryKey && item.content === String(rawEntryText).trim()
            );

            const entryObj = {
                id: data.id || `core_${crypto.randomBytes(6).toString('hex')}`,
                key: String(entryKey).trim(),
                content: String(rawEntryText).trim(),
                updatedAt: now
            };

            if (existingIndex >= 0) {
                current.entries[existingIndex] = entryObj;
            } else {
                current.entries.push(entryObj);
            }
        }

        current.updatedAt = now;
        const saved = this._safeWriteJSON(this.corePath, current);

        return {
            success: saved,
            layer: 'core_memory',
            updatedAt: now,
            data: current
        };
    }

    // ==========================================
    // LAYER 2: BEHAVIOR RULES
    // ==========================================
    getRules() {
        const fallback = {
            version: 1,
            updatedAt: new Date().toISOString(),
            rules: []
        };
        return this._safeReadJSON(this.rulesPath, fallback);
    }

    saveRules(data) {
        const current = this.getRules();
        current.rules = Array.isArray(current.rules) ? current.rules : [];
        const now = new Date().toISOString();

        if (typeof data === 'string') {
            data = { instruction: data, category: 'general', priority: 'normal' };
        } else if (!data || typeof data !== 'object') {
            return { success: false, error: 'Invalid rule payload provided.' };
        }

        if (Array.isArray(data.rules)) {
            for (let i = 0; i < data.rules.length; i++) {
                this._upsertSingleRule(current.rules, data.rules[i], now);
            }
        } else {
            this._upsertSingleRule(current.rules, data, now);
        }

        current.updatedAt = now;
        const saved = this._safeWriteJSON(this.rulesPath, current);

        return {
            success: saved,
            layer: 'behavior_rules',
            count: current.rules.length,
            updatedAt: now,
            data: current
        };
    }

    _upsertSingleRule(rulesArray, ruleInput, timestamp) {
        if (typeof ruleInput === 'string') {
            ruleInput = { instruction: ruleInput };
        }
        const instruction = String(
            ruleInput.instruction || ruleInput.rule || ruleInput.content || ruleInput.text || ''
        ).trim();

        if (!instruction) return;

        const category = String(ruleInput.category || 'general').trim();
        const priority = String(ruleInput.priority || 'normal').trim();
        const existingIdx = rulesArray.findIndex(
            (r) => r.instruction.toLowerCase() === instruction.toLowerCase()
        );

        const ruleRecord = {
            id: ruleInput.id || `rule_${crypto.randomBytes(6).toString('hex')}`,
            category: category,
            instruction: instruction,
            priority: priority,
            createdAt: existingIdx >= 0 ? rulesArray[existingIdx].createdAt : timestamp,
            updatedAt: timestamp
        };

        if (existingIdx >= 0) {
            rulesArray[existingIdx] = ruleRecord;
        } else {
            rulesArray.push(ruleRecord);
        }
    }

    // ==========================================
    // LAYER 3: KNOWLEDGE VAULT
    // ==========================================
    _extractPdfTextNative(buffer) {
        const rawLatin = buffer.toString('latin1');
        const extractedPieces = [];

        const literalRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
        let match;
        while ((match = literalRegex.exec(rawLatin)) !== null) {
            const cleaned = match[1]
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t')
                .replace(/\\\(/g, '(')
                .replace(/\\\)/g, ')')
                .replace(/\\\\/g, '\\');
            if (/[\x20-\x7E]{3,}/.test(cleaned)) {
                extractedPieces.push(cleaned.trim());
            }
        }

        const tjArrayRegex = /\[([^\]]+)\]\s*TJ/g;
        while ((match = tjArrayRegex.exec(rawLatin)) !== null) {
            const inner = match[1];
            const stringParts = inner.match(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g);
            if (stringParts) {
                const combined = stringParts
                    .map((s) => s.slice(1, -1))
                    .join('')
                    .replace(/\\\(/g, '(')
                    .replace(/\\\)/g, ')');
                if (/[\x20-\x7E]{3,}/.test(combined)) {
                    extractedPieces.push(combined.trim());
                }
            }
        }

        if (extractedPieces.length === 0) {
            const asciiMatches = rawLatin.match(/[\x20-\x7E]{12,}/g) || [];
            const filtered = asciiMatches.filter((line) => {
                const lower = line.toLowerCase();
                if (lower.includes('/type') || lower.includes('/font') || lower.includes('endobj') || lower.includes('stream')) {
                    return false;
                }
                return true;
            });
            return filtered.join('\n').slice(0, 50000);
        }

        return extractedPieces.join(' ').replace(/\s+/g, ' ').trim();
    }

    _chunkContent(text, maxChunkSize = 1000, overlap = 150) {
        const cleanText = String(text || '').replace(/\r\n/g, '\n').trim();
        if (!cleanText) return [];
        if (cleanText.length <= maxChunkSize) return [cleanText];

        const chunks = [];
        let startIndex = 0;

        while (startIndex < cleanText.length) {
            let endIndex = startIndex + maxChunkSize;
            if (endIndex < cleanText.length) {
                const paragraphBreak = cleanText.lastIndexOf('\n\n', endIndex);
                const lineBreak = cleanText.lastIndexOf('\n', endIndex);
                const sentenceBreak = cleanText.lastIndexOf('. ', endIndex);
                const spaceBreak = cleanText.lastIndexOf(' ', endIndex);

                if (paragraphBreak > startIndex + maxChunkSize * 0.5) {
                    endIndex = paragraphBreak + 2;
                } else if (lineBreak > startIndex + maxChunkSize * 0.5) {
                    endIndex = lineBreak + 1;
                } else if (sentenceBreak > startIndex + maxChunkSize * 0.5) {
                    endIndex = sentenceBreak + 2;
                } else if (spaceBreak > startIndex + maxChunkSize * 0.5) {
                    endIndex = spaceBreak + 1;
                }
            }

            const slice = cleanText.slice(startIndex, endIndex).trim();
            if (slice) {
                chunks.push(slice);
            }

            if (endIndex >= cleanText.length) break;
            startIndex = Math.max(startIndex + 1, endIndex - overlap);
        }

        return chunks;
    }

    saveVaultEntry(params = {}) {
        const filePath = params.filePath ? String(params.filePath).trim() : null;
        let content = params.content ? String(params.content) : '';
        let type = params.type ? String(params.type).toLowerCase().trim() : 'text';
        const rawTags = params.tags || [];
        const tags = Array.isArray(rawTags)
            ? rawTags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
            : String(rawTags).split(',').map((t) => t.toLowerCase().trim()).filter(Boolean);

        let fileMeta = {
            fileName: filePath ? path.basename(filePath) : 'inline_entry',
            extension: filePath ? path.extname(filePath).toLowerCase() : '.txt',
            sizeBytes: Buffer.byteLength(content, 'utf8')
        };

        if (filePath && fs.existsSync(filePath)) {
            try {
                const stat = fs.statSync(filePath);
                fileMeta.sizeBytes = stat.size;
                fileMeta.modifiedAt = stat.mtime.toISOString();

                if (!content) {
                    if (fileMeta.extension === '.pdf') {
                        type = 'pdf';
                        const buf = fs.readFileSync(filePath);
                        const extracted = this._extractPdfTextNative(buf);
                        content = extracted || `[PDF Metadata Only] File: ${fileMeta.fileName}, Size: ${stat.size} bytes, Path: ${filePath}`;
                    } else {
                        content = fs.readFileSync(filePath, 'utf8');
                    }
                }
            } catch (readErr) {
                if (!content) {
                    content = `[Unreadable File Metadata] File: ${filePath}, Error: ${readErr.message}`;
                }
            }
        }

        if (!content || !content.trim()) {
            return {
                success: false,
                error: 'No content or readable filePath provided to saveVaultEntry.'
            };
        }

        if (fileMeta.extension && !tags.includes(fileMeta.extension.replace('.', ''))) {
            tags.push(fileMeta.extension.replace('.', ''));
        }

        const vaultData = this._safeReadJSON(this.vaultPath, {
            version: 1,
            updatedAt: new Date().toISOString(),
            chunks: []
        });
        vaultData.chunks = Array.isArray(vaultData.chunks) ? vaultData.chunks : [];

        if (filePath) {
            vaultData.chunks = vaultData.chunks.filter((c) => c.filePath !== filePath);
        }

        const textChunks = this._chunkContent(content, 1000, 150);
        const now = new Date().toISOString();
        const docId = `doc_${crypto.randomBytes(6).toString('hex')}`;
        const createdChunks = [];

        for (let i = 0; i < textChunks.length; i++) {
            const chunkText = textChunks[i];
            const chunkObj = {
                id: `${docId}_chk_${i}`,
                docId: docId,
                chunkIndex: i,
                totalChunks: textChunks.length,
                filePath: filePath || null,
                fileName: fileMeta.fileName,
                type: type,
                tags: tags,
                content: chunkText,
                charLength: chunkText.length,
                createdAt: now
            };
            vaultData.chunks.push(chunkObj);
            createdChunks.push(chunkObj);
        }

        vaultData.updatedAt = now;
        const saved = this._safeWriteJSON(this.vaultPath, vaultData);

        return {
            success: saved,
            layer: 'knowledge_vault',
            docId: docId,
            chunksSaved: createdChunks.length,
            filePath: filePath,
            tags: tags,
            updatedAt: now
        };
    }

    _tokenize(text) {
        const stopWords = new Set([
            'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'have',
            'are', 'was', 'were', 'been', 'has', 'had', 'will', 'would', 'could',
            'should', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose',
            'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
            'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
            'so', 'than', 'too', 'very', 'can', 'just', 'into', 'about', 'over'
        ]);

        return String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9_\u0980-\u09FF\s.-]/g, ' ')
            .split(/\s+/)
            .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
            .filter((t) => t.length >= 2 && !stopWords.has(t));
    }

    searchVault(query, topK = 3) {
        const vaultData = this._safeReadJSON(this.vaultPath, {
            version: 1,
            updatedAt: new Date().toISOString(),
            chunks: []
        });

        const chunks = Array.isArray(vaultData.chunks) ? vaultData.chunks : [];
        if (chunks.length === 0) {
            return [];
        }

        const rawQuery = String(query || '').trim();
        if (!rawQuery) {
            return chunks.slice(-topK).reverse();
        }

        const queryTokens = this._tokenize(rawQuery);
        if (queryTokens.length === 0) {
            return chunks.slice(-topK).reverse();
        }

        const totalDocs = chunks.length;
        const docFreq = {};
        for (let i = 0; i < queryTokens.length; i++) {
            docFreq[queryTokens[i]] = 0;
        }

        const tokenizedChunks = chunks.map((chunk) => {
            const combinedText = `${chunk.fileName || ''} ${(chunk.tags || []).join(' ')} ${chunk.content || ''}`;
            const tokens = this._tokenize(combinedText);
            const tokenFreqMap = {};
            for (let i = 0; i < tokens.length; i++) {
                const tok = tokens[i];
                tokenFreqMap[tok] = (tokenFreqMap[tok] || 0) + 1;
            }
            for (const qTok of Object.keys(docFreq)) {
                if (tokenFreqMap[qTok]) {
                    docFreq[qTok] += 1;
                }
            }
            return {
                chunk: chunk,
                tokens: tokens,
                tokenFreqMap: tokenFreqMap,
                lowerContent: (chunk.content || '').toLowerCase()
            };
        });

        const lowerRawQuery = rawQuery.toLowerCase();
        const scoredResults = [];

        for (let i = 0; i < tokenizedChunks.length; i++) {
            const item = tokenizedChunks[i];
            const chunk = item.chunk;
            let rawScore = 0;
            let matchedUniqueTerms = 0;

            for (let j = 0; j < queryTokens.length; j++) {
                const qTerm = queryTokens[j];
                const tf = item.tokenFreqMap[qTerm] || 0;

                if (tf > 0) {
                    matchedUniqueTerms += 1;
                    const idf = Math.log(1 + totalDocs / (1 + (docFreq[qTerm] || 0)));
                    const sublinearTf = 1 + Math.log(tf);
                    rawScore += sublinearTf * idf;
                } else {
                    if (item.lowerContent.includes(qTerm)) {
                        rawScore += 0.4;
                    }
                }

                if (Array.isArray(chunk.tags) && chunk.tags.some((t) => t.includes(qTerm))) {
                    rawScore += 1.5;
                }

                if (chunk.fileName && chunk.fileName.toLowerCase().includes(qTerm)) {
                    rawScore += 1.25;
                }
            }

            if (rawQuery.length > 3 && item.lowerContent.includes(lowerRawQuery)) {
                rawScore += 3.0;
            }

            if (rawScore > 0) {
                const coverageBoost = 1 + (matchedUniqueTerms / queryTokens.length) * 0.5;
                const charLen = Math.max(100, (chunk.content || '').length);
                const lengthPenalty = 1 / Math.pow(charLen / 500, 0.25);
                const finalScore = Number((rawScore * coverageBoost * lengthPenalty).toFixed(4));

                scoredResults.push({
                    id: chunk.id,
                    docId: chunk.docId,
                    filePath: chunk.filePath,
                    fileName: chunk.fileName,
                    type: chunk.type,
                    tags: chunk.tags,
                    content: chunk.content,
                    score: finalScore,
                    createdAt: chunk.createdAt
                });
            }
        }

        scoredResults.sort((a, b) => b.score - a.score);
        return scoredResults.slice(0, topK);
    }

    // ==========================================
    // UNIVERSAL GATEWAY: executeTool
    // ==========================================
    async executeTool(action, args = {}, ctx = {}) {
        const normalizedAction = String(action || '').toLowerCase().trim();

        switch (normalizedAction) {
            case 'get_core':
                return this.getCore();

            case 'save_core':
            case 'save_memory':
                return this.saveCore(args);

            case 'get_rules':
            case 'get_rule':
                return this.getRules();

            case 'save_rule':
            case 'save_rules':
                return this.saveRules(args);

            case 'save_vault':
            case 'save_vault_entry':
                return this.saveVaultEntry(args);

            case 'search_vault':
            case 'search_memory': {
                const query = args.query || args.q || args.text || args.keyword || '';
                const limit = Number(args.limit || args.topK) || 3;
                return {
                    success: true,
                    query: query,
                    results: this.searchVault(query, limit)
                };
            }

            default:
                return {
                    success: false,
                    error: `Unknown memory_block action: "${action}". Supported actions: save_core, get_core, save_rule, get_rules, save_vault, search_vault.`
                };
        }
    }
}

const defaultMemoryAPI = new MemoryAPI(__dirname);

module.exports = {
    MemoryAPI: MemoryAPI,
    memoryAPI: defaultMemoryAPI,
    getCore: () => defaultMemoryAPI.getCore(),
    saveCore: (data) => defaultMemoryAPI.saveCore(data),
    getRules: () => defaultMemoryAPI.getRules(),
    saveRules: (data) => defaultMemoryAPI.saveRules(data),
    saveVaultEntry: (params) => defaultMemoryAPI.saveVaultEntry(params),
    searchVault: (query, topK) => defaultMemoryAPI.searchVault(query, topK),
    executeTool: (action, args, ctx) => defaultMemoryAPI.executeTool(action, args, ctx),
    init: (ctx) => {
        if (ctx && typeof ctx.registerService === 'function') {
            ctx.registerService('memory_block', defaultMemoryAPI);
        }
        return defaultMemoryAPI;
    }
};