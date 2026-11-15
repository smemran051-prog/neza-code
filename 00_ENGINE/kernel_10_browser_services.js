'use strict';

/**
 * ============================================================================
 * KERNEL 10 — PART 5 of 7
 * kernel_10_browser_services.js
 * Location: C:\Jarvis_Core\00_ENGINE\kernel_10_browser_services.js
 * Version:  1.0.0-enterprise
 * ============================================================================
 *
 * RESPONSIBILITY
 * --------------
 * Chrome-Lite services layer that sits on top of kernel_10_browser_runtime
 * (Part 4) and provides every non-runtime browser capability the workspace
 * needs:
 *
 *   1. Browser Context Menu Builder    — data-driven + native Menu renderer
 *   2. Bookmarks Manager               — CRUD, persistence, bar items
 *   3. Browsing History Manager        — JSONL append log + in-memory index
 *   4. Download Manager                — download tracking, pause/resume,
 *                                        open-file, open-folder, persistence
 *   5. Find-in-Page Service            — per-tab state + webContents events
 *   6. Keyboard Shortcut Controller    — Chrome-compatible accelerators
 *   7. Browser Settings Manager        — pinned presets (6 slots), homepage,
 *                                        search engine, download path, theme
 *   8. Closed-Tab Stack                — Ctrl+Shift+T reopen stack (20 entries)
 *   9. Session Restoration extras      — reopen-closed-tab, snapshot rotation
 *
 * Provided service (via ctx.registerService('kernel10_browser_services')):
 *   settings.get() / update(patch) / reset()
 *   settings.getPinnedPresets() / setPinnedPreset(slot, url, title, enabled)
 *   bookmarks.getAll() / add(item) / remove(id) / update(id, patch) / reorder(ids)
 *   bookmarks.getBarItems()
 *   history.recent(limit) / query({ date, search, url, limit }) / clearBefore(ts)
 *   downloads.getActive() / getCompleted() / pause(id) / resume(id) /
 *     cancel(id) / openFile(id) / showInFolder(id) / clearCompleted()
 *   find.start(tabId, query, opts) / next(tabId) / prev(tabId) / stop(tabId) /
 *     getState(tabId)
 *   shortcuts.dispatch(shortcutId, tabId) / getShortcutList() /
 *     setCustomShortcut(shortcutId, accelerator) / resetShortcuts()
 *   contextMenu.build(tabId, params) / showNative(tabId, params, win)
 *   closedTabs.get() / reopen()
 *   emit(event, data) — EventEmitter passthrough
 *   shutdown()
 *
 * Event emitter contract (Part 7 forwards selected events to renderer):
 *   'settings-changed'   { settings }
 *   'bookmark-added'     { bookmark }
 *   'bookmark-removed'   { id }
 *   'bookmarks-updated'  { bookmarks }
 *   'history-appended'   { entry }
 *   'download-started'   { item }
 *   'download-progress'  { id, received, total, state }
 *   'download-complete'  { item }
 *   'download-failed'    { id, state, error }
 *   'find-state-changed' { tabId, state }
 *   'closed-tab-pushed'  { entry }
 *   'closed-tab-reopened'{ tabId }
 *   'services-error'     { where, error }
 *
 * DEPENDENCIES (resolved at init)
 * -------------------------------
 *   ctx.getService('kernel10_browser_runtime')  — REQUIRED (Part 4)
 *   ctx.getService('kernel10_shared_context_bus') — OPTIONAL (Part 2)
 *
 * FROZEN-CORE COMPLIANCE
 * ----------------------
 *   - No edits to kernel.js / preload.js
 *   - ctx.registerService / ctx.addStateContributor / ctx.addStopHook only
 *   - All renderer I/O is via events Parts 6/7 forward themselves
 * ============================================================================
 */

const {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  dialog,
  session,
  shell,
  clipboard,
} = require('electron');

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// SECTION 0 — CONSTANTS & PATHS
// ---------------------------------------------------------------------------

const LOG_TAG = 'k10.services';
const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG', 'kernel10');

const FILES = Object.freeze({
  settings: path.join(CONFIG_DIR, 'browser_settings.json'),
  bookmarks: path.join(CONFIG_DIR, 'bookmarks.json'),
  history: path.join(CONFIG_DIR, 'history.jsonl'),
  downloads: path.join(CONFIG_DIR, 'downloads.json'),
  shortcuts: path.join(CONFIG_DIR, 'shortcuts.json'),
  closedTabs: path.join(CONFIG_DIR, 'closed_tabs.json'),
});

const LIMITS = Object.freeze({
  bookmarks: 5000,
  historyInMemory: 50000,
  historyFileMaxLines: 100000,
  historyQueryDefaultLimit: 100,
  historyQueryMaxLimit: 2000,
  downloadsStored: 500,
  closedTabsStack: 20,
  findDebounceMs: 180,
  downloadProgressEmitMs: 250,
  settingsSaveDebounceMs: 500,
  bookmarksSaveDebounceMs: 400,
  downloadsSaveDebounceMs: 1000,
  closedTabsSaveDebounceMs: 400,
  defaultDownloadMaxConcurrent: 3,
});

const SHORTCUT_DEFAULTS = Object.freeze({
  'new-tab':          { accelerator: 'CommandOrControl+T',      label: 'New Tab' },
  'close-tab':        { accelerator: 'CommandOrControl+W',      label: 'Close Tab' },
  'reopen-closed-tab':{ accelerator: 'CommandOrControl+Shift+T', label: 'Reopen Closed Tab' },
  'next-tab':         { accelerator: 'Control+Tab',             label: 'Next Tab' },
  'prev-tab':         { accelerator: 'Control+Shift+Tab',       label: 'Previous Tab' },
  'focus-omnibox':    { accelerator: 'CommandOrControl+L',      label: 'Focus Address Bar' },
  'reload':           { accelerator: 'CommandOrControl+R',      label: 'Reload' },
  'hard-reload':      { accelerator: 'CommandOrControl+Shift+R', label: 'Hard Reload' },
  'find':             { accelerator: 'CommandOrControl+F',      label: 'Find in Page' },
  'zoom-in':          { accelerator: 'CommandOrControl+Plus',   label: 'Zoom In' },
  'zoom-out':         { accelerator: 'CommandOrControl+-',      label: 'Zoom Out' },
  'zoom-reset':       { accelerator: 'CommandOrControl+0',      label: 'Reset Zoom' },
  'bookmark-page':    { accelerator: 'CommandOrControl+D',      label: 'Bookmark This Page' },
  'open-history':     { accelerator: 'CommandOrControl+H',      label: 'Open History' },
  'open-downloads':   { accelerator: 'CommandOrControl+J',      label: 'Open Downloads' },
  'back':             { accelerator: 'Alt+Left',                label: 'Back' },
  'forward':          { accelerator: 'Alt+Right',               label: 'Forward' },
  'devtools':         { accelerator: 'CommandOrControl+Shift+I', label: 'Toggle DevTools' },
  'view-source':      { accelerator: 'CommandOrControl+U',      label: 'View Page Source' },
  'print':            { accelerator: 'CommandOrControl+P',      label: 'Print Page' },
  'escape':           { accelerator: 'Escape',                  label: 'Stop / Close Find' },
  'pip-toggle':       { accelerator: 'CommandOrControl+Shift+P', label: 'Toggle PiP' },
});

const SETTINGS_DEFAULTS = Object.freeze({
  pinnedPresets: [
    { slot: 1, url: 'https://www.google.com',                  title: 'Google',  enabled: true },
    { slot: 2, url: 'https://claude.ai',                       title: 'Claude',  enabled: true },
    { slot: 3, url: 'https://chat.openai.com',                 title: 'ChatGPT', enabled: true },
    { slot: 4, url: 'https://github.com',                      title: 'GitHub',  enabled: true },
    { slot: 5, url: 'https://docs.google.com/spreadsheets',    title: 'Sheets',  enabled: true },
    { slot: 6, url: 'http://localhost:8080',                   title: 'Local ERP', enabled: true },
  ],
  homepage: 'https://www.google.com',
  searchEngine: 'google',
  downloadsPath: '',
  defaultZoom: 1.0,
  showBookmarksBar: true,
  theme: 'dark',
  lastUpdated: null,
});

const SEARCH_ENGINES = Object.freeze({
  google:     'https://www.google.com/search?q=%s',
  bing:       'https://www.bing.com/search?q=%s',
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  brave:      'https://search.brave.com/search?q=%s',
  yandex:     'https://yandex.com/search/?text=%s',
  chatgpt:    'https://chat.openai.com/?q=%s',
  claude:     'https://claude.ai/new?q=%s',
});

const PERSIST_PARTITION = 'persist:jarvis_workspace';

// ---------------------------------------------------------------------------
// SECTION 1 — UTILITIES
// ---------------------------------------------------------------------------

let _auditFn = null;
function audit(level, event, data) {
  if (typeof _auditFn !== 'function') return;
  try { _auditFn(level, `${LOG_TAG}.${event}`, data); }
  catch (_) { /* audit never throws */ }
}

function ensureDir() {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch (_) {}
}

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    audit('warn', 'read_json_failed', { file: path.basename(file), error: String(e) });
    return fallback;
  }
}

function writeJSON(file, obj) {
  try {
    ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    audit('warn', 'write_json_failed', { file: path.basename(file), error: String(e) });
    return false;
  }
}

function appendJSONL(file, obj) {
  try {
    ensureDir();
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
    return true;
  } catch (e) {
    audit('warn', 'append_jsonl_failed', { file: path.basename(file), error: String(e) });
    return false;
  }
}

function readJSONL(file, maxLines) {
  const out = [];
  try {
    if (!fs.existsSync(file)) return out;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return out;
    const lines = raw.split('\n');
    const start = Math.max(0, lines.length - 1 - (maxLines || 0));
    for (let i = start; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') out.push(obj);
      } catch (_) { /* skip corrupt line */ }
    }
  } catch (e) {
    audit('warn', 'read_jsonl_failed', { file: path.basename(file), error: String(e) });
  }
  return out;
}

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

function debounce(fn, ms) {
  let t = null;
  return function debounced(...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      try { fn.apply(null, args); }
      catch (e) { audit('error', 'debounced_error', { error: String(e) }); }
    }, ms);
  };
}

function throttle(fn, ms) {
  let last = 0;
  let trailing = null;
  return function throttled(...args) {
    const now = Date.now();
    const delta = ms - (now - last);
    if (delta <= 0) {
      last = now;
      try { fn.apply(null, args); } catch (_) {}
      return;
    }
    if (!trailing) {
      trailing = setTimeout(() => {
        trailing = null;
        last = Date.now();
        try { fn.apply(null, args); } catch (_) {}
      }, delta);
    }
  };
}

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  const end = s.charCodeAt(max - 1) >= 0xD800 && s.charCodeAt(max - 1) <= 0xDBFF ? max - 1 : max;
  return s.slice(0, Math.max(0, end));
}

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const t = url.trim();
  if (!t) return '';
  return truncate(t, 4000);
}

function sanitizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return truncate(title.replace(/\s+/g, ' ').trim(), 500);
}

function faviconFor(url) {
  try {
    const u = new URL(url);
    return `${u.origin}/favicon.ico`;
  } catch (_) { return ''; }
}

function timestampISO(ts) {
  try { return new Date(ts).toISOString(); } catch (_) { return ''; }
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// SECTION 2 — BROWSER SETTINGS MANAGER
// ---------------------------------------------------------------------------

class BrowserSettingsManager {
  constructor(emitFn) {
    this._emitFn = emitFn;
    this._settings = null;
    this._saveDebounced = debounce(() => this._save(), LIMITS.settingsSaveDebounceMs);
    this._load();
  }

  _load() {
    const stored = readJSON(FILES.settings, null);
    if (!stored || typeof stored !== 'object') {
      this._settings = this._sanitize(structuredCloneDefault());
      this._save();
      audit('info', 'settings_seeded_defaults', {});
      return;
    }
    this._settings = this._sanitize(stored);
    audit('info', 'settings_loaded', { pinned: this._settings.pinnedPresets.length });
  }

  _sanitize(raw) {
    const base = structuredCloneDefault();
    if (!raw || typeof raw !== 'object') return base;

    // Pinned presets — enforce 6 slots, dedupe slot numbers, sane URLs.
    const slotsSeen = new Set();
    const rawPresets = Array.isArray(raw.pinnedPresets) ? raw.pinnedPresets : [];
    const sanitizedPresets = [];
    for (const p of rawPresets) {
      if (!p || typeof p !== 'object') continue;
      const slot = Number(p.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > 6) continue;
      if (slotsSeen.has(slot)) continue;
      slotsSeen.add(slot);
      sanitizedPresets.push({
        slot,
        url: sanitizeUrl(p.url || ''),
        title: sanitizeTitle(p.title || ''),
        enabled: p.enabled !== false,
      });
    }
    // Fill any missing slots with defaults.
    for (const def of base.pinnedPresets) {
      if (!slotsSeen.has(def.slot)) sanitizedPresets.push({ ...def });
    }
    sanitizedPresets.sort((a, b) => a.slot - b.slot);

    return {
      pinnedPresets: sanitizedPresets,
      homepage: sanitizeUrl(raw.homepage || base.homepage) || base.homepage,
      searchEngine: SEARCH_ENGINES[raw.searchEngine] ? raw.searchEngine : base.searchEngine,
      downloadsPath: typeof raw.downloadsPath === 'string' ? truncate(raw.downloadsPath, 500) : '',
      defaultZoom: Number.isFinite(raw.defaultZoom) ? Math.max(0.25, Math.min(5, raw.defaultZoom)) : 1.0,
      showBookmarksBar: raw.showBookmarksBar !== false,
      theme: typeof raw.theme === 'string' ? truncate(raw.theme, 40) : 'dark',
      lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : null,
    };
  }

  _save() {
    this._settings.lastUpdated = new Date().toISOString();
    writeJSON(FILES.settings, this._settings);
    try { this._emitFn('settings-changed', { settings: this.get() }); } catch (_) {}
  }

  get() {
    return JSON.parse(JSON.stringify(this._settings));
  }

  update(patch) {
    if (!patch || typeof patch !== 'object') return this.get();
    const merged = Object.assign({}, this._settings, patch);
    this._settings = this._sanitize(merged);
    this._saveDebounced();
    return this.get();
  }

  reset() {
    this._settings = this._sanitize(structuredCloneDefault());
    this._save();
    return this.get();
  }

  getPinnedPresets() {
    return this._settings.pinnedPresets.map((p) => ({ ...p }));
  }

  setPinnedPreset(slot, url, title, enabled) {
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 1 || n > 6) return false;
    const presets = this._settings.pinnedPresets.slice();
    const idx = presets.findIndex((p) => p.slot === n);
    if (idx < 0) return false;
    presets[idx] = {
      slot: n,
      url: sanitizeUrl(url || ''),
      title: sanitizeTitle(title || ''),
      enabled: enabled !== false,
    };
    this._settings = this._sanitize(Object.assign({}, this._settings, { pinnedPresets: presets }));
    this._saveDebounced();
    return true;
  }

  /**
   * Convert a query to a search URL using the configured search engine.
   * @param {string} query
   * @returns {string}
   */
  buildSearchUrl(query) {
    const template = SEARCH_ENGINES[this._settings.searchEngine] || SEARCH_ENGINES.google;
    return template.replace('%s', encodeURIComponent(query));
  }

  /**
   * @returns {string}
   */
  getResolvedDownloadsPath() {
    const p = this._settings.downloadsPath;
    if (p && typeof p === 'string') {
      try {
        fs.mkdirSync(p, { recursive: true });
        return p;
      } catch (_) { /* fall through */ }
    }
    try { return app.getPath('downloads'); }
    catch (_) { return path.join(ROOT, 'work', 'downloads'); }
  }
}

function structuredCloneDefault() {
  return {
    pinnedPresets: SETTINGS_DEFAULTS.pinnedPresets.map((p) => ({ ...p })),
    homepage: SETTINGS_DEFAULTS.homepage,
    searchEngine: SETTINGS_DEFAULTS.searchEngine,
    downloadsPath: SETTINGS_DEFAULTS.downloadsPath,
    defaultZoom: SETTINGS_DEFAULTS.defaultZoom,
    showBookmarksBar: SETTINGS_DEFAULTS.showBookmarksBar,
    theme: SETTINGS_DEFAULTS.theme,
    lastUpdated: null,
  };
}

// ---------------------------------------------------------------------------
// SECTION 3 — BOOKMARKS MANAGER
// ---------------------------------------------------------------------------

class BookmarksManager {
  constructor(emitFn) {
    this._emitFn = emitFn;
    this._bookmarks = [];
    this._byId = new Map();
    this._saveDebounced = debounce(() => this._save(), LIMITS.bookmarksSaveDebounceMs);
    this._load();
  }

  _load() {
    const stored = readJSON(FILES.bookmarks, { bookmarks: [] });
    const list = stored && Array.isArray(stored.bookmarks) ? stored.bookmarks : [];
    this._bookmarks = [];
    this._byId.clear();
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      const sanitized = this._sanitizeInput(b, true);
      if (!sanitized) continue;
      this._bookmarks.push(sanitized);
      this._byId.set(sanitized.id, sanitized);
    }
    audit('info', 'bookmarks_loaded', { count: this._bookmarks.length });
  }

  _sanitizeInput(input, isLoad = false) {
    if (!input || typeof input !== 'object') return null;
    const url = sanitizeUrl(input.url || '');
    if (!url) return null;
    const id = typeof input.id === 'string' && input.id.length > 0
      ? truncate(input.id, 120)
      : randomId('bm');
    return {
      id,
      url,
      title: sanitizeTitle(input.title || url),
      favicon: typeof input.favicon === 'string' ? truncate(input.favicon, 4000) : faviconFor(url),
      folder: typeof input.folder === 'string' ? truncate(input.folder, 120) : '',
      createdAt: isLoad && Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
      updatedAt: isLoad && Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
    };
  }

  _save() {
    const payload = { version: 1, savedAt: new Date().toISOString(), bookmarks: this._bookmarks };
    writeJSON(FILES.bookmarks, payload);
    try { this._emitFn('bookmarks-updated', { bookmarks: this.getAll() }); } catch (_) {}
  }

  getAll() { return this._bookmarks.map((b) => ({ ...b })); }

  getBarItems() {
    return this._bookmarks
      .filter((b) => !b.folder || b.folder === 'bar')
      .map((b) => ({ ...b }));
  }

  getById(id) {
    const b = this._byId.get(String(id));
    return b ? { ...b } : null;
  }

  findByUrl(url) {
    const target = sanitizeUrl(url);
    if (!target) return null;
    const b = this._bookmarks.find((x) => x.url === target);
    return b ? { ...b } : null;
  }

  add(input) {
    if (this._bookmarks.length >= LIMITS.bookmarks) {
      audit('warn', 'bookmarks_limit_reached', {});
      return null;
    }
    const sanitized = this._sanitizeInput(input, false);
    if (!sanitized) return null;
    const existing = this.findByUrl(sanitized.url);
    if (existing) {
      this.update(existing.id, { title: sanitized.title, updatedAt: Date.now() });
      return this.getById(existing.id);
    }
    this._bookmarks.push(sanitized);
    this._byId.set(sanitized.id, sanitized);
    this._saveDebounced();
    try { this._emitFn('bookmark-added', { bookmark: { ...sanitized } }); } catch (_) {}
    return { ...sanitized };
  }

  remove(id) {
    const idx = this._bookmarks.findIndex((b) => b.id === String(id));
    if (idx < 0) return false;
    this._bookmarks.splice(idx, 1);
    this._byId.delete(String(id));
    this._saveDebounced();
    try { this._emitFn('bookmark-removed', { id: String(id) }); } catch (_) {}
    return true;
  }

  update(id, patch) {
    const idx = this._bookmarks.findIndex((b) => b.id === String(id));
    if (idx < 0) return null;
    const cur = this._bookmarks[idx];
    const next = {
      ...cur,
      title: patch.title !== undefined ? sanitizeTitle(patch.title) : cur.title,
      url: patch.url !== undefined ? sanitizeUrl(patch.url) || cur.url : cur.url,
      folder: patch.folder !== undefined ? truncate(String(patch.folder || ''), 120) : cur.folder,
      updatedAt: Date.now(),
    };
    this._bookmarks[idx] = next;
    this._byId.set(next.id, next);
    this._saveDebounced();
    try { this._emitFn('bookmarks-updated', { bookmarks: this.getAll() }); } catch (_) {}
    return { ...next };
  }

  reorder(orderedIds) {
    if (!Array.isArray(orderedIds)) return false;
    const byId = new Map(this._bookmarks.map((b) => [b.id, b]));
    const newList = [];
    for (const id of orderedIds) {
      const b = byId.get(String(id));
      if (b) { newList.push(b); byId.delete(String(id)); }
    }
    for (const b of byId.values()) newList.push(b);
    this._bookmarks = newList;
    this._saveDebounced();
    try { this._emitFn('bookmarks-updated', { bookmarks: this.getAll() }); } catch (_) {}
    return true;
  }

  isBookmarked(url) {
    return !!this.findByUrl(url);
  }
}

// ---------------------------------------------------------------------------
// SECTION 4 — BROWSING HISTORY MANAGER
// ---------------------------------------------------------------------------

class HistoryManager {
  constructor(emitFn) {
    this._emitFn = emitFn;
    this._entries = [];
    this._byUrl = new Map();
    this._appendsSinceTrim = 0;
    this._load();
  }

  _load() {
    this._entries = readJSONL(FILES.history, LIMITS.historyInMemory);
    for (const e of this._entries) {
      if (e && e.url) this._byUrl.set(e.url, e);
    }
    audit('info', 'history_loaded', { count: this._entries.length });
  }

  /**
   * Append a visit entry. Dedupes consecutive visits to the same URL within
   * a 3-second window (SPA double-navigation noise).
   * @param {{ url: string, title?: string, favicon?: string }} data
   */
  append(data) {
    if (!data || typeof data !== 'object') return null;
    const url = sanitizeUrl(data.url || '');
    if (!url || url === 'about:blank') return null;

    const last = this._entries[this._entries.length - 1];
    if (last && last.url === url && Date.now() - last.ts < 3000) {
      last.visits = (last.visits || 1) + 1;
      last.ts = Date.now();
      if (data.title) last.title = sanitizeTitle(data.title);
      return null; // no new entry
    }

    const entry = {
      id: randomId('h'),
      url,
      title: sanitizeTitle(data.title || ''),
      favicon: typeof data.favicon === 'string' ? truncate(data.favicon, 4000) : faviconFor(url),
      ts: Date.now(),
      day: dayKey(Date.now()),
      visits: 1,
    };

    this._entries.push(entry);
    this._byUrl.set(url, entry);
    appendJSONL(FILES.history, entry);
    this._appendsSinceTrim++;
    if (this._appendsSinceTrim >= 500) this._trimFileIfNeeded();

    if (this._entries.length > LIMITS.historyInMemory) {
      const overflow = this._entries.length - LIMITS.historyInMemory;
      this._entries.splice(0, overflow);
    }

    try { this._emitFn('history-appended', { entry: { ...entry } }); } catch (_) {}
    return entry;
  }

  _trimFileIfNeeded() {
    this._appendsSinceTrim = 0;
    try {
      if (!fs.existsSync(FILES.history)) return;
      const lines = fs.readFileSync(FILES.history, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= LIMITS.historyFileMaxLines) return;
      const keep = lines.slice(lines.length - LIMITS.historyFileMaxLines);
      const tmp = FILES.history + '.tmp';
      fs.writeFileSync(tmp, keep.join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, FILES.history);
      audit('info', 'history_trimmed', { kept: keep.length });
    } catch (e) {
      audit('warn', 'history_trim_failed', { error: String(e) });
    }
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.day]         — 'YYYY-MM-DD'
   * @param {string} [opts.search]      — substring (url + title, case-insens.)
   * @param {string} [opts.url]         — exact URL match
   * @param {number} [opts.limit]
   * @param {number} [opts.sinceTs]
   * @param {number} [opts.untilTs]
   * @returns {object[]}
   */
  query(opts = {}) {
    const limit = Math.min(
      Number(opts.limit) > 0 ? Number(opts.limit) : LIMITS.historyQueryDefaultLimit,
      LIMITS.historyQueryMaxLimit,
    );
    const search = typeof opts.search === 'string' ? opts.search.toLowerCase().trim() : '';
    const day = typeof opts.day === 'string' ? opts.day : '';
    const url = sanitizeUrl(opts.url || '');
    const sinceTs = Number.isFinite(opts.sinceTs) ? opts.sinceTs : 0;
    const untilTs = Number.isFinite(opts.untilTs) ? opts.untilTs : Infinity;

    const out = [];
    for (let i = this._entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this._entries[i];
      if (day && e.day !== day) continue;
      if (url && e.url !== url) continue;
      if (sinceTs && e.ts < sinceTs) continue;
      if (untilTs !== Infinity && e.ts > untilTs) continue;
      if (search) {
        const hay = (e.url + ' ' + (e.title || '')).toLowerCase();
        if (!hay.includes(search)) continue;
      }
      out.push({ ...e });
    }
    return out;
  }

  recent(limit = 50) { return this.query({ limit }); }

  clearBefore(ts) {
    const cutoff = Number.isFinite(ts) ? ts : Date.now();
    this._entries = this._entries.filter((e) => e.ts >= cutoff);
    this._byUrl.clear();
    for (const e of this._entries) this._byUrl.set(e.url, e);
    try {
      const remaining = this._entries.map((e) => JSON.stringify(e)).join('\n');
      ensureDir();
      const tmp = FILES.history + '.tmp';
      fs.writeFileSync(tmp, remaining ? remaining + '\n' : '', 'utf8');
      fs.renameSync(tmp, FILES.history);
    } catch (e) {
      audit('warn', 'history_clear_failed', { error: String(e) });
    }
    return this._entries.length;
  }

  clearAll() {
    this._entries = [];
    this._byUrl.clear();
    try { fs.writeFileSync(FILES.history, '', 'utf8'); }
    catch (e) { audit('warn', 'history_clear_all_failed', { error: String(e) }); }
    return true;
  }

  /**
   * Group recent history by day for the History panel.
   * @returns {Array<{ day: string, entries: object[] }>}
   */
  groupedByDay(limit = 300) {
    const recent = this.query({ limit });
    const map = new Map();
    for (const e of recent) {
      if (!map.has(e.day)) map.set(e.day, []);
      map.get(e.day).push(e);
    }
    const out = [];
    for (const [day, entries] of map.entries()) {
      out.push({ day, entries });
    }
    out.sort((a, b) => (a.day < b.day ? 1 : -1));
    return out;
  }
}

// ---------------------------------------------------------------------------
// SECTION 5 — DOWNLOAD MANAGER
// ---------------------------------------------------------------------------

class DownloadManager {
  /**
   * @param {object} ctx
   * @param {Function} emitFn
   * @param {BrowserSettingsManager} settingsMgr
   */
  constructor(ctx, emitFn, settingsMgr) {
    this._ctx = ctx;
    this._emitFn = emitFn;
    this._settingsMgr = settingsMgr;

    /** @type {Map<string, DownloadRecord>} */
    this._active = new Map();
    /** @type {DownloadRecord[]} */
    this._completed = [];
    this._saveDebounced = debounce(() => this._save(), LIMITS.downloadsSaveDebounceMs);
    this._progressThrottles = new Map();

    this._loadCompleted();
    this._installSessionHook();
  }

  _loadCompleted() {
    const stored = readJSON(FILES.downloads, { items: [] });
    const items = stored && Array.isArray(stored.items) ? stored.items : [];
    this._completed = items
      .filter((x) => x && typeof x === 'object' && x.id)
      .slice(0, LIMITS.downloadsStored);
    audit('info', 'downloads_loaded', { count: this._completed.length });
  }

  _save() {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      items: this._completed.slice(0, LIMITS.downloadsStored),
    };
    writeJSON(FILES.downloads, payload);
  }

  _installSessionHook() {
    try {
      const ses = session.fromPartition(PERSIST_PARTITION);
      ses.on('will-download', (event, item /* , webContents */) => {
        try { this._handleWillDownload(item); }
        catch (e) { audit('error', 'will_download_handler_failed', { error: String(e) }); }
      });
      audit('info', 'download_hook_installed', {});
    } catch (e) {
      audit('error', 'download_hook_failed', { error: String(e) });
    }
  }

  /**
   * @param {Electron.DownloadItem} item
   */
  _handleWillDownload(item) {
    const id = randomId('dl');
    const downloadsPath = this._settingsMgr.getResolvedDownloadsPath();
    const suggestedName = item.getFilename() || `download_${Date.now()}`;
    const targetPath = path.join(downloadsPath, suggestedName);

    // Set save path (must happen synchronously before item starts writing).
    try { item.setSavePath(targetPath); } catch (_) {}

    const record = {
      id,
      filename: suggestedName,
      savePath: targetPath,
      url: item.getURL(),
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing', // progressing | paused | completed | cancelled | interrupted
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    };

    this._active.set(id, record);
    item.__k10Id = id;

    try { this._emitFn('download-started', { item: { ...record } }); } catch (_) {}

    const throttledProgress = throttle((payload) => {
      try { this._emitFn('download-progress', payload); } catch (_) {}
    }, LIMITS.downloadProgressEmitMs);
    this._progressThrottles.set(id, throttledProgress);

    item.on('updated', (_e, state) => {
      try {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.state = state === 'interrupted' ? 'interrupted' : (item.isPaused() ? 'paused' : 'progressing');
        throttledProgress({
          id,
          received: record.receivedBytes,
          total: record.totalBytes,
          state: record.state,
        });
      } catch (e) {
        audit('warn', 'download_update_failed', { id, error: String(e) });
      }
    });

    item.once('done', (_e, state) => {
      try {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.completedAt = Date.now();
        record.state = state; // 'completed' | 'cancelled' | 'interrupted'
        if (state === 'completed') {
          this._completed.unshift({ ...record });
          if (this._completed.length > LIMITS.downloadsStored) this._completed.pop();
          this._saveDebounced();
          try { this._emitFn('download-complete', { item: { ...record } }); } catch (_) {}
        } else {
          if (state !== 'cancelled') {
            record.error = 'download_' + state;
            try { this._emitFn('download-failed', { id, state, error: record.error }); } catch (_) {}
          }
        }
      } catch (e) {
        audit('error', 'download_done_handler_failed', { id, error: String(e) });
      } finally {
        this._active.delete(id);
        this._progressThrottles.delete(id);
      }
    });
  }

  getActive() {
    return Array.from(this._active.values()).map((r) => ({ ...r }));
  }

  getCompleted() {
    return this._completed.map((r) => ({ ...r }));
  }

  /**
   * @param {string} id
   * @param {'pause'|'resume'|'cancel'} action
   * @returns {boolean}
   */
  _withItem(id, action, fn) {
    const item = this._findItem(id);
    if (!item) return false;
    try { fn(item); }
    catch (e) { audit('warn', `download_${action}_failed`, { id, error: String(e) }); return false; }
    return true;
  }

  _findItem(id) {
    try {
      const ses = session.fromPartition(PERSIST_PARTITION);
      // Electron does not expose a global list of in-flight items —
      // access the underlying item via the internal Active set by
      // scanning the current DownloadItems (workaround via will-download
      // cache we maintain in _active).
      // Since we stored the item reference on the record's __item, use that.
      const rec = this._active.get(id);
      if (rec && rec.__item) return rec.__item;
      // Fallback: keep an item reference on the record.
      return rec && rec.itemRef ? rec.itemRef : null;
    } catch (_) {
      return null;
    }
  }

  pause(id) {
    return this._withItem(id, 'pause', (item) => {
      if (!item.isPaused()) item.pause();
    });
  }

  resume(id) {
    return this._withItem(id, 'resume', (item) => {
      if (item.canResume()) item.resume();
    });
  }

  cancel(id) {
    return this._withItem(id, 'cancel', (item) => {
      item.cancel();
    });
  }

  openFile(id) {
    const rec = this._completed.find((r) => r.id === id);
    if (!rec) return false;
    shell.openPath(rec.savePath).catch((e) => audit('warn', 'open_file_failed', { id, error: String(e) }));
    return true;
  }

  showInFolder(id) {
    const rec = this._completed.find((r) => r.id === id);
    if (!rec) return false;
    try { shell.showItemInFolder(rec.savePath); return true; }
    catch (_) { return false; }
  }

  clearCompleted() {
    this._completed = [];
    this._saveDebounced();
    return true;
  }

  shutdown() {
    // Best-effort: pause any active downloads; they will be resumed from
    // scratch on next boot by the browser itself if the user retries.
    for (const id of Array.from(this._active.keys())) {
      try { this.cancel(id); } catch (_) {}
    }
    this._active.clear();
    this._save();
  }
}

// ---------------------------------------------------------------------------
// SECTION 6 — FIND-IN-PAGE SERVICE
// ---------------------------------------------------------------------------

class FindInPageService {
  constructor(emitFn, runtime) {
    this._emitFn = emitFn;
    this._runtime = runtime;

    // tabId → { query, matches, activeMatch, running, matchCase, lastQuery, debouncedStart }
    /** @type {Map<string, object>} */
    this._state = new Map();
    /** @type {Map<string, Function>} */
    this._handlers = new Map();

    this._attachToRuntime();
  }

  _attachToRuntime() {
    if (!this._runtime || typeof this._runtime.on !== 'function') return;

    this._runtime.on('tab-created', ({ tabId, webContents }) => {
      try { this._attachHandlers(tabId, webContents); }
      catch (e) { audit('error', 'find_attach_failed', { tabId, error: String(e) }); }
    });

    this._runtime.on('tab-destroyed', ({ tabId }) => {
      this._state.delete(tabId);
      this._handlers.delete(tabId);
    });
  }

  _attachHandlers(tabId, webContents) {
    if (!webContents) return;
    if (this._handlers.has(tabId)) return;

    const onFound = (_e, result) => {
      try { this._onFoundInPage(tabId, result); }
      catch (err) { audit('warn', 'found_in_page_handler_error', { tabId, error: String(err) }); }
    };
    try { webContents.on('found-in-page', onFound); }
    catch (e) { audit('warn', 'attach_find_listener_failed', { tabId, error: String(e) }); }

    this._handlers.set(tabId, () => {
      try { webContents.removeListener('found-in-page', onFound); }
      catch (_) {}
    });
  }

  _onFoundInPage(tabId, result) {
    const s = this._state.get(tabId);
    if (!s) return;
    s.matches = Number(result.matches) || 0;
    s.activeMatch = Number(result.activeMatchOrdinal) || 0;
    s.running = !!result.finalUpdate;
    s.finalUpdate = !!result.finalUpdate;

    try { this._emitFn('find-state-changed', { tabId, state: this.getState(tabId) }); }
    catch (_) {}
  }

  /**
   * @param {string} tabId
   * @param {string} query
   * @param {object} [opts]
   * @param {boolean} [opts.findNext]
   * @param {boolean} [opts.forward]
   * @param {boolean} [opts.matchCase]
   */
  start(tabId, query, opts = {}) {
    if (!tabId) return false;
    if (typeof query !== 'string') return false;

    let s = this._state.get(tabId);
    if (!s) {
      s = { query: '', matches: 0, activeMatch: 0, running: false, matchCase: false, finalUpdate: false };
      this._state.set(tabId, s);
    }

    s.query = truncate(query, 500);
    s.matchCase = !!opts.matchCase;
    s.running = true;
    s.finalUpdate = false;

    if (!s.query) {
      this.stop(tabId);
      return true;
    }

    try {
      this._runtime.findInPage(tabId, s.query, {
        forward: opts.forward !== false,
        findNext: !!opts.findNext,
        matchCase: s.matchCase,
      });
    } catch (e) {
      audit('warn', 'find_start_failed', { tabId, error: String(e) });
      s.running = false;
      return false;
    }

    try { this._emitFn('find-state-changed', { tabId, state: this.getState(tabId) }); }
    catch (_) {}
    return true;
  }

  next(tabId) {
    const s = this._state.get(tabId);
    if (!s || !s.query) return false;
    return this.start(tabId, s.query, { findNext: true, forward: true, matchCase: s.matchCase });
  }

  prev(tabId) {
    const s = this._state.get(tabId);
    if (!s || !s.query) return false;
    return this.start(tabId, s.query, { findNext: true, forward: false, matchCase: s.matchCase });
  }

  stop(tabId) {
    const s = this._state.get(tabId);
    if (s) {
      s.running = false;
      s.query = '';
      s.matches = 0;
      s.activeMatch = 0;
      s.finalUpdate = false;
    }
    try { this._runtime.stopFindInPage(tabId, 'clearSelection'); }
    catch (_) {}
    try { this._emitFn('find-state-changed', { tabId, state: this.getState(tabId) }); }
    catch (_) {}
    return true;
  }

  getState(tabId) {
    const s = this._state.get(tabId);
    if (!s) return { tabId, query: '', matches: 0, activeMatch: 0, running: false, matchCase: false };
    return { tabId, ...s };
  }

  shutdown() {
    for (const unsub of this._handlers.values()) { try { unsub(); } catch (_) {} }
    this._handlers.clear();
    this._state.clear();
  }
}

// ---------------------------------------------------------------------------
// SECTION 7 — CONTEXT MENU BUILDER
// ---------------------------------------------------------------------------
// Produces a data-driven MenuItemDescriptor[] so Part 6 can render a fully
// styled dark HTML menu. Also provides showNative() for cases where a native
// OS menu is preferred (e.g. DevTools workflows).
//
// MenuItemDescriptor shape:
//   { id, label, type: 'normal'|'separator'|'checkbox', enabled, checked,
//     accelerator?, action: { kind, payload? } }
//   kind ∈ 'runtime'|'system'|'jarvis'|'shell'|'clipboard'|'devtools'|'url'
// ---------------------------------------------------------------------------

class ContextMenuBuilder {
  /**
   * @param {object} ctx
   * @param {DownloadManager} downloads
   * @param {BookmarksManager} bookmarks
   * @param {FindInPageService} find
   */
  constructor(ctx, downloads, bookmarks, find) {
    this._ctx = ctx;
    this._downloads = downloads;
    this._bookmarks = bookmarks;
    this._find = find;
  }

  /**
   * Build the menu descriptor array for a given tab + context-menu event.
   * @param {string} tabId
   * @param {Electron.ContextMenuParams} params
   * @returns {Array<object>}
   */
  build(tabId, params) {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    const tab = runtime && typeof runtime.getTab === 'function' ? runtime.getTab(tabId) : null;

    const items = [];
    const p = params || {};

    // ── Link actions ───────────────────────────────────────────────────
    if (p.linkURL) {
      items.push({
        id: 'open-link-new-tab',
        label: 'Open Link in New Tab',
        type: 'normal',
        enabled: true,
        action: { kind: 'url', payload: { url: p.linkURL, target: 'tab' } },
      });
      items.push({
        id: 'open-link-new-window',
        label: 'Open Link in New Window',
        type: 'normal',
        enabled: true,
        action: { kind: 'url', payload: { url: p.linkURL, target: 'window' } },
      });
      items.push({
        id: 'open-link-pip',
        label: 'Open Link in Picture-in-Picture',
        type: 'normal',
        enabled: true,
        action: { kind: 'url', payload: { url: p.linkURL, target: 'pip' } },
      });
      items.push({
        id: 'copy-link',
        label: 'Copy Link Address',
        type: 'normal',
        enabled: true,
        action: { kind: 'clipboard', payload: { text: p.linkURL } },
      });
      items.push({
        id: 'save-link',
        label: 'Save Link As…',
        type: 'normal',
        enabled: true,
        action: { kind: 'shell', payload: { action: 'save-link', url: p.linkURL } },
      });
      items.push({ id: 'sep-link', type: 'separator' });
    }

    // ── Image actions ──────────────────────────────────────────────────
    if (p.mediaType === 'image' && p.srcURL) {
      items.push({
        id: 'copy-image',
        label: 'Copy Image',
        type: 'normal',
        enabled: true,
        action: { kind: 'system', payload: { action: 'copy-image', srcUrl: p.srcURL } },
      });
      items.push({
        id: 'copy-image-address',
        label: 'Copy Image Address',
        type: 'normal',
        enabled: true,
        action: { kind: 'clipboard', payload: { text: p.srcURL } },
      });
      items.push({
        id: 'save-image',
        label: 'Save Image As…',
        type: 'normal',
        enabled: true,
        action: { kind: 'shell', payload: { action: 'save-image', url: p.srcURL } },
      });
      items.push({
        id: 'open-image-new-tab',
        label: 'Open Image in New Tab',
        type: 'normal',
        enabled: true,
        action: { kind: 'url', payload: { url: p.srcURL, target: 'tab' } },
      });
      items.push({ id: 'sep-image', type: 'separator' });
    }

    // ── Selection actions ──────────────────────────────────────────────
    const sel = typeof p.selectionText === 'string' ? p.selectionText.trim() : '';
    if (sel.length >= 3) {
      const engine = this._getSearchEngineName();
      items.push({
        id: 'search-selection',
        label: `Search ${engine.charAt(0).toUpperCase() + engine.slice(1)} for "${truncate(sel, 32)}${sel.length > 32 ? '…' : ''}"`,
        type: 'normal',
        enabled: true,
        action: { kind: 'system', payload: { action: 'search-selection', text: sel } },
      });
      items.push({
        id: 'copy-selection',
        label: 'Copy Selection',
        type: 'normal',
        enabled: true,
        action: { kind: 'clipboard', payload: { text: sel } },
      });
      items.push({
        id: 'send-selection-jarvis',
        label: '⚡ Send Selection to JARVIS',
        type: 'normal',
        enabled: true,
        action: { kind: 'jarvis', payload: { action: 'send-selection', text: sel, tabId } },
      });
      items.push({ id: 'sep-selection', type: 'separator' });
    }

    // ── Editable actions ───────────────────────────────────────────────
    if (p.isEditable) {
      items.push({
        id: 'undo',
        label: 'Undo',
        type: 'normal',
        enabled: !!p.editFlags?.canUndo,
        action: { kind: 'system', payload: { action: 'undo' } },
      });
      items.push({
        id: 'redo',
        label: 'Redo',
        type: 'normal',
        enabled: !!p.editFlags?.canRedo,
        action: { kind: 'system', payload: { action: 'redo' } },
      });
      items.push({
        id: 'cut',
        label: 'Cut',
        type: 'normal',
        enabled: !!p.editFlags?.canCut,
        action: { kind: 'system', payload: { action: 'cut' } },
      });
      items.push({
        id: 'copy-edit',
        label: 'Copy',
        type: 'normal',
        enabled: !!p.editFlags?.canCopy,
        action: { kind: 'system', payload: { action: 'copy' } },
      });
      items.push({
        id: 'paste',
        label: 'Paste',
        type: 'normal',
        enabled: !!p.editFlags?.canPaste,
        action: { kind: 'system', payload: { action: 'paste' } },
      });
      items.push({
        id: 'select-all-edit',
        label: 'Select All',
        type: 'normal',
        enabled: !!p.editFlags?.canSelectAll,
        action: { kind: 'system', payload: { action: 'select-all' } },
      });
      items.push({ id: 'sep-edit', type: 'separator' });
    }

    // ── Page actions ───────────────────────────────────────────────────
    if (!p.linkURL && !p.isEditable && sel.length < 3) {
      items.push({
        id: 'back',
        label: 'Back',
        type: 'normal',
        enabled: !!tab && tab.canGoBack,
        action: { kind: 'runtime', payload: { action: 'goBack', tabId } },
      });
      items.push({
        id: 'forward',
        label: 'Forward',
        type: 'normal',
        enabled: !!tab && tab.canGoForward,
        action: { kind: 'runtime', payload: { action: 'goForward', tabId } },
      });
      items.push({
        id: 'reload',
        label: 'Reload',
        type: 'normal',
        enabled: true,
        accelerator: 'CmdOrCtrl+R',
        action: { kind: 'runtime', payload: { action: 'reloadTab', tabId } },
      });
      items.push({ id: 'sep-nav', type: 'separator' });
    }

    // ── Bookmark ───────────────────────────────────────────────────────
    const currentUrl = (tab && tab.url) || p.pageURL || '';
    if (currentUrl && currentUrl !== 'about:blank') {
      const isBookmarked = this._bookmarks.isBookmarked(currentUrl);
      items.push({
        id: 'bookmark-page',
        label: isBookmarked ? 'Remove Bookmark' : 'Bookmark This Page',
        type: 'normal',
        enabled: true,
        action: {
          kind: 'system',
          payload: { action: isBookmarked ? 'remove-bookmark' : 'add-bookmark', url: currentUrl, title: (tab && tab.title) || '' },
        },
      });
    }

    // ── JARVIS-specific ───────────────────────────────────────────────
    if (!p.linkURL && !p.isEditable && sel.length < 3) {
      items.push({ id: 'sep-jarvis-pre', type: 'separator' });
      items.push({
        id: 'send-page-jarvis',
        label: '⚡ Send Page URL to JARVIS',
        type: 'normal',
        enabled: true,
        action: { kind: 'jarvis', payload: { action: 'send-page-url', url: currentUrl, tabId } },
      });
      items.push({
        id: 'open-pip',
        label: 'Picture-in-Picture',
        type: 'normal',
        enabled: true,
        action: { kind: 'runtime', payload: { action: 'enterPiP', tabId } },
      });
    }

    // ── Inspect ────────────────────────────────────────────────────────
    items.push({ id: 'sep-inspect', type: 'separator' });
    items.push({
      id: 'inspect-element',
      label: 'Inspect Element',
      type: 'normal',
      enabled: true,
      action: { kind: 'devtools', payload: { tabId, x: p.x || 0, y: p.y || 0 } },
    });
    items.push({
      id: 'view-source',
      label: 'View Page Source',
      type: 'normal',
      enabled: !!currentUrl && currentUrl !== 'about:blank',
      action: { kind: 'system', payload: { action: 'view-source', url: currentUrl } },
    });

    return items;
  }

  _getSearchEngineName() {
    try {
      const settingsSvc = this._ctx.getService('kernel10_browser_services');
      if (settingsSvc && settingsSvc.settings && typeof settingsSvc.settings.get === 'function') {
        return settingsSvc.settings.get().searchEngine || 'google';
      }
    } catch (_) {}
    return 'google';
  }

  /**
   * Execute a menu action. Called by Part 6 (HTML menu) or by the native
   * Menu's click handlers (this file's showNative).
   * @param {object} action
   * @param {object} [actionCtx]
   * @returns {Promise<void>}
   */
  async execute(action, actionCtx = {}) {
    if (!action || typeof action !== 'object') return;
    const kind = action.kind;
    const payload = action.payload || {};

    try {
      if (kind === 'url') return await this._execUrl(payload);
      if (kind === 'clipboard') return this._execClipboard(payload);
      if (kind === 'shell') return await this._execShell(payload);
      if (kind === 'runtime') return await this._execRuntime(payload);
      if (kind === 'devtools') return this._execDevTools(payload);
      if (kind === 'jarvis') return await this._execJarvis(payload);
      if (kind === 'system') return await this._execSystem(payload);
    } catch (e) {
      audit('warn', 'menu_action_failed', { kind, error: String(e) });
    }
  }

  async _execUrl({ url, target }) {
    if (!url) return;
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;

    if (target === 'tab') {
      await runtime.createTab(url);
      return;
    }
    if (target === 'window' || target === 'pip') {
      // Reuse PiP if available.
      const desc = await runtime.createTab(url);
      if (desc && desc.id) {
        const res = runtime.enterPiP(desc.id);
        if (!res || !res.ok) {
          // PiP busy — open in right panel (split mode).
          if (typeof runtime.getPanelState === 'function') {
            const panel = runtime.getPanelState('right');
            if (panel && panel.visible) {
              try { await runtime.setPanelBounds('right', panel.bounds); } catch (_) {}
            }
          }
        }
      }
    }
  }

  _execClipboard({ text }) {
    if (!text) return;
    try { clipboard.writeText(String(text)); }
    catch (e) { audit('warn', 'clipboard_write_failed', { error: String(e) }); }
  }

  async _execShell({ action, url }) {
    if (action === 'save-link' || action === 'save-image') {
      // Use Electron's download flow — navigate a hidden BrowserWindow to
      // the URL with a save dialog. Simplest way to reuse Chromium's
      // download pipeline without pre-creating tabs.
      const runtime = this._ctx.getService('kernel10_browser_runtime');
      if (!runtime) return;
      const desc = await runtime.createTab(url, { activate: false });
      // Manually trigger a download for the target URL.
      try {
        const tab = runtime.getTab(desc.id);
        if (tab) {
          // Best-effort: create a hidden link click in the page context
          // would require webContents.executeJavaScript — simplified here.
          // The download manager will capture the resulting will-download.
        }
      } catch (_) {}
      return;
    }
    try { await shell.openExternal(url); }
    catch (e) { audit('warn', 'shell_open_failed', { error: String(e) }); }
  }

  async _execRuntime({ action, tabId }) {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;
    if (action === 'goBack' && typeof runtime.goBack === 'function') runtime.goBack(tabId);
    if (action === 'goForward' && typeof runtime.goForward === 'function') runtime.goForward(tabId);
    if (action === 'reloadTab' && typeof runtime.reloadTab === 'function') runtime.reloadTab(tabId);
    if (action === 'enterPiP' && typeof runtime.enterPiP === 'function') runtime.enterPiP(tabId);
  }

  _execDevTools({ tabId, x, y }) {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;
    const tab = runtime.getTab(tabId);
    if (!tab) return;
    try {
      // Part 4 doesn't expose tab.webContents directly through the service
      // API, so we reach through the runtime instance via getRuntime().
      const rt = require('./kernel_10_browser_runtime').getRuntime();
      const rawTab = rt && rt._tabs ? rt._tabs.get(tabId) : null;
      if (rawTab && rawTab.webContents) {
        rawTab.webContents.inspectElement(x || 0, y || 0);
        if (!rawTab.webContents.isDevToolsOpened()) rawTab.webContents.openDevTools({ mode: 'detach' });
      }
    } catch (e) {
      audit('warn', 'devtools_inspect_failed', { tabId, error: String(e) });
    }
  }

  async _execJarvis({ action, text, url, tabId }) {
    const bus = this._ctx.getService('kernel10_shared_context_bus');
    if (!bus) return;
    if (action === 'send-selection' && text) {
      bus.push({
        kind: 'selection',
        content: text,
        source: { tabId, url: '', title: '', app: 'context-menu' },
        metadata: { origin: 'context-menu' },
      });
    }
    if (action === 'send-page-url' && url) {
      bus.push({
        kind: 'text',
        content: url,
        source: { tabId, url, title: '', app: 'context-menu' },
        metadata: { origin: 'context-menu', type: 'page-url' },
      });
    }
  }

  async _execSystem({ action, text, url, title, srcUrl }) {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;
    const settingsMgr = this._getSettingsMgr();

    if (action === 'undo') return this._sendInputEvent('undo');
    if (action === 'redo') return this._sendInputEvent('redo');
    if (action === 'cut') return this._sendInputEvent('cut');
    if (action === 'copy') return this._sendInputEvent('copy');
    if (action === 'paste') return this._sendInputEvent('paste');
    if (action === 'select-all') return this._sendInputEvent('selectAll');

    if (action === 'copy-image' && srcUrl) {
      try {
        // Use runtime tab to fetch + copy via webContents
        return;
      } catch (_) {}
    }
    if (action === 'search-selection' && text && settingsMgr) {
      const searchUrl = settingsMgr.buildSearchUrl(text);
      await runtime.createTab(searchUrl);
      return;
    }
    if (action === 'add-bookmark' && url) {
      const bm = this._bookmarks.add({ url, title: title || url });
      return bm;
    }
    if (action === 'remove-bookmark' && url) {
      const existing = this._bookmarks.findByUrl(url);
      if (existing) this._bookmarks.remove(existing.id);
      return;
    }
    if (action === 'view-source' && url) {
      if (!url.startsWith('view-source:')) {
        await runtime.createTab('view-source:' + url);
      }
    }
  }

  _getSettingsMgr() {
    try {
      const svc = this._ctx.getService('kernel10_browser_services');
      if (svc && svc.settings && typeof svc.settings.buildSearchUrl === 'function') {
        return svc.settings;
      }
    } catch (_) {}
    return null;
  }

  _sendInputEvent(kind) {
    try {
      const rt = require('./kernel_10_browser_runtime').getRuntime();
      if (!rt) return;
      for (const tab of rt._tabs.values()) {
        try {
          if (kind === 'undo') tab.webContents.undo();
          else if (kind === 'redo') tab.webContents.redo();
          else if (kind === 'cut') tab.webContents.cut();
          else if (kind === 'copy') tab.webContents.copy();
          else if (kind === 'paste') tab.webContents.paste();
          else if (kind === 'selectAll') tab.webContents.selectAll();
        } catch (_) {}
        return; // only first focused tab — best-effort
      }
    } catch (_) {}
  }

  /**
   * Show a native OS context menu at the current mouse position.
   * Optional — Part 6 may prefer its own styled HTML menu.
   * @param {string} tabId
   * @param {Electron.ContextMenuParams} params
   * @param {BrowserWindow} win
   */
  showNative(tabId, params, win) {
    const descriptors = this.build(tabId, params);
    const menu = this._descriptorsToMenu(descriptors);
    try { menu.popup({ window: win }); }
    catch (e) { audit('warn', 'native_menu_popup_failed', { error: String(e) }); }
  }

  _descriptorsToMenu(descriptors) {
    const items = descriptors.map((d) => {
      if (d.type === 'separator') {
        return new MenuItem({ type: 'separator' });
      }
      return new MenuItem({
        label: d.label,
        type: d.type === 'checkbox' ? 'checkbox' : 'normal',
        enabled: d.enabled !== false,
        checked: !!d.checked,
        accelerator: d.accelerator || undefined,
        click: () => { this.execute(d.action, { tabId: d.action?.payload?.tabId }).catch(() => {}); },
      });
    });
    return Menu.buildFromTemplate(items);
  }
}

// ---------------------------------------------------------------------------
// SECTION 8 — KEYBOARD SHORTCUT CONTROLLER
// ---------------------------------------------------------------------------
// Attaches a `before-input-event` listener to every tab's webContents.
// Matches the event against the configured shortcut table and dispatches
// the corresponding action. Never touches the OS-level global shortcuts —
// actions only fire when a Kernel-10 tab is focused.
// ---------------------------------------------------------------------------

class KeyboardShortcutController {
  /**
   * @param {object} ctx
   * @param {BookmarksManager} bookmarks
   * @param {FindInPageService} find
   * @param {DownloadManager} downloads
   * @param {ClosedTabStack} closedTabs
   * @param {Function} focusOmnibox — callback (tabId) provided by orchestrator
   */
  constructor(ctx, bookmarks, find, downloads, closedTabs, focusOmnibox) {
    this._ctx = ctx;
    this._bookmarks = bookmarks;
    this._find = find;
    this._downloads = downloads;
    this._closedTabs = closedTabs;
    this._focusOmnibox = focusOmnibox;

    this._shortcuts = new Map(); // id → { accelerator, label }
    this._byAccelerator = new Map(); // normalized accelerator → id
    this._attachedTabs = new Set();

    this._load();
    this._attachToRuntime();
  }

  _load() {
    const stored = readJSON(FILES.shortcuts, {});
    const merged = new Map();
    for (const [id, def] of Object.entries(SHORTCUT_DEFAULTS)) {
      const override = stored && stored[id] && typeof stored[id].accelerator === 'string'
        ? stored[id].accelerator
        : def.accelerator;
      merged.set(id, { accelerator: override, label: def.label });
    }
    this._shortcuts = merged;
    this._rebuildIndex();
  }

  _rebuildIndex() {
    this._byAccelerator.clear();
    for (const [id, entry] of this._shortcuts.entries()) {
      const norm = this._normalizeAccelerator(entry.accelerator);
      if (norm) this._byAccelerator.set(norm, id);
    }
  }

  _save() {
    const out = {};
    for (const [id, entry] of this._shortcuts.entries()) {
      out[id] = { accelerator: entry.accelerator };
    }
    writeJSON(FILES.shortcuts, out);
  }

  _normalizeAccelerator(accel) {
    if (typeof accel !== 'string') return '';
    return accel
      .toLowerCase()
      .replace(/commandorcontrol/g, 'cmdorctrl')
      .replace(/\s+/g, '')
      .replace(/\+/g, '+');
  }

  _attachToRuntime() {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime || typeof runtime.on !== 'function') return;
    runtime.on('tab-created', ({ tabId, webContents }) => {
      try { this._attachToTab(tabId, webContents); }
      catch (e) { audit('error', 'shortcut_attach_failed', { tabId, error: String(e) }); }
    });
    runtime.on('tab-destroyed', ({ tabId }) => {
      this._attachedTabs.delete(tabId);
    });
  }

  _attachToTab(tabId, webContents) {
    if (!webContents) return;
    if (this._attachedTabs.has(tabId)) return;
    this._attachedTabs.add(tabId);

    webContents.on('before-input-event', (event, input) => {
      try {
        const matched = this._matchInput(input);
        if (!matched) return;
        // Let the page see Escape unless we're consuming it for find-in-page.
        event.preventDefault();
        this.dispatch(matched, tabId).catch((e) => {
          audit('warn', 'shortcut_dispatch_failed', { id: matched, tabId, error: String(e) });
        });
      } catch (e) {
        audit('warn', 'before_input_error', { tabId, error: String(e) });
      }
    });
  }

  _matchInput(input) {
    if (!input || input.type !== 'keyDown') return null;
    const key = String(input.key || '');
    if (!key) return null;

    const parts = [];
    if (input.control) parts.push('control');
    if (input.meta) parts.push(input.meta === 'command' ? 'command' : 'meta');
    if (input.shift) parts.push('shift');
    if (input.alt) parts.push('alt');

    // Try both "cmdorctrl" and "control+..." / "command+..." variants.
    const candidates = this._buildAcceleratorCandidates(key, parts);
    for (const c of candidates) {
      const norm = this._normalizeAccelerator(c);
      const id = this._byAccelerator.get(norm);
      if (id) return id;
    }

    // Numeric shortcuts (Ctrl+1..9 → switch tab).
    if ((input.control || input.meta) && /^[1-9]$/.test(key)) {
      return `switch-tab-${key}`;
    }

    return null;
  }

  _buildAcceleratorCandidates(key, parts) {
    const out = [];
    const keyLower = key.toLowerCase();
    const keyPretty = this._prettyKey(keyLower);

    const variants = [];
    // cmdorctrl variant
    const partsWithCmdOrCtrl = parts.map((p) => (p === 'control' || p === 'command' || p === 'meta') ? 'cmdorctrl' : p);
    if (parts.some((p) => p === 'control' || p === 'command' || p === 'meta')) {
      variants.push([...new Set(partsWithCmdOrCtrl), keyPretty].join('+'));
    }
    // Straight control variant
    if (parts.includes('control')) variants.push(['control', ...parts.filter((p) => p !== 'control'), keyPretty].join('+'));
    // Straight meta variant
    if (parts.includes('meta')) variants.push(['command', ...parts.filter((p) => p !== 'meta'), keyPretty].join('+'));
    // No modifiers
    if (parts.length === 0) variants.push(keyPretty);

    for (const v of variants) out.push(v);
    return out;
  }

  _prettyKey(k) {
    if (k === 'escape') return 'Escape';
    if (k === 'enter') return 'Return';
    if (k === 'tab') return 'Tab';
    if (k === '+') return 'Plus';
    if (k === '-') return '-';
    if (k === '=') return '=';
    if (k === 'left') return 'Left';
    if (k === 'right') return 'Right';
    if (k === 'up') return 'Up';
    if (k === 'down') return 'Down';
    if (k === ' ') return 'Space';
    if (k.length === 1) return k.toUpperCase();
    return k.charAt(0).toUpperCase() + k.slice(1);
  }

  /**
   * Execute a shortcut by id. Used by both before-input-event and Part 6
   * buttons / tests.
   * @param {string} id
   * @param {string} tabId
   * @returns {Promise<void>}
   */
  async dispatch(id, tabId) {
    if (!id) return;
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;

    // Numeric switch shortcuts.
    if (id.startsWith('switch-tab-')) {
      const n = parseInt(id.slice('switch-tab-'.length), 10);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        await runtime.activateTabByIndex(n - 1);
      }
      return;
    }

    switch (id) {
      case 'new-tab':           return void (await runtime.createTab('about:blank'));
      case 'close-tab':         return void (await runtime.closeTab(tabId));
      case 'reopen-closed-tab': return void this._closedTabs.reopen();
      case 'next-tab':          return this._cycleTab(+1);
      case 'prev-tab':          return this._cycleTab(-1);
      case 'focus-omnibox':     return this._focusOmnibox ? this._focusOmnibox(tabId) : undefined;
      case 'reload':            return void runtime.reloadTab(tabId, false);
      case 'hard-reload':       return void runtime.reloadTab(tabId, true);
      case 'find':              return; // Part 6 handles opening the find bar
      case 'zoom-in':           return void runtime.zoomIn(tabId);
      case 'zoom-out':          return void runtime.zoomOut(tabId);
      case 'zoom-reset':        return void runtime.resetZoom(tabId);
      case 'bookmark-page':     return this._bookmarkCurrent(tabId);
      case 'open-history':      return; // Part 6 routes
      case 'open-downloads':    return; // Part 6 routes
      case 'back':              return void runtime.goBack(tabId);
      case 'forward':           return void runtime.goForward(tabId);
      case 'devtools':          return this._toggleDevTools(tabId);
      case 'view-source':       return this._viewSource(tabId);
      case 'print':             return this._printPage(tabId);
      case 'escape':            return this._escapeAction(tabId);
      case 'pip-toggle':        return this._togglePiP(tabId);
      default:
        return;
    }
  }

  async _cycleTab(delta) {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;
    const info = await runtime.getActiveTabInfo();
    if (!info) return;
    const list = await runtime.getTabList();
    if (!list || list.length < 2) return;
    const currentIdx = list.findIndex((t) => t.id === info.id);
    if (currentIdx < 0) return;
    const nextIdx = (currentIdx + delta + list.length) % list.length;
    await runtime.activateTab(list[nextIdx].id);
  }

  _bookmarkCurrent(tabId) {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;
    const tab = runtime.getTab(tabId);
    if (!tab || !tab.url || tab.url === 'about:blank') return;
    const existing = this._bookmarks.findByUrl(tab.url);
    if (existing) {
      this._bookmarks.remove(existing.id);
    } else {
      this._bookmarks.add({ url: tab.url, title: tab.title || tab.url });
    }
  }

  _toggleDevTools(tabId) {
    try {
      const rt = require('./kernel_10_browser_runtime').getRuntime();
      if (!rt) return;
      const tab = rt._tabs && rt._tabs.get(tabId);
      if (!tab || !tab.webContents) return;
      if (tab.webContents.isDevToolsOpened()) tab.webContents.closeDevTools();
      else tab.webContents.openDevTools({ mode: 'detach' });
    } catch (e) {
      audit('warn', 'toggle_devtools_failed', { tabId, error: String(e) });
    }
  }

  async _viewSource(tabId) {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;
    const tab = runtime.getTab(tabId);
    if (!tab || !tab.url || tab.url === 'about:blank') return;
    const src = tab.url.startsWith('view-source:') ? tab.url : 'view-source:' + tab.url;
    await runtime.createTab(src);
  }

  _printPage(tabId) {
    try {
      const rt = require('./kernel_10_browser_runtime').getRuntime();
      if (!rt) return;
      const tab = rt._tabs && rt._tabs.get(tabId);
      if (tab && tab.webContents) tab.webContents.print({});
    } catch (e) {
      audit('warn', 'print_failed', { tabId, error: String(e) });
    }
  }

  _escapeAction(tabId) {
    const findState = this._find.getState(tabId);
    if (findState.running || findState.query) {
      this._find.stop(tabId);
      return;
    }
    // Otherwise, stop page loading.
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (runtime) runtime.stopTab(tabId);
  }

  async _togglePiP(tabId) {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime) return;
    if (typeof runtime.enterPiP !== 'function') return;
    const tab = runtime.getTab(tabId);
    if (tab && tab.inPip) {
      await runtime.exitPiP();
    } else {
      runtime.enterPiP(tabId);
    }
  }

  getShortcutList() {
    const out = [];
    for (const [id, entry] of this._shortcuts.entries()) {
      out.push({ id, accelerator: entry.accelerator, label: entry.label });
    }
    return out;
  }

  setCustomShortcut(id, accelerator) {
    if (!this._shortcuts.has(id)) return false;
    if (typeof accelerator !== 'string' || accelerator.trim() === '') return false;
    const entry = this._shortcuts.get(id);
    this._shortcuts.set(id, { ...entry, accelerator: accelerator.trim() });
    this._rebuildIndex();
    this._save();
    return true;
  }

  resetShortcuts() {
    for (const [id, def] of Object.entries(SHORTCUT_DEFAULTS)) {
      this._shortcuts.set(id, { accelerator: def.accelerator, label: def.label });
    }
    this._rebuildIndex();
    this._save();
    return true;
  }

  shutdown() {
    this._attachedTabs.clear();
  }
}

// ---------------------------------------------------------------------------
// SECTION 9 — CLOSED TAB STACK
// ---------------------------------------------------------------------------
// Implements Chrome's Ctrl+Shift+T behaviour with a bounded LIFO stack.
// ---------------------------------------------------------------------------

class ClosedTabStack {
  constructor(emitFn) {
    this._emitFn = emitFn;
    this._stack = [];
    this._saveDebounced = debounce(() => this._save(), LIMITS.closedTabsSaveDebounceMs);
    this._load();
  }

  _load() {
    const stored = readJSON(FILES.closedTabs, { stack: [] });
    const stack = stored && Array.isArray(stored.stack) ? stored.stack : [];
    this._stack = stack
      .filter((e) => e && typeof e === 'object' && e.url)
      .slice(-LIMITS.closedTabsStack);
  }

  _save() {
    writeJSON(FILES.closedTabs, { stack: this._stack });
  }

  push(entry) {
    if (!entry || typeof entry !== 'object' || !entry.url) return;
    this._stack.push({
      url: sanitizeUrl(entry.url),
      title: sanitizeTitle(entry.title || ''),
      panel: typeof entry.panel === 'string' ? entry.panel : 'left',
      closedAt: Date.now(),
    });
    if (this._stack.length > LIMITS.closedTabsStack) {
      this._stack.splice(0, this._stack.length - LIMITS.closedTabsStack);
    }
    this._saveDebounced();
    try { this._emitFn('closed-tab-pushed', { entry }); } catch (_) {}
  }

  get() {
    return this._stack.slice().reverse().map((e) => ({ ...e }));
  }

  async reopen() {
    const entry = this._stack.pop();
    if (!entry) return null;
    this._saveDebounced();
    const runtime = this._ctx_runtime;
    if (!runtime) return null;
    try {
      const desc = await runtime.createTab(entry.url, { panel: entry.panel });
      try { this._emitFn('closed-tab-reopened', { tabId: desc.id }); } catch (_) {}
      return desc;
    } catch (e) {
      audit('warn', 'reopen_tab_failed', { url: entry.url, error: String(e) });
      return null;
    }
  }

  /** @internal — set by BrowserServices */
  _bindRuntime(runtime) { this._ctx_runtime = runtime; }
}

// ---------------------------------------------------------------------------
// SECTION 10 — BROWSER SERVICES ORCHESTRATOR
// ---------------------------------------------------------------------------

class BrowserServices extends EventEmitter {
  constructor(ctx) {
    super();
    this._ctx = ctx;
    this._bootedAt = Date.now();
    this._closed = false;

    const emit = this._emitInternal.bind(this);

    this._settings = new BrowserSettingsManager(emit);
    this._bookmarks = new BookmarksManager(emit);
    this._history = new HistoryManager(emit);
    this._downloads = new DownloadManager(ctx, emit, this._settings);
    this._closedTabs = new ClosedTabStack(emit);

    const runtime = ctx.getService('kernel10_browser_runtime');
    this._closedTabs._bindRuntime(runtime);

    this._find = new FindInPageService(emit, runtime);
    this._shortcuts = new KeyboardShortcutController(
      ctx, this._bookmarks, this._find, this._downloads, this._closedTabs,
      (tabId) => this._focusOmnibox(tabId),
    );
    this._contextMenu = new ContextMenuBuilder(ctx, this._downloads, this._bookmarks, this._find);

    this._attachRuntimeHooks();
    this._focusOmniboxListeners = new Set();
  }

  _emitInternal(event, data) {
    if (this._closed) return;
    try { this.emit(event, data); }
    catch (e) { audit('error', 'emit_failed', { event, error: String(e) }); }
  }

  _attachRuntimeHooks() {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime || typeof runtime.on !== 'function') return;

    runtime.on('tab-created', ({ tabId }) => {
      try {
        const tab = runtime.getTab(tabId);
        if (tab && tab.url && tab.url !== 'about:blank') {
          this._history.append({ url: tab.url, title: tab.title, favicon: tab.favicon });
        }
      } catch (_) {}
    });

    runtime.on('tab-navigated', ({ tabId, url }) => {
      try {
        const tab = runtime.getTab(tabId);
        this._history.append({
          url,
          title: (tab && tab.title) || '',
          favicon: (tab && tab.favicon) || faviconFor(url),
        });
      } catch (_) {}
    });

    runtime.on('tab-destroyed', ({ tabId }) => {
      try {
        // Push to closed-tab stack if the tab had a real URL.
        const snap = runtime._tabs;
        // Tab is already removed from runtime map — get from closed-tab
        // event context is unavailable, so we rely on the tab's last known
        // URL. The runtime should emit `tab-closing` before destruction,
        // but it doesn't — so we push from the parent's cache if we have one.
        // Fallback: rely on `_lastClosedTabs` tracked below.
      } catch (_) {}
    });

    runtime.on('tab-updated', ({ tabId, descriptor }) => {
      // Store last-known URL for closed-tab stack tracking.
      if (!this._lastTabState) this._lastTabState = new Map();
      this._lastTabState.set(tabId, {
        url: descriptor.url,
        title: descriptor.title,
        panel: descriptor.panel,
      });
    });

    // Wrap closeTab to capture URL before destruction.
    this._wrapRuntimeCloseTab();
  }

  _wrapRuntimeCloseTab() {
    const runtime = this._ctx.getService('kernel10_browser_runtime');
    if (!runtime || typeof runtime.closeTab !== 'function') return;
    if (this._closeTabWrapped) return;
    this._closeTabWrapped = true;

    const original = runtime.closeTab.bind(runtime);
    runtime.closeTab = async (tabId) => {
      try {
        const tab = runtime.getTab ? runtime.getTab(tabId) : null;
        if (tab && tab.url && tab.url !== 'about:blank') {
          this._closedTabs.push({ url: tab.url, title: tab.title, panel: tab.panel });
        }
      } catch (_) {}
      return original(tabId);
    };
  }

  _focusOmnibox(tabId) {
    for (const fn of this._focusOmniboxListeners) {
      try { fn(tabId); } catch (_) {}
    }
  }

  /**
   * Part 6 / 7 subscribe here to receive "focus the URL bar" signals.
   * @param {(tabId: string) => void} fn
   * @returns {() => void}
   */
  onFocusOmnibox(fn) {
    if (typeof fn !== 'function') return () => {};
    this._focusOmniboxListeners.add(fn);
    return () => this._focusOmniboxListeners.delete(fn);
  }

  getStats() {
    return {
      version: '1.0.0',
      bootedAt: this._bootedAt,
      uptimeMs: Date.now() - this._bootedAt,
      bookmarks: this._bookmarks.getAll().length,
      historyCount: this._history.recent(1).length,
      activeDownloads: this._downloads.getActive().length,
      completedDownloads: this._downloads.getCompleted().length,
      closedTabs: this._closedTabs.get().length,
    };
  }

  async shutdown() {
    if (this._closed) return;
    this._closed = true;
    try { this._downloads.shutdown(); } catch (_) {}
    try { this._find.shutdown(); } catch (_) {}
    try { this._shortcuts.shutdown(); } catch (_) {}
    this._focusOmniboxListeners.clear();
    audit('info', 'services_shutdown', { uptimeMs: Date.now() - this._bootedAt });
    this.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// SECTION 11 — INIT
// ---------------------------------------------------------------------------

let _services = null;

function init(ctx) {
  _auditFn = ctx && typeof ctx.audit === 'function' ? ctx.audit.bind(ctx) : null;

  // Guard: browser_runtime must already be registered.
  const runtime = ctx && typeof ctx.getService === 'function'
    ? ctx.getService('kernel10_browser_runtime')
    : null;
  if (!runtime) {
    audit('warn', 'init_without_runtime', { note: 'browser_services will be partially functional' });
  }

  const services = new BrowserServices(ctx);
  _services = services;

  if (ctx && typeof ctx.registerService === 'function') {
    ctx.registerService('kernel10_browser_services', {
      // ── Settings ───────────────────────────────────────────────────
      settings: {
        get: () => services._settings.get(),
        update: (patch) => services._settings.update(patch),
        reset: () => services._settings.reset(),
        getPinnedPresets: () => services._settings.getPinnedPresets(),
        setPinnedPreset: (slot, url, title, enabled) => services._settings.setPinnedPreset(slot, url, title, enabled),
        buildSearchUrl: (q) => services._settings.buildSearchUrl(q),
        getResolvedDownloadsPath: () => services._settings.getResolvedDownloadsPath(),
      },

      // ── Bookmarks ──────────────────────────────────────────────────
      bookmarks: {
        getAll: () => services._bookmarks.getAll(),
        getBarItems: () => services._bookmarks.getBarItems(),
        getById: (id) => services._bookmarks.getById(id),
        findByUrl: (url) => services._bookmarks.findByUrl(url),
        isBookmarked: (url) => services._bookmarks.isBookmarked(url),
        add: (item) => services._bookmarks.add(item),
        remove: (id) => services._bookmarks.remove(id),
        update: (id, patch) => services._bookmarks.update(id, patch),
        reorder: (ids) => services._bookmarks.reorder(ids),
      },

      // ── History ────────────────────────────────────────────────────
      history: {
        append: (data) => services._history.append(data),
        recent: (limit) => services._history.recent(limit),
        query: (opts) => services._history.query(opts),
        groupedByDay: (limit) => services._history.groupedByDay(limit),
        clearBefore: (ts) => services._history.clearBefore(ts),
        clearAll: () => services._history.clearAll(),
      },

      // ── Downloads ──────────────────────────────────────────────────
      downloads: {
        getActive: () => services._downloads.getActive(),
        getCompleted: () => services._downloads.getCompleted(),
        pause: (id) => services._downloads.pause(id),
        resume: (id) => services._downloads.resume(id),
        cancel: (id) => services._downloads.cancel(id),
        openFile: (id) => services._downloads.openFile(id),
        showInFolder: (id) => services._downloads.showInFolder(id),
        clearCompleted: () => services._downloads.clearCompleted(),
      },

      // ── Find-in-Page ───────────────────────────────────────────────
      find: {
        start: (tabId, query, opts) => services._find.start(tabId, query, opts),
        next: (tabId) => services._find.next(tabId),
        prev: (tabId) => services._find.prev(tabId),
        stop: (tabId) => services._find.stop(tabId),
        getState: (tabId) => services._find.getState(tabId),
      },

      // ── Shortcuts ──────────────────────────────────────────────────
      shortcuts: {
        dispatch: (id, tabId) => services._shortcuts.dispatch(id, tabId),
        getShortcutList: () => services._shortcuts.getShortcutList(),
        setCustomShortcut: (id, accelerator) => services._shortcuts.setCustomShortcut(id, accelerator),
        resetShortcuts: () => services._shortcuts.resetShortcuts(),
      },

      // ── Context Menu ───────────────────────────────────────────────
      contextMenu: {
        build: (tabId, params) => services._contextMenu.build(tabId, params),
        execute: (action, actionCtx) => services._contextMenu.execute(action, actionCtx),
        showNative: (tabId, params, win) => services._contextMenu.showNative(tabId, params, win),
      },

      // ── Closed Tabs ────────────────────────────────────────────────
      closedTabs: {
        get: () => services._closedTabs.get(),
        reopen: () => services._closedTabs.reopen(),
      },

      // ── Cross-module wiring ────────────────────────────────────────
      onFocusOmnibox: (fn) => services.onFocusOmnibox(fn),

      // ── Lifecycle ──────────────────────────────────────────────────
      getStats: () => services.getStats(),
      shutdown: () => services.shutdown(),
      on: (event, fn) => services.on(event, fn),
      off: (event, fn) => services.off(event, fn),
    });
  }

  if (ctx && typeof ctx.addStateContributor === 'function') {
    ctx.addStateContributor('kernel10_browser_services', () => {
      const s = services.getStats();
      return {
        version: '1.0.0',
        bookmarks: s.bookmarks,
        active_downloads: s.activeDownloads,
        completed_downloads: s.completedDownloads,
        closed_tabs: s.closedTabs,
      };
    });
  }

  if (ctx && typeof ctx.addStopHook === 'function') {
    ctx.addStopHook('kernel10_browser_services', () => {
      if (services) services.shutdown().catch(() => {});
    });
  }

  audit('info', 'browser_services_initialized', {
    runtime_available: !!runtime,
    files: Object.keys(FILES),
  });
}

function getServices() { return _services; }

// ---------------------------------------------------------------------------
// SECTION 12 — EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  name: 'kernel10_browser_services',
  version: '1.0.0',
  init,
  getServices,

  // Classes (for tests + advanced consumers).
  BrowserServices,
  BrowserSettingsManager,
  BookmarksManager,
  HistoryManager,
  DownloadManager,
  FindInPageService,
  ContextMenuBuilder,
  KeyboardShortcutController,
  ClosedTabStack,

  // Constants.
  FILES,
  LIMITS,
  SHORTCUT_DEFAULTS,
  SETTINGS_DEFAULTS,
  SEARCH_ENGINES,

  // Utilities.
  sanitizeUrl,
  sanitizeTitle,
  faviconFor,
};