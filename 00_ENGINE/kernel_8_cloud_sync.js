'use strict';

/**
 * kernel_8_cloud_sync.js — Non-Blocking 5TB Cloud Memory & Manual Backup Engine
 * Location: C:\Jarvis_Core\00_ENGINE\kernel_8_cloud_sync.js
 *
 * Key Features:
 *   1. True Google Drive Path Detection: Detects `J:\My Drive\Jarvis_Core\Cloud_Memory`
 *      and `J:\My Drive\Jarvis_Cloud_Memory` (fixes virtual root permission error).
 *   2. NEVER Blocks / NEVER Turns Off: If Cloud Drive is offline/unmounted, seamlessly
 *      falls back to `C:\Jarvis_Core\work\cloud_fallback` without halting JARVIS.
 *   3. Manual Backup & Flush Commands:
 *      - `/cloud`               -> View live status & paths
 *      - `/cloud backup`        -> Trigger immediate manual backup & flush offline queue to Cloud
 *      - `/cloud restore`       -> Pull missing chat sessions from Cloud Drive to Local PC
 *      - `/cloud path <folder>` -> Set custom backup target path dynamically
 *   4. Rule 3 & Rule 5 Security: Masks API keys/passwords/cards (`***[MASKED]***`) and
 *      strictly excludes `01_CONFIG` (`settings.json`, `system_rules.json`).
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, '00_ENGINE');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG');

// Local directories to back up
const LOCAL_CHAT_DIR = path.join(ENGINE_DIR, 'Chat_sessions');
const LOCAL_LOGS_DIR = path.join(ROOT, 'logs');
const LOCAL_RAG_DIR = path.join(ROOT, 'work', 'knowledge_index');
const LOCAL_SCREENSHOTS_DIR = path.join(ROOT, 'work', 'screenshots');
const LOCAL_MEMORY_DIR = path.join(ROOT, 'work', 'adaptive_memory');

// Always-available Local Fallback Directory (ensures JARVIS never stops working)
const LOCAL_FALLBACK_ROOT = path.join(ROOT, 'work', 'cloud_fallback', 'Jarvis_Cloud_Memory');

// Strict Security Boundary: Never sync config files
const FORBIDDEN_SYNC_NAMES = new Set([
  'settings.json',
  'system_rules.json',
  'api_keys.txt',
  '.env',
]);

// Priority Cloud Paths (Specifically targets Google Drive's writable "My Drive" folder)
const CANDIDATE_CLOUD_PATHS = [
  'J:\\My Drive\\Jarvis_Core\\Cloud_Memory',
  'J:\\My Drive\\Jarvis_Cloud_Memory',
  'G:\\My Drive\\Jarvis_Core\\Cloud_Memory',
  'G:\\My Drive\\Jarvis_Cloud_Memory',
  'J:\\Jarvis_Cloud_Memory',
  'G:\\Jarvis_Cloud_Memory',
];

const SUB_FOLDERS = ['Chat_sessions', 'logs', 'knowledge_index', 'screenshots', 'adaptive_memory'];

// Rule 3: Sensitive Data Masking Patterns
const MASK_PATTERNS = [
  { re: /\bgsk_[A-Za-z0-9_-]{20,}\b/g, replacement: '***[MASKED_GROQ_KEY]***' },
  { re: /\b(?:AIza[A-Za-z0-9_-]{25,}|AQ\.[A-Za-z0-9_-]{20,})\b/g, replacement: '***[MASKED_GEMINI_KEY]***' },
  { re: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g, replacement: '***[MASKED_OPENROUTER_KEY]***' },
  { re: /\bcsk-[A-Za-z0-9_-]{20,}\b/g, replacement: '***[MASKED_CEREBRAS_KEY]***' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: '***[MASKED_API_KEY]***' },
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, replacement: '***[MASKED_TG_TOKEN]***' },
  { re: /("(?:password|passwd|secret|api_key|apikey|token|access_token)"\s*:\s*)"[^"]+"/gi, replacement: '$1"***[MASKED]***"' },
  { re: /\b(?:password|passwd|secret|api_key)\s*[:=]\s*\S+/gi, replacement: 'password=***[MASKED]***' },
  { re: /\b(?:\d{4}[ -]?){3}\d{4}\b/g, replacement: '***[MASKED_CARD]***' },
];

let CTX = null;
let CUSTOM_CLOUD_PATH = null;
let ACTIVE_STORAGE_ROOT = LOCAL_FALLBACK_ROOT;
let IS_USING_REAL_CLOUD = false;
let LAST_SYNC_TS = null;
let SYNCED_FILES_COUNT = 0;

// ---------------------------------------------------------------------------
// 1. Smart Google Drive ("My Drive") Detection & Safe Fallback
// ---------------------------------------------------------------------------
function canWriteToDir(targetDir) {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const sub of SUB_FOLDERS) {
      fs.mkdirSync(path.join(targetDir, sub), { recursive: true });
    }
    const probe = path.join(targetDir, '.jarvis_write_test');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveStorageRoot() {
  // 1. Check user-defined custom path first
  const configured = CUSTOM_CLOUD_PATH || CTX?.settings?.cloud_memory_path || process.env.JARVIS_CLOUD_PATH;
  if (configured && canWriteToDir(configured)) {
    ACTIVE_STORAGE_ROOT = configured;
    IS_USING_REAL_CLOUD = true;
    return ACTIVE_STORAGE_ROOT;
  }

  // 2. Check Google Drive "My Drive" paths (J:\My Drive\...)
  for (const candidate of CANDIDATE_CLOUD_PATHS) {
    const parentCheck = path.dirname(candidate);
    try {
      if (fs.existsSync(parentCheck) && canWriteToDir(candidate)) {
        ACTIVE_STORAGE_ROOT = candidate;
        IS_USING_REAL_CLOUD = true;
        return ACTIVE_STORAGE_ROOT;
      }
    } catch (_) {}
  }

  // 3. Safe Non-Blocking Fallback to Local Queue (JARVIS continues working 100%)
  canWriteToDir(LOCAL_FALLBACK_ROOT);
  ACTIVE_STORAGE_ROOT = LOCAL_FALLBACK_ROOT;
  IS_USING_REAL_CLOUD = false;
  return ACTIVE_STORAGE_ROOT;
}

// ---------------------------------------------------------------------------
// 2. Data Masking & Security Boundary
// ---------------------------------------------------------------------------
function maskSensitiveText(rawText) {
  if (typeof rawText !== 'string' || !rawText) return '';
  let masked = rawText;
  for (const rule of MASK_PATTERNS) {
    masked = masked.replace(rule.re, rule.replacement);
  }
  return masked;
}

function isForbiddenFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (FORBIDDEN_SYNC_NAMES.has(base)) return true;
  const normalized = path.resolve(filePath).toLowerCase();
  const configDirNorm = path.resolve(CONFIG_DIR).toLowerCase();
  return normalized.startsWith(configDirNorm);
}

// ---------------------------------------------------------------------------
// 3. Sync, Manual Backup & Offline Queue Flush
// ---------------------------------------------------------------------------
function syncSingleFile(localFile, subFolder, targetRoot = ACTIVE_STORAGE_ROOT) {
  if (isForbiddenFile(localFile)) return false;
  if (!fs.existsSync(localFile)) return false;

  try {
    const stat = fs.statSync(localFile);
    if (!stat.isFile()) return false;

    const fileName = path.basename(localFile);
    const destDir = path.join(targetRoot, subFolder);
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, fileName);

    if (/\.(png|jpg|jpeg|webp|gif)$/i.test(fileName)) {
      fs.copyFileSync(localFile, destFile);
    } else {
      const rawContent = fs.readFileSync(localFile, 'utf8');
      const safeContent = maskSensitiveText(rawContent);
      fs.writeFileSync(destFile, safeContent, 'utf8');
    }

    LAST_SYNC_TS = new Date().toISOString();
    SYNCED_FILES_COUNT++;
    return true;
  } catch (_) {
    return false;
  }
}

function syncDirectory(localDir, subFolder, targetRoot = ACTIVE_STORAGE_ROOT) {
  if (!fs.existsSync(localDir)) {
    try { fs.mkdirSync(localDir, { recursive: true }); } catch (_) { return 0; }
  }
  let count = 0;
  try {
    const files = fs.readdirSync(localDir);
    for (const file of files) {
      if (syncSingleFile(path.join(localDir, file), subFolder, targetRoot)) {
        count++;
      }
    }
  } catch (_) {}
  return count;
}

// If files were saved in Local Fallback while Google Drive was offline, push them to Google Drive now!
function flushFallbackQueueToCloud(cloudRoot) {
  if (!IS_USING_REAL_CLOUD || !fs.existsSync(LOCAL_FALLBACK_ROOT)) return 0;
  let flushed = 0;
  for (const sub of SUB_FOLDERS) {
    const fallbackSub = path.join(LOCAL_FALLBACK_ROOT, sub);
    if (fs.existsSync(fallbackSub)) {
      flushed += syncDirectory(fallbackSub, sub, cloudRoot);
    }
  }
  return flushed;
}

function restoreChatsFromStorage() {
  resolveStorageRoot();
  const cloudChatDir = path.join(ACTIVE_STORAGE_ROOT, 'Chat_sessions');
  if (!fs.existsSync(cloudChatDir)) return 0;

  let restored = 0;
  try {
    fs.mkdirSync(LOCAL_CHAT_DIR, { recursive: true });
    for (const file of fs.readdirSync(cloudChatDir)) {
      if (!file.endsWith('.json')) continue;
      const localTarget = path.join(LOCAL_CHAT_DIR, file);
      if (!fs.existsSync(localTarget)) {
        fs.copyFileSync(path.join(cloudChatDir, file), localTarget);
        restored++;
      }
    }
  } catch (_) {}
  return restored;
}

function runBackupNow() {
  const root = resolveStorageRoot();
  let totalFiles = 0;
  if (IS_USING_REAL_CLOUD) {
    totalFiles += flushFallbackQueueToCloud(root);
  }
  totalFiles += syncDirectory(LOCAL_CHAT_DIR, 'Chat_sessions', root);
  totalFiles += syncDirectory(LOCAL_LOGS_DIR, 'logs', root);
  totalFiles += syncDirectory(LOCAL_RAG_DIR, 'knowledge_index', root);
  totalFiles += syncDirectory(LOCAL_SCREENSHOTS_DIR, 'screenshots', root);

  return {
    ok: true,
    isRealCloud: IS_USING_REAL_CLOUD,
    activeRoot: root,
    filesBackedUp: totalFiles,
    timestamp: LAST_SYNC_TS || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 4. Real-Time Watchers
// ---------------------------------------------------------------------------
function installFolderWatchers() {
  const watchTargets = [
    { dir: LOCAL_CHAT_DIR, sub: 'Chat_sessions' },
    { dir: LOCAL_LOGS_DIR, sub: 'logs' },
    { dir: LOCAL_RAG_DIR, sub: 'knowledge_index' },
    { dir: LOCAL_SCREENSHOTS_DIR, sub: 'screenshots' },
    { dir: LOCAL_MEMORY_DIR, sub: 'adaptive_memory' },
  ];

  for (const item of watchTargets) {
    try {
      fs.mkdirSync(item.dir, { recursive: true });
      fs.watch(item.dir, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(item.dir, filename);
        setTimeout(() => {
          if (fs.existsSync(fullPath)) {
            resolveStorageRoot();
            syncSingleFile(fullPath, item.sub, ACTIVE_STORAGE_ROOT);
          }
        }, 300);
      });
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 5. Non-Blocking Chat Commands (/cloud, /cloud backup, /cloud restore, /cloud path)
// ---------------------------------------------------------------------------
function handleCloudCommand(rawPrompt) {
  const sub = rawPrompt.replace(/^\/cloud\s*/i, '').trim();

  // Command: /cloud path <custom_folder>
  if (/^path\s+/i.test(sub)) {
    const newPath = sub.replace(/^path\s+/i, '').trim().replace(/^["']|["']$/g, '');
    if (canWriteToDir(newPath)) {
      CUSTOM_CLOUD_PATH = newPath;
      const res = runBackupNow();
      return [
        `✅ **Cloud Backup Path Updated & Synced!**`,
        `• **New Active Path:** \`${res.activeRoot}\``,
        `• **Files Backed Up:** ${res.filesBackedUp}`,
      ].join('\n');
    }
    return `⚠️ Cannot write to \`${newPath}\`. Make sure the folder exists and is writable (e.g., \`/cloud path J:\\My Drive\\Jarvis_Core\\Cloud_Memory\`).`;
  }

  // Command: /cloud restore
  if (/^restore\b/i.test(sub)) {
    const restoredCount = restoreChatsFromStorage();
    return `📥 **Cloud Restore Complete:** Restored **${restoredCount}** missing chat session(s) from \`${ACTIVE_STORAGE_ROOT}\`.`;
  }

  // Command: /cloud backup OR /cloud sync OR /cloud
  const res = runBackupNow();
  const modeLabel = res.isRealCloud
    ? '🟢 **GOOGLE DRIVE CONNECTED (`My Drive`)**'
    : '🟡 **LOCAL FALLBACK QUEUE ACTIVE (Non-Blocking Mode — JARVIS stays 100% ON)**';

  return [
    `☁️ **JARVIS Cloud Memory & Backup Center**`,
    `• **Status:** ${modeLabel}`,
    `• **Active Storage Path:** \`${res.activeRoot}\``,
    `• **Files Backed Up This Run:** ${res.filesBackedUp} (Total Synced: ${SYNCED_FILES_COUNT})`,
    `• **Data Masking (Rule 3):** ACTIVE (\`***[MASKED]***\`)`,
    `• **Config Isolation (Rule 5):** \`01_CONFIG\` protected`,
    `• **Last Backup Time:** ${res.timestamp}`,
    ``,
    `💡 **Manual Commands:**`,
    `  • \`/cloud backup\` — Run immediate manual backup to Google Drive`,
    `  • \`/cloud restore\` — Restore missing chats from Google Drive`,
    `  • \`/cloud path J:\\My Drive\\Jarvis_Core\\Cloud_Memory\` — Set custom Drive folder`,
  ].join('\n');
}

function installCloudInterceptor() {
  const existingListeners = ipcMain.listeners('jarvis:ai-prompt');
  if (existingListeners.length === 0) return;

  const downstreamListener = existingListeners[0];
  ipcMain.removeAllListeners('jarvis:ai-prompt');

  ipcMain.on('jarvis:ai-prompt', async (event, data) => {
    const prompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';

    if (/^\/cloud(\b|\s)/i.test(prompt)) {
      const reply = handleCloudCommand(prompt);
      if (!event.sender.isDestroyed()) {
        event.sender.send('jarvis:ai-response', { text: reply });
      }
      return;
    }

    // Never block user prompts! Always forward to AI & auto-backup in background.
    downstreamListener(event, data);
    setTimeout(() => {
      runBackupNow();
    }, 1500);
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init(ctx) {
  CTX = ctx;
  restoreChatsFromStorage();
  const initial = runBackupNow();
  installFolderWatchers();
  installCloudInterceptor();

  // Auto-backup every 60 seconds in the background
  setInterval(() => {
    runBackupNow();
  }, 60 * 1000);

  ctx.registerService('cloud_sync', {
    isHealthy: () => true,
    isRealCloud: () => IS_USING_REAL_CLOUD,
    getCloudRoot: () => ACTIVE_STORAGE_ROOT,
    backupNow: runBackupNow,
    restoreNow: restoreChatsFromStorage,
  });

  ctx.addStateContributor('cloud_memory', () => ({
    mode: IS_USING_REAL_CLOUD ? 'GOOGLE_DRIVE' : 'LOCAL_FALLBACK',
    storage_path: ACTIVE_STORAGE_ROOT,
    synced_files_count: SYNCED_FILES_COUNT,
    last_sync: LAST_SYNC_TS,
  }));

  ctx.audit('info', 'cloud_sync_ready', {
    mode: initial.isRealCloud ? 'GOOGLE_DRIVE' : 'LOCAL_FALLBACK',
    path: initial.activeRoot,
  });
}

module.exports = { name: 'cloud_sync', init };