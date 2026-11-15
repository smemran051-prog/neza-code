'use strict';

/**
 * kernel.js — NEZA (formerly JARVIS-CORE) Engine (COMPLETE UNIFIED VERSION)
 * 
 * ARCHITECTURE UPDATE: Unified Context
 * Both 00_ENGINE/extensions AND 02_MODULES receive the exact same powerful
 * context object. They can register services, add hooks, and access state.
 */

const { app, globalShortcut, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { loadRules, classify, RISK } = require('./safety_audit');
const { HumanBridge } = require('./human_bridge');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, '00_ENGINE');
const MODULES_DIR = path.join(ROOT, '02_MODULES');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG');
const LOGS_DIR = path.join(ROOT, 'logs');
const STOP_FLAG = path.join(ROOT, 'STOP.flag');
const OS_HANDS_SCRIPT = path.join(ENGINE_DIR, 'os_hands.py');
const PRELOAD = path.join(ENGINE_DIR, 'preload.js');
const UI_FILE = path.join(ROOT, '03_UI_DASHBOARD', 'index.html');
const RULES_FILE = path.join(CONFIG_DIR, 'system_rules.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const APPROVAL_HTML = path.join(ENGINE_DIR, 'approval.html');
const APPROVAL_PRELOAD = path.join(ENGINE_DIR, 'approval_preload.js');
const EXTENSIONS_MANIFEST = path.join(ENGINE_DIR, 'extensions.json');
const PYTHON = process.env.JARVIS_PYTHON || 'python';

// ---------------------------------------------------------------------------
// Canonical settings defaults
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = Object.freeze({
  mode: 'SEMI_AUTO',
  unattended: false,
  install_date: null,
  python_path: 'python',
  limits: {
    ram_limit_mb: 1536, max_consecutive_errors: 3, stop_poll_ms: 200,
    telemetry_interval_ms: 1000, process_ram_interval_ms: 3000,
    os_hands_ready_timeout_ms: 8000, os_hands_cmd_timeout_ms: 5000,
  },
  kill_switch: {
    hotkey: 'CommandOrControl+Alt+Shift+K', stop_flag_name: 'STOP.flag',
    stop_hook: { enabled: true, host: '127.0.0.1', port: 47821, token_file: '01_CONFIG/.stop_token' },
  },
  hands: { human_idle_threshold_ms: 2000, monitor_interval_ms: 100, settle_ms: 30 },
  risky: { dialog_timeout_ms: 60000 },
  presence: { away_threshold_ms: 900000, poll_ms: 2000 },
  telegram: { master_chat_id: null },
  logs: { dir: 'logs' },
  screenshots: { dir: 'work/screenshots' },
});

const CANONICAL_SETTINGS_PATHS = Object.freeze([
  'kill_switch.hotkey', 'risky.dialog_timeout_ms', 'limits.ram_limit_mb',
  'limits.process_ram_interval_ms', 'limits.telemetry_interval_ms',
  'limits.os_hands_ready_timeout_ms', 'limits.os_hands_cmd_timeout_ms',
  'presence.away_threshold_ms', 'presence.poll_ms', 'mode', 'unattended',
]);

const VALIDATION_RULES = Object.freeze({
  'mode': { type: 'string', enum: ['SEMI_AUTO', 'FULL_AUTO'] },
  'unattended': { type: 'boolean' },
  'kill_switch.hotkey': { type: 'string', nonEmpty: true },
  'risky.dialog_timeout_ms': { type: 'integer', min: 1000, max: 600000 },
  'limits.telemetry_interval_ms': { type: 'integer', min: 200, max: 60000 },
  'limits.process_ram_interval_ms': { type: 'integer', min: 1000, max: 60000 },
  'limits.ram_limit_mb': { type: 'integer', min: 256, max: 8192 },
  'limits.os_hands_ready_timeout_ms': { type: 'integer', min: 1000, max: 60000 },
  'limits.os_hands_cmd_timeout_ms': { type: 'integer', min: 500, max: 60000 },
  'presence.poll_ms': { type: 'integer', min: 500, max: 60000 },
  'presence.away_threshold_ms': { type: 'integer', min: 10000, max: 86400000 },
  'telegram.master_chat_id': { type: 'chat_id' },
});

const FORBIDDEN_PROTO_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

// ---------------------------------------------------------------------------
// Settings utilities
// ---------------------------------------------------------------------------
function cloneDeep(obj) { return JSON.parse(JSON.stringify(obj)); }

function deepMerge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  for (const [k, v] of Object.entries(source)) {
    if (FORBIDDEN_PROTO_KEYS.has(k)) { safeLog('warn', 'settings_forbidden_key', { key: k }); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      target[k] = deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function findMissingKeys(rawObj, paths) {
  const missing = [];
  for (const p of paths) {
    const parts = p.split('.'); let cur = rawObj; let ok = true;
    for (const part of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object' || !(part in cur)) { ok = false; break; }
      cur = cur[part];
    }
    if (!ok) missing.push(p);
  }
  return missing;
}

function getPath(obj, p) {
  const parts = p.split('.'); let cur = obj;
  for (const part of parts) { if (cur === null || cur === undefined || typeof cur !== 'object') return undefined; cur = cur[part]; }
  return cur;
}

function setPath(obj, p, val) {
  const parts = p.split('.'); let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] === null || cur[part] === undefined || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = val;
}

function applyDeprecatedAliases(raw) {
  if (!raw || typeof raw !== 'object') return;
  if (raw.approval && typeof raw.approval === 'object') {
    safeLog('warn', 'settings_deprecated_key', { old: 'approval', new: 'risky.dialog_timeout_ms' });
    const oldVal = raw.approval.timeout_ms;
    if (oldVal !== undefined && (!raw.risky || typeof raw.risky !== 'object' || raw.risky.dialog_timeout_ms === undefined)) {
      if (!raw.risky || typeof raw.risky !== 'object') raw.risky = {};
      raw.risky.dialog_timeout_ms = oldVal;
    }
  }
}

function validateSettings(merged, defaults) {
  for (const [key, rule] of Object.entries(VALIDATION_RULES)) {
    const value = getPath(merged, key); const fallback = getPath(defaults, key); let valid = true;
    if (rule.type === 'boolean') { if (typeof value !== 'boolean') valid = false; }
    else if (rule.type === 'string') {
      if (typeof value !== 'string') valid = false;
      else if (rule.nonEmpty && value.trim() === '') valid = false;
      else if (rule.enum && !rule.enum.includes(value)) valid = false;
    } else if (rule.type === 'integer') {
      if (!Number.isInteger(value)) valid = false;
      else if (typeof rule.min === 'number' && value < rule.min) valid = false;
      else if (typeof rule.max === 'number' && value > rule.max) valid = false;
    } else if (rule.type === 'chat_id') {
      if (value === null) {}
      else if (typeof value === 'number') { if (!Number.isInteger(value)) valid = false; }
      else if (typeof value === 'string') { if (!/^-?\d+$/.test(value)) valid = false; }
      else valid = false;
    }
    if (!valid) { safeLog('warn', 'settings_invalid_value', { key, received: value === undefined ? null : value, fallback }); setPath(merged, key, fallback); }
  }
  return merged;
}

let settings = cloneDeep(DEFAULT_SETTINGS);

// ---------------------------------------------------------------------------
// Module command name -> action name
// ---------------------------------------------------------------------------
const ACTION_FOR_CMD = {
  ping: 'hands.ping', get_idle: 'hands.ping', mouse_move: 'input.move',
  mouse_move_rel: 'input.move', click: 'input.click', type: 'input.type', shutdown: 'system.shutdown',
};

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
const SENSITIVE_KEYS = new Set(['password', 'passwd', 'token', 'secret', 'apikey', 'api_key', 'geminikey', 'gemini_key', 'authorization', 'cookie', 'session']);

class AuditLog {
  constructor(dir) { this.dir = dir; this.fd = null; this.currentFile = null; fs.mkdirSync(this.dir, { recursive: true }); }
  _fileFor(date) { return path.join(this.dir, `${date.toISOString().slice(0, 10)}.jsonl`); }
  _open() {
    const f = this._fileFor(new Date());
    if (f === this.currentFile) return;
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (_) {} }
    this.fd = fs.openSync(f, 'a'); this.currentFile = f;
  }
  mask(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => this.mask(x));
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '***' : this.mask(val);
    return out;
  }
  log(level, event, data) {
    const entry = { ts: new Date().toISOString(), level, event, data: data === undefined ? null : this.mask(data) };
    try { this._open(); fs.writeSync(this.fd, JSON.stringify(entry) + '\n'); } catch (e) { try { process.stderr.write(`[FATAL] audit_write_failed: ${e}\n`); } catch (_) {} process.exit(3); }
  }
}

let audit = null;
const safeLog = (level, event, data) => { if (audit) { try { audit.log(level, event, data); } catch (_) {} } };

// ---------------------------------------------------------------------------
// UI bridge globals
// ---------------------------------------------------------------------------
let mainWindow = null;
let telemetryTimer = null;
let _lastCpu = null;
let ipcInstalled = false;

function pushAudit(entry) { if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('jarvis:audit', entry); } catch (_) {} } }

function pushStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const extState = {};
    for (const [k, fn] of stateContributors) { try { extState[k] = fn(); } catch (_) { extState[k] = null; } }
    mainWindow.webContents.send('jarvis:status', {
      ts: new Date().toISOString(), running, stopReason, pid: process.pid,
      mode: settings.mode, unattended: settings.unattended, os_hands_ready: !!(osHands && osHands.ready),
      modules: Array.from(modules.keys()), presence: userPresence, idle_ms: lastIdleMs, extensions: extState,
    });
  } catch (_) {}
}

function pushTelemetry() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const ram_mb = process.memoryUsage().rss / (1024 * 1024);
    const cpu = process.cpuUsage(); const now = process.hrtime.bigint();
    let cpu_pct = 0;
    if (_lastCpu) {
      const elapsed_us = Number(now - _lastCpu.t) / 1000;
      const used_us = (cpu.user - _lastCpu.u.user) + (cpu.system - _lastCpu.u.system);
      if (elapsed_us > 0) cpu_pct = Math.max(0, Math.min(100, (used_us / elapsed_us) * 100));
    }
    _lastCpu = { t: now, u: cpu };
    mainWindow.webContents.send('jarvis:telemetry', { ts: new Date().toISOString(), ram_mb: Math.round(ram_mb), cpu_pct: Math.round(cpu_pct * 10) / 10, presence: userPresence, idle_ms: lastIdleMs });
  } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240, height: 850, show: false, backgroundColor: '#0B1220',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  try { mainWindow.removeMenu(); } catch (_) {}
  mainWindow.loadFile(UI_FILE);
  mainWindow.once('ready-to-show', () => { try { mainWindow.show(); } catch (_) {} });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function installIpcHandlers() {
  if (ipcInstalled) return;
  ipcInstalled = true;
  ipcMain.on('jarvis:emergency-stop', () => signalStop('ui_emergency_stop', 0));
  ipcMain.on('jarvis:request-status', () => { pushStatus(); pushTelemetry(); });
}

// ---------------------------------------------------------------------------
// os_hands.py supervisor
// ---------------------------------------------------------------------------
class OsHands {
  constructor(scriptPath, opts = {}) {
    this.scriptPath = scriptPath;
    this.readyTimeoutMs = Number(opts.readyTimeoutMs) > 0 ? Number(opts.readyTimeoutMs) : 8000;
    this.cmdTimeoutMs = Number(opts.cmdTimeoutMs) > 0 ? Number(opts.cmdTimeoutMs) : 5000;
    this.proc = null; this.rl = null; this.pending = new Map();
    this.nextId = 1; this.ready = false; this.dead = false;
    this._onReady = null; this._onUnexpectedExit = null;
  }
  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(PYTHON, [this.scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, JARVIS_STOP_FLAG: STOP_FLAG }, windowsHide: true });
      this.proc.on('error', (e) => { safeLog('error', 'os_hands_spawn_error', { error: String(e) }); reject(e); });
      this.proc.on('exit', (code, sig) => {
        this.dead = true; this.ready = false; safeLog('warn', 'os_hands_exit', { code, sig });
        for (const [, p] of this.pending) p.reject(new Error('os_hands exited'));
        this.pending.clear();
        if (this._onUnexpectedExit) this._onUnexpectedExit(code, sig);
      });
      this.rl = readline.createInterface({ input: this.proc.stdout });
      this.rl.on('line', (line) => this._onLine(line));
      this.proc.stderr.on('data', (buf) => safeLog('warn', 'os_hands_stderr', { data: buf.toString().slice(0, 1000) }));
      const t = setTimeout(() => reject(new Error('os_hands_ready_timeout')), this.readyTimeoutMs);
      this._onReady = () => { clearTimeout(t); resolve(); };
    });
  }
  _onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'ready') { this.ready = true; if (this._onReady) this._onReady(); return; }
    if (msg.event === 'stopped') { signalStop(`os_hands:${msg.reason}`, 0); return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.status === 'ok') p.resolve(msg); else p.reject(new Error(msg.error || 'os_hands_error'));
    }
  }
  send(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.ready || this.dead) return reject(new Error('os_hands_not_ready'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('os_hands_timeout')); }, this.cmdTimeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      const payload = JSON.stringify({ id, cmd, ...(args || {}) }) + '\n';
      try { this.proc.stdin.write(payload); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  kill() {
    if (!this.proc || this.dead) return;
    try { this.proc.stdin.write('{"cmd":"shutdown"}\n'); } catch (_) {}
    try { this.proc.kill(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
const modules = new Map();
let osHands = null;
let running = false;
let stopReason = null;
let exiting = false;
let ramWatchdog = null;
let rules = null;
let humanBridge = null;
let startedAt = 0;

let userPresence = 'ACTIVE'; let lastIdleMs = 0; let presenceTimer = null; let presencePollBusy = false; let lastPollError = null;

const approvalProviders = [];
const stopHooks = [];
const commands = new Map();
const stateContributors = new Map();
const services = new Map();

// ---------------------------------------------------------------------------
// UNIFIED CONTEXT (For both Extensions and Modules)
// ---------------------------------------------------------------------------
function buildContext(componentName, isModule) {
  const scopePrefix = isModule ? `mod:${componentName}:` : `ext:${componentName}:`;
  
  return {
    name: componentName,
    get settings() { return settings; },
    get rules() { return rules; },
    log: (level, event, data) => safeLog(level, `${scopePrefix}${event}`, data),
    audit: (level, event, data) => safeLog(level, `${scopePrefix}${event}`, data),
    act: async (cmd, args = {}) => {
      if (!running) throw new Error('engine_stopped');
      if (!osHands || !osHands.ready) throw new Error('os_hands_not_ready');
      await gateAction(componentName, cmd, args);
      if (!running) throw new Error('engine_stopped');
      const safeArgs = cmd === 'type' ? { length: String(args.text ?? '').length } : args;
      safeLog('info', `${scopePrefix}act`, { cmd, args: safeArgs });
      return osHands.send(cmd, args);
    },
    isStopped: () => !running,
    state: () => ({ running, stopReason }),
    
    addApprovalProvider(spec) {
      if (!spec || typeof spec.request !== 'function') throw new Error('approval_provider_requires_request_fn');
      const entry = { name: String(spec.name || `provider_${approvalProviders.length}`), request: spec.request, cancel: typeof spec.cancel === 'function' ? spec.cancel : null };
      approvalProviders.push(entry); safeLog('info', 'ext_approval_provider_added', { name: entry.name });
    },
    addStopHook(name, fn) {
      if (typeof fn !== 'function') throw new Error('stop_hook_must_be_function');
      stopHooks.push({ name: String(name), fn }); safeLog('info', 'ext_stop_hook_added', { name: String(name) });
    },
    addCommand(key, handler) {
      if (typeof handler !== 'function') throw new Error('command_handler_must_be_function');
      commands.set(String(key), handler); safeLog('info', 'ext_command_added', { key: String(key) });
    },
    addStateContributor(key, fn) {
      if (typeof fn !== 'function') throw new Error('state_contributor_must_be_function');
      stateContributors.set(String(key), fn); safeLog('info', 'ext_state_contributor_added', { key: String(key) });
    },
    registerService(name, obj) { services.set(String(name), obj); safeLog('info', 'ext_service_registered', { name: String(name) }); },
    getService(name) { return services.get(String(name)) || null; },
    emergencyStop(reason) { signalStop(String(reason || 'component_stop'), 0); },
    getState() { return collectState(); },
  };
}

function collectState() {
  const out = {
    ts: new Date().toISOString(), running, stopReason, pid: process.pid,
    mode: settings.mode, unattended: settings.unattended, os_hands_ready: !!(osHands && osHands.ready),
    modules: Array.from(modules.keys()), presence: userPresence, idle_ms: lastIdleMs,
    uptime_ms: startedAt ? (Date.now() - startedAt) : 0, extensions: {},
  };
  for (const [k, fn] of stateContributors) { try { out.extensions[k] = fn(); } catch (e) { out.extensions[k] = { error: String(e) }; } }
  return out;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------
const EXTENSION_FILENAME_RE = /^[A-Za-z0-9_.\-]+\.js$/;

function loadExtensions() {
  if (!fs.existsSync(EXTENSIONS_MANIFEST)) return safeLog('info', 'extensions_manifest_missing', { path: EXTENSIONS_MANIFEST });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(EXTENSIONS_MANIFEST, 'utf8')); } catch (e) { return safeLog('error', 'extensions_manifest_parse_failed', { error: String(e) }); }
  if (!manifest || !Array.isArray(manifest.extensions)) return safeLog('warn', 'extensions_manifest_invalid', {});
  
  for (const file of manifest.extensions) {
    if (typeof file !== 'string' || !EXTENSION_FILENAME_RE.test(file) || file.includes('..') || file.includes('/') || file.includes('\\')) { safeLog('warn', 'extension_invalid_filename', { file: String(file) }); continue; }
    const full = path.join(ENGINE_DIR, file);
    if (!fs.existsSync(full)) { safeLog('warn', 'extension_file_missing', { file }); continue; }
    
    try {
      const mod = require(full);
      if (!mod || typeof mod.init !== 'function') { safeLog('error', 'extension_bad_contract', { file }); continue; }
      const ctx = buildContext(mod.name || path.basename(file, '.js'), false);
      mod.init(ctx);
      safeLog('info', 'extension_loaded', { file, name: mod.name || null });
    } catch (e) { safeLog('error', 'extension_init_failed', { file, error: String(e) }); }
  }
}

function loadModules() {
  if (!fs.existsSync(MODULES_DIR)) return safeLog('warn', 'modules_dir_missing', { dir: MODULES_DIR });
  const entries = fs.readdirSync(MODULES_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const entryPath = path.join(MODULES_DIR, ent.name, 'index.js');
    if (!fs.existsSync(entryPath)) continue;
    try {
      const mod = require(entryPath);
      if (typeof mod.init !== 'function') { safeLog('error', 'module_bad_contract', { name: ent.name }); continue; }
      modules.set(ent.name, mod); safeLog('info', 'module_loaded', { name: ent.name });
    } catch (e) { safeLog('error', 'module_load_failed', { name: ent.name, error: String(e) }); }
  }
}

async function initModules() {
  for (const [name, mod] of modules) {
    try {
      const ctx = buildContext(name, true);
      await mod.init(ctx);
      safeLog('info', 'module_init_ok', { name });
    } catch (e) { safeLog('error', 'module_init_failed', { name, error: String(e) }); }
  }
}

// ---------------------------------------------------------------------------
// User presence
// ---------------------------------------------------------------------------
function computePresence(idleMs) {
  if (!osHands || !osHands.ready) return 'UNKNOWN';
  const threshold = Number(settings.presence?.away_threshold_ms) || DEFAULT_SETTINGS.presence.away_threshold_ms;
  return idleMs >= threshold ? 'AWAY' : 'ACTIVE';
}

function setPresence(next, idleMs) {
  lastIdleMs = idleMs;
  if (next !== userPresence) { const from = userPresence; userPresence = next; safeLog('info', 'presence_changed', { from, to: next, idle_ms: idleMs }); }
}

async function pollPresence() {
  if (!running || presencePollBusy) return;
  presencePollBusy = true;
  try {
    if (!osHands || !osHands.ready) { setPresence('UNKNOWN', 0); return; }
    const res = await osHands.send('get_idle');
    const idle = Number(res.idle_ms);
    if (!Number.isFinite(idle) || idle < 0) throw new Error('invalid_idle_ms');
    setPresence(computePresence(idle), idle);
    lastPollError = null;
  } catch (e) {
    const msg = String(e);
    if (msg !== lastPollError) { safeLog('warn', 'presence_poll_failed', { error: msg }); lastPollError = msg; }
  } finally { presencePollBusy = false; }
}

function startPresence() {
  if (presenceTimer) return;
  const interval = Number(settings.presence?.poll_ms) > 0 ? Number(settings.presence.poll_ms) : DEFAULT_SETTINGS.presence.poll_ms;
  presenceTimer = setInterval(() => { pollPresence(); }, interval);
  pollPresence();
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------
function signalStop(reason, exitCode = 0) {
  if (stopReason) return;
  stopReason = reason; running = false;

  if (humanBridge) { try { humanBridge.cancelAll(reason); } catch (_) {} }
  for (const { name, fn } of stopHooks) { try { fn(reason); } catch (e) { safeLog('error', `stop_hook_${name}_error`, { error: String(e) }); } }
  safeLog('warn', 'stop_signal', { reason });

  if (telemetryTimer) { clearInterval(telemetryTimer); telemetryTimer = null; }
  if (ramWatchdog) { clearInterval(ramWatchdog); ramWatchdog = null; }
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  try { pushStatus(); } catch (_) {}

  try { fs.writeFileSync(STOP_FLAG, `stopped:${reason}\n${new Date().toISOString()}\n`, { flag: 'w' }); } catch (e) { safeLog('error', 'stop_flag_write_failed', { error: String(e) }); }

  if (osHands) {
    try { osHands.send('shutdown').catch(() => {}); } catch (_) {}
    setTimeout(() => { try { osHands.kill(); } catch (_) {} }, 300);
  }

  for (const [name, m] of modules) {
    try { if (typeof m.shutdown === 'function') { Promise.resolve(m.shutdown()).catch((e) => safeLog('error', `mod:${name}:shutdown_error`, { error: String(e) })); } } catch (e) { safeLog('error', `mod:${name}:shutdown_error`, { error: String(e) }); }
  }

  if (exiting) return; exiting = true;
  setTimeout(() => { try { globalShortcut.unregisterAll(); } catch (_) {} try { app.exit(exitCode); } catch (_) {} }, 800);
}

// ---------------------------------------------------------------------------
// RISKY action gate
// ---------------------------------------------------------------------------
async function gateAction(moduleName, cmd, args) {
  const action = ACTION_FOR_CMD[cmd] || cmd;
  const target = cmd === 'type' ? `text:${String(args.text ?? '').length}chars` : 'input';
  const { level, reasons } = classify(rules, action, target);
  const base = { module: moduleName, action, target, risk_level: level, mode: settings.mode };

  if (level === RISK.FORBIDDEN) { safeLog('warn', 'action_blocked', { ...base, reasons }); throw new Error(`forbidden:${reasons.join(',') || 'policy'}`); }

  if (level === RISK.RISKY) {
    if (settings.unattended) { safeLog('warn', 'action_blocked', { ...base, reason: 'unattended_risky' }); throw new Error('unattended_risky_blocked'); }
    const requestId = crypto.randomUUID();
    const expiresIn = Number(settings.risky?.dialog_timeout_ms) > 0 ? Number(settings.risky.dialog_timeout_ms) : DEFAULT_SETTINGS.risky.dialog_timeout_ms;
    const req = { id: requestId, module: moduleName, action, target, risk_level: level, summary: `${action} requested by ${moduleName}`, expires_in_ms: expiresIn };

    const pcProvider = {
      name: 'pc',
      request: (r) => humanBridge.request({ module: r.module, action: r.action, target: r.target, risk_level: r.risk_level, summary: r.summary }).then((v) => ({ decision: v.decision, reason: v.reason })),
      cancel: () => { try { if (humanBridge && humanBridge.win && !humanBridge.win.isDestroyed()) { humanBridge.win.webContents.send('approval:hide'); humanBridge.win.hide(); } } catch (_) {} },
    };

    const allProviders = [pcProvider, ...approvalProviders];
    const promises = allProviders.map((p) => Promise.resolve().then(() => p.request(req)).then((v) => ({ source: p.name, decision: (v && v.decision) || 'REJECT', reason: (v && v.reason) || 'no_reason' })).catch((e) => ({ source: p.name, decision: 'REJECT', reason: 'provider_error', error: String(e) })));
    const verdict = await Promise.race(promises);

    safeLog('info', 'approval_decided', { request_id: requestId, source: verdict.source, decision: verdict.decision, reason: verdict.reason, module: moduleName, action, providers_raced: allProviders.map((p) => p.name) });

    for (const p of allProviders) {
      if (p.name === verdict.source) continue;
      if (typeof p.cancel === 'function') { try { p.cancel(requestId, 'race_lost:' + verdict.source); } catch (e) { safeLog('warn', 'approval_cancel_failed', { provider: p.name, error: String(e) }); } }
    }

    if (verdict.decision !== 'APPROVE') throw new Error(`approval_${verdict.reason || verdict.decision}`);
  }
  return level;
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------
async function boot() {
  audit = new AuditLog(LOGS_DIR);
  const _origLog = audit.log.bind(audit);
  audit.log = (level, event, data) => { _origLog(level, event, data); pushAudit({ ts: new Date().toISOString(), level, event, data: data === undefined ? null : audit.mask(data) }); };

  audit.log('info', 'kernel_start', { root: ROOT, pid: process.pid });
  if (fs.existsSync(STOP_FLAG)) { try { fs.renameSync(STOP_FLAG, STOP_FLAG + '.old'); audit.log('warn', 'stale_stop_flag_rotated', {}); } catch (e) { process.exit(6); } }

  try {
    rules = loadRules(RULES_FILE, { JARVIS_ROOT: ROOT, ENGINE: ENGINE_DIR, CONFIG: CONFIG_DIR, MODULES: MODULES_DIR });
    if (fs.existsSync(SETTINGS_FILE)) {
      let raw; try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (pe) { audit.log('error', 'settings_parse_failed', { error: String(pe) }); throw pe; }
      applyDeprecatedAliases(raw);
      
      // FIXED: Restored the missing key check
      const missing = findMissingKeys(raw, CANONICAL_SETTINGS_PATHS);
      for (const p of missing) audit.log('warn', 'settings_missing_key', { key: p });
      
      settings = deepMerge(cloneDeep(DEFAULT_SETTINGS), raw); validateSettings(settings, DEFAULT_SETTINGS);
    } else {
      audit.log('warn', 'settings_file_missing', { path: SETTINGS_FILE, using: 'defaults' });
      settings = cloneDeep(DEFAULT_SETTINGS); validateSettings(settings, DEFAULT_SETTINGS);
    }
    audit.log('info', 'rules_loaded', { mode: settings.mode, unattended: settings.unattended });
    audit.log('info', 'settings_effective', { mode: settings.mode, unattended: settings.unattended, hotkey: settings.kill_switch.hotkey, dialog_timeout_ms: settings.risky.dialog_timeout_ms, ram_limit_mb: settings.limits.ram_limit_mb, process_ram_interval_ms: settings.limits.process_ram_interval_ms, telemetry_interval_ms: settings.limits.telemetry_interval_ms, presence_poll_ms: settings.presence.poll_ms, away_threshold_ms: settings.presence.away_threshold_ms, os_hands_ready_timeout_ms: settings.limits.os_hands_ready_timeout_ms, os_hands_cmd_timeout_ms: settings.limits.os_hands_cmd_timeout_ms, master_chat_id: settings.telegram?.master_chat_id ?? null });
  } catch (e) { audit.log('error', 'rules_load_failed', { error: String(e) }); process.exit(7); }

  humanBridge = new HumanBridge({
    windowFile: APPROVAL_HTML, preloadFile: APPROVAL_PRELOAD, audit: (lvl, ev, data) => safeLog(lvl, ev, data),
    timeoutMs: Number(settings.risky?.dialog_timeout_ms) > 0 ? Number(settings.risky.dialog_timeout_ms) : DEFAULT_SETTINGS.risky.dialog_timeout_ms,
    presence: () => userPresence, isSensitive: (text) => rules.sensitiveRegex.test(String(text)) || rules.cardLikeRegex.test(String(text)),
  });

  if (process.env.JARVIS_APPROVAL_TEST === '1') {
    humanBridge.request({ module: 'approval_test', action: 'email.send', target: 'hr@example.com', risk_level: 'RISKY', summary: 'Test RISKY approval (no action will run)' }).then((v) => audit.log('info', 'approval_test_result', v));
  }

  createWindow(); startedAt = Date.now(); running = true;

  const readyMs = Number(settings.limits?.os_hands_ready_timeout_ms) > 0 ? Number(settings.limits.os_hands_ready_timeout_ms) : DEFAULT_SETTINGS.limits.os_hands_ready_timeout_ms;
  const cmdMs = Number(settings.limits?.os_hands_cmd_timeout_ms) > 0 ? Number(settings.limits.os_hands_cmd_timeout_ms) : DEFAULT_SETTINGS.limits.os_hands_cmd_timeout_ms;
  osHands = new OsHands(OS_HANDS_SCRIPT, { readyTimeoutMs: readyMs, cmdTimeoutMs: cmdMs });
  osHands._onUnexpectedExit = () => signalStop('os_hands_exit', 0);
  try { await osHands.start(); audit.log('info', 'os_hands_started', {}); } catch (e) { audit.log('error', 'os_hands_start_failed', { error: String(e) }); signalStop('os_hands_start_failed', 2); return; }

  const hotkey = settings.kill_switch?.hotkey ?? DEFAULT_SETTINGS.kill_switch.hotkey;
  const hotkeyOk = globalShortcut.register(hotkey, () => signalStop('hotkey', 0));
  if (!hotkeyOk) { audit.log('error', 'hotkey_register_failed', { combo: hotkey }); signalStop('hotkey_register_failed', 4); return; }
  audit.log('info', 'hotkey_registered', { combo: hotkey });

  loadModules();
  await initModules();
  installIpcHandlers();
  startPresence();

  const telemetryMs = Number(settings.limits?.telemetry_interval_ms) > 0 ? Number(settings.limits.telemetry_interval_ms) : DEFAULT_SETTINGS.limits.telemetry_interval_ms;
  telemetryTimer = setInterval(() => { pushStatus(); pushTelemetry(); }, telemetryMs);
  pushStatus(); pushTelemetry();

  const ramLimitMb = Number(settings.limits?.ram_limit_mb) > 0 ? Number(settings.limits.ram_limit_mb) : DEFAULT_SETTINGS.limits.ram_limit_mb;
  const ramIntervalMs = Number(settings.limits?.process_ram_interval_ms) > 0 ? Number(settings.limits.process_ram_interval_ms) : DEFAULT_SETTINGS.limits.process_ram_interval_ms;
  ramWatchdog = setInterval(() => { if ((process.memoryUsage().rss / (1024 * 1024)) > ramLimitMb) signalStop('ram_threshold_main', 0); }, ramIntervalMs);
  if (ramWatchdog.unref) ramWatchdog.unref();

  audit.log('info', 'kernel_ready', { modules: Array.from(modules.keys()) });

  loadExtensions();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(boot).catch((e) => { safeLog('error', 'kernel_boot_failed', { error: String(e) }); process.exit(5); });
app.on('window-all-closed', () => { /* daemon: never quit here */ });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (_) {} });
app.on('before-quit', () => signalStop('app_quit', 0));
process.on('exit', () => { try { if (osHands) osHands.kill(); } catch (_) {} });
process.on('uncaughtException', (e) => signalStop('uncaught_exception', 0));
process.on('unhandledRejection', (e) => signalStop('unhandled_rejection', 0));
process.on('SIGINT', () => signalStop('sigint', 0));
process.on('SIGTERM', () => signalStop('sigterm', 0));

// ============================================================================
// ADD-ON ONLY: RIGHT-CLICK CONTEXT MENU
// ============================================================================
(() => {
  const { app, Menu, MenuItem, clipboard, shell, BrowserWindow } = require('electron');
  function attachJarvisContextMenu(webContents) {
    if (!webContents || webContents.__jarvisContextMenuAttached) return;
    webContents.__jarvisContextMenuAttached = true;
    webContents.on('context-menu', (event, params) => {
      const menu = new Menu();
      const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
      if (hasSelection) {
        menu.append(new MenuItem({ label: 'Copy', role: 'copy', accelerator: 'CmdOrCtrl+C' }));
        menu.append(new MenuItem({ label: 'Search with Google', click: () => shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText.trim())}`) }));
        menu.append(new MenuItem({ type: 'separator' }));
      }
      if (params.isEditable) {
        menu.append(new MenuItem({ label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo }));
        menu.append(new MenuItem({ label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo }));
        menu.append(new MenuItem({ type: 'separator' }));
        menu.append(new MenuItem({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }));
        menu.append(new MenuItem({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy }));
        menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }));
        menu.append(new MenuItem({ label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll }));
        menu.append(new MenuItem({ type: 'separator' }));
      }
      if (params.linkURL) {
        menu.append(new MenuItem({ label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) }));
        menu.append(new MenuItem({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }));
        menu.append(new MenuItem({ type: 'separator' }));
      }
      if (params.mediaType === 'image' && params.srcURL) {
        menu.append(new MenuItem({ label: 'Copy Image', click: () => webContents.copyImageAt(params.x, params.y) }));
        menu.append(new MenuItem({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) }));
        menu.append(new MenuItem({ type: 'separator' }));
      }
      if (webContents.canGoBack()) menu.append(new MenuItem({ label: 'Back', click: () => webContents.goBack() }));
      if (webContents.canGoForward()) menu.append(new MenuItem({ label: 'Forward', click: () => webContents.goForward() }));
      menu.append(new MenuItem({ label: 'Reload', click: () => webContents.reload() }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Inspect Element', click: () => webContents.inspectElement(params.x, params.y) }));
      const win = BrowserWindow.fromWebContents(webContents);
      menu.popup({ window: win || undefined });
    });
  }
  app.on('web-contents-created', (event, contents) => { attachJarvisContextMenu(contents); });
  app.whenReady().then(() => { BrowserWindow.getAllWindows().forEach(win => { attachJarvisContextMenu(win.webContents); }); });
})();

// ============================================================================
// ADD-ON: GEMINI LIVE VOICE BRIDGE
// ============================================================================
(() => {
  const { ipcMain, BrowserWindow } = require('electron');
  let liveBridge = null;
  ipcMain.on('gemini:start', (event) => {
    if (liveBridge) return;
    try {
      const { createGeminiLiveBridge } = require('./kernel_13_gemini_live_bridge.js');
      const apiKey = settings?.ai_providers?.gemini?.key || process.env.GEMINI_API_KEY;
      if (!apiKey) return console.error('[Gemini Live] No Gemini API key found in settings.');
      const liveModel = settings?.ai_providers?.gemini?.liveModel || 'models/gemini-3.1-flash-live-preview';
      liveBridge = createGeminiLiveBridge({ apiKey: apiKey, ctx: null, model: liveModel });
      liveBridge.on('audio', (data) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.webContents.send('gemini:audio-reply', data.data);
      });
      liveBridge.start().then(() => { console.log('[Gemini Live] WebSocket Connected successfully.'); }).catch(err => { console.error('[Gemini Live] Connection Error:', err); });
    } catch (err) { console.error('[Gemini Live] Failed to initialize:', err); }
  });
  ipcMain.on('gemini:audio-chunk', (event, base64Pcm) => { if (liveBridge) liveBridge.sendAudioChunk(base64Pcm); });
  ipcMain.on('gemini:stop', () => { if (liveBridge) { liveBridge.stop(); liveBridge = null; console.log('[Gemini Live] Disconnected.'); } });
})();