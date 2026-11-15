'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, '00_ENGINE', 'tools_vectors_cache.json');

let extractor = null;
let toolVectors = new Map();
let initPromise = null;
let isReady = false;

// ১. মডেল লোড করা (Singleton Pattern)
async function loadModel() {
  if (!extractor) {
    try {
      const { pipeline } = require('@xenova/transformers');
      extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      console.log('[Vector Search] AI Embedding Model Loaded.');
    } catch (e) {
      console.error('[Vector Search] Model Load Failed:', e.message);
    }
  }
}

// ২. কসাইন সিমিলারিটি (Cosine Similarity)
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0, magA = 0, magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ৩. ভেক্টর বিল্ড ও ক্যাশ (Persistence)
async function buildVectors(entries) {
  if (initPromise) return initPromise; // Race Condition ফিক্স

  initPromise = (async () => {
    await loadModel();
    if (!extractor) return;

    toolVectors.clear();
    const cacheData = {};
    let hasChanges = false;
    let cachedVectors = {};

    // ক্যাশ ফাইল থাকলে লোড করা
    if (fs.existsSync(CACHE_FILE)) {
      try { cachedVectors = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) {}
    }

    for (const tool of entries) {
      if (!tool.enabled) continue;
      
      const textToEmbed = `${tool.name} ${tool.description} ${(tool.tags || []).join(' ')}`;
      const hash = crypto.createHash('md5').update(textToEmbed).digest('hex');
      
      let vector = null;
      if (cachedVectors[tool.name] && cachedVectors[tool.name].hash === hash) {
        vector = cachedVectors[tool.name].vector; // ক্যাশ থেকে নিলাম
      } else {
        hasChanges = true;
        try {
          const output = await extractor(textToEmbed, { pooling: 'mean', normalize: true });
          vector = Array.from(output.data);
        } catch (_) { continue; }
      }
      
      toolVectors.set(tool.name, { vector, item: tool });
      cacheData[tool.name] = { hash, vector };
    }

    // নতুন ভেক্টর হলে ক্যাশে সেভ করা
    if (hasChanges) {
      try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData), 'utf8');
      } catch (_) {}
    }

    isReady = true;
    console.log(`[Vector Search] Ready with ${toolVectors.size} vectors.`);
  })();

  return initPromise;
}

// ৪. ভেক্টর সার্চ (Race Condition এর জন্য অপেক্ষা করবে)
async function vectorSearch(intent, maxTools = 3, threshold = 0.35) {
  if (!isReady && initPromise) {
    await initPromise; // মডেল লোড হওয়া পর্যন্ত অপেক্ষা করবে
  }
  if (!extractor || toolVectors.size === 0) return [];

  try {
    const queryOutput = await extractor(intent, { pooling: 'mean', normalize: true });
    const queryVec = Array.from(queryOutput.data);

    const scored = [];
    for (const [name, data] of toolVectors) {
      const score = cosineSimilarity(queryVec, data.vector);
      if (score >= threshold) {
        scored.push({ item: data.item, score: score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxTools).map(s => ({ ...s.item, score: s.score }));
  } catch (e) {
    console.error('[Vector Search] Search failed:', e.message);
    return [];
  }
}

module.exports = { buildVectors, vectorSearch };