'use strict';

/**
 * Tools Library backend (Electron main process).
 * Location: 00_ENGINE/tools_library/ipc_handlers.js
 *
 * Modified for NEZA Multi-Module Architecture.
 * Resolves paths directly from tools_index.json to support tools in 02_MODULES.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
const TOOLS_DIR = path.join(ROOT, '00_ENGINE', 'tools');
const INDEX_FILE = path.join(ROOT, '00_ENGINE', 'tools_index.json');
const TRASH_DIR = path.join(ROOT, 'work', 'tools_trash');

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IMPORT_BYTES = 1024 * 1024;
const REQUIRED_MARKERS = [
  { label: 'module.exports', re: /module\.exports\s*=/ },
  { label: 'name', re: /\bname\s*:/ },
  { label: 'description', re: /\bdescription\s*:/ },
  { label: 'risk', re: /\brisk\s*:/ },
  { label: 'execute', re: /\bexecute\b/ },
];

function fail(message, extra) {
  return Object.assign({ ok: false, error: message }, extra || {});
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

function note(audit, event) {
  if (typeof audit !== 'function') return;
  try {
    audit(Object.assign({ tool: 'tools_library', ts: new Date().toISOString() }, event));
  } catch (_) {}
}

function safeName(raw) {
  const base = String(raw || '').trim().replace(/\.js$/i, '');
  return NAME_RE.test(base) ? base : null;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path Resolver via Index
// ---------------------------------------------------------------------------
function resolveToolPathFromIndex(name) {
  const index = readJsonSafe(INDEX_FILE);
  if (index && Array.isArray(index.tools)) {
    const meta = index.tools.find(t => t.name === name);
    if (meta && meta.fullPath && fs.existsSync(meta.fullPath)) {
      return meta.fullPath;
    }
  }
  // Fallback to legacy
  const fallback = path.join(TOOLS_DIR, `${name}.js`);
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

// ---------------------------------------------------------------------------
// tools:list
// ---------------------------------------------------------------------------
function listTools(query, riskFilter) {
  const index = readJsonSafe(INDEX_FILE);
  const q = String(query || '').trim().toLowerCase();
  const risk = String(riskFilter || '').trim().toUpperCase();
  const tools = [];

  if (index && Array.isArray(index.tools)) {
    for (const item of index.tools) {
      if (risk && item.risk !== risk) continue;
      if (q) {
        const haystack = [item.name, item.description, ...(item.tags || []), item.source_module].join(' ').toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      tools.push(item);
    }
  }

  tools.sort((a, b) => a.description.localeCompare(b.description));
  return { ok: true, total: tools.length, indexed: tools.length > 0, tools };
}

// ---------------------------------------------------------------------------
// tools:inspect
// ---------------------------------------------------------------------------
function inspectTool(rawName) {
  const name = safeName(rawName);
  if (!name) return fail('Invalid tool name.');
  
  const file = resolveToolPathFromIndex(name);
  if (!file) return fail(`Tool not found: ${name}`);
  
  try {
    const content = fs.readFileSync(file, 'utf8');
    return { ok: true, name, fileName: `${name}.js`, content };
  } catch (err) {
    return fail(`Read failed: ${errText(err)}`);
  }
}

// ---------------------------------------------------------------------------
// tools:run
// ---------------------------------------------------------------------------
function sendLog(sender, tool, line) {
  try {
    if (sender && !sender.isDestroyed()) {
      sender.send('tools:log', { tool, line, ts: new Date().toISOString() });
    }
  } catch (_) {}
}

async function askApproval(deps, request) {
  if (typeof deps.requestApproval !== 'function') return false;
  try {
    return (await deps.requestApproval(request)) === true;
  } catch (_) {
    return false;
  }
}

async function runTool(rawName, args, sender, deps) {
  const name = safeName(rawName);
  if (!name) return fail('Invalid tool name.');
  
  const file = resolveToolPathFromIndex(name);
  if (!file) return fail(`Tool not found: ${name}`, { tool: name });

  let mod;
  try {
    delete require.cache[require.resolve(file)];
    mod = require(file);
  } catch (err) {
    return fail(`Load failed: ${errText(err)}`, { tool: name });
  }
  if (!mod || typeof mod.execute !== 'function') {
    return fail('This file does not export an execute() function.', { tool: name });
  }

  const risk = String(mod.risk || '').toUpperCase();
  if (risk === 'FORBIDDEN') return fail('FORBIDDEN tools cannot be run from the UI.', { tool: name });

  const mode = typeof deps.getMode === 'function' ? deps.getMode() : 'SEMI_AUTO';
  const runArgs = args && typeof args === 'object' ? args : {};

  if (risk === 'RISKY' && mode !== 'FULL_AUTO') {
    sendLog(sender, name, `⏸ waiting for user approval (risk: RISKY)...`);
    const approved = await askApproval(deps, { kind: 'run', tool: name, risk, args: runArgs });
    if (!approved) {
      sendLog(sender, name, `✖ execution denied by user.`);
      return fail('Run not approved.', { tool: name });
    }
  }

  const started = Date.now();
  note(deps.audit, { action: 'tool_run', tool_name: name, risk, mode });
  sendLog(sender, name, `▶ started (${risk || 'READ'}, mode ${mode})`);

  const baseCtx = {
    audit: deps.audit,
    source: 'tools_library_ui',
    log: (msg) => sendLog(sender, name, String(msg)),
  };

  let result;
  try {
    result = await mod.execute(runArgs, Object.assign({ approved: false }, baseCtx));

    if (result && result.approval_required) {
      sendLog(sender, name, `⏸ approval needed: ${result.error || 'destructive action'}`);
      const approved = await askApproval(deps, {
        kind: 'destructive',
        tool: name,
        reason: result.error || '',
        drives: result.drives || [],
      });
      if (!approved) {
        sendLog(sender, name, '✖ approval denied');
        return { ok: false, tool: name, result, duration_ms: Date.now() - started };
      }
      note(deps.audit, { action: 'destructive_approved', tool_name: name, drives: result.drives || [] });
      result = await mod.execute(runArgs, Object.assign({ approved: true }, baseCtx));
    }
  } catch (err) {
    sendLog(sender, name, `✖ error: ${errText(err)}`);
    return fail(errText(err), { tool: name, duration_ms: Date.now() - started });
  }

  const ms = Date.now() - started;
  sendLog(sender, name, `■ finished in ${ms} ms`);
  return { ok: !(result && result.ok === false), tool: name, result, duration_ms: ms };
}

// ---------------------------------------------------------------------------
// tools:import
// ---------------------------------------------------------------------------
function importTool(payload, audit) {
  const name = safeName(payload.fileName);
  if (!name) return fail('Invalid file name. Use letters, digits, "_" or "-" (max 64 characters).');

  const content = typeof payload.content === 'string' ? payload.content : '';
  if (!content.trim()) return fail('File content is empty.', { name });
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    return fail('File is larger than 1 MB.', { name });
  }

  const missing = REQUIRED_MARKERS.filter((m) => !m.re.test(content)).map((m) => m.label);
  if (missing.length > 0) {
    return fail(`Not a JARVIS tool. Missing: ${missing.join(', ')}.`, { name });
  }

  // Always drop imported tools into 00_ENGINE/tools/ first.
  // kernel_6_tool_librarian.js will automatically detect and move it to the correct block!
  const target = path.join(TOOLS_DIR, `${name}.js`);
  const exists = fs.existsSync(target) || resolveToolPathFromIndex(name) !== null;
  
  if (exists && payload.overwrite !== true) {
    return { ok: false, exists: true, name, error: 'A tool with this name already exists in the system.' };
  }

  try {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    
    // If it exists in a modular block, move the old one to trash before overwriting
    const existingPath = resolveToolPathFromIndex(name);
    if (existingPath && fs.existsSync(existingPath)) {
      fs.renameSync(existingPath, path.join(TRASH_DIR, `${stamp()}_${name}.replaced.js`));
    }

    fs.writeFileSync(target, content, 'utf8');
    note(audit, { action: 'tool_import', tool_name: name, replaced: exists });
    return { ok: true, name, file: target, replaced: exists };
  } catch (err) {
    return fail(`Import failed: ${errText(err)}`, { name });
  }
}

// ---------------------------------------------------------------------------
// tools:delete
// ---------------------------------------------------------------------------
function deleteTool(rawName, audit) {
  const name = safeName(rawName);
  if (!name) return fail('Invalid tool name.');
  
  const file = resolveToolPathFromIndex(name);
  if (!file) return fail(`Tool not found: ${name}`, { name });

  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const dest = path.join(TRASH_DIR, `${stamp()}_${name}.js`);
    fs.renameSync(file, dest);
    note(audit, { action: 'tool_delete', tool_name: name, trashed_to: dest });
    return { ok: true, name, trashed_to: dest };
  } catch (err) {
    return fail(`Delete failed: ${errText(err)}`, { name });
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
function register(ipcMain, deps) {
  const d = deps || {};
  const handlers = {
    'tools:list': (_event, p) => listTools((p || {}).query, (p || {}).risk),
    'tools:run': (event, p) => runTool((p || {}).name, (p || {}).args, event.sender, d),
    'tools:import': (_event, p) => importTool(p || {}, d.audit),
    'tools:delete': (_event, p) => deleteTool((p || {}).name, d.audit),
    'tools:inspect': (_event, p) => inspectTool((p || {}).name),
  };

  for (const channel of Object.keys(handlers)) {
    if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, payload) => {
      try {
        return await handlers[channel](event, payload);
      } catch (err) {
        return fail(errText(err));
      }
    });
  }
  return { channels: Object.keys(handlers) };
}

module.exports = { register, listTools, runTool, importTool, deleteTool, inspectTool };