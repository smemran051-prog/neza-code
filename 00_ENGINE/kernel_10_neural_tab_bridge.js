'use strict';

/**
 * ============================================================================
 * KERNEL 10 — PART 7 of 7 — MASTER ORCHESTRATOR
 * kernel_10_neural_tab_bridge.js
 * Location: C:\Jarvis_Core\00_ENGINE\kernel_10_neural_tab_bridge.js
 * Version:  1.0.0-enterprise
 * ============================================================================
 *
 * RESPONSIBILITY
 * --------------
 * The single entry point registered in 00_ENGINE/extensions.json. Loads and
 * bootstraps all six Kernel-10 sub-modules (Parts 1–6), then becomes the glue
 * that connects:
 *
 *   - kernel_9's existing jarvis:ai-prompt pipeline (as a downstream)
 *   - kernel_10_stt_intent_normalizer (Part 1)  — STT routing
 *   - kernel_10_shared_context_bus    (Part 2)  — cross-tab context
 *   - kernel_10_webview_preload.js    (Part 3)  — per-tab sensor (used by runtime)
 *   - kernel_10_browser_runtime       (Part 4)  — tab/panel/PiP runtime
 *   - kernel_10_browser_services      (Part 5)  — bookmarks/history/downloads
 *   - kernel_10_workspace_ui_injector (Part 6)  — Chrome-Lite frontend
 *
 * Provides these capabilities:
 *
 *   1. STT-first prompt pipeline (Part 1) prepended to kernel_9's AI routing.
 *      In {mode:'task', subMode:'assisted'}, garbled Bengali/Banglish STT is
 *      phonetically matched to canonical intents. On match, the tool is
 *      dispatched and the reply is sent directly — kernel_9/LLM never sees it.
 *      On miss, execution falls through to kernel_9 unchanged.
 *
 *   2. Unified IPC handlers for `jarvis:k10-*` channels emitted by Part 3's
 *      preload (context push, tab response, pill click, relay tab list, etc.).
 *
 *   3. Full command routing for `__K10__`-tagged `jarvis:ai-prompt` messages
 *      sent by Part 6's injected frontend (tab.create, panel.setBounds,
 *      overlay.toggle, settings.save, downloads.*, etc.).
 *
 *   4. Event forwarders: runtime + services → Part 6 renderer. Tab lifecycle,
 *      PiP state, downloads, find, bookmarks, history — all pushed live.
 *
 *   5. Context-menu wiring: every tab's webContents 'context-menu' event is
 *      routed through Part 5's ContextMenuBuilder and displayed by Part 6.
 *
 *   6. Overlay watcher: hides WebContentsViews when Part 6 opens any modal/
 *      drawer/context-menu (native views cannot be layered under HTML).
 *
 *   7. STT tool re-registration: fixes Part 1's default handlers for browser
 *      intents using the correct Part 4 method names (activateTabByIndex vs
 *      activateTab).
 *
 *   8. Master service registration under 'kernel10_neural_tab_bridge' so other
 *      kernels (and tests) can introspect Kernel-10 state.
 *
 * IPC CONTRACT SUMMARY
 * --------------------
 *   From Part 3 preload (per-tab):
 *     jarvis:k10-preload-ready
 *     jarvis:k10-context-push
 *     jarvis:k10-tab-response
 *     jarvis:k10-selection-change
 *     jarvis:k10-pill-click
 *     jarvis:k10-preload-error
 *     jarvis:k10-relay-tabs
 *
 *   From Part 6 renderer (piggybacked on jarvis:ai-prompt with __K10__ tag):
 *     All tab.*, panel.*, pip.*, layout.*, overlay.toggle, settings.save,
 *     bookmark.*, downloads.*, history.refresh, find.*, contextMenu.execute
 *
 *   To Part 6 renderer (via Part 6's executeJavaScript bridge):
 *     tabs.replace, tab.add, tab.update, tab.remove, tab.activate, panels.update,
 *     pip.change, settings.change, bookmarks.change, downloads.change,
 *     find.state, history.change, toast, error, contextMenu.show/hide,
 *     layout.change
 *
 * INIT ORDER (guaranteed by extensions.json)
 * ------------------------------------------
 *   kernel_9_adaptive_intelligence.js  → loads first, wraps jarvis:ai-prompt
 *   kernel_10_neural_tab_bridge.js     → loads second, wraps kernel_9's wrapper
 *   Sub-modules (Parts 1–6)            → loaded by this file, in dependency order:
 *                                         stt → bus → runtime → services → ui
 *
 * FROZEN-CORE COMPLIANCE
 * ----------------------
 *   - kernel.js, preload.js untouched
 *   - index.html / app.js / style.css untouched (injection via executeJavaScript)
 *   - Only ctx.registerService / addStateContributor / addStopHook used
 *   - All renderer IPC piggybacks on allow-listed channels
 * ============================================================================
 */

const { BrowserWindow, ipcMain, app } = require('electron');
const path = require('path');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// SECTION 0 — CONSTANTS
// ---------------------------------------------------------------------------

const LOG_TAG = 'k10.master';
const BRIDGE_EVENT = 'jarvis-k10-cmd';
const COMMAND_TAG = '__K10__';

// Recognised workspace layouts, kept in sync with Part 6.
const VALID_LAYOUTS = Object.freeze(new Set([
  'browser-full',
  'chat-browser',
  'browser-browser',
  'multi',
]));

// Sub-module descriptors — canonical load order matters.
// Each entry: { file, serviceName, label, requiresWindow, asyncInit }
const SUB_MODULES = Object.freeze([
  { file: './kernel_10_stt_intent_normalizer', serviceName: 'kernel10_stt_normalizer',      label: 'stt_normalizer',       requiresWindow: false, asyncInit: false },
  { file: './kernel_10_shared_context_bus',    serviceName: 'kernel10_shared_context_bus',  label: 'shared_context_bus',   requiresWindow: false, asyncInit: false },
  { file: './kernel_10_browser_runtime',       serviceName: 'kernel10_browser_runtime',     label: 'browser_runtime',      requiresWindow: true,  asyncInit: true  },
  { file: './kernel_10_browser_services',      serviceName: 'kernel10_browser_services',    label: 'browser_services',     requiresWindow: false, asyncInit: false },
  { file: './kernel_10_workspace_ui_injector', serviceName: 'kernel10_workspace_ui',        label: 'workspace_ui',         requiresWindow: true,  asyncInit: true  },
]);

// ---------------------------------------------------------------------------
// SECTION 1 — UTILITIES
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

/**
 * Try to require a module; returns null on failure.
 * @param {string} modulePath
 * @param {string} label
 * @returns {any|null}
 */
function safeRequire(modulePath, label) {
  try { return require(modulePath); }
  catch (e) {
    audit('warn', 'submodule_require_failed', { label, error: String(e) });
    return null;
  }
}

/**
 * Parse a __K10__ command from the raw prompt field.
 * Returns null if the payload doesn't contain a valid command.
 * @param {string} prompt
 * @returns {{ action: string, payload: any } | null}
 */
function parseKernel10Command(prompt) {
  if (typeof prompt !== 'string' || !prompt.startsWith(COMMAND_TAG)) return null;
  try {
    const raw = prompt.slice(COMMAND_TAG.length);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') return null;
    return { action: parsed.action, payload: parsed.payload };
  } catch (e) {
    audit('warn', 'command_parse_failed', { error: String(e) });
    return null;
  }
}

/**
 * Resolve the primary application BrowserWindow. In JARVIS-CORE, exactly one
 * main window exists (created by frozen kernel.js). Additional windows may
 * exist for native popups — those are tracked by Part 4's PopupWindowManager.
 * @returns {BrowserWindow|null}
 */
function getMainWindow() {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (w.isDestroyed()) continue;
      try {
        const t = w.getTitle();
        if (t && /JARVIS-CORE/i.test(t)) return w;
      } catch (_) { /* ignore */ }
    }
    return wins[0] || null;
  } catch (_) {
    return null;
  }
}

/**
 * Map a webContents to its owning tab id via Part 4's internal map.
 * @param {Electron.WebContents} sender
 * @param {object} ctx
 * @returns {string|null}
 */
function findTabIdBySender(sender, ctx) {
  if (!sender) return null;
  try {
    const rt = require('./kernel_10_browser_runtime').getRuntime();
    if (!rt || !rt._tabs) return null;
    for (const tab of rt._tabs.values()) {
      if (tab.webContents === sender) return tab.id;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Return the BrowserTab object (with view + webContents) for a tab id.
 * @param {string} tabId
 * @returns {any|null}
 */
function findRawTab(tabId) {
  try {
    const rt = require('./kernel_10_browser_runtime').getRuntime();
    if (!rt || !rt._tabs) return null;
    return rt._tabs.get(tabId) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Format a tool-dispatch result into a human-readable Bengali/English reply.
 * @param {{ ok: boolean, intent: string, result?: any, error?: string }} result
 * @param {string} intent
 * @param {number} confidence
 * @param {{ source?: string }} [route]
 * @returns {string}
 */
function formatToolResult(result, intent, confidence, route) {
  if (!result || !result.ok) {
    const err = (result && result.error) || 'unknown_error';
    return `⚠️ **${intent}** — ${err}`;
  }
  const inner = result.result;

  // kernel_9 tools return { ok, msg }
  if (inner && typeof inner === 'object' && typeof inner.msg === 'string') {
    return inner.msg;
  }

  // GET_CURRENT_MODE returns a rich summary.
  if (intent === 'GET_CURRENT_MODE' && inner && typeof inner.summary === 'string') {
    return `🧠 **Current Mode**\n${inner.summary}`;
  }

  // Friendly names for browser intents.
  const FRIENDLY = {
    SWITCH_TAB: '✅ Tab switched',
    NEW_TAB: '✅ New tab opened',
    CLOSE_TAB: '✅ Tab closed',
    OPEN_URL: '✅ URL opened',
    RELAY_TAB_DATA: '✅ Content relayed to tab',
    SWITCH_LAYOUT: '✅ Workspace layout changed',
    FIND_IN_PAGE: '✅ Find in page started',
    START_LEARNING: '🔵 Learning mode started',
    STOP_LEARNING: '✅ Learning mode stopped',
    EXECUTE_SURROGATE: '✅ Workflow executed',
  };
  const friendly = FRIENDLY[intent] || `✅ ${intent}`;

  const conf = typeof confidence === 'number' ? Math.round(confidence * 100) : 100;
  const src = route && route.source ? route.source : 'phonetic';
  let detail = '';
  if (inner && typeof inner === 'object' && Object.keys(inner).length > 0) {
    try { detail = '\n' + JSON.stringify(inner, null, 2).slice(0, 400); }
    catch (_) { /* ignore */ }
  } else if (inner !== undefined && inner !== null) {
    detail = '\n' + String(inner).slice(0, 400);
  }
  return `${friendly} (via ${src} ${conf}%)${detail}`;
}

// ---------------------------------------------------------------------------
// SECTION 2 — SUB-MODULE LOADER
// ---------------------------------------------------------------------------

/**
 * Load and initialise one Kernel-10 sub-module. If it's already registered
 * (e.g. because the user separately added it to extensions.json), skip init.
 * Handles both sync and async init().
 *
 * @param {object} descriptor
 * @param {object} ctx
 * @param {object} [initOpts]
 * @returns {Promise<{ ok: boolean, label: string, module: any, service: any }>}
 */
async function loadSubModule(descriptor, ctx, initOpts) {
  const label = descriptor.label;

  // Already initialised? Skip.
  if (ctx && typeof ctx.getService === 'function') {
    const existing = ctx.getService(descriptor.serviceName);
    if (existing) {
      audit('info', 'submodule_already_registered', { label, serviceName: descriptor.serviceName });
      return { ok: true, label, module: safeRequire(descriptor.file, label), service: existing };
    }
  }

  const mod = safeRequire(descriptor.file, label);
  if (!mod) {
    return { ok: false, label, module: null, service: null };
  }
  if (typeof mod.init !== 'function') {
    audit('warn', 'submodule_missing_init', { label });
    return { ok: false, label, module: mod, service: null };
  }

  try {
    const result = mod.init(ctx, initOpts);
    if (descriptor.asyncInit && result && typeof result.then === 'function') {
      await result;
    }
    const service = ctx && typeof ctx.getService === 'function'
      ? ctx.getService(descriptor.serviceName)
      : null;
    audit('info', 'submodule_loaded', { label, service_registered: !!service });
    return { ok: true, label, module: mod, service };
  } catch (e) {
    audit('error', 'submodule_init_failed', { label, error: String(e) });
    return { ok: false, label, module: mod, service: null };
  }
}

// ---------------------------------------------------------------------------
// SECTION 3 — STT-FIRST PROMPT PIPELINE
// ---------------------------------------------------------------------------
// Wraps kernel_9's existing `jarvis:ai-prompt` handler. Order:
//
//   [user prompt]
//     ↓
//   [__K10__ tagged?] → handleKernel10Command → reply → DONE
//     ↓ no
//   [mode=task, subMode=assisted, no _k10NoSTT?]
//     ↓ yes
//   [stt_normalizer.route()]
//     ↓ intent found?
//     ↓ yes → dispatch → reply → DONE
//     ↓ no
//   [kernel_9's downstream handler]  (unchanged behaviour)
// ---------------------------------------------------------------------------

let _downstream = null;
let _pipelineInstalled = false;

/**
 * Install the top-level IPC wrapper around the current `jarvis:ai-prompt`
 * handler (which is kernel_9's). Idempotent.
 * @param {object} ctx
 */
function installUnifiedAIPromptPipeline(ctx) {
  if (_pipelineInstalled) return;

  const listeners = ipcMain.listeners('jarvis:ai-prompt');
  if (listeners.length === 0) {
    audit('warn', 'no_downstream_listener', { note: 'kernel_9 not loaded yet? deferring' });
    return;
  }
  _downstream = listeners[0];
  ipcMain.removeAllListeners('jarvis:ai-prompt');

  ipcMain.on('jarvis:ai-prompt', async (event, data) => {
    try {
      // ── (A) __K10__ command path ────────────────────────────────────
      const tagged = data && (data._k10 || parseKernel10Command(data.prompt));
      if (tagged) {
        const command = data._k10
          ? { action: data._k10.action, payload: data._k10.payload }
          : tagged;
        try {
          await handleKernel10Command(command, event, ctx);
        } catch (e) {
          audit('warn', 'k10_command_error', { action: command.action, error: String(e) });
          try { event.sender.send('jarvis:ai-response', { text: `⚠️ Kernel-10 command failed: ${String(e)}` }); }
          catch (_) {}
        }
        return; // Do NOT reach kernel_9
      }

      // ── (B) STT-first routing (Part 1) ─────────────────────────────
      const stt = ctx.getService('kernel10_stt_normalizer');
      const rawPrompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';
      const isTaskAssisted = data
        && data.mode === 'task'
        && data.subMode === 'assisted'
        && !data._k10NoSTT;
      if (stt && isTaskAssisted && rawPrompt) {
        try {
          const routeResult = await stt.route(rawPrompt, ctx, {
            mode: data.mode,
            subMode: data.subMode,
          });
          if (routeResult && routeResult.ok && routeResult.intent) {
            const dispatchResult = await stt.dispatch(
              routeResult.intent,
              routeResult.slots,
              ctx,
              { rawText: rawPrompt }
            );
            const reply = formatToolResult(
              dispatchResult, routeResult.intent, routeResult.confidence, routeResult
            );
            if (!event.sender.isDestroyed()) {
              event.sender.send('jarvis:ai-response', { text: reply });
            }
            return; // STT handled; kernel_9 not invoked
          }
        } catch (e) {
          audit('warn', 'stt_pipeline_error', { error: String(e) });
          // Fall through to kernel_9
        }
      }

      // ── (C) Fall-through: kernel_9 + LLM ──────────────────────────
      if (typeof _downstream === 'function') {
        _downstream(event, data);
      } else {
        audit('warn', 'no_downstream_at_dispatch', {});
        try { event.sender.send('jarvis:ai-response', { text: '⚠️ AI pipeline not available.' }); }
        catch (_) {}
      }
    } catch (e) {
      audit('error', 'ai_prompt_pipeline_error', { error: String(e) });
      try { event.sender.send('jarvis:ai-response', { text: `⚠️ Pipeline error: ${String(e)}` }); }
      catch (_) {}
    }
  });

  _pipelineInstalled = true;
  audit('info', 'ai_prompt_pipeline_installed', { downstream: 'kernel_9' });
}

// ---------------------------------------------------------------------------
// SECTION 4 — __K10__ COMMAND ROUTER
// ---------------------------------------------------------------------------
// Commands come from Part 6's renderer via `jarvis:ai-prompt` with the
// `__K10__` prefix. Every command is deterministic — no LLM, no STT.
// ---------------------------------------------------------------------------

async function handleKernel10Command(command, event, ctx) {
  if (!command || typeof command !== 'object' || typeof command.action !== 'string') return;
  const action = command.action;
  const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};

  const runtime = ctx.getService('kernel10_browser_runtime');
  const services = ctx.getService('kernel10_browser_services');
  const workspaceUi = ctx.getService('kernel10_workspace_ui');
  const bus = ctx.getService('kernel10_shared_context_bus');

  try {
    switch (action) {
      // ── Tabs ──────────────────────────────────────────────────────
      case 'tab.create': {
        if (!runtime) return void audit('warn', 'cmd_no_runtime', { action });
        await runtime.createTab(payload.url || 'about:blank', {
          panel: payload.panel,
          isPinned: !!payload.isPinned,
        });
        return;
      }
      case 'tab.close': {
        if (!runtime || !payload.tabId) return;
        await runtime.closeTab(payload.tabId);
        return;
      }
      case 'tab.activate': {
        if (!runtime || !payload.tabId) return;
        await runtime.activateTab(payload.tabId);
        return;
      }
      case 'tab.navigate': {
        if (!runtime || !payload.tabId || !payload.url) return;
        await runtime.navigateTab(payload.tabId, payload.url);
        return;
      }
      case 'tab.reload': {
        if (!runtime || !payload.tabId) return;
        runtime.reloadTab(payload.tabId, !!payload.ignoreCache);
        return;
      }
      case 'tab.goBack': {
        if (!runtime || !payload.tabId) return;
        runtime.goBack(payload.tabId);
        return;
      }
      case 'tab.goForward': {
        if (!runtime || !payload.tabId) return;
        runtime.goForward(payload.tabId);
        return;
      }
      case 'tab.zoomIn': {
        if (!runtime || !payload.tabId) return;
        runtime.zoomIn(payload.tabId);
        return;
      }
      case 'tab.zoomOut': {
        if (!runtime || !payload.tabId) return;
        runtime.zoomOut(payload.tabId);
        return;
      }
      case 'tab.resetZoom': {
        if (!runtime || !payload.tabId) return;
        runtime.resetZoom(payload.tabId);
        return;
      }
      case 'tab.devtools': {
        if (!payload.tabId) return;
        const rawTab = findRawTab(payload.tabId);
        if (rawTab && rawTab.webContents) {
          if (rawTab.webContents.isDevToolsOpened()) rawTab.webContents.closeDevTools();
          else rawTab.webContents.openDevTools({ mode: 'detach' });
        }
        return;
      }

      // ── Panels ────────────────────────────────────────────────────
      case 'panel.setBounds': {
        if (!runtime || !payload.panelId) return;
        runtime.setPanelBounds(payload.panelId, payload.bounds || null);
        return;
      }
      case 'panel.setVisibility': {
        if (!payload || typeof payload !== 'object') return;
        for (const [panelId, state] of Object.entries(payload)) {
          if (!state) continue;
          const panelState = runtime && runtime.getPanelState ? runtime.getPanelState(panelId) : null;
          if (!runtime) continue;
          runtime.setPanelBounds(
            panelId,
            state.visible ? (panelState && panelState.bounds) : null
          );
        }
        return;
      }
      case 'panel.swap': {
        if (!runtime) return;
        const left = runtime.getPanelState('left');
        const right = runtime.getPanelState('right');
        if (!left || !right) return;
        runtime.setPanelBounds('left', right.bounds);
        runtime.setPanelBounds('right', left.bounds);
        return;
      }

      // ── PiP ───────────────────────────────────────────────────────
      case 'pip.enter': {
        if (!runtime || !payload.tabId) return;
        const result = runtime.enterPiP(payload.tabId);
        if (!result.ok && workspaceUi) {
          workspaceUi.toast(result.error === 'pip_already_active'
            ? 'A PiP window is already open'
            : `PiP failed: ${result.error}`, 'error');
        }
        return;
      }
      case 'pip.exit': {
        if (!runtime) return;
        await runtime.exitPiP();
        return;
      }

      // ── Layout ────────────────────────────────────────────────────
      case 'layout.change': {
        if (!payload.layout || !VALID_LAYOUTS.has(payload.layout)) return;
        if (workspaceUi) {
          await workspaceUi.send('layout.change', { layout: payload.layout });
        }
        return;
      }

      // ── Overlays (hide views when any modal is open) ──────────────
      case 'overlay.toggle': {
        const open = !!(payload && payload.open);
        try {
          const rt = require('./kernel_10_browser_runtime').getRuntime();
          if (rt && rt._tabs) {
            for (const tab of rt._tabs.values()) {
              try { tab.view.setVisible(!open); }
              catch (_) {}
            }
          }
        } catch (_) { /* ignore */ }
        return;
      }

      // ── Bookmarks ─────────────────────────────────────────────────
      case 'bookmark.add': {
        if (!services || !payload.url) return;
        services.bookmarks.add({ url: payload.url, title: payload.title });
        return;
      }
      case 'bookmark.remove': {
        if (!services || !payload.id) return;
        services.bookmarks.remove(payload.id);
        return;
      }

      // ── Settings ──────────────────────────────────────────────────
      case 'settings.save': {
        if (!services) return;
        const patch = { ...payload };
        if (Array.isArray(patch.pinnedPresets)) {
          patch.pinnedPresets = patch.pinnedPresets.map((p) => ({
            slot: Number(p.slot),
            url: String(p.url || ''),
            title: String(p.title || ''),
            enabled: p.enabled !== false,
          }));
        }
        services.settings.update(patch);
        return;
      }

      // ── Downloads ─────────────────────────────────────────────────
      case 'downloads.refresh': {
        if (!services || !workspaceUi) return;
        const active = services.downloads.getActive();
        const completed = services.downloads.getCompleted();
        workspaceUi.pushDownloads({ active, completed });
        return;
      }
      case 'downloads.pause': {
        if (services && payload.id) services.downloads.pause(payload.id);
        return;
      }
      case 'downloads.resume': {
        if (services && payload.id) services.downloads.resume(payload.id);
        return;
      }
      case 'downloads.cancel': {
        if (services && payload.id) services.downloads.cancel(payload.id);
        return;
      }
      case 'downloads.openFile': {
        if (services && payload.id) services.downloads.openFile(payload.id);
        return;
      }
      case 'downloads.showInFolder': {
        if (services && payload.id) services.downloads.showInFolder(payload.id);
        return;
      }

      // ── History ───────────────────────────────────────────────────
      case 'history.refresh': {
        if (!services || !workspaceUi) return;
        const groups = services.history.groupedByDay(300);
        workspaceUi.pushHistory(groups);
        return;
      }

      // ── Find in page ──────────────────────────────────────────────
      case 'find.start': {
        if (!services || !payload.tabId) return;
        services.find.start(payload.tabId, payload.query || '');
        return;
      }
      case 'find.next': {
        if (services && payload.tabId) services.find.next(payload.tabId);
        return;
      }
      case 'find.prev': {
        if (services && payload.tabId) services.find.prev(payload.tabId);
        return;
      }
      case 'find.stop': {
        if (services && payload.tabId) services.find.stop(payload.tabId);
        return;
      }

      // ── Context menu ──────────────────────────────────────────────
      case 'contextMenu.execute': {
        if (!services || !payload.action) return;
        await services.contextMenu.execute(payload.action);
        return;
      }

      default:
        audit('warn', 'unknown_command', { action });
        return;
    }
  } catch (e) {
    audit('error', 'command_handler_error', { action, error: String(e) });
    if (workspaceUi) {
      try { await workspaceUi.error(`Command failed: ${action} — ${String(e)}`); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// SECTION 5 — PRELOAD IPC HANDLERS
// ---------------------------------------------------------------------------
// Channels emitted by Part 3's preload running in each WebContentsView.
// Part 7 owns these because they are all cross-cutting glue.
// ---------------------------------------------------------------------------

let _ipcInstalled = false;

function installKernel10IPCListeners(ctx) {
  if (_ipcInstalled) return;
  _ipcInstalled = true;

  // Handshake from preload.
  ipcMain.on('jarvis:k10-preload-ready', (event, payload) => {
    const tabId = findTabIdBySender(event.sender, ctx);
    audit('info', 'preload_ready', {
      tabId,
      url: payload && payload.url,
      adapter: payload && payload.adapter,
    });
    // Track per-tab metadata for relay target discovery.
    try {
      const runtime = ctx.getService('kernel10_browser_runtime');
      if (runtime && tabId) {
        const tab = runtime.getTab(tabId);
        if (tab && payload) {
          const bus = ctx.getService('kernel10_shared_context_bus');
          // Noop — bus will be updated as contexts arrive.
        }
      }
    } catch (_) {}
  });

  // Context push from a tab (selection, code block, AI response, etc.).
  ipcMain.on('jarvis:k10-context-push', (event, payload) => {
    try {
      const bus = ctx.getService('kernel10_shared_context_bus');
      if (!bus) return;
      const tabId = findTabIdBySender(event.sender, ctx);
      const runtime = ctx.getService('kernel10_browser_runtime');
      const tab = runtime && tabId ? runtime.getTab(tabId) : null;
      bus.pushFromTab(payload, {
        tabId,
        tabIndex: tab ? tab.index : -1,
        url: tab ? tab.url : '',
        title: tab ? tab.title : '',
      });
    } catch (e) {
      audit('warn', 'context_push_failed', { error: String(e) });
    }
  });

  // Streaming-response completion signal from a tab (Claude/ChatGPT/etc.).
  ipcMain.on('jarvis:k10-tab-response', (event, payload) => {
    try {
      const bus = ctx.getService('kernel10_shared_context_bus');
      if (!bus) return;
      const tabId = findTabIdBySender(event.sender, ctx);
      const runtime = ctx.getService('kernel10_browser_runtime');
      const tab = runtime && tabId ? runtime.getTab(tabId) : null;
      bus.handleTabResponse(Object.assign({}, payload, {
        tabId: tabId || (payload && payload.tabId),
        source: {
          tabId: tabId,
          tabIndex: tab ? tab.index : -1,
          url: tab ? tab.url : '',
          title: tab ? tab.title : '',
          app: payload && payload.source && payload.source.app,
        },
      }));
    } catch (e) {
      audit('warn', 'tab_response_failed', { error: String(e) });
    }
  });

  // Selection indicator for the HUD (cheap event, no context push).
  ipcMain.on('jarvis:k10-selection-change', (event, payload) => {
    // Could be forwarded to a live HUD indicator — currently a no-op.
    // Part 6 already displays a live selection toolbar.
  });

  // Pill click from a code block or table in a tab.
  ipcMain.on('jarvis:k10-pill-click', async (event, payload) => {
    try {
      const bus = ctx.getService('kernel10_shared_context_bus');
      const workspaceUi = ctx.getService('kernel10_workspace_ui');
      const tabId = findTabIdBySender(event.sender, ctx);
      if (!payload) return;

      if (payload.action === 'send' || payload.action === 'apply') {
        if (bus) {
          bus.push({
            kind: payload.kind || 'code',
            content: payload.content || '',
            source: {
              tabId,
              url: payload.source && payload.source.url,
              title: payload.source && payload.source.title,
              app: payload.source && payload.source.app,
            },
            metadata: payload.metadata || {},
          });
        }
        if (workspaceUi) {
          const label = payload.kind === 'code' ? 'Code' : (payload.kind === 'table' ? 'Table' : 'Content');
          workspaceUi.toast(`${label} sent to JARVIS`, 'success');
        }
      } else if (payload.action === 'relay' && bus) {
        const targetTabId = payload.targetTabId;
        const targetTabIndex = payload.targetTabIndex;
        if (targetTabId || Number.isInteger(targetTabIndex)) {
          bus.relayToTab({
            targetTabId: targetTabId || undefined,
            targetTabIndex: Number.isInteger(targetTabIndex) ? targetTabIndex : undefined,
            payloadText: payload.content || '',
            payloadKind: payload.kind || 'text',
            autoSubmit: true,
          }).then((res) => {
            if (workspaceUi) {
              workspaceUi.toast(
                res && res.ok ? 'Content relayed to tab' : `Relay failed: ${res && res.error}`,
                res && res.ok ? 'success' : 'error'
              );
            }
          }).catch((e) => {
            if (workspaceUi) workspaceUi.toast(`Relay failed: ${String(e)}`, 'error');
          });
        }
      }
    } catch (e) {
      audit('warn', 'pill_click_failed', { error: String(e) });
    }
  });

  // Preload-side error report.
  ipcMain.on('jarvis:k10-preload-error', (event, payload) => {
    const tabId = findTabIdBySender(event.sender, ctx);
    audit('warn', 'preload_error', {
      tabId,
      where: payload && payload.where,
      message: payload && payload.message,
      url: payload && payload.url,
    });
  });

  // Relay submenu tab-list request from a preload.
  ipcMain.on('jarvis:k10-relay-tabs', async (event, payload) => {
    const runtime = ctx.getService('kernel10_browser_runtime');
    const requestId = payload && payload.requestId;
    if (!requestId || !runtime) return;
    try {
      const tabs = await runtime.getTabList();
      const reply = {
        requestId,
        tabs: tabs.map((t) => ({
          id: t.id,
          index: t.index,
          title: t.title || '',
          url: t.url || '',
          app: (() => {
            try {
              const bus = ctx.getService('kernel10_shared_context_bus');
              if (bus && typeof bus.isAITabUrl === 'function') {
                return bus.isAITabUrl(t.url) ? 'ai' : 'site';
              }
            } catch (_) {}
            return 'site';
          })(),
        })),
      };
      if (!event.sender.isDestroyed()) {
        event.sender.send('jarvis:k10-relay-tabs-reply', reply);
      }
    } catch (e) {
      audit('warn', 'relay_tabs_list_failed', { error: String(e) });
    }
  });

  audit('info', 'ipc_listeners_installed', { channels: 7 });
}

// ---------------------------------------------------------------------------
// SECTION 6 — RUNTIME EVENT FORWARDERS
// ---------------------------------------------------------------------------

function wireRuntimeEvents(ctx) {
  const runtime = ctx.getService('kernel10_browser_runtime');
  const workspaceUi = ctx.getService('kernel10_workspace_ui');
  if (!runtime || !workspaceUi) {
    audit('warn', 'runtime_wiring_skipped', {
      runtime: !!runtime,
      workspaceUi: !!workspaceUi,
    });
    return;
  }

  runtime.on('tab-created', ({ descriptor }) => {
    workspaceUi.send('tab.add', descriptor).catch(() => {});
  });

  runtime.on('tab-updated', ({ tabId, descriptor }) => {
    workspaceUi.send('tab.update', { tabId, patch: descriptor }).catch(() => {});
  });

  runtime.on('tab-destroyed', ({ tabId }) => {
    workspaceUi.send('tab.remove', { tabId }).catch(() => {});
  });

  runtime.on('tab-activated', ({ tabId, panelId }) => {
    workspaceUi.send('tab.activate', { tabId, panelId }).catch(() => {});
  });

  runtime.on('pip-entered', ({ tabId }) => {
    workspaceUi.pushPipChange(tabId).catch(() => {});
  });

  runtime.on('pip-exited', ({ tabId }) => {
    workspaceUi.pushPipChange(null).catch(() => {});
  });

  runtime.on('tab-navigated', ({ tabId }) => {
    // Trigger tab-updated for URL changes — already emitted by runtime's
    // internal _markTabDirty → tab-updated. No extra work needed.
  });

  runtime.on('runtime-error', ({ where, error, tabId }) => {
    audit('warn', 'runtime_error', { where, error, tabId });
  });

  audit('info', 'runtime_events_wired', {});
}

// ---------------------------------------------------------------------------
// SECTION 7 — SERVICE EVENT FORWARDERS
// ---------------------------------------------------------------------------

function wireServiceEvents(ctx) {
  const services = ctx.getService('kernel10_browser_services');
  const workspaceUi = ctx.getService('kernel10_workspace_ui');
  if (!services || !workspaceUi) {
    audit('warn', 'services_wiring_skipped', {
      services: !!services,
      workspaceUi: !!workspaceUi,
    });
    return;
  }

  const refreshDownloads = debounce(async () => {
    try {
      const active = services.downloads.getActive();
      const completed = services.downloads.getCompleted();
      await workspaceUi.pushDownloads({ active, completed });
    } catch (_) {}
  }, 200);

  services.on('settings-changed', ({ settings }) => {
    workspaceUi.send('settings.change', settings).catch(() => {});
  });

  services.on('bookmarks-updated', ({ bookmarks }) => {
    workspaceUi.send('bookmarks.change', bookmarks).catch(() => {});
  });

  services.on('bookmark-added', () => {
    try {
      const bms = services.bookmarks.getBarItems();
      workspaceUi.send('bookmarks.change', bms).catch(() => {});
    } catch (_) {}
  });

  services.on('bookmark-removed', () => {
    try {
      const bms = services.bookmarks.getBarItems();
      workspaceUi.send('bookmarks.change', bms).catch(() => {});
    } catch (_) {}
  });

  services.on('download-started', () => refreshDownloads());
  services.on('download-progress', () => refreshDownloads());
  services.on('download-complete', () => refreshDownloads());
  services.on('download-failed', () => refreshDownloads());

  services.on('find-state-changed', ({ tabId, state }) => {
    workspaceUi.pushFindState(tabId, state).catch(() => {});
  });

  services.on('history-appended', () => {
    // History drawer refreshes on-demand; no live push needed.
  });

  services.on('closed-tab-pushed', ({ entry }) => {
    workspaceUi.toast(`Tab closed: ${entry.title || entry.url}`, 'info').catch(() => {});
  });

  services.on('closed-tab-reopened', ({ tabId }) => {
    workspaceUi.toast('Reopened closed tab', 'success').catch(() => {});
  });

  audit('info', 'services_events_wired', {});
}

// ---------------------------------------------------------------------------
// SECTION 8 — CONTEXT MENU WIRING
// ---------------------------------------------------------------------------
// Attach a `context-menu` listener to every tab's webContents. Coordinates
// arrive relative to the WebContentsView; translate them into window
// coordinates by adding the panel's bounds offset.
// ---------------------------------------------------------------------------

function wireContextMenu(ctx) {
  const runtime = ctx.getService('kernel10_browser_runtime');
  const services = ctx.getService('kernel10_browser_services');
  const workspaceUi = ctx.getService('kernel10_workspace_ui');
  if (!runtime || !services || !workspaceUi) {
    audit('warn', 'context_menu_wiring_skipped', {
      runtime: !!runtime,
      services: !!services,
      workspaceUi: !!workspaceUi,
    });
    return;
  }

  const attachToWebContents = (tabId, webContents) => {
    if (!webContents) return;
    try {
      webContents.on('context-menu', async (event, params) => {
        try {
          const tabDesc = runtime.getTab(tabId);
          const panelId = tabDesc ? tabDesc.panel : 'left';
          const panelState = runtime.getPanelState(panelId);
          const bounds = (panelState && panelState.bounds) || { x: 0, y: 0 };
          const windowX = Number(bounds.x || 0) + Number(params.x || 0);
          const windowY = Number(bounds.y || 0) + Number(params.y || 0);

          const items = services.contextMenu.build(tabId, params);
          await workspaceUi.showContextMenu(items, { x: windowX, y: windowY });
        } catch (e) {
          audit('warn', 'context_menu_failed', { tabId, error: String(e) });
        }
      });
    } catch (e) {
      audit('warn', 'context_menu_attach_failed', { tabId, error: String(e) });
    }
  };

  // Attach to existing tabs immediately.
  try {
    const rt = require('./kernel_10_browser_runtime').getRuntime();
    if (rt && rt._tabs) {
      for (const [tabId, tab] of rt._tabs.entries()) {
        attachToWebContents(tabId, tab.webContents);
      }
    }
  } catch (_) {}

  // Attach to new tabs as they're created.
  runtime.on('tab-created', ({ tabId, webContents }) => {
    attachToWebContents(tabId, webContents);
  });

  audit('info', 'context_menu_wired', {});
}

// ---------------------------------------------------------------------------
// SECTION 9 — STT TOOL RE-REGISTRATION
// ---------------------------------------------------------------------------
// Part 1's default handlers were written against an abstract browser API.
// The concrete Part 4 service has slightly different method names. Re-register
// the affected intents so STT routing works correctly end-to-end.
// ---------------------------------------------------------------------------

function registerCorrectedSTTTools(ctx) {
  const stt = ctx.getService('kernel10_stt_normalizer');
  if (!stt || typeof stt.registerTool !== 'function') {
    audit('warn', 'stt_tool_reregistration_skipped', {});
    return;
  }

  // SWITCH_TAB — 1-based ordinal → Part 4's 0-based activateTabByIndex.
  stt.registerTool('SWITCH_TAB', async (slots, ctx) => {
    const runtime = ctx.getService('kernel10_browser_runtime');
    if (!runtime) return { ok: false, error: 'browser_runtime_unavailable' };
    const ordinal = Number(slots.tab_index);
    if (!Number.isFinite(ordinal) || ordinal < 1) {
      return { ok: false, error: 'invalid_tab_index' };
    }
    const ok = await runtime.activateTabByIndex(ordinal - 1);
    return ok
      ? { ok: true, tabIndex: ordinal - 1 }
      : { ok: false, error: 'tab_index_out_of_range' };
  }, { category: 'kernel10' });

  // CLOSE_TAB — either closes a specific index or the active tab.
  stt.registerTool('CLOSE_TAB', async (slots, ctx) => {
    const runtime = ctx.getService('kernel10_browser_runtime');
    if (!runtime) return { ok: false, error: 'browser_runtime_unavailable' };
    const ordinal = Number(slots.tab_index);
    if (Number.isFinite(ordinal) && ordinal >= 1) {
      const tabs = await runtime.getTabList();
      const target = tabs[ordinal - 1];
      if (!target) return { ok: false, error: 'tab_index_out_of_range' };
      const ok = await runtime.closeTab(target.id);
      return ok ? { ok: true, closedTabId: target.id } : { ok: false, error: 'close_failed' };
    }
    const ok = await runtime.closeActiveTab();
    return ok ? { ok: true, closed: 'active' } : { ok: false, error: 'close_failed' };
  }, { category: 'kernel10' });

  // SWITCH_LAYOUT — route through Part 6's renderer command bridge.
  stt.registerTool('SWITCH_LAYOUT', async (slots, ctx) => {
    const workspaceUi = ctx.getService('kernel10_workspace_ui');
    if (!workspaceUi) return { ok: false, error: 'workspace_ui_unavailable' };
    const requested = String(slots.layout || '').toLowerCase();
    // Normalise common STT variants.
    const aliases = {
      chat: 'chat-browser',
      'chat+browser': 'chat-browser',
      'chat+browser split': 'chat-browser',
      browser: 'browser-full',
      full: 'browser-full',
      split: 'chat-browser',
      'browser+browser': 'browser-browser',
      'browser_browser': 'browser-browser',
      multi: 'multi',
      'multi-panel': 'multi',
    };
    const layout = aliases[requested] || requested;
    if (!VALID_LAYOUTS.has(layout)) {
      return { ok: false, error: 'invalid_layout', requested };
    }
    await workspaceUi.send('layout.change', { layout });
    return { ok: true, layout };
  }, { category: 'kernel10' });

  // FIND_IN_PAGE — bridge to Part 5.
  stt.registerTool('FIND_IN_PAGE', async (slots, ctx) => {
    const runtime = ctx.getService('kernel10_browser_runtime');
    const services = ctx.getService('kernel10_browser_services');
    if (!runtime || !services) return { ok: false, error: 'services_unavailable' };
    const activeTab = await runtime.getActiveTabInfo();
    if (!activeTab) return { ok: false, error: 'no_active_tab' };
    const query = String(slots.query || '').trim();
    if (!query) return { ok: false, error: 'empty_query' };
    services.find.start(activeTab.id, query);
    return { ok: true, tabId: activeTab.id, query };
  }, { category: 'kernel10' });

  // RELAY_TAB_DATA — use the most recent context from the bus.
  stt.registerTool('RELAY_TAB_DATA', async (slots, ctx) => {
    const bus = ctx.getService('kernel10_shared_context_bus');
    if (!bus) return { ok: false, error: 'bus_unavailable' };
    const activeContext = bus.getActiveContext();
    if (!activeContext) return { ok: false, error: 'no_active_context' };
    const ordinal = Number(slots.target_tab);
    if (!Number.isFinite(ordinal) || ordinal < 1) {
      return { ok: false, error: 'invalid_target_tab' };
    }
    const res = await bus.relayToTab({
      targetTabIndex: ordinal - 1,
      payloadText: activeContext.sanitizedContent,
      payloadKind: activeContext.kind,
    });
    return res && res.ok
      ? { ok: true, relayId: res.relayId, targetTabId: res.targetTabId }
      : { ok: false, error: (res && res.error) || 'relay_failed' };
  }, { category: 'kernel10' });

  audit('info', 'stt_tools_reregistered', {
    intents: ['SWITCH_TAB', 'CLOSE_TAB', 'SWITCH_LAYOUT', 'FIND_IN_PAGE', 'RELAY_TAB_DATA'],
  });
}

/**
 * Wire an LLM callback into the STT normalizer so that low-confidence phonetic
 * matches fall back to LLM-assisted intent normalisation. Uses whichever
 * brain-router service kernel_5 exposes (best-effort discovery).
 * @param {object} ctx
 */
function wireSTTLLMFallback(ctx) {
  const stt = ctx.getService('kernel10_stt_normalizer');
  if (!stt || typeof stt.setLLMCallback !== 'function') return;

  // Best-effort discovery of a chat-capable service.
  const candidates = [
    'kernel5_brain_router', 'brain_router', 'cloud_brain',
    'ai_brain', 'llm_router', 'kernel_5_brain_router',
  ];
  let brain = null;
  for (const name of candidates) {
    try {
      const svc = ctx.getService(name);
      if (svc && (typeof svc.chat === 'function' || typeof svc.ask === 'function' || typeof svc.complete === 'function')) {
        brain = svc;
        break;
      }
    } catch (_) {}
  }
  if (!brain) {
    audit('info', 'stt_llm_fallback_unavailable', {
      candidates_tried: candidates.length,
    });
    return;
  }

  const fn = async (prompt, opts) => {
    try {
      const chatFn = brain.chat || brain.ask || brain.complete;
      const res = await chatFn.call(brain, prompt, opts || {});
      if (typeof res === 'string') return res;
      if (res && typeof res.text === 'string') return res.text;
      if (res && typeof res.content === 'string') return res.content;
      return null;
    } catch (e) {
      audit('warn', 'stt_llm_call_failed', { error: String(e) });
      return null;
    }
  };
  stt.setLLMCallback(fn);
  audit('info', 'stt_llm_fallback_wired', {});
}

// ---------------------------------------------------------------------------
// SECTION 10 — OVERLAY WATCHER INJECTION
// ---------------------------------------------------------------------------
// WebContentsView renders above all HTML in the main window. When Part 6
// opens a modal, drawer, or context menu, those overlays must hide all
// WebContentsViews temporarily. This watcher observes Part 6's DOM and sends
// `overlay.toggle` commands back to main.
// ---------------------------------------------------------------------------

const OVERLAY_WATCHER_SOURCE = `
(function() {
  if (window.__JARVIS_K10_OVERLAY_WATCHER__) return;
  window.__JARVIS_K10_OVERLAY_WATCHER__ = true;

  let overlayOpen = false;
  let pendingCheck = null;

  function computeOverlayState() {
    const anyModal = !!document.querySelector('[data-k10-modal].k10-open');
    const anyDrawer = !!document.querySelector('[data-k10-drawer].k10-open');
    const ctxMenu = !!document.querySelector('#k10-context-menu.k10-open');
    return anyModal || anyDrawer || ctxMenu;
  }

  function checkOverlayState() {
    if (pendingCheck) return;
    pendingCheck = setTimeout(() => {
      pendingCheck = null;
      const state = computeOverlayState();
      if (state === overlayOpen) return;
      overlayOpen = state;
      try {
        window.jarvis.askAI({
          prompt: '__K10__' + JSON.stringify({
            action: 'overlay.toggle',
            payload: { open: state }
          }),
          mode: 'offline',
          subMode: 'direct',
          _k10: { action: 'overlay.toggle', payload: { open: state } }
        });
      } catch (_) {}
    }, 30);
  }

  try {
    const observer = new MutationObserver(checkOverlayState);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true
    });
  } catch (_) {}

  setTimeout(checkOverlayState, 200);
})();
`;

/**
 * Inject the overlay watcher into the renderer after Part 6 has finished
 * injecting the workspace UI.
 * @param {BrowserWindow} win
 */
async function injectOverlayWatcher(win) {
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(OVERLAY_WATCHER_SOURCE);
    audit('info', 'overlay_watcher_injected', {});
  } catch (e) {
    audit('warn', 'overlay_watcher_inject_failed', { error: String(e) });
  }
}

// ---------------------------------------------------------------------------
// SECTION 11 — MASTER ORCHESTRATOR
// ---------------------------------------------------------------------------

class Kernel10Orchestrator extends EventEmitter {
  constructor(ctx) {
    super();
    this._ctx = ctx;
    this._bootedAt = Date.now();
    this._closed = false;
    this._subModules = {
      stt_normalizer: null,
      shared_context_bus: null,
      browser_runtime: null,
      browser_services: null,
      workspace_ui: null,
    };
    this._mainWindow = null;
    this._loadedLabels = [];
    this._missingLabels = [];
  }

  /**
   * Boot all sub-modules in dependency order, then wire IPC + events.
   */
  async boot() {
    // Resolve main window first — Parts 4 and 6 need it.
    this._mainWindow = getMainWindow();
    if (!this._mainWindow) {
      audit('warn', 'no_main_window_at_boot', { note: 'parts 4/6 will attach later' });
    }

    // Load sub-modules one by one in dependency order.
    for (const descriptor of SUB_MODULES) {
      const initOpts = descriptor.requiresWindow
        ? { mainWindow: this._mainWindow, restoreSession: true }
        : undefined;
      const result = await loadSubModule(descriptor, this._ctx, initOpts);
      if (result.ok && result.service) {
        this._subModules[descriptor.label] = result.service;
        this._loadedLabels.push(descriptor.label);
      } else {
        this._missingLabels.push(descriptor.label);
      }
    }

    audit('info', 'submodules_boot_summary', {
      loaded: this._loadedLabels,
      missing: this._missingLabels,
    });

    // Wait for Part 6's UI injection to actually complete before injecting
    // the overlay watcher.
    const workspaceUi = this._ctx.getService('kernel10_workspace_ui');
    if (workspaceUi && typeof workspaceUi.inject === 'function') {
      try { await workspaceUi.inject(); }
      catch (e) { audit('warn', 'workspace_inject_wait_failed', { error: String(e) }); }
    }
    if (this._mainWindow && workspaceUi) {
      await injectOverlayWatcher(this._mainWindow);
    }

    // Install our top-level AI-prompt wrapper (after kernel_9 has installed).
    installUnifiedAIPromptPipeline(this._ctx);

    // Install per-tab IPC listeners.
    installKernel10IPCListeners(this._ctx);

    // Wire runtime + services → renderer forwarders.
    wireRuntimeEvents(this._ctx);
    wireServiceEvents(this._ctx);

    // Wire context menu to every tab's webContents.
    wireContextMenu(this._ctx);

    // Re-register STT tools with corrected method names.
    registerCorrectedSTTTools(this._ctx);

    // Optional: attach LLM fallback callback for STT.
    wireSTTLLMFallback(this._ctx);

    audit('info', 'orchestrator_ready', {
      loaded: this._loadedLabels.length,
      missing: this._missingLabels.length,
      uptime_ms: Date.now() - this._bootedAt,
    });
  }

  getStats() {
    const runtime = this._subModules.browser_runtime;
    const services = this._subModules.browser_services;
    const workspaceUi = this._subModules.workspace_ui;
    const bus = this._subModules.shared_context_bus;
    return {
      version: '1.0.0',
      bootedAt: this._bootedAt,
      uptimeMs: Date.now() - this._bootedAt,
      subModules: {
        loaded: this._loadedLabels.slice(),
        missing: this._missingLabels.slice(),
      },
      runtime: runtime && typeof runtime.getStateSnapshot === 'function'
        ? (() => {
          try {
            const snap = runtime.getStateSnapshot();
            return {
              tabCount: snap.tabCount,
              pipTabId: snap.pipTabId,
              popupCount: snap.popupCount,
            };
          } catch (_) { return null; }
        })()
        : null,
      services: services && typeof services.getStats === 'function'
        ? (() => { try { return services.getStats(); } catch (_) { return null; } })()
        : null,
      workspaceUi: workspaceUi && typeof workspaceUi.isInjected === 'function'
        ? { injected: workspaceUi.isInjected() }
        : null,
      contextBus: bus && typeof bus.getStats === 'function'
        ? (() => { try { return bus.getStats(); } catch (_) { return null; } })()
        : null,
      pipelineInstalled: _pipelineInstalled,
      mainWindowAttached: !!(this._mainWindow && !this._mainWindow.isDestroyed()),
    };
  }

  async shutdown() {
    if (this._closed) return;
    this._closed = true;
    audit('info', 'orchestrator_shutdown', {
      uptime_ms: Date.now() - this._bootedAt,
    });
    this.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// SECTION 12 — MODULE INITIALIZATION
// ---------------------------------------------------------------------------

let _orchestrator = null;
let _initPromise = null;

/**
 * @param {object} ctx — kernel context
 * @returns {Promise<void>}
 */
async function init(ctx) {
  if (_initPromise) return _initPromise;

  _auditFn = ctx && typeof ctx.audit === 'function' ? ctx.audit.bind(ctx) : null;
  _initPromise = (async () => {
    _orchestrator = new Kernel10Orchestrator(ctx);
    await _orchestrator.boot();

    // Register master service.
    if (ctx && typeof ctx.registerService === 'function') {
      ctx.registerService('kernel10_neural_tab_bridge', {
        // Introspection.
        getStats: () => _orchestrator.getStats(),
        getSubModules: () => ({ ..._orchestrator._subModules }),

        // Manual re-wiring (idempotent — useful if a sub-module was missing
        // at first boot and loaded later).
        rewire: async () => {
          try {
            wireRuntimeEvents(ctx);
            wireServiceEvents(ctx);
            wireContextMenu(ctx);
            registerCorrectedSTTTools(ctx);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },

        // Convenience command dispatch (for other kernels).
        executeCommand: (action, payload) => handleKernel10Command(
          { action, payload }, { sender: { isDestroyed: () => true } }, ctx
        ),

        // Lifecycle.
        shutdown: () => _orchestrator.shutdown(),
      });
    }

    // State contributor for existing dashboard telemetry.
    if (ctx && typeof ctx.addStateContributor === 'function') {
      ctx.addStateContributor('kernel10_neural_tab_bridge', () => {
        const s = _orchestrator.getStats();
        return {
          version: '1.0.0',
          uptime_ms: s.uptimeMs,
          loaded_modules: s.subModules.loaded.length,
          missing_modules: s.subModules.missing.length,
          tabs: s.runtime ? s.runtime.tabCount : 0,
          pip_active: s.runtime ? !!s.runtime.pipTabId : false,
          workspace_injected: s.workspaceUi ? s.workspaceUi.injected : false,
          pipeline_installed: s.pipelineInstalled,
        };
      });
    }

    // Clean shutdown.
    if (ctx && typeof ctx.addStopHook === 'function') {
      ctx.addStopHook('kernel10_neural_tab_bridge', () => {
        if (_orchestrator) _orchestrator.shutdown().catch(() => {});
      });
    }

    audit('info', 'kernel10_master_initialized', {
      loaded: _orchestrator._loadedLabels.length,
      missing: _orchestrator._missingLabels.length,
    });
  })();

  return _initPromise;
}

function getOrchestrator() { return _orchestrator; }

// ---------------------------------------------------------------------------
// SECTION 13 — EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  name: 'kernel10_neural_tab_bridge',
  version: '1.0.0',
  init,
  getOrchestrator,

  // Classes.
  Kernel10Orchestrator,

  // Constants.
  BRIDGE_EVENT,
  COMMAND_TAG,
  VALID_LAYOUTS,
  SUB_MODULES,

  // Utilities (unit-testable).
  getMainWindow,
  findTabIdBySender,
  findRawTab,
  formatToolResult,
  parseKernel10Command,

  // Sub-modules (for tests / manual wiring).
  loadSubModule,
  registerCorrectedSTTTools,
  wireRuntimeEvents,
  wireServiceEvents,
  wireContextMenu,
  installKernel10IPCListeners,
  installUnifiedAIPromptPipeline,
  handleKernel10Command,
};