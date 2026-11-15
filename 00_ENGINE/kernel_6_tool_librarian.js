'use strict';

/**
 * kernel_6_tool_librarian.js — Dynamic Multi-Source Tool Retrieval + Auto-Block Provisioner (NEZA Edition)
 * 
 * - Automatically classifies & migrates tools dropped in 00_ENGINE/tools/ into 02_MODULES/<block>/tools/
 * - Self-provisions module.json and universal api.js gateways per block
 * - Scans both 00_ENGINE/tools/ and 02_MODULES/<any_block>/tools/
 * - Maintains 00_ENGINE/tools_index.json
 * - Provides AI-safe delivery (max 3 tools) to kernel_5, kernel_13, and kernel_15
 * - Dynamically watches folders for new tools (debounced)
 */

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const toolsIpcHandlers = require('./tools_library/ipc_handlers');
const scale = require('./tools_library/librarian_scale');
const vectorSearchEngine = require('./tools_library/librarian_vector_search');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
// Lock JARVIS_ROOT globally so migrated tools inside 02_MODULES/*/tools/ never break relative paths
process.env.JARVIS_ROOT = ROOT;

const ENGINE_DIR = path.join(ROOT, '00_ENGINE');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG');
const TOOLS_DIR = path.join(ENGINE_DIR, 'tools');
const MODULES_DIR = path.join(ROOT, '02_MODULES');
const INDEX_FILE = path.join(ENGINE_DIR, 'tools_index.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

const TOOL_FILE_RE = /^[A-Za-z0-9_.\-]+\.js$/;
const MAX_MATCHED_TOOLS = 3;
const MAX_TOOL_STEPS = 4;
const REQUEST_TIMEOUT_MS = 25000;
const FILE_WATCH_DEBOUNCE_MS = 2000;

let CTX = null;
let INDEX_CACHE = [];
const ACTIVE_WATCHERS = new Map();
let SYNC_DEBOUNCER = null;
let IS_AUTO_ROUTING = false;

// Protected blocks whose custom hand-written api.js must never be overwritten
const PROTECTED_BLOCKS = new Set(['memory_block', 'task_00_phase1_test']);

// Generalized Domain Classification Matrix (Rule 5)
const BLOCK_RULES = [
  {
    block: 'communication_block',
    defaultRisk: 'WRITE_SAFE',
    description: 'Omnichannel messaging and notification gateway (Telegram, WhatsApp, Email, Webhook).',
    capabilities: ['messaging', 'notifications', 'omnichannel_routing'],
    keywords: [
      'telegram', 'whatsapp', 'email', 'gmail', 'smtp', 'imap', 'discord',
      'slack', 'sms', 'webhook', 'notify', 'send message', 'chat bridge'
    ],
    imports: ['nodemailer', 'telegraf', 'whatsapp-web.js']
  },
  {
    block: 'iot_hardware_block',
    defaultRisk: 'RISKY',
    description: 'Physical hardware, serial port (COM), microcontroller, and sensor bridge.',
    capabilities: ['serial_communication', 'sensor_telemetry', 'hardware_control'],
    keywords: [
      'serialport', 'uart', 'com port', 'arduino', 'pico', 'esp32', 'modbus',
      'oscilloscope', 'rms', 'voltage', 'sensor', 'gpio', 'i2c', 'spi', 'ups'
    ],
    imports: ['serialport', 'usb', 'firmata']
  },
  {
    block: 'network_block',
    defaultRisk: 'READ',
    description: 'External web search, HTTP/REST fetching, DOM scraping, and browser automation.',
    capabilities: ['web_search', 'http_client', 'dom_scraping', 'api_gateway'],
    keywords: [
      'http', 'https', 'fetch', 'scrape', 'crawler', 'browser', 'url', 'web search',
      'google search', 'rest api', 'websocket', 'ping', 'dns', 'download', 'puppeteer'
    ],
    imports: ['http', 'https', 'net', 'dns', 'tls', 'dgram']
  },
  {
    block: 'data_block',
    defaultRisk: 'READ',
    description: 'Analytical engine for RAG indexing, AST decompilation, PDF/CSV/Excel parsing, and data transformation.',
    capabilities: ['rag_indexing', 'ast_analysis', 'document_parsing', 'data_transformation'],
    keywords: [
      'rag', 'knowledge index', 'bm25', 'ast', 'decompile', 'decompiler', 'inspect',
      'inspector', 'blueprint', 'pdf', 'excel', 'csv', 'xlsx', 'json', 'xml', 'yaml',
      'parse', 'parser', 'chunk', 'tokenize', 'search files', 'workspace search'
    ],
    imports: ['zlib', 'crypto']
  },
  {
    block: 'system_block',
    defaultRisk: 'WRITE_SAFE',
    description: 'Core OS operations, local file system management, CLI daemon, and hardware health.',
    capabilities: ['file_system', 'process_execution', 'os_automation', 'system_health'],
    keywords: [
      'cli', 'daemon', 'terminal', 'shell', 'powershell', 'cmd', 'process', 'kill',
      'exe', 'pyinstaller', 'gradle', 'apk', 'system health', 'ram', 'cpu', 'uptime',
      'registry', 'win32', 'os_hands', 'mouse', 'keyboard', 'screenshot', 'file', 'folder'
    ],
    imports: ['child_process', 'os', 'cluster', 'worker_threads']
  }
];

// ---------------------------------------------------------------------------
// 0. AUTO-CLASSIFIER & SELF-BUILDING BLOCK PROVISIONER
// ---------------------------------------------------------------------------
function generateUniversalBlockApi(blockName) {
  return `'use strict';

/**
 * PATH: 02_MODULES/${blockName}/api.js
 * DESC: Auto-Provisioned Universal Gateway for ${blockName}.
 */

const fs = require('fs');
const path = require('path');

if (!process.env.JARVIS_ROOT) {
  process.env.JARVIS_ROOT = path.resolve(__dirname, '..', '..');
}

function getContract() {
  const contractPath = path.join(__dirname, 'module.json');
  try {
    return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (_) {
    return { module_name: '${blockName}', default_risk_level: 'WRITE_SAFE', registered_tools: [] };
  }
}

async function executeTool(toolName, args = {}, context = {}) {
  const cleanName = String(toolName || '').replace(/\\.js$/i, '').trim();
  const toolPath = path.join(__dirname, 'tools', cleanName + '.js');

  if (!fs.existsSync(toolPath)) {
    throw new Error(\`Tool executable '\${cleanName}.js' missing in ${blockName}/tools/\`);
  }

  const resolved = require.resolve(toolPath);
  if (context && context.hotReload) {
    try { delete require.cache[resolved]; } catch (_) {}
  }

  const mod = require(resolved);
  if (!mod || typeof mod.execute !== 'function') {
    throw new Error(\`Tool '\${cleanName}' is missing a valid execute(args, ctx) function.\`);
  }

  return await mod.execute(args || {}, context);
}

module.exports = {
  executeTool,
  getContract,
};
`;
}

function classifyToolIntoBlock(mod, rawCode = '') {
  if (mod && typeof mod.block === 'string' && mod.block.trim()) {
    const explicit = mod.block.trim().toLowerCase();
    return explicit.endsWith('_block') ? explicit : `${explicit}_block`;
  }

  const nameText = String(mod?.name || '').toLowerCase();
  const descText = String(mod?.description || '').toLowerCase();
  const tagsText = Array.isArray(mod?.tags) ? mod.tags.join(' ').toLowerCase() : '';
  const codeLower = String(rawCode || '').toLowerCase();

  let bestBlock = 'system_block';
  let bestScore = 0;

  for (const rule of BLOCK_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (nameText.includes(kw)) score += 6;
      if (tagsText.includes(kw)) score += 5;
      if (descText.includes(kw)) score += 3;
    }
    for (const imp of rule.imports) {
      const re = new RegExp(`require\\s*\\(\\s*['"]${imp}['"]\\s*\\)`, 'i');
      if (re.test(codeLower)) score += 4;
    }
    if (score > bestScore) {
      bestScore = score;
      bestBlock = rule.block;
    }
  }

  // Fallback to scale.classifyTool category hint if score is 0
  if (bestScore === 0 && scale && typeof scale.classifyTool === 'function') {
    try {
      const cat = String(scale.classifyTool({ name: nameText, description: descText, tags: mod?.tags || [] }) || '').toUpperCase();
      if (cat.includes('NET') || cat.includes('WEB')) return 'network_block';
      if (cat.includes('DATA') || cat.includes('DOC') || cat.includes('RAG')) return 'data_block';
      if (cat.includes('COMM') || cat.includes('MSG') || cat.includes('SOCIAL')) return 'communication_block';
    } catch (_) {}
  }

  return bestBlock;
}

function ensureBlockStructure(blockName, toolNamesToRegister = []) {
  const blockDir = path.join(MODULES_DIR, blockName);
  const blockToolsDir = path.join(blockDir, 'tools');
  const contractPath = path.join(blockDir, 'module.json');
  const apiPath = path.join(blockDir, 'api.js');

  try {
    fs.mkdirSync(blockToolsDir, { recursive: true });
  } catch (_) {}

  const ruleDef = BLOCK_RULES.find((r) => r.block === blockName) || {
    block: blockName,
    defaultRisk: 'WRITE_SAFE',
    description: `Auto-provisioned modular block for ${blockName}`,
    capabilities: ['modular_tool_execution']
  };

  let contract = null;
  if (fs.existsSync(contractPath)) {
    try { contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')); } catch (_) { contract = null; }
  }

  if (!contract || typeof contract !== 'object') {
    contract = {
      module_name: blockName,
      version: '1.0.0',
      description: ruleDef.description,
      default_risk_level: ruleDef.defaultRisk,
      capabilities: ruleDef.capabilities,
      registered_tools: []
    };
  }

  if (!Array.isArray(contract.registered_tools)) {
    contract.registered_tools = [];
  }

  const mergedTools = [...new Set([...contract.registered_tools, ...toolNamesToRegister])].sort();
  if (!fs.existsSync(contractPath) || JSON.stringify(contract.registered_tools) !== JSON.stringify(mergedTools)) {
    contract.registered_tools = mergedTools;
    try { fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2), 'utf8'); } catch (_) {}
  }

  if (!PROTECTED_BLOCKS.has(blockName) && !fs.existsSync(apiPath)) {
    try { fs.writeFileSync(apiPath, generateUniversalBlockApi(blockName), 'utf8'); } catch (_) {}
  }

  return { blockDir, blockToolsDir, contractPath, apiPath };
}

function syncBlockContractExact(blockName, activeToolNames) {
  const contractPath = path.join(MODULES_DIR, blockName, 'module.json');
  if (!fs.existsSync(contractPath)) return;
  try {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const sorted = [...new Set(activeToolNames)].sort();
    if (JSON.stringify(contract.registered_tools) !== JSON.stringify(sorted)) {
      contract.registered_tools = sorted;
      fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2), 'utf8');
    }
  } catch (_) {}
}

/**
 * Automatically inspects any tool placed in 00_ENGINE/tools/ and routes it to 02_MODULES/<block>/tools/
 */
function autoRouteAndProvisionTools() {
  if (IS_AUTO_ROUTING) return;
  IS_AUTO_ROUTING = true;
  try {
    ensureBaseDirs();
    let files = [];
    try { files = fs.readdirSync(TOOLS_DIR); } catch (_) { return; }

    for (const file of files) {
      if (!TOOL_FILE_RE.test(file) || file.startsWith('_')) continue;
      const legacyFullPath = path.join(TOOLS_DIR, file);

      try {
        const st = fs.statSync(legacyFullPath);
        if (!st.isFile()) continue;
      } catch (_) { continue; }

      try {
        const rawCode = fs.readFileSync(legacyFullPath, 'utf8');
        const resolved = require.resolve(legacyFullPath);
        delete require.cache[resolved];
        const mod = require(resolved);

        if (!mod || typeof mod.name !== 'string' || typeof mod.execute !== 'function') {
          continue;
        }

        const toolName = mod.name.trim();
        if (!toolName) continue;

        const targetBlock = classifyToolIntoBlock(mod, rawCode);
        const { blockToolsDir } = ensureBlockStructure(targetBlock, [toolName]);
        const targetFilePath = path.join(blockToolsDir, file);

        // Atomic write to new modular block then remove from legacy 00_ENGINE/tools/
        fs.writeFileSync(targetFilePath, rawCode, 'utf8');
        try { delete require.cache[resolved]; } catch (_) {}
        fs.unlinkSync(legacyFullPath);

        CTX?.audit('info', 'librarian_tool_auto_routed', {
          tool: toolName,
          file,
          from: '00_ENGINE/tools',
          to_block: targetBlock
        });
      } catch (e) {
        CTX?.audit('warn', 'librarian_auto_route_skipped', {
          file,
          error: String(e.message).slice(0, 120)
        });
      }
    }
  } finally {
    IS_AUTO_ROUTING = false;
  }
}

// ---------------------------------------------------------------------------
// 1. GENERALIZED MULTI-SOURCE DISCOVERY (Rule 5)
// ---------------------------------------------------------------------------
function ensureBaseDirs() {
  if (!fs.existsSync(TOOLS_DIR)) {
    try { fs.mkdirSync(TOOLS_DIR, { recursive: true }); } catch (_) {}
  }
  if (!fs.existsSync(MODULES_DIR)) {
    try { fs.mkdirSync(MODULES_DIR, { recursive: true }); } catch (_) {}
  }
}

function discoverToolSources() {
  ensureBaseDirs();
  const sources = [];
  const seenDirs = new Set();

  const addSource = (sourceModule, dirPath) => {
    try {
      const resolved = path.resolve(dirPath);
      if (seenDirs.has(resolved)) return;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        seenDirs.add(resolved);
        sources.push({ source_module: sourceModule, dirPath: resolved });
      }
    } catch (_) {}
  };

  // 1. Dynamic Modular Blocks FIRST (02_MODULES/*/tools/) so modular blocks take priority
  try {
    if (fs.existsSync(MODULES_DIR)) {
      const moduleEntries = fs.readdirSync(MODULES_DIR, { withFileTypes: true });
      for (const dirent of moduleEntries) {
        if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
        const candidateToolsDir = path.join(MODULES_DIR, dirent.name, 'tools');
        addSource(dirent.name, candidateToolsDir);
      }
    }
  } catch (e) {
    CTX?.audit('warn', 'librarian_module_scan_failed', { error: String(e.message).slice(0, 120) });
  }

  // 2. Legacy Core Engine Tools (Staging / Fallback)
  addSource('00_ENGINE', TOOLS_DIR);

  return sources;
}

function resolveToolFilePath(meta) {
  if (!meta || typeof meta !== 'object') return '';
  if (typeof meta.fullPath === 'string' && meta.fullPath.trim()) {
    const candidate = path.isAbsolute(meta.fullPath) ? meta.fullPath : path.resolve(ROOT, meta.fullPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (typeof meta.file === 'string' && meta.file.trim()) {
    if (path.isAbsolute(meta.file) && fs.existsSync(meta.file)) return meta.file;
    if (meta.source_module && meta.source_module !== '00_ENGINE') {
      const candidate = path.join(MODULES_DIR, meta.source_module, 'tools', path.basename(meta.file));
      if (fs.existsSync(candidate)) return candidate;
    }
    const legacyCandidate = path.join(TOOLS_DIR, path.basename(meta.file));
    if (fs.existsSync(legacyCandidate)) return legacyCandidate;
  }
  return '';
}

function readExistingEnabledMap() {
  const map = new Map();
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.tools)) {
        for (const t of parsed.tools) {
          if (t && typeof t.name === 'string' && typeof t.enabled === 'boolean') {
            map.set(t.name, t.enabled);
          }
        }
      }
    }
  } catch (_) {}
  return map;
}

function syncToolsIndex() {
  ensureBaseDirs();

  // Auto-classify & migrate any newly pasted/uploaded tools in 00_ENGINE/tools/
  autoRouteAndProvisionTools();

  const enabledMap = readExistingEnabledMap();
  const sources = discoverToolSources();
  const entries = [];
  const seenToolNames = new Map();

  for (const source of sources) {
    let files = [];
    try { files = fs.readdirSync(source.dirPath); } catch (_) { continue; }

    const activeToolsInSource = [];

    for (const file of files) {
      if (!TOOL_FILE_RE.test(file)) continue;
      const fullPath = path.join(source.dirPath, file);

      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
      } catch (_) { continue; }

      try {
        const resolvedPath = require.resolve(fullPath);
        delete require.cache[resolvedPath];
        const mod = require(resolvedPath);

        if (!mod || typeof mod.name !== 'string' || typeof mod.execute !== 'function') {
          CTX?.audit('warn', 'librarian_invalid_tool_file', { file, source_module: source.source_module });
          continue;
        }

        const name = mod.name.trim();
        if (!name) continue;

        activeToolsInSource.push(name);

        if (seenToolNames.has(name)) {
          CTX?.audit('warn', 'librarian_duplicate_tool_skipped', { tool: name, kept_source: seenToolNames.get(name), skipped_source: source.source_module });
          continue;
        }
        seenToolNames.set(name, source.source_module);

        const description = String(mod.description || 'No description provided.').trim();
        const tags = Array.isArray(mod.tags) ? mod.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean) : [];
        const risk = ['READ', 'WRITE_SAFE', 'RISKY', 'FORBIDDEN'].includes(mod.risk) ? mod.risk : 'READ';
        const enabled = enabledMap.has(name) ? enabledMap.get(name) : true;
        const parameters = mod.parameters && typeof mod.parameters === 'object' ? mod.parameters : { type: 'object', properties: {} };

        const relativeToRoot = path.relative(ROOT, fullPath).replace(/\\/g, '/');

        entries.push({
          name, file, fileName: file, relativePath: relativeToRoot, fullPath,
          source_module: source.source_module, description, tags, risk, enabled, parameters,
        });
      } catch (e) {
        CTX?.audit('error', 'librarian_tool_load_error', { file, source_module: source.source_module, error: String(e.message).slice(0, 120) });
      }
    }

    // Keep module.json in sync with actual tools inside each modular block
    if (source.source_module !== '00_ENGINE') {
      ensureBlockStructure(source.source_module, activeToolsInSource);
      syncBlockContractExact(source.source_module, activeToolsInSource);
    }
  }

  entries.sort((a, b) => a.description.localeCompare(b.description));

  for (const entry of entries) {
    if (!entry.category) {
      try { entry.category = scale.classifyTool(entry); } catch (_) { entry.category = 'OTHER'; }
    }
  }

  try {
    scale.buildIndexes(entries);
    if (vectorSearchEngine && typeof vectorSearchEngine.buildVectors === 'function') {
      Promise.resolve(vectorSearchEngine.buildVectors(entries)).catch((e) => CTX?.audit('error', 'librarian_vector_build_failed', { error: String(e.message) }));
    }
  } catch (e) {
    CTX?.audit('error', 'librarian_scale_build_failed', { error: String(e.message).slice(0, 120) });
  }

  INDEX_CACHE = entries;
  const manifest = {
    version: '2.0.0',
    updated_at: new Date().toISOString(),
    total_tools: entries.length,
    sources: sources.map((s) => ({ source_module: s.source_module, path: path.relative(ROOT, s.dirPath).replace(/\\/g, '/') })),
    tools: entries.map((e) => ({
      name: e.name, file: e.file, fileName: e.fileName, relativePath: e.relativePath,
      source_module: e.source_module, description: e.description, tags: e.tags, risk: e.risk, category: e.category, enabled: e.enabled,
    })),
  };

  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(manifest, null, 2), 'utf8');
    CTX?.audit('info', 'librarian_index_synced', { total_tools: entries.length, sources_count: sources.length });
  } catch (e) {
    CTX?.audit('error', 'librarian_index_write_failed', { error: String(e.message).slice(0, 120) });
  }

  if (SYNC_DEBOUNCER) refreshFileWatchers();
  return entries;
}

// ---------------------------------------------------------------------------
// 2. DYNAMIC MULTI-DIRECTORY FILE WATCHING
// ---------------------------------------------------------------------------
function createDebouncer(fn, delayMs) {
  if (scale && typeof scale.Debouncer === 'function') return new scale.Debouncer(fn, delayMs);
  let timer = null;
  return {
    schedule() { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(); }, delayMs); },
    cancel() { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

function watchDirectory(dirPath, onTrigger) {
  const resolved = path.resolve(dirPath);
  if (ACTIVE_WATCHERS.has(resolved) || !fs.existsSync(resolved)) return;
  try {
    const watcher = fs.watch(resolved, { persistent: false }, (_eventType, filename) => {
      if (IS_AUTO_ROUTING) return;
      if (filename && (String(filename).endsWith('tools_index.json') || String(filename).endsWith('module.json'))) return;
      onTrigger();
    });
    watcher.on('error', () => { try { watcher.close(); } catch (_) {} ACTIVE_WATCHERS.delete(resolved); });
    ACTIVE_WATCHERS.set(resolved, watcher);
  } catch (_) {}
}

function refreshFileWatchers() {
  if (!SYNC_DEBOUNCER) return;
  const desiredDirs = new Set();
  const sources = discoverToolSources();
  for (const src of sources) desiredDirs.add(path.resolve(src.dirPath));
  if (fs.existsSync(MODULES_DIR)) desiredDirs.add(path.resolve(MODULES_DIR));

  for (const [watchedPath, watcher] of ACTIVE_WATCHERS.entries()) {
    if (!desiredDirs.has(watchedPath) || !fs.existsSync(watchedPath)) {
      try { watcher.close(); } catch (_) {}
      ACTIVE_WATCHERS.delete(watchedPath);
    }
  }

  for (const dirPath of desiredDirs) {
    watchDirectory(dirPath, () => {
      if (dirPath === path.resolve(MODULES_DIR)) {
        try { discoverToolSources().forEach((s) => watchDirectory(s.dirPath, () => SYNC_DEBOUNCER.schedule())); } catch (_) {}
      }
      SYNC_DEBOUNCER.schedule();
    });
  }
}

function closeAllWatchers() {
  if (SYNC_DEBOUNCER && typeof SYNC_DEBOUNCER.cancel === 'function') SYNC_DEBOUNCER.cancel();
  for (const [, watcher] of ACTIVE_WATCHERS.entries()) { try { watcher.close(); } catch (_) {} }
  ACTIVE_WATCHERS.clear();
}

// ---------------------------------------------------------------------------
// 3. AI DELIVERY CONTRACT & EXECUTION API
// ---------------------------------------------------------------------------
async function runViaBlockGatewayOrDirect(entry, args, toolCtx) {
  const sourceMod = entry.meta.source_module;
  if (sourceMod && sourceMod !== '00_ENGINE' && !PROTECTED_BLOCKS.has(sourceMod)) {
    const apiPath = path.join(MODULES_DIR, sourceMod, 'api.js');
    if (fs.existsSync(apiPath)) {
      try {
        const blockApi = require(apiPath);
        if (blockApi && typeof blockApi.executeTool === 'function') {
          const res = await blockApi.executeTool(entry.meta.name, args || {}, toolCtx);
          if (res && typeof res === 'object' && res.status === 'success' && res.data !== undefined) {
            return res.data;
          }
          return res;
        }
      } catch (gwErr) {
        CTX?.audit('warn', 'librarian_gateway_fallback', { tool: entry.meta.name, module: sourceMod, error: String(gwErr.message).slice(0, 120) });
      }
    }
  }
  return await entry.mod.execute(args || {}, toolCtx);
}

async function deliverToolsForAI(intent, maxToolsOrOptions = MAX_MATCHED_TOOLS) {
  if (INDEX_CACHE.length === 0) syncToolsIndex();
  let requestedMax = MAX_MATCHED_TOOLS;
  if (typeof maxToolsOrOptions === 'number') requestedMax = maxToolsOrOptions;
  else if (maxToolsOrOptions && typeof maxToolsOrOptions === 'object' && typeof maxToolsOrOptions.maxTools === 'number') requestedMax = maxToolsOrOptions.maxTools;

  const cappedMax = Math.max(1, Math.min(Number(requestedMax) || MAX_MATCHED_TOOLS, MAX_MATCHED_TOOLS));
  const matched = await searchRelevantTools(intent, cappedMax);
  const qualified = matched.slice(0, MAX_MATCHED_TOOLS);
  const { openAiSchemas, loadedMap } = loadMatchedToolModules(qualified);

  const deliveredTools = qualified.map((t, idx) => {
    const loaded = loadedMap.get(t.name);
    const params = loaded?.mod?.parameters || t.parameters || { type: 'object', properties: {} };
    const schemaObj = openAiSchemas[idx] || { type: 'function', function: { name: t.name, description: t.description, parameters: params } };
    return {
      type: 'function', function: schemaObj.function,
      name: t.name, description: t.description, parameters: schemaObj.function.parameters,
      risk: t.risk, score: t.score, source_module: t.source_module || '00_ENGINE',
    };
  });

  return { ok: true, intent: String(intent || '').slice(0, 200), total_found: deliveredTools.length, tools: deliveredTools, schemas: openAiSchemas.slice(0, MAX_MATCHED_TOOLS) };
}

async function executeToolByName(name, args = {}, execCtx = {}) {
  if (INDEX_CACHE.length === 0) syncToolsIndex();
  const meta = INDEX_CACHE.find((t) => t.name === name);
  if (!meta) return JSON.stringify({ error: 'tool_not_found', name });
  if (!meta.enabled) return JSON.stringify({ error: 'tool_disabled', name });

  const { loadedMap } = loadMatchedToolModules([meta]);
  const entry = loadedMap.get(name);
  if (!entry) return JSON.stringify({ error: 'tool_load_failed', name, source_module: meta.source_module });
  if (entry.meta.risk === 'FORBIDDEN') return JSON.stringify({ error: 'tool_forbidden', tool: name });
  if (entry.meta.risk === 'RISKY' && execCtx.approved !== true) return JSON.stringify({ error: 'risky_requires_voice_permission', tool: name });

  const signal = execCtx.signal || null;
  if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

  const base = CTX && typeof CTX === 'object' ? CTX : {};
  const toolCtx = Object.assign(Object.create(base), {
    signal, approved: execCtx.approved === true, callId: execCtx.callId || null, userQuery: execCtx.userQuery || '',
    source_module: entry.meta.source_module || '00_ENGINE', tool_dir: path.dirname(resolveToolFilePath(entry.meta)),
    throwIfAborted: () => { if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });

  try {
    const result = await runViaBlockGatewayOrDirect(entry, args || {}, toolCtx);
    CTX?.audit('info', 'librarian_tool_executed', { tool: name, source_module: entry.meta.source_module || '00_ENGINE', risk: entry.meta.risk, ok: true, callId: execCtx.callId || null });
    return JSON.stringify(result).slice(0, 15000);
  } catch (e) {
    if (e && e.name === 'AbortError') { CTX?.audit('warn', 'librarian_tool_aborted', { tool: name, callId: execCtx.callId || null }); throw e; }
    CTX?.audit('warn', 'librarian_tool_executed', { tool: name, ok: false, error: String(e.message) });
    return JSON.stringify({ error: String(e.message || 'execution_failed') });
  }
}

// ---------------------------------------------------------------------------
// 4. THE LIBRARIAN (Hybrid Search)
// ---------------------------------------------------------------------------
function tokenizePrompt(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9_\u0980-\u09FF\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
}

function enrichSearchMetadata(results) {
  if (!Array.isArray(results)) return [];
  return results.map((item) => {
    const cached = INDEX_CACHE.find((t) => t.name === item.name);
    if (!cached) return item;
    return { ...cached, ...item, source_module: item.source_module || cached.source_module || '00_ENGINE', fullPath: cached.fullPath, parameters: cached.parameters };
  });
}

function fallbackKeywordSearch(userPrompt, maxTools) {
  const tokens = tokenizePrompt(userPrompt);
  if (tokens.length === 0) return [];
  const promptLower = String(userPrompt || '').toLowerCase();
  const scored = [];
  for (const tool of INDEX_CACHE) {
    if (!tool.enabled) continue;
    let score = 0;
    if (promptLower.includes(tool.name.toLowerCase().replace(/_/g, ' ')) || promptLower.includes(tool.name.toLowerCase())) score += 10;
    for (const token of tokens) {
      if (tool.name.toLowerCase().includes(token)) score += 4;
      if (tool.tags.some((tag) => tag.includes(token))) score += 3;
      if (tool.description.toLowerCase().includes(token)) score += 2;
    }
    if (score > 0) scored.push({ ...tool, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxTools);
}

async function searchRelevantTools(userPrompt, maxTools = MAX_MATCHED_TOOLS) {
  if (INDEX_CACHE.length === 0) syncToolsIndex();
  const limit = Math.max(1, Math.min(Number(maxTools) || MAX_MATCHED_TOOLS, MAX_MATCHED_TOOLS));
  const KEYWORD_CONFIDENCE_THRESHOLD = 8;

  let keywordResults = [];
  if (scale && typeof scale.fastSearch === 'function') {
    try { keywordResults = enrichSearchMetadata(scale.fastSearch(userPrompt, limit)); } catch (_) {}
  }
  if (keywordResults.length === 0) keywordResults = fallbackKeywordSearch(userPrompt, limit);
  if (keywordResults.length > 0 && keywordResults[0].score >= KEYWORD_CONFIDENCE_THRESHOLD) return keywordResults.slice(0, limit);

  try {
    if (vectorSearchEngine && typeof vectorSearchEngine.vectorSearch === 'function') {
      const vectorRes = enrichSearchMetadata(await vectorSearchEngine.vectorSearch(userPrompt, limit));
      if (vectorRes && vectorRes.length > 0) {
        if (keywordResults.length > 0) {
          const merged = []; const seen = new Set();
          for (const item of [...vectorRes, ...keywordResults]) { if (!seen.has(item.name)) { seen.add(item.name); merged.push(item); } }
          return merged.slice(0, limit);
        }
        return vectorRes.slice(0, limit);
      }
    }
  } catch (_) {}
  return keywordResults.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 5. DELIVERY & RISK GATE
// ---------------------------------------------------------------------------
function loadMatchedToolModules(matchedItems) {
  const loadedMap = new Map();
  const openAiSchemas = [];
  for (const rawMeta of matchedItems) {
    const meta = INDEX_CACHE.find((t) => t.name === rawMeta.name) || rawMeta;
    const fullPath = resolveToolFilePath(meta);
    if (!fullPath || !fs.existsSync(fullPath)) {
      CTX?.audit('error', 'librarian_delivery_load_failed', { tool: meta?.name, error: 'resolved_path_not_found' });
      continue;
    }
    try {
      const resolvedPath = require.resolve(fullPath);
      delete require.cache[resolvedPath];
      const mod = require(resolvedPath);
      loadedMap.set(meta.name, { meta, mod, fullPath: resolvedPath });
      openAiSchemas.push({ type: 'function', function: { name: meta.name, description: meta.description, parameters: mod.parameters || meta.parameters || { type: 'object', properties: {} } } });
    } catch (e) {
      CTX?.audit('error', 'librarian_delivery_load_failed', { tool: meta.name, error: String(e.message) });
    }
  }
  return { loadedMap, openAiSchemas };
}

async function promptRiskyApproval(toolName, description, args) {
  if (CTX?.settings?.unattended === true) return false;
  const { response } = await dialog.showMessageBox({ type: 'warning', buttons: ['Deny', 'Approve'], defaultId: 0, cancelId: 0, message: `JARVIS Tool Permission Required: ${toolName}`, detail: `Risk Level: RISKY\nDescription: ${description}\nArguments: ${JSON.stringify(args || {})}` });
  return response === 1;
}

async function executeDeliveredTool(loadedMap, call) {
  const name = String(call?.function?.name || '');
  const entry = loadedMap.get(name);
  if (!entry) return JSON.stringify({ error: 'tool_not_in_delivery_bundle' });
  let args = {};
  try { args = typeof call?.function?.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call?.function?.arguments || {}); } catch (_) {}

  if (entry.meta.risk === 'FORBIDDEN') return JSON.stringify({ error: 'permission_forbidden' });
  if (entry.meta.risk === 'RISKY') {
    const approved = await promptRiskyApproval(name, entry.meta.description, args);
    if (!approved) return JSON.stringify({ error: 'permission_denied' });
  }

  const base = CTX && typeof CTX === 'object' ? CTX : {};
  const execCtx = Object.assign(Object.create(base), { source_module: entry.meta.source_module || '00_ENGINE', tool_dir: path.dirname(entry.fullPath), approved: true });

  try {
    const result = await runViaBlockGatewayOrDirect(entry, args, execCtx);
    CTX?.audit('info', 'librarian_tool_executed', { tool: name, source_module: entry.meta.source_module || '00_ENGINE', ok: true });
    return JSON.stringify(result).slice(0, 15000);
  } catch (e) {
    CTX?.audit('warn', 'librarian_tool_executed', { tool: name, ok: false, error: String(e.message) });
    return JSON.stringify({ error: String(e.message || 'execution_failed') });
  }
}

// ---------------------------------------------------------------------------
// 6. AI CALLER
// ---------------------------------------------------------------------------
function getActiveProviderConfig(requestedProvider) {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const json = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const providers = json.ai_providers || {};
    const order = ['groq', 'gemini', 'deepseek', 'openrouter', 'cerebras'];
    const list = requestedProvider && order.includes(requestedProvider) ? [requestedProvider, ...order.filter((p) => p !== requestedProvider)] : order;
    for (const name of list) {
      const cfg = providers[name];
      if (cfg && typeof cfg.key === 'string' && cfg.key.length > 8 && cfg.model && cfg.baseURL) return { name, ...cfg };
    }
  } catch (_) {}
  return null;
}

function callOpenAiCompatible(cfg, messages, tools) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`);
    const payload = { model: cfg.model, messages, temperature: 0.1 };
    if (tools && tools.length > 0) payload.tools = tools;
    const body = JSON.stringify(payload);

    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'JarvisCore/3.0', 'Authorization': `Bearer ${cfg.key}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP_${res.statusCode}: ${raw.slice(0, 140)}`));
        try {
          const parsed = JSON.parse(raw);
          const msg = parsed?.choices?.[0]?.message;
          if (!msg) throw new Error('empty_choices');
          resolve(msg);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 7. DIAGNOSTIC COMMANDS
// ---------------------------------------------------------------------------
function formatIndexSummary() {
  if (INDEX_CACHE.length === 0) syncToolsIndex();
  const lines = INDEX_CACHE.map((t, idx) => (
    `${idx + 1}. [${t.enabled ? 'ON' : 'OFF'}] ${t.name} (${t.risk}${t.category ? ' · ' + t.category : ''} · 🧩 ${t.source_module || '00_ENGINE'})\n   📖 ${t.description}\n   🏷️ Tags: ${t.tags.join(', ')}`
  ));
  return [`📚 NEZA / JARVIS Tools Library Index (${INDEX_CACHE.length} tools in 00_ENGINE/tools_index.json):`, '', ...lines, '', '💡 Try: "/tools test check my pc ram" or open the Tools Library tab!'].join('\n');
}

// ---------------------------------------------------------------------------
// 8. INTERCEPTOR
// ---------------------------------------------------------------------------
function installLibrarianInterceptor() {
  const existingListeners = ipcMain.listeners('jarvis:ai-prompt');
  if (existingListeners.length === 0) return;
  const brainRouterListener = existingListeners[0];
  ipcMain.removeAllListeners('jarvis:ai-prompt');

  ipcMain.on('jarvis:ai-prompt', async (event, data) => {
    const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';
    const mode = data?.mode || 'chat';
    const subMode = data?.subMode || 'assisted';

    if (/^\/tools(\b|\s)/i.test(prompt)) {
      const sub = prompt.replace(/^\/tools\s*/i, '').trim();
      if (sub.toLowerCase() === 'refresh') {
        syncToolsIndex();
        event.sender.send('jarvis:ai-response', { text: `✅ Auto-routed & re-scanned 00_ENGINE/tools/ + 02_MODULES/*/tools/ and updated index!\n\n${formatIndexSummary()}` });
        return;
      }
      if (/^test\s+/i.test(sub)) {
        const testQuery = sub.replace(/^test\s+/i, '').trim();
        const matched = await searchRelevantTools(testQuery, MAX_MATCHED_TOOLS);
        const text = matched.length === 0 ? `🔍 Search for "${testQuery}": No matching tools.` : [
          `🔍 Hybrid Search for: "${testQuery}"`, `✅ Selected Top ${matched.length} Tool(s):`,
          ...matched.map((m, i) => `  ${i + 1}. ${m.name} [Module: ${m.source_module || '00_ENGINE'}] (Score: ${m.score}, Risk: ${m.risk})`),
        ].join('\n');
        event.sender.send('jarvis:ai-response', { text });
        return;
      }
      event.sender.send('jarvis:ai-response', { text: formatIndexSummary() });
      return;
    }

    if (mode === 'tools' && prompt.length > 0) {
      const matched = await searchRelevantTools(prompt, MAX_MATCHED_TOOLS);
      const advisorContext = matched.length > 0 ? `\n\n[Librarian Advisor Note — Tools: ${matched.map((m) => `${m.name} (${m.source_module})`).join(' | ')}]` : '';
      brainRouterListener(event, { ...data, prompt: prompt + advisorContext });
      return;
    }

    const isBrowserOrUrlIntent = /\b(open|browse|visit|youtube|google|http:\/\/|https:\/\/|\.com|\.bd|\.org|\.net)\b/i.test(prompt);
    if (mode === 'task' && prompt.length > 0 && !isBrowserOrUrlIntent) {
      const matched = await searchRelevantTools(prompt, MAX_MATCHED_TOOLS);
      if (matched.length > 0 && matched[0].score >= 5) {
        const { loadedMap, openAiSchemas } = loadMatchedToolModules(matched);
        if (subMode === 'direct') {
          const topTool = matched[0];
          const out = await executeDeliveredTool(loadedMap, { function: { name: topTool.name, arguments: '{}' } });
          event.sender.send('jarvis:ai-response', { text: `🎯 [Direct Order · Tool: ${topTool.name} · Module: ${topTool.source_module || '00_ENGINE'}]\n\n${out}` });
          return;
        }
        const cfg = getActiveProviderConfig(data?.model);
        if (cfg && openAiSchemas.length > 0) {
          try {
            CTX?.audit('info', 'librarian_delivery_dispatched', { query: prompt.slice(0, 80), delivered_tools: matched.map((m) => `${m.source_module}:${m.name}`), provider: cfg.name });
            const messages = [{ role: 'system', content: `You are NEZA in TASK MODE. Librarian selected ${openAiSchemas.length} tool(s). Invoke them to solve the request.` }, { role: 'user', content: prompt }];
            let usedLibraryTool = false;
            for (let step = 0; step < MAX_TOOL_STEPS; step++) {
              const msg = await callOpenAiCompatible(cfg, messages, openAiSchemas);
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
              if (calls.length === 0) {
                if (usedLibraryTool) {
                  const badge = `📚 [Librarian Executed: ${matched.map((m) => `${m.name} (${m.source_module})`).join(', ')}]\n\n`;
                  event.sender.send('jarvis:ai-response', { text: badge + (msg.content || 'Done.') });
                  return;
                }
                break;
              }
              usedLibraryTool = true;
              messages.push(msg);
              for (const call of calls) {
                const out = await executeDeliveredTool(loadedMap, call);
                messages.push({ role: 'tool', tool_call_id: String(call.id || ''), content: out });
              }
            }
          } catch (e) {
            CTX?.audit('warn', 'librarian_task_fallback_to_brain', { error: String(e.message).slice(0, 120) });
          }
        }
      }
    }
    brainRouterListener(event, data);
  });
}

// ---------------------------------------------------------------------------
// 9. INIT
// ---------------------------------------------------------------------------
function init(ctx) {
  CTX = ctx;
  SYNC_DEBOUNCER = createDebouncer(() => syncToolsIndex(), FILE_WATCH_DEBOUNCE_MS);
  syncToolsIndex();

 toolsIpcHandlers.register(ipcMain, {
    getMode: () => ctx.settings?.mode || 'SEMI_AUTO',
    requestApproval: async (req) => await promptRiskyApproval(req.tool || 'unknown', req.reason || `Risk level: ${req.risk}`, req.args || {}),
    audit: (ev) => ctx.audit('info', ev.action || 'tools_library_event', ev),
    onSync: () => syncToolsIndex(),
  });
  refreshFileWatchers();

  if (typeof ctx.addStopHook === 'function') {
    ctx.addStopHook('tool_librarian_watchers', () => closeAllWatchers());
  }

  installLibrarianInterceptor();

  ctx.registerService('tool_librarian', {
    syncIndex: syncToolsIndex,
    getIndex: () => INDEX_CACHE,
    discoverSources: discoverToolSources,
    searchTools: searchRelevantTools,
    deliverToolsForAI,
    executeToolByName,
    stats: scale.stats,
  });

  ctx.addStateContributor('tools_library', () => ({
    total_tools: INDEX_CACHE.length,
    active_tools: INDEX_CACHE.filter((t) => t.enabled).map((t) => t.name),
    sources: discoverToolSources().map((s) => s.source_module),
    categories: scale.stats().categories,
  }));

  ctx.audit('info', 'tool_librarian_ready', {
    tools_dir: TOOLS_DIR, modules_dir: MODULES_DIR, index_file: INDEX_FILE,
    total_tools: INDEX_CACHE.length, watched_dirs: ACTIVE_WATCHERS.size, scale: scale.stats(),
  });
}

module.exports = {
  name: 'tool_librarian',
  init,
  deliverToolsForAI,
  executeToolByName,
  discoverToolSources,
  searchRelevantTools,
  stats: scale.stats,
  syncIndex: syncToolsIndex,
  getIndex: () => INDEX_CACHE,
};