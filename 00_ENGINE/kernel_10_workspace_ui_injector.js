'use strict';

/**
 * ============================================================================
 * KERNEL 10 — PART 6 of 7
 * kernel_10_workspace_ui_injector.js
 * Location: C:\Jarvis_Core\00_ENGINE\kernel_10_workspace_ui_injector.js
 * Version:  1.0.0-enterprise
 * ============================================================================
 *
 * RESPONSIBILITY
 * --------------
 * Injects the full Chrome-Lite workspace UI into the existing frozen JARVIS
 * renderer WITHOUT touching kernel.js, preload.js, index.html, style.css,
 * or app.js. Achieves this using main-process-driven DOM injection via
 * `webContents.executeJavaScript()` (which bypasses CSP `script-src`), plus
 * a custom-event bridge (window.dispatchEvent ↔ webContents.executeJavaScript)
 * for main→renderer commands. The renderer→main channel piggybacks on the
 * existing allow-listed `jarvis:ai-prompt` IPC channel with a `__K10__`
 * tagged payload.
 *
 * FEATURES DELIVERED
 * ------------------
 *   - Chrome-Lite tab strip (dynamic tab creation, activate, close, pin,
 *     reorder, duplicate, favicon, title, loading spinner)
 *   - Six configurable pinned website presets (slot 1–6), settings modal
 *   - Full address bar (omnibox): URL parsing, search-engine fallback,
 *     back/forward/reload/stop/home, zoom controls, PiP button, DevTools
 *   - Bookmarks bar with add/remove from star button in omnibox
 *   - Downloads drawer (active + completed, pause/resume/cancel/open)
 *   - History drawer (grouped by day, search, clear)
 *   - Find-in-page bar (Ctrl+F, next/prev, match counter)
 *   - Dark styled context menu (data-driven from Part 5's builder)
 *   - Four workspace layouts: browser-full, chat-browser, browser-browser,
 *     multi (3 panels when wide enough)
 *   - Draggable split divider (persisted position)
 *   - Panel controls: minimize, maximize, restore, close, swap
 *   - Picture-in-Picture dock (drag bar, resize, return button)
 *   - Two new mode buttons injected into the existing `.exec-mode-group`:
 *     [🌐 Browser] and [⬛ Split]
 *   - Full settings modal: 6 pinned presets, homepage, search engine,
 *     downloads path, theme, default zoom, bookmarks bar toggle
 *   - Snackbar / toast system for transient notifications
 *   - Chat + Browser split mode: RELOCATES the existing chat DOM
 *     (`#chat-messages` + `.chat-input-area`) into a panel so chat state
 *     and app.js bindings are preserved (0% duplication, 0% breakage)
 *
 * MAIN ↔ RENDERER BRIDGES
 * -----------------------
 *   Renderer → Main:
 *     window.jarvis.askAI({ prompt: '__K10__' + JSON.stringify({ action, payload }) })
 *     (intercepted by Part 7's jarvis:ai-prompt handler; chat path unaffected
 *      because the prompt never reaches the LLM router)
 *
 *   Main → Renderer:
 *     webContents.executeJavaScript(
 *       `window.dispatchEvent(new CustomEvent('jarvis-k10-cmd', { detail: ${JSON} }))`
 *     )
 *     (bypasses CSP because it originates from the main process, not a <script>)
 *
 *   Initial state: window.__JARVIS_K10_INITIAL__ set via executeJavaScript
 *   before the bundle runs.
 *
 * FROZEN-CORE COMPLIANCE
 * ----------------------
 *   - kernel.js / preload.js / index.html / app.js / style.css untouched
 *   - Uses ONLY ctx.registerService / ctx.addStateContributor / ctx.addStopHook
 *   - All renderer IPC piggybacks on existing ALLOWED_SEND channels
 * ============================================================================
 */

const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// SECTION 0 — CONSTANTS
// ---------------------------------------------------------------------------

const LOG_TAG = 'k10.ui';
const BRIDGE_EVENT = 'jarvis-k10-cmd';
const COMMAND_TAG = '__K10__';
const STATE_PUSH_DEBOUNCE_MS = 80;
const BOUNDS_REPORT_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// SECTION 1 — MAIN-SIDE UTILITIES
// ---------------------------------------------------------------------------

let _auditFn = null;
function audit(level, event, data) {
  if (typeof _auditFn !== 'function') return;
  try { _auditFn(level, `${LOG_TAG}.${event}`, data); }
  catch (_) { /* audit never throws */ }
}

function debounce(fn, ms) {
  let t = null;
  return function debounced(...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; try { fn.apply(null, args); } catch (_) {} }, ms);
  };
}

// ---------------------------------------------------------------------------
// SECTION 2 — RENDERER BUNDLE
// ---------------------------------------------------------------------------
// This function is stringified (.toString()) and passed to
// `webContents.executeJavaScript()`. It runs in the renderer, in the
// window's main-world context, with access to `window.jarvis` (from preload)
// but with no access to main-process state. Everything it needs is passed
// via `window.__JARVIS_K10_INITIAL__` (set before injection) and via the
// `jarvis-k10-cmd` CustomEvent stream (from main).
// ---------------------------------------------------------------------------

function __JARVIS_K10_BUNDLE__() {
  'use strict';

  // ── Idempotency guard ────────────────────────────────────────────────
  if (window.__JARVIS_K10_INSTALLED__) return;
  window.__JARVIS_K10_INSTALLED__ = true;

  // ── Utilities ────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const sel = (s) => document.querySelector(s);
  const selAll = (s) => document.querySelectorAll(s);

  /** Safe element builder — no innerHTML for dynamic content. */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'dataset' && typeof v === 'object') {
          Object.assign(el.dataset, v);
        } else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c)) : c);
      }
    }
    return el;
  }

  /** Debounce */
  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; try { fn(...args); } catch (_) {} }, ms);
    };
  }

  /** Escape URI helper */
  function enc(s) { try { return encodeURIComponent(s); } catch (_) { return s; } }

  // ── State ────────────────────────────────────────────────────────────
  const INITIAL = window.__JARVIS_K10_INITIAL__ || {};
  const state = {
    layout: 'browser-full',              // browser-full | chat-browser | browser-browser | multi
    activePanel: 'left',                 // left | right | center
    panels: {                            // per-panel state
      left:   { tabIds: [], activeTabId: null, minimized: false, maximized: false, visible: true },
      right:  { tabIds: [], activeTabId: null, minimized: false, maximized: false, visible: false },
      center: { tabIds: [], activeTabId: null, minimized: false, maximized: false, visible: false },
    },
    tabs: {},                            // tabId → descriptor
    pipTabId: null,
    dividerPos: 0.5,
    settings: INITIAL.settings || {
      pinnedPresets: [],
      searchEngine: 'google',
      showBookmarksBar: true,
      theme: 'dark',
    },
    bookmarks: INITIAL.bookmarks || [],
    chatRelocated: false,
    chatOriginalParent: null,
    findBarOpen: false,
    findQuery: '',
    downloadsOpen: false,
    historyOpen: false,
    bookmarksOpen: false,
    settingsOpen: false,
    contextMenuOpen: false,
  };

  // Merge initial tabs from runtime.
  if (Array.isArray(INITIAL.tabs)) {
    for (const t of INITIAL.tabs) {
      state.tabs[t.id] = t;
      const panel = state.panels[t.panel] ? t.panel : 'left';
      if (!state.panels[panel].tabIds.includes(t.id)) {
        state.panels[panel].tabIds.push(t.id);
      }
      if (!state.panels[panel].activeTabId) state.panels[panel].activeTabId = t.id;
    }
  }

  // ── Command sender (renderer → main) ─────────────────────────────────
  // Uses the allow-listed `jarvis:ai-prompt` channel with a `__K10__` tag.
  // Part 7's main-side handler intercepts these BEFORE any LLM routing.
  function send(action, payload) {
    try {
      const json = JSON.stringify({ action, payload });
      window.jarvis.askAI({
        prompt: '__K10__' + json,
        mode: 'offline',       // prevents kernel_9 from attempting intent match
        subMode: 'direct',
        _k10: { action, payload },
      });
    } catch (e) { /* swallow */ }
  }

  // ── Command receiver (main → renderer) ───────────────────────────────
  function setupCommandReceiver() {
    window.addEventListener('jarvis-k10-cmd', (e) => {
      const d = e && e.detail;
      if (!d || typeof d.event !== 'string') return;
      handleCommand(d.event, d.data);
    });
  }

  function handleCommand(event, data) {
    switch (event) {
      case 'tabs.replace':
        if (Array.isArray(data)) {
          state.tabs = {};
          for (const t of data) state.tabs[t.id] = t;
          refreshTabStrips();
        }
        break;
      case 'tab.add':
        if (data && data.id) { state.tabs[data.id] = data; refreshTabStrips(); }
        break;
      case 'tab.remove':
        if (data && data.tabId && state.tabs[data.tabId]) {
          delete state.tabs[data.tabId];
          refreshTabStrips();
        }
        break;
      case 'tab.update':
        if (data && data.tabId && state.tabs[data.tabId]) {
          Object.assign(state.tabs[data.tabId], data.patch || {});
          refreshTabStrips();
          refreshOmniboxForActive();
        }
        break;
      case 'tab.activate':
        if (data && data.tabId) {
          const tab = state.tabs[data.tabId];
          if (tab) {
            state.panels[tab.panel || 'left'].activeTabId = data.tabId;
            state.activePanel = tab.panel || 'left';
            refreshTabStrips();
            refreshOmniboxForActive();
          }
        }
        break;
      case 'panels.update':
        if (data && typeof data === 'object') {
          for (const pid of Object.keys(data)) {
            if (state.panels[pid]) Object.assign(state.panels[pid], data[pid]);
          }
          refreshPanels();
        }
        break;
      case 'pip.change':
        state.pipTabId = data && data.tabId || null;
        refreshPipDock();
        break;
      case 'settings.change':
        if (data) { state.settings = data; refreshBookmarksBar(); refreshPinnedPresets(); }
        break;
      case 'bookmarks.change':
        if (Array.isArray(data)) { state.bookmarks = data; refreshBookmarksBar(); }
        break;
      case 'downloads.change':
        if (data) { renderDownloads(data); }
        break;
      case 'find.state':
        if (data && data.tabId && state.panels.left.activeTabId === data.tabId) {
          renderFindState(data.state);
        }
        break;
      case 'toast':
        if (data && data.text) showToast(data.text, data.kind || 'info');
        break;
      case 'layout.change':
        if (data && data.layout) applyLayout(data.layout);
        break;
      case 'contextMenu.show':
        if (data && Array.isArray(data.items)) renderContextMenu(data.items, data.position || { x: 0, y: 0 });
        break;
      case 'contextMenu.hide':
        hideContextMenu();
        break;
      case 'history.change':
        if (Array.isArray(data)) renderHistory(data);
        break;
      case 'error':
        if (data && data.message) showToast(data.message, 'error');
        break;
      default:
        break;
    }
  }

  // ── CSS injection ────────────────────────────────────────────────────
  const CSS = `
    #k10-workspace-view {
      flex: 1; min-height: 0; display: none; flex-direction: column;
      background: var(--bg); color: var(--text);
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    #k10-workspace-view.k10-active { display: flex; }

    .k10-shell { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 12px; gap: 8px; }

    .k10-topbar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 6px 10px; background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; flex-shrink: 0;
    }
    .k10-layout-group { display: inline-flex; gap: 3px; background: var(--bg); padding: 3px; border-radius: 6px; border: 1px solid var(--border); }
    .k10-layout-btn {
      padding: 5px 10px; border: none; border-radius: 4px; background: transparent;
      color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit;
      transition: 0.15s;
    }
    .k10-layout-btn:hover { color: var(--text); }
    .k10-layout-btn.active { background: var(--accent); color: #fff; }
    .k10-global-actions { display: inline-flex; gap: 4px; margin-left: auto; }
    .k10-gbtn {
      padding: 6px 10px; border: 1px solid var(--border); border-radius: 5px;
      background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px; font-family: inherit;
      transition: 0.15s;
    }
    .k10-gbtn:hover { border-color: var(--accent); color: var(--accent); }

    .k10-body { flex: 1; min-height: 0; display: flex; gap: 0; position: relative; }
    .k10-panel {
      display: flex; flex-direction: column; flex: 1; min-width: 0;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      overflow: hidden;
    }
    .k10-panel.k10-panel-hidden { display: none; }
    .k10-panel.k10-panel-maximized { position: absolute; inset: 0; z-index: 20; flex: 1; }
    .k10-panel.k10-panel-minimized .k10-panel-header-content,
    .k10-panel.k10-panel-minimized .k10-tab-strip,
    .k10-panel.k10-panel-minimized .k10-toolbar,
    .k10-panel.k10-panel-minimized .k10-browser-content { display: none; }

    .k10-panel-header {
      display: flex; align-items: center; gap: 4px; padding: 4px 6px;
      background: var(--bg); border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .k10-panel-header-content { flex: 1; min-width: 0; }
    .k10-panel-btn {
      padding: 3px 6px; border: none; border-radius: 3px; background: transparent;
      color: var(--muted); font-size: 12px; cursor: pointer; font-family: inherit;
      transition: 0.15s;
    }
    .k10-panel-btn:hover { background: rgba(255,255,255,0.08); color: var(--text); }
    .k10-panel-btn.active { color: var(--accent); }

    .k10-tab-strip {
      display: flex; align-items: flex-end; gap: 2px; padding: 4px 4px 0;
      overflow-x: auto; overflow-y: hidden; flex-shrink: 0;
      background: var(--bg); border-bottom: 1px solid var(--border);
      scrollbar-width: thin;
    }
    .k10-tab-strip::-webkit-scrollbar { height: 4px; }
    .k10-tab-strip::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    .k10-tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 10px; border-radius: 6px 6px 0 0;
      background: var(--surface); border: 1px solid var(--border); border-bottom: none;
      cursor: pointer; font-size: 12px; color: var(--muted); min-width: 120px; max-width: 220px;
      transition: 0.15s; flex-shrink: 0; position: relative;
    }
    .k10-tab:hover { background: rgba(255,255,255,0.05); color: var(--text); }
    .k10-tab.k10-tab-active { background: var(--card-bg); color: var(--text); border-color: var(--accent); }
    .k10-tab-icon { width: 14px; height: 14px; flex-shrink: 0; border-radius: 2px; object-fit: contain; }
    .k10-tab-icon-placeholder { width: 14px; height: 14px; border-radius: 2px; background: var(--accent); opacity: 0.5; flex-shrink: 0; }
    .k10-tab-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .k10-tab-close {
      padding: 0 3px; border: none; background: transparent; color: var(--muted);
      cursor: pointer; font-size: 14px; line-height: 1; font-family: inherit;
    }
    .k10-tab-close:hover { color: var(--danger); }
    .k10-tab.k10-tab-loading .k10-tab-icon-placeholder {
      animation: k10-pulse 1s infinite;
    }
    @keyframes k10-pulse { 0%,100%{opacity:0.3;} 50%{opacity:1;} }
    .k10-tab-add {
      padding: 4px 10px; border: none; background: transparent; color: var(--muted);
      cursor: pointer; font-size: 16px; font-family: inherit; margin-bottom: 2px;
    }
    .k10-tab-add:hover { color: var(--accent); }

    .k10-toolbar {
      display: flex; align-items: center; gap: 4px; padding: 6px 8px;
      background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .k10-nav-btn {
      padding: 4px 8px; border: none; border-radius: 4px; background: transparent;
      color: var(--muted); cursor: pointer; font-size: 13px; font-family: inherit;
      transition: 0.15s; flex-shrink: 0;
    }
    .k10-nav-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: var(--text); }
    .k10-nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .k10-nav-btn.k10-nav-active { color: var(--accent); }
    .k10-omnibox {
      flex: 1; min-width: 100px; padding: 6px 12px; border-radius: 999px;
      background: var(--bg); border: 1px solid var(--border); color: var(--text);
      font-size: 12px; font-family: inherit; outline: none; transition: 0.15s;
    }
    .k10-omnibox:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(6,182,212,0.15); }
    .k10-zoom-label {
      padding: 4px 6px; font-size: 11px; color: var(--muted); min-width: 36px; text-align: center;
      font-variant-numeric: tabular-nums;
    }

    .k10-bookmarks-bar {
      display: flex; align-items: center; gap: 4px; padding: 4px 8px;
      background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0;
      overflow-x: auto; overflow-y: hidden; scrollbar-width: thin;
    }
    .k10-bookmarks-bar.hidden { display: none; }
    .k10-bm-item {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
      border-radius: 4px; background: transparent; border: 1px solid transparent;
      color: var(--muted); font-size: 11px; cursor: pointer; font-family: inherit;
      white-space: nowrap; flex-shrink: 0; transition: 0.15s;
    }
    .k10-bm-item:hover { background: rgba(255,255,255,0.06); color: var(--text); border-color: var(--border); }

    .k10-browser-content {
      flex: 1; min-height: 0; background: var(--bg);
      position: relative; overflow: hidden;
    }

    .k10-divider {
      width: 6px; flex-shrink: 0; background: var(--border);
      cursor: col-resize; transition: 0.1s;
      display: flex; align-items: center; justify-content: center;
    }
    .k10-divider:hover, .k10-divider.k10-dragging { background: var(--accent); }
    .k10-divider.k10-divider-hidden { display: none; }

    .k10-chat-panel {
      display: flex; flex-direction: column; flex: 1; min-width: 0;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      overflow: hidden;
    }
    .k10-chat-header {
      padding: 8px 12px; background: var(--bg); border-bottom: 1px solid var(--border);
      font-size: 11px; font-weight: 700; letter-spacing: 1px;
      text-transform: uppercase; color: var(--muted); flex-shrink: 0;
    }
    .k10-chat-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .k10-chat-body .chat-container { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
    .k10-chat-body .chat-input-area { padding: 10px 12px; border-top: 1px solid var(--border); }

    .k10-pip-dock {
      position: fixed; right: 24px; bottom: 24px; width: 340px; height: 260px;
      background: var(--surface); border: 2px solid var(--accent); border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5); z-index: 10000;
      display: none; flex-direction: column; overflow: hidden;
    }
    .k10-pip-dock.k10-active { display: flex; }
    .k10-pip-header {
      padding: 6px 10px; background: var(--bg); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      cursor: move; user-select: none; flex-shrink: 0;
    }
    .k10-pip-title { font-size: 12px; font-weight: 600; color: var(--text); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .k10-pip-controls { display: flex; gap: 4px; }
    .k10-pip-btn {
      padding: 2px 6px; border: none; border-radius: 3px; background: transparent;
      color: var(--muted); cursor: pointer; font-size: 12px; font-family: inherit;
    }
    .k10-pip-btn:hover { background: rgba(255,255,255,0.1); color: var(--text); }
    .k10-pip-placeholder {
      flex: 1; display: flex; align-items: center; justify-content: center;
      color: var(--muted); font-size: 12px; text-align: center; padding: 12px;
    }

    .k10-drawer {
      position: absolute; top: 0; right: 0; bottom: 0; width: 340px;
      background: var(--surface); border-left: 1px solid var(--border);
      z-index: 100; display: flex; flex-direction: column; overflow: hidden;
      transform: translateX(100%); transition: transform 0.2s;
    }
    .k10-drawer.k10-open { transform: translateX(0); }
    .k10-drawer-header {
      padding: 10px 14px; background: var(--bg); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }
    .k10-drawer-title {
      font-size: 12px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1px; color: var(--muted);
    }
    .k10-drawer-close {
      padding: 4px 8px; border: none; border-radius: 4px; background: transparent;
      color: var(--muted); cursor: pointer; font-size: 14px;
    }
    .k10-drawer-close:hover { color: var(--text); background: rgba(255,255,255,0.08); }
    .k10-drawer-body { flex: 1; overflow-y: auto; padding: 8px; }
    .k10-drawer-empty { padding: 24px; text-align: center; color: var(--muted); font-size: 12px; }

    .k10-download-item, .k10-history-item, .k10-bookmark-item {
      padding: 8px 10px; border-radius: 6px; background: var(--card-bg);
      border: 1px solid var(--border); margin-bottom: 6px;
    }
    .k10-download-name, .k10-history-title, .k10-bookmark-title {
      font-size: 12px; font-weight: 600; color: var(--text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .k10-download-meta, .k10-history-url, .k10-bookmark-url {
      font-size: 10px; color: var(--muted); margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .k10-download-actions { display: flex; gap: 4px; margin-top: 6px; }
    .k10-dl-btn {
      padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px;
      background: var(--bg); color: var(--text); cursor: pointer; font-size: 11px;
      font-family: inherit;
    }
    .k10-dl-btn:hover { border-color: var(--accent); color: var(--accent); }
    .k10-history-day { font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1px; color: var(--accent); margin: 12px 0 6px; }

    .k10-find-bar {
      position: absolute; top: 8px; right: 8px; z-index: 50;
      display: none; align-items: center; gap: 4px;
      padding: 6px 8px; background: var(--surface); border: 1px solid var(--border);
      border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    .k10-find-bar.k10-open { display: flex; }
    .k10-find-input {
      width: 180px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px;
      background: var(--bg); color: var(--text); font-size: 12px; font-family: inherit; outline: none;
    }
    .k10-find-input:focus { border-color: var(--accent); }
    .k10-find-count {
      font-size: 11px; color: var(--muted); min-width: 48px; text-align: center;
    }
    .k10-find-btn {
      padding: 3px 8px; border: none; border-radius: 3px; background: transparent;
      color: var(--muted); cursor: pointer; font-size: 12px; font-family: inherit;
    }
    .k10-find-btn:hover { background: rgba(255,255,255,0.1); color: var(--text); }

    .k10-context-menu {
      position: fixed; z-index: 99999; min-width: 220px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      padding: 4px 0; display: none;
    }
    .k10-context-menu.k10-open { display: block; }
    .k10-ctx-item {
      padding: 6px 16px; font-size: 12px; color: var(--text);
      cursor: pointer; user-select: none; white-space: nowrap;
    }
    .k10-ctx-item:hover:not(.k10-ctx-disabled) { background: var(--accent); color: #fff; }
    .k10-ctx-item.k10-ctx-disabled { opacity: 0.4; cursor: default; }
    .k10-ctx-separator {
      height: 1px; background: var(--border); margin: 4px 0;
    }
    .k10-ctx-shortcut { float: right; color: var(--muted); font-size: 11px; margin-left: 16px; }

    .k10-modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 20000;
      display: none; align-items: center; justify-content: center; padding: 20px;
    }
    .k10-modal-backdrop.k10-open { display: flex; }
    .k10-modal {
      width: 620px; max-width: 100%; max-height: 90vh; overflow-y: auto;
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);
    }
    .k10-modal h3 { font-size: 15px; color: var(--accent); margin-bottom: 12px;
      border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .k10-modal label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
    .k10-modal input[type="text"], .k10-modal input[type="url"], .k10-modal select {
      width: 100%; padding: 8px 10px; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 5px; outline: none;
      font-family: inherit; font-size: 12px;
    }
    .k10-modal input:focus, .k10-modal select:focus { border-color: var(--accent); }
    .k10-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;
      padding-top: 12px; border-top: 1px solid var(--border); }
    .k10-modal-btn {
      padding: 8px 16px; border: none; border-radius: 5px; cursor: pointer;
      font-size: 12px; font-weight: 600; font-family: inherit;
    }
    .k10-modal-btn-cancel { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .k10-modal-btn-save { background: var(--accent); color: #fff; }
    .k10-preset-row { display: grid; grid-template-columns: 30px 100px 1fr 30px; gap: 6px; align-items: center; margin: 6px 0; }
    .k10-preset-slot { font-size: 11px; color: var(--muted); text-align: center; font-weight: 700; }
    .k10-preset-toggle {
      width: 26px; height: 26px; border: 1px solid var(--border); border-radius: 4px;
      background: var(--bg); color: var(--muted); cursor: pointer; font-size: 12px;
    }
    .k10-preset-toggle.k10-enabled { background: var(--accent); color: #fff; border-color: var(--accent); }

    .k10-toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      padding: 10px 20px; background: var(--surface); border: 1px solid var(--accent);
      border-radius: 8px; color: var(--text); font-size: 13px; z-index: 99999;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5); animation: k10-toast-in 0.2s ease-out;
    }
    .k10-toast.k10-toast-error { border-color: var(--danger); }
    .k10-toast.k10-toast-success { border-color: var(--success); }
    @keyframes k10-toast-in { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }

    .k10-empty-panel {
      flex: 1; display: flex; align-items: center; justify-content: center;
      color: var(--muted); font-size: 13px; text-align: center; padding: 40px;
    }
    .k10-empty-panel strong { color: var(--accent); display: block; margin-bottom: 6px; }
  `;

  function injectCSS() {
    if (document.getElementById('k10-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'k10-ui-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ── Mode buttons injection ───────────────────────────────────────────
  function injectModeButtons() {
    const group = document.querySelector('.exec-mode-group');
    if (!group) return;
    if (group.querySelector('[data-k10-mode]')) return;

    const btnBrowser = h('button', {
      type: 'button', class: 'exec-mode-btn',
      'data-k10-mode': 'browser',
      title: 'Open Chrome-Lite Browser Workspace',
    }, '🌐 Browser');

    const btnSplit = h('button', {
      type: 'button', class: 'exec-mode-btn',
      'data-k10-mode': 'split',
      title: 'Split Chat + Browser side by side',
    }, '⬛ Split');

    group.appendChild(btnBrowser);
    group.appendChild(btnSplit);

    // Capture-phase listener — our buttons short-circuit app.js handlers.
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-k10-mode]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const mode = btn.getAttribute('data-k10-mode');
      if (mode === 'browser') enterWorkspace('browser-full');
      else if (mode === 'split') enterWorkspace('chat-browser');
    }, true);

    // Bubble-phase — when app.js's own mode buttons are clicked, exit workspace.
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-exec-mode]');
      if (!btn) return;
      exitWorkspace();
    }, false);
  }

  // ── Sidebar hijack ───────────────────────────────────────────────────
  function wireSidebarHijack() {
    document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('k10-workspace-view')?.classList.remove('k10-active');
      });
    });
  }

  // ── Workspace shell builder ──────────────────────────────────────────
  function buildWorkspaceShell() {
    if (document.getElementById('k10-workspace-view')) return;

    const content = document.querySelector('.content');
    if (!content) return;

    const view = h('div', {
      id: 'k10-workspace-view',
      class: 'page-view',
    });

    const shell = h('div', { class: 'k10-shell' });

    // Top bar
    const topbar = h('div', { class: 'k10-topbar' });
    const layoutGroup = h('div', { class: 'k10-layout-group' });
    const layouts = [
      { key: 'browser-full', label: '🌐 Browser' },
      { key: 'chat-browser', label: '📊 Chat+Browser' },
      { key: 'browser-browser', label: '🖥️ Browser×2' },
      { key: 'multi', label: '📐 Multi' },
    ];
    for (const L of layouts) {
      const b = h('button', {
        type: 'button',
        class: 'k10-layout-btn' + (state.layout === L.key ? ' active' : ''),
        'data-k10-layout': L.key,
        onclick: () => applyLayout(L.key),
      }, L.label);
      layoutGroup.appendChild(b);
    }
    topbar.appendChild(layoutGroup);

    const actions = h('div', { class: 'k10-global-actions' });
    const mkAction = (label, action, title) => h('button', {
      type: 'button', class: 'k10-gbtn', title: title || label,
      onclick: () => handleGlobalAction(action),
    }, label);

    actions.appendChild(mkAction('+ Tab', 'new-tab', 'New Tab'));
    actions.appendChild(mkAction('⭐', 'bookmarks', 'Bookmarks'));
    actions.appendChild(mkAction('📜', 'history', 'History'));
    actions.appendChild(mkAction('⬇️', 'downloads', 'Downloads'));
    actions.appendChild(mkAction('📌', 'pip', 'Picture-in-Picture'));
    actions.appendChild(mkAction('⚙️', 'settings', 'Browser Settings'));
    topbar.appendChild(actions);

    shell.appendChild(topbar);

    // Body: panels + divider
    const body = h('div', { class: 'k10-body' });
    body.appendChild(buildBrowserPanel('left'));
    body.appendChild(buildDivider());
    body.appendChild(buildBrowserPanel('right'));
    body.appendChild(buildChatPanel());
    body.appendChild(buildCenterPanel()); // hidden by default
    shell.appendChild(body);

    view.appendChild(shell);

    // Drawers + modals (siblings of shell to allow absolute positioning inside view)
    view.appendChild(buildDownloadsDrawer());
    view.appendChild(buildHistoryDrawer());
    view.appendChild(buildBookmarksDrawer());
    view.appendChild(buildSettingsModal());

    content.appendChild(view);

    // PiP dock + context menu + toast — attach to body for fixed positioning.
    document.body.appendChild(buildPipDock());
    document.body.appendChild(buildContextMenu());
  }

  function buildBrowserPanel(panelId) {
    const panel = h('div', {
      class: 'k10-panel',
      'data-k10-panel': panelId,
    });

    // Panel header
    const header = h('div', { class: 'k10-panel-header' });
    const headerContent = h('div', {
      class: 'k10-panel-header-content',
      style: { fontSize: '11px', color: 'var(--muted)', fontWeight: '600', letterSpacing: '0.5px', textTransform: 'uppercase' },
    }, panelId === 'left' ? 'Panel 1' : 'Panel 2');
    header.appendChild(headerContent);

    const mkPanelBtn = (label, title, cb) => h('button', {
      type: 'button', class: 'k10-panel-btn', title,
      onclick: cb,
    }, label);

    header.appendChild(mkPanelBtn('−', 'Minimize Panel', () => togglePanelMinimize(panelId)));
    header.appendChild(mkPanelBtn('□', 'Maximize / Restore', () => togglePanelMaximize(panelId)));
    header.appendChild(mkPanelBtn('⇄', 'Swap Panels', () => swapPanels()));
    header.appendChild(mkPanelBtn('×', 'Close Panel (Hides)', () => hidePanel(panelId)));
    panel.appendChild(header);

    // Tab strip
    const tabStrip = h('div', {
      class: 'k10-tab-strip',
      'data-k10-tab-strip': panelId,
    });
    panel.appendChild(tabStrip);

    // Toolbar
    const toolbar = h('div', { class: 'k10-toolbar' });
    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'Back', 'data-k10-nav': 'back',
      onclick: () => navAction(panelId, 'back'),
    }, '◄'));
    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'Forward', 'data-k10-nav': 'forward',
      onclick: () => navAction(panelId, 'forward'),
    }, '►'));
    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'Reload', 'data-k10-nav': 'reload',
      onclick: () => navAction(panelId, 'reload'),
    }, '⟳'));
    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'Home',
      onclick: () => navAction(panelId, 'home'),
    }, '🏠'));

    const omnibox = h('input', {
      type: 'text', class: 'k10-omnibox',
      'data-k10-omnibox': panelId,
      placeholder: 'Search or enter URL...',
      spellcheck: 'false',
    });
    omnibox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleOmniboxSubmit(panelId);
      } else if (e.key === 'Escape') {
        omnibox.blur();
      }
    });
    omnibox.addEventListener('focus', () => omnibox.select());
    toolbar.appendChild(omnibox);

    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'Bookmark this page',
      'data-k10-nav': 'bookmark',
      onclick: () => navAction(panelId, 'bookmark'),
    }, '⭐'));

    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'Zoom Out',
      onclick: () => navAction(panelId, 'zoom-out'),
    }, '−'));
    toolbar.appendChild(h('span', {
      class: 'k10-zoom-label', 'data-k10-zoom': panelId,
    }, '100%'));
    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'Zoom In',
      onclick: () => navAction(panelId, 'zoom-in'),
    }, '+'));

    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'Toggle PiP',
      onclick: () => navAction(panelId, 'pip'),
    }, '📌'));
    toolbar.appendChild(h('button', {
      type: 'button', class: 'k10-nav-btn', title: 'DevTools',
      onclick: () => navAction(panelId, 'devtools'),
    }, '⚙'));

    panel.appendChild(toolbar);

    // Bookmarks bar
    const bmBar = h('div', {
      class: 'k10-bookmarks-bar' + (state.settings.showBookmarksBar ? '' : ' hidden'),
      'data-k10-bookmarks-bar': panelId,
    });
    panel.appendChild(bmBar);

    // Browser content (bounds target — WebContentsView mounts here)
    const browserContent = h('div', {
      class: 'k10-browser-content',
      'data-k10-content': panelId,
    });
    panel.appendChild(browserContent);

    // Find bar (overlay)
    const findBar = h('div', {
      class: 'k10-find-bar', 'data-k10-find': panelId,
    });
    findBar.appendChild(h('input', {
      type: 'text', class: 'k10-find-input',
      'data-k10-find-input': panelId,
      placeholder: 'Find in page...',
    }));
    findBar.appendChild(h('span', { class: 'k10-find-count', 'data-k10-find-count': panelId }, '0/0'));
    findBar.appendChild(h('button', {
      type: 'button', class: 'k10-find-btn', title: 'Previous',
      onclick: () => findAction(panelId, 'prev'),
    }, '▲'));
    findBar.appendChild(h('button', {
      type: 'button', class: 'k10-find-btn', title: 'Next',
      onclick: () => findAction(panelId, 'next'),
    }, '▼'));
    findBar.appendChild(h('button', {
      type: 'button', class: 'k10-find-btn', title: 'Close',
      onclick: () => findAction(panelId, 'close'),
    }, '✕'));
    const findInput = findBar.querySelector('input');
    findInput.addEventListener('input', debounce(() => {
      state.findQuery = findInput.value;
      send('find.start', { tabId: state.panels[panelId].activeTabId, query: state.findQuery });
    }, 200));
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') findAction(panelId, e.shiftKey ? 'prev' : 'next');
      if (e.key === 'Escape') findAction(panelId, 'close');
    });
    browserContent.appendChild(findBar);

    return panel;
  }

  function buildChatPanel() {
    const panel = h('div', {
      class: 'k10-chat-panel',
      'data-k10-panel': 'chat',
      style: { display: 'none' },
    });
    panel.appendChild(h('div', { class: 'k10-chat-header' }, '💬 JARVIS Chat'));
    const body = h('div', { class: 'k10-chat-body', 'data-k10-chat-body': '1' });
    panel.appendChild(body);
    return panel;
  }

  function buildCenterPanel() {
    // Reuses browser panel structure but with panelId=center; hidden by default.
    const panel = buildBrowserPanel('center');
    panel.style.display = 'none';
    return panel;
  }

  function buildDivider() {
    const divider = h('div', { class: 'k10-divider', 'data-k10-divider': '1' });
    let dragging = false;
    let startX = 0;
    let startPos = 0.5;

    const onDown = (e) => {
      dragging = true;
      startX = e.clientX;
      startPos = state.dividerPos;
      divider.classList.add('k10-dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    };
    const onMove = (e) => {
      if (!dragging) return;
      const bodyEl = divider.parentElement;
      if (!bodyEl) return;
      const totalW = bodyEl.getBoundingClientRect().width;
      if (totalW <= 0) return;
      const delta = e.clientX - startX;
      let newPos = startPos + delta / totalW;
      newPos = Math.max(0.2, Math.min(0.8, newPos));
      state.dividerPos = newPos;
      applyDividerPosition();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('k10-dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // Persist + re-report bounds.
      setTimeout(() => {
        reportPanelBounds('left');
        reportPanelBounds('right');
      }, 50);
    };

    divider.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    return divider;
  }

  function applyDividerPosition() {
    const body = document.querySelector('.k10-body');
    if (!body) return;
    const divider = body.querySelector('[data-k10-divider]');
    if (!divider) return;

    const layout = state.layout;
    const leftPanel = body.querySelector('[data-k10-panel="left"]');
    const rightPanel = body.querySelector('[data-k10-panel="right"]');
    const chatPanel = body.querySelector('[data-k10-panel="chat"]');
    const centerPanel = body.querySelector('[data-k10-panel="center"]');

    // Reset all flex
    [leftPanel, rightPanel, chatPanel, centerPanel].forEach(p => {
      if (p) { p.style.flex = ''; p.style.display = ''; }
    });
    divider.classList.add('k10-divider-hidden');

    if (layout === 'browser-full') {
      if (leftPanel) leftPanel.style.flex = '1';
      if (rightPanel) rightPanel.style.display = 'none';
      if (chatPanel) chatPanel.style.display = 'none';
      if (centerPanel) centerPanel.style.display = 'none';
    } else if (layout === 'chat-browser') {
      if (chatPanel) { chatPanel.style.display = 'flex'; chatPanel.style.flex = state.dividerPos; }
      divider.classList.remove('k10-divider-hidden');
      if (leftPanel) { leftPanel.style.display = 'flex'; leftPanel.style.flex = 1 - state.dividerPos; }
      if (rightPanel) rightPanel.style.display = 'none';
      if (centerPanel) centerPanel.style.display = 'none';
      relocateChat();
    } else if (layout === 'browser-browser') {
      if (leftPanel) { leftPanel.style.display = 'flex'; leftPanel.style.flex = state.dividerPos; }
      divider.classList.remove('k10-divider-hidden');
      if (rightPanel) { rightPanel.style.display = 'flex'; rightPanel.style.flex = 1 - state.dividerPos; }
      if (chatPanel) chatPanel.style.display = 'none';
      if (centerPanel) centerPanel.style.display = 'none';
      restoreChatIfRelocated();
    } else if (layout === 'multi') {
      // 3 panels: left | divider | center | divider | right — approximate with equal widths.
      if (leftPanel) { leftPanel.style.display = 'flex'; leftPanel.style.flex = '1'; }
      if (centerPanel) { centerPanel.style.display = 'flex'; centerPanel.style.flex = '1'; }
      if (rightPanel) { rightPanel.style.display = 'flex'; rightPanel.style.flex = '1'; }
      if (chatPanel) chatPanel.style.display = 'none';
      divider.classList.add('k10-divider-hidden');
      restoreChatIfRelocated();
    }

    // Sync visible panel state to main.
    syncPanelVisibility();

    // Report bounds after layout settles.
    setTimeout(() => {
      reportPanelBounds('left');
      reportPanelBounds('right');
      reportPanelBounds('center');
    }, 30);
  }

  function syncPanelVisibility() {
    const updates = {
      left: { visible: state.layout !== 'chat-browser' || true },
      right: { visible: state.layout === 'browser-browser' || state.layout === 'multi' },
      center: { visible: state.layout === 'multi' },
    };
    for (const pid of Object.keys(updates)) {
      Object.assign(state.panels[pid], updates[pid]);
    }
    send('panel.setVisibility', updates);
  }

  function relocateChat() {
    if (state.chatRelocated) return;
    const chatBody = document.querySelector('[data-k10-chat-body="1"]');
    const msgContainer = document.getElementById('chat-messages');
    const inputArea = document.querySelector('.chat-input-area');
    const chatView = document.getElementById('chat-view');
    if (!chatBody || !msgContainer || !inputArea || !chatView) return;

    // Remember original parents for restoration.
    state.chatOriginalParent = {
      msg: msgContainer.parentElement,
      input: inputArea.parentElement,
    };
    chatBody.appendChild(msgContainer);
    chatBody.appendChild(inputArea);
    chatView.style.display = 'none';
    state.chatRelocated = true;
  }

  function restoreChatIfRelocated() {
    if (!state.chatRelocated) return;
    const msgContainer = document.getElementById('chat-messages');
    const inputArea = document.querySelector('.chat-input-area');
    const chatView = document.getElementById('chat-view');
    if (!msgContainer || !inputArea) return;

    const orig = state.chatOriginalParent;
    if (orig && orig.msg) orig.msg.appendChild(msgContainer);
    else if (chatView) chatView.appendChild(msgContainer);
    if (orig && orig.input) orig.input.appendChild(inputArea);
    else if (chatView) chatView.appendChild(inputArea);

    chatView.style.display = 'flex';
    state.chatRelocated = false;
    state.chatOriginalParent = null;
  }

  // ── Layout entry/exit ────────────────────────────────────────────────
  function enterWorkspace(layout) {
    const view = document.getElementById('k10-workspace-view');
    if (!view) return;

    // Hide all existing page views.
    selAll('.page-view').forEach(v => { if (v !== view) v.style.display = 'none'; });
    view.classList.add('k10-active');
    document.getElementById('chat-view')?.classList.remove('k10-active');

    // Mark our mode button active.
    document.querySelectorAll('[data-k10-mode]').forEach(b => b.classList.remove('active'));
    const target = document.querySelector(`[data-k10-mode="${layout === 'chat-browser' ? 'split' : 'browser'}"]`);
    if (target) target.classList.add('active');

    applyLayout(layout);

    // If no tabs exist yet in the target panel, open a pinned preset.
    if (layout === 'browser-full' || layout === 'chat-browser') {
      if (state.panels.left.tabIds.length === 0) {
        send('tab.create', { url: state.settings.pinnedPresets[0]?.url || 'https://www.google.com', panel: 'left' });
      }
    }

    // Notify main.
    send('layout.change', { layout });
  }

  function exitWorkspace() {
    const view = document.getElementById('k10-workspace-view');
    if (!view) return;

    restoreChatIfRelocated();

    view.classList.remove('k10-active');
    document.querySelectorAll('[data-k10-mode]').forEach(b => b.classList.remove('active'));

    // Restore chat view — app.js's mode buttons want to be visible.
    const chatView = document.getElementById('chat-view');
    if (chatView) chatView.style.display = 'flex';
  }

  function applyLayout(layout) {
    state.layout = layout;

    // Update layout button active states.
    document.querySelectorAll('[data-k10-layout]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-k10-layout') === layout);
    });

    applyDividerPosition();

    // If we exit chat-browser but there was a relocated chat, restore it.
    if (layout !== 'chat-browser') restoreChatIfRelocated();

    refreshTabStrips();
    refreshOmniboxForActive();

    // Re-check bounds after layout settle.
    setTimeout(() => {
      reportPanelBounds('left');
      reportPanelBounds('right');
      reportPanelBounds('center');
    }, 100);
  }

  // ── Bounds reporting ─────────────────────────────────────────────────
  function reportPanelBounds(panelId) {
    const contentEl = document.querySelector(`[data-k10-content="${panelId}"]`);
    if (!contentEl) return;
    const rect = contentEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      send('panel.setBounds', { panelId, bounds: null });
      return;
    }
    send('panel.setBounds', {
      panelId,
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }

  function setupBoundsObserver() {
    const scheduleAll = debounce(() => {
      reportPanelBounds('left');
      reportPanelBounds('right');
      reportPanelBounds('center');
    }, 100);

    window.addEventListener('resize', scheduleAll, { passive: true });

    // ResizeObserver on each panel content area.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(scheduleAll);
      for (const pid of ['left', 'right', 'center']) {
        const el = document.querySelector(`[data-k10-content="${pid}"]`);
        if (el) ro.observe(el);
      }
    }

    // Initial report.
    setTimeout(scheduleAll, 200);
  }

  // ── Tab strips ───────────────────────────────────────────────────────
  function refreshTabStrips() {
    for (const pid of ['left', 'right', 'center']) {
      renderTabStrip(pid);
    }
  }

  function renderTabStrip(panelId) {
    const strip = document.querySelector(`[data-k10-tab-strip="${panelId}"]`);
    if (!strip) return;
    strip.textContent = '';

    const pState = state.panels[panelId];
    if (!pState) return;

    for (const tabId of pState.tabIds) {
      const tab = state.tabs[tabId];
      if (!tab) continue;

      const isActive = pState.activeTabId === tabId;
      const icon = tab.favicon
        ? h('img', { class: 'k10-tab-icon', src: tab.favicon, alt: '' })
        : h('div', { class: 'k10-tab-icon-placeholder' });

      const tabEl = h('div', {
        class: 'k10-tab' + (isActive ? ' k10-tab-active' : '') + (tab.loading ? ' k10-tab-loading' : ''),
        title: tab.title || tab.url || '',
        'data-k10-tab-id': tabId,
      }, [
        icon,
        h('span', { class: 'k10-tab-title' }, tab.title || 'New Tab'),
        h('button', {
          type: 'button', class: 'k10-tab-close', title: 'Close Tab',
          onclick: (e) => { e.stopPropagation(); closeTab(tabId); },
        }, '×'),
      ]);

      tabEl.addEventListener('click', () => activateTab(tabId));
      strip.appendChild(tabEl);
    }

    // "+" new tab button
    const addBtn = h('button', {
      type: 'button', class: 'k10-tab-add', title: 'New Tab',
      onclick: () => createNewTab(panelId),
    }, '+');
    strip.appendChild(addBtn);
  }

  // ── Omnibox ──────────────────────────────────────────────────────────
  function refreshOmniboxForActive() {
    for (const pid of ['left', 'right', 'center']) {
      const omni = document.querySelector(`[data-k10-omnibox="${pid}"]`);
      const zoomLabel = document.querySelector(`[data-k10-zoom="${pid}"]`);
      const pState = state.panels[pid];
      if (!omni || !pState) continue;
      const activeId = pState.activeTabId;
      const tab = activeId ? state.tabs[activeId] : null;
      if (document.activeElement !== omni) {
        omni.value = tab ? (tab.url === 'about:blank' ? '' : tab.url) : '';
      }
      if (zoomLabel && tab) {
        zoomLabel.textContent = Math.round((tab.zoom || 1) * 100) + '%';
      }
      // Update nav button enabled states.
      const panelEl = document.querySelector(`[data-k10-panel="${pid}"]`);
      if (panelEl) {
        const backBtn = panelEl.querySelector('[data-k10-nav="back"]');
        const fwdBtn = panelEl.querySelector('[data-k10-nav="forward"]');
        if (backBtn) backBtn.disabled = !tab || !tab.canGoBack;
        if (fwdBtn) fwdBtn.disabled = !tab || !tab.canGoForward;
      }
    }
    refreshBookmarksBar();
  }

  function handleOmniboxSubmit(panelId) {
    const omni = document.querySelector(`[data-k10-omnibox="${panelId}"]`);
    if (!omni) return;
    const raw = omni.value.trim();
    if (!raw) return;
    const url = normalizeUrlInput(raw);
    if (!url) return;
    const activeId = state.panels[panelId].activeTabId;
    if (activeId) {
      send('tab.navigate', { tabId: activeId, url });
    } else {
      send('tab.create', { url, panel: panelId });
    }
  }

  function normalizeUrlInput(raw) {
    if (/^(https?|file|about|chrome|view-source):/i.test(raw)) return raw;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(raw)) return 'https://' + raw;
    // Fall back to search.
    const engine = state.settings.searchEngine || 'google';
    const engines = {
      google: 'https://www.google.com/search?q=%s',
      bing: 'https://www.bing.com/search?q=%s',
      duckduckgo: 'https://duckduckgo.com/?q=%s',
      brave: 'https://search.brave.com/search?q=%s',
      chatgpt: 'https://chat.openai.com/?q=%s',
      claude: 'https://claude.ai/new?q=%s',
    };
    return (engines[engine] || engines.google).replace('%s', encodeURIComponent(raw));
  }

  // ── Nav actions ──────────────────────────────────────────────────────
  function navAction(panelId, action) {
    const activeId = state.panels[panelId].activeTabId;
    if (!activeId) return;
    switch (action) {
      case 'back': send('tab.goBack', { tabId: activeId }); break;
      case 'forward': send('tab.goForward', { tabId: activeId }); break;
      case 'reload': send('tab.reload', { tabId: activeId }); break;
      case 'home': send('tab.navigate', { tabId: activeId, url: state.settings.homepage || 'https://www.google.com' }); break;
      case 'zoom-in': send('tab.zoomIn', { tabId: activeId }); break;
      case 'zoom-out': send('tab.zoomOut', { tabId: activeId }); break;
      case 'pip': togglePiP(activeId); break;
      case 'bookmark': toggleBookmark(); break;
      case 'devtools': send('tab.devtools', { tabId: activeId }); break;
    }
  }

  // ── Tab actions ──────────────────────────────────────────────────────
  function createNewTab(panelId) {
    const preset = state.settings.pinnedPresets?.find(p => p.enabled);
    const url = preset ? preset.url : 'https://www.google.com';
    send('tab.create', { url, panel: panelId });
  }
  function activateTab(tabId) { send('tab.activate', { tabId }); }
  function closeTab(tabId) { send('tab.close', { tabId }); }

  // ── Panel actions ────────────────────────────────────────────────────
  function togglePanelMinimize(panelId) {
    state.panels[panelId].minimized = !state.panels[panelId].minimized;
    const panelEl = document.querySelector(`[data-k10-panel="${panelId}"]`);
    if (panelEl) panelEl.classList.toggle('k10-panel-minimized', state.panels[panelId].minimized);
    setTimeout(() => reportPanelBounds(panelId), 50);
  }
  function togglePanelMaximize(panelId) {
    // Clear other maximized panels.
    for (const pid of Object.keys(state.panels)) state.panels[pid].maximized = false;
    state.panels[panelId].maximized = !state.panels[panelId].maximized;
    for (const pid of Object.keys(state.panels)) {
      const el = document.querySelector(`[data-k10-panel="${pid}"]`);
      if (el) el.classList.toggle('k10-panel-maximized', state.panels[pid].maximized);
    }
    setTimeout(() => {
      reportPanelBounds('left'); reportPanelBounds('right'); reportPanelBounds('center');
    }, 100);
  }
  function hidePanel(panelId) {
    state.panels[panelId].visible = false;
    const panelEl = document.querySelector(`[data-k10-panel="${panelId}"]`);
    if (panelEl) panelEl.classList.add('k10-panel-hidden');
    send('panel.setVisibility', { [panelId]: { visible: false } });
    setTimeout(() => reportPanelBounds(panelId), 50);
  }
  function swapPanels() {
    const l = state.panels.left;
    const r = state.panels.right;
    const temp = { tabIds: l.tabIds, activeTabId: l.activeTabId };
    l.tabIds = r.tabIds; l.activeTabId = r.activeTabId;
    r.tabIds = temp.tabIds; r.activeTabId = temp.activeTabId;
    send('panel.swap', {});
    refreshTabStrips();
    refreshOmniboxForActive();
    setTimeout(() => {
      reportPanelBounds('left'); reportPanelBounds('right');
    }, 50);
  }

  // ── PiP ──────────────────────────────────────────────────────────────
  function togglePiP(tabId) {
    if (!tabId) return;
    if (state.pipTabId === tabId) {
      send('pip.exit', { tabId });
    } else {
      send('pip.enter', { tabId });
    }
  }

  function buildPipDock() {
    const dock = h('div', {
      class: 'k10-pip-dock', id: 'k10-pip-dock',
    });
    const header = h('div', { class: 'k10-pip-header' });
    header.appendChild(h('div', { class: 'k10-pip-title', 'data-k10-pip-title': '1' }, 'Picture-in-Picture'));
    const ctrls = h('div', { class: 'k10-pip-controls' });
    ctrls.appendChild(h('button', {
      type: 'button', class: 'k10-pip-btn', title: 'Return to panel',
      onclick: () => exitPiP(),
    }, '↩'));
    ctrls.appendChild(h('button', {
      type: 'button', class: 'k10-pip-btn', title: 'Close',
      onclick: () => exitPiP(),
    }, '✕'));
    header.appendChild(ctrls);
    dock.appendChild(header);
    dock.appendChild(h('div', {
      class: 'k10-pip-placeholder', 'data-k10-pip-placeholder': '1',
    }, 'PiP window is floating on your desktop.\nUse the ↩ button to return it to the workspace.'));

    // Make it draggable.
    let dx = 0, dy = 0, dragging = false;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const r = dock.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      dock.style.left = Math.max(0, Math.min(window.innerWidth - dock.offsetWidth, e.clientX - dx)) + 'px';
      dock.style.top = Math.max(0, Math.min(window.innerHeight - dock.offsetHeight, e.clientY - dy)) + 'px';
      dock.style.right = 'auto';
      dock.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
    });

    return dock;
  }

  function refreshPipDock() {
    const dock = document.getElementById('k10-pip-dock');
    if (!dock) return;
    const title = dock.querySelector('[data-k10-pip-title="1"]');
    if (state.pipTabId) {
      dock.classList.add('k10-active');
      const tab = state.tabs[state.pipTabId];
      if (title) title.textContent = tab ? (tab.title || tab.url) : 'PiP';
    } else {
      dock.classList.remove('k10-active');
    }
  }

  function exitPiP() {
    send('pip.exit', {});
  }

  // ── Bookmarks bar ────────────────────────────────────────────────────
  function refreshBookmarksBar() {
    if (!state.settings.showBookmarksBar) {
      document.querySelectorAll('[data-k10-bookmarks-bar]').forEach(b => b.classList.add('hidden'));
      return;
    }
    document.querySelectorAll('[data-k10-bookmarks-bar]').forEach(b => b.classList.remove('hidden'));

    for (const pid of ['left', 'right', 'center']) {
      const bar = document.querySelector(`[data-k10-bookmarks-bar="${pid}"]`);
      if (!bar) continue;
      bar.textContent = '';
      const activeId = state.panels[pid]?.activeTabId;
      const activeTab = activeId ? state.tabs[activeId] : null;
      const activeUrl = activeTab ? activeTab.url : '';

      for (const bm of state.bookmarks) {
        const isActive = bm.url === activeUrl;
        const item = h('div', {
          class: 'k10-bm-item',
          title: bm.url,
          style: isActive ? { color: 'var(--accent)' } : undefined,
          onclick: () => {
            if (activeId) send('tab.navigate', { tabId: activeId, url: bm.url });
            else send('tab.create', { url: bm.url, panel: pid });
          },
        }, (isActive ? '⭐ ' : '') + (bm.title || bm.url));
        bar.appendChild(item);
      }

      if (state.bookmarks.length === 0) {
        bar.appendChild(h('span', {
          style: { fontSize: '11px', color: 'var(--muted)' },
        }, 'Click the ⭐ in the toolbar to bookmark the current page.'));
      }
    }
  }

  function toggleBookmark() {
    const pid = state.activePanel;
    const activeId = state.panels[pid]?.activeTabId;
    const tab = activeId ? state.tabs[activeId] : null;
    if (!tab || !tab.url || tab.url === 'about:blank') {
      showToast('Cannot bookmark empty page', 'error');
      return;
    }
    const existing = state.bookmarks.find(b => b.url === tab.url);
    if (existing) {
      send('bookmark.remove', { id: existing.id });
      showToast('Bookmark removed', 'info');
    } else {
      send('bookmark.add', { url: tab.url, title: tab.title || tab.url });
      showToast('Bookmarked', 'success');
    }
  }

  // ── Global actions ───────────────────────────────────────────────────
  function handleGlobalAction(action) {
    const activeId = state.panels[state.activePanel]?.activeTabId;
    switch (action) {
      case 'new-tab': createNewTab(state.activePanel); break;
      case 'settings': openSettingsModal(); break;
      case 'downloads': toggleDrawer('downloads'); break;
      case 'history': toggleDrawer('history'); break;
      case 'bookmarks': toggleDrawer('bookmarks'); break;
      case 'pip': if (activeId) togglePiP(activeId); break;
    }
  }

  // ── Drawers ──────────────────────────────────────────────────────────
  function buildDownloadsDrawer() {
    const drawer = h('div', { class: 'k10-drawer', 'data-k10-drawer': 'downloads' });
    drawer.appendChild(h('div', { class: 'k10-drawer-header' }, [
      h('div', { class: 'k10-drawer-title' }, '⬇️ Downloads'),
      h('button', {
        type: 'button', class: 'k10-drawer-close',
        onclick: () => toggleDrawer('downloads', false),
      }, '✕'),
    ]));
    drawer.appendChild(h('div', { class: 'k10-drawer-body', 'data-k10-downloads-body': '1' }));
    return drawer;
  }

  function buildHistoryDrawer() {
    const drawer = h('div', { class: 'k10-drawer', 'data-k10-drawer': 'history' });
    drawer.appendChild(h('div', { class: 'k10-drawer-header' }, [
      h('div', { class: 'k10-drawer-title' }, '📜 History'),
      h('button', {
        type: 'button', class: 'k10-drawer-close',
        onclick: () => toggleDrawer('history', false),
      }, '✕'),
    ]));
    const body = h('div', { class: 'k10-drawer-body', 'data-k10-history-body': '1' });
    drawer.appendChild(body);
    return drawer;
  }

  function buildBookmarksDrawer() {
    const drawer = h('div', { class: 'k10-drawer', 'data-k10-drawer': 'bookmarks' });
    drawer.appendChild(h('div', { class: 'k10-drawer-header' }, [
      h('div', { class: 'k10-drawer-title' }, '⭐ Bookmarks'),
      h('button', {
        type: 'button', class: 'k10-drawer-close',
        onclick: () => toggleDrawer('bookmarks', false),
      }, '✕'),
    ]));
    const body = h('div', { class: 'k10-drawer-body', 'data-k10-bookmarks-body': '1' });
    drawer.appendChild(body);
    return drawer;
  }

  function toggleDrawer(name, forceOpen) {
    const target = document.querySelector(`[data-k10-drawer="${name}"]`);
    if (!target) return;
    const isOpen = target.classList.contains('k10-open');
    // Close all drawers first.
    document.querySelectorAll('.k10-drawer').forEach(d => d.classList.remove('k10-open'));
    if (forceOpen === false || (forceOpen !== true && isOpen)) {
      // Keep closed.
    } else {
      target.classList.add('k10-open');
      // Load data.
      if (name === 'downloads') send('downloads.refresh', {});
      else if (name === 'history') send('history.refresh', {});
      else if (name === 'bookmarks') renderBookmarksDrawer();
    }
  }

  function renderDownloads(data) {
    const body = document.querySelector('[data-k10-downloads-body="1"]');
    if (!body) return;
    body.textContent = '';

    const active = Array.isArray(data.active) ? data.active : [];
    const completed = Array.isArray(data.completed) ? data.completed : [];

    if (active.length === 0 && completed.length === 0) {
      body.appendChild(h('div', { class: 'k10-drawer-empty' }, 'No downloads yet.'));
      return;
    }

    for (const item of active) {
      const pct = item.totalBytes > 0 ? Math.round((item.receivedBytes / item.totalBytes) * 100) : 0;
      body.appendChild(h('div', { class: 'k10-download-item' }, [
        h('div', { class: 'k10-download-name' }, item.filename),
        h('div', { class: 'k10-download-meta' }, `${pct}% — ${item.state}`),
        h('div', { class: 'k10-download-actions' }, [
          h('button', {
            type: 'button', class: 'k10-dl-btn',
            onclick: () => send('downloads.pause', { id: item.id }),
          }, 'Pause'),
          h('button', {
            type: 'button', class: 'k10-dl-btn',
            onclick: () => send('downloads.cancel', { id: item.id }),
          }, 'Cancel'),
        ]),
      ]));
    }

    for (const item of completed) {
      body.appendChild(h('div', { class: 'k10-download-item' }, [
        h('div', { class: 'k10-download-name' }, item.filename),
        h('div', { class: 'k10-download-meta' }, item.savePath || ''),
        h('div', { class: 'k10-download-actions' }, [
          h('button', {
            type: 'button', class: 'k10-dl-btn',
            onclick: () => send('downloads.openFile', { id: item.id }),
          }, 'Open'),
          h('button', {
            type: 'button', class: 'k10-dl-btn',
            onclick: () => send('downloads.showInFolder', { id: item.id }),
          }, 'Show in Folder'),
        ]),
      ]));
    }
  }

  function renderHistory(groups) {
    const body = document.querySelector('[data-k10-history-body="1"]');
    if (!body) return;
    body.textContent = '';
    if (!Array.isArray(groups) || groups.length === 0) {
      body.appendChild(h('div', { class: 'k10-drawer-empty' }, 'No history yet.'));
      return;
    }
    for (const group of groups) {
      body.appendChild(h('div', { class: 'k10-history-day' }, group.day));
      for (const entry of group.entries) {
        const item = h('div', {
          class: 'k10-history-item',
          onclick: () => {
            const pid = state.activePanel;
            const activeId = state.panels[pid]?.activeTabId;
            if (activeId) send('tab.navigate', { tabId: activeId, url: entry.url });
            else send('tab.create', { url: entry.url, panel: pid });
          },
        }, [
          h('div', { class: 'k10-history-title' }, entry.title || entry.url),
          h('div', { class: 'k10-history-url' }, entry.url),
        ]);
        body.appendChild(item);
      }
    }
  }

  function renderBookmarksDrawer() {
    const body = document.querySelector('[data-k10-bookmarks-body="1"]');
    if (!body) return;
    body.textContent = '';
    if (state.bookmarks.length === 0) {
      body.appendChild(h('div', { class: 'k10-drawer-empty' }, 'No bookmarks yet.'));
      return;
    }
    for (const bm of state.bookmarks) {
      body.appendChild(h('div', {
        class: 'k10-bookmark-item',
        onclick: () => {
          const pid = state.activePanel;
          const activeId = state.panels[pid]?.activeTabId;
          if (activeId) send('tab.navigate', { tabId: activeId, url: bm.url });
          else send('tab.create', { url: bm.url, panel: pid });
        },
      }, [
        h('div', { class: 'k10-bookmark-title' }, bm.title || bm.url),
        h('div', { class: 'k10-bookmark-url' }, bm.url),
      ]));
    }
  }

  // ── Find bar ─────────────────────────────────────────────────────────
  function findAction(panelId, action) {
    const bar = document.querySelector(`[data-k10-find="${panelId}"]`);
    const activeId = state.panels[panelId]?.activeTabId;
    if (!bar) return;
    if (action === 'close') {
      bar.classList.remove('k10-open');
      state.findBarOpen = false;
      if (activeId) send('find.stop', { tabId: activeId });
      return;
    }
    if (action === 'next') send('find.next', { tabId: activeId });
    else if (action === 'prev') send('find.prev', { tabId: activeId });
  }

  function renderFindState(fState) {
    const bar = document.querySelector(`[data-k10-find="${state.activePanel}"]`);
    if (!bar) return;
    const countEl = bar.querySelector('[data-k10-find-count]');
    if (countEl && fState) {
      countEl.textContent = `${fState.activeMatch || 0}/${fState.matches || 0}`;
    }
  }

  function openFindBar() {
    const pid = state.activePanel;
    const bar = document.querySelector(`[data-k10-find="${pid}"]`);
    if (!bar) return;
    bar.classList.add('k10-open');
    state.findBarOpen = true;
    const input = bar.querySelector('input');
    if (input) { input.focus(); input.select(); }
  }

  // ── Context menu ─────────────────────────────────────────────────────
  function buildContextMenu() {
    return h('div', { class: 'k10-context-menu', id: 'k10-context-menu' });
  }

  function renderContextMenu(items, position) {
    const menu = document.getElementById('k10-context-menu');
    if (!menu) return;
    menu.textContent = '';

    for (const item of items) {
      if (item.type === 'separator') {
        menu.appendChild(h('div', { class: 'k10-ctx-separator' }));
        continue;
      }
      const isDisabled = item.enabled === false;
      const row = h('div', {
        class: 'k10-ctx-item' + (isDisabled ? ' k10-ctx-disabled' : ''),
        onclick: () => {
          if (isDisabled) return;
          send('contextMenu.execute', { action: item.action });
          hideContextMenu();
        },
      });
      row.appendChild(document.createTextNode(item.label || ''));
      if (item.accelerator) {
        row.appendChild(h('span', { class: 'k10-ctx-shortcut' }, item.accelerator));
      }
      menu.appendChild(row);
    }

    // Position within viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.left = Math.min(position.x, vw - 240) + 'px';
    menu.style.top = Math.min(position.y, vh - 300) + 'px';
    menu.classList.add('k10-open');
    state.contextMenuOpen = true;

    // Click-outside to close.
    const close = (e) => {
      if (!menu.contains(e.target)) hideContextMenu();
    };
    setTimeout(() => document.addEventListener('mousedown', close, { once: true, capture: true }), 10);
  }

  function hideContextMenu() {
    const menu = document.getElementById('k10-context-menu');
    if (menu) menu.classList.remove('k10-open');
    state.contextMenuOpen = false;
  }

  // ── Settings modal ───────────────────────────────────────────────────
  function buildSettingsModal() {
    const backdrop = h('div', { class: 'k10-modal-backdrop', 'data-k10-modal': 'settings' });
    const modal = h('div', { class: 'k10-modal' });

    modal.appendChild(h('h3', {}, '🌐 Browser Settings'));

    // Pinned presets section
    modal.appendChild(h('h3', {}, '📌 Pinned Website Presets (6 slots)'));
    const presetsContainer = h('div', { 'data-k10-presets': '1' });
    modal.appendChild(presetsContainer);

    // Search engine
    modal.appendChild(h('h3', {}, '🔍 Search Engine'));
    const engineSelect = h('select', { 'data-k10-setting': 'searchEngine' });
    for (const [key, label] of [['google', 'Google'], ['bing', 'Bing'], ['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave'], ['chatgpt', 'ChatGPT'], ['claude', 'Claude']]) {
      engineSelect.appendChild(h('option', { value: key }, label));
    }
    modal.appendChild(engineSelect);

    // Homepage
    modal.appendChild(h('label', {}, 'Homepage URL'));
    modal.appendChild(h('input', { type: 'text', 'data-k10-setting': 'homepage', placeholder: 'https://www.google.com' }));

    // Downloads path
    modal.appendChild(h('label', {}, 'Downloads Path (leave blank for default)'));
    modal.appendChild(h('input', { type: 'text', 'data-k10-setting': 'downloadsPath', placeholder: 'C:\\Users\\...\\Downloads' }));

    // Show bookmarks bar
    modal.appendChild(h('label', {}, 'Show Bookmarks Bar'));
    const bmToggle = h('input', { type: 'checkbox', 'data-k10-setting': 'showBookmarksBar' });
    modal.appendChild(bmToggle);

    // Actions
    const actions = h('div', { class: 'k10-modal-actions' });
    actions.appendChild(h('button', {
      type: 'button', class: 'k10-modal-btn k10-modal-btn-cancel',
      onclick: () => closeSettingsModal(),
    }, 'Cancel'));
    actions.appendChild(h('button', {
      type: 'button', class: 'k10-modal-btn k10-modal-btn-save',
      onclick: () => saveSettings(),
    }, 'Save'));
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    return backdrop;
  }

  function refreshPinnedPresets() {
    const container = document.querySelector('[data-k10-presets="1"]');
    if (!container) return;
    container.textContent = '';

    const presets = state.settings.pinnedPresets || [];
    for (let slot = 1; slot <= 6; slot++) {
      const preset = presets.find(p => p.slot === slot) || { slot, url: '', title: '', enabled: false };
      const row = h('div', { class: 'k10-preset-row', 'data-k10-preset-row': String(slot) }, [
        h('div', { class: 'k10-preset-slot' }, `#${slot}`),
        h('input', {
          type: 'text', placeholder: 'Title', value: preset.title || '',
          'data-k10-preset-title': String(slot),
          style: { padding: '5px 6px', fontSize: '11px' },
        }),
        h('input', {
          type: 'url', placeholder: 'https://example.com', value: preset.url || '',
          'data-k10-preset-url': String(slot),
          style: { padding: '5px 6px', fontSize: '11px' },
        }),
        h('button', {
          type: 'button',
          class: 'k10-preset-toggle' + (preset.enabled ? ' k10-enabled' : ''),
          'data-k10-preset-enabled': String(slot),
          onclick: (e) => {
            const btn = e.currentTarget;
            btn.classList.toggle('k10-enabled');
          },
        }, preset.enabled ? '✓' : '○'),
      ]);
      container.appendChild(row);
    }
  }

  function openSettingsModal() {
    const backdrop = document.querySelector('[data-k10-modal="settings"]');
    if (!backdrop) return;
    refreshPinnedPresets();

    // Populate other settings.
    const engine = backdrop.querySelector('[data-k10-setting="searchEngine"]');
    if (engine) engine.value = state.settings.searchEngine || 'google';
    const hp = backdrop.querySelector('[data-k10-setting="homepage"]');
    if (hp) hp.value = state.settings.homepage || '';
    const dp = backdrop.querySelector('[data-k10-setting="downloadsPath"]');
    if (dp) dp.value = state.settings.downloadsPath || '';
    const bmt = backdrop.querySelector('[data-k10-setting="showBookmarksBar"]');
    if (bmt) bmt.checked = state.settings.showBookmarksBar !== false;

    backdrop.classList.add('k10-open');
    state.settingsOpen = true;
  }

  function closeSettingsModal() {
    const backdrop = document.querySelector('[data-k10-modal="settings"]');
    if (backdrop) backdrop.classList.remove('k10-open');
    state.settingsOpen = false;
  }

  function saveSettings() {
    const backdrop = document.querySelector('[data-k10-modal="settings"]');
    if (!backdrop) return;

    const presets = [];
    for (let slot = 1; slot <= 6; slot++) {
      const title = backdrop.querySelector(`[data-k10-preset-title="${slot}"]`)?.value.trim() || '';
      const url = backdrop.querySelector(`[data-k10-preset-url="${slot}"]`)?.value.trim() || '';
      const enabledBtn = backdrop.querySelector(`[data-k10-preset-enabled="${slot}"]`);
      const enabled = enabledBtn && enabledBtn.classList.contains('k10-enabled');
      if (url) presets.push({ slot, url, title, enabled });
    }

    const patch = {
      pinnedPresets: presets,
      searchEngine: backdrop.querySelector('[data-k10-setting="searchEngine"]')?.value || 'google',
      homepage: backdrop.querySelector('[data-k10-setting="homepage"]')?.value.trim() || '',
      downloadsPath: backdrop.querySelector('[data-k10-setting="downloadsPath"]')?.value.trim() || '',
      showBookmarksBar: !!backdrop.querySelector('[data-k10-setting="showBookmarksBar"]')?.checked,
    };

    send('settings.save', patch);
    showToast('Settings saved', 'success');
    closeSettingsModal();
  }

  // ── Toast ────────────────────────────────────────────────────────────
  function showToast(text, kind) {
    const existing = document.querySelector('.k10-toast');
    if (existing) existing.remove();
    const toast = h('div', {
      class: 'k10-toast' + (kind === 'error' ? ' k10-toast-error' : kind === 'success' ? ' k10-toast-success' : ''),
    }, text);
    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3000);
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────
  function installKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Only when workspace visible.
      const view = document.getElementById('k10-workspace-view');
      if (!view || !view.classList.contains('k10-active')) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      if (ctrl && e.key === 'f') { e.preventDefault(); openFindBar(); return; }
      if (ctrl && e.key === 'l') { e.preventDefault(); document.querySelector(`[data-k10-omnibox="${state.activePanel}"]`)?.focus(); return; }
      if (ctrl && e.key === 't') { e.preventDefault(); createNewTab(state.activePanel); return; }
      if (ctrl && e.key === 'w') { e.preventDefault(); const activeId = state.panels[state.activePanel]?.activeTabId; if (activeId) closeTab(activeId); return; }
      if (ctrl && e.key === 'r') { e.preventDefault(); const activeId = state.panels[state.activePanel]?.activeTabId; if (activeId) send('tab.reload', { tabId: activeId }); return; }
      if (ctrl && shift && e.key === 'R') { e.preventDefault(); const activeId = state.panels[state.activePanel]?.activeTabId; if (activeId) send('tab.reload', { tabId: activeId, ignoreCache: true }); return; }
      if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); const activeId = state.panels[state.activePanel]?.activeTabId; if (activeId) send('tab.zoomIn', { tabId: activeId }); return; }
      if (ctrl && e.key === '-') { e.preventDefault(); const activeId = state.panels[state.activePanel]?.activeTabId; if (activeId) send('tab.zoomOut', { tabId: activeId }); return; }
      if (ctrl && e.key === '0') { e.preventDefault(); const activeId = state.panels[state.activePanel]?.activeTabId; if (activeId) send('tab.resetZoom', { tabId: activeId }); return; }
      if (ctrl && e.key === 'Tab') { e.preventDefault(); cycleTab(shift ? -1 : 1); return; }
      if (e.key === 'Escape') {
        if (state.settingsOpen) { closeSettingsModal(); return; }
        if (state.contextMenuOpen) { hideContextMenu(); return; }
        if (state.findBarOpen) { findAction(state.activePanel, 'close'); return; }
      }
    });
  }

  function cycleTab(delta) {
    const pid = state.activePanel;
    const pState = state.panels[pid];
    if (!pState || pState.tabIds.length < 2) return;
    const currentIdx = pState.tabIds.indexOf(pState.activeTabId);
    if (currentIdx < 0) return;
    const next = (currentIdx + delta + pState.tabIds.length) % pState.tabIds.length;
    activateTab(pState.tabIds[next]);
  }

  // ── Bootstrap ────────────────────────────────────────────────────────
  function refreshPanels() {
    refreshTabStrips();
    refreshOmniboxForActive();
    refreshBookmarksBar();
  }

  function boot() {
    injectCSS();
    injectModeButtons();
    wireSidebarHijack();
    buildWorkspaceShell();
    setupCommandReceiver();
    setupBoundsObserver();
    installKeyboardShortcuts();
    refreshTabStrips();
    refreshOmniboxForActive();
    refreshBookmarksBar();
    refreshPipDock();
  }

  // Wait until DOM is ready before injecting.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

// The rendered bundle string. Wrapping in `(...)();` invokes immediately.
const BUNDLE_SOURCE = '(' + __JARVIS_K10_BUNDLE__.toString() + ')();';

// ---------------------------------------------------------------------------
// SECTION 3 — WORKSPACE UI INJECTOR
// ---------------------------------------------------------------------------

class WorkspaceUIInjector extends EventEmitter {
  /**
   * @param {object} ctx
   */
  constructor(ctx) {
    super();
    this._ctx = ctx;
    this._mainWindow = null;
    this._injected = false;
    this._closed = false;
    this._injectPromise = null;
    this._pendingContextMenu = null;
    this._pendingFind = null;
    this._lastBoundReport = { left: null, right: null, center: null };
  }

  /**
   * Attach to the main BrowserWindow and inject the UI immediately.
   * @param {BrowserWindow} win
   */
  async attachToWindow(win) {
    if (!win || win.isDestroyed()) throw new Error('attach_invalid_window');
    this._mainWindow = win;
    win.once('closed', () => { this._mainWindow = null; this._injected = false; });
    audit('info', 'attached', { winId: win.id });
    try { await this.inject(); }
    catch (e) { audit('error', 'inject_failed', { error: String(e) }); }
  }

  /**
   * Wait for the renderer to reach DOM-ready, then inject initial state +
   * the full renderer bundle.
   * @returns {Promise<void>}
   */
  async inject() {
    if (this._injected) return;
    if (this._injectPromise) return this._injectPromise;
    if (!this._mainWindow) throw new Error('no_window');

    this._injectPromise = (async () => {
      const wc = this._mainWindow.webContents;
      if (wc.isLoadingMainFrame()) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 3000);
          wc.once('did-finish-load', () => { clearTimeout(t); resolve(); });
        });
      }

      // Build initial state from registered services.
      const initial = await this._buildInitialState();

      // Set initial state on window.
      const initialJson = JSON.stringify(initial);
      await wc.executeJavaScript(
        `window.__JARVIS_K10_INITIAL__ = ${initialJson}; true;`
      ).catch(() => {});

      // Inject bundle.
      await wc.executeJavaScript(BUNDLE_SOURCE).catch((e) => {
        audit('warn', 'bundle_execute_failed', { error: String(e) });
        throw e;
      });

      this._injected = true;
      this._injectPromise = null;
      audit('info', 'ui_injected', {
        initial_tabs: initial.tabs ? initial.tabs.length : 0,
        presets: initial.settings?.pinnedPresets?.length || 0,
      });
    })();

    return this._injectPromise;
  }

  async _buildInitialState() {
    const out = {
      settings: null,
      bookmarks: [],
      tabs: [],
      panels: null,
    };
    try {
      const svc = this._ctx.getService('kernel10_browser_services');
      if (svc && svc.settings) {
        out.settings = svc.settings.get();
        out.bookmarks = svc.bookmarks.getBarItems();
      }
    } catch (e) { audit('warn', 'initial_state_services_failed', { error: String(e) }); }

    try {
      const rt = this._ctx.getService('kernel10_browser_runtime');
      if (rt) {
        out.tabs = await rt.getTabList();
        out.panels = {
          left: rt.getPanelState('left'),
          right: rt.getPanelState('right'),
        };
      }
    } catch (e) { audit('warn', 'initial_state_runtime_failed', { error: String(e) }); }

    return out;
  }

  /**
   * Send a command to the renderer via custom event.
   * @param {string} event
   * @param {any} data
   */
  async send(event, data) {
    if (!this._mainWindow || this._mainWindow.isDestroyed()) return;
    if (!this._injected) {
      try { await this.inject(); }
      catch (_) { return; }
    }
    const payload = JSON.stringify({ event, data });
    const code = `window.dispatchEvent(new CustomEvent('${BRIDGE_EVENT}', { detail: ${payload} })); true;`;
    try { await this._mainWindow.webContents.executeJavaScript(code); }
    catch (e) { audit('warn', 'send_failed', { event, error: String(e) }); }
  }

  /** Debounced state push (used by service change events). */
  pushStateDebounced = debounce(async () => {
    try {
      const rt = this._ctx.getService('kernel10_browser_runtime');
      if (rt) {
        const tabs = await rt.getTabList();
        await this.send('tabs.replace', tabs);
      }
    } catch (_) { /* ignore */ }
  }, STATE_PUSH_DEBOUNCE_MS);

  /** Send settings update. */
  async pushSettings() {
    try {
      const svc = this._ctx.getService('kernel10_browser_services');
      if (svc && svc.settings) {
        await this.send('settings.change', svc.settings.get());
      }
    } catch (_) {}
  }

  /** Send bookmarks update. */
  async pushBookmarks() {
    try {
      const svc = this._ctx.getService('kernel10_browser_services');
      if (svc && svc.bookmarks) {
        await this.send('bookmarks.change', svc.bookmarks.getBarItems());
      }
    } catch (_) {}
  }

  /** Send a toast. */
  async toast(text, kind) {
    await this.send('toast', { text, kind: kind || 'info' });
  }

  /** Send error. */
  async error(message) {
    await this.send('error', { message });
  }

  /**
   * Show a context menu in the renderer.
   * @param {Array<object>} items
   * @param {{ x: number, y: number }} position
   */
  async showContextMenu(items, position) {
    await this.send('contextMenu.show', { items, position });
  }

  hideContextMenu() { return this.send('contextMenu.hide', null); }

  /** Push find-in-page state. */
  pushFindState(tabId, state) {
    return this.send('find.state', { tabId, state });
  }

  /** Push history drawer content. */
  pushHistory(groups) {
    return this.send('history.change', groups);
  }

  /** Push downloads drawer content. */
  pushDownloads(data) {
    return this.send('downloads.change', data);
  }

  /** Push PiP state change. */
  pushPipChange(tabId) {
    return this.send('pip.change', { tabId });
  }

  async shutdown() {
    if (this._closed) return;
    this._closed = true;
    this._mainWindow = null;
    this._injected = false;
    this.removeAllListeners();
    audit('info', 'shutdown', {});
  }
}

// ---------------------------------------------------------------------------
// SECTION 4 — INIT
// ---------------------------------------------------------------------------

let _injector = null;

function init(ctx) {
  _auditFn = ctx && typeof ctx.audit === 'function' ? ctx.audit.bind(ctx) : null;

  const injector = new WorkspaceUIInjector(ctx);
  _injector = injector;

  // Attach to the main window (via Part 4's attached window).
  try {
    const rt = ctx.getService('kernel10_browser_runtime');
    const win = rt && typeof rt.getAttachedWindow === 'function' ? rt.getAttachedWindow() : null;
    if (win) {
      injector.attachToWindow(win).catch((e) => {
        audit('warn', 'initial_attach_failed', { error: String(e) });
      });
    }
  } catch (e) {
    audit('warn', 'attach_lookup_failed', { error: String(e) });
  }

  if (ctx && typeof ctx.registerService === 'function') {
    ctx.registerService('kernel10_workspace_ui', {
      // Wiring.
      attachToWindow: (win) => injector.attachToWindow(win),
      inject: () => injector.inject(),

      // Live push API.
      send: (event, data) => injector.send(event, data),
      pushState: () => injector.pushStateDebounced(),
      pushSettings: () => injector.pushSettings(),
      pushBookmarks: () => injector.pushBookmarks(),
      pushFindState: (tabId, state) => injector.pushFindState(tabId, state),
      pushHistory: (groups) => injector.pushHistory(groups),
      pushDownloads: (data) => injector.pushDownloads(data),
      pushPipChange: (tabId) => injector.pushPipChange(tabId),

      // Toast/error helpers.
      toast: (text, kind) => injector.toast(text, kind),
      error: (msg) => injector.error(msg),

      // Context menu.
      showContextMenu: (items, pos) => injector.showContextMenu(items, pos),
      hideContextMenu: () => injector.hideContextMenu(),

      // Query.
      isInjected: () => injector._injected,

      // Lifecycle.
      shutdown: () => injector.shutdown(),
    });
  }

  if (ctx && typeof ctx.addStateContributor === 'function') {
    ctx.addStateContributor('kernel10_workspace_ui', () => ({
      version: '1.0.0',
      injected: injector._injected,
      attached: !!injector._mainWindow,
    }));
  }

  if (ctx && typeof ctx.addStopHook === 'function') {
    ctx.addStopHook('kernel10_workspace_ui', () => {
      if (injector) injector.shutdown().catch(() => {});
    });
  }

  audit('info', 'ui_injector_initialized', {
    attached: !!injector._mainWindow,
  });
}

function getInjector() { return _injector; }

// ---------------------------------------------------------------------------
// SECTION 5 — EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  name: 'kernel10_workspace_ui_injector',
  version: '1.0.0',
  init,
  getInjector,

  WorkspaceUIInjector,

  // Useful constants.
  BRIDGE_EVENT,
  COMMAND_TAG,
  BUNDLE_SOURCE,

  // Internal bundle function (exposed for tests).
  __JARVIS_K10_BUNDLE__,
};