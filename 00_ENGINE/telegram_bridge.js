'use strict';

/**
 * telegram_bridge.js — transport-only Telegram bridge for JARVIS-CORE.
 *
 * Sends messages and approval requests, emits events for incoming commands
 * and approval decisions. Contains NO safety policy:
 *   - no presence logic
 *   - no risk logic
 *   - no kill-switch logic
 * kernel.js decides what to do with every event.
 *
 * Node built-ins only: https, events. No third-party packages. Never requires
 * kernel.js, human_bridge.js, or safety_audit.js.
 *
 * Public methods never throw. Failures are audited and reflected in state.
 */

const https = require('https');
const { EventEmitter } = require('events');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;
const CHAT_ID_RE = /^-?\d+$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,36}$/;
const CALLBACK_RE = /^(approve|reject):([A-Za-z0-9-]{8,36})$/;

const REQUEST_TIMEOUT_MS = 40000;
const POLL_LONG_TIMEOUT_S = 30;
const STARTUP_OFFSET = -1;
const STALE_WINDOW_S = 5;

const SEND_INTERVAL_MS = 1000;
const MAX_QUEUE = 20;
const MAX_MESSAGE_LEN = 4000;
const MAX_SUMMARY_LEN = 600;
const MAX_TARGET_LEN = 200;
const MAX_NAME_LEN = 64;
const MAX_CALLBACK_TEXT_LEN = 200;

const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60000;

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------
class TelegramBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._audit = typeof opts.audit === 'function' ? opts.audit : () => {};

    this._token = process.env.JARVIS_TG_TOKEN || '';
    this._chatId = process.env.JARVIS_TG_CHAT_ID || '';

    this.enabled = false;
    this._disableReason = null;

    if (!TOKEN_RE.test(this._token)) {
      this._disable('invalid_token');
    } else if (!CHAT_ID_RE.test(this._chatId)) {
      this._disable('invalid_chat_id');
    } else {
      this.enabled = true;
    }

    this._running = false;
    this._readyEmitted = false;
    this._lastUpdateId = 0;
    this._startedAtUnix = 0;
    this._inflight = null;
    this._sleepEntries = new Set();
    this._consecutiveFailures = 0;

    this._pending = new Map();
    this._sendQueue = [];
    this._sendTimer = null;
    this._sending = false;
    this._lastSendAt = 0;

    if (!this.enabled) {
      this._log('warn', 'telegram_disabled', { reason: this._disableReason });
      const reason = this._disableReason;
      setImmediate(() => { try { this.emit('disabled', { reason }); } catch (_) {} });
    }
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------
  _disable(reason) {
    this.enabled = false;
    this._disableReason = reason;
  }

  _maskToken(s) {
    if (!s) return s;
    const t = this._token;
    if (!t) return String(s);
    return String(s).split(t).join('***');
  }

  _log(level, event, data) {
    try {
      let safe = data;
      if (safe && typeof safe === 'object') {
        safe = { ...safe };
        for (const k of Object.keys(safe)) {
          if (typeof safe[k] === 'string') safe[k] = this._maskToken(safe[k]);
        }
      }
      this._audit(level, event, safe);
    } catch (_) { /* never throw from logging */ }
  }

  _escape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _emitReady() {
    if (this._readyEmitted) return;
    this._readyEmitted = true;
    try { this.emit('ready'); } catch (_) {}
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      if (!this._running) { resolve(); return; }
      const entry = { resolve, timer: null };
      this._sleepEntries.add(entry);
      entry.timer = setTimeout(() => {
        this._sleepEntries.delete(entry);
        resolve();
      }, ms);
    });
  }

  _wakeAllSleeps() {
    for (const e of this._sleepEntries) {
      try { clearTimeout(e.timer); } catch (_) {}
      try { e.resolve(); } catch (_) {}
    }
    this._sleepEntries.clear();
  }

  // -----------------------------------------------------------------------
  // HTTPS
  // -----------------------------------------------------------------------
  _apiCall(method, params) {
    return new Promise((resolve) => {
      if (!this.enabled) {
        return resolve({ ok: false, description: 'disabled' });
      }
      const body = JSON.stringify(params || {});
      const url = `https://api.telegram.org/bot${this._token}/${method}`;
      let req;
      let settled = false;

      const done = (val) => {
        if (settled) return;
        settled = true;
        if (this._inflight === req) this._inflight = null;
        resolve(val);
      };

      try {
        req = https.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: REQUEST_TIMEOUT_MS,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed;
            try { parsed = JSON.parse(raw); }
            catch (_) {
              return done({ ok: false, _badJson: true, _statusCode: res.statusCode });
            }
            parsed._statusCode = res.statusCode;
            done(parsed);
          });
        });
      } catch (_) {
        return done({ ok: false, _transportError: true, _code: null });
      }

      this._inflight = req;

      req.on('timeout', () => {
        try { req.destroy(new Error('timeout')); } catch (_) {}
      });
      req.on('error', (e) => {
        done({ ok: false, _transportError: true, _code: e.code || null, _timeout: /timeout/i.test(String(e)) });
      });
      try { req.write(body); } catch (_) {}
      try { req.end(); } catch (_) {}
    });
  }

  // -----------------------------------------------------------------------
  // Public: lifecycle
  // -----------------------------------------------------------------------
  start() {
    if (!this.enabled || this._running) return;
    this._running = true;
    this._readyEmitted = false;
    this._startedAtUnix = Math.floor(Date.now() / 1000);
    this._consecutiveFailures = 0;
    this._runLoop();
  }

  stop() {
    this._running = false;
    if (this._inflight) {
      try { this._inflight.destroy(new Error('stop')); } catch (_) {}
      this._inflight = null;
    }
    if (this._sendTimer) {
      try { clearTimeout(this._sendTimer); } catch (_) {}
      this._sendTimer = null;
    }
    this._wakeAllSleeps();
    while (this._sendQueue.length) {
      const item = this._sendQueue.shift();
      try { item.resolve(false); } catch (_) {}
    }
    for (const entry of this._pending.values()) {
      if (entry.timer) {
        try { clearTimeout(entry.timer); } catch (_) {}
        entry.timer = null;
      }
    }
  }

  async _runLoop() {
    // Prime offset with one call; do not process returned updates.
    try {
      const r = await this._apiCall('getUpdates', {
        offset: STARTUP_OFFSET,
        timeout: 0,
        allowed_updates: ['message', 'callback_query'],
      });
      if (!this._running) return;
      if (r && r.ok) {
        this._emitReady();
        const list = Array.isArray(r.result) ? r.result : [];
        if (list.length > 0) {
          const last = list[list.length - 1];
          if (last && typeof last.update_id === 'number') {
            this._lastUpdateId = last.update_id;
          }
        }
      } else if (r && (r._statusCode === 401 || r.error_code === 401)) {
        this._log('warn', 'telegram_auth_failed', {});
        this._disable('auth_failed');
        this._running = false;
        return;
      }
    } catch (_) { /* fall through to loop */ }

    while (this._running) {
      try { await this._pollOnce(); }
      catch (_) { await this._sleep(BASE_BACKOFF_MS); }
    }
  }

  async _pollOnce() {
    if (!this._running) return;
    let r;
    try {
      r = await this._apiCall('getUpdates', {
        offset: this._lastUpdateId + 1,
        timeout: POLL_LONG_TIMEOUT_S,
        allowed_updates: ['message', 'callback_query'],
      });
    } catch (_) {
      this._log('warn', 'telegram_bad_response', {});
      await this._sleep(BASE_BACKOFF_MS);
      return;
    }
    if (!this._running) return;
    if (!r) {
      await this._sleep(BASE_BACKOFF_MS);
      return;
    }
    if (r._transportError) {
      this._consecutiveFailures++;
      const wait = Math.min(BASE_BACKOFF_MS * Math.pow(2, this._consecutiveFailures - 1), MAX_BACKOFF_MS);
      const code = r._code || (TRANSIENT_CODES.has(r._code) ? r._code : (r._timeout ? 'timeout' : 'unknown'));
      this._log('warn', 'telegram_network_error', { code });
      await this._sleep(wait);
      return;
    }
    if (r._badJson) {
      this._log('warn', 'telegram_bad_response', {});
      await this._sleep(BASE_BACKOFF_MS);
      return;
    }
    if (r._statusCode === 401 || r.error_code === 401) {
      this._log('warn', 'telegram_auth_failed', {});
      this._disable('auth_failed');
      this._running = false;
      return;
    }
    if (r._statusCode === 409 || r.error_code === 409) {
      this._log('warn', 'telegram_conflict', {});
      await this._sleep(30000);
      return;
    }
    if (r._statusCode === 429 || r.error_code === 429) {
      const retry = (r.parameters && Number(r.parameters.retry_after)) || 30;
      this._log('warn', 'telegram_rate_limited', { retry_after: retry });
      await this._sleep(retry * 1000);
      return;
    }
    if (!r.ok) {
      this._log('warn', 'telegram_bad_response', { error_code: r.error_code || null });
      await this._sleep(BASE_BACKOFF_MS);
      return;
    }

    // Success
    this._consecutiveFailures = 0;
    this._emitReady();

    const updates = Array.isArray(r.result) ? r.result : [];
    for (const u of updates) {
      if (!this._running) return;
      if (u && typeof u.update_id === 'number' && u.update_id > this._lastUpdateId) {
        this._lastUpdateId = u.update_id;
      }
      try { this._handleUpdate(u); } catch (_) {}
    }
  }

  // -----------------------------------------------------------------------
  // Incoming handlers
  // -----------------------------------------------------------------------
  _handleUpdate(u) {
    if (!u || typeof u !== 'object') return;
    if (u.message) this._handleMessage(u.message);
    else if (u.callback_query) this._handleCallback(u.callback_query);
  }

  _handleMessage(msg) {
    if (typeof msg.date === 'number' && msg.date < this._startedAtUnix - STALE_WINDOW_S) {
      this._log('warn', 'telegram_stale_update', {});
      return;
    }
    const chatId = msg.chat && String(msg.chat.id);
    const fromId = msg.from && String(msg.from.id);
    if (chatId !== this._chatId || fromId !== this._chatId) {
      const suffix = String(fromId || chatId || '').slice(-4);
      this._log('warn', 'telegram_unauthorized_access', { kind: 'message', id_suffix: suffix });
      return;
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (text === '/status') {
      try { this.emit('command:status', {}); } catch (_) {}
    } else if (text === '/stop') {
      try { this.emit('command:stop', {}); } catch (_) {}
    }
  }

  _handleCallback(cq) {
    const msg = cq.message;
    if (msg && typeof msg.date === 'number' && msg.date < this._startedAtUnix - STALE_WINDOW_S) {
      this._log('warn', 'telegram_stale_update', {});
      return;
    }
    const chatId = msg && msg.chat && String(msg.chat.id);
    const fromId = cq.from && String(cq.from.id);
    if (chatId !== this._chatId || fromId !== this._chatId) {
      const suffix = String(fromId || chatId || '').slice(-4);
      this._log('warn', 'telegram_unauthorized_access', { kind: 'callback_query', id_suffix: suffix });
      return;
    }
    const data = typeof cq.data === 'string' ? cq.data : '';
    const m = data.match(CALLBACK_RE);
    if (!m) {
      this._answerCallback(cq.id, 'Invalid');
      return;
    }
    const kind = m[1];
    const requestId = m[2];
    const entry = this._pending.get(requestId);
    const now = Date.now();
    if (!entry || entry.resolved || entry.expiresAt < now) {
      this._log('warn', 'telegram_stale_approval', {});
      this._answerCallback(cq.id, 'Already handled or expired');
      return;
    }
    // 1. Mark resolved synchronously
    entry.resolved = true;
    // 2. Emit
    const decision = kind === 'approve' ? 'APPROVE' : 'REJECT';
    try { this.emit('approval:resolved', { id: requestId, decision, reason: 'telegram_remote' }); } catch (_) {}
    // 3. Answer
    this._answerCallback(cq.id, decision === 'APPROVE' ? 'Approved' : 'Rejected');
    // 4. Edit
    const newText = decision === 'APPROVE' ? 'APPROVED via Telegram' : 'REJECTED via Telegram';
    this._editMessageText(String(this._chatId), entry.chatMessageId, newText, null);
    // 5. Clear timer and remove entry
    if (entry.timer) { try { clearTimeout(entry.timer); } catch (_) {} entry.timer = null; }
    this._pending.delete(requestId);
  }

  // -----------------------------------------------------------------------
  // Public: sending
  // -----------------------------------------------------------------------
  sendMessage(text) {
    if (!this.enabled) return Promise.resolve(false);
    const s = String(text == null ? '' : text).slice(0, MAX_MESSAGE_LEN);
    if (!s) return Promise.resolve(false);
    return this._enqueueSend(async () => {
      const r = await this._apiCall('sendMessage', {
        chat_id: this._chatId,
        text: s,
      });
      if (r && r.ok) return true;
      this._log('warn', 'telegram_send_failed', { error_code: r && r.error_code ? r.error_code : null });
      return false;
    });
  }

  sendApprovalRequest(opts) {
    if (!this.enabled) return Promise.resolve(false);
    const o = opts || {};
    const requestId = String(o.request_id == null ? '' : o.request_id);
    if (!REQUEST_ID_RE.test(requestId)) {
      this._log('warn', 'telegram_invalid_request_id', {});
      return Promise.resolve(false);
    }
    const modName = this._escape(String(o.module == null ? '' : o.module).slice(0, MAX_NAME_LEN));
    const action = this._escape(String(o.action == null ? '' : o.action).slice(0, MAX_NAME_LEN));
    const target = this._escape(String(o.target == null ? '' : o.target).slice(0, MAX_TARGET_LEN));
    const summary = this._escape(String(o.summary == null ? '' : o.summary).slice(0, MAX_SUMMARY_LEN));
    const expiresIn = Number(o.expires_in_ms) > 0 ? Number(o.expires_in_ms) : 60000;

    const text = [
      '<b>Approval Required</b>',
      `Module: ${modName}`,
      `Action: ${action}`,
      `Target: ${target}`,
      `Summary: ${summary}`,
    ].join('\n');

    const replyMarkup = {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `approve:${requestId}` },
        { text: 'Reject',  callback_data: `reject:${requestId}`  },
      ]],
    };

    return this._enqueueSend(async () => {
      const r = await this._apiCall('sendMessage', {
        chat_id: this._chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
      if (!r || !r.ok || !r.result || typeof r.result.message_id !== 'number') {
        this._log('warn', 'telegram_send_failed', { error_code: r && r.error_code ? r.error_code : null });
        return false;
      }
      const chatMessageId = r.result.message_id;
      const entry = {
        chatMessageId,
        expiresAt: Date.now() + expiresIn,
        resolved: false,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        if (entry.resolved) return;
        entry.resolved = true;
        entry.timer = null;
        this._editMessageText(String(this._chatId), entry.chatMessageId, 'Expired', null);
        this._pending.delete(requestId);
      }, expiresIn);
      if (entry.timer.unref) entry.timer.unref();
      this._pending.set(requestId, entry);
      return true;
    });
  }

  cancelApproval(requestId, reason) {
    if (!this.enabled) return false;
    const id = String(requestId == null ? '' : requestId);
    const entry = this._pending.get(id);
    if (!entry || entry.resolved) return false;
    entry.resolved = true;
    if (entry.timer) { try { clearTimeout(entry.timer); } catch (_) {} entry.timer = null; }
    this._pending.delete(id);
    const reasonStr = String(reason == null ? '' : reason).slice(0, MAX_CALLBACK_TEXT_LEN);
    this._editMessageText(String(this._chatId), entry.chatMessageId, `Resolved on PC: ${reasonStr}`, null);
    return true;
  }

  // -----------------------------------------------------------------------
  // Internal send helpers
  // -----------------------------------------------------------------------
  _answerCallback(callbackQueryId, text) {
    if (!callbackQueryId) return Promise.resolve(false);
    return this._enqueueSend(async () => {
      const r = await this._apiCall('answerCallbackQuery', {
        callback_query_id: String(callbackQueryId),
        text: String(text == null ? '' : text).slice(0, MAX_CALLBACK_TEXT_LEN),
      });
      return !!(r && r.ok);
    });
  }

  _editMessageText(chatId, messageId, text, replyMarkup) {
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text: String(text == null ? '' : text).slice(0, MAX_MESSAGE_LEN),
    };
    if (replyMarkup === null) {
      params.reply_markup = { inline_keyboard: [] };
    } else if (replyMarkup) {
      params.reply_markup = replyMarkup;
    }
    return this._enqueueSend(async () => {
      const r = await this._apiCall('editMessageText', params);
      return !!(r && r.ok);
    });
  }

  // -----------------------------------------------------------------------
  // Send queue (>= 1000 ms between sends; max 20; overflow dropped)
  // -----------------------------------------------------------------------
  _enqueueSend(fn) {
    return new Promise((resolve) => {
      if (!this.enabled) { resolve(false); return; }
      if (this._sendQueue.length >= MAX_QUEUE) {
        this._log('warn', 'telegram_queue_full', {});
        resolve(false);
        return;
      }
      this._sendQueue.push({ fn, resolve });
      this._drainSendQueue();
    });
  }

  async _drainSendQueue() {
    if (this._sending || !this._sendQueue.length) return;
    const now = Date.now();
    const sinceLast = now - this._lastSendAt;
    if (sinceLast < SEND_INTERVAL_MS) {
      if (!this._sendTimer) {
        const wait = SEND_INTERVAL_MS - sinceLast;
        this._sendTimer = setTimeout(() => {
          this._sendTimer = null;
          this._drainSendQueue();
        }, wait);
        if (this._sendTimer.unref) this._sendTimer.unref();
      }
      return;
    }
    this._sending = true;
    const item = this._sendQueue.shift();
    let result = false;
    try { result = await item.fn(); }
    catch (_) { result = false; }
    this._lastSendAt = Date.now();
    this._sending = false;
    try { item.resolve(result); } catch (_) {}
    if (this._sendQueue.length) this._drainSendQueue();
  }
}

module.exports = { TelegramBridge };