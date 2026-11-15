'use strict';

/**
 * kernel_3_night_mode.js — Night Mode Extension for JARVIS-CORE.
 * 
 * Uses the Zero-Patch approach:
 *   - Adds an Approval Provider that instantly REJECTS all RISKY actions during night hours.
 *   - Silently ignores actions during the day (letting PC/Telegram handle them).
 *   - Sends a Morning Summary via Telegram at the configured time.
 *   - Configuration is saved to settings.json via IPC from the UI.
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'night_mode',
  _timer: null,
  _config: null,
  _ctx: null,

  init(ctx) {
    this._ctx = ctx;
    
    // 1. লোড ডিফল্ট কনফিগারেশন (যদি settings.json-এ না থাকে)
    this._config = ctx.settings.night_mode || {
      enabled: true,
      start_time: '23:00',
      end_time: '07:00',
      summary_time: '07:05'
    };

    const settingsPath = path.join(process.env.JARVIS_ROOT || 'C:\\Jarvis_Core', '01_CONFIG', 'settings.json');

    // 2. UI থেকে সেটিংস সেভ করার লিসেনার
    ipcMain.on('jarvis:save-night-config', (event, data) => {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const json = JSON.parse(raw);
        json.night_mode = data;
        fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2));
        
        this._config = data; // মেমরিতে আপডেট
        ctx.audit('info', 'night_mode_config_saved', data);
      } catch (e) {
        ctx.audit('error', 'night_mode_save_failed', { error: String(e) });
      }
    });

    // 3. নাইট মোড রাত-গেট (The Zero-Patch Trick)
    ctx.addApprovalProvider({
      name: 'night_mode_guard',
      request: (req) => {
        if (this._isNightTime()) {
          ctx.audit('warn', 'night_mode_blocked_action', { action: req.action, module: req.module });
          // রাতে হলে সাথে সাথে রিজেক্ট (কোনো পপ-আপ আসবে না)
          return Promise.resolve({ decision: 'REJECT', reason: 'night_mode_active' });
        }
        // দিনে হলে চুপ থাকবে, যাতে PC বা Telegram উত্তর দিতে পারে
        return new Promise(() => {}); 
      }
    });

    // 4. সামারি টাইমার (প্রতি ১ মিনিটে চেক করবে)
    this._timer = setInterval(() => this._checkSummary(), 60000);

    // 5. স্টপ হুক (মেমরি ক্লিনআপ)
    ctx.addStopHook('night_mode', () => {
      if (this._timer) clearInterval(this._timer);
    });

    ctx.audit('info', 'night_mode_initialized', { config: this._config });
  },

  // বর্তমান সময় নাইট মোডের ভেতরে আছে কিনা চেক করা
  _isNightTime() {
    if (!this._config || !this._config.enabled) return false;
    
    // HH:MM ফরম্যাট ভ্যালিডেট করা
    if (!/^\d{2}:\d{2}$/.test(this._config.start_time) || !/^\d{2}:\d{2}$/.test(this._config.end_time)) {
      return false; 
    }

    const now = new Date();
    const curMins = now.getHours() * 60 + now.getMinutes();
    
    const [sh, sm] = this._config.start_time.split(':').map(Number);
    const [eh, em] = this._config.end_time.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;

    if (startMins <= endMins) {
      // যেমন: 01:00 থেকে 06:00
      return curMins >= startMins && curMins < endMins;
    } else {
      // যেমন: 23:00 থেকে 07:00 (মধ্যরাত ক্রস করে)
      return curMins >= startMins || curMins < endMins;
    }
  },

  // সামারি পাঠানোর সময় হয়েছে কিনা চেক করা
  _checkSummary() {
    if (!this._config || !this._config.enabled || !this._config.summary_time) return;
    
    const now = new Date();
    const curTime = now.toTimeString().slice(0, 5); // "HH:MM"
    if (curTime !== this._config.summary_time) return;

    // ডুপ্লিকেট সামারি ব্লক করতে মার্কার ফাইল
    const today = now.toISOString().slice(0, 10); // UTC Date
    const markerPath = path.join(process.env.JARVIS_ROOT || 'C:\\Jarvis_Core', 'logs', '.last_night_summary');
    
    if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8') === today) {
      return; // আজকের সামারি আগেই পাঠানো হয়েছে
    }

    this._sendMorningSummary(today);
  },

  // লগ ফাইল থেকে ডেটা এনে টেলিগ্রামে পাঠানো
  _sendMorningSummary(today) {
    try {
      const logsDir = path.join(process.env.JARVIS_ROOT || 'C:\\Jarvis_Core', 'logs');
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      
      let blockCount = 0;
      let errorCount = 0;
      
      // দুটি UTC ফাইল রিড (গতকাল এবং আজ)
      [yesterday, today].forEach(dateStr => {
        const f = path.join(logsDir, `${dateStr}.jsonl`);
        if (!fs.existsSync(f)) return;
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.event === 'night_mode_blocked_action') blockCount++;
            if (entry.level === 'error') errorCount++;
          } catch (_) {}
        }
      });

      // টেলিগ্রাম সার্ভিস খোঁজা
      const tgBridge = this._ctx.getService('telegram');
      if (tgBridge && tgBridge.enabled) {
        const text = `🌅 <b>JARVIS Morning Summary</b>\n\n` +
                     `🔒 Blocked RISKY actions: ${blockCount}\n` +
                     `⚠️ Errors: ${errorCount}\n\n` +
                     `<i>System is back in normal mode.</i>`;
        tgBridge.sendMessage(text).catch(() => {});
      }

      // মার্কার ফাইল আপডেট
      const markerPath = path.join(process.env.JARVIS_ROOT || 'C:\\Jarvis_Core', 'logs', '.last_night_summary');
      fs.writeFileSync(markerPath, today);
      
      this._ctx.audit('info', 'night_mode_summary_sent', { blockCount, errorCount });

    } catch (e) {
      this._ctx.audit('error', 'night_mode_summary_failed', { error: String(e) });
    }
  }
};