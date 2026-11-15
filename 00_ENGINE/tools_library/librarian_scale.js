'use strict';

/**
 * librarian_scale.js — Scales kernel_6 to 10,000+ tools
 * Location: 00_ENGINE/tools_library/librarian_scale.js
 *
 * Adds: inverted index, category classifier, LRU cache, delivery contract.
 * kernel_6 imports this; no full rewrite needed.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 100;
const CATEGORY_MIN_MATCHES = 1;

// Auto-derived from tags/description. Extend as library grows.
const CATEGORIES = {
  SYSTEM:   ['system','health','ram','cpu','memory','battery','disk','drive','process','uptime','hardware','status','pc'],
  FILE:     ['file','folder','directory','read','write','delete','search','note','json','metadata','size','trash'],
  NETWORK:  ['network','ping','url','download','fetch','ip','web','http','connection','wifi','internet'],
  INPUT:    ['clipboard','copy','paste','keyboard','mouse','input'],
  MEDIA:    ['screenshot','image','video','sound','beep','toast','notification','audio'],
  APP:      ['launch','close','kill','app','exe','terminate','start','process'],
  CODE:     ['code','compile','build','ast','decompile','script','cli','terminal','daemon','pkg','pyinstaller','gradle'],
  AI:       ['llm','prompt','ai','chat','analysis','advisor','blueprint'],
  DATA:     ['recover','inspect','analyze','metadata','parse','extract','data'],
  UTILITY:  ['math','time','date','log','calculate','expression','clock','now','today'],
};

// In-memory state
const INVERTED = new Map();      // word  -> Set<tool_name>
const CATEGORY_MAP = new Map();  // category -> [tool_name]
const SEARCH_CACHE = new Map();  // intent_key -> { tools, ts }
let ALL_TOOLS = [];              // reference to kernel_6's INDEX_CACHE

// ---------------------------------------------------------------------------
// Tokenizer (reuse kernel_6's logic, extended for Bangla + tags)
// ---------------------------------------------------------------------------
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\u0980-\u09FF\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

// ---------------------------------------------------------------------------
// Category classifier
// ---------------------------------------------------------------------------
function classifyTool(meta) {
  const text = [meta.name || '', meta.description || '', ...(meta.tags || [])]
    .join(' ')
    .toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORIES)) {
    let s = 0;
    for (const w of words) if (text.includes(w)) s++;
    if (s > bestScore) { bestScore = s; best = cat; }
  }
  return bestScore >= CATEGORY_MIN_MATCHES ? best : 'OTHER';
}

// ---------------------------------------------------------------------------
// Build indexes (called once per syncToolsIndex)
// ---------------------------------------------------------------------------
function buildIndexes(entries) {
  ALL_TOOLS = Array.isArray(entries) ? entries : [];
  INVERTED.clear();
  CATEGORY_MAP.clear();

  for (const entry of ALL_TOOLS) {
    if (!entry || !entry.enabled) continue;

    // Category
    const cat = entry.category || classifyTool(entry);
    if (!CATEGORY_MAP.has(cat)) CATEGORY_MAP.set(cat, []);
    CATEGORY_MAP.get(cat).push(entry.name);

    // Words: name tokens + tags + category words
    const words = new Set([
      ...tokenize(entry.name),
      ...(entry.tags || []).map((t) => String(t).toLowerCase().trim()),
    ]);
    for (const w of words) {
      if (!w) continue;
      if (!INVERTED.has(w)) INVERTED.set(w, new Set());
      INVERTED.get(w).add(entry.name);
    }
  }

  invalidateCache();
}

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------
function cacheKey(intent) {
  return String(intent || '').toLowerCase().trim().slice(0, 200);
}

function cacheGet(intent) {
  const k = cacheKey(intent);
  const e = SEARCH_CACHE.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { SEARCH_CACHE.delete(k); return null; }
  // LRU touch
  SEARCH_CACHE.delete(k);
  SEARCH_CACHE.set(k, e);
  return e.tools;
}

function cacheSet(intent, tools) {
  const k = cacheKey(intent);
  SEARCH_CACHE.set(k, { tools, ts: Date.now() });
  while (SEARCH_CACHE.size > CACHE_MAX) {
    SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value);
  }
}

function invalidateCache() {
  SEARCH_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Fast search (inverted index + fallback)
// ---------------------------------------------------------------------------
function fastSearch(intent, maxTools = 3) {
  const cached = cacheGet(intent);
  if (cached) return cached;

  const words = tokenize(intent);
  if (words.length === 0) return [];

  // Collect candidates from inverted index
  const candidates = new Map(); // name -> base score
  for (const w of words) {
    const matches = INVERTED.get(w);
    if (!matches) continue;
    for (const name of matches) {
      candidates.set(name, (candidates.get(name) || 0) + 3);
    }
  }

  // Fallback: if inverted index misses entirely (rare phrasing), do linear scan
  if (candidates.size === 0) {
    return linearScanFallback(intent, maxTools);
  }

  // Score candidates against full intent
  const fullLower = String(intent || '').toLowerCase();
  const toolMap = new Map(ALL_TOOLS.map((t) => [t.name, t]));
  const scored = [];

  for (const [name, base] of candidates) {
    const tool = toolMap.get(name);
    if (!tool || !tool.enabled) continue;

    let score = base;
    const nameLower = name.toLowerCase();
    const descLower = String(tool.description || '').toLowerCase();

    if (fullLower.includes(nameLower)) score += 10;
    for (const w of words) {
      if (descLower.includes(w)) score += 2;
    }

    scored.push({ item: tool, score });
  }

  scored.sort((a, b) =>
    b.score - a.score ||
    String(a.item.description || '').localeCompare(String(b.item.description || ''))
  );

  const result = scored.slice(0, maxTools).map((s) => ({ ...s.item, score: s.score }));
  cacheSet(intent, result);
  return result;
}

function linearScanFallback(intent, maxTools) {
  // Re-use kernel_6's original algorithm as fallback
  const words = tokenize(intent);
  const fullLower = String(intent || '').toLowerCase();
  const scored = [];

  for (const item of ALL_TOOLS) {
    if (!item.enabled) continue;
    let score = 0;
    const nameLower = String(item.name || '').toLowerCase();
    const descLower = String(item.description || '').toLowerCase();
    const tags = Array.isArray(item.tags) ? item.tags : [];

    if (fullLower.includes(nameLower)) score += 12;
    for (const w of words) {
      if (tags.includes(w)) score += 5;
      else if (tags.some((t) => t.includes(w) || w.includes(t))) score += 3;
      if (nameLower.includes(w)) score += 4;
      if (descLower.includes(w)) score += 2;
    }
    if (score > 0) scored.push({ item, score });
  }

  scored.sort((a, b) =>
    b.score - a.score ||
    String(a.item.description || '').localeCompare(String(b.item.description || ''))
  );
  return scored.slice(0, maxTools).map((s) => ({ ...s.item, score: s.score }));
}

// ---------------------------------------------------------------------------
// Delivery contract — what AI gets (max 3 tools, never the library)
// ---------------------------------------------------------------------------
function deliverForAI(intent, options = {}) {
  const maxTools = Math.min(Math.max(1, Number(options.maxTools) || 3), 5);
  const minScore = Number(options.minScore) || 3;

  const tools = fastSearch(intent, maxTools);
  const qualified = tools.filter((t) => t.score >= minScore);

  return {
    ok: true,
    intent: String(intent || '').slice(0, 200),
    total_found: qualified.length,
    tools: qualified.map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      score: t.score,
    })),
    // Contract: NO file paths, NO full library, NO internal ids
  };
}

// ---------------------------------------------------------------------------
// Debouncer (for file watcher — prevents full re-sync on every save)
// ---------------------------------------------------------------------------
class Debouncer {
  constructor(fn, delayMs = 2000) {
    this.fn = fn;
    this.delay = delayMs;
    this.timer = null;
  }
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.fn(); } catch (_) {}
    }, this.delay);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }
  cancel() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

// ---------------------------------------------------------------------------
// Stats (for diagnostics)
// ---------------------------------------------------------------------------
function stats() {
  return {
    total_tools: ALL_TOOLS.length,
    enabled_tools: ALL_TOOLS.filter((t) => t.enabled).length,
    inverted_words: INVERTED.size,
    categories: Object.fromEntries(
      Array.from(CATEGORY_MAP.entries()).map(([k, v]) => [k, v.length])
    ),
    cache_size: SEARCH_CACHE.size,
  };
}

module.exports = {
  buildIndexes,
  fastSearch,
  deliverForAI,
  classifyTool,
  invalidateCache,
  Debouncer,
  stats,
  _internals: { tokenize, CATEGORIES, INVERTED, CATEGORY_MAP },
};