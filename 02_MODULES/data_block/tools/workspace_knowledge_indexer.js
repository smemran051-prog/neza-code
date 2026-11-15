'use strict';

/**
 * JARVIS-CORE Tool: workspace_knowledge_indexer
 * Location : 00_ENGINE/tools/workspace_knowledge_indexer.js
 * Runtime  : Node.js (CommonJS). Built-in modules only: fs, path, crypto.
 *
 * Modes (args.action):
 *   index      - incremental deep scan, saved to work/knowledge_index/workspace_rag_index.json
 *   search     - BM25 + filename + symbol ranked retrieval over the saved index
 *   live_scan  - real-time disk walk of any folder or drive (no index needed)
 *   stats      - index totals, language breakdown, size, timestamps
 *   clear      - remove stale entries (default) or delete the whole index (confirm: true)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME = 'workspace_knowledge_indexer';
const ROOT = path.resolve(process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..'));
const INDEX_DIR = path.join(ROOT, 'work', 'knowledge_index');
const INDEX_FILE = path.join(INDEX_DIR, 'workspace_rag_index.json');
const INDEX_VERSION = 1;

const LIMITS = Object.freeze({
  MAX_FILES_DEFAULT: 3000,
  MAX_FILES_HARD: 5000,
  MAX_CONTENT_BYTES: 2 * 1024 * 1024,
  BINARY_PROBE_BYTES: 8000,
  CHUNK_LINES: 60,
  CHUNK_OVERLAP: 10,
  MAX_CHUNKS_PER_FILE: 400,
  MAX_CHUNKS_TOTAL: 12000,
  MAX_TERMS_PER_CHUNK: 48,
  MAX_SYMBOLS_PER_FILE: 300,
  MAX_TOKEN_LENGTH: 40,
  TOP_K_DEFAULT_SEARCH: 8,
  TOP_K_DEFAULT_LIVE: 20,
  TOP_K_MAX: 50,
  CANDIDATE_MULTIPLIER: 3,
  SNIPPET_MAX_LINES: 40,
  SNIPPET_MAX_CHARS: 1500,
  LIVE_MAX_FILES: 50000,
  LIVE_TIME_BUDGET_MS: 25000,
  LIVE_HITS_PER_FILE: 3,
  BM25_K1: 1.2,
  BM25_B: 0.75,
});

// Heavy / junk / system folders that are never walked (matched case-insensitively).
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build',
  '.idea', '.vscode', 'appdata', '$recycle.bin', 'system volume information',
]);

// Content-indexed text/code extensions.
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.py', '.html', '.css', '.json', '.md', '.txt',
  '.ps1', '.bat', '.sql', '.yaml', '.yml', '.c', '.cpp', '.h',
]);

const LANGUAGE_BY_EXT = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript',
  '.py': 'Python', '.html': 'HTML', '.css': 'CSS', '.json': 'JSON', '.md': 'Markdown',
  '.txt': 'Text', '.ps1': 'PowerShell', '.bat': 'Batch', '.sql': 'SQL', '.yaml': 'YAML',
  '.yml': 'YAML', '.c': 'C', '.cpp': 'C++', '.h': 'C/C++ Header',
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'not', 'but',
  'you', 'your', 'return', 'null', 'true', 'false', 'undefined', 'var', 'let', 'const',
]);

// ---------------------------------------------------------------------------
// Symbol extraction rules (regex based). Group 1 is always the captured name.
// ---------------------------------------------------------------------------
const JS_RULES = [
  { kind: 'function', re: /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g },
  { kind: 'function', re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]{0,200}\)|[A-Za-z_$][\w$]*)\s*=>/g },
  { kind: 'class', re: /\bclass\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'export', re: /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'export', re: /\bexports\.([A-Za-z_$][\w$]*)\s*=/g },
  { kind: 'import', re: /\brequire\(\s*['"]([^'"\n]{1,200})['"]\s*\)/g },
  { kind: 'import', re: /\bimport\s+(?:[^'";\n]{0,200}?\sfrom\s+)?['"]([^'"\n]{1,200})['"]/g },
];

const PY_RULES = [
  { kind: 'function', re: /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm },
  { kind: 'class', re: /^[ \t]*class[ \t]+([A-Za-z_]\w*)/gm },
  { kind: 'import', re: /^[ \t]*from[ \t]+([\w.]+)[ \t]+import\b/gm },
  { kind: 'import', re: /^[ \t]*import[ \t]+([\w.]+)/gm },
];

const PS_RULES = [
  { kind: 'function', re: /^[ \t]*function[ \t]+([A-Za-z_][\w-]*)/gim },
];

const C_RULES = [
  { kind: 'import', re: /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\n]{1,200})[>"]/gm },
  { kind: 'function', re: /^[A-Za-z_][\w \t*&:<>]{0,80}?\b([A-Za-z_]\w*)[ \t]*\([^;{}\n]{0,200}\)[ \t]*\{/gm },
];

const SQL_RULES = [
  { kind: 'class', re: /\bcreate\s+(?:or\s+replace\s+)?(?:table|view|function|procedure)\s+(?:if\s+not\s+exists\s+)?([\w.\[\]"`]+)/gi },
];

const BAT_RULES = [
  { kind: 'function', re: /^[ \t]*:([A-Za-z_][\w-]*)/gm },
];

const MD_RULES = [
  { kind: 'heading', re: /^#{1,3}[ \t]+(.{1,80})$/gm },
];

function rulesFor(ext) {
  switch (ext) {
    case '.js': case '.mjs': case '.cjs': case '.ts': return JS_RULES;
    case '.py': return PY_RULES;
    case '.ps1': return PS_RULES;
    case '.c': case '.cpp': case '.h': return C_RULES;
    case '.sql': return SQL_RULES;
    case '.bat': return BAT_RULES;
    case '.md': return MD_RULES;
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function errCode(err) {
  if (err && err.code) return String(err.code);
  return err && err.message ? String(err.message) : 'UNKNOWN';
}

function fail(action, message, extra) {
  return Object.assign({ ok: false, action, error: message }, extra || {});
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function isBinary(buffer) {
  const n = Math.min(buffer.length, LIMITS.BINARY_PROBE_BYTES);
  return buffer.subarray(0, n).indexOf(0) !== -1;
}

function termFreq(termMap, term) {
  const v = termMap ? termMap[term] : 0;
  return typeof v === 'number' ? v : 0;
}

function normalizeExt(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  return s.startsWith('.') ? s : '.' + s;
}

function normalizeExtensions(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const set = new Set(list.map(normalizeExt).filter(Boolean));
  return set.size > 0 ? set : null;
}

function passesFilter(rec, filter) {
  if (!filter) return true;
  if (filter.startsWith('.')) return rec.ext === filter;
  return rec.ext === '.' + filter || rec.abs.toLowerCase().includes(filter);
}

function sortObjectByValueDesc(obj) {
  const out = {};
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of entries) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Paths and safety
// ---------------------------------------------------------------------------
function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function resolveDir(input) {
  const text = String(input || '').trim();
  if (!text) return { error: 'Empty directory path.' };
  const abs = path.resolve(ROOT, text);
  try {
    if (!fs.statSync(abs).isDirectory()) return { error: `Not a directory: ${abs}` };
  } catch (err) {
    return { error: `Cannot access ${abs} (${errCode(err)})` };
  }
  return { abs };
}

function resolveRoots(raw) {
  let items = [];
  if (Array.isArray(raw)) items = raw;
  else if (raw !== undefined && raw !== null) items = [raw];
  items = items.filter((x) => typeof x === 'string' && x.trim() !== '');
  if (items.length === 0) items = [ROOT];

  const valid = [];
  const errors = [];
  for (const item of items) {
    const r = resolveDir(item);
    if (r.error) errors.push(r.error);
    else if (!valid.includes(r.abs)) valid.push(r.abs);
  }
  // Drop roots that sit inside another root so nothing is walked twice.
  const pruned = valid.filter((dir, i) => !valid.some((other, j) => j !== i && isWithin(dir, other)));
  return { valid: pruned, errors };
}

function isSkippedDirName(name) {
  return SKIP_DIR_NAMES.has(String(name).toLowerCase());
}

function noteError(state, where, err) {
  state.errors++;
  if (state.warnings.length < 20) state.warnings.push(`${errCode(err)} @ ${where}`);
}

// ---------------------------------------------------------------------------
// Audit (best-effort: a logging failure never blocks an operation)
// ---------------------------------------------------------------------------
async function audit(ctx, event) {
  if (!ctx || typeof ctx.audit !== 'function') return;
  try {
    await ctx.audit(Object.assign({ tool: NAME, ts: new Date().toISOString() }, event));
  } catch (err) {
    // ignore logging failure
  }
}

// ---------------------------------------------------------------------------
// Tokenizer, symbols and chunks
// ---------------------------------------------------------------------------
function tokenize(text) {
  if (!text) return [];
  // Split camelCase boundaries, then lowercase and keep letters, digits and combining marks
  // (marks keep Bangla vowel signs inside words).
  const spaced = String(text).replace(/(\p{Ll}|\d)(\p{Lu})/gu, '$1 $2');
  const raw = spaced.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) || [];
  const out = [];
  for (const tok of raw) {
    if (tok.length < 2 || tok.length > LIMITS.MAX_TOKEN_LENGTH || STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function extractSymbols(ext, text) {
  const found = [];
  const seen = new Set();
  const lineStarts = computeLineStarts(text);

  const add = (kind, rawName, index) => {
    if (found.length >= LIMITS.MAX_SYMBOLS_PER_FILE) return;
    const name = String(rawName || '').trim();
    if (!name || name.length > 120) return;
    const key = kind + '\u0000' + name;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ n: name, k: kind, l: lineOf(lineStarts, index) });
  };

  for (const rule of rulesFor(ext)) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      add(rule.kind, m[1], m.index);
      if (found.length >= LIMITS.MAX_SYMBOLS_PER_FILE) return found;
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  if (['.js', '.mjs', '.cjs', '.ts'].includes(ext)) {
    const re = /\bmodule\.exports\s*=\s*\{([^}]{0,4000})\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/[\s:]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(name)) add('export', name, m.index);
      }
    }
  }
  return found;
}

function makeChunk(file, startLine, endLine, tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, LIMITS.MAX_TERMS_PER_CHUNK);
  const t = {};
  for (const [term, n] of top) t[term] = n;
  return { f: file, s: startLine, e: endLine, len: tokens.length, t };
}

function buildChunks(file, lines) {
  const chunks = [];
  const step = LIMITS.CHUNK_LINES - LIMITS.CHUNK_OVERLAP;
  let truncated = false;
  for (let start = 0; start < lines.length; start += step) {
    if (chunks.length >= LIMITS.MAX_CHUNKS_PER_FILE) {
      truncated = true;
      break;
    }
    const end = Math.min(start + LIMITS.CHUNK_LINES, lines.length);
    const tokens = tokenize(lines.slice(start, end).join('\n'));
    if (tokens.length > 0) chunks.push(makeChunk(file, start + 1, end, tokens));
    if (end >= lines.length) break;
  }
  return { chunks, truncated };
}

// ---------------------------------------------------------------------------
// Directory walking (iterative, fault tolerant, symlink-safe)
// ---------------------------------------------------------------------------
function* walkFiles(rootAbs, state) {
  const stack = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      noteError(state, dir, err);
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        state.symlinks++;
        continue;
      }
      if (ent.isDirectory()) {
        if (isSkippedDirName(ent.name)) state.skippedDirs++;
        else stack.push(full);
        continue;
      }
      if (ent.isFile()) {
        yield { abs: full, name: ent.name, ext: path.extname(ent.name).toLowerCase() };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Index file: load, save (atomic), grouping and merge
// ---------------------------------------------------------------------------
function emptyIndex() {
  return { version: INDEX_VERSION, root: ROOT, updatedAt: null, lastRun: null, files: {}, chunks: [] };
}

function loadIndex() {
  let raw;
  try {
    raw = fs.readFileSync(INDEX_FILE, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { exists: false, data: emptyIndex(), warning: null };
    return { exists: false, data: emptyIndex(), warning: `Index unreadable (${errCode(err)})` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== INDEX_VERSION || !parsed.files ||
        typeof parsed.files !== 'object' || !Array.isArray(parsed.chunks)) {
      throw new Error('unexpected index layout or version');
    }
    return { exists: true, data: parsed, warning: null };
  } catch (err) {
    return { exists: false, data: emptyIndex(), warning: `Index corrupted, it will be rebuilt (${err.message})` };
  }
}

function saveIndex(data) {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const tmp = `${INDEX_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    try {
      fs.renameSync(tmp, INDEX_FILE);
    } catch (renameErr) {
      // Windows may refuse to replace an existing file in some states.
      try { fs.unlinkSync(INDEX_FILE); } catch (_) { /* nothing to remove */ }
      fs.renameSync(tmp, INDEX_FILE);
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* temp file may not exist */ }
    throw err;
  }
}

function groupChunksByFile(chunks) {
  const map = new Map();
  for (const c of chunks || []) {
    if (!c || typeof c.f !== 'string') continue;
    let list = map.get(c.f);
    if (!list) {
      list = [];
      map.set(c.f, list);
    }
    list.push(c);
  }
  return map;
}

function summarizeFiles(files) {
  let total = 0;
  let content = 0;
  let symbols = 0;
  for (const rec of Object.values(files)) {
    total++;
    if (rec.contentIndexed) content++;
    symbols += Array.isArray(rec.symbols) ? rec.symbols.length : 0;
  }
  return { files: total, contentFiles: content, symbols };
}

function reuseFile(rec, prev, prevList, newChunks, budget) {
  if (prevList.length > budget.left) {
    rec.skipReason = 'chunk_budget';
    return { rec, status: 'metadata' };
  }
  for (const c of prevList) newChunks.push(c);
  budget.left -= prevList.length;
  rec.sha1 = prev.sha1 || null;
  rec.symbols = Array.isArray(prev.symbols) ? prev.symbols : [];
  rec.chunkCount = prevList.length;
  rec.contentIndexed = true;
  rec.truncated = !!prev.truncated;
  return { rec, status: 'reused' };
}

function processFile(entry, prevFiles, prevChunks, newChunks, budget) {
  const rec = {
    abs: entry.abs,
    rel: displayPath(entry.abs),
    name: entry.name,
    ext: entry.ext,
    size: 0,
    mtimeMs: 0,
    sha1: null,
    contentIndexed: false,
    truncated: false,
    skipReason: null,
    chunkCount: 0,
    symbols: [],
  };

  let st;
  try {
    st = fs.statSync(entry.abs);
  } catch (err) {
    rec.skipReason = `stat_error:${errCode(err)}`;
    return { rec, status: 'error' };
  }
  rec.size = st.size;
  rec.mtimeMs = st.mtimeMs;

  if (!TEXT_EXTENSIONS.has(entry.ext)) {
    rec.skipReason = 'unsupported_type';
    return { rec, status: 'metadata' };
  }
  if (st.size > LIMITS.MAX_CONTENT_BYTES) {
    rec.skipReason = 'too_large';
    return { rec, status: 'metadata' };
  }

  const prev = Object.prototype.hasOwnProperty.call(prevFiles, entry.abs) ? prevFiles[entry.abs] : null;
  const prevList = prevChunks.get(entry.abs) || [];

  // Fast path: size and mtime unchanged, so no need to read the file at all.
  if (prev && prev.contentIndexed && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
    return reuseFile(rec, prev, prevList, newChunks, budget);
  }

  let buf;
  try {
    buf = fs.readFileSync(entry.abs);
  } catch (err) {
    rec.skipReason = `read_error:${errCode(err)}`;
    return { rec, status: 'error' };
  }
  if (isBinary(buf)) {
    rec.skipReason = 'binary';
    return { rec, status: 'metadata' };
  }

  const hash = sha1(buf);
  rec.sha1 = hash;
  // mtime changed but content identical (for example a touch): reuse the old chunks.
  if (prev && prev.contentIndexed && prev.sha1 === hash) {
    return reuseFile(rec, prev, prevList, newChunks, budget);
  }

  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const built = buildChunks(entry.abs, lines);
  if (built.chunks.length > budget.left) {
    rec.skipReason = 'chunk_budget';
    rec.sha1 = null;
    return { rec, status: 'metadata' };
  }

  rec.symbols = extractSymbols(entry.ext, text);
  for (const c of built.chunks) newChunks.push(c);
  budget.left -= built.chunks.length;
  rec.chunkCount = built.chunks.length;
  rec.contentIndexed = true;
  rec.truncated = built.truncated;
  return { rec, status: 'fresh' };
}

function mergeIndex(oldFiles, oldChunks, newFiles, newChunks, scannedRoots, extFilter, capped) {
  const files = {};
  const keptOld = [];
  for (const abs of Object.keys(oldFiles)) {
    if (Object.prototype.hasOwnProperty.call(newFiles, abs)) continue;
    const rec = oldFiles[abs];
    const inScope = scannedRoots.some((root) => isWithin(abs, root)) &&
      (!extFilter || extFilter.has(rec.ext));
    // A full (not capped) scan that did not see this file means it was deleted or is now skipped.
    if (inScope && !capped) continue;
    files[abs] = rec;
    keptOld.push(abs);
  }
  for (const abs of Object.keys(newFiles)) files[abs] = newFiles[abs];

  const chunks = [];
  for (const abs of keptOld) {
    const list = oldChunks.get(abs);
    if (list) for (const c of list) chunks.push(c);
  }
  for (const c of newChunks) chunks.push(c);
  return { files, chunks };
}

// ---------------------------------------------------------------------------
// Mode A: index
// ---------------------------------------------------------------------------
async function runIndex(input, ctx) {
  const started = Date.now();
  const roots = resolveRoots(input.target_dirs);
  if (roots.valid.length === 0) {
    return fail('index', `No valid target directory. ${roots.errors.join(' | ')}`);
  }
  const maxFiles = clampInt(input.max_files, 1, LIMITS.MAX_FILES_HARD, LIMITS.MAX_FILES_DEFAULT);
  const extFilter = normalizeExtensions(input.extensions);

  await audit(ctx, {
    action: 'index',
    phase: 'start',
    roots: roots.valid,
    extensions: extFilter ? [...extFilter] : 'all',
    maxFiles,
  });

  const previous = loadIndex();
  const oldFiles = previous.data.files;
  const oldChunks = groupChunksByFile(previous.data.chunks);
  const state = { visited: 0, errors: 0, symlinks: 0, skippedDirs: 0, warnings: [], capped: false };
  const budget = { left: LIMITS.MAX_CHUNKS_TOTAL };
  const newFiles = {};
  const newChunks = [];
  const counts = { fresh: 0, reused: 0, metadata: 0, error: 0 };
  const skipReasons = {};

  scan:
  for (const root of roots.valid) {
    for (const entry of walkFiles(root, state)) {
      if (extFilter && !extFilter.has(entry.ext)) continue;
      if (isWithin(entry.abs, INDEX_DIR)) continue;
      if (state.visited >= maxFiles) {
        state.capped = true;
        break scan;
      }
      state.visited++;
      const result = processFile(entry, oldFiles, oldChunks, newChunks, budget);
      newFiles[result.rec.abs] = result.rec;
      counts[result.status] = (counts[result.status] || 0) + 1;
      if (result.rec.skipReason) {
        const key = result.rec.skipReason.split(':')[0];
        skipReasons[key] = (skipReasons[key] || 0) + 1;
      }
    }
  }

  const merged = mergeIndex(oldFiles, oldChunks, newFiles, newChunks, roots.valid, extFilter, state.capped);
  const durationMs = Date.now() - started;
  const data = {
    version: INDEX_VERSION,
    root: ROOT,
    updatedAt: new Date().toISOString(),
    lastRun: {
      roots: roots.valid,
      visitedFiles: state.visited,
      capped: state.capped,
      durationMs,
      extensions: extFilter ? [...extFilter] : 'all',
    },
    files: merged.files,
    chunks: merged.chunks,
  };

  try {
    saveIndex(data);
  } catch (err) {
    await audit(ctx, { action: 'index', phase: 'save_failed', error: err.message });
    return fail('index', `Failed to save index: ${err.message}`);
  }

  const totals = summarizeFiles(merged.files);
  await audit(ctx, {
    action: 'index',
    phase: 'done',
    visitedFiles: state.visited,
    freshlyIndexed: counts.fresh,
    reusedUnchanged: counts.reused,
    totalFiles: totals.files,
    totalChunks: merged.chunks.length,
    capped: state.capped,
    durationMs,
  });

  const warnings = [];
  if (previous.warning) warnings.push(previous.warning);
  for (const w of state.warnings) warnings.push(w);

  return {
    ok: true,
    action: 'index',
    indexPath: INDEX_FILE,
    roots: roots.valid,
    rootErrors: roots.errors,
    visitedFiles: state.visited,
    fileCap: maxFiles,
    capped: state.capped,
    freshlyIndexed: counts.fresh,
    reusedUnchanged: counts.reused,
    metadataOnly: counts.metadata,
    errors: state.errors,
    skipped: skipReasons,
    totalFilesInIndex: totals.files,
    totalContentFiles: totals.contentFiles,
    totalChunks: merged.chunks.length,
    totalSymbols: totals.symbols,
    durationMs,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Mode B: search (BM25 + filename + symbol + coverage + phrase scoring)
// ---------------------------------------------------------------------------
function fileNameScore(rec, qSet, qLower, cache) {
  if (cache.has(rec.abs)) return cache.get(rec.abs);
  const base = rec.name.toLowerCase();
  const stem = base.replace(/\.[^.]+$/, '');
  let score = 0;
  if (base === qLower || stem === qLower) {
    score = 12;
  } else if (qLower.length >= 2 && (base.includes(qLower) || stem.includes(qLower))) {
    score = 8;
  } else {
    const nameTokens = new Set(tokenize(rec.name));
    let hits = 0;
    for (const t of qSet) if (nameTokens.has(t)) hits++;
    score = hits * 3;
  }
  cache.set(rec.abs, score);
  return score;
}

function matchingSymbols(rec, qSet, qLower, cache) {
  if (cache.has(rec.abs)) return cache.get(rec.abs);
  const out = [];
  for (const sym of rec.symbols || []) {
    if (!sym || sym.k === 'import') continue;
    let hit = String(sym.n).toLowerCase() === qLower;
    if (!hit) {
      for (const t of tokenize(sym.n)) {
        if (qSet.has(t)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) out.push(sym);
  }
  cache.set(rec.abs, out);
  return out;
}

function readSource(rec, cache) {
  if (cache.has(rec.abs)) return cache.get(rec.abs);
  let result;
  try {
    const st = fs.statSync(rec.abs);
    if (st.size > LIMITS.MAX_CONTENT_BYTES * 2) {
      result = { lines: [], stale: true, missing: true };
    } else {
      const text = fs.readFileSync(rec.abs, 'utf8').replace(/^\uFEFF/, '');
      result = {
        lines: text.split(/\r?\n/),
        stale: st.mtimeMs !== rec.mtimeMs || st.size !== rec.size,
        missing: false,
      };
    }
  } catch (err) {
    result = { lines: [], stale: false, missing: true };
  }
  cache.set(rec.abs, result);
  return result;
}

function buildSnippetFor(rec, chunk, cache) {
  const src = readSource(rec, cache);
  if (src.missing) {
    return { text: '(source file is no longer readable; run index again)', endLine: chunk.e, stale: false, missing: true };
  }
  const lines = src.lines;
  const from = Math.max(1, chunk.s);
  const to = Math.min(lines.length, chunk.e, from + LIMITS.SNIPPET_MAX_LINES - 1);
  let text = from <= lines.length ? lines.slice(from - 1, to).join('\n') : '';
  if (text.length > LIMITS.SNIPPET_MAX_CHARS) {
    text = text.slice(0, LIMITS.SNIPPET_MAX_CHARS) + '\n...';
  }
  return { text, endLine: Math.max(from, to), stale: src.stale, missing: false };
}

function compareItems(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.rec.rel.length - b.rec.rel.length || a.rec.rel.localeCompare(b.rec.rel);
}

async function runSearch(input, ctx) {
  const query = String(input.query || '').trim();
  if (!query) return fail('search', 'search requires a non-empty "query".');
  const topK = clampInt(input.top_k, 1, LIMITS.TOP_K_MAX, LIMITS.TOP_K_DEFAULT_SEARCH);
  const filter = String(input.file_filter || '').trim().toLowerCase();

  let loaded = loadIndex();
  let autoIndexed = false;
  if (!loaded.exists) {
    const built = await runIndex({ target_dirs: [ROOT] }, ctx);
    if (!built.ok) return built;
    loaded = loadIndex();
    autoIndexed = true;
    if (!loaded.exists) return fail('search', 'Index could not be loaded after auto-indexing.');
  }

  const index = loaded.data;
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return fail('search', 'Query has no searchable words after tokenizing.');
  const qSet = new Set(qTokens);
  const qLower = query.toLowerCase();
  const chunks = index.chunks;
  const N = chunks.length;

  // Document frequency and average chunk length for BM25.
  const df = new Map(qTokens.map((t) => [t, 0]));
  let totalLen = 0;
  for (const c of chunks) {
    totalLen += c.len || 0;
    for (const tok of qTokens) {
      if (termFreq(c.t, tok) > 0) df.set(tok, df.get(tok) + 1);
    }
  }
  const avgLen = N > 0 ? (totalLen / N) || 1 : 1;
  const idf = new Map();
  for (const tok of qTokens) {
    const d = df.get(tok);
    idf.set(tok, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  }

  const nameCache = new Map();
  const symCache = new Map();
  const candidates = [];
  const filesWithChunkHit = new Set();

  for (const c of chunks) {
    const rec = index.files[c.f];
    if (!rec || !passesFilter(rec, filter)) continue;

    let bm25 = 0;
    const matchedTerms = [];
    for (const tok of qTokens) {
      const tf = termFreq(c.t, tok);
      if (tf <= 0) continue;
      matchedTerms.push(tok);
      const norm = tf + LIMITS.BM25_K1 * (1 - LIMITS.BM25_B + LIMITS.BM25_B * ((c.len || 0) / avgLen));
      bm25 += idf.get(tok) * ((tf * (LIMITS.BM25_K1 + 1)) / norm);
    }

    const symbols = matchingSymbols(rec, qSet, qLower, symCache).filter((s) => s.l >= c.s && s.l <= c.e);
    if (bm25 <= 0 && symbols.length === 0) continue;

    const nameScore = fileNameScore(rec, qSet, qLower, nameCache);
    const coverage = (matchedTerms.length / qTokens.length) * 3;
    const symScore = Math.min(symbols.length * 4, 12);
    filesWithChunkHit.add(rec.abs);
    candidates.push({
      kind: 'code',
      rec,
      chunk: c,
      score: bm25 + coverage + symScore + nameScore,
      matchedTerms,
      matchedSymbols: [...new Set(symbols.map((s) => s.n))],
    });
  }

  // Files matched only by name (no content hit), including non-indexed binaries.
  const fileItems = [];
  for (const rec of Object.values(index.files)) {
    if (filesWithChunkHit.has(rec.abs) || !passesFilter(rec, filter)) continue;
    const nameScore = fileNameScore(rec, qSet, qLower, nameCache);
    if (nameScore > 0) {
      fileItems.push({ kind: 'file', rec, chunk: null, score: nameScore, matchedTerms: [], matchedSymbols: [] });
    }
  }

  const pool = candidates.concat(fileItems).sort(compareItems);
  const head = pool.slice(0, topK * LIMITS.CANDIDATE_MULTIPLIER);

  // Read snippets only for the shortlist, and reward exact phrase matches.
  const lineCache = new Map();
  for (const item of head) {
    if (item.kind !== 'code') continue;
    const view = buildSnippetFor(item.rec, item.chunk, lineCache);
    item.snippet = view.text;
    item.endLine = view.endLine;
    item.stale = view.stale;
    item.missing = view.missing;
    if (view.text && view.text.toLowerCase().includes(qLower)) item.score += 6;
  }
  head.sort(compareItems);
  const top = head.slice(0, topK);

  const results = top.map((item, i) => {
    if (item.kind === 'file') {
      return {
        rank: i + 1,
        type: 'file',
        file: item.rec.rel,
        path: item.rec.abs,
        startLine: null,
        endLine: null,
        score: round2(item.score),
        matchedBy: 'filename',
        sizeBytes: item.rec.size,
        snippet: '',
      };
    }
    return {
      rank: i + 1,
      type: 'code',
      file: item.rec.rel,
      path: item.rec.abs,
      startLine: item.chunk.s,
      endLine: item.endLine,
      score: round2(item.score),
      matchedTerms: item.matchedTerms,
      matchedSymbols: item.matchedSymbols,
      stale: item.stale,
      sourceMissing: item.missing,
      snippet: item.snippet,
    };
  });

  await audit(ctx, {
    action: 'search',
    topK,
    filter: filter || null,
    candidates: pool.length,
    returned: results.length,
  });

  return {
    ok: true,
    action: 'search',
    query,
    autoIndexed,
    indexUpdatedAt: index.updatedAt,
    indexedFiles: Object.keys(index.files).length,
    candidateCount: pool.length,
    returned: results.length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Mode C: live_scan (no index, real-time walk)
// ---------------------------------------------------------------------------
function scanTextFile(abs, qLower, qTokens) {
  let buf;
  try {
    const st = fs.statSync(abs);
    if (st.size > LIMITS.MAX_CONTENT_BYTES) return [];
    buf = fs.readFileSync(abs);
  } catch (err) {
    return [];
  }
  if (isBinary(buf)) return [];

  const lines = buf.toString('utf8').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length && out.length < LIMITS.LIVE_HITS_PER_FILE; i++) {
    const low = lines[i].toLowerCase();
    const phrase = qLower.length >= 2 && low.includes(qLower);
    const allTokens = qTokens.length > 0 && qTokens.every((t) => low.includes(t));
    if (!phrase && !allTokens) continue;
    const from = Math.max(0, i - 2);
    const to = Math.min(lines.length, i + 3);
    let snippet = lines.slice(from, to).join('\n');
    if (snippet.length > LIMITS.SNIPPET_MAX_CHARS) {
      snippet = snippet.slice(0, LIMITS.SNIPPET_MAX_CHARS) + '\n...';
    }
    out.push({ type: 'text', file: abs, startLine: from + 1, endLine: to, matchedBy: 'content', snippet });
  }
  return out;
}

async function runLiveScan(input, ctx) {
  const query = String(input.query || '').trim();
  if (!query) return fail('live_scan', 'live_scan requires a non-empty "query".');
  if (!input.search_path) return fail('live_scan', 'live_scan requires "search_path" (folder or drive).');
  const dir = resolveDir(input.search_path);
  if (dir.error) return fail('live_scan', dir.error);

  const topK = clampInt(input.top_k, 1, LIMITS.TOP_K_MAX, LIMITS.TOP_K_DEFAULT_LIVE);
  const extension = input.extension ? normalizeExt(input.extension) : '';
  const qLower = query.toLowerCase();
  const qTokens = [...new Set(tokenize(query))];
  const deadline = Date.now() + LIMITS.LIVE_TIME_BUDGET_MS;
  const state = { visited: 0, errors: 0, symlinks: 0, skippedDirs: 0, warnings: [], capped: false };
  const hits = [];
  let timedOut = false;
  let stoppedEarly = false;

  scan:
  for (const entry of walkFiles(dir.abs, state)) {
    if (Date.now() > deadline) {
      timedOut = true;
      break scan;
    }
    if (state.visited >= LIMITS.LIVE_MAX_FILES) {
      state.capped = true;
      break scan;
    }
    if (extension && entry.ext !== extension) continue;
    state.visited++;

    const base = entry.name.toLowerCase();
    const nameHit = (qLower.length >= 2 && base.includes(qLower)) ||
      (qTokens.length > 0 && qTokens.every((t) => base.includes(t)));
    if (nameHit) {
      hits.push({ type: 'file', file: entry.abs, startLine: null, endLine: null, matchedBy: 'filename', snippet: '' });
    }
    if (TEXT_EXTENSIONS.has(entry.ext)) {
      for (const h of scanTextFile(entry.abs, qLower, qTokens)) hits.push(h);
    }
    if (hits.length >= topK) {
      stoppedEarly = true;
      break scan;
    }
  }

  const ordered = hits
    .sort((a, b) => {
      if (a.matchedBy === b.matchedBy) return 0;
      return a.matchedBy === 'filename' ? -1 : 1;
    })
    .slice(0, topK)
    .map((h, i) => Object.assign({ rank: i + 1 }, h));

  await audit(ctx, {
    action: 'live_scan',
    searchPath: dir.abs,
    scannedFiles: state.visited,
    timedOut,
    returned: ordered.length,
  });

  return {
    ok: true,
    action: 'live_scan',
    searchPath: dir.abs,
    query,
    scannedFiles: state.visited,
    timedOut,
    capped: state.capped,
    stoppedEarly,
    errors: state.errors,
    returned: ordered.length,
    results: ordered,
    note: 'Live scan returns the first matches it finds within the time budget; use index + search for ranked results.',
  };
}

// ---------------------------------------------------------------------------
// Mode D: stats
// ---------------------------------------------------------------------------
function runStats() {
  const loaded = loadIndex();
  const base = { ok: true, action: 'stats', indexPath: INDEX_FILE };
  if (!loaded.exists) {
    return Object.assign(base, {
      exists: false,
      message: 'No index yet. Run action "index" first.',
      warning: loaded.warning,
    });
  }

  const idx = loaded.data;
  const byExtension = {};
  const byLanguage = {};
  const skipReasons = {};
  let symbols = 0;
  let contentFiles = 0;
  let metadataOnly = 0;

  for (const rec of Object.values(idx.files)) {
    const ext = rec.ext || '(none)';
    byExtension[ext] = (byExtension[ext] || 0) + 1;

    const lang = LANGUAGE_BY_EXT[ext] || 'Other';
    if (!byLanguage[lang]) byLanguage[lang] = { files: 0, chunks: 0 };
    byLanguage[lang].files++;
    byLanguage[lang].chunks += rec.chunkCount || 0;

    if (rec.contentIndexed) contentFiles++;
    else metadataOnly++;
    symbols += Array.isArray(rec.symbols) ? rec.symbols.length : 0;

    if (rec.skipReason) {
      const key = String(rec.skipReason).split(':')[0];
      skipReasons[key] = (skipReasons[key] || 0) + 1;
    }
  }

  let indexSizeBytes = null;
  try {
    indexSizeBytes = fs.statSync(INDEX_FILE).size;
  } catch (err) {
    indexSizeBytes = null;
  }

  return Object.assign(base, {
    exists: true,
    updatedAt: idx.updatedAt,
    lastRun: idx.lastRun,
    totalFiles: Object.keys(idx.files).length,
    contentIndexedFiles: contentFiles,
    metadataOnlyFiles: metadataOnly,
    totalChunks: idx.chunks.length,
    totalSymbols: symbols,
    byExtension: sortObjectByValueDesc(byExtension),
    byLanguage,
    skipReasons,
    indexSizeBytes,
    indexSize: indexSizeBytes === null ? 'unknown' : formatBytes(indexSizeBytes),
    warning: loaded.warning,
  });
}

// ---------------------------------------------------------------------------
// Mode E: clear (stale entries by default, whole index only with confirm)
// ---------------------------------------------------------------------------
async function runClear(input, ctx) {
  const scope = String(input.scope || 'stale').trim().toLowerCase();
  if (scope !== 'stale' && scope !== 'all') return fail('clear', 'scope must be "stale" or "all".');
  if (scope === 'all' && input.confirm !== true) {
    return fail('clear', 'Deleting the whole index requires "confirm": true.');
  }

  await audit(ctx, { action: 'clear', scope, phase: 'start' });

  if (scope === 'all') {
    try {
      fs.unlinkSync(INDEX_FILE);
    } catch (err) {
      if (errCode(err) !== 'ENOENT') return fail('clear', `Could not delete index: ${errCode(err)}`);
    }
    await audit(ctx, { action: 'clear', scope: 'all', phase: 'done' });
    return { ok: true, action: 'clear', scope: 'all', indexPath: INDEX_FILE, message: 'Index deleted.' };
  }

  const loaded = loadIndex();
  if (!loaded.exists) {
    return { ok: true, action: 'clear', scope: 'stale', message: 'No valid index to clean.', warning: loaded.warning };
  }

  const idx = loaded.data;
  const files = {};
  const staleSet = new Set();
  const report = { removedMissing: 0, invalidatedChanged: 0, kept: 0, unreadable: 0 };

  for (const [abs, rec] of Object.entries(idx.files)) {
    let st;
    try {
      st = fs.statSync(abs);
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        report.removedMissing++;
      } else {
        report.unreadable++;
        files[abs] = rec;
      }
      continue;
    }
    if (rec.contentIndexed && (st.size !== rec.size || st.mtimeMs !== rec.mtimeMs)) {
      files[abs] = Object.assign({}, rec, {
        contentIndexed: false,
        chunkCount: 0,
        symbols: [],
        skipReason: 'needs_reindex',
      });
      staleSet.add(abs);
      report.invalidatedChanged++;
      continue;
    }
    files[abs] = rec;
    report.kept++;
  }

  const chunks = idx.chunks.filter((c) => files[c.f] && !staleSet.has(c.f));
  const updated = Object.assign({}, idx, { updatedAt: new Date().toISOString(), files, chunks });
  try {
    saveIndex(updated);
  } catch (err) {
    return fail('clear', `Failed to save cleaned index: ${err.message}`);
  }

  await audit(ctx, Object.assign({ action: 'clear', scope: 'stale', phase: 'done' }, report));
  return Object.assign(
    { ok: true, action: 'clear', scope: 'stale' },
    report,
    { remainingFiles: Object.keys(files).length, remainingChunks: chunks.length }
  );
}

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------
const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['index', 'search', 'live_scan', 'stats', 'clear'],
      description: 'Which mode to run.',
    },
    target_dirs: {
      description: 'index: folder path or array of folder paths, relative to JARVIS_ROOT or absolute. Defaults to JARVIS_ROOT.',
      anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    extensions: {
      type: 'array',
      items: { type: 'string' },
      description: 'index: optional extension filter, for example [".js", ".py"].',
    },
    max_files: {
      type: 'integer',
      minimum: 1,
      maximum: LIMITS.MAX_FILES_HARD,
      description: `index: maximum files visited per run (default ${LIMITS.MAX_FILES_DEFAULT}).`,
    },
    query: {
      type: 'string',
      description: 'search and live_scan: text to find in file names and contents.',
    },
    top_k: {
      type: 'integer',
      minimum: 1,
      maximum: LIMITS.TOP_K_MAX,
      description: `search: results to return (default ${LIMITS.TOP_K_DEFAULT_SEARCH}). live_scan: default ${LIMITS.TOP_K_DEFAULT_LIVE}.`,
    },
    file_filter: {
      type: 'string',
      description: 'search: extension such as ".py", or a path substring.',
    },
    search_path: {
      type: 'string',
      description: 'live_scan: folder or drive to walk, for example "D:\\\\" or "D:\\\\Projects".',
    },
    extension: {
      type: 'string',
      description: 'live_scan: only walk files with this extension, for example ".py".',
    },
    scope: {
      type: 'string',
      enum: ['stale', 'all'],
      description: 'clear: "stale" (default) removes missing or changed entries; "all" deletes the index and needs confirm.',
    },
    confirm: {
      type: 'boolean',
      description: 'clear with scope "all": must be true.',
    },
  },
  required: ['action'],
};

async function execute(args, ctx) {
  const input = args && typeof args === 'object' ? args : {};
  const action = String(input.action || '').trim().toLowerCase();
  try {
    switch (action) {
      case 'index':
        return await runIndex(input, ctx);
      case 'search':
        return await runSearch(input, ctx);
      case 'live_scan':
        return await runLiveScan(input, ctx);
      case 'stats':
        await audit(ctx, { action: 'stats' });
        return runStats();
      case 'clear':
        return await runClear(input, ctx);
      default:
        return fail(action || 'none', `Unknown action "${action}". Use one of: index, search, live_scan, stats, clear.`);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await audit(ctx, { action, phase: 'error', error: message });
    return fail(action || 'none', `Unexpected error: ${message}`);
  }
}

module.exports = {
  name: NAME,
  description: 'A0. Local RAG workspace knowledge indexer: deep-indexes folders (code, text, symbols and chunks) into a persistent JSON index, searches it with BM25, filename and symbol scoring, live-scans any folder or drive without an index, and reports or cleans index stats. Use it to find old projects, scripts and documents, and to learn existing coding style.',
  tags: ['rag', 'search files', 'knowledge index', 'find code', 'workspace search', 'local memory', 'deep file search', 'index folder'],
  risk: 'WRITE_SAFE',
  parameters: PARAMETERS,
  execute,
};
