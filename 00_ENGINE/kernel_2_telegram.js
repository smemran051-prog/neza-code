'use strict';

const { TelegramBridge } = require('./telegram_bridge');
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'telegram',

  init(ctx) {
    const settings = ctx.settings;

    // 1. UI থেকে সেটিংস সেভ করার লিসেনার
    ipcMain.on('jarvis:save-telegram-config', (event, data) => {
      try {
        const settingsPath = path.join(process.env.JARVIS_ROOT || 'C:\\Jarvis_Core', '01_CONFIG', 'settings.json');
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const settingsJson = JSON.parse(raw);
        
        if (!settingsJson.telegram) settingsJson.telegram = {};
        
        // টোকেন এবং চ্যাট আইডি ফাইলে সেভ করা
        if (data.token) {
          settingsJson.telegram.token = data.token;
          process.env.JARVIS_TG_TOKEN = data.token;
        }
        if (data.chatId) {
          settingsJson.telegram.master_chat_id = data.chatId;
          process.env.JARVIS_TG_CHAT_ID = String(data.chatId);
        }
        
        fs.writeFileSync(settingsPath, JSON.stringify(settingsJson, null, 2));
        ctx.audit('info', 'telegram_config_saved_via_ui', { chat_id: data.chatId });
      } catch (e) {
        ctx.audit('error', 'telegram_save_config_failed', { error: String(e) });
      }
    });

    // 2. Credentials রিড করা (প্রথমে env, তারপর settings.json)
    const token = process.env.JARVIS_TG_TOKEN || (settings.telegram && settings.telegram.token) || '';
    let chatId = settings.telegram && settings.telegram.master_chat_id != null
      ? settings.telegram.master_chat_id
      : null;
      
    if (chatId === null || chatId === undefined) {
      chatId = process.env.JARVIS_TG_CHAT_ID || null;
    }
    
    if (chatId !== null && chatId !== undefined) {
      process.env.JARVIS_TG_CHAT_ID = String(chatId);
    }

    if (!token || chatId === null || chatId === undefined) {
      ctx.audit('warn', 'telegram_disabled', { reason: 'missing_credentials' });
      return;
    }

    // 3. Initialize Bridge
    let bridge;
    try {
      bridge = new TelegramBridge({
        audit: (lvl, ev, data) => ctx.audit(lvl, ev, data),
      });
    } catch (e) {
      ctx.audit('error', 'telegram_constructor_failed', { error: String(e) });
      return;
    }

    if (!bridge.enabled) {
      ctx.audit('warn', 'telegram_disabled', { reason: 'bridge_disabled' });
      return;
    }

    // 4. Commands
    bridge.on('command:status', () => {
      const state = ctx.getState();
      const ramMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
      const text = [
        `Mode: ${state.mode}`,
        `Presence: ${state.presence}`,
        `RAM: ${ramMb} MB`,
        `os_hands: ${state.os_hands_ready ? 'READY' : 'DEAD'}`,
      ].join('\n');
      Promise.resolve(bridge.sendMessage(text)).catch(() => {});
    });

    bridge.on('command:stop', () => {
      ctx.audit('warn', 'telegram_stop_command', {});
      ctx.emergencyStop('telegram_remote_stop');
    });

    // 5. Approval Provider
    ctx.addApprovalProvider({
      name: 'telegram',
      request: (req) => new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          try { bridge.removeListener('approval:resolved', handler); } catch (_) {}
          resolve(v);
        };
        const handler = (data) => {
          if (data && data.id === req.id) {
            finish({ decision: data.decision, reason: data.reason || 'telegram_remote' });
          }
        };
        bridge.on('approval:resolved', handler);
        Promise.resolve(bridge.sendApprovalRequest({
          request_id: req.id,
          module: req.module,
          action: req.action,
          target: req.target,
          summary: req.summary,
          expires_in_ms: req.expires_in_ms,
        })).then((sent) => {
          if (!sent) finish({ decision: 'REJECT', reason: 'send_failed' });
        }).catch(() => finish({ decision: 'REJECT', reason: 'send_failed' }));
      }),
      cancel: (id, reason) => {
        try { bridge.cancelApproval(id, reason || 'Cancelled'); } catch (_) {}
      },
    });

    // 6. Hooks & State
    ctx.addStopHook('telegram', () => { try { bridge.stop(); } catch (_) {} });
    ctx.addStateContributor('telegram', () => ({ enabled: bridge.enabled }));
    ctx.registerService('telegram', bridge);

    // 7. Start Polling
    try { bridge.start(); }
    catch (e) { ctx.audit('error', 'telegram_start_failed', { error: String(e) }); }

    ctx.audit('info', 'telegram_started', {
      chat_id_suffix: String(chatId).slice(-4),
    });
  },
};