'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_SEND = new Set([
  'jarvis:emergency-stop', 'jarvis:request-status', 'jarvis:save-telegram-config',
  'jarvis:save-night-config', 'jarvis:add-extension', 'jarvis:save-ai-config', 'jarvis:ai-prompt',
  'jarvis:transcribe-audio',
  'gemini:start', 'gemini:stop', 'gemini:audio-chunk',
  'chat:new-session', 'chat:list-sessions', 'chat:load-session', 
  'chat:save-message', 'chat:rename-session', 'chat:delete-session',
  'tools:list', 'tools:run', 'tools:import', 'tools:delete', 'tools:inspect',
  'ollama:status'
]);

const ALLOWED_RECV = new Set([
  'jarvis:telemetry', 'jarvis:audit', 'jarvis:status', 'jarvis:ai-response', 'jarvis:ai-tool',
  'gemini:audio-reply',
  'tools:log'
]);

function safeOn(channel, cb) {
  if (!ALLOWED_RECV.has(channel)) throw new Error('blocked_recv:' + channel);
  if (typeof cb !== 'function') throw new Error('cb_required');
  ipcRenderer.on(channel, (_e, p) => { try { cb(p); } catch (_) {} });
}

function subscribe(channel, cb) {
  if (!ALLOWED_RECV.has(channel)) throw new Error('blocked_recv:' + channel);
  if (typeof cb !== 'function') throw new Error('cb_required');
  const handler = (_e, p) => { try { cb(p); } catch (_) {} };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function safeSend(channel, payload) {
  if (!ALLOWED_SEND.has(channel)) throw new Error('blocked_send:' + channel);
  ipcRenderer.send(channel, payload);
}

function safeInvoke(channel, ...args) {
  if (!ALLOWED_SEND.has(channel)) throw new Error('blocked_send:' + channel);
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('jarvis', {
  onTelemetry: (cb) => safeOn('jarvis:telemetry', cb),
  onAudit: (cb) => safeOn('jarvis:audit', cb),
  onStatus: (cb) => safeOn('jarvis:status', cb),
  onAIResponse: (cb) => safeOn('jarvis:ai-response', cb),
  onAITool: (cb) => safeOn('jarvis:ai-tool', cb),
  
  emergencyStop: () => safeSend('jarvis:emergency-stop'),
  requestStatus: () => safeSend('jarvis:request-status'),
  saveTelegramConfig: (t, c) => safeSend('jarvis:save-telegram-config', { token: t, chatId: c }),
  saveNightConfig: (c) => safeSend('jarvis:save-night-config', c),
  addExtension: (f) => safeSend('jarvis:add-extension', f),
  saveAiConfig: (c) => safeSend('jarvis:save-ai-config', c),
  askAI: (data) => safeSend('jarvis:ai-prompt', data),
  transcribeAudio: (data) => safeSend('jarvis:transcribe-audio', data),
  startGeminiLive: () => safeSend('gemini:start'),
  stopGeminiLive: () => safeSend('gemini:stop'),
  sendGeminiAudio: (base64Pcm) => safeSend('gemini:audio-chunk', base64Pcm),
  onGeminiAudio: (cb) => safeOn('gemini:audio-reply', cb),
  checkOllamaStatus: (cfg) => safeInvoke('ollama:status', cfg),

  newSession: () => safeInvoke('chat:new-session'),
  listSessions: () => safeInvoke('chat:list-sessions'),
  loadSession: (id) => safeInvoke('chat:load-session', id),
  saveMessage: (data) => safeInvoke('chat:save-message', data),
  renameSession: (data) => safeInvoke('chat:rename-session', data),
  deleteSession: (id) => safeInvoke('chat:delete-session', id),
});

contextBridge.exposeInMainWorld('toolsLibrary', {
  list: (query, risk) => safeInvoke('tools:list', { query, risk }),
  run: (name, args) => safeInvoke('tools:run', { name, args }),
  importTool: (fileName, content, overwrite) =>
    safeInvoke('tools:import', { fileName, content, overwrite: overwrite === true }),
  deleteTool: (name) => safeInvoke('tools:delete', { name }),
  inspectTool: (name) => safeInvoke('tools:inspect', { name }),
  onLog: (cb) => subscribe('tools:log', cb),
});