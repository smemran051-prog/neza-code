'use strict';

/**
 * JARVIS-CORE Tool: advanced_cli_daemon
 * Location : 00_ENGINE/tools/advanced_cli_daemon.js
 * Runtime  : Node.js (CommonJS), Windows first. Built-in modules only.
 *
 * Modes (args.action):
 *   run_sync        - run a command, capture output, enforce timeout
 *   start_bg        - start a long-running job with a log file and registry entry
 *   status          - job state, elapsed time and recent log lines
 *   list            - all tracked jobs with live state and counts
 *   stop            - stop a job (or pid) and its whole process tree
 *   build_preset    - one-click builds: pkg / electron-builder / PyInstaller / Gradle
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const NAME = 'advanced_cli_daemon';
const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..', '..');
const IS_WIN = process.platform === 'win32';

const CLI_DIR = path.join(ROOT, 'work', 'cli_daemon');
const LOG_DIR = path.join(CLI_DIR, 'logs');
const REGISTRY_FILE = path.join(CLI_DIR, 'process_registry.json');

const GRACE_MS = 1500;
const TAIL_BYTES = 64 * 1024;
const CAPTURE_LIMIT = 1024 * 1024;
const SYNC_TIMEOUT_DEFAULT = 60000;
const SYNC_TIMEOUT_MAX = 300000;
const GRACEFUL_WAIT_MS = 3000;
const MAX_JOBS = 500;

// Drive-level destructive commands. They need approval when they target an internal drive.
const DESTRUCTIVE_PATTERNS = [
  /\bformat(?:\.com)?\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\b(?:format-volume|clear-disk|remove-partition|initialize-disk)\b/i,
  /\b(?:del|erase|rd|rmdir|remove-item)\b[^\n]*\s[a-z]:\\?(?=\s|$|["'&|*])/i,
  /\brm\s+-[a-z]*r[a-z]*\s+\/(?=\s|$|\*)/i,
];
// Win32_LogicalDisk.DriveType: 2 = removable (external), 3 = local fixed (internal), 4 = network, 5 = optical.
const DRIVE_TYPE_INTERNAL = 3;

const liveChildren = new Map();
let registry = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function errCode(err) {
  if (err && err.code) return String(err.code);
  return err && err.message ? String(err.message) : 'UNKNOWN';
}

function fail(action, message, extra) {
  return Object.assign({ ok: false, action, error: message }, extra || {});
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${field}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function normalizeArgs(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('"args" must be an array of strings');
  return raw.map((a) => String(a));
}

function sanitizeEnv(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = String(raw[key]);
  }
  return out;
}

function sanitizeLabel(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64);
}

function sanitizeName(value) {
  const s = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
}

function newJobId() {
  return `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function commandLine(command, args) {
  return [command, ...args].join(' ');
}

function isDestructive(text) {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(text));
}

// Returns the Win32 DriveType for a letter, or null when it cannot be determined.
function getDriveType(letter) {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve(null);
    const script = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").DriveType`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const n = parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(n) ? n : null);
      }
    );
  });
}

// Returns null when the command may run now. Otherwise returns an approval request.
// Approval comes only from ctx.approved (set by the kernel after the user clicks Approve).
// Values in the model's args are never trusted for approval.
async function approvalGate(line, ctx) {
  if (!isDestructive(line)) return null;
  if (ctx && ctx.approved === true) return null;
  const letters = [...new Set([...line.matchAll(/\b([a-z]):/gi)].map((m) => m[1].toUpperCase()))];
  if (letters.length === 0) {
    return { reason: 'Destructive command with no drive letter. Approval required.', drives: [] };
  }
  const types = await Promise.all(letters.map((l) => getDriveType(l)));
  const internal = letters.filter((_, i) => types[i] === null || types[i] === DRIVE_TYPE_INTERNAL);
  if (internal.length === 0) return null; // external-only target: no approval needed
  return { reason: 'Destructive command targets an internal drive. Approval required.', drives: internal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

function resolveCwd(raw) {
  if (raw === undefined || raw === null || raw === '') return { abs: ROOT };
  const abs = path.resolve(ROOT, String(raw));
  try {
    if (!fs.statSync(abs).isDirectory()) return { error: `Not a directory: ${abs}` };
  } catch (err) {
    return { error: `Working directory not found: ${abs} (${errCode(err)})` };
  }
  return { abs };
}

async function audit(ctx, event) {
  if (!ctx || typeof ctx.audit !== 'function') return;
  try {
    await ctx.audit(Object.assign({ tool: NAME, ts: new Date().toISOString() }, event));
  } catch (_) {
    // Logging never blocks an operation.
  }
}

// ---------------------------------------------------------------------------
// Spawning (Windows uses cmd.exe so .bat, .cmd, npx and gradlew.bat work)
// ---------------------------------------------------------------------------
function quoteArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

function buildSpawnPlan(command, args) {
  if (IS_WIN) {
    const line = args.length > 0 ? [command, ...args].map(quoteArg).join(' ') : command;
    return {
      file: process.env.ComSpec || 'cmd.exe',
      argv: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true,
    };
  }
  if (args.length > 0) return { file: command, argv: args, verbatim: false };
  return { file: '/bin/sh', argv: ['-c', command], verbatim: false };
}

function spawnProcess(command, args, opts) {
  const plan = buildSpawnPlan(command, args);
  const spawnOpts = {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN && !!opts.detached,
    shell: false,
  };
  if (IS_WIN) spawnOpts.windowsVerbatimArguments = plan.verbatim;
  return spawn(plan.file, plan.argv, spawnOpts);
}

// ---------------------------------------------------------------------------
// Process liveness and termination
// ---------------------------------------------------------------------------
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function killTree(pid, force) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    if (IS_WIN) {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      execFile('taskkill', args, { windowsHide: true }, (err) => resolve(!err));
      return;
    }
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(-pid, signal);
    } catch (_) {
      try {
        process.kill(pid, signal);
      } catch (err) {
        return resolve(false);
      }
    }
    resolve(true);
  });
}

// Graceful request first, then forced tree kill if the process is still alive.
async function terminatePid(pid) {
  if (!isAlive(pid)) return 'gone';
  await killTree(pid, false);
  const deadline = Date.now() + GRACEFUL_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return 'graceful';
    await sleep(200);
  }
  await killTree(pid, true);
  await sleep(300);
  return isAlive(pid) ? 'failed' : 'forced';
}

// ---------------------------------------------------------------------------
// Registry (process_registry.json)
// ---------------------------------------------------------------------------
function loadRegistry() {
  if (registry) return registry;
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    registry = { version: 1, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch (_) {
    registry = { version: 1, jobs: [] };
  }
  return registry;
}

function saveRegistry() {
  const reg = loadRegistry();
  if (reg.jobs.length > MAX_JOBS) {
    const excess = reg.jobs.length - MAX_JOBS;
    const drop = new Set(reg.jobs.filter((j) => j.status !== 'running').slice(0, excess).map((j) => j.job_id));
    reg.jobs = reg.jobs.filter((j) => !drop.has(j.job_id));
  }
  fs.mkdirSync(CLI_DIR, { recursive: true });
  const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch (_) {
    try { fs.unlinkSync(REGISTRY_FILE); } catch (__) { /* nothing to replace */ }
    fs.renameSync(tmp, REGISTRY_FILE);
  }
}

function findJob(input) {
  const jobs = loadRegistry().jobs;
  if (input.job_id) return jobs.find((j) => j.job_id === String(input.job_id)) || null;
  if (input.label) {
    const want = sanitizeLabel(input.label);
    const matches = jobs.filter((j) => j.label === want);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }
  return null;
}

function elapsedSec(job) {
  const end = job.finished_at ? Date.parse(job.finished_at) : Date.now();
  return Math.round((end - Date.parse(job.start_time)) / 100) / 10;
}

function publicJob(job) {
  return {
    job_id: job.job_id,
    label: job.label,
    pid: job.pid,
    status: job.status,
    exit_code: job.exit_code,
    start_time: job.start_time,
    finished_at: job.finished_at,
    elapsed_sec: elapsedSec(job),
    log_file: job.log_file,
    note: job.note,
  };
}

function refreshJob(job) {
  if (job.status !== 'running' || liveChildren.has(job.job_id)) return;
  if (job.pid && isAlive(job.pid)) return;
  job.status = 'failed';
  job.exit_code = null;
  job.finished_at = new Date().toISOString();
  job.note = 'process was no longer tracked and is not alive; exit code unknown';
  saveRegistry();
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
function makeLineStamper(tag) {
  let pending = '';
  return {
    push(chunk) {
      const parts = (pending + chunk.toString('utf8')).split(/\r?\n/);
      pending = parts.pop();
      return parts.map((line) => `${new Date().toISOString()} [${tag}] ${line}\n`).join('');
    },
    flush() {
      if (!pending) return '';
      const out = `${new Date().toISOString()} [${tag}] ${pending}\n`;
      pending = '';
      return out;
    },
  };
}

function tailLines(file, count) {
  let fd;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    let lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines = lines.slice(1);
    return lines.filter((l) => l.length > 0).slice(-count);
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* already closed */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Mode: run_sync
// ---------------------------------------------------------------------------
async function runSync(input, ctx) {
  const command = requireString(input.command, 'command');
  const args = normalizeArgs(input.args);
  const cwd = resolveCwd(input.cwd);
  if (cwd.error) return fail('run_sync', cwd.error);
  const line = commandLine(command, args);
  const gate = await approvalGate(line, ctx);
  if (gate) return fail('run_sync', gate.reason, { approval_required: true, drives: gate.drives, command: line });

  const timeoutMs = clampInt(input.timeout_ms, 1000, SYNC_TIMEOUT_MAX, SYNC_TIMEOUT_DEFAULT);
  const env = Object.assign({}, process.env, sanitizeEnv(input.env));
  await audit(ctx, { action: 'run_sync', command: line, cwd: cwd.abs, destructive: isDestructive(line) });

  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawnProcess(command, args, { cwd: cwd.abs, env, detached: true });
    } catch (err) {
      resolve(fail('run_sync', `Spawn failed: ${err.message}`));
      return;
    }

    const out = { stdout: '', stderr: '', truncated: false };
    const collect = (key) => (chunk) => {
      if (out[key].length >= CAPTURE_LIMIT) {
        out.truncated = true;
        return;
      }
      out[key] += chunk.toString('utf8');
      if (out[key].length > CAPTURE_LIMIT) {
        out[key] = out[key].slice(0, CAPTURE_LIMIT);
        out.truncated = true;
      }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const buildResult = (code, errMsg) => ({
      ok: !timedOut && code === 0 && !errMsg,
      action: 'run_sync',
      command: line,
      exit_code: code === undefined ? null : code,
      timed_out: timedOut,
      duration_ms: Date.now() - started,
      stdout: out.stdout,
      stderr: errMsg ? `${out.stderr}\n${errMsg}` : out.stderr,
      truncated: out.truncated,
    });

    timer = setTimeout(async () => {
      timedOut = true;
      await killTree(child.pid, true);
      finish(buildResult(null, `timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.on('error', (err) => finish(buildResult(null, err.message)));
    child.on('close', (code) => finish(buildResult(code, null)));
  });
}

// ---------------------------------------------------------------------------
// Mode: start_bg
// ---------------------------------------------------------------------------
async function startBg(input, ctx) {
  const command = requireString(input.command, 'command');
  const args = normalizeArgs(input.args);
  const cwd = resolveCwd(input.cwd);
  if (cwd.error) return fail('start_bg', cwd.error);
  const line = commandLine(command, args);
  const gate = await approvalGate(line, ctx);
  if (gate) return fail('start_bg', gate.reason, { approval_required: true, drives: gate.drives, command: line });

  const env = Object.assign({}, process.env, sanitizeEnv(input.env));
  const label = sanitizeLabel(input.label) || sanitizeLabel(command) || 'job';
  const jobId = newJobId();
  const logFile = path.join(LOG_DIR, `${jobId}.log`);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  let child;
  try {
    child = spawnProcess(command, args, { cwd: cwd.abs, env, detached: true });
  } catch (err) {
    logStream.end();
    return fail('start_bg', `Spawn failed: ${err.message}`);
  }

  const job = {
    job_id: jobId,
    pid: child.pid || null,
    label,
    command: line,
    cwd: cwd.abs,
    start_time: new Date().toISOString(),
    finished_at: null,
    status: 'running',
    exit_code: null,
    log_file: logFile,
    note: null,
  };
  loadRegistry().jobs.push(job);
  liveChildren.set(jobId, child);
  saveRegistry();

  const outStamp = makeLineStamper('OUT');
  const errStamp = makeLineStamper('ERR');
  child.stdout.on('data', (chunk) => logStream.write(outStamp.push(chunk)));
  child.stderr.on('data', (chunk) => logStream.write(errStamp.push(chunk)));

  let finalized = false;
  const finalize = (status, code, note) => {
    if (finalized) return;
    finalized = true;
    const flushed = outStamp.flush() + errStamp.flush();
    if (job.status === 'running') job.status = status;
    job.exit_code = code === undefined ? null : code;
    job.finished_at = new Date().toISOString();
    if (note) job.note = note;
    logStream.end(`${flushed}${job.finished_at} [SYS] process ended: status=${job.status} exit_code=${job.exit_code}\n`);
    liveChildren.delete(jobId);
    try {
      saveRegistry();
    } catch (_) {
      // Registry write failed; the in-memory state stays correct for this session.
    }
  };

  child.on('error', (err) => finalize('failed', null, `spawn or runtime error: ${err.message}`));
  child.on('close', (code) => finalize(code === 0 ? 'completed' : 'failed', code, null));

  await audit(ctx, { action: 'start_bg', job_id: jobId, pid: job.pid, label, command: line, cwd: cwd.abs });

  // Grace period: catch immediate startup errors without freezing on long jobs.
  const settled = await new Promise((resolve) => {
    if (finalized) return resolve(true);
    const timer = setTimeout(() => resolve(finalized), GRACE_MS);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', done);
    child.once('error', done);
  });

  if (settled) {
    await new Promise((resolve) => {
      if (logStream.writableFinished) return resolve();
      logStream.once('finish', resolve);
    });
    return {
      ok: job.status === 'completed',
      action: 'start_bg',
      job_id: jobId,
      pid: job.pid,
      label,
      status: job.status,
      exit_code: job.exit_code,
      log_file: logFile,
      recent_logs: tailLines(logFile, 60),
      platform: os.platform(),
    };
  }

  return {
    ok: true,
    action: 'start_bg',
    job_id: jobId,
    pid: job.pid,
    label,
    status: 'running',
    log_file: logFile,
    recent_logs: tailLines(logFile, 20),
    note: 'Still running. Use action "status" with this job_id to track progress.',
  };
}

// ---------------------------------------------------------------------------
// Mode: status
// ---------------------------------------------------------------------------
function statusMode(input) {
  const job = findJob(input);
  if (!job) return fail('status', 'Job not found. Provide a valid job_id or label.');
  refreshJob(job);
  const tail = clampInt(input.tail_lines, 1, 1000, 60);
  return {
    ok: true,
    action: 'status',
    job_id: job.job_id,
    label: job.label,
    status: job.status,
    pid: job.pid,
    elapsed_sec: elapsedSec(job),
    exit_code: job.exit_code,
    log_file: job.log_file,
    note: job.note,
    recent_logs: tailLines(job.log_file, tail),
  };
}

// ---------------------------------------------------------------------------
// Mode: list
// ---------------------------------------------------------------------------
function listMode() {
  const jobs = loadRegistry().jobs;
  for (const job of jobs) refreshJob(job);
  const counts = { running: 0, completed: 0, failed: 0, killed: 0 };
  for (const job of jobs) {
    if (Object.prototype.hasOwnProperty.call(counts, job.status)) counts[job.status]++;
  }
  return {
    ok: true,
    action: 'list',
    counts,
    total: jobs.length,
    jobs: jobs.slice().reverse().map(publicJob),
  };
}

// ---------------------------------------------------------------------------
// Mode: stop
// ---------------------------------------------------------------------------
async function stopMode(input, ctx) {
  const hasSelector = !!(input.job_id || input.label);
  const job = hasSelector ? findJob(input) : null;
  if (hasSelector && !job) return fail('stop', 'Job not found.');

  let pid = job ? job.pid : null;
  if (!pid && input.pid !== undefined) pid = Number(input.pid);
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return fail('stop', 'Provide a job_id, label or a valid pid.');
  }
  if (pid === process.pid) return fail('stop', 'Refusing to stop the daemon process itself.');
  if (job && job.status !== 'running') {
    return { ok: true, action: 'stop', job_id: job.job_id, status: job.status, message: 'Job is not running.' };
  }

  await audit(ctx, { action: 'stop', job_id: job ? job.job_id : null, pid });
  // Mark first so the exit handler records 'killed' instead of 'failed'.
  if (job) job.status = 'killed';
  const outcome = await terminatePid(pid);

  if (job) {
    if (outcome === 'failed') {
      job.status = 'running';
    } else {
      job.exit_code = null;
      job.finished_at = new Date().toISOString();
      job.note = `stopped by user (${outcome})`;
    }
    try {
      fs.appendFileSync(job.log_file, `${new Date().toISOString()} [SYS] termination requested by stop: ${outcome}\n`);
    } catch (_) {
      // Log file may be gone; the registry still records the stop.
    }
    saveRegistry();
  }

  return {
    ok: outcome !== 'failed',
    action: 'stop',
    job_id: job ? job.job_id : null,
    pid,
    outcome,
    status: job ? job.status : null,
  };
}

// ---------------------------------------------------------------------------
// Mode: build_preset
// ---------------------------------------------------------------------------
const PRESETS = {
  node_pkg_exe: {
    needsEntry: true,
    prepare(dir) {
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    },
    build(p) {
      return {
        command: 'npx',
        args: ['pkg', p.entry, '--targets', 'node18-win-x64', '--output', path.join('dist', `${p.name}.exe`)],
      };
    },
    expected(p) {
      return path.join('dist', `${p.name}.exe`);
    },
  },
  electron_exe: {
    needsEntry: false,
    build() {
      return { command: 'npx', args: ['electron-builder', '--win', 'portable'] };
    },
    expected() {
      return 'dist';
    },
  },
  python_pyinstaller_exe: {
    needsEntry: true,
    build(p) {
      return { command: 'pyinstaller', args: ['--onefile', '--noconsole', '--name', p.name, p.entry] };
    },
    expected(p) {
      return path.join('dist', `${p.name}.exe`);
    },
  },
  android_gradle_apk: {
    needsEntry: false,
    needsGradlew: true,
    build() {
      return { command: IS_WIN ? 'gradlew.bat' : './gradlew', args: ['assembleDebug'] };
    },
    expected() {
      return path.join('app', 'build', 'outputs', 'apk', 'debug');
    },
  },
};

async function buildPreset(input, ctx) {
  const type = String(input.preset_type || '');
  if (!Object.prototype.hasOwnProperty.call(PRESETS, type)) {
    return fail('build_preset', `Unknown preset_type. Use: ${Object.keys(PRESETS).join(', ')}.`);
  }
  const preset = PRESETS[type];

  if (!input.project_dir) return fail('build_preset', '"project_dir" is required.');
  const dir = resolveCwd(input.project_dir);
  if (dir.error) return fail('build_preset', dir.error);

  const name = sanitizeName(input.output_name || 'app');
  if (!name) return fail('build_preset', 'output_name may contain only letters, digits, "_" and "-" (max 64).');

  const entry = input.entry_file ? String(input.entry_file).trim() : '';
  if (preset.needsEntry) {
    if (!entry) return fail('build_preset', `"entry_file" is required for ${type}.`);
    if (!fileExists(path.resolve(dir.abs, entry))) {
      return fail('build_preset', `entry_file not found inside project_dir: ${entry}`);
    }
  }
  if (preset.needsGradlew) {
    const wrapper = path.join(dir.abs, IS_WIN ? 'gradlew.bat' : 'gradlew');
    if (!fileExists(wrapper)) return fail('build_preset', `Gradle wrapper not found: ${wrapper}`);
  }

  if (preset.prepare) {
    try {
      preset.prepare(dir.abs);
    } catch (err) {
      return fail('build_preset', `Could not prepare output folder: ${errCode(err)}`);
    }
  }

  const spec = preset.build({ entry, name });
  const runInput = {
    command: spec.command,
    args: spec.args,
    cwd: dir.abs,
    label: `${type}_${name}`,
    env: input.env,
    timeout_ms: input.timeout_ms,
  };
  const result = input.mode === 'sync' ? await runSync(runInput, ctx) : await startBg(runInput, ctx);

  return Object.assign(result, {
    action: 'build_preset',
    preset_type: type,
    expected_output: path.join(dir.abs, preset.expected({ entry, name })),
  });
}

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------
const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['run_sync', 'start_bg', 'status', 'list', 'stop', 'build_preset'],
      description: 'Which mode to run.',
    },
    command: { type: 'string', description: 'run_sync / start_bg: executable or full shell command line.' },
    args: { type: 'array', items: { type: 'string' }, description: 'run_sync / start_bg: optional argument list.' },
    cwd: { type: 'string', description: 'Working directory. Defaults to JARVIS_ROOT.' },
    env: { type: 'object', description: 'Environment variable overrides.' },
    timeout_ms: {
      type: 'integer',
      minimum: 1000,
      maximum: SYNC_TIMEOUT_MAX,
      description: `run_sync: timeout in ms (default ${SYNC_TIMEOUT_DEFAULT}).`,
    },
    label: { type: 'string', description: 'start_bg: human-readable job name, e.g. "build_barcode_exe".' },
    job_id: { type: 'string', description: 'status / stop: job identifier.' },
    pid: { type: 'integer', description: 'stop: process id when no job_id is given.' },
    tail_lines: { type: 'integer', minimum: 1, maximum: 1000, description: 'status: number of log lines (default 60).' },
    preset_type: {
      type: 'string',
      enum: ['node_pkg_exe', 'electron_exe', 'python_pyinstaller_exe', 'android_gradle_apk'],
      description: 'build_preset: which build to run.',
    },
    project_dir: { type: 'string', description: 'build_preset: project folder.' },
    entry_file: { type: 'string', description: 'build_preset: entry script, relative to project_dir (node_pkg_exe, python_pyinstaller_exe).' },
    output_name: { type: 'string', description: 'build_preset: output name without extension (letters, digits, _ and -).' },
    mode: { type: 'string', enum: ['background', 'sync'], description: 'build_preset: background (default) or sync.' },
  },
  required: ['action'],
};

async function execute(args, ctx) {
  const input = args && typeof args === 'object' ? args : {};
  const action = String(input.action || '').trim().toLowerCase();
  try {
    switch (action) {
      case 'run_sync':
        return await runSync(input, ctx);
      case 'start_bg':
        return await startBg(input, ctx);
      case 'status':
        return statusMode(input);
      case 'list':
        return listMode();
      case 'stop':
        return await stopMode(input, ctx);
      case 'build_preset':
        return await buildPreset(input, ctx);
      default:
        return fail(action || 'none', `Unknown action "${action}". Use: run_sync, start_bg, status, list, stop, build_preset.`);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await audit(ctx, { action, phase: 'error', error: message });
    return fail(action || 'none', message);
  }
}

module.exports = {
  name: NAME,
  description: 'A0. Advanced Windows CLI daemon: runs terminal commands fast, starts long background jobs (builds, servers, bots) with live logs and job tracking, stops whole process trees, and builds portable .exe (pkg, electron-builder, PyInstaller) or .apk (Gradle) apps in one step.',
  tags: ['cli', 'daemon', 'terminal', 'background process', 'compile exe', 'build apk', 'run script', 'process manager', 'logs', 'kill process', 'pkg', 'pyinstaller', 'gradle'],
  risk: 'RISKY',
  parameters: PARAMETERS,
  execute,
};
