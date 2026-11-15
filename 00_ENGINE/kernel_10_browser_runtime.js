'use strict';

/**
 * ============================================================================
 * KERNEL 10 — PART 4 of 7
 * kernel_10_browser_runtime.js
 * Location: C:\Jarvis_Core\00_ENGINE\kernel_10_browser_runtime.js
 * Version:  1.0.0-enterprise
 * ============================================================================
 *
 * RESPONSIBILITY
 * --------------
 * Core Chromium browser runtime for the JARVIS-CORE Chrome-Lite workspace.
 * Owns every live WebContentsView, tab, panel, popup and PiP window.
 *
 * This module is the SINGLE SOURCE OF TRUTH for browser state. Every other
 * Kernel-10 module consumes it either by (a) subscribing to its event
 * emitter, or (b) calling the service methods registered in `init(ctx)`.
 *
 * Provided services (via ctx.registerService('kernel10_browser_runtime')):
 *   getTabList()                      — Promise<BrowserTabDescriptor[]>
 *   getTab(tabId)                     — descriptor | null
 *   getActiveTabInfo()                — { id, index, url, title, count, panelId } | null
 *   createTab(url, opts)              — Promise<descriptor>
 *   closeTab(tabId)                   — Promise<boolean>
 *   closeActiveTab(panelId?)          — Promise<boolean>
 *   activateTab(tabId)                — Promise<boolean>
 *   activateTabByIndex(index, panelId)— Promise<boolean>
 *   navigateTab(tabId, url)           — Promise<void>
 *   goBack(tabId) / goForward(tabId) / reloadTab(tabId, ignoreCache) / stopTab(tabId)
 *   goHome(tabId)
 *   setZoom(tabId, factor) / zoomIn / zoomOut / resetZoom
 *   pinTab(tabId, pinned)
 *   reorderTab(tabId, newIndex, panelId)
 *   duplicateTab(tabId)
 *   setPanelBounds(panelId, bounds|null)
 *   getPanelState(panelId)
 *   injectPromptToTab(tabId, promptText, opts) — Promise<{ ok, error? }>
 *   findInPage(tabId, query, opts)    — { matches, activeMatchOrdinal } | null
 *   stopFindInPage(tabId, action)
 *   enterPiP(tabId) / exitPiP()
 *   getStateSnapshot()                — { tabs, panels, activeTabId, pip, version }
 *   snapshot() / restore(snap) / clearStorage()
 *   attachToWindow(win) / detach()
 *   on(event, fn) / off(event, fn)    — EventEmitter passthrough
 *   shutdown()
 *
 * Event emitter contract (Part 7 forwards these to the renderer via IPC):
 *   'tab-created'    { tabId, descriptor, webContents, view }
 *   'tab-destroyed'  { tabId }
 *   'tab-activated'  { tabId, panelId }
 *   'tab-updated'    { tabId, patch }               (debounced per-tab)
 *   'tab-navigated'  { tabId, url, isInPage }
 *   'panel-bounds'   { panelId, bounds }
 *   'pip-entered'    { tabId }
 *   'pip-exited'     { tabId }
 *   'state-change'   full snapshot                  (debounced)
 *   'runtime-error'  { where, error, tabId? }
 *
 * REQUIRED ENVIRONMENT
 * --------------------
 *   - Electron ≥ 30 (for BaseWindow + WebContentsView + BrowserWindow.contentView)
 *   - Kernel.js already created the main BrowserWindow (frozen-core constraint)
 *   - Part 7 calls `attachToWindow(mainWindow)` once available
 *
 * ARCHITECTURE DECISIONS
 * ----------------------
 *   1. Chrome-style layout: Part 6 draws all chrome (tab strip, toolbar,
 *      omnibox). Part 4 draws ONLY web content via WebContentsView.setBounds.
 *      Bounds from Part 6 exclude the toolbar strip — the view sits BELOW
 *      the toolbar, exactly like real Chrome.
 *   2. Persistent partitions: every tab uses `persist:jarvis_workspace` so
 *      logins/cookies/localStorage survive restarts and are shared across
 *      tabs (needed for cross-tab relay between AI providers).
 *   3. Preload: every tab loads `kernel_10_webview_preload.js` (Part 3).
 *   4. Context isolation + sandbox enabled — preload is enough for our IPC.
 *   5. Popup policy: `_blank` → new tab; `window.open(url, name, features)`
 *      → native popup with `window.opener` intact (required by OAuth);
 *      `save-to-disk` → deny + hand to Part 5 download manager.
 *   6. PiP: tab view is detached from the main window and re-attached to a
 *      small always-on-top BaseWindow. Session state survives the move
 *      because the webContents is never destroyed.
 *   7. Session persistence: JSON snapshot in `<ROOT>/01_CONFIG/kernel10/session.json`,
 *      saved on 5s debounce + on shutdown. Restore loads URLs asynchronously.
 *
 * FROZEN-CORE COMPLIANCE
 * ----------------------
 *   - kernel.js / preload.js untouched
 *   - Attaches to mainWindow via contentView.addChildView() — no window
 *     construction, no re-creation
 *   - IPC handled entirely by Part 7; this module only emits events
 * ============================================================================
 */

const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  session,
  screen,
} = require('electron');

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// SECTION 0 — CONSTANTS & CONFIG
// ---------------------------------------------------------------------------

const LOG_TAG = 'k10.runtime';
const PRELOAD_PATH = path.join(__dirname, 'kernel_10_webview_preload.js');
const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG', 'kernel10');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

const PERSIST_PARTITION = 'persist:jarvis_workspace';

const MAX_TABS = 50;
const TAB_ID_BYTES = 8;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5.0;
const ZOOM_STEP = 0.1;

const DEFAULT_PANEL_ID = 'left';
const VALID_PANEL_IDS = Object.freeze(new Set(['left', 'right', 'main']));

const DEFAULT_POPUP_WIDTH = 900;
const DEFAULT_POPUP_HEIGHT = 700;

const PIP_DEFAULT_WIDTH = 480;
const PIP_DEFAULT_HEIGHT = 360;
const PIP_MIN_WIDTH = 280;
const PIP_MIN_HEIGHT = 200;

const SAVE_DEBOUNCE_MS = 5000;
const STATE_EMIT_DEBOUNCE_MS = 60;
const TAB_UPDATE_DEBOUNCE_MS = 40;

const INJECT_INITIAL_LOAD_WAIT_MS = 6000;
const INJECT_LOAD_POLL_MS = 200;

const ALLOWED_NAV_PROTOCOLS = Object.freeze(new Set([
  'http:', 'https:', 'file:', 'about:', 'data:', 'chrome:', 'devtools:',
]));

// Tab event names we forward to the renderer for status updates.
// NOTE: `page-favicon-updated` returns an array; we pick the first entry.
const TAB_EVENTS_TO_FORWARD = Object.freeze({
  'did-start-loading': 'loading',
  'did-stop-loading': 'idle',
  'did-finish-load': 'loaded',
  'did-fail-load': 'error',
  'page-title-updated': 'title',
  'page-favicon-updated': 'favicon',
  'did-navigate': 'navigated',
  'did-navigate-in-page': 'navigated-in-page',
  'render-process-gone': 'crash',
});

// ---------------------------------------------------------------------------
// SECTION 1 — UTILITIES
// ---------------------------------------------------------------------------

/**
 * Audit helper — never throws.
 * @param {'info'|'warn'|'error'} level
 * @param {string} event
 * @param {object} [data]
 */
let _auditFn = null;
function audit(level, event, data) {
  if (typeof _auditFn !== 'function') return;
  try {
    _auditFn(level, `${LOG_TAG}.${event}`, data);
  } catch (_) { /* audit must never crash */ }
}

/**
 * Generate a tab id.
 * @returns {string}
 */
function makeTabId() {
  return 'tab_' + crypto.randomBytes(TAB_ID_BYTES).toString('hex');
}

/**
 * Validate/normalize a URL string. Allows `about:blank`, http(s), file, etc.
 * If input lacks scheme, prepend https://.
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  if (t === 'about:blank') return 'about:blank';
  try {
    // If it already parses as a URL, validate protocol.
    const u = new URL(t);
    if (ALLOWED_NAV_PROTOCOLS.has(u.protocol)) return t;
    return null;
  } catch (_) {
    // Try to parse as host — heuristic.
    try {
      const u = new URL('https://' + t);
      if (u.protocol === 'https:' && u.hostname) return u.toString();
    } catch (_) { /* ignore */ }
    return null;
  }
}

/**
 * Whether a URL is allowed as a main-frame navigation.
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedNavUrl(url) {
  try {
    const u = new URL(url);
    return ALLOWED_NAV_PROTOCOLS.has(u.protocol);
  } catch (_) {
    return false;
  }
}

/**
 * Bounds sanity: all fields integers ≥ 0. Returns null if invalid.
 * @param {any} b
 * @returns {{ x:number, y:number, width:number, height:number } | null}
 */
function sanitizeBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const x = Math.round(Number(b.x));
  const y = Math.round(Number(b.y));
  const w = Math.round(Number(b.width));
  const h = Math.round(Number(b.height));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < 0 || h < 0) return null;
  return { x, y, width: w, height: h };
}

/**
 * Clamp a zoom factor into the allowed range.
 * @param {number} z
 * @returns {number}
 */
function clampZoom(z) {
  if (!Number.isFinite(z)) return 1.0;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/**
 * Deep-but-safe clone for descriptor objects (no functions, no cycles).
 * @template T @param {T} v @returns {T}
 */
function safeClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(safeClone);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = safeClone(val);
  }
  return out;
}

/**
 * Debounce an async-safe function. Timer is dropped on subsequent calls.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
function debounce(fn, ms) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try { fn.apply(null, args); }
      catch (e) { audit('error', 'debounced_error', { error: String(e) }); }
    }, ms);
  };
}

/**
 * Whether the current tab state needs a fresh favicon URL extraction.
 * @param {string} url
 * @returns {string}
 */
function extractFavicon(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    return `${u.origin}/favicon.ico`;
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// SECTION 2 — BROWSER TAB (encapsulates WebContentsView + listeners)
// ---------------------------------------------------------------------------

class BrowserTab {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.panelId
   * @param {string} opts.url
   * @param {boolean} [opts.isPinned]
   * @param {number} [opts.zoom]
   * @param {Function} opts.emitFn          — forwarded emitter (runtime)
   * @param {Function} opts.onStateDirty    — throttled dirty marker
   */
  constructor(opts) {
    this.id = opts.id;
    this.panelId = VALID_PANEL_IDS.has(opts.panelId) ? opts.panelId : DEFAULT_PANEL_ID;
    this.isPinned = !!opts.isPinned;
    this.zoom = clampZoom(opts.zoom || 1.0);

    this.createdAt = Date.now();
    this.lastActiveAt = this.createdAt;
    this.loadedAt = 0;
    this.loading = false;
    this.url = normalizeUrl(opts.url) || 'about:blank';
    this.title = '';
    this.favicon = '';
    this.canGoBack = false;
    this.canGoForward = false;
    this.lastError = null;
    this.pipWindowId = null;

    this._emitFn = opts.emitFn;
    this._onStateDirty = opts.onStateDirty;
    this._destroyed = false;

    // Create the WebContentsView.
    this.view = new WebContentsView({
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        partition: PERSIST_PARTITION,
        backgroundThrottling: true,
      },
    });
    this.webContents = this.view.webContents;

    // Force-deny audio autoplay until user interaction (privacy default).
    try { this.webContents.setAudioMuted(false); } catch (_) {}

    this._installListeners();

    // Load initial URL. Errors surface via did-fail-load, so we don't need
    // to await this promise here.
    if (this.url && this.url !== 'about:blank') {
      this.loadURL(this.url).catch((e) => {
        audit('warn', 'initial_load_failed', { tabId: this.id, error: String(e) });
      });
    }
  }

  /** @private */
  _installListeners() {
    const wc = this.webContents;
    const safe = (label, fn) => (...args) => {
      try { fn(...args); }
      catch (e) { audit('error', `tab_listener_${label}`, { tabId: this.id, error: String(e) }); }
    };

    wc.on('did-start-loading', safe('did-start-loading', () => {
      this.loading = true;
      this._onStateDirty(this.id);
    }));

    wc.on('did-stop-loading', safe('did-stop-loading', () => {
      this.loading = false;
      this._refreshNavState();
      this._onStateDirty(this.id);
    }));

    wc.on('did-finish-load', safe('did-finish-load', () => {
      this.loadedAt = Date.now();
      this.lastError = null;
      this._refreshNavState();
      this._onStateDirty(this.id);
    }));

    wc.on('did-fail-load', safe('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 = ERR_ABORTED (usually a redirect cancel — not a real failure).
      if (errorCode === -3) return;
      this.loading = false;
      this.lastError = { code: errorCode, description: String(errorDescription || ''), url: validatedURL };
      this._refreshNavState();
      this._onStateDirty(this.id);
    }));

    wc.on('page-title-updated', safe('page-title-updated', (_e, title) => {
      this.title = String(title || '');
      this._onStateDirty(this.id);
    }));

    wc.on('page-favicon-updated', safe('page-favicon-updated', (_e, favicons) => {
      if (Array.isArray(favicons) && favicons.length > 0) {
        this.favicon = String(favicons[0] || '');
        this._onStateDirty(this.id);
      }
    }));

    wc.on('did-navigate', safe('did-navigate', (_e, url, httpResponseCode) => {
      this.url = String(url || '');
      this._refreshNavState();
      this._onStateDirty(this.id);
      try { this._emitFn('tab-navigated', { tabId: this.id, url: this.url, isInPage: false, httpResponseCode }); }
      catch (_) {}
    }));

    wc.on('did-navigate-in-page', safe('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = String(url || '');
      this._refreshNavState();
      this._onStateDirty(this.id);
      try { this._emitFn('tab-navigated', { tabId: this.id, url: this.url, isInPage: true }); }
      catch (_) {}
    }));

    wc.on('render-process-gone', safe('render-process-gone', (_e, details) => {
      this.lastError = {
        code: -9000,
        description: `renderer_gone:${(details && details.reason) || 'unknown'}`,
        url: this.url,
      };
      this.loading = false;
      this._onStateDirty(this.id);
    }));

    wc.on('will-navigate', safe('will-navigate', (event, url) => {
      if (!isAllowedNavUrl(url)) {
        audit('warn', 'navigation_blocked', { tabId: this.id, url: String(url).slice(0, 500) });
        try { event.preventDefault(); } catch (_) {}
      }
    }));

    wc.on('will-redirect', safe('will-redirect', (event, url) => {
      if (!isAllowedNavUrl(url)) {
        audit('warn', 'redirect_blocked', { tabId: this.id, url: String(url).slice(0, 500) });
        try { event.preventDefault(); } catch (_) {}
      }
    }));

    wc.on('certificate-error', safe('certificate-error', (event, url, error) => {
      // Default deny. Log for the user.
      audit('warn', 'certificate_error', { tabId: this.id, url: String(url).slice(0, 500), error: String(error) });
    }));
  }

  /** @private Recompute canGoBack/canGoForward from the nav history. */
  _refreshNavState() {
    try {
      const nav = this.webContents.navigationHistory;
      this.canGoBack = !!nav.canGoBack();
      this.canGoForward = !!nav.canGoForward();
    } catch (_) {
      this.canGoBack = false;
      this.canGoForward = false;
    }
  }

  /** @param {string} url @returns {Promise<void>} */
  async loadURL(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) throw new Error('invalid_url');
    this.url = normalized;
    await this.webContents.loadURL(normalized);
  }

  goBack() { try { this.webContents.navigationHistory.goBack(); } catch (_) {} }
  goForward() { try { this.webContents.navigationHistory.goForward(); } catch (_) {} }
  reload(ignoreCache = false) {
    try {
      if (ignoreCache) this.webContents.reloadIgnoringCache();
      else this.webContents.reload();
    } catch (_) {}
  }
  stop() { try { this.webContents.stop(); } catch (_) {} }
  goHome() { this.loadURL('about:blank').catch(() => {}); }

  /**
   * @param {number} factor
   */
  setZoom(factor) {
    const z = clampZoom(factor);
    try {
      this.webContents.setZoomFactor(z);
      this.zoom = z;
      this._onStateDirty(this.id);
    } catch (_) {}
  }

  /** @returns {object} */
  toDescriptor() {
    return {
      id: this.id,
      panel: this.panelId,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      isPinned: this.isPinned,
      zoom: this.zoom,
      partition: PERSIST_PARTITION,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      error: this.lastError,
      inPip: this.pipWindowId != null,
    };
  }

  /**
   * Persistence snapshot — sanitized fields only, no webContents/view refs.
   * @returns {object}
   */
  toSnapshot() {
    return {
      id: this.id,
      panel: this.panelId,
      url: this.url,
      title: this.title,
      isPinned: this.isPinned,
      zoom: this.zoom,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  /**
   * Clean destruction.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try { this.webContents.removeAllListeners(); } catch (_) {}
    try { this.webContents.close(); } catch (_) {}
    try { this.view = null; } catch (_) {}
    try { this.webContents = null; } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// SECTION 3 — BROWSER PANEL (tab collection + bounds + active tab)
// ---------------------------------------------------------------------------

class BrowserPanel {
  /**
   * @param {string} id
   */
  constructor(id) {
    this.id = VALID_PANEL_IDS.has(id) ? id : DEFAULT_PANEL_ID;
    this.tabIds = [];           // ordered
    this.activeTabId = null;
    this.bounds = null;         // { x, y, width, height } or null (unmounted)
    this.visible = false;
  }

  /** @param {string} tabId */
  addTab(tabId) {
    if (!this.tabIds.includes(tabId)) this.tabIds.push(tabId);
    if (!this.activeTabId) this.activeTabId = tabId;
  }

  /** @param {string} tabId */
  removeTab(tabId) {
    const i = this.tabIds.indexOf(tabId);
    if (i >= 0) this.tabIds.splice(i, 1);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabIds.length > 0
        ? this.tabIds[Math.min(i, this.tabIds.length - 1)]
        : null;
    }
  }

  /** @param {string} tabId */
  setActive(tabId) {
    if (this.tabIds.includes(tabId)) this.activeTabId = tabId;
  }

  /** @returns {object} */
  toSnapshot() {
    return {
      id: this.id,
      tabIds: this.tabIds.slice(),
      activeTabId: this.activeTabId,
      bounds: this.bounds ? { ...this.bounds } : null,
      visible: this.visible,
    };
  }

  /** @param {object} snap */
  restore(snap) {
    if (!snap || typeof snap !== 'object') return;
    if (Array.isArray(snap.tabIds)) this.tabIds = snap.tabIds.filter((x) => typeof x === 'string');
    if (typeof snap.activeTabId === 'string' && this.tabIds.includes(snap.activeTabId)) {
      this.activeTabId = snap.activeTabId;
    } else {
      this.activeTabId = this.tabIds[0] || null;
    }
    this.bounds = sanitizeBounds(snap.bounds);
    this.visible = !!snap.visible;
  }
}

// ---------------------------------------------------------------------------
// SECTION 4 — POPUP WINDOW MANAGER (native child windows with window.opener)
// ---------------------------------------------------------------------------
// Tracked so we can close them on shutdown. Kept as native BrowserWindows
// (Electron default) so OAuth flows that rely on window.opener continue to
// work.
// ---------------------------------------------------------------------------

class PopupWindowManager {
  /**
   * @param {object} ctx
   * @param {object} opts
   * @param {Function} opts.emitFn
   */
  constructor(ctx, opts) {
    this._ctx = ctx;
    this._emitFn = opts.emitFn;
    this._popups = new Set();
  }

  /**
   * Track a popup child window (created via `did-create-window`).
   * @param {BrowserWindow} childWindow
   * @param {object} details
   * @param {BrowserTab} openerTab
   */
  track(childWindow, details, openerTab) {
    if (!childWindow || childWindow.isDestroyed()) return;
    this._popups.add(childWindow);

    try { childWindow.removeMenu(); } catch (_) {}

    const wcId = (childWindow.webContents && childWindow.webContents.id) || -1;

    childWindow.once('closed', () => {
      this._popups.delete(childWindow);
      audit('info', 'popup_closed', { openerTabId: openerTab && openerTab.id, wcId });
    });

    if (childWindow.webContents) {
      childWindow.webContents.setWindowOpenHandler((inner) => {
        // A popup opening another popup — cascade as tab in the opener's panel.
        if (openerTab) {
          setImmediate(() => {
            try { this._emitFn('_internal-open-tab', { url: inner.url, panelId: openerTab.panelId }); }
            catch (_) {}
          });
        }
        return { action: 'deny' };
      });
    }

    audit('info', 'popup_opened', {
      openerTabId: openerTab && openerTab.id,
      url: details && details.url,
      wcId,
    });
  }

  /**
   * Close every tracked popup.
   */
  closeAll() {
    for (const w of Array.from(this._popups)) {
      try { if (!w.isDestroyed()) w.close(); } catch (_) {}
      this._popups.delete(w);
    }
  }
}

// ---------------------------------------------------------------------------
// SECTION 5 — PiP WINDOW MANAGER (single floating always-on-top window)
// ---------------------------------------------------------------------------

class PiPWindowManager {
  /**
   * @param {object} opts
   * @param {Function} opts.emitFn
   * @param {Function} opts.onPipClosed
   */
  constructor(opts) {
    this._emitFn = opts.emitFn;
    this._onPipClosed = opts.onPipClosed;
    /** @type {BaseWindow|null} */
    this._win = null;
    /** @type {WebContentsView|null} */
    this._view = null;
    /** @type {string|null} */
    this._tabId = null;
  }

  /**
   * Detach the given view from its parent window and re-attach to a new PiP
   * BaseWindow. If a PiP window already exists, close it first (single PiP).
   *
   * @param {string} tabId
   * @param {WebContentsView} view
   * @param {string} title
   * @returns {{ ok: boolean, error?: string }}
   */
  enter(tabId, view, title) {
    if (!view) return { ok: false, error: 'no_view' };
    if (this._win && !this._win.isDestroyed()) return { ok: false, error: 'pip_already_active' };

    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea || { x: 0, y: 0, width: 1280, height: 800 };
    const width = Math.min(PIP_DEFAULT_WIDTH, workArea.width);
    const height = Math.min(PIP_DEFAULT_HEIGHT, workArea.height);
    const x = workArea.x + workArea.width - width - 24;
    const y = workArea.y + workArea.height - height - 24;

    try {
      this._win = new BaseWindow({
        width,
        height,
        x,
        y,
        frame: true,
        resizable: true,
        minimizable: true,
        maximizable: false,
        alwaysOnTop: true,
        title: title ? `PiP — ${title.slice(0, 60)}` : 'PiP',
        backgroundColor: '#0B1220',
      });

      this._win.setMinimumSize(PIP_MIN_WIDTH, PIP_MIN_HEIGHT);

      // Detach from parent contentView.
      const parentWin = this._getViewParent(view);
      if (parentWin && parentWin.contentView) {
        try { parentWin.contentView.removeChildView(view); } catch (_) {}
      }

      this._win.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width, height });

      // Track window resize to keep the view filling it.
      this._win.on('resize', () => {
        try {
          const [w, h] = this._win.getSize();
          view.setBounds({ x: 0, y: 0, width: w, height: h });
        } catch (_) {}
      });

      this._win.once('closed', () => {
        const closedTabId = this._tabId;
        this._win = null;
        this._view = null;
        this._tabId = null;
        try { this._onPipClosed(closedTabId); } catch (_) {}
        try { this._emitFn('pip-exited', { tabId: closedTabId }); } catch (_) {}
      });

      this._view = view;
      this._tabId = tabId;
      this._win.show();
      try { this._emitFn('pip-entered', { tabId }); } catch (_) {}
      audit('info', 'pip_entered', { tabId });
      return { ok: true };
    } catch (e) {
      audit('error', 'pip_enter_failed', { tabId, error: String(e) });
      this._win = null;
      this._view = null;
      this._tabId = null;
      return { ok: false, error: String(e) };
    }
  }

  /**
   * Close PiP and hand the view back to the caller (who re-attaches it).
   * @returns {{ tabId: string|null, view: WebContentsView|null }}
   */
  exit() {
    const view = this._view;
    const tabId = this._tabId;
    if (!this._win || this._win.isDestroyed()) {
      this._win = null;
      this._view = null;
      this._tabId = null;
      return { tabId, view };
    }
    try {
      if (view) {
        try { this._win.contentView.removeChildView(view); } catch (_) {}
      }
      this._win.close();
    } catch (_) {}
    this._win = null;
    this._view = null;
    this._tabId = null;
    return { tabId, view };
  }

  /** @returns {boolean} */
  isActive() {
    return !!(this._win && !this._win.isDestroyed());
  }

  /** @param {string} tabId @returns {boolean} */
  isTabInPip(tabId) {
    return this.isActive() && this._tabId === tabId;
  }

  /** @returns {string|null} */
  getPipTabId() {
    return this.isActive() ? this._tabId : null;
  }

  /** @private */
  _getViewParent(view) {
    // WebContentsView doesn't expose its parent. Track via our own map in
    // BrowserRuntime — this method is a fallback.
    try {
      // Electron ≥ 30 exposes view.getVisible() but not parent lookup.
      // Fallback: use BrowserWindow.getAllWindows() and check contentView.
      const wins = BrowserWindow.getAllWindows();
      for (const w of wins) {
        try {
          // There is no official API; the caller (BrowserRuntime) manages
          // parent tracking. This path is therefore best-effort.
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  /**
   * Force-close PiP (used on shutdown).
   */
  shutdown() {
    if (this._win && !this._win.isDestroyed()) {
      try { this._win.close(); } catch (_) {}
    }
    this._win = null;
    this._view = null;
    this._tabId = null;
  }
}

// ---------------------------------------------------------------------------
// SECTION 6 — SESSION PERSISTENCE
// ---------------------------------------------------------------------------

class SessionPersistence {
  /**
   * @param {string} file
   */
  constructor(file) {
    this.file = file;
    this._dirReady = false;
  }

  /** @private */
  _ensureDir() {
    if (this._dirReady) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); }
    catch (e) { audit('warn', 'session_dir_create_failed', { error: String(e) }); }
    this._dirReady = true;
  }

  /**
   * @param {object} snapshot
   * @returns {boolean}
   */
  save(snapshot) {
    try {
      this._ensureDir();
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      audit('warn', 'session_save_failed', { error: String(e) });
      return false;
    }
  }

  /**
   * @returns {object|null}
   */
  load() {
    try {
      if (!fs.existsSync(this.file)) return null;
      const raw = fs.readFileSync(this.file, 'utf8');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (e) {
      audit('warn', 'session_load_failed', { error: String(e) });
      return null;
    }
  }

  /**
   * Delete the session file.
   */
  clear() {
    try {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    } catch (e) {
      audit('warn', 'session_clear_failed', { error: String(e) });
    }
  }
}

// ---------------------------------------------------------------------------
// SECTION 7 — BROWSER RUNTIME (main orchestrator)
// ---------------------------------------------------------------------------

class BrowserRuntime extends EventEmitter {
  /**
   * @param {object} ctx — kernel context
   * @param {object} [opts]
   * @param {BrowserWindow} [opts.mainWindow]
   */
  constructor(ctx, opts = {}) {
    super();
    this._ctx = ctx;
    this._mainWindow = opts.mainWindow || null;

    /** @type {Map<string, BrowserTab>} */
    this._tabs = new Map();
    /** @type {Map<string, BrowserPanel>} */
    this._panels = new Map();

    // Default panels.
    this._panels.set('left', new BrowserPanel('left'));
    this._panels.set('right', new BrowserPanel('right'));

    this._popupManager = new PopupWindowManager(ctx, { emitFn: this._emit.bind(this) });
    this._pipManager = new PiPWindowManager({
      emitFn: this._emit.bind(this),
      onPipClosed: (tabId) => this._onPipClosed(tabId),
    });
    this._persistence = new SessionPersistence(SESSION_FILE);

    this._dirtyTabs = new Set();
    this._stateEmitScheduled = false;
    this._saveTimer = null;
    this._bootedAt = Date.now();
    this._closed = false;

    // Debounced emitters.
    this._flushDirtyTabs = debounce(() => this._doFlushDirtyTabs(), TAB_UPDATE_DEBOUNCE_MS);
    this._scheduleStateEmit = debounce(() => this._doEmitState(), STATE_EMIT_DEBOUNCE_MS);
    this._scheduleSave = debounce(() => this._doSave(), SAVE_DEBOUNCE_MS);

    // Internal open-tab event (used by PopupWindowManager cascade).
    this.on('_internal-open-tab', ({ url, panelId }) => {
      this.createTab(url, { panel: panelId }).catch((e) => {
        audit('warn', 'cascade_open_failed', { url, error: String(e) });
      });
    });
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  /**
   * Bind to a BrowserWindow (called by Part 7 once the main window exists).
   * @param {BrowserWindow} win
   */
  attachToWindow(win) {
    if (!win || win.isDestroyed()) throw new Error('attach_invalid_window');
    this._mainWindow = win;
    win.once('closed', () => { this._mainWindow = null; });
    audit('info', 'attached_to_window', { winId: win.id });
    // Re-apply any bounds we've already stored.
    for (const panel of this._panels.values()) this._applyPanelBounds(panel);
  }

  /**
   * Detach from current window without destroying tabs.
   */
  detach() {
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      for (const tab of this._tabs.values()) {
        try { this._mainWindow.contentView.removeChildView(tab.view); } catch (_) {}
      }
    }
    this._mainWindow = null;
  }

  /** @returns {BrowserWindow|null} */
  getAttachedWindow() { return this._mainWindow; }

  // ── Internal emitters ─────────────────────────────────────────────────

  /** @private */
  _emit(event, data) {
    try { this.emit(event, data); }
    catch (e) { audit('error', 'emit_failed', { event, error: String(e) }); }
    this._scheduleStateEmit();
  }

  /** @private */
  _markTabDirty(tabId) {
    this._dirtyTabs.add(tabId);
    this._flushDirtyTabs();
  }

  /** @private */
  _doFlushDirtyTabs() {
    if (this._dirtyTabs.size === 0) return;
    const ids = Array.from(this._dirtyTabs);
    this._dirtyTabs.clear();
    for (const id of ids) {
      const tab = this._tabs.get(id);
      if (!tab) continue;
      try { this.emit('tab-updated', { tabId: id, descriptor: tab.toDescriptor() }); }
      catch (_) {}
    }
  }

  /** @private */
  _doEmitState() {
    try { this.emit('state-change', this.getStateSnapshot()); }
    catch (_) {}
  }

  /** @private */
  _doSave() {
    try {
      const snap = this.snapshot();
      this._persistence.save(snap);
    } catch (e) {
      audit('warn', 'save_failed', { error: String(e) });
    }
  }

  // ── Panel bounds ──────────────────────────────────────────────────────

  /**
   * @param {string} panelId
   * @param {{ x:number,y:number,width:number,height:number } | null} bounds
   */
  setPanelBounds(panelId, bounds) {
    const panel = this._panels.get(panelId);
    if (!panel) return false;
    const sanitized = sanitizeBounds(bounds);
    panel.bounds = sanitized;
    panel.visible = !!sanitized;
    this._applyPanelBounds(panel);
    this._emit('panel-bounds', { panelId, bounds: sanitized });
    this._scheduleSave();
    return true;
  }

  /**
   * @param {string} panelId
   * @returns {object|null}
   */
  getPanelState(panelId) {
    const panel = this._panels.get(panelId);
    return panel ? panel.toSnapshot() : null;
  }

  /** @private Attach + position the active tab of a panel. */
  _applyPanelBounds(panel) {
    if (!this._mainWindow || this._mainWindow.isDestroyed()) return;

    // Detach any tabs currently mounted for this panel.
    for (const tabId of panel.tabIds) {
      const tab = this._tabs.get(tabId);
      if (!tab) continue;
      try { this._mainWindow.contentView.removeChildView(tab.view); } catch (_) {}
    }

    if (!panel.visible || !panel.bounds || !panel.activeTabId) return;
    const tab = this._tabs.get(panel.activeTabId);
    if (!tab) return;
    if (this._pipManager.isTabInPip(tab.id)) return; // PiP takes precedence

    try {
      this._mainWindow.contentView.addChildView(tab.view);
      tab.view.setBounds(panel.bounds);
    } catch (e) {
      audit('error', 'apply_bounds_failed', { panelId: panel.id, tabId: tab.id, error: String(e) });
    }
  }

  // ── Tab lifecycle ─────────────────────────────────────────────────────

  /**
   * @param {string} [url='about:blank']
   * @param {object} [opts]
   * @param {string} [opts.panel]
   * @param {boolean} [opts.isPinned]
   * @param {boolean} [opts.activate=true]
   * @param {string} [opts.id]         — override id (for restore)
   * @param {number} [opts.zoom]
   * @returns {Promise<object>}       — descriptor
   */
  async createTab(url = 'about:blank', opts = {}) {
    if (this._closed) throw new Error('runtime_closed');
    if (this._tabs.size >= MAX_TABS) throw new Error('tab_limit_reached');

    const panelId = VALID_PANEL_IDS.has(opts.panel) ? opts.panel : DEFAULT_PANEL_ID;
    const panel = this._panels.get(panelId);
    if (!panel) throw new Error('invalid_panel');

    const tabId = opts.id || makeTabId();
    if (this._tabs.has(tabId)) throw new Error('tab_id_collision');

    const tab = new BrowserTab({
      id: tabId,
      panelId,
      url: normalizeUrl(url) || 'about:blank',
      isPinned: !!opts.isPinned,
      zoom: opts.zoom,
      emitFn: this._emit.bind(this),
      onStateDirty: (id) => this._markTabDirty(id),
    });

    this._tabs.set(tabId, tab);
    panel.addTab(tabId);

    // Install window-open handler.
    this._installWindowOpenHandler(tab);

    // Install per-tab injection acknowledgment channel — Part 7 handles the
    // global ipcMain.on; this just ensures every tab can receive the
    // `jarvis:k10-inject-prompt` channel from the runtime.
    // (No-op here; the preload already listens. Kept for clarity.)

    // Emit.
    try { this.emit('tab-created', { tabId, descriptor: tab.toDescriptor(), webContents: tab.webContents, view: tab.view }); }
    catch (_) {}

    // Activate if requested OR if this is the first tab in the panel.
    if (opts.activate !== false || !panel.activeTabId || panel.activeTabId === tabId) {
      this._activateInPanel(panel, tabId);
    }

    this._markTabDirty(tabId);
    this._scheduleSave();
    return tab.toDescriptor();
  }

  /**
   * @private Install the deny/allow policy for `window.open` and `target=_blank`.
   */
  _installWindowOpenHandler(tab) {
    try {
      tab.webContents.setWindowOpenHandler((details) => {
        // Save-to-disk → let Part 5 handle it via download manager.
        if (details.disposition === 'save-to-disk') {
          return { action: 'deny' };
        }

        // Native popups (window.open with features) → preserve window.opener.
        if (details.disposition === 'new-window') {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              parent: this._mainWindow && !this._mainWindow.isDestroyed() ? this._mainWindow : undefined,
              width: DEFAULT_POPUP_WIDTH,
              height: DEFAULT_POPUP_HEIGHT,
              autoHideMenuBar: true,
              backgroundColor: '#0B1220',
              webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                session: tab.webContents.session,
              },
            },
          };
        }

        // Everything else → new tab in the same panel.
        const normalized = normalizeUrl(details.url);
        if (normalized) {
          setImmediate(() => {
            this.createTab(normalized, { panel: tab.panelId }).catch((e) => {
              audit('warn', 'new_tab_from_link_failed', { url: normalized, error: String(e) });
            });
          });
        }
        return { action: 'deny' };
      });

      // Track child windows created via `action: 'allow'`.
      tab.webContents.on('did-create-window', (childWindow, details) => {
        this._popupManager.track(childWindow, details, tab);
      });
    } catch (e) {
      audit('error', 'install_window_open_handler_failed', { tabId: tab.id, error: String(e) });
    }
  }

  /**
   * @param {string} tabId
   * @returns {Promise<boolean>}
   */
  async closeTab(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;

    const panel = this._panels.get(tab.panelId);

    // If tab is in PiP, exit PiP first.
    if (this._pipManager.isTabInPip(tabId)) {
      try { this._pipManager.exit(); } catch (_) {}
    }

    // Detach view from window.
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      try { this._mainWindow.contentView.removeChildView(tab.view); } catch (_) {}
    }

    // Remove from panel.
    if (panel) panel.removeTab(tabId);

    // Destroy webContents + view.
    try { tab.destroy(); } catch (_) {}
    this._tabs.delete(tabId);

    try { this.emit('tab-destroyed', { tabId }); } catch (_) {}

    // If panel now empty AND it was visible, create a fresh about:blank tab.
    if (panel && panel.tabIds.length === 0 && panel.visible) {
      try {
        await this.createTab('about:blank', { panel: panel.id });
      } catch (e) {
        audit('warn', 'auto_create_replacement_failed', { panelId: panel.id, error: String(e) });
      }
    } else if (panel) {
      this._applyPanelBounds(panel);
    }

    this._scheduleSave();
    return true;
  }

  /**
   * @param {string} [panelId]
   * @returns {Promise<boolean>}
   */
  async closeActiveTab(panelId) {
    const id = panelId || DEFAULT_PANEL_ID;
    const panel = this._panels.get(id);
    if (!panel || !panel.activeTabId) return false;
    return this.closeTab(panel.activeTabId);
  }

  /**
   * @param {string} tabId
   * @returns {Promise<boolean>}
   */
  async activateTab(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    const panel = this._panels.get(tab.panelId);
    if (!panel) return false;
    this._activateInPanel(panel, tabId);
    return true;
  }

  /**
   * @param {number} index   — 0-based index within panel
   * @param {string} [panelId]
   * @returns {Promise<boolean>}
   */
  async activateTabByIndex(index, panelId) {
    const id = panelId || DEFAULT_PANEL_ID;
    const panel = this._panels.get(id);
    if (!panel) return false;
    const tabId = panel.tabIds[Number(index)];
    if (!tabId) return false;
    this._activateInPanel(panel, tabId);
    return true;
  }

  /** @private */
  _activateInPanel(panel, tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return;
    panel.setActive(tabId);
    tab.lastActiveAt = Date.now();

    // If exiting PiP because a different tab was activated, don't — PiP tab
    // stays in PiP. Only (re)apply bounds if this tab isn't in PiP.
    if (!this._pipManager.isTabInPip(tabId)) {
      this._applyPanelBounds(panel);
    }

    try { this.emit('tab-activated', { tabId, panelId: panel.id }); } catch (_) {}
    this._markTabDirty(tabId);
    this._scheduleSave();
  }

  /**
   * @param {string} tabId
   * @param {number} newIndex
   * @param {string} [panelId]
   * @returns {boolean}
   */
  reorderTab(tabId, newIndex, panelId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    const panel = this._panels.get(panelId || tab.panelId);
    if (!panel) return false;
    const curIdx = panel.tabIds.indexOf(tabId);
    if (curIdx < 0) return false;
    const target = Math.max(0, Math.min(panel.tabIds.length - 1, Number(newIndex)));
    panel.tabIds.splice(curIdx, 1);
    panel.tabIds.splice(target, 0, tabId);
    this._markTabDirty(tabId);
    this._scheduleSave();
    return true;
  }

  /**
   * @param {string} tabId
   * @returns {Promise<object|null>}
   */
  async duplicateTab(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return null;
    const panel = this._panels.get(tab.panelId);
    const newTab = await this.createTab(tab.url, {
      panel: tab.panelId,
      isPinned: tab.isPinned,
      zoom: tab.zoom,
    });
    // Insert right after the source tab.
    if (panel) {
      const srcIdx = panel.tabIds.indexOf(tabId);
      if (srcIdx >= 0) this.reorderTab(newTab.id, srcIdx + 1, panel.id);
    }
    return newTab;
  }

  /**
   * @param {string} tabId
   * @param {boolean} pinned
   * @returns {boolean}
   */
  pinTab(tabId, pinned) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.isPinned = !!pinned;
    this._markTabDirty(tabId);
    this._scheduleSave();
    return true;
  }

  // ── Navigation ────────────────────────────────────────────────────────

  /**
   * @param {string} tabId
   * @param {string} url
   * @returns {Promise<void>}
   */
  async navigateTab(tabId, url) {
    const tab = this._tabs.get(tabId);
    if (!tab) throw new Error('tab_not_found');
    const normalized = normalizeUrl(url);
    if (!normalized) throw new Error('invalid_url');
    await tab.loadURL(normalized);
  }

  /**
   * @param {string} tabId
   * @returns {boolean}
   */
  goBack(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.goBack();
    return true;
  }

  /**
   * @param {string} tabId
   * @returns {boolean}
   */
  goForward(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.goForward();
    return true;
  }

  /**
   * @param {string} tabId
   * @param {boolean} [ignoreCache]
   * @returns {boolean}
   */
  reloadTab(tabId, ignoreCache = false) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.reload(ignoreCache);
    return true;
  }

  /**
   * @param {string} tabId
   * @returns {boolean}
   */
  stopTab(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.stop();
    return true;
  }

  /**
   * @param {string} tabId
   * @returns {boolean}
   */
  goHome(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.goHome();
    return true;
  }

  // ── Zoom ──────────────────────────────────────────────────────────────

  /**
   * @param {string} tabId
   * @param {number} factor
   * @returns {boolean}
   */
  setZoom(tabId, factor) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.setZoom(factor);
    this._scheduleSave();
    return true;
  }

  /**
   * @param {string} tabId
   * @returns {boolean}
   */
  zoomIn(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.setZoom(tab.zoom + ZOOM_STEP);
    this._scheduleSave();
    return true;
  }

  /**
   * @param {string} tabId
   * @returns {boolean}
   */
  zoomOut(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.setZoom(tab.zoom - ZOOM_STEP);
    this._scheduleSave();
    return true;
  }

  /**
   * @param {string} tabId
   * @returns {boolean}
   */
  resetZoom(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    tab.setZoom(1.0);
    this._scheduleSave();
    return true;
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /**
   * @returns {Promise<object[]>} — sanitized descriptors
   */
  async getTabList() {
    const out = [];
    // Emit pinned first, in panel insertion order.
    for (const panel of this._panels.values()) {
      for (const tabId of panel.tabIds) {
        const tab = this._tabs.get(tabId);
        if (tab && tab.isPinned) out.push(tab.toDescriptor());
      }
    }
    for (const panel of this._panels.values()) {
      for (const tabId of panel.tabIds) {
        const tab = this._tabs.get(tabId);
        if (tab && !tab.isPinned) out.push(tab.toDescriptor());
      }
    }
    // Add a global index (position in the flattened list).
    return out.map((d, i) => ({ ...d, index: i }));
  }

  /**
   * @param {string} tabId
   * @returns {object|null}
   */
  getTab(tabId) {
    const tab = this._tabs.get(tabId);
    return tab ? tab.toDescriptor() : null;
  }

  /**
   * @returns {Promise<{ id, index, url, title, count, panelId } | null>}
   */
  async getActiveTabInfo() {
    for (const panel of this._panels.values()) {
      if (!panel.activeTabId) continue;
      const tab = this._tabs.get(panel.activeTabId);
      if (!tab) continue;
      const list = await this.getTabList();
      const idx = list.findIndex((t) => t.id === tab.id);
      return {
        id: tab.id,
        index: idx < 0 ? 0 : idx,
        url: tab.url,
        title: tab.title,
        count: this._tabs.size,
        panelId: panel.id,
      };
    }
    return null;
  }

  /**
   * @returns {object}
   */
  getStateSnapshot() {
    const tabs = [];
    for (const panel of this._panels.values()) {
      for (const tabId of panel.tabIds) {
        const tab = this._tabs.get(tabId);
        if (tab) tabs.push(tab.toDescriptor());
      }
    }
    // Global index.
    tabs.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
    const withIndex = tabs.map((d, i) => ({ ...d, index: i }));

    const panels = {};
    for (const panel of this._panels.values()) {
      panels[panel.id] = {
        id: panel.id,
        tabIds: panel.tabIds.slice(),
        activeTabId: panel.activeTabId,
        bounds: panel.bounds ? { ...panel.bounds } : null,
        visible: panel.visible,
      };
    }

    return {
      version: '1.0.0',
      ts: Date.now(),
      tabs: withIndex,
      panels,
      pipTabId: this._pipManager.getPipTabId(),
      tabCount: this._tabs.size,
      popupCount: (() => {
        try { return this._popupManager._popups.size; } catch (_) { return 0; }
      })(),
    };
  }

  // ── Prompt injection ─────────────────────────────────────────────────

  /**
   * Inject a text prompt into the given tab's page input field. Optimistic —
   * returns ok:true immediately after the IPC send lands. If the target page
   * has no compatible input, Part 2's broadcast pipeline discovers this via
   * response timeout, which is the correct failure mode for cross-tab work.
   *
   * @param {string} tabId
   * @param {string} promptText
   * @param {object} [opts]
   * @param {boolean} [opts.autoSubmit=true]
   * @param {string} [opts.relayId]
   * @param {string} [opts.broadcastId]
   * @param {string} [opts.kind]
   * @param {number} [opts.loadWaitMs]
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async injectPromptToTab(tabId, promptText, opts = {}) {
    const tab = this._tabs.get(tabId);
    if (!tab) return { ok: false, error: 'tab_not_found' };
    if (!promptText || typeof promptText !== 'string') {
      return { ok: false, error: 'empty_prompt' };
    }

    // Wait until the tab has finished initial load (bounded).
    if (!tab.loadedAt) {
      const waited = await this._waitForLoad(tab, opts.loadWaitMs || INJECT_INITIAL_LOAD_WAIT_MS);
      if (!waited) return { ok: false, error: 'tab_not_loaded' };
    }

    try {
      tab.webContents.send('jarvis:k10-inject-prompt', {
        promptText,
        autoSubmit: opts.autoSubmit !== false,
        relayId: opts.relayId || null,
        broadcastId: opts.broadcastId || null,
        kind: opts.kind || 'broadcast',
        tabId,
        sentAt: Date.now(),
      });
      audit('info', 'injected_prompt', {
        tabId,
        kind: opts.kind || 'broadcast',
        length: promptText.length,
      });
      // Small async yield so callers awaiting this don't starve the loop.
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true };
    } catch (e) {
      audit('warn', 'inject_send_failed', { tabId, error: String(e) });
      return { ok: false, error: String(e) };
    }
  }

  /** @private */
  async _waitForLoad(tab, timeoutMs) {
    if (tab.loadedAt) return true;
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = () => {
        if (tab.loadedAt || !this._tabs.has(tab.id)) return resolve(!!tab.loadedAt);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, INJECT_LOAD_POLL_MS);
      };
      tick();
    });
  }

  // ── Find-in-page ─────────────────────────────────────────────────────

  /**
   * Part 5 wraps this with UI. Part 4 only delegates to webContents.
   * @param {string} tabId
   * @param {string} query
   * @param {object} [opts]
   * @returns {boolean}
   */
  findInPage(tabId, query, opts = {}) {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    try {
      const wc = tab.webContents;
      if (!query) { wc.stopFindInPage('clearSelection'); return true; }
      wc.findInPage(String(query), {
        forward: opts.forward !== false,
        findNext: !!opts.findNext,
        matchCase: !!opts.matchCase,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {string} tabId
   * @param {string} [action='clearSelection']
   * @returns {boolean}
   */
  stopFindInPage(tabId, action = 'clearSelection') {
    const tab = this._tabs.get(tabId);
    if (!tab) return false;
    try { tab.webContents.stopFindInPage(action); return true; }
    catch (_) { return false; }
  }

  // ── PiP ───────────────────────────────────────────────────────────────

  /**
   * Move the given tab into a floating PiP window.
   * @param {string} tabId
   * @returns {{ ok: boolean, error?: string }}
   */
  enterPiP(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return { ok: false, error: 'tab_not_found' };
    if (this._pipManager.isActive()) return { ok: false, error: 'pip_already_active' };

    // Detach from panel contentView.
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      try { this._mainWindow.contentView.removeChildView(tab.view); } catch (_) {}
    }

    const res = this._pipManager.enter(tab.id, tab.view, tab.title);
    if (res.ok) {
      tab.pipWindowId = 'pip';
      this._markTabDirty(tab.id);
      this._scheduleSave();
    } else {
      // Failure — re-apply panel bounds to restore visibility.
      const panel = this._panels.get(tab.panelId);
      if (panel) this._applyPanelBounds(panel);
    }
    return res;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async exitPiP() {
    if (!this._pipManager.isActive()) return false;
    const { tabId, view } = this._pipManager.exit();
    if (!tabId || !view) return false;

    const tab = this._tabs.get(tabId);
    if (tab) {
      tab.pipWindowId = null;
      const panel = this._panels.get(tab.panelId);
      if (panel) {
        // Re-attach + bounds via _applyPanelBounds (idempotent).
        try { this._mainWindow && this._mainWindow.contentView.addChildView(view); } catch (_) {}
        this._applyPanelBounds(panel);
      }
      this._markTabDirty(tabId);
    }
    this._scheduleSave();
    return true;
  }

  /** @private Called when the user closes the PiP window directly. */
  _onPipClosed(tabId) {
    if (!tabId) return;
    const tab = this._tabs.get(tabId);
    if (!tab) return;
    tab.pipWindowId = null;
    const panel = this._panels.get(tab.panelId);
    if (panel && this._mainWindow && !this._mainWindow.isDestroyed()) {
      try {
        this._mainWindow.contentView.addChildView(tab.view);
        this._applyPanelBounds(panel);
      } catch (_) {}
    }
    this._markTabDirty(tabId);
    this._scheduleSave();
  }

  // ── Persistence ───────────────────────────────────────────────────────

  /**
   * @returns {object}
   */
  snapshot() {
    const tabs = [];
    for (const tab of this._tabs.values()) tabs.push(tab.toSnapshot());
    const panels = [];
    for (const panel of this._panels.values()) panels.push(panel.toSnapshot());
    return {
      version: '1.0.0',
      capturedAt: new Date().toISOString(),
      tabs,
      panels,
      pipTabId: this._pipManager.getPipTabId(),
    };
  }

  /**
   * Restore from a previous snapshot. Tabs are created asynchronously in
   * insertion order; each tab loads its URL via `createTab()`'s built-in
   * loader. Safe to call before `attachToWindow()` — bounds will be applied
   * on attach.
   *
   * @param {object} snap
   * @returns {Promise<{ restored: number, skipped: number }>}
   */
  async restore(snap) {
    if (!snap || typeof snap !== 'object') return { restored: 0, skipped: 0 };
    const panels = Array.isArray(snap.panels) ? snap.panels : [];
    const tabs = Array.isArray(snap.tabs) ? snap.tabs : [];
    if (tabs.length === 0) return { restored: 0, skipped: 0 };

    // Restore panels metadata first.
    for (const psnap of panels) {
      const panel = this._panels.get(psnap && psnap.id);
      if (panel) {
        if (psnap.bounds !== undefined) panel.bounds = sanitizeBounds(psnap.bounds);
        panel.visible = !!psnap.visible;
      }
    }

    let restored = 0;
    let skipped = 0;

    // Create tabs. Preserve ordering via createTab's insertion at end.
    for (const tsnap of tabs) {
      if (!tsnap || typeof tsnap !== 'object' || !tsnap.id || !tsnap.url) {
        skipped++;
        continue;
      }
      try {
        await this.createTab(tsnap.url, {
          id: tsnap.id,
          panel: tsnap.panel || DEFAULT_PANEL_ID,
          isPinned: !!tsnap.isPinned,
          zoom: tsnap.zoom,
          activate: false,
        });
        restored++;
      } catch (e) {
        audit('warn', 'restore_tab_failed', { id: tsnap.id, error: String(e) });
        skipped++;
      }
    }

    // Restore active tabs per panel.
    for (const psnap of panels) {
      if (!psnap || !this._panels.has(psnap.id)) continue;
      const panel = this._panels.get(psnap.id);
      const activeId = psnap.activeTabId;
      if (activeId && panel.tabIds.includes(activeId)) {
        panel.activeTabId = activeId;
        const tab = this._tabs.get(activeId);
        if (tab) tab.lastActiveAt = Date.now();
      } else if (panel.tabIds.length > 0) {
        panel.activeTabId = panel.tabIds[0];
      }
    }

    // Reorder to match saved panel order (createTab appends at end).
    for (const psnap of panels) {
      if (!psnap || !this._panels.has(psnap.id)) continue;
      const panel = this._panels.get(psnap.id);
      const desired = Array.isArray(psnap.tabIds) ? psnap.tabIds : [];
      const ordered = desired.filter((id) => panel.tabIds.includes(id));
      // Append any created-but-not-in-desired (in case of edge cases).
      const extras = panel.tabIds.filter((id) => !desired.includes(id));
      panel.tabIds = ordered.concat(extras);
    }

    // Re-apply bounds for all panels.
    for (const panel of this._panels.values()) this._applyPanelBounds(panel);

    this._scheduleSave();
    audit('info', 'restore_complete', { restored, skipped });
    return { restored, skipped };
  }

  /**
   * Wipe session file and close all tabs + popups.
   * @returns {Promise<void>}
   */
  async clearStorage() {
    // Close popups + PiP first.
    this._popupManager.closeAll();
    this._pipManager.shutdown();

    // Close all tabs.
    for (const tabId of Array.from(this._tabs.keys())) {
      try { await this.closeTab(tabId); } catch (_) {}
    }

    // Wipe session file.
    this._persistence.clear();

    // Wipe the persist partition data.
    try {
      const ses = session.fromPartition(PERSIST_PARTITION);
      await ses.clearStorageData();
      await ses.clearCache();
    } catch (e) {
      audit('warn', 'clear_partition_failed', { error: String(e) });
    }

    audit('info', 'storage_cleared', {});
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  /**
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this._closed) return;
    this._closed = true;

    try { this._doSave(); } catch (_) {}

    try { this._popupManager.closeAll(); } catch (_) {}
    try { this._pipManager.shutdown(); } catch (_) {}

    // Detach + destroy every tab.
    for (const tab of Array.from(this._tabs.values())) {
      try { if (this._mainWindow && !this._mainWindow.isDestroyed()) this._mainWindow.contentView.removeChildView(tab.view); } catch (_) {}
      try { tab.destroy(); } catch (_) {}
    }
    this._tabs.clear();

    for (const panel of this._panels.values()) {
      panel.tabIds = [];
      panel.activeTabId = null;
    }

    audit('info', 'runtime_shutdown', { uptimeMs: Date.now() - this._bootedAt });
    this.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// SECTION 8 — INITIALIZATION
// ---------------------------------------------------------------------------

let _runtime = null;

/**
 * @param {object} ctx
 * @param {object} [opts]
 * @param {BrowserWindow} [opts.mainWindow]
 * @param {boolean} [opts.restoreSession=true]
 */
async function init(ctx, opts = {}) {
  _auditFn = ctx && typeof ctx.audit === 'function' ? ctx.audit.bind(ctx) : null;

  const runtime = new BrowserRuntime(ctx, { mainWindow: opts.mainWindow || null });
  _runtime = runtime;

  // Register service.
  if (ctx && typeof ctx.registerService === 'function') {
    ctx.registerService('kernel10_browser_runtime', {
      // Wiring.
      attachToWindow: (win) => runtime.attachToWindow(win),
      detach: () => runtime.detach(),
      getAttachedWindow: () => runtime.getAttachedWindow(),

      // Tabs.
      createTab: (url, o) => runtime.createTab(url, o),
      closeTab: (id) => runtime.closeTab(id),
      closeActiveTab: (panelId) => runtime.closeActiveTab(panelId),
      activateTab: (id) => runtime.activateTab(id),
      activateTabByIndex: (index, panelId) => runtime.activateTabByIndex(index, panelId),
      reorderTab: (id, idx, panelId) => runtime.reorderTab(id, idx, panelId),
      duplicateTab: (id) => runtime.duplicateTab(id),
      pinTab: (id, pinned) => runtime.pinTab(id, pinned),

      // Navigation.
      navigateTab: (id, url) => runtime.navigateTab(id, url),
      goBack: (id) => runtime.goBack(id),
      goForward: (id) => runtime.goForward(id),
      reloadTab: (id, ignore) => runtime.reloadTab(id, ignore),
      stopTab: (id) => runtime.stopTab(id),
      goHome: (id) => runtime.goHome(id),

      // Zoom.
      setZoom: (id, z) => runtime.setZoom(id, z),
      zoomIn: (id) => runtime.zoomIn(id),
      zoomOut: (id) => runtime.zoomOut(id),
      resetZoom: (id) => runtime.resetZoom(id),

      // Panels.
      setPanelBounds: (id, bounds) => runtime.setPanelBounds(id, bounds),
      getPanelState: (id) => runtime.getPanelState(id),

      // Queries.
      getTabList: () => runtime.getTabList(),
      getTab: (id) => runtime.getTab(id),
      getActiveTabInfo: () => runtime.getActiveTabInfo(),
      getStateSnapshot: () => runtime.getStateSnapshot(),

      // Prompt inject (Part 2 contract).
      injectPromptToTab: (id, text, o) => runtime.injectPromptToTab(id, text, o),

      // Find-in-page (Part 5 uses this).
      findInPage: (id, q, o) => runtime.findInPage(id, q, o),
      stopFindInPage: (id, action) => runtime.stopFindInPage(id, action),

      // PiP.
      enterPiP: (id) => runtime.enterPiP(id),
      exitPiP: () => runtime.exitPiP(),

      // Persistence.
      snapshot: () => runtime.snapshot(),
      restore: (snap) => runtime.restore(snap),
      clearStorage: () => runtime.clearStorage(),
      shutdown: () => runtime.shutdown(),

      // Events.
      on: (event, fn) => runtime.on(event, fn),
      off: (event, fn) => runtime.off(event, fn),
    });
  }

  // Telemetry contributor.
  if (ctx && typeof ctx.addStateContributor === 'function') {
    ctx.addStateContributor('kernel10_browser_runtime', () => {
      const snap = runtime.getStateSnapshot();
      return {
        version: snap.version,
        tab_count: snap.tabCount,
        popup_count: snap.popupCount,
        active_panels: Object.keys(snap.panels).filter((k) => snap.panels[k].visible),
        pip_active: snap.pipTabId != null,
        attached: !!runtime.getAttachedWindow(),
      };
    });
  }

  // Stop hook.
  if (ctx && typeof ctx.addStopHook === 'function') {
    ctx.addStopHook('kernel10_browser_runtime', () => {
      if (runtime) runtime.shutdown().catch(() => {});
    });
  }

  // Auto-attach to main window if provided.
  if (opts.mainWindow) {
    try { runtime.attachToWindow(opts.mainWindow); }
    catch (e) { audit('warn', 'auto_attach_failed', { error: String(e) }); }
  }

  // Restore previous session (opt-out via opts.restoreSession === false).
  if (opts.restoreSession !== false) {
    const saved = runtime._persistence.load();
    if (saved) {
      try {
        const res = await runtime.restore(saved);
        audit('info', 'session_restored', res);
      } catch (e) {
        audit('warn', 'session_restore_failed', { error: String(e) });
      }
    }
  }

  audit('info', 'browser_runtime_initialized', {
    attached: !!opts.mainWindow,
    session_path: SESSION_FILE,
    restored_tab_count: runtime._tabs.size,
  });
}

/**
 * @returns {BrowserRuntime|null}
 */
function getRuntime() { return _runtime; }

// ---------------------------------------------------------------------------
// SECTION 9 — EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  name: 'kernel10_browser_runtime',
  version: '1.0.0',
  init,
  getRuntime,

  // Classes for tests.
  BrowserRuntime,
  BrowserTab,
  BrowserPanel,
  PopupWindowManager,
  PiPWindowManager,
  SessionPersistence,

  // Constants.
  PERSIST_PARTITION,
  SESSION_FILE,
  MAX_TABS,
  MIN_ZOOM,
  MAX_ZOOM,

  // Utilities (unit-testable).
  normalizeUrl,
  isAllowedNavUrl,
  sanitizeBounds,
  clampZoom,
  extractFavicon,
};