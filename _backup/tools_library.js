/*
 * Tools Library UI (renderer). Plain browser script, no bundler.
 * Location: 03_UI_DASHBOARD/tools_library.js
 *
 * Usage (once, after the page loads):
 *   ToolsLibraryUI.mount(document.getElementById('yourToolsPanelId'));
 *
 * Needs window.toolsLibrary (tools_library_preload.js). Builds its DOM only inside the
 * container you pass, and uses textContent everywhere (no innerHTML).
 */
(function (global) {
  'use strict';

  const RISK_CLASS = {
    READ: 'tl-risk-read',
    WRITE_SAFE: 'tl-risk-safe',
    RISKY: 'tl-risk-risky',
    FORBIDDEN: 'tl-risk-forbidden',
  };

  const state = {
    root: null,
    grid: null,
    search: null,
    riskSel: null,
    argsInput: null,
    count: null,
    status: null,
    consoleBox: null,
    consoleTitle: null,
    consoleBody: null,
    activeTool: null,
    query: '',
    risk: '',
    timer: null,
    unsubscribe: null,
  };

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

  function ensureStyles() {
    if (document.getElementById('tl-style')) return;
    document.head.appendChild(el('link', { id: 'tl-style', rel: 'stylesheet', href: 'tools_library.css' }));
  }

  function showStatus(message, isError) {
    state.status.textContent = message;
    state.status.className = isError ? 'tl-status tl-error' : 'tl-status';
  }

  function appendLine(line) {
    state.consoleBody.appendChild(document.createTextNode(`${line}\n`));
    state.consoleBody.scrollTop = state.consoleBody.scrollHeight;
  }

  function openConsole(name) {
    state.activeTool = name;
    state.consoleTitle.textContent = `Console · ${name}`;
    state.consoleBox.classList.remove('tl-hidden');
  }

  function closeConsole() {
    state.activeTool = null;
    state.consoleBox.classList.add('tl-hidden');
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
    state.count.textContent = `${res.total} tool(s)${res.indexed ? '' : ' · index not ready'}`;
    renderGrid(res.tools);
  }

  function renderGrid(tools) {
    state.grid.textContent = '';
    if (tools.length === 0) {
      state.grid.appendChild(el('div', { class: 'tl-empty', text: 'No tools match. Drop .js files here to import.' }));
      return;
    }
    for (const tool of tools) state.grid.appendChild(renderCard(tool));
  }

  function renderCard(tool) {
    const badge = el('span', {
      class: `tl-badge ${RISK_CLASS[tool.risk] || 'tl-risk-none'}`,
      text: tool.risk || 'NO RISK',
    });
    const runBtn = el('button', { class: 'tl-btn tl-run', type: 'button', text: '▶ Run', onclick: () => onRun(tool) });
    const delBtn = el('button', { class: 'tl-btn tl-del', type: 'button', text: '🗑 Delete', onclick: () => onDelete(tool) });
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
    const raw = state.argsInput.value.trim();
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
    state.grid.classList.remove('tl-drop');
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

  // ---- layout ------------------------------------------------------------

  function build() {
    state.search = el('input', { type: 'search', class: 'tl-search', placeholder: 'Search name, description or tag…' });
    state.search.addEventListener('input', () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.query = state.search.value;
        refresh();
      }, 150);
    });

    state.riskSel = el('select', { class: 'tl-risk' }, [
      el('option', { value: '', text: 'All risks' }),
      el('option', { value: 'READ', text: 'READ' }),
      el('option', { value: 'WRITE_SAFE', text: 'WRITE_SAFE' }),
      el('option', { value: 'RISKY', text: 'RISKY' }),
    ]);
    state.riskSel.addEventListener('change', () => {
      state.risk = state.riskSel.value;
      refresh();
    });

    state.argsInput = el('input', { type: 'text', class: 'tl-args', placeholder: 'Args JSON (optional)' });
    state.count = el('span', { class: 'tl-count', text: '' });
    state.status = el('div', { class: 'tl-status', text: '' });

    const fileInput = el('input', { type: 'file', accept: '.js', multiple: '', class: 'tl-hidden' });
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      for (const file of files) {
        await importFromText(file.name, await file.text());
      }
      fileInput.value = '';
    });

    const toolbar = el('div', { class: 'tl-toolbar' }, [
      state.search,
      state.riskSel,
      state.argsInput,
      el('button', { class: 'tl-btn', type: 'button', text: 'Import (+)', onclick: () => fileInput.click() }),
      el('button', { class: 'tl-btn', type: 'button', text: 'Paste code', onclick: onPaste }),
      state.count,
      fileInput,
    ]);

    state.grid = el('div', { class: 'tl-grid' });
    state.grid.addEventListener('dragover', (event) => {
      event.preventDefault();
      state.grid.classList.add('tl-drop');
    });
    state.grid.addEventListener('dragleave', () => state.grid.classList.remove('tl-drop'));
    state.grid.addEventListener('drop', onDrop);

    state.consoleTitle = el('span', { class: 'tl-console-title', text: '' });
    state.consoleBody = el('pre', { class: 'tl-console-body' });
    state.consoleBox = el('div', { class: 'tl-console tl-hidden' }, [
      el('div', { class: 'tl-console-head' }, [
        state.consoleTitle,
        el('button', { class: 'tl-btn', type: 'button', text: 'Clear', onclick: () => { state.consoleBody.textContent = ''; } }),
        el('button', { class: 'tl-btn', type: 'button', text: 'Close', onclick: closeConsole }),
      ]),
      state.consoleBody,
    ]);

    state.root = el('div', { class: 'tl-root-inner' }, [toolbar, state.status, state.grid, state.consoleBox]);
    return state.root;
  }

  function mount(container) {
    if (!container) throw new Error('ToolsLibraryUI.mount needs a container element.');
    if (!global.toolsLibrary) {
      throw new Error('window.toolsLibrary is missing. Expose tools_library_preload.js in preload.js.');
    }
    ensureStyles();
    if (state.unsubscribe) state.unsubscribe();

    container.textContent = '';
    container.appendChild(build());
    state.unsubscribe = global.toolsLibrary.onLog(onLog);

    // Stop Electron from navigating to a file dropped outside the grid.
    global.addEventListener('dragover', (event) => event.preventDefault());
    global.addEventListener('drop', (event) => {
      if (!state.grid || !state.grid.contains(event.target)) event.preventDefault();
    });

    refresh();
  }

  global.ToolsLibraryUI = { mount, refresh };
})(window);
