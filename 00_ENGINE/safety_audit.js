'use strict';
/**
 * JARVIS-CORE Phase 1 - safety_audit.js
 *
 * Policy and audit primitives. No Electron import and no side effects at require time.
 *   - Risk classifier (READ < WRITE_SAFE < RISKY < FORBIDDEN), driven by system_rules.json
 *   - Forbidden path, window title and process policy
 *   - Fail-closed JSONL audit logger with masking (logs/YYYY-MM-DD.jsonl)
 *   - 3-tier kill-switch verifier (reports readiness; does not change state)
 */
const fs = require('fs');
const path = require('path');

const RISK = Object.freeze({ READ: 'READ', WRITE_SAFE: 'WRITE_SAFE', RISKY: 'RISKY', FORBIDDEN: 'FORBIDDEN' });
const RISK_ORDER = Object.freeze(['READ', 'WRITE_SAFE', 'RISKY', 'FORBIDDEN']);
const RESULT = Object.freeze({ STARTED: 'STARTED', OK: 'OK', BLOCKED: 'BLOCKED', ERROR: 'ERROR', CANCELLED: 'CANCELLED' });
const KILL = Object.freeze({ ARMED: 'ARMED', SOFT_STOP: 'SOFT_STOP', EMERGENCY: 'EMERGENCY', AUTO_STOP: 'AUTO_STOP' });

const WRITE_ACTIONS = new Set(['fs.write_local', 'report.write', 'fs.delete']);
const MAX_TARGET_LEN = 240;
const MAX_ERROR_LEN = 300;
const CARD_LIKE = /\b(?:\d[ -]?){12,18}\d\b/;

class AuditWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditWriteError';
  }
}

function maxLevel(a, b) {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandPlaceholders(input, vars) {
  let out = String(input);
  for (const [name, value] of Object.entries(vars)) out = out.split(`%${name}%`).join(value);
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => (process.env[name] ?? match));
  return path.normalize(out);
}

function normalizeForCompare(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

function isUnder(target, roots) {
  const t = normalizeForCompare(target);
  return roots.some((root) => {
    const r = normalizeForCompare(root);
    return t === r || t.startsWith(r + path.sep);
  });
}

function looksLikePath(s) {
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\');
}

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function stopFlagExists(flagPath) {
  return !!flagPath && fs.existsSync(flagPath);
}

function localDayStamp(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function truncate(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function validateRules(raw) {
  const required = [
    'risk_levels', 'action_risk', 'default_unknown_action_risk', 'forbidden_paths',
    'allowed_write_roots', 'forbidden_processes', 'forbidden_title_keywords',
    'allowed_title_keywords', 'sensitive_keywords',
  ];
  for (const key of required) {
    if (!(key in raw)) throw new Error(`system_rules.json: missing "${key}"`);
  }
  for (const lvl of RISK_ORDER) {
    if (!raw.risk_levels[lvl]) throw new Error(`system_rules.json: risk_levels.${lvl} missing`);
  }
  if (!RISK_ORDER.includes(raw.default_unknown_action_risk)) {
    throw new Error('system_rules.json: default_unknown_action_risk is not a valid level');
  }
  for (const [action, lvl] of Object.entries(raw.action_risk)) {
    if (!RISK_ORDER.includes(lvl)) throw new Error(`system_rules.json: action_risk.${action} invalid level`);
  }
}

/**
 * Load and normalise system_rules.json.
 * @param {string} file  absolute path to system_rules.json
 * @param {object} vars  placeholder map, e.g. { JARVIS_ROOT, ENGINE, CONFIG, MODULES }
 */
function loadRules(file, vars) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateRules(raw);
  const sensitive = raw.sensitive_keywords.filter(Boolean);
  return {
    riskLevels: raw.risk_levels,
    actionRisk: raw.action_risk,
    defaultRisk: raw.default_unknown_action_risk,
    forbiddenPaths: raw.forbidden_paths.map((p) => expandPlaceholders(p, vars)),
    allowedWriteRoots: raw.allowed_write_roots.map((p) => expandPlaceholders(p, vars)),
    forbiddenProcesses: raw.forbidden_processes.map((s) => s.toLowerCase()),
    forbiddenTitleKeywords: raw.forbidden_title_keywords.filter(Boolean).map((s) => s.toLowerCase()),
    allowedTitleKeywords: raw.allowed_title_keywords.filter(Boolean).map((s) => s.toLowerCase()),
    sensitiveRegex: sensitive.length
      ? new RegExp(`\\b(?:${sensitive.map(escapeRe).join('|')})\\b`, 'i')
      : /$^/,
    cardLikeRegex: CARD_LIKE,
  };
}

/**
 * Title policy shared by kernel and os_hands.
 * Returns null when allowed, or { code, title } when blocked.
 */
function titleVerdict(rules, title) {
  const t = String(title ?? '').toLowerCase();
  if (rules.forbiddenTitleKeywords.some((k) => t.includes(k))) {
    return { code: 'FORBIDDEN_WINDOW', title: String(title ?? '') };
  }
  if (rules.allowedTitleKeywords.length && !rules.allowedTitleKeywords.some((k) => t.includes(k))) {
    return { code: 'UNEXPECTED_WINDOW', title: String(title ?? '') };
  }
  return null;
}

/**
 * Classify an action. Level is the strictest of: action default, target policy.
 * @returns {{ level: string, reasons: string[] }}
 */
function classify(rules, action, target = '') {
  const reasons = [];
  const known = Object.prototype.hasOwnProperty.call(rules.actionRisk, action);
  let level = known ? rules.actionRisk[action] : rules.defaultRisk;
  if (!known) reasons.push('unknown_action_default');

  const t = String(target ?? '');
  if (t.startsWith('window:')) {
    if (titleVerdict(rules, t.slice('window:'.length))) {
      level = maxLevel(level, RISK.FORBIDDEN);
      reasons.push('forbidden_window');
    }
  } else if (looksLikePath(t)) {
    if (isUnder(t, rules.forbiddenPaths)) {
      level = maxLevel(level, RISK.FORBIDDEN);
      reasons.push('forbidden_path');
    } else if (WRITE_ACTIONS.has(action) && !isUnder(t, rules.allowedWriteRoots)) {
      level = maxLevel(level, RISK.RISKY);
      reasons.push('write_outside_allowed_roots');
    }
  }
  return { level, reasons };
}

function isSensitive(rules, action, target, explicit) {
  if (explicit === true) return true;
  const text = `${action ?? ''} ${target ?? ''}`;
  return rules.sensitiveRegex.test(text) || rules.cardLikeRegex.test(text);
}

/**
 * Fail-closed JSONL audit logger.
 * write() is synchronous and fsyncs. It throws AuditWriteError on any failure,
 * and the caller must abort the action.
 */
function createAuditLogger({ logDir, sessionId, rules }) {
  fs.mkdirSync(logDir, { recursive: true });
  if (!canWrite(logDir)) throw new AuditWriteError(`audit directory not writable: ${logDir}`);

  const fileFor = (date = new Date()) => path.join(logDir, `${localDayStamp(date)}.jsonl`);

  return {
    dir: logDir,
    fileFor,
    write(entry) {
      const now = new Date();
      const sensitive = isSensitive(rules, entry.action, entry.target, entry.sensitive);
      const record = {
        time: now.toISOString(),
        session_id: sessionId,
        mode: entry.mode ?? 'UNKNOWN',
        module: entry.module ?? 'kernel',
        action: entry.action,
        target: sensitive ? 'MASKED' : truncate(entry.target ?? '', MAX_TARGET_LEN),
        risk_level: entry.risk_level ?? RISK.READ,
        result: entry.result,
        error_msg: entry.error_msg
          ? (sensitive ? 'MASKED' : truncate(entry.error_msg, MAX_ERROR_LEN))
          : null,
        duration_ms: Math.max(0, Math.round(entry.duration_ms ?? 0)),
        stop_state: entry.stop_state ?? KILL.ARMED,
      };

      const buf = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      let fd = null;
      try {
        fd = fs.openSync(fileFor(now), 'a');
        let offset = 0;
        while (offset < buf.length) {
          offset += fs.writeSync(fd, buf, offset, buf.length - offset);
        }
        fs.fsyncSync(fd);
      } catch (err) {
        throw new AuditWriteError(`audit write failed: ${err.message}`);
      } finally {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch (_) { /* ignore close errors */ }
        }
      }
      return record;
    },
  };
}

/**
 * Verify the three kill-switch tiers without changing any state.
 * Tier 1: STOP.flag location is writable.
 * Tier 2: hotkey and /stop hook are active.
 * Tier 3: rules are loaded and audit directory is writable.
 */
function verifyKillSwitch({ rootDir, stopFlagPath, logDir, hotkeyOk, stopHookOk, rulesLoaded, handsRunning }) {
  const probe = path.join(rootDir, `.kill_probe_${process.pid}`);
  const tier1 = { flagPresent: stopFlagExists(stopFlagPath), writable: false, error: null };
  try {
    fs.writeFileSync(probe, 'probe', 'utf8');
    fs.unlinkSync(probe);
    tier1.writable = true;
  } catch (err) {
    tier1.error = err.message;
    try { fs.unlinkSync(probe); } catch (_) { /* probe may not exist */ }
  }

  const tier2 = {
    hotkeyRegistered: !!hotkeyOk,
    stopHookListening: !!stopHookOk,
    handsRunning: !!handsRunning,
  };
  const tier3 = {
    rulesLoaded: !!rulesLoaded,
    auditDirWritable: canWrite(logDir),
  };
  const ready = tier1.writable && tier2.hotkeyRegistered && tier2.stopHookListening
    && tier3.rulesLoaded && tier3.auditDirWritable;

  return {
    status: ready ? 'READY' : 'DEGRADED',
    tier1,
    tier2,
    tier3,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  RISK,
  RISK_ORDER,
  RESULT,
  KILL,
  AuditWriteError,
  maxLevel,
  loadRules,
  titleVerdict,
  classify,
  createAuditLogger,
  stopFlagExists,
  verifyKillSwitch,
};