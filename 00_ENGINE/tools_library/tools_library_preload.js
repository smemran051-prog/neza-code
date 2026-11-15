'use strict';

/**
 * Preload helper for the Tools Library.
 * Location: 00_ENGINE/tools_library/tools_library_preload.js
 *
 * Merge into the existing preload.js (inside its contextBridge section):
 *   const { exposeToolsLibrary } = require('./tools_library/tools_library_preload');
 *   exposeToolsLibrary(contextBridge, ipcRenderer);
 */

function exposeToolsLibrary(contextBridge, ipcRenderer) {
  contextBridge.exposeInMainWorld('toolsLibrary', {
    list: (query, risk) => ipcRenderer.invoke('tools:list', { query, risk }),
    run: (name, args) => ipcRenderer.invoke('tools:run', { name, args }),
    importTool: (fileName, content, overwrite) =>
      ipcRenderer.invoke('tools:import', { fileName, content, overwrite: overwrite === true }),
    deleteTool: (name) => ipcRenderer.invoke('tools:delete', { name }),
    onLog: (callback) => {
      const handler = (_event, message) => callback(message);
      ipcRenderer.on('tools:log', handler);
      return () => ipcRenderer.removeListener('tools:log', handler);
    },
  });
}

module.exports = { exposeToolsLibrary };
