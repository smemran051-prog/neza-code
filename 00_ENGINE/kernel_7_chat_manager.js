'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// kernel_5 এর ask ফাংশনটি ব্যবহার করে সামারাইজ করা হবে
const { ask } = require('./kernel_5_brain_router');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const SESSIONS_DIR = path.join(ROOT, '00_ENGINE', 'Chat_sessions');
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

module.exports = {
  name: 'chat_manager',

  init(ctx) {
    // ১. সেশন ফোল্ডার তৈরি
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    if (!fs.existsSync(INDEX_FILE)) {
      fs.writeFileSync(INDEX_FILE, JSON.stringify([]));
    }

    // ২. UI থেকে নতুন চ্যাট তৈরি করা
    ipcMain.handle('chat:new-session', async () => {
      const id = crypto.randomUUID();
      const newSession = { id, name: 'New Chat', createdAt: Date.now(), messages: [] };
      
      fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(newSession, null, 2));
      
      const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      index.push({ id, name: newSession.name, createdAt: newSession.createdAt });
      fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

      ctx.audit('info', 'chat_session_created', { id });
      return newSession;
    });

    // ৩. সব সেশনের লিস্ট দেখা (লাইব্রেরি)
    ipcMain.handle('chat:list-sessions', async () => {
      const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      return index.sort((a, b) => b.createdAt - a.createdAt);
    });

    // ৪. নির্দিষ্ট সেশন লোড করা
    ipcMain.handle('chat:load-session', async (event, id) => {
      const file = path.join(SESSIONS_DIR, `${id}.json`);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    });

    // ৫. সেশনে মেসেজ সেভ করা এবং অটো-সামারাইজেশন
    ipcMain.handle('chat:save-message', async (event, { id, message, model }) => {
      const file = path.join(SESSIONS_DIR, `${id}.json`);
      if (!fs.existsSync(file)) return false;

      const session = JSON.parse(fs.readFileSync(file, 'utf8'));
      session.messages.push(message);
      
      // --- Auto-Summarization Logic ---
      if (session.messages.length >= 200) {
        try {
          ctx.audit('info', 'chat_auto_summarizing', { id, count: session.messages.length });
          
          const toSummarize = session.messages.slice(0, 150);
          const remaining = session.messages.slice(150);
          
          const prompt = `Summarize this conversation briefly:\n${JSON.stringify(toSummarize)}`;
          
          // এখানে UI-তে সিলেক্ট করা মডেলটিই ব্যবহার করা হচ্ছে
          const summary = await ask(prompt, 'chat', model, null, 'ui');
          
          session.messages = [
            { role: 'system', content: `[Summary of past conversation]: ${summary}` },
            ...remaining
          ];
          ctx.audit('info', 'chat_auto_summarized', { id, newCount: session.messages.length });
        } catch (e) {
          ctx.audit('error', 'chat_summarize_failed', { id, error: String(e) });
        }
      }
      // ---------------------------------

      fs.writeFileSync(file, JSON.stringify(session, null, 2));
      return true;
    });

    // ৬. সেশনের নাম পরিবর্তন (Rename)
    ipcMain.handle('chat:rename-session', async (event, { id, newName }) => {
      const file = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(file)) {
        const session = JSON.parse(fs.readFileSync(file, 'utf8'));
        session.name = newName;
        fs.writeFileSync(file, JSON.stringify(session, null, 2));
      }
      const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      const item = index.find(i => i.id === id);
      if (item) item.name = newName;
      fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
      
      return true;
    });

    // ৭. সেশন ডিলিট করা
    ipcMain.handle('chat:delete-session', async (event, id) => {
      const file = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      
      let index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      index = index.filter(i => i.id !== id);
      fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
      
      ctx.audit('info', 'chat_session_deleted', { id });
      return true;
    });

    ctx.audit('info', 'chat_manager_ready', { folder: SESSIONS_DIR });
  }
};