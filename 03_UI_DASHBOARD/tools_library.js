/*
 * Tools Library UI (renderer). Location: 03_UI_DASHBOARD/tools_library.js
 *
 * Binds to the static markup in index.html (ids tl-*) and starts by itself.
 * It is an external script, so it works under the CSP (script-src 'self').
 * Needs window.toolsLibrary from preload.js. Uses textContent only (no innerHTML).
 */
(function (global) {
  'use strict';

  const RISK_CLASS = {
    READ: 'tl-risk-read',
    WRITE_SAFE: 'tl-risk-safe',
    RISKY: 'tl-risk-risky',
    FORBIDDEN: 'tl-risk-forbidden',
  };

  const ui = {};
  const state = { query: '', risk: '', timer: null, activeTool: null, unsubscribe: null };

  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      for (const key of Object.keys(opts)) {
        const value = opts[key];
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2), value);
        } else node.setAttribute(key, value);
      }
    }
    for (const child of children || []) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function collect() {
    const map = {
      count: 'tl-count',
      search: 'tl-search',
      risk: 'tl-risk',
      args: 'tl-args',
      importBtn: 'tl-import-btn',
      pasteBtn: 'tl-paste-btn',
      fileInput: 'tl-file-input',
      status: 'tl-status',
      grid: 'tl-grid',
      consoleBox: 'tl-console',
      consoleTitle: 'tl-console-title',
      consoleBody: 'tl-console-body',
      consoleClear: 'tl-console-clear',
      consoleClose: 'tl-console-close',
    };
    const missing = [];
    for (const key of Object.keys(map)) {
      ui[key] = document.getElementById(map[key]);
      if (!ui[key]) missing.push(map[key]);
    }
    return missing;
  }

  function showStatus(message, isError) {
    ui.status.textContent = message;
    ui.status.className = isError ? 'tl-status tl-error' : 'tl-status';
  }

  function appendLine(line) {
    ui.consoleBody.appendChild(document.createTextNode(`${line}\n`));
    ui.consoleBody.scrollTop = ui.consoleBody.scrollHeight;
  }

  function openConsole(name) {
    state.activeTool = name;
    ui.consoleTitle.textContent = `Console · ${name}`;
    ui.consoleBox.hidden = false;
  }

  function closeConsole() {
    state.activeTool = null;
    ui.consoleBox.hidden = true;
  }

  function onLog(message) {
    if (!message || message.tool !== state.activeTool) return;
    const time = String(message.ts || '').slice(11, 19);
    appendLine(`[${time}] ${message.line}`);
  }

  // ---- listing -----------------------------------------------------------

  async function refresh() {
    let res;
    try {
      res = await global.toolsLibrary.list(state.query, state.risk);
    } catch (err) {
      showStatus(`List failed: ${err.message}`, true);
      return;
    }
    if (!res || !res.ok) {
      showStatus((res && res.error) || 'List failed.', true);
      return;
    }
    ui.count.textContent = `${res.total} tool(s)${res.indexed ? '' : ' · index not ready'}`;
    showStatus('');
    renderGrid(res.tools);
  }

  function renderGrid(tools) {
    ui.grid.textContent = '';
    if (tools.length === 0) {
      ui.grid.appendChild(el('div', { class: 'tl-empty', text: 'No tools match. Drop .js files here to import.' }));
      return;
    }
    for (const tool of tools) ui.grid.appendChild(renderCard(tool));
  }

  function renderCard(tool) {
    const badge = el('span', {
      class: `tl-badge ${RISK_CLASS[tool.risk] || 'tl-risk-none'}`,
      text: tool.risk || 'NO RISK',
    });
    const runBtn = el('button', { class: 'tl-btn tl-run', type: 'button', text: 'Run', onclick: () => onRun(tool) });
    const delBtn = el('button', { class: 'tl-btn tl-del', type: 'button', text: 'Delete', onclick: () => onDelete(tool) });
    const tags = el('div', { class: 'tl-tags' }, tool.tags.map((t) => el('span', { class: 'tl-tag', text: t })));

    return el('div', { class: 'tl-card', 'data-tool': tool.name }, [
      el('div', { class: 'tl-card-head' }, [el('span', { class: 'tl-name', text: tool.name }), badge]),
      el('div', { class: 'tl-desc', text: tool.description || '(no description)' }),
      tags,
      el('div', { class: 'tl-actions' }, [runBtn, delBtn]),
    ]);
  }

  // ---- run ---------------------------------------------------------------

  async function onRun(tool) {
    let args = {};
    const raw = ui.args.value.trim();
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch (_) {
        showStatus('Args must be valid JSON, for example {"query": "test"}.', true);
        return;
      }
    }

    openConsole(tool.name);
    appendLine(`▶ running ${tool.name} …`);
    let res;
    try {
      res = await global.toolsLibrary.run(tool.name, args);
    } catch (err) {
      appendLine(`✖ ${err.message}`);
      return;
    }
    appendLine(JSON.stringify(res, null, 2));
  }

  // ---- delete ------------------------------------------------------------

  async function onDelete(tool) {
    if (!global.confirm(`Move "${tool.name}" to trash? It can be restored from work/tools_trash.`)) return;
    let res;
    try {
      res = await global.toolsLibrary.deleteTool(tool.name);
    } catch (err) {
      showStatus(`Delete failed: ${err.message}`, true);
      return;
    }
    if (!res || !res.ok) {
      showStatus((res && res.error) || 'Delete failed.', true);
      return;
    }
    if (state.activeTool === tool.name) closeConsole();
    showStatus(`Moved ${tool.name} to trash.`);
    await refresh();
  }

  // ---- import (drop, file picker, paste) ---------------------------------

  async function importFromText(fileName, text) {
    let res;
    try {
      res = await global.toolsLibrary.importTool(fileName, text, false);
      if (res && res.exists) {
        if (!global.confirm(`"${res.name}" already exists. Replace it? The old file goes to trash.`)) {
          showStatus('Import cancelled.');
          return;
        }
        res = await global.toolsLibrary.importTool(fileName, text, true);
      }
    } catch (err) {
      showStatus(`Import failed: ${err.message}`, true);
      return;
    }
    if (!res || !res.ok) {
      showStatus(`Import failed: ${(res && res.error) || 'unknown error'}`, true);
      return;
    }
    showStatus(`Imported ${res.name}.`);
    await refresh();
  }

  async function onDrop(event) {
    event.preventDefault();
    ui.grid.classList.remove('tl-drop');
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || [])
      .filter((f) => /\.js$/i.test(f.name));
    if (files.length === 0) {
      showStatus('Only .js files can be imported.', true);
      return;
    }
    for (const file of files) {
      await importFromText(file.name, await file.text());
    }
  }

  async function onPaste() {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      showStatus(`Clipboard read failed: ${err.message}`, true);
      return;
    }
    const match = text.match(/\bname\s*:\s*['"]([A-Za-z0-9_-]{1,64})['"]/);
    if (!match) {
      showStatus('Clipboard has no tool name (name: "...") to use as the file name.', true);
      return;
    }
    await importFromText(`${match[1]}.js`, text);
  }

  // ---- wiring ------------------------------------------------------------

  function bindEvents() {
    ui.search.addEventListener('input', () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.query = ui.search.value;
        refresh();
      }, 150);
    });

    ui.risk.addEventListener('change', () => {
      state.risk = ui.risk.value;
      refresh();
    });

    ui.importBtn.addEventListener('click', () => ui.fileInput.click());

    ui.fileInput.addEventListener('change', async () => {
      const files = Array.from(ui.fileInput.files || []);
      for (const file of files) {
        await importFromText(file.name, await file.text());
      }
      ui.fileInput.value = '';
    });

    ui.pasteBtn.addEventListener('click', onPaste);

    ui.consoleClear.addEventListener('click', () => {
      ui.consoleBody.textContent = '';
    });
    ui.consoleClose.addEventListener('click', closeConsole);

    ui.grid.addEventListener('dragover', (event) => {
      event.preventDefault();
      ui.grid.classList.add('tl-drop');
    });
    ui.grid.addEventListener('dragleave', () => ui.grid.classList.remove('tl-drop'));
    ui.grid.addEventListener('drop', onDrop);

    // Stop Electron from navigating to a file dropped outside the grid.
    global.addEventListener('dragover', (event) => event.preventDefault());
    global.addEventListener('drop', (event) => {
      if (!ui.grid.contains(event.target)) event.preventDefault();
    });

    state.unsubscribe = global.toolsLibrary.onLog(onLog);
  }

  function init() {
    const missing = collect();
    if (missing.length > 0) {
      console.error('Tools Library: missing elements: ' + missing.join(', '));
      return;
    }
    if (!global.toolsLibrary) {
      showStatus('window.toolsLibrary is missing. Check that preload.js exposes it.', true);
      return;
    }
    try {
      bindEvents();
      refresh();
    } catch (err) {
      showStatus(`Tools Library failed to start: ${err.message}`, true);
      console.error(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.ToolsLibraryUI = { refresh: () => refresh() };
})(window);
