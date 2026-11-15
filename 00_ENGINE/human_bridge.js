'use strict';
/**
 * human_bridge.js: RISKY action approval gate (PC popup channel).
 *
 * - One approval window, reused. Shown only while a request is active.
 * - Only one request is visible at a time. Others wait in a queue (max MAX_QUEUE).
 * - Decisions: APPROVE | REJECT. Reasons: user | timeout | stop | window_closed |
 *   queue_full | window_failed.
 * - Only the approval window's webContents may respond, and only for the active id.
 * - Approve is refused if it arrives before MIN_APPROVE_MS after the popup is shown.
 * - Telegram is NOT here yet. `presence` is the hook it will use later.
 */
const { BrowserWindow, ipcMain } = require('electron');
const crypto = require('crypto');

const MAX_QUEUE = 5;
const MAX_SUMMARY = 300;
const MAX_TARGET = 200;
const MIN_APPROVE_MS = 1500;

class HumanBridge {
  constructor(opts) {
    this.windowFile = opts.windowFile;
    this.preloadFile = opts.preloadFile;
    this.audit = opts.audit;                       // (level, event, data) => void
    this.timeoutMs = opts.timeoutMs || 60000;
    this.presence = opts.presence || (() => 'UNKNOWN');
    this.isSensitive = opts.isSensitive || (() => false);
    this.queue = [];
    this.active = null;
    this.win = null;
    this.stopped = false;
    this._installed = false;
  }

  _clip(text, max) {
    const s = text == null ? '' : String(text);
    return s.length > max ? s.slice(0, max - 1) + '...' : s;
  }

  /**
   * Ask the user. Resolves with { id, decision, reason }. Never rejects.
   */
  request({ module, action, target, risk_level, summary }) {
    this._install();
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const sensitive = this.isSensitive(`${action} ${target}`);
      const req = {
        id,
        module: this._clip(module, 64),
        action: this._clip(action, 64),
        target: sensitive ? 'MASKED' : this._clip(target, MAX_TARGET),
        summary: sensitive ? 'MASKED' : this._clip(summary, MAX_SUMMARY),
        risk_level: risk_level || 'RISKY',
        t0: Date.now(),
        shownAt: 0,
        resolve,
        timer: null,
      };
      this.audit('info', 'approval_requested', {
        request_id: id, module: req.module, action: req.action,
        risk_level: req.risk_level, target: req.target, presence: this.presence(),
      });
      if (this.stopped) return this._settle(req, 'REJECT', 'stop');
      if (this.queue.length >= MAX_QUEUE) return this._settle(req, 'REJECT', 'queue_full');
      this.queue.push(req);
      this._pump();
    });
  }

  /** Called by kernel on Tier-2/Tier-3 stop. Rejects everything and blocks new requests. */
  cancelAll(reason) {
    this.stopped = true;
    if (this.active) this._finish('REJECT', reason);
    while (this.queue.length) this._settle(this.queue.shift(), 'REJECT', reason);
    this._hideWindow();
  }

  _pump() {
    if (this.active || this.stopped || this.queue.length === 0) return;
    const next = this.queue.shift();
    this.active = next;
    next.timer = setTimeout(() => this._finish('REJECT', 'timeout'), this.timeoutMs);
    this._showWindow(next).catch((e) => {
      this.audit('error', 'approval_window_failed', { request_id: next.id, error: String(e) });
      this._finish('REJECT', 'window_failed');
    });
  }

  _finish(decision, reason) {
    const cur = this.active;
    if (!cur) return;
    this.active = null;
    clearTimeout(cur.timer);
    this._settle(cur, decision, reason);
    this._hideWindow();
    this._pump();
  }

  _settle(req, decision, reason) {
    this.audit('info', 'approval_resolved', {
      request_id: req.id, module: req.module, action: req.action,
      risk_level: req.risk_level, decision, reason, waited_ms: Date.now() - req.t0,
    });
    req.resolve({ id: req.id, decision, reason });
  }

  _install() {
    if (this._installed) return;
    this._installed = true;
    ipcMain.on('jarvis:approval-respond', (event, msg) => {
      if (!this.win || this.win.isDestroyed()) return;
      if (event.sender.id !== this.win.webContents.id) {
        this.audit('warn', 'approval_unauthorized_sender', { sender: event.sender.id });
        return;
      }
      if (!msg || typeof msg !== 'object' || !this.active) return;
      if (msg.id !== this.active.id) {
        this.audit('warn', 'approval_stale_response', { request_id: this._clip(msg.id, 64) });
        return;
      }
      if (msg.decision !== 'APPROVE' && msg.decision !== 'REJECT') return;
      if (msg.decision === 'APPROVE' && Date.now() - this.active.shownAt < MIN_APPROVE_MS) {
        this.audit('warn', 'approval_too_fast', { request_id: msg.id });
        return;
      }
      this._finish(msg.decision, 'user');
    });
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return Promise.resolve(this.win);

    const win = new BrowserWindow({
      width: 520, height: 380, show: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: false,
      backgroundColor: '#0B1220', title: 'JARVIS: Approval',
      webPreferences: {
        preload: this.preloadFile,
        contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      },
    });
    win.setMenu(null);
    win.on('close', (e) => {
      if (this.active) { e.preventDefault(); this._finish('REJECT', 'window_closed'); }
    });
    win.on('closed', () => { if (this.win === win) this.win = null; });
    this.win = win;

    const loaded = new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve(win));
      win.webContents.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`approval_load_failed:${code}:${desc}`)));
    });
    win.loadFile(this.windowFile);
    return loaded;
  }

  async _showWindow(req) {
    const win = await this._ensureWindow();
    if (!this.active || this.active.id !== req.id) return; // resolved while loading
    req.shownAt = Date.now();
    win.webContents.send('approval:show', {
      id: req.id,
      module: req.module,
      action: req.action,
      target: req.target,
      summary: req.summary,
      risk_level: req.risk_level,
      presence: this.presence(),
      timeout_ms: this.timeoutMs,
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show();
    win.focus();
  }

  _hideWindow() {
    if (!this.win || this.win.isDestroyed()) return;
    try { this.win.webContents.send('approval:hide'); } catch (_) {}
    this.win.hide();
  }
}

module.exports = { HumanBridge };