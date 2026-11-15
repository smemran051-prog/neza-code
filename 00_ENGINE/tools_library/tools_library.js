/*
 * Tools Library UI (renderer). Location: 03_UI_DASHBOARD/tools_library.js
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
      addModalBtn: 'tl-add-modal-btn',
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
      addModal: 'tl-add-modal',
      modalDropzone: 'tl-modal-dropzone',
      newFilename: 'tl-new-filename',
      newCode: 'tl-new-code',
      addCancel: 'tl-add-cancel',
      addSave: 'tl-add-save',
      inspectModal: 'tl-inspect-modal',
      inspectTitle: 'tl-inspect-title',
      inspectCode: 'tl-inspect-code',
      inspectCopy: 'tl-inspect-copy',
      inspectClose: 'tl-inspect-close',
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
    ui.consoleTitle.textContent = `Live Console Output · ${name}`;
    ui.consoleBox.hidden = false;
  }

  function closeConsole() {
    state.activeTool = null;
    ui.consoleBox.hidden = true;
  }

  function onLog(message) {
    if (!message) return;
    if (state.activeTool && message.tool !== state.activeTool) return;
    const time = String(message.ts || '').slice(11, 19);
    appendLine(`[${time}] [${message.tool}] ${message.line}`);
  }

  // ---- Listing & TOC Grid ------------------------------------------------

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
    ui.count.textContent = `${res.total} tool(s) indexed`;
    showStatus('');
    renderGrid(res.tools);
  }

  function renderGrid(tools) {
    ui.grid.textContent = '';
    if (tools.length === 0) {
      ui.grid.appendChild(
        el('div', {
          class: 'tl-empty',
          text: 'No matching tools in 00_ENGINE/tools/. Click "+ Add Tool" or drag & drop a .js file here.',
        })
      );
      return;
    }
    for (const tool of tools) ui.grid.appendChild(renderCard(tool));
  }

  function renderCard(tool) {
    const badge = el('span', {
      class: `tl-badge ${RISK_CLASS[tool.risk] || 'tl-risk-none'}`,
      text: tool.risk || 'READ',
    });

    const runBtn = el('button', {
      class: 'tl-btn tl-run',
      type: 'button',
      text: '▶ Run Tool',
      onclick: () => onRun(tool),
    });

    const inspectBtn = el('button', {
      class: 'tl-btn tl-inspect',
      type: 'button',
      title: 'Inspect Tool Source Code',
      text: '📝 Inspect',
      onclick: () => onInspect(tool),
    });

    const delBtn = el('button', {
      class: 'tl-btn tl-del',
      type: 'button',
      title: 'Delete Tool',
      text: '🗑️',
      onclick: () => onDelete(tool),
    });

    const tags = el(
      'div',
      { class: 'tl-tags' },
      (tool.tags || []).map((t) =>
        el('span', {
          class: 'tl-tag',
          text: `#${t}`,
          onclick: () => {
            ui.search.value = t;
            state.query = t;
            refresh();
          },
        })
      )
    );

    return el('div', { class: 'tl-card', 'data-tool': tool.name }, [
      el('div', { class: 'tl-card-head' }, [el('span', { class: 'tl-name', text: tool.name }), badge]),
      el('div', { class: 'tl-desc', text: tool.description || '(no description)' }),
      tags,
      el('div', { class: 'tl-actions' }, [runBtn, inspectBtn, delBtn]),
    ]);
  }

  // ---- Direct Run --------------------------------------------------------

  async function onRun(tool) {
    let args = {};
    const raw = ui.args.value.trim();
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch (_) {
        showStatus('Args must be valid JSON, e.g. {"query": "test"}.', true);
        return;
      }
    }

    openConsole(tool.name);
    appendLine(`▶ Direct Run started: ${tool.name} (${tool.risk || 'READ'})`);
    let res;
    try {
      res = await global.toolsLibrary.run(tool.name, args);
    } catch (err) {
      appendLine(`✖ Execution Error: ${err.message}`);
      return;
    }
    appendLine(`✔ Result:\n${JSON.stringify(res, null, 2)}`);
  }

  // ---- Inspect -----------------------------------------------------------

  async function onInspect(tool) {
    if (typeof global.toolsLibrary.inspectTool !== 'function') {
      showStatus('Inspect bridge not available.', true);
      return;
    }
    try {
      const res = await global.toolsLibrary.inspectTool(tool.name);
      if (!res || !res.ok) {
        showStatus((res && res.error) || 'Could not inspect tool.', true);
        return;
      }
      ui.inspectTitle.textContent = `📝 ${res.fileName} (${tool.risk || 'READ'})`;
      ui.inspectCode.textContent = res.content || '';
      ui.inspectModal.style.display = 'flex';
    } catch (err) {
      showStatus(`Inspect failed: ${err.message}`, true);
    }
  }

  // ---- Delete ------------------------------------------------------------

  async function onDelete(tool) {
    if (!global.confirm(`Move "${tool.name}.js" to work/tools_trash?`)) return;
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
    showStatus(`🗑️ Moved ${tool.name}.js to trash.`);
    await refresh();
  }

  // ---- Import (Modal, Drop, File Picker, Clipboard) ----------------------

  async function importFromText(fileName, text) {
    let res;
    try {
      res = await global.toolsLibrary.importTool(fileName, text, false);
      if (res && res.exists) {
        if (!global.confirm(`"${res.name}" already exists in 00_ENGINE/tools/. Replace it?`)) {
          showStatus('Import cancelled.');
          return false;
        }
        res = await global.toolsLibrary.importTool(fileName, text, true);
      }
    } catch (err) {
      showStatus(`Import failed: ${err.message}`, true);
      return false;
    }
    if (!res || !res.ok) {
      showStatus(`Import failed: ${(res && res.error) || 'unknown error'}`, true);
      return false;
    }
    showStatus(`✅ Imported ${res.name}.js into 00_ENGINE/tools/`);
    await refresh();
    return true;
  }

  async function onDropFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.js$/i.test(f.name));
    if (files.length === 0) {
      showStatus('Only .js tool files can be imported.', true);
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
      ui.newCode.value = text;
      ui.addModal.style.display = 'flex';
      showStatus('Paste detected. Set a tool name in the modal to save.');
      return;
    }
    await importFromText(`${match[1]}.js`, text);
  }

  // ---- Events ------------------------------------------------------------

  function bindEvents() {
    ui.search.addEventListener('input', () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.query = ui.search.value;
        refresh();
      }, 120);
    });

    ui.risk.addEventListener('change', () => {
      state.risk = ui.risk.value;
      refresh();
    });

    ui.importBtn.addEventListener('click', () => ui.fileInput.click());

    ui.fileInput.addEventListener('change', async () => {
      await onDropFiles(ui.fileInput.files);
      ui.fileInput.value = '';
    });

    ui.pasteBtn.addEventListener('click', onPaste);

    // + Add Tool Modal
    ui.addModalBtn.addEventListener('click', () => {
      ui.addModal.style.display = 'flex';
    });
    ui.addCancel.addEventListener('click', () => {
      ui.addModal.style.display = 'none';
    });
    ui.addSave.addEventListener('click', async () => {
      const code = (ui.newCode.value || '').trim();
      let fname = (ui.newFilename.value || '').trim();
      if (!fname) {
        const m = code.match(/\bname\s*:\s*['"]([A-Za-z0-9_-]{1,64})['"]/);
        if (m) fname = `${m[1]}.js`;
      }
      if (!fname) {
        alert('Please enter a tool file name or include name: "..." in your module.exports.');
        return;
      }
      const ok = await importFromText(fname, code);
      if (ok) {
        ui.newFilename.value = '';
        ui.addModal.style.display = 'none';
      }
    });

    // Dropzone inside + Add Tool Modal
    ui.modalDropzone.addEventListener('click', () => ui.fileInput.click());
    ui.modalDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      ui.modalDropzone.classList.add('dragover');
    });
    ui.modalDropzone.addEventListener('dragleave', () => ui.modalDropzone.classList.remove('dragover'));
    ui.modalDropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      ui.modalDropzone.classList.remove('dragover');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /\.js$/i.test(f.name));
      if (files.length > 0) {
        ui.newFilename.value = files[0].name;
        ui.newCode.value = await files[0].text();
      }
    });

    // Inspect Modal
    ui.inspectClose.addEventListener('click', () => {
      ui.inspectModal.style.display = 'none';
    });
    ui.inspectCopy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(ui.inspectCode.textContent || '');
        ui.inspectCopy.textContent = '✅ Copied!';
        setTimeout(() => { ui.inspectCopy.textContent = '📋 Copy Code'; }, 1500);
      } catch (_) {}
    });

    // Console Drawer
    ui.consoleClear.addEventListener('click', () => {
      ui.consoleBody.textContent = '';
    });
    ui.consoleClose.addEventListener('click', closeConsole);

    // Grid Drag-and-Drop
    ui.grid.addEventListener('dragover', (event) => {
      event.preventDefault();
      ui.grid.classList.add('tl-drop');
    });
    ui.grid.addEventListener('dragleave', () => ui.grid.classList.remove('tl-drop'));
    ui.grid.addEventListener('drop', async (event) => {
      event.preventDefault();
      ui.grid.classList.remove('tl-drop');
      await onDropFiles(event.dataTransfer && event.dataTransfer.files);
    });

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