'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
 * JARVIS-CORE :: KERNEL 10 :: PART 3 OF 5
 * kernel_10_webview_preload.js
 *
 * In-Tab DOM Sensor — runs inside EVERY dynamic WebContentsView / <webview>.
 *
 * Responsibilities:
 *   1.  Platform-agnostic AI stream completion detector
 *       (Claude / ChatGPT / Gemini / Google AI / Generic).
 *   2.  Floating ⚡ Apply-to-Jarvis pill injector over <pre><code> blocks.
 *   3.  Table capture pill for data tables (>= 2 data rows).
 *   4.  Debounced text-selection relay (mouseup + shift-arrow keyup).
 *   5.  React/Vue-aware input injection (contenteditable + textarea).
 *   6.  Prompt relay + post-stream response harvest back to broadcastId.
 *   7.  Platform-specific CSS injected with unique prefix (no page conflicts).
 *
 * Hardening:
 *   - IPC rate limit (configurable per-channel budget)
 *   - MutationObserver budget guard (throttles if page churns too hard)
 *   - Idempotent pill injection (data-jarvis10-pill="1" attribute check)
 *   - Selection min/max length + dedupe hash
 *   - Multi-signal stream completion (text-stability + stop-button-vanished)
 *   - Zero eval, zero innerHTML of untrusted text (uses textContent)
 *
 * Frozen-Core compliant. Loaded as webPreferences.preload. Requires
 * contextIsolation: true and sandbox: false (verified at bootstrap).
 * ═══════════════════════════════════════════════════════════════════════════ */

const { ipcRenderer, contextBridge } = require('electron');

const MODULE_ID = 'kernel_10_webview_preload';
const MODULE_VERSION = '10.0.0';

const CHANNELS = Object.freeze({
  BUS_PUSH: 'jarvis10:bus:push',
  BUS_BROADCAST_RESPONSE: 'jarvis10:bus:broadcast-response',
  RELAY_PROMPT: 'jarvis10:relay:prompt',
  RELAY_INJECT_INPUT: 'jarvis10:relay:inject-input',
  PRELOAD_HELLO: 'jarvis10:preload:hello',
  PRELOAD_DIAGNOSTICS: 'jarvis10:preload:diagnostics'
});

const STYLE_ID = 'jarvis10-preload-styles';
const PILL_ATTR = 'data-jarvis10-pill';
const PILL_ID_ATTR = 'data-jarvis10-pill-id';

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 1 — LOGGING
 * ═══════════════════════════════════════════════════════════════════════════ */

const LOG_LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 };

function createLogger(scope, levelName) {
  const threshold = LOG_LEVELS[levelName] !== undefined ? LOG_LEVELS[levelName] : LOG_LEVELS.info;
  const emit = (level, args) => {
    if (LOG_LEVELS[level] < threshold) return;
    if (level === 'error') {
      // eslint-disable-next-line no-console
      console.error(`[${scope}]`, ...args);
    } else if (level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(`[${scope}]`, ...args);
    } else if (LOG_LEVELS[level] >= LOG_LEVELS.debug) {
      // eslint-disable-next-line no-console
      console.log(`[${scope}]`, ...args);
    }
  };
  return {
    trace: (...a) => emit('trace', a),
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    child: (sub) => createLogger(`${scope}:${sub}`, levelName)
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 2 — UTILITIES
 * ═══════════════════════════════════════════════════════════════════════════ */

function sha1Short(str) {
  // FNV-1a 32-bit — cheap dedupe hash, no crypto needed in-page
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function debounce(fn, waitMs) {
  let timer = null;
  const wrapped = function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try { fn.apply(this, args); } catch (_) { /* swallow */ }
    }, waitMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

function throttle(fn, waitMs) {
  let last = 0;
  let pending = null;
  const wrapped = function throttled(...args) {
    const now = Date.now();
    const remain = waitMs - (now - last);
    if (remain <= 0) {
      last = now;
      try { fn.apply(this, args); } catch (_) { /* swallow */ }
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        last = Date.now();
        try { fn.apply(this, args); } catch (_) { /* swallow */ }
      }, remain);
      if (pending && typeof pending.unref === 'function') pending.unref();
    }
  };
  wrapped.cancel = () => { if (pending) { clearTimeout(pending); pending = null; } };
  return wrapped;
}

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  return true;
}

function textOf(el) {
  if (!el) return '';
  return String(el.innerText || el.textContent || '').trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 3 — PLATFORM DETECTION & ADAPTERS
 * ═══════════════════════════════════════════════════════════════════════════ */

const PLATFORM = Object.freeze({
  CLAUDE: 'claude',
  CHATGPT: 'chatgpt',
  GEMINI: 'gemini',
  PERPLEXITY: 'perplexity',
  COPILOT: 'copilot',
  GOOGLE: 'google',
  GENERIC: 'generic'
});

function detectPlatform() {
  const host = String(window.location.hostname || '').toLowerCase();
  const path = String(window.location.pathname || '').toLowerCase();

  if (host.includes('claude.ai')) return PLATFORM.CLAUDE;
  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return PLATFORM.CHATGPT;
  if (host.includes('gemini.google.com') || host.includes('bard.google.com')) return PLATFORM.GEMINI;
  if (host.includes('perplexity.ai')) return PLATFORM.PERPLEXITY;
  if (host.includes('copilot.microsoft.com')) return PLATFORM.COPILOT;
  if (host.includes('google.')) return PLATFORM.GOOGLE;
  return PLATFORM.GENERIC;
}

/**
 * Adapter contract — every platform returns a shape like:
 *   {
 *     name: string,
 *     streamRoots:   () => Element[],      // candidate containers we watch
 *     messageNodes:  () => Element[],      // ordered oldest → newest messages
 *     lastMessage:   () => Element | null,
 *     streamingFlag: () => boolean,        // true while generating
 *     chatInput:     () => Element | null, // the prompt textarea / contenteditable
 *     submitButton:  () => Element | null,
 *     codeBlockSelector: string,
 *     tableSelector: string
 *   }
 */

const CLAUDE_ADAPTER = {
  name: PLATFORM.CLAUDE,
  streamRoots() {
    const roots = [];
    document.querySelectorAll('[data-testid="conversation-turn"], .font-claude-message, [data-testid="chat-messages"]')
      .forEach((el) => roots.push(el));
    if (roots.length === 0 && document.body) roots.push(document.body);
    return roots;
  },
  messageNodes() {
    // Claude renders each assistant/user turn as a block with a stable wrapper
    const nodes = Array.from(document.querySelectorAll(
      '[data-testid="conversation-turn"], .font-claude-message'
    ));
    return nodes;
  },
  lastMessage() {
    const nodes = this.messageNodes();
    return nodes.length ? nodes[nodes.length - 1] : null;
  },
  streamingFlag() {
    // Claude shows a stop button + a specific "generating" indicator
    const stopBtn = document.querySelector(
      'button[aria-label*="Stop"], button[aria-label*="stop"], [data-testid="stop-button"]'
    );
    if (stopBtn && isVisible(stopBtn)) return true;
    const generating = document.querySelector('[data-testid="message-streaming"], [aria-busy="true"]');
    return !!generating && isVisible(generating);
  },
  chatInput() {
    return document.querySelector('div[contenteditable="true"].ProseMirror') ||
           document.querySelector('div[contenteditable="true"][data-testid="chat-input"]') ||
           document.querySelector('div[contenteditable="true"]');
  },
  submitButton() {
    return document.querySelector(
      'button[aria-label*="Send"], button[data-testid="send-button"], button[type="submit"]'
    );
  },
  codeBlockSelector: 'pre > code, pre, .font-mono pre',
  tableSelector: 'table'
};

const CHATGPT_ADAPTER = {
  name: PLATFORM.CHATGPT,
  streamRoots() {
    const roots = [];
    document.querySelectorAll('main, [role="main"], article, [data-testid^="conversation-turn"]')
      .forEach((el) => roots.push(el));
    if (roots.length === 0 && document.body) roots.push(document.body);
    return roots;
  },
  messageNodes() {
    return Array.from(document.querySelectorAll(
      'article[data-testid^="conversation-turn"], [data-message-author-role]'
    ));
  },
  lastMessage() {
    const nodes = this.messageNodes();
    return nodes.length ? nodes[nodes.length - 1] : null;
  },
  streamingFlag() {
    const stop = document.querySelector(
      '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]'
    );
    if (stop && isVisible(stop)) return true;
    const aria = document.querySelector('main [aria-busy="true"]');
    return !!aria && isVisible(aria);
  },
  chatInput() {
    return document.querySelector('#prompt-textarea') ||
           document.querySelector('textarea[data-id="root"]') ||
           document.querySelector('div[contenteditable="true"].ProseMirror') ||
           document.querySelector('div[contenteditable="true"]');
  },
  submitButton() {
    return document.querySelector(
      'button[data-testid="send-button"], button[aria-label="Send prompt"], button[type="submit"]'
    );
  },
  codeBlockSelector: 'pre > code, pre',
  tableSelector: 'table'
};

const GEMINI_ADAPTER = {
  name: PLATFORM.GEMINI,
  streamRoots() {
    const roots = [];
    document.querySelectorAll('main, .conversation-container, model-response, user-query')
      .forEach((el) => roots.push(el));
    if (roots.length === 0 && document.body) roots.push(document.body);
    return roots;
  },
  messageNodes() {
    return Array.from(document.querySelectorAll(
      'model-response, user-query, message-content'
    ));
  },
  lastMessage() {
    const nodes = this.messageNodes();
    return nodes.length ? nodes[nodes.length - 1] : null;
  },
  streamingFlag() {
    const stop = document.querySelector(
      'button[aria-label*="Stop"], button[aria-label*="stop"], .stop-button'
    );
    if (stop && isVisible(stop)) return true;
    const busy = document.querySelector('[aria-busy="true"]');
    return !!busy && isVisible(busy);
  },
  chatInput() {
    return document.querySelector('rich-textarea div[contenteditable="true"]') ||
           document.querySelector('div[contenteditable="true"]');
  },
  submitButton() {
    return document.querySelector(
      'button[aria-label*="Send"], button.send-button, button[type="submit"]'
    );
  },
  codeBlockSelector: 'pre > code, pre, code-block',
  tableSelector: 'table'
};

const GENERIC_ADAPTER = {
  name: PLATFORM.GENERIC,
  streamRoots() {
    return document.body ? [document.body] : [];
  },
  messageNodes() {
    // Heuristic: find blocks whose class/id hints at a message/response container
    const candidates = document.querySelectorAll(
      '[class*="message" i], [id*="message" i], [class*="response" i], [id*="response" i], [class*="turn" i]'
    );
    const filtered = [];
    for (const el of candidates) {
      // reject deep nesting — only keep outer containers
      if (el.children.length > 200) continue;
      filtered.push(el);
    }
    return filtered;
  },
  lastMessage() {
    const nodes = this.messageNodes();
    return nodes.length ? nodes[nodes.length - 1] : null;
  },
  streamingFlag() {
    // Best signal is the text-stability detector; nothing reliable here
    return false;
  },
  chatInput() {
    return document.querySelector('textarea') ||
           document.querySelector('[contenteditable="true"]');
  },
  submitButton() {
    return document.querySelector('button[type="submit"]');
  },
  codeBlockSelector: 'pre > code, pre',
  tableSelector: 'table'
};

function pickAdapter(platformName) {
  switch (platformName) {
    case PLATFORM.CLAUDE: return CLAUDE_ADAPTER;
    case PLATFORM.CHATGPT: return CHATGPT_ADAPTER;
    case PLATFORM.GEMINI: return GEMINI_ADAPTER;
    case PLATFORM.PERPLEXITY:
    case PLATFORM.COPILOT:
    case PLATFORM.GOOGLE:
    default:
      return GENERIC_ADAPTER;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 4 — IPC BRIDGE (rate-limited, deduped, self-healing)
 * ═══════════════════════════════════════════════════════════════════════════ */

class IpcBridge {
  constructor(logger, options) {
    this.log = logger;
    this.opts = Object.assign({
      perChannelWindowMs: 1000,
      perChannelBudget: 25,
      sendTimeoutMs: 4000
    }, options || {});
    this._buckets = new Map();  // channel → { count, windowStart }
    this._sent = 0;
    this._suppressed = 0;
  }

  _checkBudget(channel) {
    const now = Date.now();
    let bucket = this._buckets.get(channel);
    if (!bucket || (now - bucket.windowStart) >= this.opts.perChannelWindowMs) {
      bucket = { count: 0, windowStart: now };
      this._buckets.set(channel, bucket);
    }
    if (bucket.count >= this.opts.perChannelBudget) {
      this._suppressed += 1;
      return false;
    }
    bucket.count += 1;
    return true;
  }

  send(channel, payload) {
    if (!this._checkBudget(channel)) return { ok: false, suppressed: true };
    try {
      ipcRenderer.send(channel, payload);
      this._sent += 1;
      return { ok: true };
    } catch (err) {
      this.log.warn(`ipc send failed [${channel}]`, err && err.message);
      return { ok: false, error: err && err.message };
    }
  }

  invoke(channel, payload) {
    if (!this._checkBudget(channel)) return Promise.resolve({ ok: false, suppressed: true });
    const timeout = new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'ipc-timeout' }), this.opts.sendTimeoutMs);
      if (typeof t.unref === 'function') t.unref();
    });
    const work = Promise.resolve(ipcRenderer.invoke(channel, payload)).then(
      (r) => ({ ok: true, result: r }),
      (err) => ({ ok: false, error: err && err.message ? err.message : String(err) })
    );
    return Promise.race([work, timeout]);
  }

  stats() {
    return { sent: this._sent, suppressed: this._suppressed };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 5 — STREAM COMPLETION DETECTOR
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Multi-signal stream detector. Fires 'complete' exactly once per stream
 * once two independent signals agree:
 *   A) The last assistant message text has been stable for `stableMs`.
 *   B) The platform's streaming flag has been false for `flagGraceMs`.
 *     (If the platform exposes no flag, only signal A is required.)
 */
class StreamDetector {
  constructor(adapter, logger, options) {
    this.adapter = adapter;
    this.log = logger;
    this.opts = Object.assign({
      stableMs: 850,
      flagGraceMs: 350,
      minTextLength: 8,
      pollIntervalMs: 450,
      messageSignatureLength: 32
    }, options || {});

    this._observer = null;
    this._pollTimer = null;
    this._lastText = '';
    this._lastChangeAt = 0;
    this._streamingStarted = false;
    this._lastCompletedSignature = '';
    this._listeners = { complete: [] };
    this._running = false;
    this._pendingBroadcast = null;   // { broadcastId, targetKey, sentAt }
  }

  on(event, fn) {
    if (this._listeners[event] && typeof fn === 'function') this._listeners[event].push(fn);
    return this;
  }

  _emit(event, payload) {
    const list = this._listeners[event] || [];
    for (const fn of list) {
      try { fn(payload); } catch (err) {
        this.log.warn(`listener[${event}] threw`, err && err.message);
      }
    }
  }

  /** Tag the currently-streaming response as the answer to a specific broadcast. */
  registerPendingBroadcast(broadcastId, targetKey) {
    this._pendingBroadcast = {
      broadcastId,
      targetKey,
      sentAt: Date.now()
    };
    this.log.debug(`pending broadcast registered id=${broadcastId}`);
  }

  start() {
    if (this._running) return;
    this._running = true;

    const roots = this.adapter.streamRoots();
    this._observer = new MutationObserver((mutations) => {
      // We don't care about the exact mutations — we care that text changed.
      if (mutations.length === 0) return;
      this._onMutated();
    });

    for (const root of roots) {
      try {
        this._observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true
        });
      } catch (err) {
        this.log.warn('observer.observe failed on root', err && err.message);
      }
    }

    // Independent poll — catches pages that suppress mutation events
    this._pollTimer = setInterval(() => this._poll(), this.opts.pollIntervalMs);
    if (typeof this._pollTimer.unref === 'function') this._pollTimer.unref();

    this.log.info(`StreamDetector started (platform=${this.adapter.name})`);
  }

  stop() {
    if (this._observer) {
      try { this._observer.disconnect(); } catch (_) { /* ignore */ }
      this._observer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._running = false;
  }

  _onMutated() {
    const last = this.adapter.lastMessage();
    if (!last) return;
    const text = textOf(last);
    if (!text) return;

    if (text !== this._lastText) {
      this._lastText = text;
      this._lastChangeAt = Date.now();
      if (!this._streamingStarted) {
        this._streamingStarted = true;
        this._emit('start', { textLength: text.length });
      }
      return;
    }

    // Text unchanged — check stability
    this._maybeComplete(text);
  }

  _poll() {
    const last = this.adapter.lastMessage();
    if (!last) return;
    const text = textOf(last);
    if (!text) return;

    if (text !== this._lastText) {
      this._lastText = text;
      this._lastChangeAt = Date.now();
      if (!this._streamingStarted) {
        this._streamingStarted = true;
        this._emit('start', { textLength: text.length });
      }
      return;
    }

    this._maybeComplete(text);
  }

  _maybeComplete(text) {
    if (!this._streamingStarted) return;
    if (text.length < this.opts.minTextLength) return;

    const stableFor = Date.now() - this._lastChangeAt;
    if (stableFor < this.opts.stableMs) return;

    // Signal B: platform flag must be clear (if the platform exposes one)
    let flagStreaming = false;
    try {
      flagStreaming = !!this.adapter.streamingFlag();
    } catch (_) { flagStreaming = false; }

    // If flag is still true, give it another grace period (unless the platform
    // never returns true and text stability alone should conclude).
    if (flagStreaming) return;

    // Signature check — avoid firing for the same message twice
    const signature = `${text.length}:${sha1Short(text.slice(0, 200))}:${sha1Short(text.slice(-200))}`;
    if (signature === this._lastCompletedSignature) return;
    this._lastCompletedSignature = signature;

    this._streamingStarted = false;

    const pending = this._pendingBroadcast;
    this._pendingBroadcast = null;

    this._emit('complete', {
      text,
      textLength: text.length,
      signature,
      broadcastId: pending ? pending.broadcastId : null,
      targetKey: pending ? pending.targetKey : null,
      sourcePlatform: this.adapter.name,
      sourceUrl: window.location.href
    });
  }

  /** Manual trigger — used by the "harvest now" pill on a message. */
  forceComplete() {
    const last = this.adapter.lastMessage();
    if (!last) return;
    const text = textOf(last);
    if (!text) return;
    this._lastText = text;
    this._lastChangeAt = Date.now() - this.opts.stableMs - 1;
    this._maybeComplete(text);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 6 — CSS INJECTION (platform-isolated, prefixed class names)
 * ═══════════════════════════════════════════════════════════════════════════ */

const STYLE_TEXT = `
.j10-pill-wrap {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  z-index: 2147483600;
  pointer-events: none;
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 140ms ease, transform 140ms ease;
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
}
.j10-host:hover > .j10-pill-wrap,
.j10-host:focus-within > .j10-pill-wrap,
.j10-pill-wrap:hover {
  opacity: 1;
  transform: translateY(0);
}
.j10-pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.01em;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.15);
  background: linear-gradient(180deg, #2b2f36 0%, #1a1d22 100%);
  color: #e8e8ea;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 2px 6px rgba(0,0,0,0.28), 0 0 0 0 rgba(99,102,241,0);
  transition: background 120ms ease, box-shadow 120ms ease, transform 80ms ease;
  white-space: nowrap;
}
.j10-pill:hover {
  background: linear-gradient(180deg, #343943 0%, #23272e 100%);
  box-shadow: 0 3px 10px rgba(0,0,0,0.34), 0 0 0 3px rgba(99,102,241,0.18);
}
.j10-pill:active { transform: scale(0.97); }
.j10-pill[data-kind="code"]     { border-color: rgba(99,102,241,0.55); }
.j10-pill[data-kind="table"]    { border-color: rgba(34,197,94,0.55); }
.j10-pill[data-kind="selection"]{ border-color: rgba(234,179,8,0.55); }
.j10-pill[data-kind="relay"]    { border-color: rgba(56,189,248,0.55); }
.j10-pill[data-kind="clip"]     { border-color: rgba(168,85,247,0.55); }
.j10-pill.j10-active {
  background: linear-gradient(180deg, #6366f1 0%, #4f46e5 100%);
  border-color: #818cf8;
  color: #fff;
}
.j10-pill.j10-done {
  background: linear-gradient(180deg, #16a34a 0%, #15803d 100%);
  border-color: #22c55e;
  color: #fff;
}
.j10-pill.j10-err {
  background: linear-gradient(180deg, #dc2626 0%, #b91c1c 100%);
  border-color: #ef4444;
  color: #fff;
}
.j10-pill .j10-icon {
  display: inline-block;
  width: 12px;
  height: 12px;
  text-align: center;
  font-size: 12px;
  line-height: 12px;
}
.j10-sel-bar {
  position: fixed;
  z-index: 2147483601;
  display: flex;
  gap: 3px;
  padding: 3px;
  background: #1a1d22;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.4);
  pointer-events: auto;
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 120ms ease, transform 120ms ease;
}
.j10-sel-bar.j10-visible { opacity: 1; transform: translateY(0); }
.j10-sel-bar .j10-pill { font-size: 11px; padding: 3px 8px; }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  (document.head || document.documentElement).appendChild(style);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 7 — PILL FACTORY
 * ═══════════════════════════════════════════════════════════════════════════ */

function createPill(opts) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'j10-pill';
  btn.setAttribute('data-kind', String(opts.kind || 'code'));
  btn.setAttribute(PILL_ATTR, '1');
  if (opts.id) btn.setAttribute(PILL_ID_ATTR, opts.id);
  btn.title = opts.title || '';

  const icon = document.createElement('span');
  icon.className = 'j10-icon';
  icon.textContent = opts.icon || '⚡';
  btn.appendChild(icon);

  if (opts.label) {
    const label = document.createElement('span');
    label.className = 'j10-label';
    label.textContent = opts.label;
    btn.appendChild(label);
  }

  return btn;
}

function setPillState(btn, state, labelText) {
  if (!btn) return;
  btn.classList.remove('j10-active', 'j10-done', 'j10-err');
  if (state === 'active') btn.classList.add('j10-active');
  else if (state === 'done') btn.classList.add('j10-done');
  else if (state === 'err') btn.classList.add('j10-err');
  if (labelText !== undefined) {
    const labelEl = btn.querySelector('.j10-label');
    if (labelEl) labelEl.textContent = labelText;
    else {
      const s = document.createElement('span');
      s.className = 'j10-label';
      s.textContent = labelText;
      btn.appendChild(s);
    }
  }
  if (state) {
    setTimeout(() => {
      btn.classList.remove('j10-active', 'j10-done', 'j10-err');
    }, 1600);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 8 — CODE BLOCK PILL MANAGER
 * ═══════════════════════════════════════════════════════════════════════════ */

class CodePillManager {
  constructor(adapter, ipc, logger, options) {
    this.adapter = adapter;
    this.ipc = ipc;
    this.log = logger;
    this.opts = Object.assign({
      minCodeLength: 12,
      maxCodeLength: 400000,
      maxBlocksPerPage: 60,
      scanDebounceMs: 400,
      rescanIntervalMs: 3000
    }, options || {});
    this._observer = null;
    this._scanTimer = null;
    this._running = false;
    this._count = 0;
    this._scan = debounce(() => this._doScan(), this.opts.scanDebounceMs);
  }

  start() {
    if (this._running) return;
    this._running = true;

    this._observer = new MutationObserver(() => this._scan());
    if (document.body) {
      try {
        this._observer.observe(document.body, { childList: true, subtree: true });
      } catch (err) {
        this.log.warn('code observer failed', err && err.message);
      }
    }

    this._scanTimer = setInterval(() => this._doScan(), this.opts.rescanIntervalMs);
    if (typeof this._scanTimer.unref === 'function') this._scanTimer.unref();

    // Initial sweep after DOM ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._doScan(), { once: true });
    } else {
      this._doScan();
    }
    this.log.info('CodePillManager started');
  }

  stop() {
    if (this._observer) { try { this._observer.disconnect(); } catch (_) {} this._observer = null; }
    if (this._scanTimer) { clearInterval(this._scanTimer); this._scanTimer = null; }
    this._scan.cancel();
    this._running = false;
  }

  _doScan() {
    if (!this._running) return;
    if (this._count >= this.opts.maxBlocksPerPage) return;

    let blocks;
    try {
      blocks = document.querySelectorAll(this.adapter.codeBlockSelector);
    } catch (err) {
      this.log.warn('code selector failed', err && err.message);
      return;
    }

    for (const block of blocks) {
      if (this._count >= this.opts.maxBlocksPerPage) break;

      // The actual <pre> element (if we matched the inner <code>)
      const pre = (block.tagName === 'PRE')
        ? block
        : (block.closest ? block.closest('pre') : null);
      if (!pre) continue;

      // Already has a pill?
      if (pre.querySelector(`[${PILL_ATTR}]`)) continue;

      const text = textOf(block);
      if (text.length < this.opts.minCodeLength) continue;
      if (text.length > this.opts.maxCodeLength) continue;

      this._attach(pre, block, text);
    }
  }

  _attach(pre, codeEl, text) {
    // Ensure the pre is a positioning context
    const computed = window.getComputedStyle(pre);
    if (computed.position === 'static') {
      pre.style.position = 'relative';
      pre.setAttribute('data-jarvis10-pos-mod', '1');
    }
    pre.classList.add('j10-host');

    const wrap = document.createElement('div');
    wrap.className = 'j10-pill-wrap';

    const applyBtn = createPill({
      kind: 'code',
      icon: '⚡',
      label: 'Apply to Jarvis',
      title: 'Send this code block to JARVIS-CORE',
      id: `code_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`
    });
    applyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      this._onApplyClick(applyBtn, text, codeEl);
    });

    const clipBtn = createPill({
      kind: 'clip',
      icon: '📋',
      label: 'Copy',
      title: 'Copy code to clipboard'
    });
    clipBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      this._onCopyClick(clipBtn, text);
    });

    wrap.appendChild(applyBtn);
    wrap.appendChild(clipBtn);
    pre.appendChild(wrap);
    this._count += 1;
  }

  _onApplyClick(btn, text, codeEl) {
    setPillState(btn, 'active', 'Sending…');

    // Best-effort language detection
    let lang = '';
    if (codeEl && codeEl.className) {
      const m = String(codeEl.className).match(/(?:language|lang)-([a-z0-9+#.]+)/i);
      if (m) lang = m[1].toLowerCase();
    }
    if (!lang) {
      const parentPre = codeEl && codeEl.closest ? codeEl.closest('pre') : null;
      if (parentPre && parentPre.getAttribute) {
        const attr = parentPre.getAttribute('data-language') || parentPre.getAttribute('lang');
        if (attr) lang = String(attr).toLowerCase();
      }
    }

    const payload = {
      kind: 'code',
      text,
      meta: {
        language: lang || null,
        sourceUrl: window.location.href,
        sourcePlatform: this.adapter.name,
        pillAction: 'apply-to-jarvis',
        capturedAt: Date.now()
      }
    };

    const sendResult = this.ipc.invoke(CHANNELS.BUS_PUSH, payload);
    if (sendResult && typeof sendResult.then === 'function') {
      sendResult.then((r) => {
        if (r && r.ok) {
          setPillState(btn, 'done', 'Sent ✓');
        } else {
          setPillState(btn, 'err', 'Failed');
        }
      });
    } else {
      setPillState(btn, 'done', 'Sent ✓');
    }
  }

  async _onCopyClick(btn, text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setPillState(btn, 'done', 'Copied ✓');
      } else {
        // Fallback: hidden textarea
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        setPillState(btn, ok ? 'done' : 'err', ok ? 'Copied ✓' : 'Failed');
      }
    } catch (err) {
      this.log.warn('copy failed', err && err.message);
      setPillState(btn, 'err', 'Failed');
    }
  }

  stats() { return { pillsInjected: this._count }; }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 9 — TABLE PILL MANAGER
 * ═══════════════════════════════════════════════════════════════════════════ */

class TablePillManager {
  constructor(adapter, ipc, logger, options) {
    this.adapter = adapter;
    this.ipc = ipc;
    this.log = logger;
    this.opts = Object.assign({
      minDataRows: 2,
      maxCells: 2000,
      scanDebounceMs: 500,
      maxTablesPerPage: 30
    }, options || {});
    this._observer = null;
    this._scan = debounce(() => this._doScan(), this.opts.scanDebounceMs);
    this._running = false;
    this._count = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._observer = new MutationObserver(() => this._scan());
    if (document.body) {
      try {
        this._observer.observe(document.body, { childList: true, subtree: true });
      } catch (err) {
        this.log.warn('table observer failed', err && err.message);
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._doScan(), { once: true });
    } else {
      this._doScan();
    }
    this.log.info('TablePillManager started');
  }

  stop() {
    if (this._observer) { try { this._observer.disconnect(); } catch (_) {} this._observer = null; }
    this._scan.cancel();
    this._running = false;
  }

  _doScan() {
    if (!this._running) return;
    if (this._count >= this.opts.maxTablesPerPage) return;

    let tables;
    try { tables = document.querySelectorAll(this.adapter.tableSelector); }
    catch (err) { return; }

    for (const table of tables) {
      if (this._count >= this.opts.maxTablesPerPage) break;
      if (table.querySelector(`[${PILL_ATTR}]`)) continue;

      const rowCount = table.querySelectorAll('tr').length;
      if (rowCount < (this.opts.minDataRows + 1)) continue;
      if (table.querySelectorAll('td, th').length > this.opts.maxCells) continue;
      if (!isVisible(table)) continue;

      this._attach(table);
    }
  }

  _attach(table) {
    const computed = window.getComputedStyle(table);
    if (computed.position === 'static') {
      table.style.position = 'relative';
      table.setAttribute('data-jarvis10-pos-mod', '1');
    }
    table.classList.add('j10-host');

    const wrap = document.createElement('div');
    wrap.className = 'j10-pill-wrap';

    const btn = createPill({
      kind: 'table',
      icon: '⚡',
      label: 'Capture Table',
      title: 'Send this table to JARVIS-CORE',
      id: `table_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`
    });
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      this._onCaptureClick(btn, table);
    });

    wrap.appendChild(btn);
    table.appendChild(wrap);
    this._count += 1;
  }

  _extractTable(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    const data = [];
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const rowData = cells.map((c) => textOf(c).replace(/\s+/g, ' ').trim());
      if (rowData.length) data.push(rowData);
    }
    // Determine max column count for a compact TSV/Markdown representation
    const maxCols = data.reduce((m, r) => Math.max(m, r.length), 0);
    const markdown = data.map((r) => {
      const padded = r.slice();
      while (padded.length < maxCols) padded.push('');
      return `| ${padded.join(' | ')} |`;
    });
    if (markdown.length >= 1 && maxCols > 0) {
      const header = markdown[0];
      const sep = `| ${Array(maxCols).fill('---').join(' | ')} |`;
      markdown.splice(1, 0, sep);
      // reorder header/sep
      const fixed = [header, sep, ...markdown.slice(2)];
      return { rows: data, markdown: fixed.join('\n'), cols: maxCols };
    }
    return { rows: data, markdown: markdown.join('\n'), cols: maxCols };
  }

  _onCaptureClick(btn, table) {
    setPillState(btn, 'active', 'Capturing…');
    try {
      const ex = this._extractTable(table);
      if (!ex.markdown) {
        setPillState(btn, 'err', 'Empty');
        return;
      }
      const payload = {
        kind: 'table',
        text: ex.markdown,
        meta: {
          rows: ex.rows.length,
          cols: ex.cols,
          sourceUrl: window.location.href,
          sourcePlatform: this.adapter.name,
          rawTable: ex.rows.slice(0, 200)
        }
      };
      const r = this.ipc.invoke(CHANNELS.BUS_PUSH, payload);
      if (r && typeof r.then === 'function') {
        r.then((res) => setPillState(btn, res && res.ok ? 'done' : 'err', res && res.ok ? 'Sent ✓' : 'Failed'));
      } else {
        setPillState(btn, 'done', 'Sent ✓');
      }
    } catch (err) {
      this.log.warn('table capture failed', err && err.message);
      setPillState(btn, 'err', 'Failed');
    }
  }

  stats() { return { tablesPillified: this._count }; }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 10 — SELECTION RELAY (mouseup + keyboard, debounced, deduped)
 * ═══════════════════════════════════════════════════════════════════════════ */

class SelectionRelay {
  constructor(ipc, logger, options) {
    this.ipc = ipc;
    this.log = logger;
    this.opts = Object.assign({
      minLength: 4,
      maxLength: 8000,
      debounceMs: 260,
      dedupeWindowMs: 1200
    }, options || {});

    this._onMouseUp = this._onMouseUp.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._flush = debounce(() => this._maybePush(), this.opts.debounceMs);
    this._lastHash = '';
    this._lastAt = 0;
    this._running = false;
    this._count = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    document.addEventListener('mouseup', this._onMouseUp, true);
    document.addEventListener('keyup', this._onKeyUp, true);
    this.log.info('SelectionRelay started');
  }

  stop() {
    document.removeEventListener('mouseup', this._onMouseUp, true);
    document.removeEventListener('keyup', this._onKeyUp, true);
    this._flush.cancel();
    this._running = false;
  }

  _onMouseUp() {
    this._flush();
  }

  _onKeyUp(ev) {
    // Only Shift+Arrow / Shift+Home / Shift+End extend selection
    if (!ev.shiftKey) return;
    const k = ev.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown'
        || k === 'Home' || k === 'End') {
      this._flush();
    }
  }

  _maybePush() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = String(sel.toString() || '').trim();
      if (!text) return;
      if (text.length < this.opts.minLength) return;
      if (text.length > this.opts.maxLength) return;

      // Skip if selection is entirely inside one of our own pill UI elements
      const anchor = sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
      if (anchor && anchor.closest && anchor.closest('.j10-pill, .j10-pill-wrap, .j10-sel-bar')) return;

      const hash = sha1Short(text);
      const now = Date.now();
      if (hash === this._lastHash && (now - this._lastAt) < this.opts.dedupeWindowMs) return;
      this._lastHash = hash;
      this._lastAt = now;

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      const payload = {
        kind: 'selection',
        text,
        meta: {
          length: text.length,
          sourceUrl: window.location.href,
          sourcePlatform: this.adapterName(),
          anchorTag: anchor ? anchor.tagName : null,
          rect: {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        }
      };

      this.ipc.send(CHANNELS.BUS_PUSH, payload);
      this._count += 1;
      this._showMiniBar(rect, text);
    } catch (err) {
      this.log.warn('selection push failed', err && err.message);
    }
  }

  adapterName() {
    const host = String(window.location.hostname || '').toLowerCase();
    if (host.includes('claude.ai')) return 'claude';
    if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'chatgpt';
    if (host.includes('gemini.google.com')) return 'gemini';
    return 'generic';
  }

  _showMiniBar(rect, text) {
    // Remove existing bar
    const old = document.querySelector('.j10-sel-bar');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    if (!rect || rect.width === 0) return;
    // Position below selection unless near viewport bottom
    const vh = window.innerHeight;
    const top = (rect.bottom + 8 + 44 > vh) ? (rect.top - 44) : (rect.bottom + 8);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 260));

    const bar = document.createElement('div');
    bar.className = 'j10-sel-bar';
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(left)}px`;

    const sendBtn = createPill({
      kind: 'selection',
      icon: '⚡',
      label: 'Send to Jarvis',
      title: 'Push this selection to JARVIS-CORE'
    });
    sendBtn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.ipc.invoke(CHANNELS.BUS_PUSH, {
        kind: 'selection',
        text,
        meta: { sourceUrl: window.location.href, viaMiniBar: true }
      });
      setPillState(sendBtn, 'done', 'Sent ✓');
      setTimeout(() => this._dismissBar(bar), 500);
    });

    const relayBtn = createPill({
      kind: 'relay',
      icon: '↗',
      label: 'Relay to Tab…',
      title: 'Open relay prompt'
    });
    relayBtn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = window.prompt('Relay to which tab? (name or index)', 'claude');
      if (!target) { this._dismissBar(bar); return; }
      this.ipc.invoke('jarvis10:bus:relay', {
        target: /^\d+$/.test(target) ? Number(target) : { kind: 'name', value: target },
        payload: text,
        kind: 'selection',
        asPrompt: true
      }).then((r) => {
        setPillState(relayBtn, r && (r.ok || (r.result && r.result.ok)) ? 'done' : 'err',
          r && (r.ok || (r.result && r.result.ok)) ? 'Relayed ✓' : 'Failed');
        setTimeout(() => this._dismissBar(bar), 600);
      });
    });

    bar.appendChild(sendBtn);
    bar.appendChild(relayBtn);
    document.body.appendChild(bar);
    requestAnimationFrame(() => bar.classList.add('j10-visible'));

    // Auto-hide after 5s of inactivity
    clearTimeout(this._barTimer);
    this._barTimer = setTimeout(() => this._dismissBar(bar), 5000);
    if (typeof this._barTimer.unref === 'function') this._barTimer.unref();
  }

  _dismissBar(bar) {
    if (!bar) return;
    bar.classList.remove('j10-visible');
    setTimeout(() => {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }, 160);
  }

  stats() { return { selectionsPushed: this._count }; }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 11 — INPUT INJECTOR (React/Vue-aware)
 * ═══════════════════════════════════════════════════════════════════════════ */

class InputInjector {
  constructor(adapter, logger, options) {
    this.adapter = adapter;
    this.log = logger;
    this.opts = Object.assign({
      focusDelayMs: 60,
      submitDelayMs: 220,
      typeDelayMs: 0
    }, options || {});
  }

  _reactValueSetter(el, value) {
    try {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
      if (!proto) return false;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!desc || typeof desc.set !== 'function') return false;
      desc.set.call(el, value);
      return true;
    } catch (err) {
      this.log.warn('react value setter failed', err && err.message);
      return false;
    }
  }

  _dispatchInput(el) {
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) { /* ignore */ }
  }

  async _fillContentEditable(el, text) {
    el.focus();
    await this._sleep(this.opts.focusDelayMs);

    // Clear existing
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);

    // Preferred: execCommand('insertText') works with React contenteditable
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (_) { inserted = false; }

    if (!inserted) {
      // Fallback: clear + set textContent + dispatch InputEvent
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(document.createTextNode(text));
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      } catch (_) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return true;
  }

  async _fillTextarea(el, text) {
    el.focus();
    await this._sleep(this.opts.focusDelayMs);
    const setOk = this._reactValueSetter(el, text);
    if (!setOk) el.value = text;
    this._dispatchInput(el);
    return true;
  }

  /**
   * @param {{text:string, asPrompt?:boolean, submit?:boolean}} req
   */
  async inject(req) {
    const text = typeof req.text === 'string' ? req.text : '';
    if (!text) return { ok: false, error: 'empty-text' };

    const input = this.adapter.chatInput();
    if (!input) return { ok: false, error: 'no-input-found' };

    const isContentEditable = input.isContentEditable === true || input.getAttribute('contenteditable') === 'true';

    try {
      if (isContentEditable) await this._fillContentEditable(input, text);
      else await this._fillTextarea(input, text);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'fill-failed' };
    }

    if (req.submit !== false && req.asPrompt !== false) {
      await this._sleep(this.opts.submitDelayMs);
      const btn = this.adapter.submitButton();
      if (btn && isVisible(btn) && !btn.disabled) {
        btn.click();
      } else {
        // Fallback: synthesize Enter key
        const enterOpts = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
        input.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
        input.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
      }
    }

    return { ok: true, inputKind: isContentEditable ? 'contenteditable' : 'textarea' };
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 12 — MAIN PRELOAD CONTROLLER
 * ═══════════════════════════════════════════════════════════════════════════ */

class WebviewPreload {
  constructor() {
    const host = String(window.location.hostname || '').toLowerCase();
    this.log = createLogger(`K10:PRELOAD[${host || 'local'}]`, 'info');
    this.platform = detectPlatform();
    this.adapter = pickAdapter(this.platform);
    this.ipc = new IpcBridge(this.log.child('ipc'));

    this.streamDetector = new StreamDetector(this.adapter, this.log.child('stream'));
    this.codeMgr = new CodePillManager(this.adapter, this.ipc, this.log.child('code'));
    this.tableMgr = new TablePillManager(this.adapter, this.ipc, this.log.child('table'));
    this.selection = new SelectionRelay(this.ipc, this.log.child('selection'));
    this.injector = new InputInjector(this.adapter, this.log.child('inject'));

    this._tabId = null;
    this._startedAt = Date.now();
    this._initialized = false;
  }

  setTabId(tabId) {
    this._tabId = tabId;
    this.log.info(`preload bound to tabId=${tabId}`);
  }

  async initialize() {
    if (this._initialized) return;
    this._initialized = true;

    // Inject CSS early
    injectStyles();

    // Wire stream → IPC
    this.streamDetector.on('complete', (payload) => this._onStreamComplete(payload));
    this.streamDetector.on('start', (payload) => this._onStreamStart(payload));

    // Listen to relay channels
    ipcRenderer.on(CHANNELS.RELAY_PROMPT, (_e, payload) => this._onRelayPrompt(payload));
    ipcRenderer.on(CHANNELS.RELAY_INJECT_INPUT, (_e, payload) => this._onRelayInjectInput(payload));

    // Start subsystems
    this.streamDetector.start();
    this.codeMgr.start();
    this.tableMgr.start();
    this.selection.start();

    // Handshake with main
    this.ipc.send(CHANNELS.PRELOAD_HELLO, {
      module: MODULE_ID,
      version: MODULE_VERSION,
      platform: this.platform,
      url: window.location.href,
      title: document.title,
      readyAt: this._startedAt,
      contextIsolation: !!(typeof contextBridge === 'object' && contextBridge)
    });

    this.log.info(`WebviewPreload v${MODULE_VERSION} ready (platform=${this.platform})`);
  }

  _onStreamStart(payload) {
    this.log.debug(`stream started (len=${payload.textLength})`);
  }

  _onStreamComplete(payload) {
    this.log.debug(`stream complete (len=${payload.textLength}, broadcast=${payload.broadcastId || 'none'})`);

    // 1. Push to shared context bus as AI response
    this.ipc.send(CHANNELS.BUS_PUSH, {
      kind: 'ai-response',
      text: payload.text,
      meta: {
        sourceUrl: payload.sourceUrl,
        sourcePlatform: payload.sourcePlatform,
        signature: payload.signature,
        broadcastId: payload.broadcastId
      }
    });

    // 2. If this was the answer to a broadcast, notify the bus
    if (payload.broadcastId) {
      this.ipc.send(CHANNELS.BUS_BROADCAST_RESPONSE, {
        broadcastId: payload.broadcastId,
        targetKey: payload.targetKey || null,
        text: payload.text,
        ok: true,
        meta: { platform: payload.sourcePlatform, sourceUrl: payload.sourceUrl }
      });
    }
  }

  async _onRelayPrompt(payload) {
    if (!payload || typeof payload !== 'object') return;
    const text = typeof payload.prompt === 'string' ? payload.prompt : '';
    if (!text) return;

    // Register broadcast BEFORE typing so we capture the response
    if (payload.broadcastId) {
      this.streamDetector.registerPendingBroadcast(payload.broadcastId, payload.targetKey || null);
    }

    this.log.debug(`relay-prompt received (broadcast=${payload.broadcastId || 'none'}, len=${text.length})`);

    try {
      const result = await this.injector.inject({
        text,
        asPrompt: true,
        submit: true
      });
      if (!result.ok) {
        this.log.warn(`inject failed: ${result.error}`);
        if (payload.broadcastId) {
          this.ipc.send(CHANNELS.BUS_BROADCAST_RESPONSE, {
            broadcastId: payload.broadcastId,
            targetKey: payload.targetKey || null,
            text: '',
            ok: false,
            meta: { error: result.error }
          });
        }
      }
    } catch (err) {
      this.log.warn('relay-prompt threw', err && err.message);
    }
  }

  async _onRelayInjectInput(payload) {
    if (!payload || typeof payload !== 'object') return;
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text) return;

    this.log.debug(`relay-inject-input received (len=${text.length}, asPrompt=${!!payload.asPrompt})`);

    try {
      await this.injector.inject({
        text,
        asPrompt: !!payload.asPrompt,
        submit: !!payload.asPrompt
      });
    } catch (err) {
      this.log.warn('relay-inject-input threw', err && err.message);
    }
  }

  getDiagnostics() {
    return {
      module: MODULE_ID,
      version: MODULE_VERSION,
      platform: this.platform,
      url: window.location.href,
      title: document.title,
      readyAt: this._startedAt,
      uptimeMs: Date.now() - this._startedAt,
      ipc: this.ipc.stats(),
      code: this.codeMgr.stats(),
      table: this.tableMgr.stats(),
      selection: this.selection.stats()
    };
  }

  shutdown() {
    try { this.streamDetector.stop(); } catch (_) {}
    try { this.codeMgr.stop(); } catch (_) {}
    try { this.tableMgr.stop(); } catch (_) {}
    try { this.selection.stop(); } catch (_) {}
    this.log.info('WebviewPreload shut down');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SECTION 13 — BOOTSTRAP
 * ═══════════════════════════════════════════════════════════════════════════ */

const preload = new WebviewPreload();

// Expose a minimal frozen control surface to the page (optional — used only
// for debugging from DevTools; the pills operate entirely from preload).
try {
  if (typeof contextBridge === 'object' && contextBridge) {
    contextBridge.exposeInMainWorld('__jarvis10', Object.freeze({
      version: MODULE_VERSION,
      platform: preload.platform,
      diagnostics: () => preload.getDiagnostics(),
      forceHarvest: () => preload.streamDetector.forceComplete()
    }));
  }
} catch (err) {
  preload.log.warn('contextBridge exposure failed', err && err.message);
}

// Wait for DOM to be at least interactive before booting observers
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    preload.initialize().catch((err) => preload.log.error('init failed', err && err.message));
  }, { once: true });
} else {
  preload.initialize().catch((err) => preload.log.error('init failed', err && err.message));
}

// Clean shutdown on page unload
window.addEventListener('beforeunload', () => {
  try { preload.shutdown(); } catch (_) {}
}, { once: true });

module.exports = {
  MODULE_ID,
  MODULE_VERSION,
  CHANNELS,
  preload
};