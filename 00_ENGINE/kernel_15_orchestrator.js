'use strict';

/**
 * ============================================================================
 *  NEZA — CENTRAL BRAIN INTENT ORCHESTRATOR
 *  kernel_15_orchestrator.js
 * ----------------------------------------------------------------------------
 *  Replaces the old single-brain router with a multi-step, capability-driven
 *  graph executor.
 *
 *  PIPELINE
 *    1. CAPABILITY DISCOVERY  -> scan 02_MODULES/* /module.json  +  live services
 *    2. INTENT PLANNING       -> LLM returns a strict JSON plan (array of steps)
 *    3. GRAPH EXECUTION       -> ctx.getService(block).executeTool(action, args)
 *    4. FALLBACK              -> legacy kernel_5 chat listener (captured & replayed)
 *
 *  RULE 4 (Zero placeholders): full implementation, no stubs.
 *  RULE 5 (Generalized): zero hardcoded block names, zero hardcoded actions.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

/* ---------------------------------------------------------------------------
 * 0. SAFE ELECTRON BINDING
 *    The kernel must never crash the host process just because it was loaded
 *    in a non-Electron context (tests, CLI tooling, hot-reload sandboxes).
 * ------------------------------------------------------------------------- */
let ipcMain = null;
try {
  // eslint-disable-next-line global-require
  const electron = require('electron');
  ipcMain = (electron && electron.ipcMain) || null;
} catch (_err) {
  ipcMain = null;
}

/* ---------------------------------------------------------------------------
 * 1. CONSTANTS
 * ------------------------------------------------------------------------- */
const PROMPT_CHANNEL = 'jarvis:ai-prompt';
const RESPONSE_CHANNEL = 'jarvis:ai-response';
const PROGRESS_CHANNEL = 'jarvis:orchestrator:progress';
const PLAN_CHANNEL = 'jarvis:orchestrator:plan';

const LIMITS = {
  MAX_STEPS: 8,
  LLM_TIMEOUT_MS: 25000,
  STEP_TIMEOUT_MS: 30000,
  PLANNER_TEMPERATURE: 0.1,
  PLANNER_MAX_TOKENS: 1200,
  PLANNER_HISTORY_TURNS: 6,
  MANIFEST_CHAR_BUDGET: 12000,
  MAX_RESULT_CHARS: 8000
};

const PROVIDER_DEFAULTS = {
  groq: {
    host: 'api.groq.com',
    path: '/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile'
  },
  gemini: {
    host: 'generativelanguage.googleapis.com',
    pathPrefix: '/v1beta/models/',
    model: 'gemini-2.0-flash'
  }
};

/* ---------------------------------------------------------------------------
 * 2. MODULE STATE
 * ------------------------------------------------------------------------- */
const state = {
  initialized: false,
  ctx: null,
  settings: null,
  settingsPath: null,
  registry: new Map(),          // blockName -> entry
  aliases: new Map(),           // alias/normalized -> blockName
  handlerRef: null,
  legacyListeners: [],
  legacySet: new Set(),
  activeRequests: new Map(),    // requestId -> { startedAt }
  lastPlan: null
};

/* ---------------------------------------------------------------------------
 * 3. SMALL UTILITIES
 * ------------------------------------------------------------------------- */
function isFn(value) {
  return typeof value === 'function';
}

function isObj(value) {
  return value !== null && typeof value === 'object';
}

function nowIso() {
  return new Date().toISOString();
}

function truncate(text, max) {
  const str = typeof text === 'string' ? text : String(text == null ? '' : text);
  return str.length <= max ? str : str.slice(0, max) + '…';
}

function safeJsonParse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    // Strip UTF-8 BOM and // comments (some hand-edited configs contain them).
    const cleaned = raw.replace(/^\uFEFF/, '').replace(/^\s*\/\/.*$/gm, '');
    return safeJsonParse(cleaned);
  } catch (_err) {
    return null;
  }
}

function walkFiles(dir, depth, out, maxDepth) {
  if (depth > maxDepth) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
      walkFiles(full, depth + 1, out, maxDepth);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Depth-limited BFS search for a settings key.
 * @param {any} root
 * @param {RegExp[]} matchers  tested against the key name
 * @returns {string|null} first non-empty string value that matches
 */
function deepFindString(root, matchers, maxDepth) {
  const queue = [{ node: root, depth: 0 }];
  const seen = new Set();
  const limit = typeof maxDepth === 'number' ? maxDepth : 6;

  while (queue.length) {
    const { node, depth } = queue.shift();
    if (!isObj(node) || seen.has(node) || depth > limit) continue;
    seen.add(node);

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) {
        for (const rx of matchers) {
          if (rx.test(key)) return value.trim();
        }
      } else if (isObj(value)) {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return null;
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message || `Operation timed out after ${ms}ms`)), ms);
    if (isFn(timer.unref)) timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => {
        if (timer) clearTimeout(timer);
        return value;
      },
      (err) => {
        if (timer) clearTimeout(timer);
        throw err;
      }
    ),
    timeout
  ]);
}

function normaliseName(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/\.json$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/* ---------------------------------------------------------------------------
 * 4. AUDIT / LOGGING
 * ------------------------------------------------------------------------- */
function audit(level, event, meta) {
  const payload = isObj(meta) ? meta : {};
  try {
    if (state.ctx && isFn(state.ctx.audit)) {
      state.ctx.audit(level, event, payload);
      return;
    }
    if (state.ctx && state.ctx.logger && isFn(state.ctx.logger.audit)) {
      state.ctx.logger.audit(level, event, payload);
      return;
    }
    if (state.ctx && isFn(state.ctx.log)) {
      state.ctx.log(`[orchestrator] ${level} ${event} ${JSON.stringify(payload)}`);
      return;
    }
  } catch (_err) {
    /* audit must never throw */
  }
  // eslint-disable-next-line no-console
  console.log(`[orchestrator:${level}] ${event}`, payload);
}

/* ---------------------------------------------------------------------------
 * 5. SETTINGS + PROVIDER RESOLUTION
 * ------------------------------------------------------------------------- */
function loadSettings(ctx) {
  if (isObj(ctx) && isObj(ctx.settings) && Object.keys(ctx.settings).length) {
    state.settingsPath = '<ctx.settings>';
    return ctx.settings;
  }

  const roots = [];
  if (isObj(ctx)) {
    ['rootPath', 'root', 'appRoot', 'appPath', 'baseDir', 'projectRoot', 'cwd'].forEach((key) => {
      if (typeof ctx[key] === 'string' && ctx[key]) roots.push(ctx[key]);
    });
  }
  roots.push(process.cwd());
  roots.push(path.resolve(__dirname, '..'));
  roots.push(__dirname);

  const candidates = [];
  const seen = new Set();
  for (const root of roots) {
    const list = [
      path.join(root, '01_CONFIG', 'settings.json'),
      path.join(root, '01_CONFIG', 'config.json'),
      path.join(root, 'settings.json')
    ];
    for (const candidate of list) {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      candidates.push(resolved);
    }
  }

  for (const candidate of candidates) {
    const parsed = safeReadJson(candidate);
    if (parsed) {
      state.settingsPath = candidate;
      return parsed;
    }
  }
  state.settingsPath = null;
  return {};
}

const KEY_HINT_RX = /(api[_-]?key|apikey|key|token|secret|credential)/i;
const MODEL_HINT_RX = /(model|engine|deployment)/i;

/**
 * BFS for the provider's own settings sub-object.
 * Handles: { ai: { groq: {...} } }, { providers: { gemini: {...} } },
 *          { groq: "gsk_..." } and deeply nested variants.
 */
function findProviderBlock(settings, aliases) {
  const queue = [{ node: settings, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { node, depth } = queue.shift();
    if (!isObj(node) || Array.isArray(node) || seen.has(node) || depth > 7) continue;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      const norm = normaliseName(key);
      if (aliases.indexOf(norm) !== -1) {
        if (isObj(value) && !Array.isArray(value)) return value;
        if (typeof value === 'string' && value.trim().length > 8) return { apiKey: value.trim() };
      }
      if (isObj(value) && !Array.isArray(value)) queue.push({ node: value, depth: depth + 1 });
    }
  }
  return null;
}

function pickStringFromBlock(block, hint) {
  if (!isObj(block)) return null;
  for (const key of Object.keys(block)) {
    const value = block[key];
    if (typeof value === 'string' && value.trim() && hint.test(key)) return value.trim();
  }
  return null;
}

function readEnv(names) {
  for (const envName of names) {
    const raw = process.env[envName];
    if (raw && String(raw).trim().length > 8) return String(raw).trim();
  }
  return null;
}

/**
 * Resolve `{ key, model }` for a provider from env vars or settings.json.
 * No hardcoded key names beyond conventional aliases.
 */
function resolveProviderCredentials(providerId, aliases, envNames, keyFallbackMatchers, modelAliases) {
  const block = findProviderBlock(state.settings || {}, aliases);

  const key =
    readEnv(envNames) ||
    pickStringFromBlock(block, KEY_HINT_RX) ||
    deepFindString(state.settings || {}, keyFallbackMatchers, 7) ||
    null;

  const model =
    pickStringFromBlock(block, MODEL_HINT_RX) ||
    deepFindString(state.settings || {}, modelAliases, 7) ||
    PROVIDER_DEFAULTS[providerId].model;

  return { key, model, block };
}

function resolveProviders() {
  const settings = state.settings || {};
  const providers = [];

  const groq = resolveProviderCredentials(
    'groq',
    ['groq', 'groq_ai', 'groqai', 'groq_cloud'],
    ['GROQ_API_KEY', 'GROQ_KEY', 'NEZA_GROQ_KEY', 'GROQ_TOKEN'],
    [/groq.*api[_-]?key/i, /groq.*key/i, /groq.*token/i],
    [/groq.*model/i]
  );
  if (groq.key) providers.push({ id: 'groq', key: groq.key, model: groq.model });

  const gemini = resolveProviderCredentials(
    'gemini',
    ['gemini', 'google', 'google_ai', 'googleai', 'gemini_ai', 'google_gemini'],
    ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'NEZA_GEMINI_KEY'],
    [/gemini.*api[_-]?key/i, /gemini.*key/i, /google.*api[_-]?key/i],
    [/gemini.*model/i, /google.*model/i]
  );
  if (gemini.key) providers.push({ id: 'gemini', key: gemini.key, model: gemini.model });

  // Honour an explicit preference order from settings, e.g. ai.provider = 'gemini'
  const preferred = deepFindString(
    settings,
    [/^(ai_)?provider$/i, /^(ai_)?planner_?provider$/i, /primary_?provider/i],
    6
  );
  if (preferred) {
    const wanted = normaliseName(preferred);
    providers.sort((a, b) => (a.id === wanted ? -1 : 0) - (b.id === wanted ? -1 : 0));
  }

  return providers;
}

/* ---------------------------------------------------------------------------
 * 6. HTTP TRANSPORT (https only, no external deps)
 * ------------------------------------------------------------------------- */
function httpsJsonRequest(opts) {
  return new Promise((resolve, reject) => {
    const body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body || {});
    const headers = Object.assign(
      {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json'
      },
      opts.headers || {}
    );

    let req;
    try {
      req = https.request(
        {
          hostname: opts.hostname,
          port: opts.port || 443,
          path: opts.path,
          method: opts.method || 'POST',
          headers
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: raw }));
          res.on('error', reject);
        }
      );
    } catch (err) {
      reject(err);
      return;
    }

    req.setTimeout(opts.timeoutMs || LIMITS.LLM_TIMEOUT_MS, () => {
      req.destroy(new Error(`LLM request timed out after ${opts.timeoutMs || LIMITS.LLM_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callGroq(provider, systemPrompt, userPrompt) {
  const response = await httpsJsonRequest({
    hostname: PROVIDER_DEFAULTS.groq.host,
    path: PROVIDER_DEFAULTS.groq.path,
    method: 'POST',
    timeoutMs: LIMITS.LLM_TIMEOUT_MS,
    headers: { Authorization: `Bearer ${provider.key}` },
    body: {
      model: provider.model || PROVIDER_DEFAULTS.groq.model,
      temperature: LIMITS.PLANNER_TEMPERATURE,
      max_tokens: LIMITS.PLANNER_MAX_TOKENS,
      top_p: 1,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    }
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Groq HTTP ${response.statusCode}: ${truncate(response.body, 300)}`);
  }
  const parsed = safeJsonParse(response.body);
  const text =
    parsed &&
    parsed.choices &&
    parsed.choices[0] &&
    parsed.choices[0].message &&
    parsed.choices[0].message.content;
  if (!text) throw new Error('Groq returned an empty completion');
  return text;
}

async function callGemini(provider, systemPrompt, userPrompt) {
  const model = provider.model || PROVIDER_DEFAULTS.gemini.model;
  const response = await httpsJsonRequest({
    hostname: PROVIDER_DEFAULTS.gemini.host,
    path: `${PROVIDER_DEFAULTS.gemini.pathPrefix}${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.key)}`,
    method: 'POST',
    timeoutMs: LIMITS.LLM_TIMEOUT_MS,
    body: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: LIMITS.PLANNER_TEMPERATURE,
        maxOutputTokens: LIMITS.PLANNER_MAX_TOKENS,
        responseMimeType: 'application/json'
      }
    }
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Gemini HTTP ${response.statusCode}: ${truncate(response.body, 300)}`);
  }
  const parsed = safeJsonParse(response.body);
  const candidate =
    parsed &&
    parsed.candidates &&
    parsed.candidates[0] &&
    parsed.candidates[0].content &&
    parsed.candidates[0].content.parts;
  const text = Array.isArray(candidate) ? candidate.map((p) => p && p.text).filter(Boolean).join('\n') : '';
  if (!text) throw new Error('Gemini returned an empty completion');
  return text;
}

/* ---------------------------------------------------------------------------
 * 7. CAPABILITY DISCOVERY
 * ------------------------------------------------------------------------- */
function resolveModulesRoot(ctx) {
  const roots = [];
  if (isObj(ctx)) {
    ['rootPath', 'root', 'appRoot', 'appPath', 'baseDir', 'projectRoot', 'modulesPath'].forEach((key) => {
      if (typeof ctx[key] === 'string' && ctx[key]) roots.push(ctx[key]);
    });
    if (typeof ctx.modulesPath === 'string') roots.push(ctx.modulesPath);
  }
  roots.push(process.cwd());
  roots.push(path.resolve(__dirname, '..'));
  roots.push(__dirname);

  const candidates = [];
  const seen = new Set();
  for (const root of roots) {
    const list = [
      /(^|[/\\])02_MODULES$/i.test(root) ? root : path.join(root, '02_MODULES'),
      path.join(root, 'modules'),
      path.join(root, 'MODULES')
    ];
    for (const candidate of list) {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      candidates.push(resolved);
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    } catch (_err) {
      /* ignore */
    }
  }
  return null;
}

/**
 * Normalise wildly different `module.json` shapes into a flat action list.
 * Supports:
 *   { "capabilities": ["save", "search"] }
 *   { "capabilities": { "save": { "description": "..." } } }
 *   { "tools": [{ "name": "send_telegram", "description": "..." }] }
 *   { "api": { "actions": [...] } } / { "actions": [...] }
 */
function extractCapabilities(moduleJson) {
  const actions = [];
  const seen = new Set();

  const pushAction = (name, meta) => {
    if (!name || typeof name !== 'string') return;
    const key = name.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const description =
      (typeof meta === 'string' && meta) ||
      (isObj(meta) && (meta.description || meta.desc || meta.summary || meta.purpose)) ||
      '';
    actions.push({ action: key, description: String(description || '') });
  };

  const harvest = (node, depth) => {
    if (!node || depth > 4) return;

    if (Array.isArray(node)) {
      node.forEach((item) => {
        if (typeof item === 'string') pushAction(item, '');
        else if (isObj(item)) pushAction(item.name || item.action || item.id || item.tool, item);
      });
      return;
    }

    if (isObj(node)) {
      // Named map: { save: { description } }
      const keys = Object.keys(node);
      const looksLikeMap = keys.some(
        (k) => ['name', 'description', 'desc', 'params', 'schema', 'args', 'input'].indexOf(k) === -1
      );
      if (looksLikeMap) {
        keys.forEach((key) => {
          if (['name', 'description', 'desc', 'params', 'schema', 'args', 'input', 'version', 'enabled'].indexOf(key) !== -1) return;
          pushAction(key, node[key]);
        });
      }
    }
  };

 if (isObj(moduleJson)) {
    // Priority 1: Actual executable tools registered in module.json
    const primaryContainers = [
      moduleJson.registered_tools,
      moduleJson.tools,
      moduleJson.actions,
      moduleJson.methods,
      moduleJson.exports,
      moduleJson.api && moduleJson.api.actions,
      moduleJson.api && moduleJson.api.tools,
      moduleJson.interface && moduleJson.interface.actions,
      moduleJson.tools && moduleJson.tools.list
    ];
    primaryContainers.forEach((node) => harvest(node, 0));

    // Priority 2: Only fall back to abstract capabilities if no registered_tools exist
    if (!actions.length) {
      const fallbackContainers = [
        moduleJson.capabilities,
        moduleJson.api && moduleJson.api.capabilities
      ];
      fallbackContainers.forEach((node) => harvest(node, 0));
    }

    // Last resort: a flat `permissions` / `scopes` array of strings.
    if (!actions.length && Array.isArray(moduleJson.permissions)) {
      moduleJson.permissions.forEach((p) => {
        if (typeof p === 'string') pushAction(p, '');
      });
    }
  }

  return actions;
}

function readServiceCapabilities(service) {
  if (!isObj(service)) return [];
  const actions = [];
  const seen = new Set();
  const push = (name) => {
    if (typeof name !== 'string' || !name.trim() || seen.has(name)) return;
    seen.add(name);
    actions.push({ action: name, description: '' });
  };

  if (Array.isArray(service.capabilities)) service.capabilities.forEach(push);
  else if (isObj(service.capabilities)) Object.keys(service.capabilities).forEach(push);
  if (Array.isArray(service.tools)) {
    service.tools.forEach((t) => {
      if (typeof t === 'string') push(t);
      else if (isObj(t)) push(t.name || t.action || t.id);
    });
  } else if (isObj(service.tools)) Object.keys(service.tools).forEach(push);
  if (isFn(service.listTools)) {
    try {
      const list = service.listTools();
      if (Array.isArray(list)) {
        list.forEach((t) => {
          if (typeof t === 'string') push(t);
          else if (isObj(t)) push(t.name || t.action || t.id);
        });
      } else if (isObj(list)) {
        Object.keys(list).forEach(push);
      }
    } catch (_err) {
      /* ignore */
    }
  }
  return actions;
}

function collectServiceNames(ctx) {
  const names = new Set();
  const pushAll = (obj) => {
    if (!obj) return;
    if (Array.isArray(obj)) {
      obj.forEach((n) => typeof n === 'string' && names.add(n));
      return;
    }
    if (obj instanceof Map) {
      obj.forEach((_v, k) => typeof k === 'string' && names.add(k));
      return;
    }
    if (isObj(obj)) Object.keys(obj).forEach((k) => names.add(k));
  };

  if (isFn(ctx.listServices)) {
    try {
      pushAll(ctx.listServices());
    } catch (_err) {
      /* ignore */
    }
  }
  if (isFn(ctx.getServices)) {
    try {
      pushAll(ctx.getServices());
    } catch (_err) {
      /* ignore */
    }
  }
  pushAll(ctx.services);
  pushAll(ctx._services);
  if (isObj(ctx.registry)) pushAll(ctx.registry.services);
  if (obj_keys_safe(ctx).length) obj_keys_safe(ctx).forEach((k) => {
    if (/^service(s)?$/i.test(k) || /service/i.test(k)) pushAll(ctx[k]);
  });

  return Array.from(names).filter((name) => typeof name === 'string' && name.trim());
}

function obj_keys_safe(obj) {
  try {
    return isObj(obj) ? Object.keys(obj) : [];
  } catch (_err) {
    return [];
  }
}

function registerEntry(entry) {
  const key = normaliseName(entry.name);
  if (!key) return;
  const existing = state.registry.get(key);
  if (existing) {
    // Merge actions / metadata rather than overwrite.
    existing.actions = mergeActions(existing.actions, entry.actions);
    existing.description = existing.description || entry.description;
    existing.dir = existing.dir || entry.dir;
    if (!existing.moduleJson && entry.moduleJson) existing.moduleJson = entry.moduleJson;
    return;
  }
  state.registry.set(key, entry);
  const aliasSet = new Set([key, normaliseName(entry.name.replace(/[_-]?block$/i, ''))]);
  if (entry.dir) aliasSet.add(normaliseName(path.basename(entry.dir)));
  aliasSet.forEach((alias) => {
    if (alias && !state.aliases.has(alias)) state.aliases.set(alias, key);
  });
}

function mergeActions(a, b) {
  const map = new Map();
  (a || []).forEach((item) => map.set(item.action, item));
  (b || []).forEach((item) => {
    if (!map.has(item.action) || (!map.get(item.action).description && item.description)) {
      map.set(item.action, item);
    }
  });
  return Array.from(map.values());
}

/**
 * Scan 02_MODULES for module.json manifests, then merge in live services that
 * exist only at runtime (registered via ctx.registerService).
 */
function discoverBlocks(ctx) {
  state.registry.clear();
  state.aliases.clear();

  const modulesRoot = resolveModulesRoot(ctx);
  const scanned = [];

  if (modulesRoot) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(modulesRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch (_err) {
      dirs = [];
    }

    for (const dir of dirs) {
      const blockDir = path.join(modulesRoot, dir.name);
      const manifestPaths = [
        path.join(blockDir, 'module.json'),
        path.join(blockDir, 'package.json')
      ];
      let manifest = null;
      let manifestPath = null;
      for (const candidate of manifestPaths) {
        const parsed = safeReadJson(candidate);
        if (parsed) {
          manifest = parsed;
          manifestPath = candidate;
          break;
        }
      }

      const declaredName = (manifest && (manifest.name || manifest.id || manifest.block)) || dir.name;
      const actions = extractCapabilities(manifest || {});
      const description =
        (manifest && (manifest.description || manifest.summary || manifest.purpose)) || '';

      // A package.json with no NEZA metadata should not pollute the registry
      // unless it actually declares capabilities.
      if (!actions.length && /package\.json$/i.test(manifestPath || '') && !(manifest && manifest.capabilities)) {
        continue;
      }

      registerEntry({
        name: declaredName,
        dir: blockDir,
        manifestPath,
        moduleJson: manifest,
        description,
        actions,
        source: 'module.json'
      });
      scanned.push(declaredName);
    }
  }

  // Merge runtime services (may add blocks or enrich scanned ones).
  const serviceNames = collectServiceNames(ctx);
  for (const serviceName of serviceNames) {
    const service = getServiceByName(ctx, serviceName);
    const liveActions = readServiceCapabilities(service);
    const key = normaliseName(serviceName);
    const existing = state.registry.get(key);
    if (existing) {
      existing.actions = mergeActions(existing.actions, liveActions);
      existing.serviceName = existing.serviceName || serviceName;
      if (!existing.description && isObj(service) && typeof service.description === 'string') {
        existing.description = service.description;
      }
    } else {
      registerEntry({
        name: serviceName,
        dir: null,
        manifestPath: null,
        moduleJson: null,
        description: (isObj(service) && (service.description || service.purpose)) || '',
        actions: liveActions,
        serviceName,
        source: 'ctx.registerService'
      });
    }
  }

  audit('info', 'orchestrator_discovery', {
    modulesRoot: modulesRoot || null,
    scannedCount: scanned.length,
    registeredCount: state.registry.size
  });

  return { modulesRoot, scanned, registry: state.registry };
}
function getServiceByName(ctx, name) {
  if (!name) return null;
  const normalised = normaliseName(name);

  // 1. Try getting from context directly
  if (ctx) {
    try {
      if (isFn(ctx.getService)) {
        const direct = ctx.getService(name);
        if (direct) return direct;
        if (normalised !== name) {
          const retry = ctx.getService(normalised);
          if (retry) return retry;
        }
      }
    } catch (_err) {}

    // 2. Try getting from context service containers
    const container = [ctx.services, ctx._services, ctx.registry && ctx.registry.services];
    for (const bag of container) {
      if (!isObj(bag)) continue;
      if (bag[name]) return bag[name];
      if (bag[normalised]) return bag[normalised];
      for (const key of Object.keys(bag)) {
        if (normaliseName(key) === normalised) return bag[key];
      }
    }
  }

  // 3. GENERALIZED DYNAMIC BLOCK LOADER (Works for memory_block, system_block, data_block, etc.)
  const modulesRoot = resolveModulesRoot(ctx || state.ctx);
  if (modulesRoot) {
    const candidates = [
      name,
      normalised,
      normalised.endsWith('_block') ? normalised : `${normalised}_block`
    ];
    for (const folder of candidates) {
      const apiPath = path.join(modulesRoot, folder, 'api.js');
      if (fs.existsSync(apiPath)) {
        try {
          const mod = require(apiPath);
          return mod.memoryAPI || mod.defaultMemoryAPI || mod;
        } catch (_err) {
          // Continue checking candidates
        }
      }
    }
  }

  // 4. Fallback to registry entry directory if known
  const entry = state.registry.get(normalised);
  if (entry && entry.dir) {
    const entryApiPath = path.join(entry.dir, 'api.js');
    if (fs.existsSync(entryApiPath)) {
      try {
        const mod = require(entryApiPath);
        return mod.memoryAPI || mod.defaultMemoryAPI || mod;
      } catch (_err) {}
    }
  }

  return null;
}



function resolveEntry(ctx, blockName) {
  if (!blockName) return null;
  const key = normaliseName(blockName);
  let entry = state.registry.get(key);
  if (entry) return entry;

  const aliased = state.aliases.get(key);
  if (aliased) {
    entry = state.registry.get(aliased);
    if (entry) return entry;
  }

  // Fuzzy: allow "memory" -> "memory_block", "communication" -> "communication_block"
  for (const [registryKey, candidate] of state.registry) {
    if (registryKey === key) return candidate;
    if (registryKey.indexOf(key) !== -1 || key.indexOf(registryKey) !== -1) return candidate;
  }

  // Runtime-only fallback: a service exists but was never in a manifest.
  const liveService = getServiceByName(ctx, blockName);
  if (liveService) {
    const synthetic = {
      name: blockName,
      dir: null,
      manifestPath: null,
      moduleJson: null,
      description: '',
      actions: readServiceCapabilities(liveService),
      serviceName: blockName,
      source: 'runtime'
    };
    registerEntry(synthetic);
    return state.registry.get(normaliseName(blockName));
  }

  return null;
}

function buildManifestForPrompt() {
  const blocks = [];
  let budget = LIMITS.MANIFEST_CHAR_BUDGET;

  for (const entry of state.registry.values()) {
    if (!entry.actions || !entry.actions.length) {
      // Still expose blocks that only advertise executeTool dynamically.
      const service = getServiceByName(state.ctx, entry.serviceName || entry.name);
      if (!service || !isFn(service.executeTool)) continue;
    }

    const actions = (entry.actions || []).map((item) => ({
      action: item.action,
      description: truncate(item.description || '', 140)
    }));

    const block = {
      block: entry.name,
      description: truncate(entry.description || '', 180)
    };
    if (actions.length) block.actions = actions;

    const serialised = JSON.stringify(block);
    if (serialised.length > budget) {
      // Degrade gracefully: strip descriptions before giving up entirely.
      block.actions = actions.map((item) => item.action);
      block.description = '';
      const lean = JSON.stringify(block);
      if (lean.length > budget) continue;
      blocks.push(block);
      budget -= lean.length;
      continue;
    }
    blocks.push(block);
    budget -= serialised.length;
  }

  return blocks;
}

/* ---------------------------------------------------------------------------
 * 8. PLANNER PROMPT + JSON EXTRACTION
 * ------------------------------------------------------------------------- */
/* ========================================================================= */
/* 3-LAYER MEMORY AUTO-INJECT HELPERS                                        */
/* ========================================================================= */
function resolveMemoryBlock(ctx) {
  if (ctx && typeof ctx.getService === 'function') {
    const svc = ctx.getService('memory_block');
    if (svc) return svc;
  }
  return null;
}

function truncateAndSummarizeLayer(rawObj, maxChars = 2000) {
  if (!rawObj) return 'None';
  let formatted = '';
  if (typeof rawObj === 'string') {
    formatted = rawObj.trim();
  } else if (Array.isArray(rawObj.rules)) {
    formatted = rawObj.rules.map((r, idx) => `${idx + 1}. [${(r.priority || 'normal').toUpperCase()}] (${r.category || 'general'}): ${r.instruction}`).join('\n');
  } else {
    const sections = [];
    if (rawObj.profile && Object.keys(rawObj.profile).length > 0) sections.push(`Profile: ${JSON.stringify(rawObj.profile)}`);
    if (rawObj.identity && Object.keys(rawObj.identity).length > 0) sections.push(`Identity: ${JSON.stringify(rawObj.identity)}`);
    if (Array.isArray(rawObj.goals) && rawObj.goals.length > 0) sections.push(`Goals: ${rawObj.goals.join(' | ')}`);
    if (Array.isArray(rawObj.entries) && rawObj.entries.length > 0) {
      const recent = rawObj.entries.slice(-20).map((e) => `- [${e.key}]: ${e.content}`).join('\n');
      sections.push(`Facts:\n${recent}`);
    }
    formatted = sections.length > 0 ? sections.join('\n') : JSON.stringify(rawObj);
  }
  if (formatted.length <= maxChars) return formatted;
  return formatted.slice(0, maxChars) + '\n...[TRUNCATED FOR CONTEXT SAFETY]...';
}

function build3LayerMemoryContext(userPrompt, ctx) {
  const memoryBlock = resolveMemoryBlock(ctx);
  if (!memoryBlock) return '';
  
  let layer1Text = 'None', layer2Text = 'None', layer3Text = 'None';
  try {
    const coreData = typeof memoryBlock.getCore === 'function' ? memoryBlock.getCore() : {};
    layer1Text = truncateAndSummarizeLayer(coreData, 2000);
  } catch (err) {}
  
  try {
    const rulesData = typeof memoryBlock.getRules === 'function' ? memoryBlock.getRules() : {};
    layer2Text = truncateAndSummarizeLayer(rulesData, 2000);
  } catch (err) {}
  
  try {
    if (typeof memoryBlock.searchVault === 'function' && userPrompt) {
      const topChunks = memoryBlock.searchVault(userPrompt, 3) || [];
      if (topChunks.length > 0) {
        layer3Text = topChunks.map((c, i) => `[Chunk ${i + 1} | Source: ${c.fileName || 'vault'}]\n${String(c.content || '').slice(0, 600)}`).join('\n\n');
      }
    }
  } catch (err) {}

  return [
    '=== NEZA 3-LAYER MEMORY CONTEXT ===',
    '[LAYER 1: CORE MEMORY]', layer1Text,
    '[LAYER 2: BEHAVIOR RULES]', layer2Text,
    '[LAYER 3: RELEVANT VAULT CHUNKS]', layer3Text,
    '=== END MEMORY CONTEXT ==='
  ].join('\n');
}
function buildPlannerSystemPrompt(manifest, userPrompt, ctx) {
  const capabilityJson = JSON.stringify(manifest, null, 2);
  const memoryContext = build3LayerMemoryContext(userPrompt, ctx);
  return [
    memoryContext,
    '',
    'You are NEZA Central Brain, the intent planner of a modular AI operating environment.',
    'Your ONLY job is to translate the user request into an executable plan made of calls to the available blocks.',
    '',
    'RULES:',
    '1. Output ONLY a JSON array. No prose, no markdown fences, no comments, no trailing commas.',
    '2. Each element must be an object with exactly these keys: "block", "action", "args".',
    '3. "block" and "action" MUST come from the AVAILABLE BLOCKS list below. Never invent a block or an action.',
    '4. "args" must be a JSON object. Use {} when the action takes no arguments.',
    '5. Decompose multi-part user requests into multiple steps, ordered by execution sequence.',
    '6. To pass a previous step\'s output into a later step, use the placeholder "{{steps.N.result}}" (0-based index) or "{{prev.result}}".',
    '7. If the request is pure conversation, chit-chat, a question that needs no block, or nothing can satisfy it, output exactly: []',
    '8. Never include authentication, API keys, or fabricated data in args.',
    '9. Maximum ' + LIMITS.MAX_STEPS + ' steps. Prefer the smallest plan that satisfies the intent.',
    '',
    'EXAMPLE OUTPUT:',
    '[{"block":"memory_block","action":"save_memory","args":{"content":"User likes tea"}},{"block":"communication_block","action":"send_telegram","args":{"text":"{{prev.result}}"}}]',
    '',
    'AVAILABLE BLOCKS (generated live from 02_MODULES manifests and runtime services):',
    capabilityJson
  ].join('\n');
}

function buildPlannerUserPrompt(userPrompt, history, meta) {
  const lines = [];
  if (Array.isArray(history) && history.length) {
    lines.push('RECENT CONVERSATION (oldest first):');
    history.forEach((turn) => {
      if (!isObj(turn)) return;
      const role = String(turn.role || turn.sender || 'user').slice(0, 20);
      const content = truncate(turn.content || turn.text || turn.message || '', 500);
      if (content) lines.push(`- ${role}: ${content}`);
    });
    lines.push('');
  }
  if (isObj(meta) && meta.sessionId) lines.push(`SESSION: ${meta.sessionId}`);
  lines.push('USER REQUEST:');
  lines.push(truncate(userPrompt, 4000));
  lines.push('');
  lines.push('Return the JSON array plan now.');
  return lines.join('\n');
}

/**
 * Extract the first balanced JSON array (or an object containing one) from an
 * LLM response that may contain fences, prose, or thinking traces.
 */
function extractPlanPayload(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .trim();

  const tryParse = (candidate) => {
    const parsed = safeJsonParse(candidate);
    if (!parsed) return null;
    if (Array.isArray(parsed)) return parsed;
    if (isObj(parsed)) {
      const nested = parsed.steps || parsed.plan || parsed.actions || parsed.tasks || parsed.tool_calls;
      if (Array.isArray(nested)) return nested;
    }
    return null;
  };

  const direct = tryParse(cleaned);
  if (direct) return direct;

  // Balanced-bracket scan for the first top-level array.
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '[') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          const slice = cleaned.slice(start, i + 1);
          const parsed = tryParse(slice);
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  // Balanced-brace scan for the first object that wraps a plan.
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParse(cleaned.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  return null;
}

async function requestPlan(userPrompt, history, meta) {
  const manifest = buildManifestForPrompt();
  if (!manifest.length) {
    return { plan: [], provider: null, raw: null, reason: 'no_blocks_registered' };
  }

  const providers = resolveProviders();
  if (!providers.length) {
    throw new Error(
      'No LLM provider credentials found. Expected a Groq/Gemini key in 01_CONFIG/settings.json or GROQ_API_KEY / GEMINI_API_KEY env vars.'
    );
  }

  const systemPrompt = buildPlannerSystemPrompt(manifest, userPrompt, meta.ctx);
  const userPromptText = buildPlannerUserPrompt(userPrompt, history, meta);
  const failures = [];

  for (const provider of providers) {
    try {
      const raw =
        provider.id === 'groq'
          ? await callGroq(provider, systemPrompt, userPromptText)
          : await callGemini(provider, systemPrompt, userPromptText);

      const plan = extractPlanPayload(raw);
      if (plan) {
        return { plan, provider: provider.id, raw, reason: 'ok' };
      }
      failures.push(`${provider.id}: unparsable plan output`);
      audit('warn', 'orchestrator_plan_unparsable', {
        provider: provider.id,
        sample: truncate(raw, 300)
      });
    } catch (err) {
      failures.push(`${provider.id}: ${err && err.message}`);
      audit('warn', 'orchestrator_plan_provider_error', {
        provider: provider.id,
        error: err && err.message
      });
    }
  }

  throw new Error(`Planner failed on every provider -> ${failures.join(' | ')}`);
}

/* ---------------------------------------------------------------------------
 * 9. PLAN VALIDATION
 * ------------------------------------------------------------------------- */
function validatePlan(rawPlan, ctx) {
  const accepted = [];
  const rejected = [];

  if (!Array.isArray(rawPlan)) {
    return { steps: [], rejected: [{ reason: 'plan_not_array' }] };
  }

  rawPlan.slice(0, LIMITS.MAX_STEPS).forEach((rawStep, index) => {
    if (!isObj(rawStep)) {
      rejected.push({ index, reason: 'step_not_object' });
      return;
    }

    const blockRaw = rawStep.block || rawStep.blockName || rawStep.module || rawStep.service || rawStep.tool;
    const actionRaw = rawStep.action || rawStep.tool || rawStep.name || rawStep.method || rawStep.function;

    if (!blockRaw || typeof blockRaw !== 'string') {
      rejected.push({ index, reason: 'missing_block' });
      return;
    }
    if (!actionRaw || typeof actionRaw !== 'string') {
      rejected.push({ index, reason: 'missing_action', block: blockRaw });
      return;
    }

    const entry = resolveEntry(ctx, blockRaw);
    if (!entry) {
      rejected.push({ index, reason: 'unknown_block', block: blockRaw });
      return;
    }

    const declared = (entry.actions || []).map((item) => item.action);
    const action = String(actionRaw);
    const known =
      !declared.length ||
      declared.indexOf(action) !== -1 ||
      declared.some((name) => normaliseName(name) === normaliseName(action));

    if (!known) {
      // Soft rejection: only drop when we are confident the block is strictly
      // enumerated (i.e. it declared capabilities) AND it does not expose a
      // generic executeTool gateway.
      const service = getServiceByName(ctx, entry.serviceName || entry.name);
      const hasGateway = isObj(service) && isFn(service.executeTool);
      if (declared.length >= 3 && !hasGateway) {
        rejected.push({ index, reason: 'unknown_action', block: entry.name, action });
        return;
      }
    }

    accepted.push({
      index,
      block: entry.name,
      requestedBlock: blockRaw,
      action,
      args: isObj(rawStep.args || rawStep.params || rawStep.arguments) ? rawStep.args || rawStep.params || rawStep.arguments : {}
    });
  });

  return { steps: accepted, rejected };
}

/* ---------------------------------------------------------------------------
 * 10. TEMPLATE / CONTEXT PASSING
 * ------------------------------------------------------------------------- */
function readScope(expr, scope) {
  if (!scope || !expr) return undefined;
  let pathExpr = String(expr).trim();
  if (!pathExpr) return undefined;

  // steps[0] -> steps.0 ; step1 -> steps.0
  pathExpr = pathExpr.replace(/\[\s*(\d+)\s*\]/g, '.$1');
  const stepMatch = pathExpr.match(/^step\s*(\d+)(\..+)?$/i);
  if (stepMatch) {
    const idx = parseInt(stepMatch[1], 10) - 1;
    pathExpr = `steps.${idx}` + (stepMatch[2] || '');
  }
  if (/^(prev|previous)$/i.test(pathExpr)) pathExpr = 'prev';
  if (/^(prompt|input|query)$/i.test(pathExpr)) pathExpr = 'prompt';

  const segments = pathExpr.split('.').filter(Boolean);
  let cursor = scope;
  for (const segment of segments) {
    if (cursor == null) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx)) return undefined;
      cursor = cursor[idx];
    } else if (isObj(cursor)) {
      if (!(segment in cursor)) return undefined;
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function stringifyValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function resolveTemplate(input, scope) {
  if (typeof input === 'string') {
    const whole = input.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (whole) {
      const resolved = readScope(whole[1], scope);
      return resolved === undefined ? input : resolved;
    }
    return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (full, expr) => {
      const resolved = readScope(expr, scope);
      return resolved === undefined ? full : stringifyValue(resolved);
    });
  }
  if (Array.isArray(input)) return input.map((item) => resolveTemplate(item, scope));
  if (isObj(input)) {
    const out = {};
    for (const key of Object.keys(input)) out[key] = resolveTemplate(input[key], scope);
    return out;
  }
  return input;
}

/* ---------------------------------------------------------------------------
 * 11. EXECUTION ENGINE
 * ------------------------------------------------------------------------- */
function normaliseToolResult(result) {
  if (result && typeof result === 'object' && ('ok' in result || 'success' in result)) {
    const ok = result.ok !== undefined ? !!result.ok : !!result.success;
    return {
      ok,
      data: result.data !== undefined ? result.data : result.result !== undefined ? result.result : result,
      error: result.error || null,
      raw: result
    };
  }
  return { ok: true, data: result === undefined ? null : result, error: null, raw: result };
}

async function executeStep(step, position, scope) {
  const entry = resolveEntry(state.ctx, step.block);
  if (!entry) throw new Error(`Block "${step.block}" is not registered`);

  const service = getServiceByName(state.ctx, entry.serviceName || entry.name);
  if (!service) throw new Error(`Service for block "${entry.name}" is unavailable`);

  const resolvedArgs = resolveTemplate(step.args || {}, scope);

  audit('info', 'orchestrator_step', {
    block: entry.name,
    action: step.action,
    step: position,
    args: truncate(JSON.stringify(resolvedArgs || {}), 500)
  });

 let invocation;
  if (isFn(service.executeTool)) {
    invocation = service.executeTool(step.action, resolvedArgs, { ctx: state.ctx });
  } else if (isFn(service[step.action])) {
    invocation = service[step.action](resolvedArgs, { ctx: state.ctx });
  } else {
    // Fallback to tool_librarian service if action is a registered tool name
    const librarian = getServiceByName(state.ctx, 'tool_librarian');
    if (librarian && isFn(librarian.executeToolByName)) {
      invocation = librarian.executeToolByName(step.action, resolvedArgs, { approved: true });
    } else {
      throw new Error(`Service "${entry.name}" exposes neither executeTool() nor a "${step.action}" method`);
    }
  }

  const raw = await withTimeout(
    Promise.resolve(invocation),
    LIMITS.STEP_TIMEOUT_MS,
    `Step ${position + 1} (${entry.name}.${step.action}) timed out after ${LIMITS.STEP_TIMEOUT_MS}ms`
  );

  return { entry, normalised: normaliseToolResult(raw), args: resolvedArgs };
}

async function executePlan(steps, ctx, meta) {
  const scope = {
    prompt: meta.prompt,
    steps: [],
    prev: null
  };
  const results = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const record = {
      index: i,
      block: step.block,
      action: step.action,
      ok: false,
      result: null,
      error: null
    };

    try {
      const { normalised, args } = await executeStep(step, i, scope);
      record.ok = normalised.ok;
      record.result = normalised.data;
      record.error = normalised.error;
      record.args = args;
    } catch (err) {
      record.ok = false;
      record.error = (err && err.message) || String(err);
      audit('error', 'orchestrator_step_failed', {
        block: step.block,
        action: step.action,
        step: i,
        error: record.error
      });
    }

    results.push(record);
    scope.steps.push(record);
    scope.prev = record;

    emitProgress(ctx, meta, {
      phase: 'step_complete',
      index: i,
      total: steps.length,
      block: step.block,
      action: step.action,
      ok: record.ok,
      error: record.error
    });

    if (!record.ok) {
      // Fail-fast: remaining steps likely depend on this output.
      for (let j = i + 1; j < steps.length; j += 1) {
        results.push({
          index: j,
          block: steps[j].block,
          action: steps[j].action,
          ok: false,
          result: null,
          error: 'skipped_due_to_previous_failure'
        });
      }
      break;
    }
  }

  return { results, scope };
}

/* ---------------------------------------------------------------------------
 * 12. RENDERER COMMUNICATION
 * ------------------------------------------------------------------------- */
function replyChannelFor(payload) {
  if (isObj(payload)) {
    const explicit = payload.replyChannel || payload.responseChannel || payload.channel;
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  }
  return RESPONSE_CHANNEL;
}

function requestIdFor(payload) {
  if (isObj(payload)) {
    const id = payload.requestId || payload.id || payload.correlationId;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function replyToRenderer(event, payload, original) {
  const channel = replyChannelFor(original);
  const requestId = requestIdFor(original);
  const envelope = Object.assign(
    {
      channel,
      requestId,
      ok: !!payload.ok,
      mode: payload.mode || 'orchestrator',
      ts: nowIso()
    },
    payload || {}
  );

  try {
    if (event && isFn(event.reply)) {
      event.reply(channel, envelope);
      return true;
    }
  } catch (_err) {
    /* fall through */
  }
  try {
    if (event && event.sender && isFn(event.sender.send) && !event.sender.isDestroyed()) {
      event.sender.send(channel, envelope);
      return true;
    }
  } catch (_err) {
    /* fall through */
  }
  try {
    if (state.ctx && isFn(state.ctx.reply)) {
      state.ctx.reply(channel, envelope);
      return true;
    }
  } catch (_err) {
    /* fall through */
  }

  audit('warn', 'orchestrator_reply_dropped', { channel, requestId });
  return false;
}

function emitProgress(ctx, meta, data) {
  try {
    const event = meta && meta.event;
    if (!event) return;
    const payload = Object.assign({ requestId: meta.requestId, ts: nowIso() }, data || {});
    if (isFn(event.reply)) {
      // Use a dedicated progress channel without hijacking the reply channel.
      if (event.sender && isFn(event.sender.send) && !event.sender.isDestroyed()) {
        event.sender.send(PROGRESS_CHANNEL, payload);
      }
      return;
    }
    if (event.sender && isFn(event.sender.send) && !event.sender.isDestroyed()) {
      event.sender.send(PROGRESS_CHANNEL, payload);
    }
  } catch (_err) {
    /* progress is best-effort only */
  }
}

function emitPlan(event, requestId, plan) {
  try {
    if (event && isFn(event.reply)) {
      event.reply(PLAN_CHANNEL, { requestId, plan, ts: nowIso() });
      return;
    }
    if (event && event.sender && isFn(event.sender.send) && !event.sender.isDestroyed()) {
      event.sender.send(PLAN_CHANNEL, { requestId, plan, ts: nowIso() });
    }
  } catch (_err) {
    /* best-effort */
  }
}

/* ---------------------------------------------------------------------------
 * 13. LEGACY (kernel_5) FALLBACK
 * ------------------------------------------------------------------------- */
/**
 * Take ownership of the IPC channel: any pre-existing listener (kernel_5 chat
 * mode) is captured and detached so the orchestrator becomes the single entry
 * point, while remaining available for fallback replay.
 */
function siphonLegacyListeners() {
  if (!ipcMain || !isFn(ipcMain.listeners)) return 0;
  let listeners = [];
  try {
    listeners = ipcMain.listeners(PROMPT_CHANNEL) || [];
  } catch (_err) {
    return 0;
  }

  let captured = 0;
  for (const listener of listeners) {
    if (!isFn(listener)) continue;
    if (listener === state.handlerRef || listener.__nezaOrchestrator) continue;
    if (state.legacySet.has(listener)) continue;
    state.legacySet.add(listener);
    state.legacyListeners.push(listener);
    captured += 1;
    try {
      ipcMain.removeListener(PROMPT_CHANNEL, listener);
    } catch (_err) {
      /* ignore */
    }
  }

  if (captured) audit('info', 'orchestrator_legacy_captured', { count: captured });
  return captured;
}

function fallbackToLegacy(event, payload, reason) {
  // Do NOT siphon here. It captures our own callers and causes infinite loops.

  audit('warn', 'orchestrator_fallback', {
    reason: reason || 'unspecified',
    legacyCount: state.legacyListeners.length
  });

  if (!state.legacyListeners.length) {
    replyToRenderer(
      event,
      {
        ok: false,
        mode: 'fallback-unavailable',
        error: reason || 'orchestrator could not plan and no legacy chat handler is registered',
        text: 'I could not plan that request with the available blocks, and chat fallback (kernel_5) is not loaded.',
        plan: [],
        results: []
      },
      payload
    );
    return false;
  }

  // Only call the FIRST captured listener to prevent duplicate responses.
  if (state.legacyListeners.length > 0) {
    const listener = state.legacyListeners[0];
    try {
      listener(event, payload);
    } catch (err) {
      audit('error', 'orchestrator_legacy_listener_error', { error: err && err.message });
    }
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * 14. MAIN HANDLER
 * ------------------------------------------------------------------------- */
function extractPromptText(payload) {
  if (typeof payload === 'string') return payload;
  if (isObj(payload)) {
    const candidate = payload.prompt || payload.text || payload.message || payload.query || payload.input;
    if (typeof candidate === 'string') return candidate;
    if (isObj(payload.data) && typeof payload.data.prompt === 'string') return payload.data.prompt;
  }
  return '';
}

function extractHistory(payload) {
  if (!isObj(payload)) return [];
  const raw = payload.history || payload.messages || payload.context || payload.conversation;
  if (!Array.isArray(raw)) return [];
  return raw.slice(-LIMITS.PLANNER_HISTORY_TURNS);
}

async function handlePrompt(event, payload) {
  const requestId = requestIdFor(payload);
  const prompt = extractPromptText(payload);

// INTERNAL COMMAND & BROWSER GUARD: Bypass orchestrator for UI/Browser tags or direct URL/website open requests
  const isDirectBrowserOpen = /^\s*(open|browse|visit|go\s+to)\s+(youtube|google|facebook|github|https?:\/\/|\S+\.(com|org|net|bd|io))\b/i.test(prompt || '');
  if (prompt && (prompt.startsWith('__') || prompt.startsWith('/') || isDirectBrowserOpen)) {
    return fallbackToLegacy(event, payload, 'internal_or_browser_bypass');
  }
  const meta = {
    requestId,
    event,
    sessionId: isObj(payload) ? payload.sessionId || payload.session : null
  };

  // Do not siphon here, it causes loops with kernel_10, 11, 12

  if (!prompt || !prompt.trim()) {
    return fallbackToLegacy(event, payload, 'empty_prompt');
  }

  state.activeRequests.set(requestId, { startedAt: Date.now() });
  audit('info', 'orchestrator_prompt', { requestId, chars: prompt.length });

  try {
    // ---- Step 1: discovery -------------------------------------------------
    discoverBlocks(state.ctx);

    // ---- Step 2: planning --------------------------------------------------
    const planResult = await requestPlan(prompt, extractHistory(payload), Object.assign(meta, { ctx: state.ctx }));

    if (!planResult.plan || !planResult.plan.length) {
      return fallbackToLegacy(event, payload, planResult.reason || 'empty_plan');
    }

    // ---- Step 3: validation ------------------------------------------------
    const { steps, rejected } = validatePlan(planResult.plan, state.ctx);

    if (!steps.length) {
      audit('warn', 'orchestrator_plan_rejected', { rejected });
      return fallbackToLegacy(event, payload, 'no_valid_steps');
    }

    state.lastPlan = { requestId, provider: planResult.provider, steps, rejected, ts: nowIso() };
    emitPlan(event, requestId, steps);

    // ---- Step 4: execution -------------------------------------------------
    const { results } = await executePlan(steps, state.ctx, meta);

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const lastResult = results.length ? results[results.length - 1] : null;

    const summary = results.map((r) => {
      const head = `${r.index + 1}. ${r.block}.${r.action}`;
      return r.ok ? `${head} — ok` : `${head} — failed (${r.error || 'unknown error'})`;
    });

    const displayText = buildDisplayText(results, prompt);

    replyToRenderer(
      event,
      {
        ok: failed.length === 0,
        mode: 'orchestrator',
        provider: planResult.provider,
        requestId,
        plan: steps.map((s) => ({ block: s.block, action: s.action, args: s.args })),
        results: results.map((r) => ({
          index: r.index,
          block: r.block,
          action: r.action,
          ok: r.ok,
          error: r.error,
          data: truncateJson(r.result, LIMITS.MAX_RESULT_CHARS)
        })),
        rejected,
        stats: { steps: results.length, succeeded, failed: failed.length },
        text: displayText,
        summary,
        answer: lastResult && lastResult.ok ? truncateJson(lastResult.result, 2000) : null
      },
      payload
    );

    audit('info', 'orchestrator_complete', {
      requestId,
      steps: results.length,
      succeeded,
      failed: failed.length
    });

    return true;
  } catch (err) {
    const message = (err && err.message) || String(err);
    audit('error', 'orchestrator_error', { requestId, error: message });
    try {
      return fallbackToLegacy(event, payload, `orchestrator_error: ${message}`);
    } catch (innerErr) {
      audit('error', 'orchestrator_fallback_crashed', {
        requestId,
        error: (innerErr && innerErr.message) || String(innerErr)
      });
      replyToRenderer(
        event,
        {
          ok: false,
          mode: 'error',
          error: message,
          text: 'Something went wrong while planning that request. Please try again.'
        },
        payload
      );
      return false;
    }
  } finally {
    state.activeRequests.delete(requestId);
  }
}

function truncateJson(value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) + '…' : value;
  try {
    const serialised = JSON.stringify(value);
    if (serialised.length <= max) return value;
    return serialised.slice(0, max) + '…';
  } catch (_err) {
    return String(value).slice(0, max);
  }
}

function buildDisplayText(results, prompt) {
  const ok = results.filter((r) => r && r.ok);
  const failed = results.filter((r) => r && !r.ok);

  if (!results.length) return 'No steps were executed.';

  if (failed.length) {
    const first = failed[0];
    return `Executed ${ok.length}/${results.length} step(s). Failed at ${first.block}.${first.action}: ${first.error || 'unknown error'}`;
  }

  const last = results[results.length - 1];
  const data = last.result;

  if (typeof data === 'string' && data.trim()) return data.trim();
  
  if (isObj(data)) {
    // ১. Core Memory রেসপন্স ফরম্যাট
    if (data.profile && data.profile.name) {
      const p = data.profile;
      return `আপনার নাম: ${p.name}\nআপনার রোল: ${p.role || 'N/A'}\nসিস্টেম: ${p.systemName || 'NEZA'}`;
    }
    // ২. Behavior Rules রেসপন্স ফরম্যাট
    if (data.rules && Array.isArray(data.rules)) {
      return `Rules:\n` + data.rules.map(r => `- ${r.instruction}`).join('\n');
    }
    // ৩. Vault Search রেসপন্স ফরম্যাট
    if (data.results && Array.isArray(data.results)) {
      if (data.results.length === 0) return 'No relevant memory found in Vault.';
      return `Found ${data.results.length} result(s):\n` + data.results.map((r, i) => `${i+1}. ${r.content}`).join('\n\n');
    }
    // ৪. সাধারণ ফরম্যাট
    const candidate = data.text || data.message || data.reply || data.answer || data.content;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    
    return JSON.stringify(data, null, 2);
  }
  
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);

  if (results.length === 1) {
    return `Done: ${last.block}.${last.action}`;
  }
  return `Done — executed ${results.length} step(s): ` + results.map((r) => `${r.block}.${r.action}`).join(' → ');
}

/* ---------------------------------------------------------------------------
 * 15. PUBLIC SERVICE SURFACE
 * ------------------------------------------------------------------------- */
function createOrchestratorApi() {
  return {
    name: 'orchestrator',
    version: '1.0.0',
    description: 'Central Brain: capability discovery + LLM planning + graph execution.',
    capabilities: ['plan', 'execute', 'discover', 'capabilities'],

    /** Re-scan 02_MODULES + runtime services. */
    discover() {
      const result = discoverBlocks(state.ctx);
      return {
        ok: true,
        modulesRoot: result.modulesRoot,
        blocks: Array.from(state.registry.values()).map((entry) => ({
          block: entry.name,
          source: entry.source,
          description: entry.description,
          actions: (entry.actions || []).map((a) => a.action)
        }))
      };
    },

    /** Compact manifest of every block and action, for UI / other agents. */
    capabilities() {
      return { ok: true, blocks: buildManifestForPrompt() };
    },

    /** Generate a plan without executing it. */
    async plan(prompt, options) {
      discoverBlocks(state.ctx);
      const opts = isObj(options) ? options : {};
      const result = await requestPlan(String(prompt || ''), opts.history || [], opts);
      const { steps, rejected } = validatePlan(result.plan, state.ctx);
      return { ok: steps.length > 0, provider: result.provider, steps, rejected };
    },

    /** Execute a pre-built plan. */
    async execute(plan, options) {
      discoverBlocks(state.ctx);
      const { steps, rejected } = validatePlan(plan, state.ctx);
      if (!steps.length) return { ok: false, steps: [], rejected, results: [] };
      const opts = isObj(options) ? options : {};
      const { results } = await executePlan(steps, state.ctx, {
        prompt: opts.prompt || '',
        requestId: opts.requestId || requestIdFor({}),
        event: null
      });
      return { ok: results.every((r) => r.ok), steps, rejected, results };
    },

    /** Unified tool entry-point so the orchestrator is callable like any block. */
    async executeTool(action, args) {
      const payload = isObj(args) ? args : {};
      switch (action) {
        case 'plan':
          return this.plan(payload.prompt || payload.text, payload);
        case 'execute':
          return this.execute(payload.plan || payload.steps || [], payload);
        case 'discover':
        case 'capabilities':
          return this[ action === 'discover' ? 'discover' : 'capabilities' ]();
        default:
          throw new Error(`orchestrator does not support action "${action}"`);
      }
    },

    /** Full pipeline: plan then execute. */
    async run(prompt, options) {
      const planned = await this.plan(prompt, options);
      if (!planned.ok) return { ok: false, provider: planned.provider, steps: [], results: [], rejected: planned.rejected };
      const executed = await this.execute(planned.steps, Object.assign({ prompt }, options || {}));
      return { ok: executed.ok, provider: planned.provider, steps: planned.steps, results: executed.results };
    }
  };
}

/* ---------------------------------------------------------------------------
 * 16. INIT
 * ------------------------------------------------------------------------- */
function init(ctx) {
  if (state.initialized) {
    audit('warn', 'orchestrator_already_initialized', {});
    return createOrchestratorApi();
  }

  state.ctx = ctx || {};

  // 1) settings + credentials
  state.settings = loadSettings(state.ctx);

  // 2) capability discovery (best-effort; never fatal)
  try {
    discoverBlocks(state.ctx);
  } catch (err) {
    audit('error', 'orchestrator_discovery_failed', { error: (err && err.message) || String(err) });
  }

  // 3) IPC binding
  if (ipcMain && isFn(ipcMain.on)) {
    // Capture and detach any legacy listeners already attached (kernel_5).
    siphonLegacyListeners();

    const handler = function nezaOrchestratorHandler(event, payload) {
      // The orchestrator must never destabilise the host app.
      Promise.resolve()
        .then(() => handlePrompt(event, payload))
        .catch((err) => {
          audit('error', 'orchestrator_unhandled', { error: (err && err.message) || String(err) });
          try {
            fallbackToLegacy(event, payload, 'unhandled_orchestrator_error');
          } catch (_inner) {
            /* swallow */
          }
        });
    };
    handler.__nezaOrchestrator = true;
    state.handlerRef = handler;

    try {
      ipcMain.on(PROMPT_CHANNEL, handler);
    } catch (err) {
      audit('error', 'orchestrator_ipc_bind_failed', { error: (err && err.message) || String(err) });
    }
  } else {
    audit('warn', 'orchestrator_no_ipc', { reason: 'ipcMain unavailable (non-Electron context)' });
  }

  // 4) expose as a service so other blocks can call the orchestrator
  const api = createOrchestratorApi();
  try {
    if (isFn(state.ctx.registerService)) state.ctx.registerService('orchestrator', api);
    else if (isObj(state.ctx.services)) state.ctx.services.orchestrator = api;
  } catch (err) {
    audit('warn', 'orchestrator_service_register_failed', { error: (err && err.message) || String(err) });
  }

  state.initialized = true;

  audit('info', 'orchestrator_ready', {
    settingsPath: state.settingsPath,
    blocks: state.registry.size,
    legacyListeners: state.legacyListeners.length,
    providers: resolveProviders().map((p) => p.id)
  });

  return api;
}

/* ---------------------------------------------------------------------------
 * 17. EXPORTS
 * ------------------------------------------------------------------------- */
module.exports = {
  name: 'orchestrator',
  version: '1.0.0',
  channel: PROMPT_CHANNEL,
  init,
  // Internals exposed for unit tests / diagnostics only.
  _internal: {
    discoverBlocks,
    validatePlan,
    extractPlanPayload,
    resolveTemplate,
    normaliseName,
    normaliseToolResult,
    buildManifestForPrompt,
    getState() {
      return state;
    }
  }
};
