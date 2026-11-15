'use strict';

/**
 * Tools Library backend (Electron main process).
 * Location: 00_ENGINE/tools_library/ipc_handlers.js
 *
 * Register from an extension (kernel_4_ui_manager.js), not from kernel.js:
 *   require('./tools_library/ipc_handlers').register(ipcMain, {
 *     getMode: () => currentMode,            // 'SEMI_AUTO' | 'FULL_AUTO'
 *     requestApproval: async (req) => bool,   // wired to the existing approval popup
 *     audit: (event) => {}                    // optional, writes to the JSONL audit log
 *   });
 *
 * Channels: tools:list, tools:run, tools:import, tools:delete
 * Event sent to renderer: tools:log  { tool, line, ts }
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
  } catch (_) {
    // Logging never blocks an action.
  }
}

function safeName(raw) {
  const base = String(raw || '').trim().replace(/\.js$/i, '');
  return NAME_RE.test(base) ? base : null;
}

function toolFile(name) {
  return path.join(TOOLS_DIR, `${name}.js`);
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

// Accepts the index as an array, as { tools: [...] }, or as an object keyed by name.
function normalizeIndex(raw) {
  const out = new Map();
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.tools)) list = raw.tools;
  else if (raw && typeof raw === 'object') {
    list = Object.keys(raw).map((k) => Object.assign({ name: k }, raw[k]));
  }
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    out.set(name, {
      description: String(entry.description || ''),
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
      risk: String(entry.risk || ''),
    });
  }
  return out;
}

// Fallback when a tool is not in the index yet: read the metadata from its source text.
function metaFromSource(text) {
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  const tagBlock = text.match(/tags\s*:\s*\[([^\]]{0,2000})\]/);
  const tags = tagBlock
    ? tagBlock[1].split(',').map((t) => t.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean)
    : [];
  return {
    description: pick(/description\s*:\s*['"`]([^'"`]{0,400})['"`]/),
    risk: pick(/risk\s*:\s*['"]([A-Z_]+)['"]/),
    tags,
  };
}

// ---------------------------------------------------------------------------
// tools:list  (TOC grid + search + risk filter)
// ---------------------------------------------------------------------------
function listTools(query, riskFilter) {
  const index = normalizeIndex(readJsonSafe(INDEX_FILE));
  let files;
  try {
    files = fs.readdirSync(TOOLS_DIR).filter((f) => /\.js$/i.test(f)).sort();
  } catch (err) {
    return fail(`Tools folder unreadable: ${TOOLS_DIR} (${errText(err)})`);
  }

  const q = String(query || '').trim().toLowerCase();
  const risk = String(riskFilter || '').trim().toUpperCase();
  const tools = [];

  for (const file of files) {
    const name = file.replace(/\.js$/i, '');
    if (!NAME_RE.test(name)) continue;

    let meta = index.get(name);
    if (!meta) {
      try {
        meta = metaFromSource(fs.readFileSync(toolFile(name), 'utf8'));
      } catch (_) {
        meta = { description: '', risk: '', tags: [] };
      }
    }

    const item = {
      name,
      description: meta.description || '',
      risk: String(meta.risk || '').toUpperCase(),
      tags: meta.tags || [],
    };
    if (risk && item.risk !== risk) continue;
    if (q) {
      const haystack = [item.name, item.description, ...item.tags].join(' ').toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    tools.push(item);
  }

  return { ok: true, total: tools.length, indexed: index.size > 0, tools };
}

// ---------------------------------------------------------------------------
// tools:run  (direct execution with approval gate)
// ---------------------------------------------------------------------------
function sendLog(sender, tool, line) {
  try {
    if (sender && !sender.isDestroyed()) {
      sender.send('tools:log', { tool, line, ts: new Date().toISOString() });
    }
  } catch (_) {
    // Renderer may have closed; the run continues.
  }
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
  const file = toolFile(name);
  if (!fs.existsSync(file)) return fail(`Tool not found: ${name}`, { tool: name });

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
    const approved = await askApproval(deps, { kind: 'run', tool: name, risk, args: runArgs });
    if (!approved) return fail('Run not approved.', { tool: name });
  }

  const started = Date.now();
  note(deps.audit, { action: 'tool_run', tool_name: name, risk, mode });
  sendLog(sender, name, `▶ started (${risk || 'NO_RISK'}, mode ${mode})`);

  const baseCtx = { audit: deps.audit, source: 'tools_library_ui' };
  let result;
  try {
    result = await mod.execute(runArgs, Object.assign({ approved: false }, baseCtx));

    // A tool asked for a destructive-action approval (e.g. drive format on an internal drive).
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
// tools:import  (add a tool file; overwrite moves the old file to trash)
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

  const target = toolFile(name);
  const exists = fs.existsSync(target);
  if (exists && payload.overwrite !== true) {
    return { ok: false, exists: true, name, error: 'A tool with this name already exists.' };
  }

  try {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    if (exists) {
      fs.renameSync(target, path.join(TRASH_DIR, `${stamp()}_${name}.replaced.js`));
    }
    fs.writeFileSync(target, content, 'utf8');
    note(audit, { action: 'tool_import', tool_name: name, replaced: exists });
    return { ok: true, name, file: target, replaced: exists };
  } catch (err) {
    return fail(`Import failed: ${errText(err)}`, { name });
  }
}

// ---------------------------------------------------------------------------
// tools:delete  (moves the file to work/tools_trash, so it can be restored)
// ---------------------------------------------------------------------------
function deleteTool(rawName, audit) {
  const name = safeName(rawName);
  if (!name) return fail('Invalid tool name.');
  const file = toolFile(name);
  if (!fs.existsSync(file)) return fail(`Tool not found: ${name}`, { name });

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

module.exports = { register, listTools, runTool, importTool, deleteTool };
