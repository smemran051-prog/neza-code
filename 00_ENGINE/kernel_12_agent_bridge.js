'use strict';

/**
 * ============================================================================
 * JARVIS-CORE :: KERNEL 12 — PURCHASED WEB AI & AGENTIC BRIDGE (v5.0 Preload-IPC)
 * File Location : 00_ENGINE/kernel_12_agent_bridge.js
 * ============================================================================
 *
 * Why v5.0 Fixes `MaxListenersExceededWarning (did-stop-loading)` & CSP Block:
 *  1. Zero `executeJavaScript` Polling (No `did-stop-loading` Leak!):
 *     - In Electron 36, calling `webContents.executeJavaScript()` while a page
 *       has open streams queues `did-stop-loading` listeners and hangs forever.
 *     - v5.0 eliminates `executeJavaScript` polling completely and uses a
 *       dedicated Isolated Preload Script (`00_ENGINE/k12_ai_preload.js`,
 *       auto-generated on startup) that communicates via native Electron IPC
 *       (`ipcRenderer.send` / `ipcRenderer.on`) in <1ms!
 *  2. 100% Immune to Browser CSP & TrustedTypes:
 *     - Electron Preload scripts run in an isolated world with full DOM access
 *       and `ipcRenderer`, completely bypassing Gemini/Claude/ChatGPT CSP!
 *  3. Works Automatically Both Ways When "⚡ Tool Call: ON" is Active:
 *     - Way A (Direct in Gemini Window): Type "open youtube" inside your
 *       `jervis Command` Gem window -> as soon as Gemini outputs the JSON block,
 *       the Preload script sends it via IPC to Kernel 12 and JARVIS executes it
 *       on your PC immediately!
 *     - Way B (From JARVIS Chat Box): Type "open youtube" in JARVIS chat ->
 *       Kernel 12 sends `k12:inject-prompt` via IPC -> Preload types & clicks
 *       Send in Gemini -> Gemini outputs JSON -> Preload sends it back via IPC
 *       -> JARVIS executes the tool immediately!
 *     - Way C (1-Click Pill): Click `[⚡ Send to Jarvis]` on any JSON block.
 * ============================================================================
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { BrowserWindow, ipcMain, dialog, shell, session } = require('electron');

const LOG_TAG = 'k12.agent_bridge';
const PORT = 8080;
const COMMAND_TAG = '__K12__';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PERSIST_PARTITION = 'persist:jarvis_workspace';

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, '00_ENGINE');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG');
const TOOLS_DIR = path.join(ENGINE_DIR, 'tools');
const TOOLS_INDEX_FILE = path.join(ENGINE_DIR, 'tools_index.json');
const K12_SETTINGS_FILE = path.join(CONFIG_DIR, 'kernel12_purchased_ai.json');
const K12_PRELOAD_FILE = path.join(ENGINE_DIR, 'k12_ai_preload.js');
const CHROME_EXT_DIR = path.join(ROOT, 'work', 'jarvis_chrome_bridge_ext');

// Genuine Google Chrome Identity (Fixes Google Sign-In "This browser or app may not be secure")
const CHROME_FULL_VER = process.versions.chrome || '134.0.6998.89';
const CHROME_MAJOR = CHROME_FULL_VER.split('.')[0] || '134';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL_VER} Safari/537.36`;
const CHROME_SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not-A.Brand";v="99"`;
const CHROME_SEC_CH_FULL = `"Chromium";v="${CHROME_FULL_VER}", "Google Chrome";v="${CHROME_FULL_VER}", "Not-A.Brand";v="99.0.0.0"`;

const DESTRUCTIVE_CMD_RE = /\b(?:format(?:\.com)?\s+[a-z]:|diskpart|rd\s+\/s|rmdir\s+\/s|del\s+\/[fqs]|erase\s+\/[fqs]|remove-item\b.*-recurse|shutdown(?:\.exe)?\s+\/[sr]|reg\s+delete)\b/i;

const DEFAULT_K12_SETTINGS = Object.freeze({
  activeUrl: 'https://gemini.google.com/app',
  preset: 'gemini',
  toolBridgeEnabled: true,
  maxToolSteps: 6,
  responseTimeoutMs: 60000,
  presets: {
    gemini: 'https://gemini.google.com/app',
    claude: 'https://claude.ai/new',
    chatgpt: 'https://chatgpt.com/',
    deepseek: 'https://chat.deepseek.com/',
  },
});

let _ctx = null;
let _audit = null;
let _server = null;
let _purchasedAiWin = null;
let _isQuitting = false;
let _sessionStealthInstalled = false;
let _ipcListenersInstalled = false;
let _uiInjectedOnce = false;
let _executedJsonSignatures = new Set();
let _pendingPromptWaiter = null;
let _pendingUserDecision = null;
let _wsClients = new Set();

// ---------------------------------------------------------------------------
// 1. LOGGING & SETTINGS PERSISTENCE
// ---------------------------------------------------------------------------
function audit(level, event, data) {
  if (typeof _audit !== 'function') return;
  try {
    _audit(level, `${LOG_TAG}.${event}`, data || {});
  } catch (_) {}
}

function loadK12Settings() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(K12_SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(K12_SETTINGS_FILE, 'utf8'));
      return {
        ...DEFAULT_K12_SETTINGS,
        ...(raw || {}),
        presets: { ...DEFAULT_K12_SETTINGS.presets, ...((raw && raw.presets) || {}) },
      };
    }
  } catch (e) {
    audit('warn', 'settings_load_error', { error: String(e.message || e) });
  }
  return { ...DEFAULT_K12_SETTINGS, presets: { ...DEFAULT_K12_SETTINGS.presets } };
}

function saveK12Settings(patch) {
  const current = loadK12Settings();
  const next = {
    ...current,
    ...(patch || {}),
    presets: {
      ...current.presets,
      ...((patch && patch.presets) || {}),
    },
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(K12_SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
    audit('info', 'settings_saved', { activeUrl: next.activeUrl, toolBridgeEnabled: next.toolBridgeEnabled });
  } catch (e) {
    audit('warn', 'settings_save_error', { error: String(e.message || e) });
  }
  return next;
}

function getMainWindow() {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (!w || w.isDestroyed()) continue;
      if (_purchasedAiWin && w.id === _purchasedAiWin.id) continue;
      const title = String(w.getTitle() || '');
      if (/JARVIS-CORE/i.test(title)) return w;
    }
    for (const w of wins) {
      if (!w || w.isDestroyed()) continue;
      if (_purchasedAiWin && w.id === _purchasedAiWin.id) continue;
      return w;
    }
  } catch (_) {}
  return null;
}

function broadcastToUI(eventName, data) {
  try {
    const mainWin = getMainWindow();
    if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isLoadingMainFrame()) {
      const payload = JSON.stringify({ event: eventName, data: data || {} });
      mainWin.webContents
        .executeJavaScript(`window.dispatchEvent(new CustomEvent('j10ws-agent-event', { detail: ${payload} })); true;`)
        .catch(() => {});
    }
  } catch (_) {}
}

function sendChatNoticeToUI(text) {
  try {
    const mainWin = getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('jarvis:ai-response', { text: String(text || '') });
    }
  } catch (_) {}
}

function fastSignature(str) {
  return crypto.createHash('sha1').update(String(str || '').trim()).digest('hex');
}

// ---------------------------------------------------------------------------
// 2. AUTO-GENERATED ISOLATED PRELOAD SCRIPT (`00_ENGINE/k12_ai_preload.js`)
// ---------------------------------------------------------------------------
// Runs inside the Purchased AI Window in Electron's Isolated Preload World.
// Uses pure `ipcRenderer` — ZERO `executeJavaScript` calls, ZERO
// `did-stop-loading` listeners, and 100% immune to page CSP / TrustedTypes!
// ---------------------------------------------------------------------------
function __K12_PRELOAD_RUNTIME__(ipcRenderer) {
  if (window.__K12_PRELOAD_ACTIVE__) return;
  window.__K12_PRELOAD_ACTIVE__ = true;

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
  }

  function findInputBox() {
    const selectors = [
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"][aria-label*="Ask" i]',
      'div[contenteditable="true"][data-testid="chat-input"]',
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'fieldset div[contenteditable="true"]',
      'textarea[data-id="root"]',
      'textarea',
      'div[contenteditable="true"]',
    ];
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (isVisible(nodes[i])) return nodes[i];
        }
        if (nodes.length > 0) return nodes[nodes.length - 1];
      } catch (_) {}
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button.send-button',
      '.send-button-container button',
      'button[aria-label*="Send" i]',
      'button[mattooltip*="Send" i]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Submit" i]',
      'button.submit',
      'button[type="submit"]',
    ];
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (let i = nodes.length - 1; i >= 0; i--) {
          const btn = nodes[i];
          if (isVisible(btn) && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
            return btn;
          }
        }
      } catch (_) {}
    }
    return null;
  }

  function cleanText(raw) {
    return String(raw || '')
      .replace(/⚡\s*Send to Jarvis/gi, '')
      .replace(/⚡\s*Relay/gi, '')
      .replace(/⚡\s*Apply/gi, '')
      .replace(/^JSON\s*\n/i, '')
      .trim();
  }

  function readLatestOutput() {
    const msgSelectors = [
      'model-response message-content',
      'message-content',
      '[data-test-id="model-response"]',
      '.model-response-text',
      '[data-message-author-role="assistant"]',
      '[data-testid="chat-message-content"]',
      'div.font-claude-message',
      'div.ds-markdown',
      'div.markdown',
    ];

    let msgNodes = [];
    for (const sel of msgSelectors) {
      try {
        const found = document.querySelectorAll(sel);
        if (found && found.length > 0) {
          msgNodes = Array.from(found);
          break;
        }
      } catch (_) {}
    }

    const codeNodes = Array.from(document.querySelectorAll('pre code, pre'));
    const lastMsg = msgNodes.length > 0 ? msgNodes[msgNodes.length - 1] : null;
    const lastCode = codeNodes.length > 0 ? codeNodes[codeNodes.length - 1] : null;

    const msgText = lastMsg ? cleanText(lastMsg.innerText || lastMsg.textContent) : '';
    const codeText = lastCode ? cleanText(lastCode.innerText || lastCode.textContent) : '';

    let isStreaming = false;
    const stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button[data-testid="stop-button"]',
      '[data-is-streaming="true"]',
      '.streaming-indicator',
    ];
    for (const sSel of stopSelectors) {
      try {
        const stopEl = document.querySelector(sSel);
        if (stopEl && isVisible(stopEl)) {
          isStreaming = true;
          break;
        }
      } catch (_) {}
    }

    return {
      msgCount: msgNodes.length,
      msgText,
      codeCount: codeNodes.length,
      codeText,
      isStreaming,
    };
  }

  let baselineDone = false;
  let lastEmittedKey = '';
  let candidateKey = '';
  let candidateSnap = null;
  let lastMutationTs = 0;

  function makeKey(snap) {
    const primary = snap.codeText && snap.codeText.includes('"action"') ? snap.codeText : snap.msgText;
    return (
      snap.codeCount +
      ':' +
      snap.msgCount +
      ':' +
      primary.length +
      ':' +
      primary.slice(0, 80) +
      ':' +
      primary.slice(-80)
    );
  }

  setTimeout(() => {
    try {
      const snap = readLatestOutput();
      lastEmittedKey = makeKey(snap);
      baselineDone = true;
      ipcRenderer.send('k12:preload-ready', { url: location.href, title: document.title });
    } catch (_) {
      baselineDone = true;
    }
  }, 1200);

  // Local DOM inspection inside Preload (zero executeJavaScript, zero did-stop-loading listeners!)
  setInterval(() => {
    if (!baselineDone) return;
    try {
      const snap = readLatestOutput();
      const hasJsonCode = snap.codeText && snap.codeText.includes('"action"');
      const hasMsg = snap.msgText && snap.msgText.length > 0;
      if (!hasJsonCode && !hasMsg) return;

      const key = makeKey(snap);
      if (key === lastEmittedKey) return;

      if (key !== candidateKey) {
        candidateKey = key;
        candidateSnap = snap;
        lastMutationTs = Date.now();
        return;
      }

      const stableMs = Date.now() - lastMutationTs;
      const ready =
        (hasJsonCode && !snap.isStreaming && stableMs >= 650) ||
        (hasJsonCode && stableMs >= 1400) ||
        (!snap.isStreaming && stableMs >= 1400) ||
        stableMs >= 3800;

      if (ready && candidateSnap) {
        lastEmittedKey = key;
        ipcRenderer.send('k12:ai-output-ready', {
          codeText: candidateSnap.codeText,
          msgText: candidateSnap.msgText,
          codeCount: candidateSnap.codeCount,
          msgCount: candidateSnap.msgCount,
          url: location.href,
        });
      }
    } catch (_) {}
  }, 450);

  // Receive prompt from JARVIS Chat Box via pure IPC (k12:inject-prompt)
  ipcRenderer.on('k12:inject-prompt', (_ev, payload) => {
    try {
      const text = String((payload && payload.text) || '').trim();
      const requestId = payload && payload.requestId;
      if (!text) return;

      const snapBefore = readLatestOutput();
      lastEmittedKey = makeKey(snapBefore);

      const input = findInputBox();
      if (!input) {
        ipcRenderer.send('k12:inject-status', { requestId, ok: false, error: 'input_not_found' });
        return;
      }

      input.focus();
      if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(input);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false, null);
        } catch (_) {}

        let ok = false;
        try {
          ok = document.execCommand('insertText', false, text);
        } catch (_) {}

        if (!ok || !String(input.textContent || '').trim()) {
          input.textContent = text;
        }

        try {
          input.dispatchEvent(
            new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
          );
          input.dispatchEvent(
            new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: text })
          );
        } catch (_) {
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else {
        try {
          const proto =
            input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(input, text);
        } catch (_) {
          input.value = text;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      setTimeout(() => {
        const btn = findSendButton();
        if (btn) {
          try {
            btn.click();
          } catch (_) {}
          ipcRenderer.send('k12:inject-status', { requestId, ok: true, clicked: true });
        } else {
          ipcRenderer.send('k12:inject-status', { requestId, ok: true, clicked: false, needNativeEnter: true });
        }
      }, 180);
    } catch (e) {
      ipcRenderer.send('k12:inject-status', {
        requestId: payload && payload.requestId,
        ok: false,
        error: String(e.message || e),
      });
    }
  });
}

function ensurePreloadAndExtensionFiles() {
  try {
    const preloadCode = [
      "'use strict';",
      "const { ipcRenderer } = require('electron');",
      "try { require('./kernel_10_webview_preload.js'); } catch (_) {}",
      `(${__K12_PRELOAD_RUNTIME__.toString()})(ipcRenderer);`,
      '',
    ].join('\n');
    fs.writeFileSync(K12_PRELOAD_FILE, preloadCode, 'utf8');
  } catch (e) {
    audit('warn', 'write_k12_preload_failed', { error: String(e.message || e) });
  }

  try {
    fs.mkdirSync(CHROME_EXT_DIR, { recursive: true });
    const manifest = {
      manifest_version: 3,
      name: 'JARVIS K12 Purchased AI Auto-Bridge (CSP-Free)',
      version: '5.0.0',
      description: 'Bypasses page CSP via Service Worker and auto-sends Gemini/Claude/ChatGPT JSON commands directly to JARVIS.',
      permissions: ['activeTab', 'scripting'],
      host_permissions: [
        'http://127.0.0.1:8080/*',
        'http://localhost:8080/*',
        'https://gemini.google.com/*',
        'https://claude.ai/*',
        'https://chatgpt.com/*',
        'https://chat.openai.com/*',
        'https://chat.deepseek.com/*',
      ],
      background: {
        service_worker: 'background.js',
      },
      content_scripts: [
        {
          matches: [
            'https://gemini.google.com/*',
            'https://claude.ai/*',
            'https://chatgpt.com/*',
            'https://chat.openai.com/*',
            'https://chat.deepseek.com/*',
          ],
          js: ['content.js'],
          run_at: 'document_idle',
        },
      ],
    };

    const backgroundJs = [
      'chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {',
      '  if (msg && msg.type === "JARVIS_AUTO_JSON") {',
      '    fetch("http://127.0.0.1:8080/api/auto-json", {',
      '      method: "POST",',
      '      headers: { "Content-Type": "application/json" },',
      '      body: JSON.stringify(msg.payload || {})',
      '    })',
      '    .then(r => r.json())',
      '    .then(data => sendResponse({ ok: true, data }))',
      '    .catch(err => sendResponse({ ok: false, error: String(err) }));',
      '    return true;',
      '  }',
      '});',
    ].join('\n');

    const contentJs = [
      '(function() {',
      '  let lastSentCode = "";',
      '  let candidateCode = "";',
      '  let stableTicks = 0;',
      '  function getLatestCode() {',
      '    const codes = document.querySelectorAll("pre code, pre");',
      '    if (!codes || codes.length === 0) return "";',
      '    const last = codes[codes.length - 1];',
      '    return String(last.innerText || last.textContent || "").trim();',
      '  }',
      '  setTimeout(() => { lastSentCode = getLatestCode(); }, 1200);',
      '  setInterval(() => {',
      '    const code = getLatestCode();',
      '    if (!code || !code.includes(\'"action"\') || code === lastSentCode) {',
      '      stableTicks = 0;',
      '      return;',
      '    }',
      '    if (code !== candidateCode) {',
      '      candidateCode = code;',
      '      stableTicks = 1;',
      '      return;',
      '    }',
      '    stableTicks++;',
      '    if (stableTicks >= 2) {',
      '      lastSentCode = code;',
      '      stableTicks = 0;',
      '      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {',
      '        chrome.runtime.sendMessage({',
      '          type: "JARVIS_AUTO_JSON",',
      '          payload: { rawText: code, source: location.href }',
      '        });',
      '      }',
      '    }',
      '  }, 700);',
      '})();',
    ].join('\n');

    fs.writeFileSync(path.join(CHROME_EXT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(CHROME_EXT_DIR, 'background.js'), backgroundJs, 'utf8');
    fs.writeFileSync(path.join(CHROME_EXT_DIR, 'content.js'), contentJs, 'utf8');
  } catch (_) {}
}

function launchExternalBrowserWithExtension(targetUrl) {
  ensurePreloadAndExtensionFiles();
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const exe = candidates.find((p) => fs.existsSync(p));
  if (exe) {
    spawn(exe, [`--load-extension=${CHROME_EXT_DIR}`, targetUrl], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return true;
  }
  shell.openExternal(targetUrl).catch(() => {});
  return false;
}

// ---------------------------------------------------------------------------
// 3. CHROME STEALTH HEADERS (FIXES GOOGLE LOGIN)
// ---------------------------------------------------------------------------
function installSessionChromeStealth() {
  if (_sessionStealthInstalled) return;
  _sessionStealthInstalled = true;

  const partitionsToPatch = [
    session.fromPartition(PERSIST_PARTITION),
    session.defaultSession,
  ].filter(Boolean);

  for (const sess of partitionsToPatch) {
    try {
      sess.setUserAgent(CHROME_UA);
      sess.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...(details.requestHeaders || {}) };

        for (const k of Object.keys(headers)) {
          const lower = k.toLowerCase();
          if (lower === 'user-agent') headers[k] = CHROME_UA;
          else if (lower === 'sec-ch-ua') headers[k] = CHROME_SEC_CH_UA;
          else if (lower === 'sec-ch-ua-full-version-list') headers[k] = CHROME_SEC_CH_FULL;
          else if (lower === 'sec-ch-ua-full-version') headers[k] = `"${CHROME_FULL_VER}"`;
          else if (lower === 'sec-ch-ua-platform') headers[k] = '"Windows"';
          else if (lower === 'sec-ch-ua-mobile') headers[k] = '?0';
          else if (lower === 'x-requested-with') delete headers[k];
        }

        if (!headers['sec-ch-ua'] && !headers['Sec-CH-UA']) {
          headers['sec-ch-ua'] = CHROME_SEC_CH_UA;
          headers['sec-ch-ua-mobile'] = '?0';
          headers['sec-ch-ua-platform'] = '"Windows"';
        }

        callback({ cancel: false, requestHeaders: headers });
      });
    } catch (e) {
      audit('warn', 'session_stealth_patch_error', { error: String(e.message || e) });
    }
  }
}

async function clearGoogleRejectedCookies() {
  try {
    const sess = session.fromPartition(PERSIST_PARTITION);
    const cookies = await sess.cookies.get({ domain: 'accounts.google.com' });
    for (const c of cookies) {
      await sess.cookies.remove(`https://accounts.google.com${c.path || '/'}`, c.name).catch(() => {});
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 4. PERSISTENT PURCHASED AI WINDOW (WITH K12 PRELOAD & MAX LISTENERS SAFE)
// ---------------------------------------------------------------------------
async function ensurePurchasedAiWindow(opts = {}) {
  installSessionChromeStealth();
  ensurePreloadAndExtensionFiles();

  const cfg = loadK12Settings();
  const targetUrl = String(opts.url || cfg.activeUrl || 'https://gemini.google.com/app').trim();
  const showWindow = opts.show === true;

  if (_purchasedAiWin && !_purchasedAiWin.isDestroyed()) {
    const wc = _purchasedAiWin.webContents;
    wc.setMaxListeners(50);
    const currentUrl = String(wc.getURL() || '');

    if (currentUrl.includes('/signin/rejected')) {
      await clearGoogleRejectedCookies();
      await _purchasedAiWin.loadURL(targetUrl, { userAgent: CHROME_UA }).catch(() => {});
    } else if (opts.forceNavigate && targetUrl && currentUrl !== targetUrl) {
      await _purchasedAiWin.loadURL(targetUrl, { userAgent: CHROME_UA }).catch(() => {});
    }

    if (showWindow) {
      try {
        if (_purchasedAiWin.isMinimized()) _purchasedAiWin.restore();
        _purchasedAiWin.show();
        _purchasedAiWin.moveTop();
        _purchasedAiWin.focus();
      } catch (_) {}
    }

    broadcastToUI('agent:connected', { message: 'Purchased AI Session Connected' });
    return wc;
  }

  await clearGoogleRejectedCookies();

  _purchasedAiWin = new BrowserWindow({
    width: 1100,
    height: 780,
    show: showWindow,
    title: 'JARVIS :: Purchased AI Session (Login Once — Auto-Saved)',
    backgroundColor: '#0B1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: K12_PRELOAD_FILE,
      partition: PERSIST_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  const wc = _purchasedAiWin.webContents;
  wc.setMaxListeners(50);
  wc.setUserAgent(CHROME_UA);

  wc.setWindowOpenHandler(() => {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 540,
        height: 700,
        autoHideMenuBar: true,
        webPreferences: {
          partition: PERSIST_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      },
    };
  });

  wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
    if (!isMainFrame || typeof navUrl !== 'string') return;
    if (/^https:\/\/(gemini\.google\.com|claude\.ai|chatgpt\.com|chat\.deepseek\.com)/i.test(navUrl)) {
      if (!navUrl.includes('accounts.google.com')) {
        const updated = saveK12Settings({ activeUrl: navUrl });
        broadcastToUI('k12:state-sync', updated);
      }
    }
  });

  wc.on('did-navigate', async (_e, navUrl) => {
    if (typeof navUrl === 'string' && navUrl.includes('/signin/rejected')) {
      await clearGoogleRejectedCookies();
    }
  });

  _purchasedAiWin.on('close', (e) => {
    if (!_isQuitting && _purchasedAiWin && !_purchasedAiWin.isDestroyed()) {
      e.preventDefault();
      _purchasedAiWin.minimize();
      broadcastToUI('agent:connected', { message: 'Purchased AI Running in Background' });
    }
  });

  await _purchasedAiWin.loadURL(targetUrl, { userAgent: CHROME_UA }).catch((e) => {
    audit('warn', 'purchased_ai_load_error', { url: targetUrl, error: String(e.message || e) });
  });

  if (showWindow && _purchasedAiWin && !_purchasedAiWin.isDestroyed()) {
    try {
      if (_purchasedAiWin.isMinimized()) _purchasedAiWin.restore();
      _purchasedAiWin.show();
      _purchasedAiWin.moveTop();
      _purchasedAiWin.focus();
    } catch (_) {}
  }

  broadcastToUI('agent:connected', { message: 'Purchased AI Session Connected' });
  return wc;
}

// ---------------------------------------------------------------------------
// 5. ON-DEMAND TOOL LIBRARIAN & BUILT-IN EXECUTION ENGINE
// ---------------------------------------------------------------------------
async function confirmRiskyExecution(title, detail) {
  if (_ctx && _ctx.settings && _ctx.settings.unattended === true) return false;
  try {
    const mainWin = getMainWindow();
    const { response } = await dialog.showMessageBox(mainWin || undefined, {
      type: 'warning',
      buttons: ['Deny', 'Approve'],
      defaultId: 0,
      cancelId: 0,
      title: 'JARVIS Security Gate',
      message: title,
      detail: String(detail || '').slice(0, 1000),
    });
    return response === 1;
  } catch (_) {
    return false;
  }
}

const BUILTIN_TOOLS = {
  read_file: async (args) => {
    if (!args || !args.path) throw new Error('path_required');
    const fullPath = path.resolve(ROOT, String(args.path));
    if (!fs.existsSync(fullPath)) throw new Error(`file_not_found: ${args.path}`);
    const content = fs.readFileSync(fullPath, 'utf8');
    return content.length > 15000 ? content.slice(0, 15000) + '\n...[truncated]' : content;
  },

  write_file: async (args) => {
    if (!args || !args.path || args.content === undefined) throw new Error('path_and_content_required');
    const fullPath = path.resolve(ROOT, String(args.path));
    const norm = fullPath.toLowerCase();
    if (norm.includes('01_config') || norm.endsWith('kernel.js') || norm.endsWith('system_rules.json')) {
      const ok = await confirmRiskyExecution('JARVIS wants to modify a protected file', fullPath);
      if (!ok) throw new Error('permission_denied_by_user');
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, String(args.content), 'utf8');
    return `Successfully wrote ${Buffer.byteLength(String(args.content), 'utf8')} bytes to ${args.path}`;
  },

  list_dir: async (args) => {
    const target = args && args.path ? String(args.path) : '.';
    const dirPath = path.resolve(ROOT, target);
    if (!fs.existsSync(dirPath)) throw new Error(`directory_not_found: ${target}`);
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).slice(0, 250);
    return entries.map((e) => (e.isDirectory() ? `[DIR] ${e.name}` : e.name));
  },

  run_command: (args, callback) => {
    if (!args || !args.command) {
      if (callback) return callback({ stdout: '', stderr: '', error: 'command_required' });
      throw new Error('command_required');
    }
    const cmd = String(args.command).trim();
    try {
      exec(cmd, { timeout: 25000, cwd: ROOT, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        const res = {
          command: cmd,
          stdout: String(stdout || '').slice(0, 12000),
          stderr: String(stderr || '').slice(0, 4000),
          error: err ? err.message : null,
        };
        if (callback) callback(res);
      });
    } catch (err) {
      if (callback) callback({ command: cmd, stdout: '', stderr: '', error: err.message });
    }
  },

  open_url: async (args) => {
    const rawUrl = String((args && (args.url || args.site || args.query)) || '').trim();
    if (!rawUrl) throw new Error('url_required');
    const targetUrl = /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : rawUrl.includes('.') && !rawUrl.includes(' ')
      ? `https://${rawUrl}`
      : `https://www.google.com/search?q=${encodeURIComponent(rawUrl)}`;
    await shell.openExternal(targetUrl);
    return `Opened URL in browser: ${targetUrl}`;
  },
};

function searchLibraryToolsOnDemand(queryText, maxResults = 3) {
  let matched = [];
  try {
    const librarian = _ctx && typeof _ctx.getService === 'function' ? _ctx.getService('tool_librarian') : null;
    if (librarian && typeof librarian.searchTools === 'function') {
      matched = librarian.searchTools(String(queryText || ''), maxResults) || [];
    }
  } catch (_) {}

  if (!matched || matched.length === 0) {
    try {
      if (fs.existsSync(TOOLS_INDEX_FILE)) {
        const idx = JSON.parse(fs.readFileSync(TOOLS_INDEX_FILE, 'utf8'));
        const list = Array.isArray(idx.tools) ? idx.tools : [];
        const words = String(queryText || '')
          .toLowerCase()
          .split(/[^a-z0-9_\u0980-\u09FF]+/)
          .filter((w) => w.length >= 2);

        const scored = [];
        for (const item of list) {
          if (item.enabled === false) continue;
          let score = 0;
          const nameL = String(item.name || '').toLowerCase();
          const descL = String(item.description || '').toLowerCase();
          const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t).toLowerCase()) : [];

          for (const w of words) {
            if (nameL.includes(w)) score += 5;
            if (tags.some((t) => t.includes(w))) score += 4;
            if (descL.includes(w)) score += 2;
          }
          if (score > 0) scored.push({ item, score });
        }
        scored.sort((a, b) => b.score - a.score);
        matched = scored.slice(0, maxResults).map((s) => s.item);
      }
    } catch (_) {}
  }

  const enriched = [];
  for (const m of matched) {
    let parameters = { type: 'object', properties: {} };
    try {
      const toolFile = path.join(TOOLS_DIR, m.file || `${m.name}.js`);
      if (fs.existsSync(toolFile)) {
        const mod = require(toolFile);
        if (mod && mod.parameters) parameters = mod.parameters;
      }
    } catch (_) {}
    enriched.push({
      name: m.name,
      risk: m.risk || 'READ',
      description: m.description,
      parameters,
    });
  }

  return enriched;
}

async function executeAnyJarvisTool(toolName, args = {}) {
  const cleanName = String(toolName || '').trim();
  const safeArgs = args && typeof args === 'object' ? args : {};

  if (cleanName === 'read_file' || cleanName === 'list_dir' || cleanName === 'write_file' || cleanName === 'open_url') {
    try {
      const out = await BUILTIN_TOOLS[cleanName](safeArgs);
      return { ok: true, tool: cleanName, result: out };
    } catch (e) {
      return { ok: false, tool: cleanName, error: String(e.message || e) };
    }
  }

  if (cleanName === 'run_command') {
    const cmdStr = String(safeArgs.command || '').trim();
    if (!cmdStr) return { ok: false, tool: cleanName, error: 'command_required' };

    if (DESTRUCTIVE_CMD_RE.test(cmdStr)) {
      const approved = await confirmRiskyExecution('Destructive Terminal Command Approval Required', cmdStr);
      if (!approved) return { ok: false, tool: cleanName, error: 'permission_denied_by_user' };
    }

    return await new Promise((resolve) => {
      BUILTIN_TOOLS.run_command(safeArgs, (res) => {
        resolve({ ok: !res.error, tool: cleanName, result: res });
      });
    });
  }

  const candidatePath = path.join(TOOLS_DIR, `${cleanName.replace(/\.js$/i, '')}.js`);
  if (fs.existsSync(candidatePath)) {
    try {
      delete require.cache[require.resolve(candidatePath)];
      const mod = require(candidatePath);
      if (!mod || typeof mod.execute !== 'function') {
        return { ok: false, tool: cleanName, error: 'invalid_modular_tool' };
      }
      const risk = String(mod.risk || 'READ').toUpperCase();
      if (risk === 'RISKY') {
        const approved = await confirmRiskyExecution(
          `JARVIS Tool Approval Required: ${cleanName}`,
          `Risk: RISKY\nDescription: ${mod.description || ''}\nArgs: ${JSON.stringify(safeArgs)}`
        );
        if (!approved) return { ok: false, tool: cleanName, error: 'permission_denied_by_user' };
      }
      const res = await mod.execute(safeArgs, _ctx);
      return { ok: true, tool: cleanName, result: res };
    } catch (e) {
      return { ok: false, tool: cleanName, error: String(e.message || e) };
    }
  }

  return { ok: false, tool: cleanName, error: `unknown_tool: ${cleanName}` };
}

// ---------------------------------------------------------------------------
// 6. JSON PARSER & IPC-DRIVEN EXECUTION ORCHESTRATOR
// ---------------------------------------------------------------------------
function extractAgentJsonCommand(responseText) {
  const text = String(responseText || '').trim();
  if (!text) return null;

  const fenceMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const m of fenceMatches) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') {
        return parsed;
      }
    } catch (_) {}
  }

  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') {
        return parsed;
      }
    } catch (_) {}
  }

  const idx = text.indexOf('"action"');
  if (idx !== -1) {
    const start = text.lastIndexOf('{', idx);
    if (start !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const candidate = text.slice(start, i + 1);
              try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') {
                  return parsed;
                }
              } catch (_) {}
              break;
            }
          }
        }
      }
    }
  }

  return null;
}

function formatExecutedToolSummary(toolName, execResult) {
  if (!execResult.ok) {
    return `❌ **Tool Error (\`${toolName}\`):** ${execResult.error || 'Execution failed'}`;
  }
  const r = execResult.result;
  let body = '';
  if (typeof r === 'string') {
    body = r;
  } else if (r && typeof r === 'object') {
    if (r.command && !r.stdout && !r.stderr) {
      body = `✅ Executed command: \`${r.command}\``;
    } else if (r.stdout || r.stderr) {
      body = [
        r.command ? `Command: \`${r.command}\`` : '',
        r.stdout ? `\`\`\`\n${String(r.stdout).trim()}\n\`\`\`` : '',
        r.stderr ? `Stderr:\n\`\`\`\n${String(r.stderr).trim()}\n\`\`\`` : '',
      ]
        .filter(Boolean)
        .join('\n');
    } else {
      body = `\`\`\`json\n${JSON.stringify(r, null, 2).slice(0, 3000)}\n\`\`\``;
    }
  }
  return `⚡ **[Purchased AI · Tool Executed: \`${toolName}\`]**\n\n${body || '✅ Done.'}`;
}

async function processAgentJsonCommand(cmd, step, maxSteps, originalUserPrompt) {
  const rawAction = String(cmd.action || '').trim();
  const action = rawAction.toLowerCase();

  if (action === 'final' || action === 'done' || action === 'answer') {
    return {
      continueLoop: false,
      reply: `⚡ **[Purchased AI · Task Completed]**\n\n${cmd.answer || cmd.result || cmd.message || 'Done.'}`,
    };
  }

  if (action === 'ask_user' || action === 'confirm' || action === 'choice') {
    const question = String(
      cmd.question || cmd.message || (cmd.payload && cmd.payload.question) || 'আপনার সিদ্ধান্ত প্রয়োজন:'
    ).trim();
    const choices = Array.isArray(cmd.choices || cmd.options || (cmd.payload && cmd.payload.choices))
      ? cmd.choices || cmd.options || cmd.payload.choices
      : [];
    _pendingUserDecision = { ts: Date.now(), question, choices };

    broadcastToUI('k12:user-choice', { question, choices });

    const choicesText =
      choices.length > 0
        ? `\n\n**অপশনসমূহ (যেকোনো একটি টাইপ করুন বা নিচের বাটনে ক্লিক করুন):**\n` +
          choices.map((c, i) => `  ${i + 1}. \`${c}\``).join('\n')
        : '';

    return {
      continueLoop: false,
      reply: `🤔 **[Purchased AI আপনার সিদ্ধান্ত জানতে চাচ্ছে]**\n\n${question}${choicesText}`,
    };
  }

  if (action === 'request_tools' || action === 'need_tools' || action === 'search_tools' || action === 'get_tools') {
    const query = String(
      cmd.query || cmd.keywords || (cmd.payload && (cmd.payload.query || cmd.payload.keywords)) || originalUserPrompt
    ).trim();
    const matchedTools = searchLibraryToolsOnDemand(query, 3);
    audit('info', 'on_demand_tools_delivered', { query, matched: matchedTools.map((t) => t.name) });

    const nextPrompt = [
      `[JARVIS LIBRARIAN — Matched Tools for "${query}"]`,
      matchedTools.length > 0
        ? JSON.stringify(matchedTools, null, 2)
        : `No custom tools matched. Built-in tools available: run_command, list_dir, read_file, write_file, open_url.`,
      `Reply with ONLY the JSON command to execute the tool, e.g. {"action":"<tool_name>","payload":{...}}`,
    ].join('\n');

    return { continueLoop: true, nextPrompt };
  }

  const targetToolName =
    action === 'call_tool' || action === 'run_tool' || action === 'execute'
      ? String(cmd.tool || cmd.name || (cmd.payload && cmd.payload.tool) || '').trim()
      : rawAction;

  const targetToolArgs =
    action === 'call_tool' || action === 'run_tool' || action === 'execute'
      ? cmd.args || (cmd.payload && cmd.payload.args) || cmd.payload || cmd.parameters || {}
      : cmd.payload || cmd.args || cmd.parameters || {};

  audit('info', 'agent_loop_tool_call', { step, tool: targetToolName });
  broadcastToUI('k12:step-progress', { step, tool: targetToolName });

  const execResult = await executeAnyJarvisTool(targetToolName, targetToolArgs);

  if ((cmd.continue === true || cmd.next_step === true) && step < maxSteps) {
    const nextPrompt = [
      `[JARVIS TOOL RESULT — Step ${step}/${maxSteps} for "${targetToolName}"]`,
      JSON.stringify(execResult).slice(0, 10000),
      `Output the next JSON command if more steps are needed, or write the final answer.`,
    ].join('\n');
    return { continueLoop: true, nextPrompt };
  }

  return {
    continueLoop: false,
    reply: formatExecutedToolSummary(targetToolName, execResult),
  };
}

function installPreloadIpcListeners() {
  if (_ipcListenersInstalled) return;
  _ipcListenersInstalled = true;

  ipcMain.on('k12:preload-ready', (_event, payload) => {
    broadcastToUI('agent:connected', { message: `AI Ready: ${(payload && payload.url) || ''}` });
  });

  ipcMain.on('k12:inject-status', (event, payload) => {
    if (payload && payload.needNativeEnter && event.sender && !event.sender.isDestroyed()) {
      try {
        event.sender.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        event.sender.sendInputEvent({ type: 'char', keyCode: '\r' });
        event.sender.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      } catch (_) {}
    }
  });

  const handleDetectedAiOutput = async (rawCodeText, rawMsgText) => {
    const primaryText =
      rawCodeText && rawCodeText.includes('"action"') ? rawCodeText : rawMsgText || rawCodeText || '';
    if (!primaryText) return;

    // 1. If a JARVIS Chat Box request is waiting for the response, resolve it immediately!
    if (_pendingPromptWaiter) {
      const waiter = _pendingPromptWaiter;
      _pendingPromptWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(primaryText);
      return;
    }

    // 2. Otherwise, the user typed directly inside the Gemini window!
    //    If Tool Bridge (⚡ Tool Call: ON) is enabled and the output contains a JSON command, execute it automatically!
    const cfg = loadK12Settings();
    if (!cfg.toolBridgeEnabled) return;

    const cmd = extractAgentJsonCommand(primaryText);
    if (!cmd) return;

    const sig = `auto:${fastSignature(primaryText)}`;
    if (_executedJsonSignatures.has(sig)) return;
    _executedJsonSignatures.add(sig);

    audit('info', 'direct_gemini_json_auto_executed', { action: cmd.action });
    const outcome = await processAgentJsonCommand(cmd, 1, 1, primaryText);
    if (outcome && outcome.reply) {
      sendChatNoticeToUI(outcome.reply);
    }
  };

  ipcMain.on('k12:ai-output-ready', (_event, payload) => {
    if (!payload) return;
    handleDetectedAiOutput(payload.codeText, payload.msgText).catch(() => {});
  });

  // Also hook Kernel 10's jarvis:k10-tab-response so Kernel-10 Browser/Split tabs auto-execute JSON in Tool Mode!
  ipcMain.on('jarvis:k10-tab-response', (_event, payload) => {
    if (!payload || !payload.responseText) return;
    handleDetectedAiOutput('', String(payload.responseText)).catch(() => {});
  });

  // Hook [⚡ Send to Jarvis] / [⚡ Apply] pill clicks
  ipcMain.on('jarvis:k10-pill-click', async (_event, payload) => {
    try {
      if (!payload || !payload.content) return;
      const cmd = extractAgentJsonCommand(String(payload.content));
      if (cmd) {
        const res = await processAgentJsonCommand(cmd, 1, 1, String(payload.content));
        if (res && res.reply) {
          sendChatNoticeToUI(res.reply);
        }
      }
    } catch (_) {}
  });
}

async function sendPromptToPurchasedAiAndWait(promptText, timeoutMs = 60000) {
  const cfg = loadK12Settings();
  const wc = await ensurePurchasedAiWindow({ url: cfg.activeUrl, show: false });
  if (!wc || wc.isDestroyed()) {
    throw new Error('Purchased AI window is not available.');
  }

  if (wc.isLoadingMainFrame()) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      wc.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 800));
  }

  const requestId = 'k12req_' + Date.now();
  const textToSend = String(promptText || '').trim();

  return await new Promise((resolve, reject) => {
    if (_pendingPromptWaiter && _pendingPromptWaiter.timer) {
      clearTimeout(_pendingPromptWaiter.timer);
    }

    const timer = setTimeout(() => {
      _pendingPromptWaiter = null;
      reject(
        new Error(
          'পেইড AI উইন্ডো থেকে এখনো উত্তর আসেনি। একবার 🔑 AI Window বাটনে ক্লিক করে দেখুন আপনার Gem বা চ্যাট পেজ ওপেন আছে কিনা (চাইলে সরাসরি ওই উইন্ডোতেও লিখতে পারেন—জার্ভিস অটোমেটিক কমান্ড রান করবে!)'
        )
      );
    }, timeoutMs);

    _pendingPromptWaiter = { resolve, reject, timer };
    wc.send('k12:inject-prompt', { requestId, text: textToSend });
  });
}

async function handlePurchasedAiPrompt(rawUserPrompt) {
  const cfg = loadK12Settings();
  const cleanPrompt = String(rawUserPrompt || '').trim();

  const directJsonCmd = extractAgentJsonCommand(cleanPrompt);
  if (directJsonCmd) {
    const res = await processAgentJsonCommand(directJsonCmd, 1, 1, cleanPrompt);
    return res.reply || '✅ Direct JSON executed.';
  }

  let isResumingDecision = false;
  if (_pendingUserDecision) {
    isResumingDecision = true;
    _pendingUserDecision = null;
  }

  if (!cfg.toolBridgeEnabled && !isResumingDecision) {
    const reply = await sendPromptToPurchasedAiAndWait(cleanPrompt, cfg.responseTimeoutMs);
    return `🌐 **[Purchased AI · Chat/Gem Mode]**\n\n${reply}`;
  }

  const isCustomGemOrProject = /\/(?:gem|g|project)\//i.test(String(cfg.activeUrl || ''));
  const maxSteps = Number(cfg.maxToolSteps) || 6;

  let nextPromptToSend;
  if (isResumingDecision) {
    nextPromptToSend = `User Decision: "${cleanPrompt}". Now output the JSON command to complete the task.`;
  } else if (isCustomGemOrProject) {
    nextPromptToSend = cleanPrompt;
  } else {
    nextPromptToSend = `${cleanPrompt}\n\n[JARVIS Bridge: If this requires a PC action, reply ONLY with JSON: {"action":"run_command"|"list_dir"|"read_file"|"write_file"|"open_url"|"request_tools"|"ask_user", "payload":{...}}]`;
  }

  for (let step = 1; step <= maxSteps; step++) {
    const aiReply = await sendPromptToPurchasedAiAndWait(nextPromptToSend, cfg.responseTimeoutMs);
    const cmd = extractAgentJsonCommand(aiReply);

    if (!cmd) {
      return `⚡ **[Purchased AI]**\n\n${aiReply}`;
    }

    const sig = `auto:${fastSignature(aiReply)}`;
    _executedJsonSignatures.add(sig);

    const outcome = await processAgentJsonCommand(cmd, step, maxSteps, cleanPrompt);
    if (!outcome.continueLoop) {
      return outcome.reply;
    }
    nextPromptToSend = outcome.nextPrompt;
  }

  return `⚠️ **[Purchased AI]** সর্বোচ্চ ${maxSteps}টি স্টেপ সম্পন্ন হয়েছে।`;
}

// ---------------------------------------------------------------------------
// 7. RENDERER UI INJECTION (DROPDOWN, SETTINGS LINK BOX, SMART TOGGLE ICON)
// ---------------------------------------------------------------------------
function __K12_RENDERER_INJECTOR__() {
  'use strict';
  if (window.__JARVIS_K12_UI_INSTALLED__) return;
  window.__JARVIS_K12_UI_INSTALLED__ = true;

  let k12State = window.__JARVIS_K12_INITIAL_STATE__ || {
    activeUrl: 'https://gemini.google.com/app',
    preset: 'gemini',
    toolBridgeEnabled: true,
    presets: {
      gemini: 'https://gemini.google.com/app',
      claude: 'https://claude.ai/new',
      chatgpt: 'https://chatgpt.com/',
      deepseek: 'https://chat.deepseek.com/',
    },
  };

  function sendK12Cmd(action, payload) {
    try {
      if (window.jarvis && typeof window.jarvis.askAI === 'function') {
        window.jarvis.askAI({
          prompt: '__K12__' + JSON.stringify({ action, payload: payload || {} }),
          mode: 'chat',
        });
      }
    } catch (_) {}
  }

  function injectStyles() {
    if (document.getElementById('k12-purchased-ai-styles')) return;
    const style = document.createElement('style');
    style.id = 'k12-purchased-ai-styles';
    style.textContent = [
      '.k12-bridge-controls { display: none; align-items: center; gap: 6px; margin-left: 4px; }',
      '.k12-bridge-controls.visible { display: inline-flex; }',
      '.k12-toggle-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid var(--border, rgba(255,255,255,0.12)); background: rgba(17, 24, 39, 0.75); color: var(--muted, #9CA3AF); transition: all 0.2s ease; font-family: inherit; }',
      '.k12-toggle-btn:hover { border-color: var(--accent, #06B6D4); color: var(--text, #F3F4F6); }',
      '.k12-toggle-btn.active { background: rgba(16, 185, 129, 0.16); border-color: #10B981; color: #34D399; box-shadow: 0 0 10px rgba(16, 185, 129, 0.25); }',
      '.k12-login-btn { padding: 6px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid rgba(6, 182, 212, 0.4); background: rgba(6, 182, 212, 0.1); color: var(--accent, #06B6D4); transition: all 0.2s ease; font-family: inherit; }',
      '.k12-login-btn:hover { background: var(--accent, #06B6D4); color: #fff; }',
      '.k12-choice-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; padding: 8px 12px; background: rgba(6, 182, 212, 0.08); border: 1px solid rgba(6, 182, 212, 0.3); border-radius: 8px; }',
      '.k12-choice-chip { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent, #06B6D4); background: var(--surface, #111827); color: var(--text, #F3F4F6); font-size: 12px; font-weight: 600; cursor: pointer; }',
      '.k12-choice-chip:hover { background: var(--accent, #06B6D4); color: #fff; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  function injectChatToolbarControls() {
    const select = document.getElementById('ai-model');
    if (!select) return;

    if (!select.querySelector('option[value="purchased_ai"]')) {
      const opt = document.createElement('option');
      opt.value = 'purchased_ai';
      opt.textContent = '🌐 Purchased AI (Custom Link)';
      select.appendChild(opt);

      const savedProvider = localStorage.getItem('jarvis-selected-ai-model');
      if (savedProvider === 'purchased_ai') {
        select.value = 'purchased_ai';
      }
    }

    const chatTools = document.querySelector('.chat-tools');
    if (chatTools && !document.getElementById('k12-bridge-controls')) {
      const wrap = document.createElement('div');
      wrap.id = 'k12-bridge-controls';
      wrap.className = 'k12-bridge-controls';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.id = 'k12-tool-toggle-btn';
      toggleBtn.className = 'k12-toggle-btn';
      toggleBtn.onclick = () => {
        k12State.toolBridgeEnabled = !k12State.toolBridgeEnabled;
        updateToolbarState();
        sendK12Cmd('toggle_tool_bridge', { enabled: k12State.toolBridgeEnabled });
      };

      const loginBtn = document.createElement('button');
      loginBtn.type = 'button';
      loginBtn.id = 'k12-open-ai-win-btn';
      loginBtn.className = 'k12-login-btn';
      loginBtn.textContent = '🔑 AI Window / Login';
      loginBtn.title = 'Open Purchased AI Window to Login once or chat directly in your Gem';
      loginBtn.onclick = () => {
        sendK12Cmd('open_login_window', { url: k12State.activeUrl });
      };

      wrap.appendChild(toggleBtn);
      wrap.appendChild(loginBtn);
      chatTools.appendChild(wrap);

      select.addEventListener('change', () => {
        localStorage.setItem('jarvis-selected-ai-model', select.value);
        updateToolbarState();
      });

      document.querySelectorAll('.exec-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => setTimeout(updateToolbarState, 30));
      });
    }

    updateToolbarState();
  }

  function updateToolbarState() {
    const select = document.getElementById('ai-model');
    const wrap = document.getElementById('k12-bridge-controls');
    const toggleBtn = document.getElementById('k12-tool-toggle-btn');
    if (!select || !wrap || !toggleBtn) return;

    const isPurchasedSelected = select.value === 'purchased_ai';
    const activeModeBtn = document.querySelector('.exec-mode-btn.active');
    const currentExecMode = activeModeBtn ? activeModeBtn.getAttribute('data-exec-mode') : 'chat';

    if (isPurchasedSelected || currentExecMode === 'task') {
      wrap.classList.add('visible');
    } else {
      wrap.classList.remove('visible');
    }

    if (k12State.toolBridgeEnabled) {
      toggleBtn.classList.add('active');
      toggleBtn.textContent = '⚡ Tool Call: ON (JSON Bridge)';
      toggleBtn.title = 'Click to turn OFF tool calling and chat normally / set up your Gem';
    } else {
      toggleBtn.classList.remove('active');
      toggleBtn.textContent = '💬 Gem/Chat Mode (Tools: OFF)';
      toggleBtn.title = 'Currently in normal chat & Gem setup mode. Click to ENABLE direct JSON tool calls!';
    }
  }

  function injectSettingsModalSection() {
    const settingsModal = document.getElementById('settings-modal');
    if (!settingsModal || document.getElementById('k12-settings-section')) return;

    const modalContent = settingsModal.querySelector('.modal-content');
    const modalActions = settingsModal.querySelector('.modal-actions');
    if (!modalContent) return;

    const section = document.createElement('div');
    section.id = 'k12-settings-section';
    section.innerHTML = [
      '<h2>🌐 Purchased Web AI Link (Claude / ChatGPT / Gemini / Custom Gem)</h2>',
      '<div class="row-group">',
      '  <div>',
      '    <label>Quick Platform Preset</label>',
      '    <select id="k12-preset-select" class="settings-select">',
      '      <option value="gemini">Google Gemini Advanced (gemini.google.com)</option>',
      '      <option value="claude">Claude Pro / Max (claude.ai)</option>',
      '      <option value="chatgpt">ChatGPT Plus / Pro (chatgpt.com)</option>',
      '      <option value="deepseek">DeepSeek Web (chat.deepseek.com)</option>',
      '      <option value="custom">Custom Gem / Project / Purchased AI Link</option>',
      '    </select>',
      '  </div>',
      '  <div style="display: flex; align-items: flex-end; gap: 6px;">',
      '    <button type="button" id="k12-settings-login-btn" class="btn-refresh" style="margin: 0; flex: 1;">🔑 In-App Login</button>',
      '    <button type="button" id="k12-settings-ext-browser-btn" class="btn-refresh" style="margin: 0; flex: 1;" title="Opens in your real Edge/Chrome with Auto-Bridge Extension (Zero F12)">🌐 Edge/Chrome</button>',
      '  </div>',
      '</div>',
      '<label>Purchased AI / Custom Gem Link (URL)</label>',
      '<input type="text" id="k12-purchased-url-input" placeholder="https://gemini.google.com/gem/... or https://claude.ai/..." />',
      '<div class="help-text">',
      '  💡 When <b>⚡ Tool Call: ON</b> is active, any JSON command generated inside your Gemini/Claude/ChatGPT window executes on your PC automatically via Preload IPC!',
      '</div>',
    ].join('\n');

    if (modalActions) {
      modalContent.insertBefore(section, modalActions);
    } else {
      modalContent.appendChild(section);
    }

    const presetSelect = document.getElementById('k12-preset-select');
    const urlInput = document.getElementById('k12-purchased-url-input');
    const loginBtn = document.getElementById('k12-settings-login-btn');
    const extBrowserBtn = document.getElementById('k12-settings-ext-browser-btn');

    if (urlInput) urlInput.value = k12State.activeUrl || 'https://gemini.google.com/app';
    if (presetSelect) presetSelect.value = k12State.preset || 'gemini';

    if (presetSelect && urlInput) {
      presetSelect.addEventListener('change', () => {
        const val = presetSelect.value;
        if (val !== 'custom' && k12State.presets && k12State.presets[val]) {
          urlInput.value = k12State.presets[val];
        }
      });
    }

    if (loginBtn && urlInput) {
      loginBtn.addEventListener('click', () => {
        const url = urlInput.value.trim() || 'https://gemini.google.com/app';
        const preset = presetSelect ? presetSelect.value : 'custom';
        k12State.activeUrl = url;
        k12State.preset = preset;
        sendK12Cmd('save_and_open_login', { activeUrl: url, preset });
      });
    }

    if (extBrowserBtn && urlInput) {
      extBrowserBtn.addEventListener('click', () => {
        const url = urlInput.value.trim() || 'https://gemini.google.com/app';
        const preset = presetSelect ? presetSelect.value : 'custom';
        k12State.activeUrl = url;
        k12State.preset = preset;
        sendK12Cmd('open_external_browser_bridge', { activeUrl: url, preset });
      });
    }

    const saveBtn = document.getElementById('btn-save-settings');
    if (saveBtn && !saveBtn.__k12Hooked) {
      saveBtn.__k12Hooked = true;
      saveBtn.addEventListener('click', () => {
        if (!urlInput) return;
        const url = urlInput.value.trim() || 'https://gemini.google.com/app';
        const preset = presetSelect ? presetSelect.value : 'custom';
        k12State.activeUrl = url;
        k12State.preset = preset;
        sendK12Cmd('save_settings', { activeUrl: url, preset });
      });
    }
  }

  window.addEventListener('j10ws-agent-event', (e) => {
    const detail = (e && e.detail) || {};
    const ev = detail.event;
    const data = detail.data || {};

    if (ev === 'k12:state-sync') {
      k12State = Object.assign({}, k12State, data);
      const urlInput = document.getElementById('k12-purchased-url-input');
      const presetSelect = document.getElementById('k12-preset-select');
      if (urlInput) urlInput.value = k12State.activeUrl || '';
      if (presetSelect && k12State.preset) presetSelect.value = k12State.preset;
      updateToolbarState();
    }

    if (ev === 'k12:step-progress') {
      const loader = document.getElementById('ai-loading');
      if (loader) {
        loader.textContent = '⚡ [Step ' + data.step + '] Executing tool: ' + data.tool + '...';
      }
    }

    if (ev === 'k12:user-choice' && Array.isArray(data.choices) && data.choices.length > 0) {
      setTimeout(() => {
        const chatMessages = document.getElementById('chat-messages');
        if (!chatMessages) return;
        const bar = document.createElement('div');
        bar.className = 'k12-choice-bar';
        data.choices.forEach((choiceText) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'k12-choice-chip';
          btn.textContent = choiceText;
          btn.onclick = () => {
            bar.remove();
            const aiInput = document.getElementById('ai-input');
            const sendBtn = document.getElementById('btn-send-ai');
            if (aiInput && sendBtn) {
              aiInput.value = choiceText;
              sendBtn.click();
            }
          };
          bar.appendChild(btn);
        });
        chatMessages.appendChild(bar);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }, 150);
    }
  });

  function boot() {
    injectStyles();
    injectChatToolbarControls();
    injectSettingsModalSection();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

function injectK12UiIntoMainWindow() {
  if (_uiInjectedOnce) return true;
  const mainWin = getMainWindow();
  if (!mainWin || mainWin.isDestroyed()) return false;

  mainWin.webContents.setMaxListeners(50);

  const cfg = loadK12Settings();
  const script = `
    window.__JARVIS_K12_INITIAL_STATE__ = ${JSON.stringify(cfg)};
    (${__K12_RENDERER_INJECTOR__.toString()})();
  `;

  const doInject = () => {
    if (mainWin.isDestroyed()) return;
    _uiInjectedOnce = true;
    mainWin.webContents.executeJavaScript(script).catch(() => {});
    broadcastToUI('agent:connected', { message: 'JARVIS Purchased AI Bridge Ready' });
  };

  if (mainWin.webContents.isLoadingMainFrame()) {
    mainWin.webContents.once('did-finish-load', doInject);
  } else {
    doInject();
  }
  return true;
}

// ---------------------------------------------------------------------------
// 8. IPC PIPELINE INTERCEPTOR FOR PURCHASED AI & __K12__ COMMANDS
// ---------------------------------------------------------------------------
function installK12PromptInterceptor() {
  const listeners = ipcMain.listeners('jarvis:ai-prompt');
  if (listeners.length === 0) return false;

  if (listeners[0] && listeners[0].__isK12Wrapper) return true;

  const downstream = listeners[0];
  ipcMain.removeAllListeners('jarvis:ai-prompt');

  const k12Wrapper = async (event, data) => {
    try {
      const rawPrompt = typeof data?.prompt === 'string' ? data.prompt : '';

      if (rawPrompt.startsWith('__K10__') || rawPrompt.startsWith('__K11__') || data?._k10) {
        return downstream(event, data);
      }

      if (rawPrompt.startsWith(COMMAND_TAG)) {
        let parsed = null;
        try {
          parsed = JSON.parse(rawPrompt.slice(COMMAND_TAG.length));
        } catch (_) {}
        if (parsed && parsed.action) {
          const act = parsed.action;
          const payload = parsed.payload || {};

          if (act === 'toggle_tool_bridge') {
            const updated = saveK12Settings({ toolBridgeEnabled: Boolean(payload.enabled) });
            broadcastToUI('k12:state-sync', updated);
            const statusMsg = updated.toolBridgeEnabled
              ? '⚡ **Purchased AI Tool Bridge: ON** — এখন জার্ভিস চ্যাট অথবা সরাসরি Gemini উইন্ডোতে যেকোনো JSON কমান্ড জেনারেট হলেই তা স্বয়ংক্রিয়ভাবে পিসিতে এক্সিকিউট হবে!'
              : '💬 **Purchased AI Tool Bridge: OFF** — এখন সাধারণ চ্যাট ও Gem সেটআপ মোডে আছেন (কোনো JSON টুল কল যাবে না)।';
            sendChatNoticeToUI(statusMsg);
            return;
          }

          if (act === 'save_settings') {
            const updated = saveK12Settings({
              activeUrl: String(payload.activeUrl || '').trim() || DEFAULT_K12_SETTINGS.activeUrl,
              preset: String(payload.preset || 'custom'),
            });
            broadcastToUI('k12:state-sync', updated);
            return;
          }

          if (act === 'open_login_window' || act === 'save_and_open_login') {
            if (payload.activeUrl) {
              saveK12Settings({
                activeUrl: String(payload.activeUrl).trim(),
                preset: String(payload.preset || 'custom'),
              });
            }
            const cfg = loadK12Settings();
            await ensurePurchasedAiWindow({ url: cfg.activeUrl, show: true, forceNavigate: Boolean(payload.activeUrl) });
            sendChatNoticeToUI(
              `🔑 **Purchased AI Window Opened:** \`${cfg.activeUrl}\`\nএখানে আপনি সরাসরি আপনার Gem-এ কমান্ড লিখতে পারেন কিংবা জার্ভিসের চ্যাটবক্সে লিখতে পারেন—জার্ভিস সাথে সাথে টুল রান করবে!`
            );
            return;
          }

          if (act === 'open_external_browser_bridge') {
            if (payload.activeUrl) {
              saveK12Settings({
                activeUrl: String(payload.activeUrl).trim(),
                preset: String(payload.preset || 'custom'),
              });
            }
            const cfg = loadK12Settings();
            launchExternalBrowserWithExtension(cfg.activeUrl);
            sendChatNoticeToUI(
              `🌐 **Real Edge/Chrome Launched with CSP-Free Auto-Bridge:** \`${cfg.activeUrl}\`\nএখন Edge/Chrome-এর Gemini-তে কোনো JSON কমান্ড আসামাত্রই জার্ভিস সেটি অটোমেটিক রান করবে!`
            );
            return;
          }
        }
        return;
      }

      if (data && data.model === 'purchased_ai') {
        let cleanUserPrompt = rawPrompt;
        const uqIdx = rawPrompt.lastIndexOf('User Query:');
        if (uqIdx !== -1) {
          cleanUserPrompt = rawPrompt.slice(uqIdx + 'User Query:'.length).trim();
        }

        try {
          const replyText = await handlePurchasedAiPrompt(cleanUserPrompt);
          if (!event.sender.isDestroyed()) {
            event.sender.send('jarvis:ai-response', { text: replyText });
          }
        } catch (err) {
          if (!event.sender.isDestroyed()) {
            event.sender.send('jarvis:ai-response', {
              text: `❌ **Purchased AI Error:** ${String(err.message || err)}`,
            });
          }
        }
        return;
      }

      return downstream(event, data);
    } catch (e) {
      audit('error', 'k12_interceptor_error', { error: String(e.message || e) });
      return downstream(event, data);
    }
  };

  k12Wrapper.__isK12Wrapper = true;
  ipcMain.on('jarvis:ai-prompt', k12Wrapper);
  return true;
}

// ---------------------------------------------------------------------------
// 9. PORT 8080 HTTP + WEBSOCKET SERVER
// ---------------------------------------------------------------------------
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>JARVIS K12 :: Agent Command Center</title>
  <style>
    body { background: #0f1115; color: #e5e7eb; font-family: 'Segoe UI', monospace; margin: 0; padding: 20px; display: flex; flex-direction: column; height: 95vh; box-sizing: border-box; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2b2f36; padding-bottom: 12px; margin-bottom: 15px; }
    .badge { padding: 5px 12px; border-radius: 99px; font-size: 12px; font-weight: bold; background: #dc2626; color: #fff; }
    .badge.online { background: #16a34a; }
    .Layout { display: grid; grid-template-columns: 320px 1fr; gap: 16px; flex: 1; min-height: 0; }
    .panel { background: #181b20; border: 1px solid #2b2f36; border-radius: 8px; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
    h3 { margin: 0 0 8px 0; font-size: 13px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; }
    button { background: #252932; color: #e5e7eb; border: 1px solid #374151; padding: 9px 12px; border-radius: 6px; cursor: pointer; font-weight: 600; text-align: left; transition: 0.15s; }
    button:hover { background: #6366f1; border-color: #818cf8; color: #fff; }
    input, textarea { background: #0a0c10; color: #10b981; border: 1px solid #2b2f36; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 12.5px; outline: none; }
    input:focus, textarea:focus { border-color: #6366f1; }
    #log { flex: 1; overflow-y: auto; background: #090b0e; padding: 14px; border-radius: 6px; border: 1px solid #22262e; font-size: 12.5px; white-space: pre-wrap; line-height: 1.5; }
    .tx { color: #60a5fa; } .rx { color: #34d399; } .err { color: #f87171; }
  </style>
</head>
<body>
  <div class="header">
    <div><strong>⚡ JARVIS-CORE :: KERNEL 12 AGENT BRIDGE (v5.0 Preload-IPC)</strong></div>
    <div id="status" class="badge">DISCONNECTED</div>
  </div>
  <div class="Layout">
    <div class="panel">
      <h3>Quick Actions</h3>
      <button onclick="sendAction('get_tools', {})">🛠️ Get Registered Tools</button>
      <button onclick="sendAction('request_tools', {query: 'system health battery'})">🔍 Test Librarian On-Demand</button>
      <button onclick="sendAction('list_dir', {path: '00_ENGINE'})">📂 List 00_ENGINE Files</button>
      <button onclick="sendAction('read_file', {path: '00_ENGINE/extensions.json'})">📄 Read extensions.json</button>
      <button onclick="sendAction('run_command', {command: 'start https://youtube.com'})">▶️ Open YouTube</button>
      
      <h3 style="margin-top:10px;">Direct Terminal Command</h3>
      <input id="cmdInput" placeholder="e.g. dir, ipconfig, start notepad" onkeydown="if(event.key==='Enter') runTerminal()" />
      <button onclick="runTerminal()" style="text-align:center; background:#4f46e5; border-color:#6366f1;">🚀 Execute Command</button>

      <h3 style="margin-top:10px;">Raw JSON Payload</h3>
      <textarea id="rawJson" rows="5">{"action":"list_dir","payload":{"path":"."}}</textarea>
      <button onclick="sendRaw()" style="text-align:center;">⚡ Send Raw JSON</button>
    </div>
    <div class="panel">
      <h3>Live Telemetry & Output Stream</h3>
      <div id="log"></div>
    </div>
  </div>
  <script>
    let ws;
    const logEl = document.getElementById('log');
    const statusEl = document.getElementById('status');

    function log(msg, cls = '') {
      const div = document.createElement('div');
      div.className = cls;
      div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function connect() {
      const wsUrl = 'ws://' + (location.host || '127.0.0.1:8080');
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        statusEl.textContent = 'CONNECTED (' + wsUrl + ')';
        statusEl.className = 'badge online';
        log('Connected to JARVIS Kernel 12 Bridge!', 'rx');
      };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          log('JARVIS RESPONSE:\\n' + JSON.stringify(data, null, 2), data.status === 'error' ? 'err' : 'rx');
        } catch (_) { log('RAW: ' + e.data, 'rx'); }
      };
      ws.onclose = () => {
        statusEl.textContent = 'DISCONNECTED - RETRYING...';
        statusEl.className = 'badge';
        setTimeout(connect, 2000);
      };
    }

    function sendAction(action, payload) {
      const msg = JSON.stringify({ action, payload });
      log('SENT: ' + msg, 'tx');
      ws.send(msg);
    }

    function runTerminal() {
      const cmd = document.getElementById('cmdInput').value.trim();
      if (cmd) sendAction('run_command', { command: cmd });
    }

    function sendRaw() {
      try {
        const raw = document.getElementById('rawJson').value.trim();
        JSON.parse(raw);
        log('SENT: ' + raw, 'tx');
        ws.send(raw);
      } catch (e) { log('Invalid JSON: ' + e.message, 'err'); }
    }

    connect();
  </script>
</body>
</html>`;

function sendWsMessage(socket, data) {
  if (!socket || socket.destroyed || !socket.writable) return;
  try {
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  } catch (_) {}
}

async function handleIncomingWsMessage(rawMsg, socket) {
  let parsed;
  try {
    parsed = JSON.parse(rawMsg);
  } catch (_) {
    return sendWsMessage(socket, { status: 'error', message: 'Invalid JSON format' });
  }

  const { action, payload } = parsed;
  if (!action) return sendWsMessage(socket, { status: 'error', message: 'Missing action' });

  audit('info', 'bridge_command_received', { action });

  try {
    if (action === 'get_tools') {
      return sendWsMessage(socket, {
        status: 'success',
        tools: ['read_file', 'write_file', 'list_dir', 'run_command', 'open_url', 'request_tools', 'call_tool'],
      });
    }

    if (action === 'request_tools') {
      const tools = searchLibraryToolsOnDemand((payload && payload.query) || '', 3);
      return sendWsMessage(socket, { status: 'success', result: tools });
    }

    if (action === 'call_tool') {
      const toolName = (payload && (payload.tool || payload.name)) || '';
      const toolArgs = (payload && (payload.args || payload.parameters)) || {};
      const res = await executeAnyJarvisTool(toolName, toolArgs);
      return sendWsMessage(socket, { status: res.ok ? 'success' : 'error', result: res });
    }

    if (action === 'run_command') {
      BUILTIN_TOOLS.run_command(payload || {}, (result) => {
        sendWsMessage(socket, { status: result.error ? 'error' : 'success', result });
      });
      return;
    }

    if (BUILTIN_TOOLS[action]) {
      const result = await BUILTIN_TOOLS[action](payload || {});
      return sendWsMessage(socket, { status: 'success', result });
    }

    const modRes = await executeAnyJarvisTool(action, payload || {});
    if (modRes.ok) {
      return sendWsMessage(socket, { status: 'success', result: modRes.result });
    }

    return sendWsMessage(socket, { status: 'error', message: `Unknown action: ${action}` });
  } catch (err) {
    sendWsMessage(socket, { status: 'error', message: String(err.message || err) });
  }
}

function createWebSocketServer(onMessage) {
  const server = http.createServer((req, res) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    if (req.method === 'POST' && req.url === '/api/auto-json') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const cfg = loadK12Settings();
          if (!cfg.toolBridgeEnabled) {
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, reason: 'tool_bridge_off' }));
          }
          const rawText = String(body.rawText || '').trim();
          const sig = `ext:${fastSignature(rawText)}`;
          if (rawText && !_executedJsonSignatures.has(sig)) {
            const cmd = extractAgentJsonCommand(rawText);
            if (cmd) {
              _executedJsonSignatures.add(sig);
              const outcome = await processAgentJsonCommand(cmd, 1, 1, rawText);
              if (outcome && outcome.reply) {
                sendChatNoticeToUI(outcome.reply);
              }
              res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: true, executed: cmd.action }));
            }
          }
          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, skipped: true }));
        } catch (e) {
          res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      });
      return;
    }

    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(DASHBOARD_HTML);
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();

    const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n');

    socket.write(responseHeaders);
    socket.setNoDelay(true);
    _wsClients.add(socket);

    broadcastToUI('agent:connected', { message: 'External AI Brain Connected' });

    socket.on('error', (err) => audit('warn', 'socket_error', { error: err.message }));

    socket.on('close', () => {
      _wsClients.delete(socket);
      if (_wsClients.size === 0 && (!_purchasedAiWin || _purchasedAiWin.isDestroyed())) {
        broadcastToUI('agent:disconnected', { message: 'External AI Disconnected' });
      }
      audit('info', 'socket_closed', {});
    });

    socket.on('data', (buffer) => {
      try {
        let offset = 2;
        const firstByte = buffer[0];
        const secondByte = buffer[1];

        const opCode = firstByte & 0x0f;
        if (opCode === 0x08) return socket.end();
        if (opCode === 0x09) {
          socket.write(Buffer.from([0x8a, 0x00]));
          return;
        }

        const isMasked = (secondByte & 0x80) === 0x80;
        let payloadLength = secondByte & 0x7f;

        if (payloadLength === 126) {
          payloadLength = buffer.readUInt16BE(2);
          offset += 2;
        } else if (payloadLength === 127) {
          payloadLength = Number(buffer.readBigUInt64BE(2));
          offset += 8;
        }

        let mask = null;
        if (isMasked) {
          mask = buffer.slice(offset, offset + 4);
          offset += 4;
        }

        const payload = Buffer.from(buffer.slice(offset, offset + payloadLength));
        if (isMasked && mask) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }

        const message = payload.toString('utf8');
        if (message) onMessage(message, socket);
      } catch (err) {
        audit('warn', 'socket_parse_error', { error: err.message });
      }
    });
  });

  server.on('error', (err) => {
    audit('warn', 'bridge_server_error', { error: String(err.message || err) });
  });

  server.listen(PORT, '0.0.0.0', () => {
    audit('info', 'bridge_started', { port: PORT });
    console.log(`\n🔗 [JARVIS Agent Bridge] Control Panel: http://localhost:${PORT}`);
    console.log(`🔗 [JARVIS Agent Bridge] WebSocket URL: ws://127.0.0.1:${PORT}\n`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// 10. INITIALIZATION & LIFECYCLE
// ---------------------------------------------------------------------------
function init(ctx) {
  _ctx = ctx || null;
  _audit = ctx && typeof ctx.audit === 'function' ? ctx.audit.bind(ctx) : null;

  installSessionChromeStealth();
  ensurePreloadAndExtensionFiles();
  installPreloadIpcListeners();

  if (!_server) {
    _server = createWebSocketServer(handleIncomingWsMessage);
  }

  if (ctx && typeof ctx.registerService === 'function') {
    ctx.registerService('kernel12_agent_bridge', {
      getPort: () => PORT,
      getSettings: loadK12Settings,
      saveSettings: saveK12Settings,
      openLoginWindow: (url) => ensurePurchasedAiWindow({ url, show: true, forceNavigate: true }),
    });
  }

  if (ctx && typeof ctx.addStopHook === 'function') {
    ctx.addStopHook('kernel_12_agent_bridge', () => {
      _isQuitting = true;
      try {
        if (_purchasedAiWin && !_purchasedAiWin.isDestroyed()) _purchasedAiWin.destroy();
      } catch (_) {}
      try {
        if (_server) _server.close();
      } catch (_) {}
    });
  }

  const attachAll = () => {
    installK12PromptInterceptor();
    injectK12UiIntoMainWindow();
  };

  setTimeout(attachAll, 500);
  setTimeout(attachAll, 1800);
  setTimeout(attachAll, 3500);
}

if (require.main === module || process.type === 'browser') {
  init();
}

module.exports = {
  name: 'kernel_12_agent_bridge',
  version: '5.0.0',
  init,
};