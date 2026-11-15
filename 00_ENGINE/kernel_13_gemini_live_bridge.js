'use strict';

/**
 * kernel_13_gemini_live_bridge.js
 * ---------------------------------------------------------------------------
 * JARVIS-CORE | Kernel 13 | Gemini Multimodal Live <-> Tool Librarian bridge
 *
 * - Connects to Gemini Live (BidiGenerateContent WebSocket).
 * - Declares ONLY 3 static meta-tools (ask_librarian, check_status, cancel_task).
 *   The 10,000+ local tools are never exposed to Gemini.
 * - ask_librarian -> kernel_6_tool_librarian.js
 *       deliverToolsForAI(intent) -> executeToolByName(name, args, ctx)
 * - FIFO queue for ask_librarian (strictly one at a time).
 *   check_status / cancel_task are instant, side-effect free, and answered
 *   out-of-band so that a cancel is never stuck behind the task it must cancel.
 * - RISKY tools: no UI popup. A toolResponse tells Gemini to ask the user
 *   verbally; execution only happens after a second ask_librarian call that
 *   carries the one-time confirm_token.
 * - AbortController per task (voice interruption, toolCallCancellation,
 *   cancel_task, timeout, shutdown).
 * - Idempotency cache keyed by (call id + argument fingerprint) so duplicate
 *   toolCalls after a WebSocket reconnect never execute twice.
 * - All tool args validated; every string sent back is capped at 500 chars.
 *
 * Dependency:  npm install ws
 * Env:         GEMINI_API_KEY (or options.apiKey), GEMINI_LIVE_MODEL (optional)
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const WebSocket = require('ws');
// 👇 নতুন যোগ করুন:
let memoryManager = null;
let bm25Rag = null;
try {
  const k9 = require('./kernel_9_adaptive_intelligence_4.js');
  memoryManager = k9.memoryAndSftManager;
  bm25Rag = k9.bm25RagEngine;
} catch (e) {
  console.warn('[KERNEL-13] Memory engine not loaded yet:', e.message);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_MODEL = 'models/gemini-3.1-flash-live-preview';

const MAX_OUTPUT_CHARS = 500;
const MAX_INTENT_CHARS = 1000;
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 60;

const TOOL_ASK = 'ask_librarian';
const TOOL_STATUS = 'check_status';
const TOOL_CANCEL = 'cancel_task';
const ALLOWED_TOOLS = new Set([TOOL_ASK, TOOL_STATUS, TOOL_CANCEL]);

// Abort reasons that mean "Gemini already knows / does not wait" -> no toolResponse.
const SILENT_ABORT_CODES = new Set(['interrupted', 'server_cancel', 'shutdown']);

const TOKEN_RE = /^[a-f0-9]{8}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const DEFAULT_SYSTEM_INSTRUCTION = [
  'You are JARVIS, a concise voice assistant that controls the user\'s local PC.',
  'You never run PC actions yourself. You have exactly three tools:',
  '- ask_librarian(intent): give it a short natural-language description of what the user wants done on the PC.',
  '- check_status(task_id?): see what is running or queued.',
  '- cancel_task(task_id?): cancel the running task (or a specific one).',
  'Rules:',
  '1. Never claim an action succeeded until the tool response says status "success".',
  '2. If a tool response has status "needs_permission", do NOT proceed. Ask the user out loud for explicit',
  '   permission. Only if they clearly say yes, call ask_librarian again with the same intent and the given confirm_token.',
  '3. If the user says no, or does not answer, tell them the action was not run.',
  '4. Keep spoken replies short. Tool outputs may be truncated; summarize them.',
].join('\n');

const META_TOOL_DECLARATIONS = [
  {
    name: TOOL_ASK,
    description:
      'Ask the local Tool Librarian to find and run the right PC tool for the user\'s request. ' +
      'Pass a short natural-language intent. Returns a status and a short output. ' +
      'If status is "needs_permission", ask the user verbally before calling again with confirm_token.',
    parameters: {
      type: 'OBJECT',
      properties: {
        intent: {
          type: 'STRING',
          description: 'What the user wants done on the PC, in plain language (max 1000 chars).',
        },
        confirm_token: {
          type: 'STRING',
          description:
            'Only when retrying after the user verbally approved a risky action: the confirm_token from the earlier needs_permission response.',
        },
        // 👇 এই arguments ব্লকটি ঠিক এখানে বসাতে হবে, confirm_token এর ব্র্যাকেট বন্ধ করার পর 👇
        arguments: {
          type: 'OBJECT',
          description: 'The arguments required to run the chosen tool. For example, {"url": "https://youtube.com"}.',
        },
      },
      required: ['intent'],
    },
  },
  {
    name: TOOL_STATUS,
    description: 'Check the state of the local task queue: what is running, how many are waiting, or the state of one task.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'STRING', description: 'Optional id of a specific earlier tool call.' },
      },
    },
  },
  {
    name: TOOL_CANCEL,
    description:
      'Cancel the currently running local task and everything queued behind it, or one specific task if task_id is given.',
    parameters: {
      type: 'OBJECT',
      properties: {
        task_id: { type: 'STRING', description: 'Optional id of a specific tool call to cancel.' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeToString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === 'object') {
    try {
      const seen = new WeakSet();
      const s = JSON.stringify(value, (_k, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v !== null && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      });
      return s === undefined ? String(value) : s;
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

/** Hard cap: returned string is never longer than `max` characters. */
function truncateText(value, max = MAX_OUTPUT_CHARS) {
  const str = safeToString(value);
  if (str.length <= max) return str;
  const marker = '…[truncated]';
  let cut = str.slice(0, Math.max(0, max - marker.length));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // do not split a surrogate pair
  return cut + marker;
}

/** Caps every top-level string field of a response object. */
function finalizeResponse(response) {
  const out = {};
  const src = isPlainObject(response) ? response : { status: 'success', output: safeToString(response) };
  for (const [k, v] of Object.entries(src)) {
    out[k] = typeof v === 'string' ? truncateText(v, MAX_OUTPUT_CHARS) : v;
  }
  if (typeof out.status !== 'string') out.status = 'success';
  return out;
}

function cleanString(value, label, { min = 0, max }) {
  if (typeof value !== 'string') return { ok: false, error: `${label} must be a string` };
  const s = value.replace(CONTROL_CHARS, ' ').trim();
  if (s.length < min) return { ok: false, error: `${label} is empty or too short` };
  if (s.length > max) return { ok: false, error: `${label} is too long (max ${max} characters)` };
  return { ok: true, value: s };
}

function isEmptyArg(v) {
  return v === undefined || v === null || v === '';
}

function validateArgs(name, rawArgs) {
  const args = isEmptyArg(rawArgs) ? {} : rawArgs;
  if (!isPlainObject(args)) return { ok: false, error: 'args must be a JSON object' };

  switch (name) {
    case TOOL_ASK: {
      const intent = cleanString(args.intent, 'intent', { min: 1, max: MAX_INTENT_CHARS });
      if (!intent.ok) return intent;
      let confirmToken = null;
      if (!isEmptyArg(args.confirm_token)) {
        const t = cleanString(args.confirm_token, 'confirm_token', { min: 1, max: 64 });
        if (!t.ok) return t;
        if (!TOKEN_RE.test(t.value)) return { ok: false, error: 'confirm_token has an invalid format' };
        confirmToken = t.value.toLowerCase();
      }
            // 👇 নতুন যোগ করুন 👇
      let toolArgs = {};
      if (args.arguments && typeof args.arguments === 'object') {
        toolArgs = args.arguments;
      }
      return { ok: true, value: { intent: intent.value, confirmToken, toolArgs } };
    }
    case TOOL_STATUS:
    case TOOL_CANCEL: {
      let taskId = null;
      if (!isEmptyArg(args.task_id)) {
        const t = cleanString(args.task_id, 'task_id', { min: 1, max: MAX_ID_CHARS });
        if (!t.ok) return t;
        taskId = t.value;
      }
      return { ok: true, value: { taskId } };
    }
    default:
      return { ok: false, error: 'unknown tool' };
  }
}

/** Validates one functionCall coming from Gemini. */
function validateFunctionCall(fc) {
  if (!isPlainObject(fc)) return { ok: false, error: 'functionCall must be an object', id: null, name: null };

  const id = typeof fc.id === 'string' ? fc.id.trim() : '';
  if (!id || id.length > MAX_ID_CHARS) {
    return { ok: false, error: 'functionCall has a missing or invalid id', id: null, name: null };
  }

  const name = typeof fc.name === 'string' ? fc.name : '';
  if (!ALLOWED_TOOLS.has(name)) {
    return {
      ok: false,
      error: `Unknown tool. Only ${[...ALLOWED_TOOLS].join(', ')} are available.`,
      id,
      name: truncateText(name || 'unknown', 60),
    };
  }

  const args = validateArgs(name, fc.args);
  if (!args.ok) return { ok: false, error: args.error, id, name };

  return { ok: true, id, name, args: args.value };
}

function fingerprint(name, args) {
  return crypto
    .createHash('sha256')
    // 👇 args.toolArgs || {} যোগ করুন 👇
    .update(JSON.stringify([name, args.intent || '', args.confirmToken || '', args.taskId || '', args.toolArgs || {}]))
    .digest('hex')
    .slice(0, 16);
}

function normalizeToolList(found) {
  if (Array.isArray(found)) return found.filter((t) => t !== null && t !== undefined);
  if (isPlainObject(found)) {
    if (Array.isArray(found.tools)) return found.tools.filter((t) => t !== null && t !== undefined);
    if (Array.isArray(found.results)) return found.results.filter((t) => t !== null && t !== undefined);
    return [found];
  }
  return [];
}

function toolLabel(tool) {
  if (typeof tool === 'string') return truncateText(tool, MAX_LABEL_CHARS);
  if (isPlainObject(tool)) {
    const raw = tool.name || tool.title || tool.id || tool.tool || 'unnamed tool';
    return truncateText(String(raw).replace(CONTROL_CHARS, ' '), MAX_LABEL_CHARS);
  }
  return 'unnamed tool';
}

/** Default RISKY detector. Override with options.isRisky(tool) if your flag differs. */
function defaultIsRisky(tool) {
  if (!isPlainObject(tool)) return false;
  if (tool.risky === true || tool.isRisky === true) return true;
  const fields = [tool.risk, tool.riskLevel, tool.risk_level, tool.safety, tool.safetyLevel, tool.flag, tool.status];
  for (const f of fields) {
    if (typeof f === 'string' && f.trim().toUpperCase() === 'RISKY') return true;
  }
  for (const listName of ['flags', 'tags', 'labels']) {
    const list = tool[listName];
    if (Array.isArray(list) && list.some((x) => typeof x === 'string' && x.trim().toUpperCase() === 'RISKY')) {
      return true;
    }
  }
  return false;
}

function makeAbortError(signal) {
  const code = (signal && signal.reason && signal.reason.code) || 'aborted';
  const err = new Error(`Task aborted (${code})`);
  err.name = 'AbortError';
  err.code = code;
  return err;
}

/** Runs fn() but rejects immediately when the signal aborts, even if fn ignores the signal. */
function raceAbort(fn, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(makeAbortError(signal));
      return;
    }
    const onAbort = () => reject(makeAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
  });
}

function rawToString(raw) {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return String(raw);
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

class GeminiLiveBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
    const model = options.model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
    this.model = model.startsWith('models/') ? model : `models/${model}`;
    this.baseUrl = options.url || GEMINI_WS_BASE;
    this.responseModalities = Array.isArray(options.responseModalities) ? options.responseModalities : ['AUDIO'];
    this.systemInstruction = options.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION;

    this.isRiskyFn = typeof options.isRisky === 'function' ? options.isRisky : defaultIsRisky;
    this.verifyPermission = typeof options.verifyPermission === 'function' ? options.verifyPermission : null;

    this.taskTimeoutMs = Number.isFinite(options.taskTimeoutMs) ? options.taskTimeoutMs : 120000;
    this.permissionTtlMs = Number.isFinite(options.permissionTtlMs) ? options.permissionTtlMs : 120000;
    this.idempotencyTtlMs = Number.isFinite(options.idempotencyTtlMs) ? options.idempotencyTtlMs : 300000;
    this.maxReconnectAttempts = Number.isFinite(options.maxReconnectAttempts) ? options.maxReconnectAttempts : 8;
    this.abortOnInterrupt = options.abortOnInterrupt !== false;
    this.useSessionResumption = options.useSessionResumption !== false;
    this.maxCacheEntries = 500;
    this.maxPending = 20;
    this.outboxTtlMs = 60000;

    this._logger = options.logger || console;
    this._debug = Boolean(options.debug);

    this._librarian = options.librarian || null;

    // connection state
    this._ws = null;
    this._epoch = 0;
    this._ready = false;
    this._shouldRun = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._lastPong = 0;
    this._resumptionHandle = null;
    this._usedHandleThisAttempt = false;
    this._startPromise = null;
    this._startDeferred = null;
    this._outbox = [];

    // task state
    this._queue = [];
    this._current = null;
    this._pumping = false;
    this._inflight = new Map(); // key -> job (queued or running)
    this._cache = new Map(); // key -> { id, name, response, at }
    this._pending = new Map(); // token -> { tool, intent, expiresAt }
  }

  // ----- public API --------------------------------------------------------

  start() {
    if (this._startPromise) return this._startPromise;
    if (!this.apiKey) {
      return Promise.reject(new Error('GeminiLiveBridge: missing API key (options.apiKey or GEMINI_API_KEY).'));
    }
    this._shouldRun = true;
    this._reconnectAttempts = 0;
    this._startPromise = new Promise((resolve, reject) => {
      this._startDeferred = { resolve, reject };
    });
    this._startPromise.catch(() => {}); 
    this._open();
    return this._startPromise;
  }

  async stop() {
    this._shouldRun = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopHeartbeat();
    this._cancelAll('shutdown');
    this._epoch += 1;
    const ws = this._ws;
    this._ws = null;
    this._ready = false;
    if (ws) {
      try { ws.close(1000, 'client shutdown'); } catch (_) { try { ws.terminate(); } catch (__) {} }
    }
    if (this._startDeferred) this._startDeferred.reject(new Error('GeminiLiveBridge stopped before becoming ready.'));
    this._startPromise = null;
    this._startDeferred = null;
    this._outbox.length = 0;
    this.emit('closed');
  }

  sendAudioChunk(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
    if (typeof base64Pcm !== 'string' || !base64Pcm) return false;
    return this._sendReady({ realtimeInput: { audio: { data: base64Pcm, mimeType } } });
  }

  sendText(text) {
    const t = cleanString(text, 'text', { min: 1, max: 8000 });
    if (!t.ok) return false;
    return this._sendReady({
      clientContent: { turns: [{ role: 'user', parts: [{ text: t.value }] }], turnComplete: true },
    });
  }

  get isReady() { return this._ready; }

  _redact(text) {
    let s = safeToString(text);
    if (this.apiKey) s = s.split(this.apiKey).join('[REDACTED]');
    return s;
  }

  _log(level, message, extra) {
    if (level === 'debug' && !this._debug) return;
    const fn = (this._logger && typeof this._logger[level] === 'function' && this._logger[level]) ||
      (this._logger && typeof this._logger.log === 'function' && this._logger.log) || console.log;
    try {
      if (extra !== undefined) fn.call(this._logger, `[KERNEL-13] ${message}`, this._redact(extra));
      else fn.call(this._logger, `[KERNEL-13] ${message}`);
    } catch (_) {}
  }

  _emitError(err) {
    const e = err instanceof Error ? err : new Error(safeToString(err));
    e.message = this._redact(e.message);
    this._log('error', e.message);
    if (this.listenerCount('error') > 0) this.emit('error', e);
  }

   _buildSetup() {
    let finalSystemInstruction = this.systemInstruction;

    // 🧠 মেমোরি ও কনটেক্সট লোড করা
    if (memoryManager && bm25Rag) {
      try {
        // ১. অপারেটরের পার্সোনালিটি ও রুলস লোড করা
        const adaptiveHeader = memoryManager.buildSystemPromptHeader();
        
        // ২. আগের চ্যাট/কাজের সারসংক্ষেপ (RAG) লোড করা
        const pastContext = bm25Rag.retrieveTopK("Gemini Live previous session context", 3);

        finalSystemInstruction = `${this.systemInstruction}\n\n${adaptiveHeader}\n\n[Previous Context]:\n${pastContext || 'No previous context found.'}`;
      } catch (err) {
        this._log('warn', 'Failed to load memory context', err.message);
      }
    }

    const setup = {
      model: this.model,
      generationConfig: { responseModalities: this.responseModalities },
      systemInstruction: { parts: [{ text: finalSystemInstruction }] }, // 👈 মেমোরি সহ ইনস্ট্রাকশন পাঠানো হলো
      tools: [{ functionDeclarations: META_TOOL_DECLARATIONS }],
    };
    if (this.useSessionResumption) {
      setup.sessionResumption = this._resumptionHandle ? { handle: this._resumptionHandle } : {};
    }
    return { setup };
  }

  _open() {
    if (!this._shouldRun) return;
    const url = `${this.baseUrl}?key=${encodeURIComponent(this.apiKey)}`;
    let ws;
    try {
      ws = new WebSocket(url, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 15000 });
    } catch (err) {
      this._emitError(err);
      this._scheduleReconnect();
      return;
    }

    this._epoch += 1;
    const epoch = this._epoch;
    this._ws = ws;
    this._ready = false;
    this._usedHandleThisAttempt = Boolean(this._resumptionHandle);

    ws.on('open', () => {
      if (epoch !== this._epoch) return;
      this._log('info', 'WebSocket open, sending setup.');
      this._startHeartbeat(ws);
      this._rawSend(ws, this._buildSetup());
    });
    ws.on('message', (raw) => { if (epoch === this._epoch) this._onMessage(raw); });
    ws.on('pong', () => { if (epoch === this._epoch) this._lastPong = Date.now(); });
    ws.on('error', (err) => {
      if (epoch !== this._epoch) return;
      this._emitError(new Error(`WebSocket error: ${err && err.message ? err.message : err}`));
    });
    ws.on('close', (code, reasonBuf) => {
      if (epoch !== this._epoch) return;
      this._onClose(code, reasonBuf ? reasonBuf.toString('utf8') : '');
    });
  }

  _onClose(code, reason) {
    this._stopHeartbeat();
    const wasReady = this._ready;
    this._ready = false;
    this._ws = null;
    this._log('warn', `WebSocket closed (code ${code}).`, reason || undefined);
    this.emit('disconnected', { code, reason: this._redact(reason) });
    if (!wasReady && this._usedHandleThisAttempt) this._resumptionHandle = null;
    if (this._shouldRun) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this._shouldRun || this._reconnectTimer) return;
    this._reconnectAttempts += 1;
    if (this._reconnectAttempts > this.maxReconnectAttempts) {
      this._giveUp(new Error(`Gemini Live: gave up after ${this.maxReconnectAttempts} reconnect attempts.`));
      return;
    }
    const base = Math.min(30000, 1000 * 2 ** (this._reconnectAttempts - 1));
    const delay = base + Math.floor(Math.random() * 500);
    this._log('info', `Reconnecting in ${delay} ms (attempt ${this._reconnectAttempts}).`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._open();
    }, delay);
  }

  _giveUp(err) {
    this._shouldRun = false;
    this._emitError(err);
    if (this._startDeferred) {
      this._startDeferred.reject(err);
      this._startDeferred = null;
    }
    this._startPromise = null;
    this.emit('closed');
  }

  _startHeartbeat(ws) {
    this._stopHeartbeat();
    this._lastPong = Date.now();
    this._heartbeatTimer = setInterval(() => {
      try {
        if (Date.now() - this._lastPong > 45000) {
          this._log('warn', 'Heartbeat timeout, terminating socket.');
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      } catch (_) {}
    }, 20000);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _rawSend(ws, obj) {
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      this._emitError(err);
      return false;
    }
  }

  _sendReady(obj) {
    if (!this._ready || !this._ws) return false;
    return this._rawSend(this._ws, obj);
  }

  _sendToolResponse(id, name, response) {
    const payload = { toolResponse: { functionResponses: [{ id, name, response }] } };
    if (!this._sendReady(payload)) {
      this._outbox.push({ payload, at: Date.now() });
      while (this._outbox.length > 100) this._outbox.shift();
      this._log('debug', `Buffered toolResponse for ${id} (socket not ready).`);
    }
  }

  _flushOutbox() {
    if (!this._outbox.length) return;
    const items = this._outbox.splice(0);
    const now = Date.now();
    for (const item of items) {
      if (now - item.at > this.outboxTtlMs) continue;
      if (!this._sendReady(item.payload)) this._outbox.push(item);
    }
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(rawToString(raw));
    } catch (err) {
      this._log('warn', 'Ignoring non-JSON message from Gemini.');
      return;
    }
    if (!isPlainObject(msg)) return;

    try {
      if (msg.setupComplete !== undefined) this._onSetupComplete();
      if (isPlainObject(msg.sessionResumptionUpdate)) {
        const u = msg.sessionResumptionUpdate;
        if (u.resumable !== false && typeof u.newHandle === 'string' && u.newHandle) {
          this._resumptionHandle = u.newHandle;
        }
      }
      if (isPlainObject(msg.toolCallCancellation)) {
        const ids = Array.isArray(msg.toolCallCancellation.ids) ? msg.toolCallCancellation.ids : [];
        for (const id of ids) {
          if (typeof id === 'string') this._cancelById(id, 'server_cancel');
        }
      }
      if (isPlainObject(msg.toolCall)) {
        const calls = Array.isArray(msg.toolCall.functionCalls) ? msg.toolCall.functionCalls : [];
        for (const fc of calls) this._handleFunctionCall(fc);
      }
      if (isPlainObject(msg.serverContent)) this._onServerContent(msg.serverContent);
      if (msg.goAway !== undefined) {
        this._log('warn', 'Gemini sent goAway; the session will end soon, reconnect will follow.');
        this.emit('go_away', msg.goAway);
      }
    } catch (err) {
      this._emitError(err);
    }
  }

  _onSetupComplete() {
    this._ready = true;
    this._reconnectAttempts = 0;
    this._log('info', 'Gemini Live session ready.');
    if (this._startDeferred) {
      this._startDeferred.resolve();
      this._startDeferred = null;
    }
    this.emit('ready');
    this._flushOutbox();
  }

  _onServerContent(sc) {
    if (sc.interrupted === true) {
      this.emit('interrupted');
      if (this.abortOnInterrupt) this._cancelAll('interrupted');
    }
    const parts = sc.modelTurn && Array.isArray(sc.modelTurn.parts) ? sc.modelTurn.parts : [];
    for (const part of parts) {
      if (!isPlainObject(part)) continue;
      
      if (isPlainObject(part.inlineData) && typeof part.inlineData.data === 'string') {
        this.emit('audio', { data: part.inlineData.data, mimeType: part.inlineData.mimeType });
      } else if (typeof part.text === 'string') {
        this.emit('text', part.text);
        
        // 🧠 জেমিনির কথা মেমোরিতে সেভ করা (Long-Term Memory)
        if (memoryManager) {
          memoryManager.recordEpisodicEvent('gemini_live_response', part.text, { source: 'voice_live' });
        }
      }
    }
    if (sc.turnComplete === true) this.emit('turnComplete');
  }

  _handleFunctionCall(fc) {
    const v = validateFunctionCall(fc);
    if (!v.ok) {
      this._log('warn', `Rejected functionCall: ${v.error}`);
      if (v.id) {
        this._reply(v.id, v.name || 'unknown', { status: 'error', message: v.error }, null);
      }
      return;
    }

    const { id, name, args } = v;
    const key = `${id}:${fingerprint(name, args)}`;

    const cached = this._cacheGet(key);
    if (cached) {
      this._log('info', `Duplicate toolCall ${id}: replaying cached response.`);
      this._sendToolResponse(id, cached.name, cached.response);
      return;
    }
    if (this._inflight.has(key)) {
      this._log('info', `Duplicate toolCall ${id}: already in flight, ignoring.`);
      return;
    }

    if (name === TOOL_STATUS || name === TOOL_CANCEL) {
      let response;
      try {
        response = name === TOOL_STATUS ? this._doCheckStatus(args) : this._doCancelTask(args);
      } catch (err) {
        response = { status: 'error', message: truncateText(err && err.message ? err.message : err) };
      }
      this._reply(id, name, response, key);
      return;
    }

    const job = {
      id,
      key,
      name,
      args,
      status: 'queued',
      controller: new AbortController(),
      abortReason: null,
      enqueuedAt: Date.now(),
      startedAt: null,
    };
    this._inflight.set(key, job);
    this._queue.push(job);
    this._log('debug', `Queued ${id} (queue length ${this._queue.length}).`);
    this._pump();
  }

  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this._queue.length > 0) {
        const job = this._queue.shift();
        if (!job || job.status !== 'queued') continue;
        this._current = job;
        try {
          await this._runJob(job);
        } catch (err) {
          this._emitError(err); 
        }
        this._current = null;
      }
    } finally {
      this._pumping = false;
      this._current = null;
    }
  }

  async _runJob(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    const timer = setTimeout(() => this._abortJob(job, 'timeout'), this.taskTimeoutMs);
    let response;
    try {
      response = await this._runAskLibrarian(job);
    } catch (err) {
      response = this._errorToResponse(err);
    } finally {
      clearTimeout(timer);
    }

    const silent = Boolean(job.abortReason && SILENT_ABORT_CODES.has(job.abortReason));
    job.status = response && response.status === 'cancelled' ? 'cancelled' : 'finished';
    this._inflight.delete(job.key);

    if (silent) {
      this._log('debug', `Task ${job.id} aborted (${job.abortReason}); no toolResponse sent.`);
      return;
    }
    this._reply(job.id, job.name, response, job.key);
  }

  _errorToResponse(err) {
    if (err && err.name === 'AbortError') {
      if (err.code === 'timeout') {
        return { status: 'timeout', message: 'The local task took too long and was stopped.' };
      }
      return { status: 'cancelled', message: 'The task was cancelled before it finished.' };
    }
    this._log('error', 'Task failed.', err && err.message ? err.message : err);
    return { status: 'error', message: truncateText(err && err.message ? err.message : 'Unknown error') };
  }

  // =========================================================================
  // ⚠️ MODIFIED SECTION: Only this part is changed to use new kernel_6 API.
  // =========================================================================
  async _runAskLibrarian(job) {
    const { intent, confirmToken } = job.args;
    const signal = job.controller.signal;
    const librarian = this._getLibrarian();

    let tool = null;
        // 🧠 ইউজারের ইনটেন্ট মেমোরিতে সেভ করা
    if (memoryManager && intent) {
      memoryManager.recordEpisodicEvent('user_voice_intent', intent, { source: 'gemini_live' });
    }
    let approved = false;

    // 1. Handle Confirm Token (Voice Approval)
    if (confirmToken) {
      const pending = this._takePending(confirmToken);
      if (!pending) {
        return {
          status: 'error',
          message: 'The permission token is invalid or expired. Ask the user again, starting with a fresh ask_librarian call without a token.',
        };
      }
      if (this.verifyPermission) {
        const allowed = await raceAbort(() => this.verifyPermission({ tool: pending.tool, intent }), signal);
        if (allowed !== true) {
          return { status: 'denied', message: 'Permission was not confirmed locally. The action was not run.' };
        }
      }
      tool = pending.tool;
      approved = true;
    } 
    // 2. Fresh Search
    else {
      // Call new kernel_6 API: deliverToolsForAI
      const searchResult = await raceAbort(() => librarian.deliverToolsForAI(intent, { maxTools: 3 }), signal);
      const tools = normalizeToolList(searchResult);
      
      if (tools.length === 0) {
        return { status: 'not_found', message: 'No matching local tool was found for that request.' };
      }
      tool = tools[0];

      // Risk check
      let risky = false;
      try {
        risky = Boolean(this.isRiskyFn(tool));
      } catch (_) {
        risky = true;
      }

      if (risky) {
        const label = toolLabel(tool);
        const token = this._createPending(tool, intent);
        return {
          status: 'needs_permission',
          risky: true,
          tool: label,
          confirm_token: token,
          message:
            `This action is flagged RISKY: "${label}". Do NOT run it yet. ` +
            'Ask the user out loud for explicit permission, saying what it will do. ' +
            `If they clearly say yes, call ask_librarian again with the same intent and confirm_token="${token}". ` +
            'If they say no or stay silent, do not run it and tell them it was not run.',
        };
      }
    }

    // 3. Execute Tool using new kernel_6 API: executeToolByName
    const rawResult = await raceAbort(
      () => librarian.executeToolByName(tool.name, job.args.toolArgs || {}, { signal, approved, callId: job.id, userQuery: intent }),
      signal
    );

    // kernel_6 returns a JSON string, we need to parse it for final processing
    let parsedResult = rawResult;
    if (typeof rawResult === 'string') {
      try { parsedResult = JSON.parse(rawResult); } catch (_) {}
    }

    return this._normalizeExecutionResult(parsedResult, tool);
  }
  // =========================================================================

  _normalizeExecutionResult(result, tool) {
    const label = toolLabel(tool);
    if (isPlainObject(result)) {
      const hasError = !isEmptyArg(result.error) && result.error !== false;
      const failed = result.success === false || result.ok === false || hasError;
      const body = result.output ?? result.stdout ?? result.result ?? result.message ?? result;
      if (failed) {
        return { status: 'error', tool: label, output: truncateText(result.error ?? body) };
      }
      return { status: 'success', tool: label, output: truncateText(body) };
    }
    return { status: 'success', tool: label, output: truncateText(result) };
  }

  _describeJob(job) {
    return {
      task_id: truncateText(job.id, 60),
      tool: job.name,
      intent: truncateText(job.args.intent || '', 100),
      elapsed_s: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
    };
  }

  _doCheckStatus({ taskId }) {
    const response = {
      status: 'ok',
      connected: this._ready,
      running: this._current ? this._describeJob(this._current) : null,
      queued: this._queue.length,
      queued_task_ids: this._queue.slice(0, 5).map((j) => truncateText(j.id, 60)),
    };
    if (taskId) {
      const job = this._findJobById(taskId);
      if (job) {
        response.task = { task_id: truncateText(taskId, 60), state: job.status };
      } else {
        const entry = this._cacheFindById(taskId);
        response.task = entry
          ? { task_id: truncateText(taskId, 60), state: 'finished', result_status: entry.response.status }
          : { task_id: truncateText(taskId, 60), state: 'unknown' };
      }
    }
    return response;
  }

  _doCancelTask({ taskId }) {
    let cancelled = [];
    if (taskId) {
      const job = this._findJobById(taskId);
      if (!job) {
        const entry = this._cacheFindById(taskId);
        return {
          status: 'ok',
          cancelled: 0,
          message: entry ? 'That task already finished.' : 'No running or queued task with that id.',
        };
      }
      cancelled = this._cancelJob(job, 'cancelled_by_model');
    } else {
      cancelled = this._cancelAll('cancelled_by_model');
    }
    if (cancelled.length === 0) return { status: 'ok', cancelled: 0, message: 'Nothing was running or queued.' };
    return { status: 'ok', cancelled: cancelled.length, message: `Cancelled ${cancelled.length} task(s).` };
  }

  _abortJob(job, code) {
    if (job.controller.signal.aborted) return;
    job.abortReason = code;
    job.controller.abort({ code });
  }

  _cancelQueued(job, code) {
    const idx = this._queue.indexOf(job);
    if (idx >= 0) this._queue.splice(idx, 1);
    job.status = 'cancelled';
    this._abortJob(job, code);
    this._inflight.delete(job.key);
    if (!SILENT_ABORT_CODES.has(code)) {
      this._reply(job.id, job.name, { status: 'cancelled', message: 'The task was cancelled before it started.' }, job.key);
    }
  }

  _cancelJob(job, code) {
    if (job === this._current) {
      this._abortJob(job, code);
      return [job.id];
    }
    if (job.status === 'queued') {
      this._cancelQueued(job, code);
      return [job.id];
    }
    return [];
  }

  _cancelAll(code) {
    const ids = [];
    if (this._current) ids.push(...this._cancelJob(this._current, code));
    for (const job of [...this._queue]) ids.push(...this._cancelJob(job, code));
    return ids;
  }

  _cancelById(id, code) {
    const job = this._findJobById(id);
    if (job) this._cancelJob(job, code);
  }

  _findJobById(id) {
    for (const job of this._inflight.values()) {
      if (job.id === id) return job;
    }
    return null;
  }

  _cacheGet(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.idempotencyTtlMs) {
      this._cache.delete(key);
      return null;
    }
    return entry;
  }

  _cacheFindById(id) {
    for (const entry of this._cache.values()) {
      if (entry.id === id && Date.now() - entry.at <= this.idempotencyTtlMs) return entry;
    }
    return null;
  }

  _cacheSet(key, id, name, response) {
    this._cache.set(key, { id, name, response, at: Date.now() });
    while (this._cache.size > this.maxCacheEntries) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  _reply(id, name, response, key) {
    const final = finalizeResponse(response);
    if (key) this._cacheSet(key, id, name, final);
    this._sendToolResponse(id, name, final);
  }

  _createPending(tool, intent) {
    const now = Date.now();
    for (const [t, p] of this._pending) {
      if (p.expiresAt <= now) this._pending.delete(t);
    }
    while (this._pending.size >= this.maxPending) {
      this._pending.delete(this._pending.keys().next().value);
    }
    const token = crypto.randomBytes(4).toString('hex');
    this._pending.set(token, { tool, intent, expiresAt: now + this.permissionTtlMs });
    return token;
  }

  _takePending(token) {
    const p = this._pending.get(token);
    if (!p) return null;
    this._pending.delete(token);
    if (p.expiresAt <= Date.now()) return null;
    return p;
  }

  // =========================================================================
  // ⚠️ MODIFIED SECTION: Updated to check for new kernel_6 exports.
  // =========================================================================
  _getLibrarian() {
    if (!this._librarian) {
      try {
        this._librarian = require(path.join(__dirname, 'kernel_6_tool_librarian.js'));
      } catch (err) {
        throw new Error(`Could not load kernel_6_tool_librarian.js: ${err && err.message ? err.message : err}`);
      }
    }
    if (
      !this._librarian ||
      typeof this._librarian.deliverToolsForAI !== 'function' ||
      typeof this._librarian.executeToolByName !== 'function'
    ) {
      this._librarian = null;
      throw new Error('kernel_6_tool_librarian.js must export deliverToolsForAI() and executeToolByName().');
    }
    return this._librarian;
  }
}

function createGeminiLiveBridge(options) {
  return new GeminiLiveBridge(options);
}

module.exports = {
  GeminiLiveBridge,
  createGeminiLiveBridge,
  META_TOOL_DECLARATIONS,
  _internals: { truncateText, validateFunctionCall, validateArgs, defaultIsRisky, finalizeResponse },
};