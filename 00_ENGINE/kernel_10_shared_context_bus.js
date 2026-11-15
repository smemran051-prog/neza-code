'use strict';

/**
 * ============================================================================
 * KERNEL 10 — PART 2 of 7
 * kernel_10_shared_context_bus.js
 * Location: C:\Jarvis_Core\00_ENGINE\kernel_10_shared_context_bus.js
 * Version:  1.0.0-enterprise
 * ============================================================================
 *
 * RESPONSIBILITY
 * --------------
 * Main-process neural context bridge shared by every tab, panel and service
 * in Kernel 10. Provides:
 *
 *   - NeuralContextRingBuffer: bounded, deduplicating, byte-aware ring buffer
 *     storing every context payload (selection, code block, AI response,
 *     table, image ref, relay trace).
 *   - Sanitization pipeline: ANSI strip, secret masking (Groq / OpenAI /
 *     Anthropic / OpenRouter / Google / GitHub / AWS / JWT / Bearer /
 *     password / api-key / credit-card), null-byte strip, CRLF normalize,
 *     metadata sanitization, per-kind truncation, UTF-16-safe truncation.
 *   - Cross-tab prompt broadcaster: injects one prompt into many AI tabs
 *     simultaneously, correlates responses by broadcastId, resolves with
 *     a structured aggregate (complete / partial / timeout).
 *   - AI response collector: broadcasts register themselves as pending;
 *     Part 3 preload + Part 7 IPC pipe responses back in; results are stored
 *     in the ring buffer AND emitted to the caller.
 *   - Controlled relay: pushes a specific context payload into a specific
 *     browser tab's input field (via Part 4 browser_runtime).
 *   - Pub/sub event bus with strict typed events for Part 6 UI progress bars
 *     and Part 7 orchestration.
 *   - Snapshot / restore for session persistence (orchestrator manages the
 *     file path).
 *
 * EXPORTS (used by Part 7 master orchestrator)
 * --------------------------------------------
 *   name
 *   init(ctx)
 *   getBus()                       → SharedContextBus | null
 *   createBus(ctx, opts)           → SharedContextBus  (fresh instance)
 *   SharedContextBus               → class
 *   NeuralContextRingBuffer        → class
 *   sanitizeContext(str, kind, o)  → { sanitized, truncated, redactions,
 *                                       originalLength }
 *   sha256Hex(str)                 → hex string
 *   detectApp(url)                 → 'claude' | 'chatgpt' | ... | 'unknown'
 *   isAITabUrl(url)                → boolean
 *   SECRET_PATTERNS                → array of { name, source, flags }
 *   EVENT_NAMES                    → frozen array of public event names
 *   VALID_KINDS                    → frozen Set of supported context kinds
 *   DEFAULT_CAPACITY
 *   DEFAULT_MAX_TOTAL_BYTES
 *
 * EXPECTED DEPENDENCIES (lazy — resolved at call time, not init time)
 * -------------------------------------------------------------------
 *   ctx.getService('kernel10_browser_runtime') → {
 *     getTabList()                → Promise<BrowserTabDescriptor[]>
 *     getActiveTabInfo()          → Promise<{ id, index, url, count }>
 *     injectPromptToTab(tabId, promptText, opts) →
 *                                    Promise<{ ok, injectedInto?, error? }>
 *   }
 *
 *   These are the ONLY runtime requirements. When the browser runtime is not
 *   yet loaded, bus methods that need it return `{ ok: false, error:
 *   'browser_runtime_unavailable' }` — they never throw.
 *
 * FROZEN-CORE COMPLIANCE
 * ----------------------
 * No edits to kernel.js or preload.js. Only ctx.audit() for logs,
 * ctx.registerService() for discovery, ctx.addStateContributor() for
 * telemetry, ctx.addStopHook() for clean shutdown of pending broadcasts.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// SECTION 0 — CONSTANTS & CONFIG
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const LOG_TAG = 'k10.bus';

// Ring buffer sizing.
const DEFAULT_CAPACITY = 500;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB total memory budget

// Per-kind max content length (in UTF-16 code units, post-sanitize).
const KIND_MAX_LENGTHS = Object.freeze({
  text: 200_000,
  selection: 100_000,
  code: 512_000,
  table: 300_000,
  ai_response: 300_000,
  image: 4_000,           // data URLs are reduced to a marker; URL refs kept as-is
  relay: 200_000,
});

// Absolute max for any single raw incoming payload BEFORE sanitization.
// Protects against pathological pushes.
const MAX_RAW_PAYLOAD_CHARS = 4 * 1024 * 1024; // 4 MB raw

// Metadata is capped to prevent log spam.
const MAX_METADATA_SERIALIZED = 16_384;

// Dedupe window — hashes seen within this window are collapsed.
const DEDUPE_WINDOW_MS = 30_000;

// Broadcast defaults.
const DEFAULT_BROADCAST_TIMEOUT_MS = 60_000;
const MAX_BROADCAST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BROADCAST_TABS = 6;
const MAX_CONCURRENT_BROADCASTS = 8;

// Valid context kinds (frozen so callers can't mutate at runtime).
const VALID_KINDS = Object.freeze(new Set([
  'text',
  'selection',
  'code',
  'table',
  'ai_response',
  'image',
  'relay',
]));

// Public event names (frozen) — subscribers subscribe by these strings only.
const EVENT_NAMES = Object.freeze([
  'context:push',
  'context:deduped',
  'context:cleared',
  'broadcast:started',
  'broadcast:response',
  'broadcast:complete',
  'broadcast:timeout',
  'broadcast:failed',
  'broadcast:shutdown',
  'relay:sent',
  'relay:fail',
]);

// ---------------------------------------------------------------------------
// SECTION 1 — SANITIZATION PATTERNS
// ---------------------------------------------------------------------------
// Every pattern is stored as { name, source, flags } so we can construct a
// FRESH RegExp on each call (avoids lastIndex state poisoning across calls).
// Order matters slightly: longer/more specific tokens first so that a Groq
// key embedded in an OpenAI-shaped token is redacted under the correct name.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = Object.freeze([
  // AI provider tokens.
  { name: 'groq_key',         source: '\\bgsk_[A-Za-z0-9]{20,}\\b',                 flags: 'g' },
  { name: 'openrouter_key',   source: '\\bsk-or-v1-[A-Za-z0-9_-]{20,}\\b',           flags: 'g' },
  { name: 'openai_key',       source: '\\bsk-[A-Za-z0-9_-]{20,}\\b',                 flags: 'g' },
  { name: 'anthropic_key',    source: '\\bsk-ant-[A-Za-z0-9_-]{20,}\\b',             flags: 'g' },
  { name: 'google_api_key',   source: '\\bAIza[0-9A-Za-z_-]{30,}\\b',                flags: 'g' },
  { name: 'cerebras_key',     source: '\\bcsk-[A-Za-z0-9]{20,}\\b',                  flags: 'g' },
  // GitHub.
  { name: 'github_pat_v2',    source: '\\bgithub_pat_[A-Za-z0-9_]{40,}\\b',          flags: 'g' },
  { name: 'github_pat',       source: '\\bghp_[A-Za-z0-9]{30,}\\b',                  flags: 'g' },
  { name: 'github_oauth',     source: '\\bgho_[A-Za-z0-9]{30,}\\b',                  flags: 'g' },
  // AWS.
  { name: 'aws_access_key',   source: '\\bAKIA[0-9A-Z]{16}\\b',                      flags: 'g' },
  // JWT (three-part base64url).
  { name: 'jwt',              source: '\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b', flags: 'g' },
  // Bearer header.
  { name: 'bearer_token',     source: '\\bBearer\\s+[A-Za-z0-9_.\\-]{20,}\\b',        flags: 'gi' },
  // Key=value assignments (broad, but anchored to key names).
  { name: 'password_assign',  source: '(?:password|passwd|pwd)\\s*[:=]\\s*["\']?[^\\s"\']{4,}',   flags: 'gi' },
  { name: 'api_key_assign',   source: '(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token|access[_-]?token)\\s*[:=]\\s*["\']?[^\\s"\']{8,}', flags: 'gi' },
  // Credit card–shaped number (grouped). Anchored to avoid matching long digits in code.
  { name: 'credit_card',      source: '\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b', flags: 'g' },
]);

// ---------------------------------------------------------------------------
// SECTION 2 — UTILITY FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest. Deterministic, used for dedupe and content identity.
 * @param {string} s
 * @returns {string}
 */
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/**
 * Random hex ID (used for entry ids).
 * @param {number} [bytes=6]
 * @returns {string}
 */
function randomHex(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Detect the "app identity" of a URL for tagging and default routing.
 * @param {string} url
 * @returns {string}
 */
function detectApp(url) {
  const u = String(url || '');
  if (!u) return 'unknown';
  if (/claude\.ai/i.test(u)) return 'claude';
  if (/chat\.openai\.com|chatgpt\.com/i.test(u)) return 'chatgpt';
  if (/gemini\.google\.com|bard\.google\.com/i.test(u)) return 'gemini';
  if (/copilot\.microsoft\.com/i.test(u)) return 'copilot';
  if (/perplexity\.ai/i.test(u)) return 'perplexity';
  if (/deepseek\.com/i.test(u)) return 'deepseek';
  if (/grok\.com/i.test(u)) return 'grok';
  if (/docs\.google\.com\/spreadsheets/i.test(u)) return 'sheets';
  if (/mail\.google\.com/i.test(u)) return 'gmail';
  if (/google\.com/i.test(u)) return 'google';
  if (/github\.com/i.test(u)) return 'github';
  if (/youtube\.com/i.test(u)) return 'youtube';
  if (/stackoverflow\.com/i.test(u)) return 'stackoverflow';
  if (/erp/i.test(u)) return 'erp';
  return 'unknown';
}

/**
 * True if a tab URL is an AI provider chat surface where broadcasting /
 * response harvesting is meaningful.
 * @param {string} url
 * @returns {boolean}
 */
function isAITabUrl(url) {
  const app = detectApp(url);
  return app === 'claude' || app === 'chatgpt' || app === 'gemini' ||
         app === 'copilot' || app === 'perplexity' || app === 'deepseek' ||
         app === 'grok';
}

/**
 * UTF-16-safe truncation — never splits a surrogate pair at the boundary.
 * @param {string} s
 * @param {number} maxLen
 * @returns {string}
 */
function safeTruncate(s, maxLen) {
  if (typeof s !== 'string') return '';
  if (s.length <= maxLen) return s;
  let end = maxLen;
  if (end > 0 && end <= s.length) {
    const code = s.charCodeAt(end - 1);
    // If last code unit is a high surrogate, drop it (would break a pair).
    if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  }
  return s.slice(0, Math.max(0, end));
}

/**
 * Strip ANSI SGR / cursor escapes so terminal output stored in tabs
 * doesn't corrupt downstream processing.
 * @param {string} s
 * @returns {string}
 */
function stripAnsi(s) {
  // Broad ANSI / VT100 sequence.
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Deep clone JSON-safe object with prototype pollution guards.
 * @param {any} v
 * @returns {any}
 */
function safeDeepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(safeDeepClone);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = safeDeepClone(val);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SECTION 3 — SANITIZATION PIPELINE
// ---------------------------------------------------------------------------

/**
 * Apply every secret regex to a string, collecting pattern names for audit.
 * @param {string} s
 * @param {string[]} redactions — accumulator
 * @returns {string}
 */
function applySecretPatterns(s, redactions) {
  let out = s;
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.source, p.flags);
    out = out.replace(re, () => {
      if (redactions.length < 20) redactions.push(p.name);
      return `***[MASKED:${p.name}]***`;
    });
  }
  return out;
}

/**
 * Sanitize metadata values recursively with the same secret patterns.
 * Caps depth and size so a malicious tab can't blow up memory.
 * @param {any} obj
 * @param {number} [depth=0]
 * @returns {any}
 */
function sanitizeMetadataValue(obj, depth = 0) {
  if (depth > 5) return '[DEPTH_LIMIT]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    const redactions = [];
    const cleaned = applySecretPatterns(obj, redactions);
    return safeTruncate(cleaned, 2000);
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) {
    return obj.slice(0, 100).map((v) => sanitizeMetadataValue(v, depth + 1));
  }
  if (typeof obj === 'object') {
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (count++ >= 100) break;
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[String(k).slice(0, 100)] = sanitizeMetadataValue(v, depth + 1);
    }
    return out;
  }
  return String(obj).slice(0, 500);
}

/**
 * Sanitize a metadata object (top-level). Caps total serialized size.
 * @param {any} meta
 * @returns {object}
 */
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  try {
    const cloned = safeDeepClone(meta);
    const sanitized = sanitizeMetadataValue(cloned);
    const serialized = JSON.stringify(sanitized);
    if (serialized.length > MAX_METADATA_SERIALIZED) {
      return {
        _truncated: true,
        _originalLength: serialized.length,
      };
    }
    return sanitized;
  } catch (_) {
    return { _error: 'metadata_not_serializable' };
  }
}

/**
 * Sanitize image content — data URLs are reduced to marker metadata so we
 * never store base64 image blobs in the ring buffer.
 * @param {string} content
 * @returns {{ sanitized: string, truncated: boolean, redactions: string[], originalLength: number }}
 */
function sanitizeImageContent(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return { sanitized: '[INVALID_IMAGE]', truncated: false, redactions: [], originalLength: 0 };
  }
  const originalLength = content.length;
  // data URL — extract mime + length only.
  if (content.startsWith('data:')) {
    const m = content.match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s);
    if (m) {
      const mime = m[1] || 'application/octet-stream';
      const dataLen = m[2] ? m[2].length : 0;
      return {
        sanitized: `[IMAGE_DATAURL mime=${mime} base64_len=${dataLen}]`,
        truncated: false,
        redactions: [],
        originalLength,
      };
    }
  }
  // Plain URL reference.
  if (/^https?:\/\//i.test(content)) {
    return {
      sanitized: safeTruncate(content, 2000),
      truncated: content.length > 2000,
      redactions: [],
      originalLength,
    };
  }
  // Unknown shape — safely quote the head of it.
  return {
    sanitized: `[IMAGE_REF ${safeTruncate(content, 200)}]`,
    truncated: content.length > 200,
    redactions: [],
    originalLength,
  };
}

/**
 * Main sanitization entrypoint. Applies redaction, whitespace normalization,
 * and truncation — full pipeline depends on `kind`.
 *
 * @param {string} rawContent
 * @param {string} kind — one of VALID_KINDS
 * @param {object} [opts]
 * @param {number} [opts.maxLength] — override per-kind default
 * @param {boolean} [opts.preserveWhitespace=false] — force code-style handling
 * @returns {{ sanitized: string, truncated: boolean, redactions: string[], originalLength: number }}
 */
function sanitizeContext(rawContent, kind, opts = {}) {
  if (typeof rawContent !== 'string') {
    return { sanitized: '', truncated: false, redactions: [], originalLength: 0 };
  }

  // Image handling diverges — delegate to the image-specific helper.
  if (kind === 'image') {
    return sanitizeImageContent(rawContent);
  }

  const originalLength = rawContent.length;
  const effectiveKind = VALID_KINDS.has(kind) ? kind : 'text';
  const treatAsCode = effectiveKind === 'code' || opts.preserveWhitespace === true;

  let s = rawContent;

  // 1. ANSI strip.
  s = stripAnsi(s);

  // 2. Null bytes strip.
  s = s.replace(/\0/g, '');

  // 3. Secret redaction.
  const redactions = [];
  s = applySecretPatterns(s, redactions);

  // 4. Line ending normalize.
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 5. Whitespace normalisation (kind-aware).
  if (treatAsCode) {
    // Preserve indentation; strip only trailing spaces per line.
    s = s.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
    // Collapse absurd blank-line runs (5+ → 4).
    s = s.replace(/\n{5,}/g, '\n\n\n\n');
  } else {
    // Prose: collapse intra-line space runs, then blanket 3+ blank lines.
    s = s.replace(/[ \t]+/g, ' ');
    s = s.replace(/ *\n */g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
  }

  // 6. Final trim (prose only — code may have meaningful trailing blank).
  if (!treatAsCode) s = s.trim();

  // 7. Truncation.
  const maxLength = Number(opts.maxLength) > 0
    ? Number(opts.maxLength)
    : (KIND_MAX_LENGTHS[effectiveKind] || KIND_MAX_LENGTHS.text);

  let truncated = false;
  if (s.length > maxLength) {
    const origLen = s.length;
    s = safeTruncate(s, maxLength) + `\n\n[... TRUNCATED ${origLen - maxLength} chars ...]`;
    truncated = true;
  }

  return { sanitized: s, truncated, redactions, originalLength };
}

// ---------------------------------------------------------------------------
// SECTION 4 — NEURAL CONTEXT RING BUFFER
// ---------------------------------------------------------------------------
// Bounded, byte-aware, deduplicating. Eviction policy: FIFO by insertion
// order, additionally enforced on total memory budget.
// ---------------------------------------------------------------------------

class NeuralContextRingBuffer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity=500]
   * @param {number} [opts.maxTotalBytes=50MB]
   * @param {number} [opts.dedupeWindowMs=30000]
   */
  constructor(opts = {}) {
    this.capacity = Number(opts.capacity) > 0 ? Number(opts.capacity) : DEFAULT_CAPACITY;
    this.maxTotalBytes = Number(opts.maxTotalBytes) > 0
      ? Number(opts.maxTotalBytes)
      : DEFAULT_MAX_TOTAL_BYTES;
    this.dedupeWindowMs = Number(opts.dedupeWindowMs) > 0
      ? Number(opts.dedupeWindowMs)
      : DEDUPE_WINDOW_MS;

    this._items = [];
    this._hashIndex = new Map(); // hash → entry
    this._idIndex = new Map();   // id → entry
    this._seq = 0;
    this._totalBytes = 0;
    this._dedupeHits = 0;
    this._kindCounts = Object.create(null);
  }

  /**
   * Push a fully-formed entry. Dedupes by hash within the window; evicts
   * oldest entries when capacity or total bytes are exceeded.
   * @param {object} entry
   * @returns {{ ok: boolean, deduped: boolean, entry: object }}
   */
  push(entry) {
    if (!entry || typeof entry !== 'object' || !entry.hash || !entry.id) {
      return { ok: false, deduped: false, entry: null };
    }

    // Dedupe check.
    const existing = this._hashIndex.get(entry.hash);
    if (existing && (entry.timestamp - existing.lastSeenAt) <= this.dedupeWindowMs) {
      existing.lastSeenAt = entry.timestamp;
      existing.hitCount = (existing.hitCount || 1) + 1;
      this._dedupeHits++;
      return { ok: true, deduped: true, entry: existing };
    }

    // Insert.
    entry.seq = ++this._seq;
    entry.hitCount = 1;
    entry.lastSeenAt = entry.timestamp;

    this._items.push(entry);
    this._hashIndex.set(entry.hash, entry);
    this._idIndex.set(entry.id, entry);
    this._totalBytes += (entry.length || 0) * 2; // UTF-16 estimate
    this._kindCounts[entry.kind] = (this._kindCounts[entry.kind] || 0) + 1;

    // Enforce capacity.
    while (this._items.length > this.capacity) this._evictOne();
    // Enforce memory budget.
    while (this._totalBytes > this.maxTotalBytes && this._items.length > 0) this._evictOne();

    return { ok: true, deduped: false, entry };
  }

  /** @private */
  _evictOne() {
    const evicted = this._items.shift();
    if (!evicted) return;
    this._totalBytes -= (evicted.length || 0) * 2;
    this._kindCounts[evicted.kind] = Math.max(0, (this._kindCounts[evicted.kind] || 0) - 1);
    if (this._hashIndex.get(evicted.hash) === evicted) this._hashIndex.delete(evicted.hash);
    if (this._idIndex.get(evicted.id) === evicted) this._idIndex.delete(evicted.id);
  }

  /**
   * @param {number} limit
   * @returns {object[]}
   */
  getRecent(limit) {
    const n = Number(limit) > 0 ? Number(limit) : 50;
    return this._items.slice(-n);
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  getById(id) {
    return this._idIndex.get(id) || null;
  }

  /**
   * @param {string} hash
   * @returns {object|null}
   */
  getByHash(hash) {
    return this._hashIndex.get(hash) || null;
  }

  /**
   * Filter by source tab id, ordered oldest → newest.
   * @param {string} tabId
   * @param {number} [limit]
   * @returns {object[]}
   */
  getBySource(tabId, limit = 50) {
    if (!tabId) return [];
    const out = [];
    for (let i = this._items.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this._items[i];
      if (e.source && e.source.tabId === tabId) out.push(e);
    }
    return out.reverse();
  }

  /** @returns {object[]} full snapshot (shallow copy) */
  getAll() {
    return this._items.slice();
  }

  /** Clear all entries. */
  clear() {
    this._items = [];
    this._hashIndex.clear();
    this._idIndex.clear();
    this._seq = 0;
    this._totalBytes = 0;
    this._dedupeHits = 0;
    this._kindCounts = Object.create(null);
  }

  /** @returns {object} */
  stats() {
    const oldest = this._items[0] || null;
    const newest = this._items[this._items.length - 1] || null;
    return {
      count: this._items.length,
      capacity: this.capacity,
      totalBytes: this._totalBytes,
      maxTotalBytes: this.maxTotalBytes,
      dedupeHits: this._dedupeHits,
      kindCounts: { ...this._kindCounts },
      oldestAt: oldest ? oldest.timestamp : null,
      newestAt: newest ? newest.timestamp : null,
    };
  }

  /**
   * JSON-serializable snapshot for session persistence.
   * @returns {object}
   */
  snapshot() {
    return {
      capturedAt: new Date().toISOString(),
      seq: this._seq,
      items: this._items.slice(),
      kindCounts: { ...this._kindCounts },
      dedupeHits: this._dedupeHits,
    };
  }

  /**
   * Restore from a previous snapshot. Best-effort — skips items that fail
   * validation. Does not throw on malformed input; instead returns a report.
   * @param {object} snap
   * @returns {{ restored: number, skipped: number }}
   */
  restore(snap) {
    if (!snap || typeof snap !== 'object' || !Array.isArray(snap.items)) {
      return { restored: 0, skipped: 0 };
    }
    this.clear();
    let restored = 0;
    let skipped = 0;
    for (const item of snap.items) {
      if (!item || typeof item !== 'object' || !item.hash || !item.id) {
        skipped++;
        continue;
      }
      const res = this.push(item);
      if (res.ok && !res.deduped) restored++;
      else if (!res.ok) skipped++;
    }
    return { restored, skipped };
  }
}

// ---------------------------------------------------------------------------
// SECTION 5 — SHARED CONTEXT BUS
// ---------------------------------------------------------------------------

class SharedContextBus {
  /**
   * @param {object} ctx — kernel context
   * @param {object} [opts]
   * @param {number} [opts.capacity]
   * @param {number} [opts.maxTotalBytes]
   * @param {number} [opts.dedupeWindowMs]
   */
  constructor(ctx, opts = {}) {
    this._ctx = ctx || null;
    this._auditFn = ctx && typeof ctx.audit === 'function' ? ctx.audit.bind(ctx) : null;

    this._ring = new NeuralContextRingBuffer({
      capacity: opts.capacity,
      maxTotalBytes: opts.maxTotalBytes,
      dedupeWindowMs: opts.dedupeWindowMs,
    });

    /** @type {Map<string, PendingBroadcast>} */
    this._pendingBroadcasts = new Map();

    /** @type {Map<string, Set<Function>>} */
    this._subscribers = new Map();

    this._bootedAt = Date.now();
    this._pushCount = 0;
    this._relayCount = 0;
    this._broadcastCount = 0;
    this._closed = false;
  }

  // ── Audit helper ──────────────────────────────────────────────────────

  /** @private */
  _audit(level, event, data) {
    if (typeof this._auditFn !== 'function') return;
    try {
      this._auditFn(level, `${LOG_TAG}.${event}`, data);
    } catch (_) { /* audit must never break the bus */ }
  }

  // ── Event pub/sub ─────────────────────────────────────────────────────

  /**
   * Subscribe to a named event. Returns an unsubscribe function.
   * @param {string} event — must be in EVENT_NAMES
   * @param {(data: any) => void} fn
   * @returns {() => void}
   */
  subscribe(event, fn) {
    if (!EVENT_NAMES.includes(event)) {
      throw new Error(`unknown_event:${event}`);
    }
    if (typeof fn !== 'function') {
      throw new Error('subscriber_must_be_function');
    }
    if (!this._subscribers.has(event)) this._subscribers.set(event, new Set());
    this._subscribers.get(event).add(fn);
    return () => this.unsubscribe(event, fn);
  }

  /**
   * @param {string} event
   * @param {Function} fn
   */
  unsubscribe(event, fn) {
    const set = this._subscribers.get(event);
    if (set) set.delete(fn);
  }

  /**
   * Emit to all subscribers of an event. Subscriber errors are swallowed
   * and audit-logged so one bad listener can't break others.
   * @private
   */
  _emit(event, data) {
    const set = this._subscribers.get(event);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      try { fn(data); }
      catch (e) { this._audit('warn', 'subscriber_error', { event, error: String(e) }); }
    }
  }

  // ── Push / query ──────────────────────────────────────────────────────

  /**
   * Validate + sanitize + store a context payload.
   * @param {object} rawPayload
   * @param {string} rawPayload.kind
   * @param {string} rawPayload.content
   * @param {object} [rawPayload.source] — { tabId, tabIndex, url, title, app }
   * @param {object} [rawPayload.metadata]
   * @returns {{ ok: boolean, deduped?: boolean, entry?: object, error?: string }}
   */
  pushContext(rawPayload) {
    if (this._closed) return { ok: false, error: 'bus_closed' };
    if (!rawPayload || typeof rawPayload !== 'object') {
      return { ok: false, error: 'invalid_payload' };
    }

    const kind = VALID_KINDS.has(rawPayload.kind) ? rawPayload.kind : 'text';
    const content = rawPayload.content;
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, error: 'empty_content' };
    }
    if (content.length > MAX_RAW_PAYLOAD_CHARS) {
      return { ok: false, error: 'payload_too_large' };
    }

    const src = rawPayload.source && typeof rawPayload.source === 'object'
      ? rawPayload.source
      : {};
    const source = {
      tabId: src.tabId != null ? String(src.tabId) : null,
      tabIndex: Number.isInteger(src.tabIndex) ? src.tabIndex : -1,
      url: typeof src.url === 'string' ? safeTruncate(src.url, 4000) : '',
      title: typeof src.title === 'string' ? safeTruncate(src.title, 500) : '',
      app: typeof src.app === 'string' && src.app ? src.app : detectApp(src.url),
    };

    const sanitized = sanitizeContext(content, kind);

    if (!sanitized.sanitized || sanitized.sanitized.length === 0) {
      return { ok: false, error: 'empty_after_sanitize' };
    }

    const hash = sha256Hex(
      `${kind}|${source.tabId || ''}|${sanitized.sanitized}`
    );
    const id = `ctx_${Date.now()}_${randomHex(6)}`;
    const timestamp = Date.now();

    const entry = {
      id,
      source,
      kind,
      // Schema field names — both `content` and `sanitizedContent` are
      // populated with the SAME reference to avoid double memory cost. The
      // raw pre-truncation length is preserved in `originalLength`.
      content: sanitized.sanitized,
      sanitizedContent: sanitized.sanitized,
      length: sanitized.sanitized.length,
      originalLength: sanitized.originalLength,
      truncated: sanitized.truncated,
      redactions: sanitized.redactions,
      hash,
      timestamp,
      metadata: sanitizeMetadata(rawPayload.metadata),
    };

    const res = this._ring.push(entry);
    if (!res.ok) {
      return { ok: false, error: 'ring_push_failed' };
    }

    if (res.deduped) {
      this._emit('context:deduped', {
        id: res.entry.id,
        hash,
        tabId: source.tabId,
        lastSeenAt: res.entry.lastSeenAt,
        hitCount: res.entry.hitCount,
      });
      return { ok: true, deduped: true, entry: res.entry };
    }

    this._pushCount++;
    this._emit('context:push', entry);
    return { ok: true, deduped: false, entry };
  }

  /**
   * Inbound pipe for Part 7: called when Part 3 preload pushes context
   * via IPC. Merges sender metadata into source then delegates to pushContext.
   *
   * @param {object} rawPayload
   * @param {object} [senderMeta] — { tabId, url, title, tabIndex }
   * @returns {{ ok: boolean, deduped?: boolean, entry?: object, error?: string }}
   */
  handleInboundContext(rawPayload, senderMeta = {}) {
    if (!rawPayload || typeof rawPayload !== 'object') {
      return { ok: false, error: 'invalid_payload' };
    }
    const srcIn = rawPayload.source && typeof rawPayload.source === 'object'
      ? rawPayload.source
      : {};

    const source = {
      tabId: srcIn.tabId != null ? srcIn.tabId
            : (rawPayload.tabId != null ? rawPayload.tabId
            : (senderMeta && senderMeta.tabId != null ? senderMeta.tabId : null)),
      tabIndex: srcIn.tabIndex != null ? srcIn.tabIndex
              : (rawPayload.tabIndex != null ? rawPayload.tabIndex
              : (senderMeta && Number.isInteger(senderMeta.tabIndex) ? senderMeta.tabIndex : -1)),
      url: srcIn.url || rawPayload.url || (senderMeta && senderMeta.url) || '',
      title: srcIn.title || rawPayload.title || (senderMeta && senderMeta.title) || '',
      app: srcIn.app || rawPayload.app || detectApp(srcIn.url || rawPayload.url || (senderMeta && senderMeta.url)),
    };

    return this.pushContext({
      kind: rawPayload.kind || 'text',
      content: rawPayload.content,
      source,
      metadata: rawPayload.metadata || {},
    });
  }

  /** @param {number} [limit=50] @returns {object[]} */
  getRecent(limit) { return this._ring.getRecent(limit); }

  /** @param {string} id @returns {object|null} */
  getById(id) { return this._ring.getById(id); }

  /** @param {string} hash @returns {object|null} */
  getByHash(hash) { return this._ring.getByHash(hash); }

  /** @param {string} tabId @param {number} [limit] @returns {object[]} */
  getBySource(tabId, limit) { return this._ring.getBySource(tabId, limit); }

  /** @returns {object[]} */
  getAll() { return this._ring.getAll(); }

  /**
   * Return the most "actionable" recent context, preferring selections
   * over AI responses over generic text — this is what Part 7 feeds to
   * a "apply this to file" or "send to JARVIS" action.
   * @returns {object|null}
   */
  getActiveContext() {
    const recent = this._ring.getRecent(50);
    const priority = ['selection', 'ai_response', 'text', 'code', 'table', 'relay', 'image'];
    for (const kind of priority) {
      for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i].kind === kind) return recent[i];
      }
    }
    return recent.length > 0 ? recent[recent.length - 1] : null;
  }

  /** Clear all stored contexts. */
  clearContexts() {
    this._ring.clear();
    this._emit('context:cleared', { ts: Date.now() });
  }

  // ── Broadcast (cross-tab prompt) ──────────────────────────────────────

  /**
   * Broadcast one prompt to many AI tabs concurrently and collect their
   * responses back into the bus.
   *
   * @param {string} promptText
   * @param {object} [opts]
   * @param {string[]} [opts.targetTabIds]     — explicit selection
   * @param {number[]} [opts.targetTabIndexes] — explicit selection by index
   * @param {number} [opts.expectedResponses]  — defaults to successful injections
   * @param {number} [opts.timeoutMs]          — default 60s, max 300s
   * @param {number} [opts.maxTabs]            — cap concurrent injections (default 6)
   * @returns {Promise<object>} — see `_finalizeBroadcast` for result shape
   */
  async broadcastPrompt(promptText, opts = {}) {
    if (this._closed) return { ok: false, error: 'bus_closed' };
    if (this._pendingBroadcasts.size >= MAX_CONCURRENT_BROADCASTS) {
      return { ok: false, error: 'too_many_concurrent_broadcasts' };
    }

    const text = String(promptText || '').trim();
    if (!text) return { ok: false, error: 'empty_prompt' };

    const runtime = this._ctx && typeof this._ctx.getService === 'function'
      ? this._ctx.getService('kernel10_browser_runtime')
      : null;
    if (!runtime || typeof runtime.getTabList !== 'function' || typeof runtime.injectPromptToTab !== 'function') {
      return { ok: false, error: 'browser_runtime_unavailable' };
    }

    // Resolve target tabs.
    let allTabs;
    try {
      allTabs = await Promise.resolve(runtime.getTabList());
    } catch (e) {
      return { ok: false, error: 'tab_list_failed', detail: String(e) };
    }
    if (!Array.isArray(allTabs) || allTabs.length === 0) {
      return { ok: false, error: 'no_tabs_open' };
    }

    let targetTabs = [];
    if (Array.isArray(opts.targetTabIds) && opts.targetTabIds.length > 0) {
      const idSet = new Set(opts.targetTabIds.map(String));
      targetTabs = allTabs.filter((t) => idSet.has(String(t.id)));
    } else if (Array.isArray(opts.targetTabIndexes) && opts.targetTabIndexes.length > 0) {
      const idxSet = new Set(opts.targetTabIndexes.map(Number));
      targetTabs = allTabs.filter((t) => idxSet.has(Number(t.index)));
    } else {
      // Default: all AI provider tabs.
      targetTabs = allTabs.filter((t) => isAITabUrl(t.url));
    }

    const maxTabs = Number(opts.maxTabs) > 0 ? Number(opts.maxTabs) : DEFAULT_MAX_BROADCAST_TABS;
    targetTabs = targetTabs.slice(0, maxTabs);

    if (targetTabs.length === 0) {
      return { ok: false, error: 'no_target_tabs' };
    }

    const broadcastId = `bc_${Date.now()}_${randomHex(4)}`;
    const timeoutMs = Math.min(
      Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_BROADCAST_TIMEOUT_MS,
      MAX_BROADCAST_TIMEOUT_MS,
    );
    const requestedExpected = Number.isInteger(opts.expectedResponses) && opts.expectedResponses > 0
      ? opts.expectedResponses
      : targetTabs.length;

    /** @type {PendingBroadcast} */
    const pending = {
      broadcastId,
      prompt: text,
      targetTabIds: targetTabs.map((t) => String(t.id)),
      expectedResponses: Math.min(requestedExpected, targetTabs.length),
      responses: [],
      attempted: [],
      createdAt: Date.now(),
      timeoutMs,
      timer: null,
      resolve: null,
    };

    const promise = new Promise((resolve) => {
      pending.resolve = resolve;
      pending.timer = setTimeout(() => {
        this._finalizeBroadcast(broadcastId, 'timeout');
      }, timeoutMs);
    });

    this._pendingBroadcasts.set(broadcastId, pending);
    this._broadcastCount++;
    this._emit('broadcast:started', {
      broadcastId,
      prompt: text,
      targetTabIds: pending.targetTabIds.slice(),
      expected: pending.expectedResponses,
      timeoutMs,
      ts: Date.now(),
    });
    this._audit('info', 'broadcast_started', {
      broadcastId,
      target_count: pending.targetTabIds.length,
      expected: pending.expectedResponses,
    });

    // Fan-out injections. Sequential awaits ensure we can collect failures
    // per-tab without Promise.all bail-out surprises.
    for (const tab of targetTabs) {
      try {
        const res = await Promise.resolve(
          runtime.injectPromptToTab(tab.id, text, { broadcastId, kind: 'broadcast' })
        );
        pending.attempted.push({
          tabId: String(tab.id),
          url: tab.url || '',
          ok: !!(res && res.ok !== false),
          error: res && res.error ? String(res.error) : null,
        });
      } catch (e) {
        pending.attempted.push({
          tabId: String(tab.id),
          url: tab.url || '',
          ok: false,
          error: String(e),
        });
      }
    }

    const successCount = pending.attempted.filter((a) => a.ok).length;
    if (successCount === 0) {
      clearTimeout(pending.timer);
      this._pendingBroadcasts.delete(broadcastId);
      const result = {
        ok: false,
        broadcastId,
        reason: 'all_injections_failed',
        prompt: text,
        attempted: pending.attempted.slice(),
        responses: [],
        elapsedMs: Date.now() - pending.createdAt,
      };
      this._emit('broadcast:failed', result);
      this._audit('warn', 'broadcast_all_injections_failed', { broadcastId });
      pending.resolve(result);
      return promise;
    }

    // Shrink expected to successful injections.
    pending.expectedResponses = Math.min(pending.expectedResponses, successCount);

    return promise;
  }

  /**
   * Inbound pipe for Part 7: called when Part 3 preload sends back a
   * harvested AI response. If `broadcastId` is present, correlates with
   * an active broadcast; otherwise, stores as plain `ai_response` context.
   *
   * @param {object} payload
   * @param {string} [payload.broadcastId]
   * @param {string} payload.tabId
   * @param {string} payload.responseText
   * @param {object} [payload.source]
   * @param {object} [payload.metadata]
   * @returns {{ ok: boolean, contextId?: string, broadcastId?: string, error?: string }}
   */
  handleTabResponse(payload) {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'invalid_payload' };
    }
    const { broadcastId, tabId, responseText } = payload;
    if (typeof responseText !== 'string' || responseText.length === 0) {
      return { ok: false, error: 'empty_response' };
    }

    // No broadcast correlation → store as generic ai_response.
    if (!broadcastId) {
      const res = this.handleInboundContext({
        kind: 'ai_response',
        content: responseText,
        source: payload.source || { tabId, tabIndex: -1, url: '', title: '', app: 'ai' },
        metadata: payload.metadata || {},
      });
      return {
        ok: res.ok,
        contextId: res.entry ? res.entry.id : undefined,
        error: res.error,
      };
    }

    const pending = this._pendingBroadcasts.get(broadcastId);
    if (!pending) {
      // Broadcast already finalized or unknown — still record as context for
      // traceability, tagged with broadcastId + stale marker.
      const res = this.handleInboundContext({
        kind: 'ai_response',
        content: responseText,
        source: payload.source || { tabId, tabIndex: -1, url: '', title: '', app: 'ai' },
        metadata: Object.assign({}, payload.metadata || {}, { broadcastId, stale: true }),
      });
      return {
        ok: res.ok,
        contextId: res.entry ? res.entry.id : undefined,
        broadcastId,
        error: res.ok ? undefined : res.error,
      };
    }

    // Guard against duplicate tab responses.
    if (pending.responses.some((r) => r.tabId === String(tabId))) {
      return { ok: false, error: 'duplicate_response', broadcastId };
    }

    const sanitized = sanitizeContext(responseText, 'ai_response');
    if (!sanitized.sanitized) {
      return { ok: false, error: 'empty_after_sanitize', broadcastId };
    }

    const hash = sha256Hex(`ai_response|${tabId}|${sanitized.sanitized}`);
    const id = `ctx_${Date.now()}_${randomHex(6)}`;
    const timestamp = Date.now();
    const source = payload.source && typeof payload.source === 'object'
      ? {
        tabId: String(payload.source.tabId || tabId || ''),
        tabIndex: Number.isInteger(payload.source.tabIndex) ? payload.source.tabIndex : -1,
        url: String(payload.source.url || ''),
        title: String(payload.source.title || ''),
        app: String(payload.source.app || detectApp(payload.source.url || '')),
      }
      : {
        tabId: String(tabId || ''),
        tabIndex: -1,
        url: '',
        title: '',
        app: 'ai',
      };

    const entry = {
      id,
      source,
      kind: 'ai_response',
      content: sanitized.sanitized,
      sanitizedContent: sanitized.sanitized,
      length: sanitized.sanitized.length,
      originalLength: sanitized.originalLength,
      truncated: sanitized.truncated,
      redactions: sanitized.redactions,
      hash,
      timestamp,
      metadata: sanitizeMetadata(
        Object.assign({}, payload.metadata || {}, { broadcastId })
      ),
    };
    this._ring.push(entry);
    this._pushCount++;

    pending.responses.push({
      tabId: String(tabId || ''),
      url: source.url,
      responseText: sanitized.sanitized,
      contextId: id,
      hash,
      receivedAt: timestamp,
    });

    this._emit('context:push', entry);
    this._emit('broadcast:response', {
      broadcastId,
      tabId: String(tabId || ''),
      contextId: id,
      received: pending.responses.length,
      expected: pending.expectedResponses,
    });

    if (pending.responses.length >= pending.expectedResponses) {
      this._finalizeBroadcast(broadcastId, 'complete');
    }

    return { ok: true, contextId: id, broadcastId };
  }

  /**
   * @private
   * @param {string} broadcastId
   * @param {'complete'|'timeout'|'shutdown'} reason
   */
  _finalizeBroadcast(broadcastId, reason) {
    const pending = this._pendingBroadcasts.get(broadcastId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pendingBroadcasts.delete(broadcastId);

    const result = {
      ok: pending.responses.length > 0,
      broadcastId,
      reason,
      prompt: pending.prompt,
      responses: pending.responses.slice(),
      attempted: pending.attempted.slice(),
      expected: pending.expectedResponses,
      received: pending.responses.length,
      elapsedMs: Date.now() - pending.createdAt,
    };

    const event = `broadcast:${reason}`;
    if (EVENT_NAMES.includes(event)) {
      this._emit(event, result);
    }
    this._audit(reason === 'complete' ? 'info' : 'warn', `broadcast_${reason}`, {
      broadcastId,
      received: result.received,
      expected: result.expected,
      elapsed_ms: result.elapsedMs,
    });

    try { pending.resolve(result); }
    catch (_) { /* resolve must never throw */ }
  }

  /**
   * Cancel a pending broadcast and resolve it with a partial result.
   * @param {string} broadcastId
   * @returns {boolean}
   */
  cancelBroadcast(broadcastId) {
    if (!this._pendingBroadcasts.has(broadcastId)) return false;
    this._finalizeBroadcast(broadcastId, 'shutdown');
    return true;
  }

  // ── Relay (one-way push into a specific tab) ──────────────────────────

  /**
   * Deliver a specific payload into a specific browser tab's input field.
   *
   * @param {object} opts
   * @param {string} [opts.targetTabId]
   * @param {number} [opts.targetTabIndex]
   * @param {string} [opts.payloadText]
   * @param {string} [opts.payloadKind='text'] — 'text'|'code'|'selection'|'relay'
   * @param {string} [opts.prompt] — alias for payloadText
   * @param {object} [opts.metadata]
   * @returns {Promise<{ ok: boolean, relayId?: string, targetTabId?: string,
   *                     contextId?: string, injected?: any, error?: string }>}
   */
  async relayToTab(opts = {}) {
    if (this._closed) return { ok: false, error: 'bus_closed' };

    const runtime = this._ctx && typeof this._ctx.getService === 'function'
      ? this._ctx.getService('kernel10_browser_runtime')
      : null;
    if (!runtime || typeof runtime.getTabList !== 'function') {
      return { ok: false, error: 'browser_runtime_unavailable' };
    }

    let allTabs;
    try {
      allTabs = await Promise.resolve(runtime.getTabList());
    } catch (e) {
      return { ok: false, error: 'tab_list_failed', detail: String(e) };
    }
    if (!Array.isArray(allTabs)) allTabs = [];

    // Resolve target tab.
    let targetTab = null;
    if (opts.targetTabId) {
      targetTab = allTabs.find((t) => String(t.id) === String(opts.targetTabId)) || null;
    } else if (Number.isInteger(opts.targetTabIndex)) {
      targetTab = allTabs.find((t) => Number(t.index) === Number(opts.targetTabIndex)) || null;
    }
    if (!targetTab && typeof runtime.getActiveTabInfo === 'function') {
      try {
        const info = await Promise.resolve(runtime.getActiveTabInfo());
        if (info && info.id != null) {
          targetTab = allTabs.find((t) => String(t.id) === String(info.id)) || null;
        }
      } catch (_) { /* fall through */ }
    }
    if (!targetTab) {
      return { ok: false, error: 'no_target_tab' };
    }

    const text = String(opts.payloadText || opts.prompt || '').trim();
    if (!text) return { ok: false, error: 'empty_payload' };

    const payloadKind = VALID_KINDS.has(opts.payloadKind) ? opts.payloadKind : 'relay';
    const sanitized = sanitizeContext(text, payloadKind, { preserveWhitespace: payloadKind === 'code' });
    if (!sanitized.sanitized) {
      return { ok: false, error: 'empty_after_sanitize' };
    }

    const relayId = `rl_${Date.now()}_${randomHex(4)}`;

    // Store as a relay trace.
    const source = {
      tabId: '__relay__',
      tabIndex: -1,
      url: targetTab.url || '',
      title: targetTab.title || '',
      app: 'relay',
    };
    const entry = {
      id: `ctx_${Date.now()}_${randomHex(6)}`,
      source,
      kind: 'relay',
      content: sanitized.sanitized,
      sanitizedContent: sanitized.sanitized,
      length: sanitized.sanitized.length,
      originalLength: sanitized.originalLength,
      truncated: sanitized.truncated,
      redactions: sanitized.redactions,
      hash: sha256Hex(`relay|${targetTab.id}|${sanitized.sanitized}`),
      timestamp: Date.now(),
      metadata: sanitizeMetadata(
        Object.assign({}, opts.metadata || {}, { relayId, targetTabId: String(targetTab.id) })
      ),
    };
    this._ring.push(entry);
    this._pushCount++;

    // Inject via runtime.
    if (typeof runtime.injectPromptToTab !== 'function') {
      return { ok: false, error: 'runtime_missing_inject' };
    }
    try {
      const injected = await Promise.resolve(
        runtime.injectPromptToTab(targetTab.id, sanitized.sanitized, {
          relayId,
          kind: payloadKind,
          autoSubmit: opts.autoSubmit !== false,
        })
      );
      this._relayCount++;
      this._emit('relay:sent', {
        relayId,
        targetTabId: String(targetTab.id),
        contextId: entry.id,
        ts: Date.now(),
      });
      this._audit('info', 'relay_sent', { relayId, target_tab: String(targetTab.id) });
      return {
        ok: true,
        relayId,
        targetTabId: String(targetTab.id),
        contextId: entry.id,
        injected: injected || null,
      };
    } catch (e) {
      this._emit('relay:fail', {
        relayId,
        targetTabId: String(targetTab.id),
        error: String(e),
        ts: Date.now(),
      });
      this._audit('error', 'relay_failed', { relayId, error: String(e) });
      return { ok: false, error: String(e) };
    }
  }

  // ── Await one-off response from a tab ─────────────────────────────────

  /**
   * Wait for the next `ai_response`-kind context push from a specific tab.
   * Useful for synchronous round-trip relays where the caller wants the AI
   * tab's reply inline.
   *
   * @param {string} tabId
   * @param {object} [opts]
   * @param {string} [opts.kind='ai_response']
   * @param {number} [opts.timeoutMs=30000]
   * @returns {Promise<object>}
   */
  waitForContextFromTab(tabId, opts = {}) {
    const kindFilter = opts.kind || 'ai_response';
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30_000;
    const sinceTs = Date.now();

    return new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
      };
      const onPush = (entry) => {
        if (!entry || !entry.source) return;
        if (String(entry.source.tabId) !== String(tabId)) return;
        if (kindFilter && entry.kind !== kindFilter) return;
        if (entry.timestamp < sinceTs) return;
        cleanup();
        resolve(entry);
      };
      const unsubscribe = this.subscribe('context:push', onPush);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  /** @returns {object} */
  getStats() {
    const ring = this._ring.stats();
    return {
      version: '1.0.0',
      bootedAt: this._bootedAt,
      uptimeMs: Date.now() - this._bootedAt,
      ring,
      pushCount: this._pushCount,
      relayCount: this._relayCount,
      broadcastCount: this._broadcastCount,
      pendingBroadcasts: this._pendingBroadcasts.size,
      subscriberEvents: this._subscribers.size,
      subscriberTotal: Array.from(this._subscribers.values())
        .reduce((acc, set) => acc + set.size, 0),
      closed: this._closed,
    };
  }

  /**
   * Snapshot for persistence (session restoration).
   * @returns {object}
   */
  snapshot() {
    return {
      capturedAt: new Date().toISOString(),
      ring: this._ring.snapshot(),
      counters: {
        pushCount: this._pushCount,
        relayCount: this._relayCount,
        broadcastCount: this._broadcastCount,
      },
    };
  }

  /**
   * Restore from a previous snapshot.
   * @param {object} snap
   * @returns {{ restored: number, skipped: number }}
   */
  restore(snap) {
    if (!snap || typeof snap !== 'object') {
      return { restored: 0, skipped: 0 };
    }
    const ringSnap = snap.ring && typeof snap.ring === 'object' ? snap.ring : snap;
    const res = this._ring.restore(ringSnap);
    if (snap.counters && typeof snap.counters === 'object') {
      if (Number.isInteger(snap.counters.pushCount)) this._pushCount = snap.counters.pushCount;
      if (Number.isInteger(snap.counters.relayCount)) this._relayCount = snap.counters.relayCount;
      if (Number.isInteger(snap.counters.broadcastCount)) this._broadcastCount = snap.counters.broadcastCount;
    }
    this._audit('info', 'restore_complete', res);
    return res;
  }

  /**
   * Clean shutdown — finalizes pending broadcasts as `shutdown`.
   * Safe to call multiple times.
   */
  shutdown() {
    if (this._closed) return;
    this._closed = true;
    for (const broadcastId of Array.from(this._pendingBroadcasts.keys())) {
      try { this._finalizeBroadcast(broadcastId, 'shutdown'); }
      catch (_) { /* ignore */ }
    }
    this._audit('info', 'bus_shutdown', {
      pushes: this._pushCount,
      relays: this._relayCount,
      broadcasts: this._broadcastCount,
    });
  }
}

// ---------------------------------------------------------------------------
// SECTION 6 — MODULE SINGLETON + INIT
// ---------------------------------------------------------------------------

let _busInstance = null;

/**
 * Create a fresh bus (not the singleton) — useful for tests.
 * @param {object} ctx
 * @param {object} [opts]
 * @returns {SharedContextBus}
 */
function createBus(ctx, opts = {}) {
  return new SharedContextBus(ctx, opts);
}

/**
 * Return the module singleton (created by init).
 * @returns {SharedContextBus|null}
 */
function getBus() {
  return _busInstance;
}

/**
 * Module initializer — called by kernel.js via `kernel_10_neural_tab_bridge.js`
 * (Part 7) OR by the master orchestrator directly.
 *
 * @param {object} ctx
 */
function init(ctx) {
  const audit = ctx && typeof ctx.audit === 'function' ? ctx.audit : null;
  const safeAudit = (lvl, ev, data) => {
    if (audit) {
      try { audit(lvl, `${LOG_TAG}.${ev}`, data); } catch (_) {}
    }
  };

  _busInstance = new SharedContextBus(ctx);

  // Register service so Part 1 (STT router), Part 7 (orchestrator), and any
  // future consumer can access the bus without a hard require.
  if (ctx && typeof ctx.registerService === 'function') {
    ctx.registerService('kernel10_shared_context_bus', {
      // Push / query.
      push: (payload) => _busInstance.pushContext(payload),
      pushFromTab: (payload, senderMeta) => _busInstance.handleInboundContext(payload, senderMeta),
      getRecent: (n) => _busInstance.getRecent(n),
      getById: (id) => _busInstance.getById(id),
      getByHash: (hash) => _busInstance.getByHash(hash),
      getBySource: (tabId, n) => _busInstance.getBySource(tabId, n),
      getActiveContext: () => _busInstance.getActiveContext(),
      getAll: () => _busInstance.getAll(),
      clear: () => _busInstance.clearContexts(),

      // Cross-tab.
      broadcastPrompt: (prompt, opts) => _busInstance.broadcastPrompt(prompt, opts),
      handleTabResponse: (payload) => _busInstance.handleTabResponse(payload),
      cancelBroadcast: (id) => _busInstance.cancelBroadcast(id),
      relayToTab: (opts) => _busInstance.relayToTab(opts),
      waitForContextFromTab: (tabId, opts) => _busInstance.waitForContextFromTab(tabId, opts),

      // Pub/sub.
      subscribe: (event, fn) => _busInstance.subscribe(event, fn),
      unsubscribe: (event, fn) => _busInstance.unsubscribe(event, fn),

      // Diagnostics / persistence.
      getStats: () => _busInstance.getStats(),
      snapshot: () => _busInstance.snapshot(),
      restore: (snap) => _busInstance.restore(snap),
      shutdown: () => _busInstance.shutdown(),

      // Utilities exposed to consumers.
      sanitizeContext,
      sha256Hex,
      detectApp,
      isAITabUrl,
      EVENT_NAMES,
      VALID_KINDS,
    });
  }

  // Telemetry contributor.
  if (ctx && typeof ctx.addStateContributor === 'function') {
    ctx.addStateContributor('kernel10_shared_context_bus', () => {
      const s = _busInstance.getStats();
      return {
        version: '1.0.0',
        context_count: s.ring.count,
        context_bytes: s.ring.totalBytes,
        capacity: s.ring.capacity,
        pending_broadcasts: s.pendingBroadcasts,
        push_count: s.pushCount,
        relay_count: s.relayCount,
        broadcast_count: s.broadcastCount,
        dedupe_hits: s.ring.dedupeHits,
      };
    });
  }

  // Clean shutdown of pending broadcasts when the engine stops.
  if (ctx && typeof ctx.addStopHook === 'function') {
    ctx.addStopHook('kernel10_shared_context_bus', () => {
      if (_busInstance) _busInstance.shutdown();
    });
  }

  safeAudit('info', 'bus_initialized', {
    capacity: _busInstance._ring.capacity,
    max_bytes: _busInstance._ring.maxTotalBytes,
  });
}

// ---------------------------------------------------------------------------
// SECTION 7 — EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  name: 'kernel10_shared_context_bus',
  init,
  getBus,
  createBus,

  // Classes.
  SharedContextBus,
  NeuralContextRingBuffer,

  // Utilities (unit-testable).
  sanitizeContext,
  sha256Hex,
  detectApp,
  isAITabUrl,
  safeTruncate,
  stripAnsi,

  // Constants.
  SECRET_PATTERNS,
  EVENT_NAMES,
  VALID_KINDS,
  DEFAULT_CAPACITY,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_BROADCAST_TIMEOUT_MS,
  MAX_BROADCAST_TIMEOUT_MS,
  DEFAULT_MAX_BROADCAST_TABS,
  KIND_MAX_LENGTHS,
};