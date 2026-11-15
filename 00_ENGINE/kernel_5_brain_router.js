'use strict';

/**
 * kernel_5_brain_router.js — JARVIS-CORE AI Brain
 * Features:
 *   - 4-Mode Execution System: Chat, Task (AI Assisted + Direct Order), Tools (Advisor), Offline (Ollama Local/Tailscale)
 *   - Unrestricted open_url tool (opens ANY valid website/URL or searches Google/YouTube)
 *   - Aggressive Task Mode System Prompt (never says "I can't open a browser")
 *   - Full UI Settings support for custom API Keys, Models, Ollama URLs, and Hardware RAM limits
 *   - Auto-discovers working Gemini models from Google API on HTTP 404 (Self-Healing)
 *   - Voice support via Groq Whisper with Auto-Language detection (Bengali/English)
 */

const { ipcMain, dialog, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, '00_ENGINE');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const HOME = os.homedir();

const PROVIDER_ORDER = ['groq', 'gemini', 'deepseek', 'openrouter', 'cerebras'];
const VISION_PROVIDERS = new Set(['gemini']);
const MAX_STEPS = 6;
const MAX_PROMPT_CHARS = 4000;
const MAX_READ_CHARS = 8000;
const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_CHARS = 200000;
const MAX_PATH_CHARS = 260;
const MAX_TOOL_RESULT_CHARS = 20000;
const MAX_IMAGES = 2;
const MAX_IMAGE_CHARS = 6000000;
const REQUEST_TIMEOUT_MS = 25000;
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,100}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

const DEFAULTS = {
  groq: {
    model: 'openai/gpt-oss-20b',
    fallbackModels: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    baseURL: 'https://api.groq.com/openai/v1',
  },
  gemini: {
    model: 'gemini-flash-latest',
    fallbackModels: ['gemini-3.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-pro-latest'],
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  deepseek: {
    model: 'deepseek-chat',
    fallbackModels: ['deepseek-reasoner'],
    baseURL: 'https://api.deepseek.com/v1',
  },
  openrouter: {
    model: 'meta-llama/llama-3.1-8b-instruct:free',
    fallbackModels: [],
    baseURL: 'https://openrouter.ai/api/v1',
  },
  cerebras: {
    model: 'llama3.1-8b',
    fallbackModels: [],
    baseURL: 'https://api.cerebras.ai/v1',
  },
};

const OLLAMA_CONFIG = {
  model: 'llama3.2:latest',
  localURL: 'http://127.0.0.1:11434',
  tailscaleURL: '',
  preferTailscale: false,
};

const DESKTOP_DIRS = [
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'OneDrive', 'Desktop'),
];
const DOCS_DIRS = [
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Downloads'),
];
// Generalized: Allow All Drives dynamically (C to Z) as per user command
const ALL_DRIVES = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => l + ':\\');
const READ_ROOTS = [ROOT, ...DESKTOP_DIRS, ...DOCS_DIRS, ...ALL_DRIVES];
const WRITE_ROOTS = [ROOT, ...DESKTOP_DIRS, ...DOCS_DIRS, ...ALL_DRIVES];
const FORBIDDEN_ROOTS = [
  process.env.SystemRoot || 'C:\\Windows',
  process.env.ProgramFiles || 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  process.env.ProgramData || 'C:\\ProgramData',
  path.join(HOME, 'AppData'),
];

const KEY_RULES = [
  { provider: 'groq', prefix: /^gsk_[A-Za-z0-9_-]{20,}$/, scan: /\bgsk_[A-Za-z0-9_-]{20,}\b/g },
  { provider: 'gemini', prefix: /^(?:AIza[A-Za-z0-9_-]{25,}|AQ\.[A-Za-z0-9_-]{20,})$/, scan: /\b(?:AIza[A-Za-z0-9_-]{25,}|AQ\.[A-Za-z0-9_-]{20,})\b/g },
  { provider: 'openrouter', prefix: /^sk-or-v1-[A-Za-z0-9_-]{20,}$/, scan: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g },
  { provider: 'cerebras', prefix: /^csk-[A-Za-z0-9_-]{20,}$/, scan: /\bcsk-[A-Za-z0-9_-]{20,}\b/g },
  { provider: 'deepseek', prefix: /^sk-[A-Za-z0-9_-]{20,}$/, scan: /\bsk-[A-Za-z0-9]{20,}\b/g },
];

const SITE_SHORTCUTS = {
  youtube: { home: 'https://www.youtube.com', search: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
  google:  { home: 'https://www.google.com',  search: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  github:  { home: 'https://github.com',      search: (q) => `https://github.com/search?q=${encodeURIComponent(q)}` },
  bing:    { home: 'https://www.bing.com',    search: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
};

const TOOLS = Object.freeze([
  { type: 'function', function: { name: 'get_status', description: 'Return the current mode and unattended flag.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_dir', description: 'List entries of a folder.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file (first 8000 characters).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write the full content of a file. Creates or overwrites.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run one shell command in the JARVIS root. The user must approve it.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open ANY website, URL, domain (e.g. https://example.com, github.com, daraz.com.bd, facebook.com, youtube.com), or search query in the user\'s default browser. Always call this whenever the user asks to open, visit, browse, or search any website or link.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL or domain name to open (e.g. https://github.com or daraz.com.bd)' },
          site: { type: 'string', description: 'Optional site shortcut or domain (e.g. youtube, google, github, or any domain)' },
          query: { type: 'string', description: 'Optional search query to run on the site or Google/YouTube' },
        },
      },
    },
  },
]);

const SYSTEM_PROMPT_CHAT = 'You are JARVIS, a concise and helpful assistant. You are currently in Chat Mode (pure conversation only; do not trigger tools).';

const SYSTEM_PROMPT_TOOLS_ADVISOR = [
  'You are JARVIS operating in TOOLS ADVISOR MODE.',
  'In this mode, the user manually controls tools from the Tools Library.',
  'You MUST act strictly as an advisor: explain which tool to run, what JSON arguments to pass, or write modular tool code if asked, but NEVER execute tools automatically.',
].join(' ');

function taskSystemPrompt() {
  return [
    'You are JARVIS, an active OS-level execution agent on the user\'s Windows PC.',
    'Available built-in tools: get_status, list_dir, read_file, write_file, run_command, open_url.',
    `Readable folders: ${READ_ROOTS.join(' ; ')}.`,
    `Writable folders: ${WRITE_ROOTS.join(' ; ')}.`,
    `Desktop folder: ${DESKTOP_DIRS[0]}.`,
    'CRITICAL MANDATE: You are in TASK MODE. Whenever the user asks to open a website, browse a URL, search the web/YouTube, check files, write code, or run a system action, IMMEDIATELY invoke the matching tool (`open_url`, `list_dir`, `read_file`, `write_file`, `run_command`) EVEN IF the user did NOT use the word "tool" or "tools".',
    'NEVER say "I cannot open a browser", "I am a text AI", or "I don\'t have access to your PC". Call `open_url` to open ANY website or URL.',
    'Use absolute paths when a file is outside the JARVIS root.',
    'When you change code, write the COMPLETE file content.',
    'Never reveal API keys. If a tool is denied by the user, state that it was denied and do not retry.',
  ].join(' ');
}

let CTX = null;
let AI = {};
let GEMINI_MODELS = [];
const MODEL_MEMORY = {};
const REJECTED = new Set();
const disabledProviders = new Set();

function installPermissionPolicy() {
  try {
    if (!session || !session.defaultSession) return;
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        return callback(true);
      }
      callback(false);
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Keys, models and settings
// ---------------------------------------------------------------------------
function detectProviderByKeyPrefix(rawKey) {
  if (typeof rawKey !== 'string') return null;
  const k = rawKey.trim();
  for (const rule of KEY_RULES) {
    if (rule.prefix.test(k)) return { provider: rule.provider, key: k };
  }
  return null;
}

function keyMatchesProvider(name, key) {
  const d = detectProviderByKeyPrefix(key);
  return !!d && d.provider === name;
}

function scanTextForKeys(text, targetMap) {
  if (!text || typeof text !== 'string') return;
  for (const rule of KEY_RULES) {
    const match = text.match(rule.scan);
    if (match && match[0] && !targetMap[rule.provider]) {
      targetMap[rule.provider] = match[0];
    }
  }
}

function cleanModelName(rawModel) {
  if (typeof rawModel !== 'string') return '';
  const m = rawModel.trim().replace(/^models\//i, '');
  return MODEL_RE.test(m) ? m : '';
}

function settingsModelFor(existing, name) {
  const entry = existing && typeof existing === 'object' ? existing[name] : null;
  const m = entry && typeof entry === 'object' ? cleanModelName(entry.model) : '';
  return m;
}

function rememberModels(existing) {
  if (!existing || typeof existing !== 'object') return;
  for (const name of PROVIDER_ORDER) {
    const m = settingsModelFor(existing, name);
    if (m) MODEL_MEMORY[name] = m;
  }
}

function modelFor(name) {
  return MODEL_MEMORY[name] || DEFAULTS[name].model || '';
}

function autoDiscoverAllKeys(existingInput = {}) {
  rememberModels(existingInput);
  REJECTED.clear();
  const rawKeys = {};

  for (const name of PROVIDER_ORDER) {
    if (AI[name] && AI[name].key) {
      rawKeys[name] = AI[name].key;
    }
  }

  if (existingInput && typeof existingInput === 'object') {
    for (const [k, v] of Object.entries(existingInput)) {
      const lower = k.toLowerCase();
      if (lower === 'ollama' && v && typeof v === 'object') {
        if (v.model) OLLAMA_CONFIG.model = cleanModelName(v.model) || OLLAMA_CONFIG.model;
        if (v.localURL) OLLAMA_CONFIG.localURL = String(v.localURL).trim();
        if (v.tailscaleURL !== undefined) OLLAMA_CONFIG.tailscaleURL = String(v.tailscaleURL).trim();
        if (typeof v.preferTailscale === 'boolean') OLLAMA_CONFIG.preferTailscale = v.preferTailscale;
        continue;
      }
      if (typeof v === 'string' && v.trim()) {
        const auto = detectProviderByKeyPrefix(v);
        if (auto) rawKeys[auto.provider] = auto.key;
        else REJECTED.add(lower);
      } else if (v && typeof v === 'object') {
        if (typeof v.model === 'string' && v.model.trim()) {
          const cm = cleanModelName(v.model);
          if (cm && PROVIDER_ORDER.includes(lower)) MODEL_MEMORY[lower] = cm;
        }
        if (typeof v.key === 'string' && v.key.trim()) {
          const key = v.key.trim();
          const auto = detectProviderByKeyPrefix(key);
          if (keyMatchesProvider(lower, key)) rawKeys[lower] = key;
          else if (auto) rawKeys[auto.provider] = auto.key;
          else REJECTED.add(lower);
        }
      }
    }
  }

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const fileText = fs.readFileSync(SETTINGS_FILE, 'utf8');
      scanTextForKeys(fileText, rawKeys);
      try {
        const parsed = JSON.parse(fileText);
        if (parsed && parsed.ai_providers) {
          for (const name of PROVIDER_ORDER) {
            if (!MODEL_MEMORY[name]) {
              const savedM = settingsModelFor(parsed.ai_providers, name);
              if (savedM) MODEL_MEMORY[name] = savedM;
            }
          }
          if (parsed.ai_providers.ollama && typeof parsed.ai_providers.ollama === 'object') {
            Object.assign(OLLAMA_CONFIG, parsed.ai_providers.ollama);
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  const dropFiles = [
    path.join(CONFIG_DIR, 'api_keys.txt'),
    path.join(CONFIG_DIR, '.env'),
    path.join(ROOT, '.env'),
    path.join(ROOT, 'api_keys.txt'),
  ];
  for (const df of dropFiles) {
    try {
      if (fs.existsSync(df)) scanTextForKeys(fs.readFileSync(df, 'utf8'), rawKeys);
    } catch (_) {}
  }

  const out = {};
  for (const name of PROVIDER_ORDER) {
    const key = rawKeys[name];
    if (!key || key.length < 8) continue;

    // 👇 Future-Proof: পুরনো সব ডেটা এখানে ধরে রাখা হবে 👇
    const existingEntry = existingInput[name] || {};

    out[name] = {
      ...existingEntry,
      key,
      model: modelFor(name),
      baseURL: DEFAULTS[name].baseURL.replace(/\/+$/, ''),
    };
    REJECTED.delete(name);
  }

  for (const name of REJECTED) {
    CTX?.audit('warn', 'ai_key_format_rejected', { provider: name });
  }
  return out;
}

function persistAiProvidersToSettings(cleanMap) {
  try {
    const json = fs.existsSync(SETTINGS_FILE)
      ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
      : {};
    const next = {};
    for (const name of PROVIDER_ORDER) {
      if (cleanMap[name]) {
        // 👇 Future-Proof: কোনো সেটিংস বাদ না দিয়ে পুরো অবজেক্টটাই সেভ হবে 👇
        next[name] = {
          ...cleanMap[name],
          baseURL: DEFAULTS[name].baseURL,
        };
        continue;
      }
      const model = MODEL_MEMORY[name];
      if (model) next[name] = { model, baseURL: DEFAULTS[name].baseURL };
    }
    next.ollama = { ...OLLAMA_CONFIG };
    json.ai_providers = next;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(json, null, 2), 'utf8');
  } catch (e) {
    if (CTX) CTX.audit('error', 'ai_settings_persist_failed', { error: String(e.message).slice(0, 120) });
  }
}

function ensureAiLoaded() {
  if (Object.keys(AI).length === 0) {
    AI = autoDiscoverAllKeys(CTX?.settings?.ai_providers);
  }
}

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------
function realOrNull(p) {
  try { return fs.realpathSync.native(p); } catch (_) { return null; }
}

function realRootsOf(list) {
  return list.map(realOrNull).filter(Boolean);
}

function isUnder(target, base) {
  const rel = path.relative(base.toLowerCase(), target.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function checkPath(rawPath, mode) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH_CHARS || rawPath.includes('\0')) {
    return { ok: false, error: 'bad_path' };
  }

  const absolute = path.resolve(ROOT, rawPath);
  const existed = fs.existsSync(absolute);
  let real;

  if (mode === 'write') {
    const parent = realOrNull(path.dirname(absolute));
    if (!parent) return { ok: false, error: 'parent_not_found' };
    real = path.join(parent, path.basename(absolute));
    if (existed) {
      real = realOrNull(absolute);
      if (!real) return { ok: false, error: 'not_found' };
    }
  } else {
    real = realOrNull(absolute);
    if (!real) return { ok: false, error: 'not_found' };
  }

  const forbidden = realRootsOf(FORBIDDEN_ROOTS);
  if (forbidden.some((f) => isUnder(real, f))) return { ok: false, error: 'path_forbidden' };

  const allowedRoots = realRootsOf(mode === 'write' ? WRITE_ROOTS : READ_ROOTS);
  if (!allowedRoots.some((r) => isUnder(real, r))) return { ok: false, error: 'path_outside_allowed' };

  if (mode === 'read') return { ok: true, real, needsApproval: false };

  const rootReal = realOrNull(ROOT) || ROOT;
  const engineReal = realOrNull(ENGINE_DIR) || ENGINE_DIR;
  const configReal = realOrNull(CONFIG_DIR) || CONFIG_DIR;
  const desktopReal = realRootsOf(DESKTOP_DIRS);

  const isCore = isUnder(real, engineReal) || isUnder(real, configReal);
  const inRootOrDesktop = isUnder(real, rootReal) || desktopReal.some((d) => isUnder(real, d));
  const needsApproval = isCore || existed || !inRootOrDesktop;

  return { ok: true, real, needsApproval };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------
async function confirmAction(message, detail) {
  if (CTX?.settings?.unattended === true) return false;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Deny', 'Approve'],
    defaultId: 0,
    cancelId: 0,
    message,
    detail: String(detail).slice(0, 1000),
  });
  return response === 1;
}

// ---------------------------------------------------------------------------
// Built-in OS Tools (Upgraded open_url for ANY valid URL/website)
// ---------------------------------------------------------------------------
function toolGetStatus() {
  return {
    mode: CTX.settings?.mode ?? 'SEMI_AUTO',
    unattended: CTX.settings?.unattended === true,
  };
}

function toolListDir(args) {
  const chk = checkPath(args.path ?? '.', 'read');
  if (!chk.ok) return { error: chk.error };
  let st;
  try { st = fs.statSync(chk.real); } catch (_) { return { error: 'not_found' }; }
  if (!st.isDirectory()) return { error: 'not_a_directory' };

  const entries = [];
  let truncated = false;
  for (const ent of fs.readdirSync(chk.real, { withFileTypes: true })) {
    if (entries.length >= 300) { truncated = true; break; }
    entries.push({ name: ent.name, type: ent.isDirectory() ? 'dir' : 'file' });
  }
  return { path: chk.real, entries, truncated };
}

function toolReadFile(args) {
  const chk = checkPath(args.path, 'read');
  if (!chk.ok) return { error: chk.error };
  let st;
  try { st = fs.statSync(chk.real); } catch (_) { return { error: 'not_found' }; }
  if (!st.isFile()) return { error: 'not_a_file' };
  if (st.size > MAX_READ_BYTES) return { error: 'file_too_large' };
  const text = fs.readFileSync(chk.real, 'utf8');
  return {
    path: chk.real,
    truncated: text.length > MAX_READ_CHARS,
    content: text.slice(0, MAX_READ_CHARS),
  };
}

async function toolWriteFile(args) {
  if (typeof args.content !== 'string' || args.content.length > MAX_WRITE_CHARS) {
    return { error: 'content_invalid' };
  }
  const chk = checkPath(args.path, 'write');
  if (!chk.ok) return { error: chk.error };

  if (chk.needsApproval) {
    const approved = await confirmAction('JARVIS wants to write a file', chk.real);
    if (!approved) {
      CTX.audit('warn', 'ai_file_write_denied', { path: chk.real });
      return { error: 'permission_denied' };
    }
  }

  fs.writeFileSync(chk.real, args.content, 'utf8');
  CTX.audit('info', 'ai_file_written', { path: chk.real, bytes: Buffer.byteLength(args.content, 'utf8') });
  return { success: true, path: chk.real };
}

async function toolRunCommand(args) {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command || command.length > 500) return { error: 'command_invalid' };

  const approved = await confirmAction('JARVIS wants to run a command', command);
  if (!approved) {
    CTX.audit('warn', 'ai_command_denied', { command: command.slice(0, 120) });
    return { error: 'permission_denied' };
  }

  try {
    const output = execSync(command, { cwd: ROOT, timeout: 30000, maxBuffer: 1024 * 1024 }).toString();
    CTX.audit('info', 'ai_command_run', { command: command.slice(0, 120), ok: true });
    return { success: true, stdout: output.slice(0, MAX_READ_CHARS) };
  } catch (_) {
    CTX.audit('warn', 'ai_command_run', { command: command.slice(0, 120), ok: false });
    return { error: 'command_failed' };
  }
}

function resolveAnyTargetUrl(args) {
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  const rawSite = typeof args.site === 'string' ? args.site.trim() : '';
  const query = typeof args.query === 'string' ? args.query.trim() : '';

  if (query.length > 400) return { error: 'query_invalid' };

  const shortcutKey = (rawSite || rawUrl).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '');
  if (SITE_SHORTCUTS[shortcutKey]) {
    const entry = SITE_SHORTCUTS[shortcutKey];
    return { url: query ? entry.search(query) : entry.home };
  }

  const candidate = rawUrl || rawSite;
  if (candidate) {
    const withProto = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    try {
      const parsed = new URL(withProto);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        if (query && !parsed.search) {
          return { url: `https://www.google.com/search?q=${encodeURIComponent(`site:${parsed.hostname} ${query}`)}` };
        }
        return { url: parsed.toString() };
      }
    } catch (_) {}
  }

  if (query) {
    return { url: `https://www.google.com/search?q=${encodeURIComponent(query)}` };
  }

  return { error: 'invalid_url' };
}

async function toolOpenUrl(args) {
  const resolved = resolveAnyTargetUrl(args || {});
  if (resolved.error || !resolved.url) return { error: resolved.error || 'invalid_url' };

  const url = resolved.url;
  try {
    await shell.openExternal(url);
    CTX.audit('info', 'ai_url_opened', { url });
    return { success: true, url };
  } catch (_) {
    return { error: 'open_failed' };
  }
}

async function runTool(call) {
  const name = String(call?.function?.name || '');
  let args = {};
  try {
    args = JSON.parse(call?.function?.arguments || '{}');
  } catch (_) {
    return JSON.stringify({ error: 'bad_arguments' });
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};

  let out;
  try {
    if (name === 'get_status') out = toolGetStatus();
    else if (name === 'list_dir') out = toolListDir(args);
    else if (name === 'read_file') out = toolReadFile(args);
    else if (name === 'write_file') out = await toolWriteFile(args);
    else if (name === 'run_command') out = await toolRunCommand(args);
    else if (name === 'open_url') out = await toolOpenUrl(args);
    else out = { error: 'unknown_tool' };
  } catch (_) {
    out = { error: 'tool_failed' };
  }

  CTX.audit(out.error ? 'warn' : 'info', 'ai_tool_call', {
    tool: name.slice(0, 32),
    ok: !out.error,
    error: out.error || null,
  });
  return JSON.stringify(out).slice(0, MAX_TOOL_RESULT_CHARS);
}

// ---------------------------------------------------------------------------
// Deterministic Direct Order Execution (Task Mode -> Direct Order Sub-Toggle)
// ---------------------------------------------------------------------------
async function tryDirectOrderExecution(promptText) {
  const text = String(promptText || '').trim();
  const lower = text.toLowerCase();

  // 1. Open URL / Website / Search pattern
  const openMatch = text.match(/^(?:open|visit|browse|go to|launch)\s+(.+)$/i);
  if (openMatch) {
    const target = openMatch[1].trim();
    const ytSearch = target.match(/^youtube\s+(?:and\s+)?(?:search|play|for)?\s*(.+)$/i);
    if (ytSearch) {
      const res = await toolOpenUrl({ site: 'youtube', query: ytSearch[1].trim() });
      return res.success ? `⚡ [Direct Order] Opened YouTube search: ${res.url}` : `❌ Direct Order failed: ${res.error}`;
    }
    const gSearch = target.match(/^google\s+(?:and\s+)?(?:search|for)?\s*(.+)$/i);
    if (gSearch) {
      const res = await toolOpenUrl({ site: 'google', query: gSearch[1].trim() });
      return res.success ? `⚡ [Direct Order] Opened Google search: ${res.url}` : `❌ Direct Order failed: ${res.error}`;
    }
    const res = await toolOpenUrl({ url: target });
    if (res.success) return `⚡ [Direct Order] Opened in browser: ${res.url}`;
  }

  // 2. Direct Search on Google / YouTube
  const searchMatch = text.match(/^(?:search|google)\s+(.+)$/i);
  if (searchMatch) {
    const res = await toolOpenUrl({ site: 'google', query: searchMatch[1].trim() });
    if (res.success) return `⚡ [Direct Order] Searched Google: ${res.url}`;
  }

  // 3. List directory
  const listMatch = text.match(/^(?:list|ls|dir)\s*(.*)$/i);
  if (listMatch && (lower.startsWith('list ') || lower === 'ls' || lower === 'dir' || lower.startsWith('dir '))) {
    const targetPath = listMatch[1].trim() || '.';
    const res = toolListDir({ path: targetPath });
    if (!res.error) {
      return `⚡ [Direct Order] Directory (${res.path}):\n` + res.entries.map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('\n');
    }
  }

  // 4. Run shell command directly: "run <cmd>" or "cmd: <cmd>"
  const cmdMatch = text.match(/^(?:run command|cmd:|exec:)\s*(.+)$/i);
  if (cmdMatch) {
    const res = await toolRunCommand({ command: cmdMatch[1].trim() });
    return res.success ? `⚡ [Direct Order] Command Output:\n${res.stdout}` : `❌ Command Error: ${res.error}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Local & Tailscale Ollama Support
// ---------------------------------------------------------------------------
function httpJsonRequest(urlStr, method = 'GET', bodyObj = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (_) { return reject(new Error('invalid_ollama_url')); }
    const client = u.protocol === 'https:' ? https : http;
    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP_${res.statusCode}: ${raw.slice(0, 140)}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch (_) { reject(new Error('invalid_json')); }
      });
    });

    req.on('error', (e) => reject(new Error(e.code || e.message || 'ollama_unreachable')));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function checkOllamaStatus(customCfg = {}) {
  const localUrl = String(customCfg.localUrl || OLLAMA_CONFIG.localURL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const tailscaleUrl = String(customCfg.tailscaleUrl ?? OLLAMA_CONFIG.tailscaleURL ?? '').replace(/\/+$/, '');
  const preferTs = customCfg.preferTailscale ?? OLLAMA_CONFIG.preferTailscale;

  const candidates = [];
  if (preferTs && tailscaleUrl) candidates.push({ label: 'Tailscale', url: tailscaleUrl });
  if (localUrl) candidates.push({ label: 'Local', url: localUrl });
  if (!preferTs && tailscaleUrl) candidates.push({ label: 'Tailscale', url: tailscaleUrl });

  let lastErr = 'not_configured';
  for (const c of candidates) {
    try {
      const data = await httpJsonRequest(`${c.url}/api/tags`, 'GET', null, 4500);
      const models = Array.isArray(data?.models) ? data.models.map((m) => m.name) : [];
      return { online: true, activeUrl: c.url, endpointLabel: c.label, models };
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { online: false, error: lastErr };
}

async function callOllamaChat(messages, tools, customCfg = {}) {
  const status = await checkOllamaStatus({
    localUrl: customCfg.localURL,
    tailscaleUrl: customCfg.tailscaleURL,
    preferTailscale: customCfg.preferTailscale,
  });

  if (!status.online) {
    throw new Error(`Ollama is OFFLINE (${status.error}). Please start Ollama locally or connect via Tailscale.`);
  }

  const chosenModel = customCfg.model || OLLAMA_CONFIG.model || status.models[0] || 'llama3.2:latest';
  const payload = {
    model: chosenModel,
    messages,
    stream: false,
  };
  if (tools && tools.length > 0) payload.tools = tools;

  const data = await httpJsonRequest(`${status.activeUrl}/v1/chat/completions`, 'POST', payload, REQUEST_TIMEOUT_MS);
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error('empty_ollama_response');
  return { msg, provider: `ollama-${status.endpointLabel.toLowerCase()}`, model: chosenModel };
}

// ---------------------------------------------------------------------------
// Google model list & Auto-Selection
// ---------------------------------------------------------------------------
function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('insecure_endpoint'));

    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'JarvisCore/3.0', ...headers },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP_${res.statusCode}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch (_) { reject(new Error('invalid_json')); }
      });
    });

    req.on('error', (e) => reject(new Error(e.code || e.message || 'network_error')));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function refreshGeminiModels() {
  ensureAiLoaded();
  const cfg = AI.gemini;
  if (!cfg) return { ok: false, error: 'no_gemini_key' };

  try {
    const data = await httpsGetJson(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      { 'x-goog-api-key': cfg.key }
    );
    const names = (Array.isArray(data.models) ? data.models : [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => MODEL_RE.test(n) && /^gemini/i.test(n) && !/embedding|imagen|veo|aqa|tts|audio/i.test(n));

    names.sort((a, b) => {
      const score = (s) => (s.includes('flash') ? 0 : s.includes('pro') ? 1 : 2);
      return score(a) - score(b);
    });

    GEMINI_MODELS = names;
    CTX.audit('info', 'gemini_models_refreshed', { count: names.length, top: names.slice(0, 5) });
    return { ok: true, models: names };
  } catch (e) {
    CTX.audit('warn', 'gemini_models_refresh_failed', { error: String(e.message).slice(0, 80) });
    return { ok: false, error: String(e.message).slice(0, 80) };
  }
}

// ---------------------------------------------------------------------------
// Chat commands
// ---------------------------------------------------------------------------
function parseCommand(text) {
  if (!text.startsWith('/')) return null;
  const m = text.match(/^\/(model|models)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

function describeProviders() {
  return PROVIDER_ORDER.map((p) => {
    const model = modelFor(p) || '(model not set)';
    let keyState;
    if (AI[p]) keyState = 'key ok';
    else if (REJECTED.has(p)) keyState = 'stored key has wrong format, paste a valid key';
    else keyState = 'no key';
    return `${p}: ${model} — ${keyState}`;
  }).join('\n');
}

async function handleCommand(cmd) {
  if (cmd.name === 'models') {
    if (cmd.args.toLowerCase() === 'refresh') {
      const r = await refreshGeminiModels();
      if (!r.ok) return `Could not refresh Gemini models: ${r.error}`;
      const list = r.models.slice(0, 40).join('\n');
      return `Gemini models available for your key (${r.models.length}). Set one in Settings or with /model gemini <name>:\n${list}`;
    }
    return describeProviders();
  }

  const parts = cmd.args.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    return [
      'Usage: /model <provider> <model-name>',
      `Providers: ${PROVIDER_ORDER.join(', ')}, ollama`,
      'Example: /model gemini gemini-flash-latest',
      'Gemini list: /models refresh',
    ].join('\n');
  }

  const provider = parts[0].toLowerCase();
  const model = cleanModelName(parts[1]);
  if (provider === 'ollama') {
    OLLAMA_CONFIG.model = model;
    persistAiProvidersToSettings(AI);
    return `✅ Ollama model set to ${model}.`;
  }
  if (!PROVIDER_ORDER.includes(provider)) {
    return `Unknown provider. Use one of: ${PROVIDER_ORDER.join(', ')}, ollama`;
  }
  if (!model) return 'Invalid model name.';

  MODEL_MEMORY[provider] = model;
  if (AI[provider]) AI[provider] = { ...AI[provider], model };
  disabledProviders.delete(provider);
  persistAiProvidersToSettings(AI);
  CTX.audit('info', 'ai_model_set', { provider, model });

  return `✅ ${provider} model set to ${model}.`;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
function cleanImages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list.slice(0, MAX_IMAGES)) {
    if (typeof v === 'string' && v.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(v)) out.push(v);
  }
  return out;
}

function buildUserContent(text, images) {
  if (!images || images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

// ---------------------------------------------------------------------------
// Provider call (HTTPS only)
// ---------------------------------------------------------------------------
function callProvider(cfg, modelName, messages, tools) {
  return new Promise((resolve, reject) => {
    const cleanModel = cleanModelName(modelName) || modelName;
    const u = new URL(`${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`);
    if (u.protocol !== 'https:') return reject(new Error('insecure_endpoint'));

    const payload = { model: cleanModel, messages, temperature: 0.2 };
    if (tools && tools.length > 0) payload.tools = tools;
    const body = JSON.stringify(payload);

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'JarvisCore/3.0',
      'Authorization': `Bearer ${cfg.key}`,
      'Content-Length': Buffer.byteLength(body),
    };

    const options = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let apiMsg = raw.slice(0, 220);
          try {
            const errJson = JSON.parse(raw);
            if (errJson.error && errJson.error.message) apiMsg = errJson.error.message;
            else if (Array.isArray(errJson) && errJson[0]?.error?.message) apiMsg = errJson[0].error.message;
          } catch (_) {}
          const err = new Error(`HTTP_${res.statusCode}: ${apiMsg.slice(0, 180)}`);
          err.status = res.statusCode;
          err.rawMessage = apiMsg;
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const msg = parsed?.choices?.[0]?.message;
          if (!msg) throw new Error('empty_choices');
          resolve(msg);
        } catch (parseErr) {
          reject(new Error(`invalid_json_response: ${parseErr.message}`));
        }
      });
    });

    req.on('error', (e) => reject(new Error(e.code || e.message || 'network_error')));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function askAI(messages, tools, requestedModel, needVision) {
  ensureAiLoaded();

  let providers = [...PROVIDER_ORDER];
  if (requestedModel && providers.includes(requestedModel)) {
    providers = [requestedModel, ...providers.filter((p) => p !== requestedModel)];
  }

  const failures = [];

  for (const name of providers) {
    const cfg = AI[name];
    if (!cfg || disabledProviders.has(name)) continue;

    if (needVision && !VISION_PROVIDERS.has(name)) {
      failures.push(`${name}: no_vision_support`);
      continue;
    }

    let modelsToTry = [
      modelFor(name),
      cfg.model,
      ...GEMINI_MODELS.slice(0, name === 'gemini' ? 3 : 0),
      ...(DEFAULTS[name].fallbackModels || []),
    ].filter((v, idx, arr) => v && arr.indexOf(v) === idx);

    let refreshedGeminiThisTurn = false;

    for (let i = 0; i < modelsToTry.length; i++) {
      const modelName = modelsToTry[i];
      try {
        CTX.audit('info', 'ai_request_attempt', { provider: name, model: modelName });
        const msg = await callProvider(cfg, modelName, messages, tools);
        CTX.audit('info', 'ai_request_success', { provider: name, model: modelName });

        if (MODEL_MEMORY[name] !== modelName) {
          MODEL_MEMORY[name] = modelName;
          AI[name].model = modelName;
          persistAiProvidersToSettings(AI);
        }
        return { msg, provider: name, model: modelName, failures };
      } catch (e) {
        failures.push(`${name}(${modelName}): ${e.message}`);
        CTX.audit('warn', 'ai_provider_failed', { provider: name, model: modelName, error: String(e.message).slice(0, 160) });

        if (name === 'gemini' && (e.status === 404 || e.status === 400) && !refreshedGeminiThisTurn) {
          refreshedGeminiThisTurn = true;
          const suggested = String(e.rawMessage || '').match(/models\/(gemini-[A-Za-z0-9._-]+)/i);
          if (suggested && suggested[1] && !modelsToTry.includes(suggested[1])) {
            modelsToTry.push(suggested[1]);
          }
          const r = await refreshGeminiModels();
          if (r.ok && r.models.length > 0) {
            for (const gm of r.models.slice(0, 5)) {
              if (!modelsToTry.includes(gm)) modelsToTry.push(gm);
            }
          }
        }

        if (e.status === 401 || e.status === 403) {
          disabledProviders.add(name);
          break;
        }
      }
    }
  }

  if (needVision && failures.length === 0) throw new Error('no_vision_provider_configured');
  throw new Error(failures.length > 0 ? failures.join(' | ') : 'no_configured_providers');
}

function fallbackNote(requestedModel, picked) {
  if (!requestedModel || !PROVIDER_ORDER.includes(requestedModel)) return '';
  if (picked.provider === requestedModel) return '';

  if (!AI[requestedModel]) {
    return `⚠️ ${requestedModel} has no key, so ${picked.provider} (${picked.model}) answered.\n\n`;
  }
  if (disabledProviders.has(requestedModel)) {
    return `⚠️ ${requestedModel} key failed authentication, so ${picked.provider} (${picked.model}) answered.\n\n`;
  }

  const reason = picked.failures.find((f) => f.startsWith(`${requestedModel}(`) || f.startsWith(`${requestedModel}:`))
    || `${requestedModel} did not answer`;
  return `⚠️ ${reason.slice(0, 200)}\nAnswered by ${picked.provider} (${picked.model}).\n\n`;
}

async function ask(userPrompt, mode = 'chat', requestedModel = null, rawImages = null, source = 'ui', extra = {}) {
  const images = cleanImages(rawImages);
  const trimmed = typeof userPrompt === 'string' ? userPrompt.trim() : '';

  if (!trimmed && images.length === 0) return 'Empty prompt.';

  ensureAiLoaded();

  if (trimmed && images.length === 0) {
    const cmd = parseCommand(trimmed);
    if (cmd) {
      if (source !== 'ui') return 'Commands work only from the JARVIS dashboard.';
      return await handleCommand(cmd);
    }

    const detected = detectProviderByKeyPrefix(trimmed);
    if (detected) {
      const { provider, key } = detected;
      AI[provider] = {
        key,
        model: modelFor(provider),
        baseURL: DEFAULTS[provider].baseURL.replace(/\/+$/, ''),
      };
      REJECTED.delete(provider);
      disabledProviders.delete(provider);
      persistAiProvidersToSettings(AI);
      CTX.audit('info', 'ai_key_auto_detected_from_chat', { provider });
      return `✅ ${provider.toUpperCase()} key saved. Active Model: ${modelFor(provider)}.`;
    }
  }

  // Task Mode -> Direct Order sub-toggle (deterministic execution bypassing AI API limits)
  if (mode === 'task' && extra.subMode === 'direct' && trimmed) {
    const directOut = await tryDirectOrderExecution(trimmed);
    if (directOut) return directOut;
  }

  // Offline Mode or Ollama selected
  if (mode === 'offline' || requestedModel === 'ollama') {
    try {
      const sysPrompt = mode === 'task' ? taskSystemPrompt() : (mode === 'tools' ? SYSTEM_PROMPT_TOOLS_ADVISOR : SYSTEM_PROMPT_CHAT);
      const messages = [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: trimmed.slice(0, MAX_PROMPT_CHARS) },
      ];
      const ollamaRes = await callOllamaChat(messages, mode === 'task' ? TOOLS : null, extra.ollamaConfig || {});
      return `📴 [${ollamaRes.provider}: ${ollamaRes.model}]\n\n${ollamaRes.msg.content || 'Done.'}`;
    } catch (e) {
      return `❌ Offline / Ollama Error: ${e.message}`;
    }
  }

  if (Object.keys(AI).length === 0) {
    return '⚠️ No API key configured. Add a key in ⚙️ Settings, paste it in chat, or switch to 📴 Offline Mode (Ollama).';
  }

  const isTask = mode === 'task';
  const isToolsAdvisor = mode === 'tools';
  const text = trimmed.slice(0, MAX_PROMPT_CHARS) || 'Describe the attached image.';
  CTX.audit('info', 'ai_prompt', { mode, chars: text.length, images: images.length });

  const sysContent = isTask
    ? taskSystemPrompt()
    : (isToolsAdvisor ? SYSTEM_PROMPT_TOOLS_ADVISOR : SYSTEM_PROMPT_CHAT);

  const messages = [
    { role: 'system', content: sysContent },
    { role: 'user', content: buildUserContent(text, images) },
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Tools are ONLY passed in Task Mode; never in Chat Mode or Tools Advisor Mode
      const picked = await askAI(messages, isTask ? TOOLS : null, requestedModel, images.length > 0);
      const calls = isTask && Array.isArray(picked.msg.tool_calls) ? picked.msg.tool_calls : [];

      if (calls.length === 0) {
        return fallbackNote(requestedModel, picked) + (picked.msg.content || 'Done.');
      }

      messages.push(picked.msg);
      for (const call of calls) {
        messages.push({ role: 'tool', tool_call_id: String(call.id || ''), content: await runTool(call) });
      }
    }
    return 'Stopped: too many tool steps.';
  } catch (e) {
    return `❌ AI Error: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Voice Transcription (Groq Whisper)
// ---------------------------------------------------------------------------
function transcribeAudio(base64Audio, lang = 'bn') {
  return new Promise((resolve, reject) => {
    ensureAiLoaded();
    const groqKey = AI['groq'] ? AI['groq'].key : null;
    if (!groqKey) return reject(new Error('Groq API Key is required for Voice Input.'));

    if (typeof base64Audio !== 'string' || !base64Audio.includes(',')) {
      return reject(new Error('Invalid audio format received.'));
    }

    const buffer = Buffer.from(base64Audio.split(',')[1], 'base64');
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

    const payloadParts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`)
    ];

    if (lang && lang !== 'auto') {
      payloadParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`));
    }

    payloadParts.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(payloadParts);

    const req = https.request('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Groq API Error: ${res.statusCode}`));
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          resolve(parsed.text || '');
        } catch (_) {
          reject(new Error('Invalid response format from Groq'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init(ctx) {
  CTX = ctx;
  AI = autoDiscoverAllKeys(ctx.settings?.ai_providers);
  persistAiProvidersToSettings(AI);

  if (AI.gemini) {
    refreshGeminiModels().then((r) => {
      if (r.ok && r.models.length > 0 && !r.models.includes(modelFor('gemini'))) {
        MODEL_MEMORY.gemini = r.models[0];
        AI.gemini.model = r.models[0];
        persistAiProvidersToSettings(AI);
      }
    }).catch(() => {});
  }

  try {
    installPermissionPolicy();
  } catch (e) {
    ctx.audit('warn', 'permission_policy_failed', { error: String(e.message).slice(0, 120) });
  }

  if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler('ollama:status');
  ipcMain.handle('ollama:status', async (_event, cfg) => {
    return await checkOllamaStatus(cfg || {});
  });

  ipcMain.on('jarvis:save-ai-config', (_event, data) => {
    try {
      const mergedInput = { ...(ctx.settings?.ai_providers || {}), ...AI };
      if (data && typeof data === 'object') {
        if (data.ollama && typeof data.ollama === 'object') {
          Object.assign(OLLAMA_CONFIG, data.ollama);
        }
        for (const [k, v] of Object.entries(data)) {
          const lower = k.toLowerCase();
          if (!PROVIDER_ORDER.includes(lower)) continue;

          if (typeof v === 'string' && v.trim()) {
            mergedInput[lower] = { ...(mergedInput[lower] || {}), key: v.trim() };
          } else if (v && typeof v === 'object') {
            const prev = (mergedInput[lower] && typeof mergedInput[lower] === 'object')
              ? mergedInput[lower]
              : (typeof mergedInput[lower] === 'string' ? { key: mergedInput[lower] } : {});
            
            // 👇 Future-Proof: নতুন যা-ই আসুক, তা আগেরটার সাথে মার্জ হবে 👇
            mergedInput[lower] = { ...prev, ...v };

            // মডেলের নাম ক্লিন করা
            if (v.model) {
              const cm = cleanModelName(v.model);
              if (cm) {
                mergedInput[lower].model = cm;
                MODEL_MEMORY[lower] = cm;
              }
            }
          }
        }
      }
      AI = autoDiscoverAllKeys(mergedInput);
      disabledProviders.clear();
      persistAiProvidersToSettings(AI);
      ctx.audit('info', 'ai_config_saved', {
        providers: Object.keys(AI),
        models: PROVIDER_ORDER.reduce((acc, p) => ({ ...acc, [p]: modelFor(p) }), {}),
      });
    } catch (e) {
      ctx.audit('error', 'ai_config_save_failed', { error: String(e.message).slice(0, 120) });
    }
  });

  ipcMain.on('jarvis:ai-prompt', async (event, data) => {
    const res = await ask(data?.prompt, data?.mode, data?.model, data?.images, 'ui', {
      subMode: data?.subMode,
      ollamaConfig: data?.ollamaConfig,
    });
    if (!event.sender.isDestroyed()) {
      event.sender.send('jarvis:ai-response', { text: res });
    }
  });

  ipcMain.on('jarvis:transcribe-audio', async (event, data) => {
    try {
      const audio = typeof data === 'string' ? data : data?.audio;
      const mode = typeof data === 'object' ? (data.mode || 'direct') : 'direct';
      const lang = typeof data === 'object' ? (data.lang || 'bn') : 'bn';
      if (!audio) throw new Error('No audio data received.');

      const text = await transcribeAudio(audio, lang);

      if (!event.sender.isDestroyed()) {
        event.sender.send('jarvis:ai-response', { text, isVoice: true, mode });
      }

      if (mode === 'direct') {
        const res = await ask(text, 'chat', null, null, 'ui');
        if (!event.sender.isDestroyed()) {
          event.sender.send('jarvis:ai-response', { text: res });
        }
      }
    } catch (e) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('jarvis:ai-response', { text: `Voice Error: ${e.message}`, isVoice: true });
      }
    }
  });

  const tgBridge = ctx.getService('telegram');
  if (tgBridge && tgBridge.enabled) {
    tgBridge.on('command:ai', async (d) => {
      if (!d || !d.text) return;
      const reply = await ask(d.text, 'chat', null, null, 'telegram');
      tgBridge.sendMessage(`🤖 JARVIS:\n${String(reply).slice(0, 3500)}`).catch(() => {});
    });
  }

  ctx.addStateContributor('ai_brain', () => ({
    configured_providers: Object.keys(AI),
    active_models: PROVIDER_ORDER.reduce((acc, p) => ({ ...acc, [p]: modelFor(p) }), {}),
    ollama: OLLAMA_CONFIG,
  }));

  ctx.audit('info', 'brain_router_ready', {
    providers_detected: Object.keys(AI),
    vision: [...VISION_PROVIDERS],
    desktop: DESKTOP_DIRS[0],
  });
}

module.exports = { name: 'brain_router', init, ask };