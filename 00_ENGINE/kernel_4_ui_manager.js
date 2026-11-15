'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { register: registerToolsLibrary } = require('./tools_library/ipc_handlers');

module.exports = {
  name: 'ui_manager',
  init(ctx) {
    const manifestPath = path.join(process.env.JARVIS_ROOT || 'C:\\Jarvis_Core', '00_ENGINE', 'extensions.json');

    ipcMain.on('jarvis:add-extension', (event, fileName) => {
      try {
        // সিকিউরিটি ভ্যালিডেশন: ফাইলনেম শুধু .js দিয়ে শেষ হবে এবং কোনো '../' থাকবে না
        if (!/^[A-Za-z0-9_.-]+\.js$/.test(fileName) || fileName.includes('..')) {
          ctx.audit('warn', 'extension_add_invalid_name', { fileName });
          return;
        }

        const raw = fs.readFileSync(manifestPath, 'utf8');
        const json = JSON.parse(raw);

        if (!json.extensions) json.extensions = [];

        if (!json.extensions.includes(fileName)) {
          json.extensions.push(fileName);
          json.extensions.sort(); // A-Z সাজানো
          fs.writeFileSync(manifestPath, JSON.stringify(json, null, 2));
          ctx.audit('info', 'extension_added_via_ui', { fileName });
        }
      } catch (e) {
        ctx.audit('error', 'extension_add_failed', { error: String(e) });
      }
    });

    // Tools Library: tools:list, tools:run, tools:import, tools:delete
    // getMode and requestApproval are used only if the kernel provides them on ctx.
    // Until then: mode defaults to SEMI_AUTO and RISKY tools are denied from the UI.
    registerToolsLibrary(ipcMain, {
      getMode: () => (typeof ctx.getMode === 'function' ? ctx.getMode() : 'SEMI_AUTO'),
      requestApproval: (request) =>
        typeof ctx.requestApproval === 'function'
          ? ctx.requestApproval(request)
          : Promise.resolve(false),
      audit: (event) => ctx.audit('info', event.action || 'tools_library', event),
    });
  }
};
