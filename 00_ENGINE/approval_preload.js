'use strict';
/**
 * Preload for the approval popup only. Exposes three functions and nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('approval', {
  onShow: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('approval:show', (_e, p) => cb(p));
  },
  onHide: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('approval:hide', () => cb());
  },
  respond: (id, decision) => {
    if (typeof id !== 'string' || id.length > 64) return;
    if (decision !== 'APPROVE' && decision !== 'REJECT') return;
    ipcRenderer.send('jarvis:approval-respond', { id, decision });
  },
});