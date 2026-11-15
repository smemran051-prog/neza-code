'use strict';

/**
 * ============================================================================
 * FILE: kernel_9_adaptive_intelligence_0.js
 * SUB-ENGINE 0: Semantic Intent NLU, Domain Lexicon, PII Masking & Win32 Vault
 * ============================================================================
 * Architecture:
 *   - Multi-layered Bengali + English + Banglish Semantic Intent Classifier
 *   - Context-aware Casual Chitchat & False-Positive Story Filter
 *   - Strict Rule 1-5 Security Enforcement & Deep Regex Secret Masking
 *   - Native Windows Credential Manager Integration (DPAPI + cmdkey + P/Invoke)
 * ============================================================================
 */

const { execFileSync, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.JARVIS_ROOT || path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, '00_ENGINE');
const CONFIG_DIR = path.join(ROOT, '01_CONFIG');
const TOOLS_DIR = path.join(ENGINE_DIR, 'tools');
const WORK_DIR = path.join(ROOT, 'work');
const VAULT_META_FILE = path.join(WORK_DIR, 'vault_registry.json');

// ---------------------------------------------------------------------------
// 1. RULE 5: STRICT IMMUTABLE SECURITY BOUNDARIES
// ---------------------------------------------------------------------------
const FORBIDDEN_CONFIG_PATHS = Object.freeze([
  '01_config',
  'settings.json',
  'system_rules.json',
  'extensions.json',
  'kernel.js',
  'preload.js',
  '.env',
  'credentials',
]);

function isPathForbidden(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const norm = targetPath.toLowerCase().replace(/\\/g, '/');
  for (const forbidden of FORBIDDEN_CONFIG_PATHS) {
    if (norm.includes(forbidden)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2. RULE 3: INDUSTRIAL PII & SECRET MASKING ENGINE
// ---------------------------------------------------------------------------
const SECRET_MASK_RULES = [
  { name: 'GROQ_KEY', re: /\bgsk_[A-Za-z0-9_-]{20,}\b/g, replacement: '***[MASKED_GROQ_KEY]***' },
  { name: 'GEMINI_KEY', re: /\b(?:AIza[A-Za-z0-9_-]{25,}|AQ\.[A-Za-z0-9_-]{20,})\b/g, replacement: '***[MASKED_GEMINI_KEY]***' },
  { name: 'OPENAI_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replacement: '***[MASKED_OPENAI_KEY]***' },
  { name: 'GITHUB_PAT', re: /\bgh[pousr]_[A-Za-z0-9]{25,}\b/g, replacement: '***[MASKED_GITHUB_TOKEN]***' },
  { name: 'TELEGRAM_BOT', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, replacement: '***[MASKED_TG_TOKEN]***' },
  { name: 'BEARER_JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '***[MASKED_JWT]***' },
  { name: 'JSON_SECRET', re: /("(?:password|passwd|pwd|secret|api_key|apikey|access_token|auth_token|pin|cvv|private_key)"\s*:\s*)"[^"]+"/gi, replacement: '$1"***[MASKED]***"' },
  { name: 'KV_SECRET', re: /\b(password|passwd|pwd|secret|api_key|token|pin|পাসওয়ার্ড|পাসওয়ার্ড|পিন)\s*[:=]\s*([^\s,;]+)/gi, replacement: '$1=***[MASKED]***' },
  { name: 'BANK_CARD', re: /\b(?:\d{4}[ -]?){3}\d{4}\b/g, replacement: '***[MASKED_CARD]***' },
  { name: 'BD_NID_PHONE', re: /\b(?:01[3-9]\d{8}|\d{10}|\d{13}|\d{17})\b/g, replacement: (m) => (m.startsWith('01') ? m : '***[MASKED_ID]***') },
];

function sanitizeAndMaskText(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') {
    try {
      input = JSON.stringify(input);
    } catch (_) {
      return '';
    }
  }
  let sanitized = input;
  for (const rule of SECRET_MASK_RULES) {
    sanitized = sanitized.replace(rule.re, rule.replacement);
  }
  return sanitized;
}

function sanitizeObjectDeep(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeAndMaskText(obj);
  if (Array.isArray(obj)) return obj.map((item) => sanitizeObjectDeep(item));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/^(?:password|passwd|pwd|secret|token|api_key|pin|cvv)$/i.test(k)) {
        out[k] = '***[MASKED]***';
      } else {
        out[k] = sanitizeObjectDeep(v);
      }
    }
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// 3. DOMAIN VOCABULARY & SYNONYM GRAPH (Bengali + Banglish + Technical)
// ---------------------------------------------------------------------------
const DOMAIN_LEXICON = {
  ups_hardware: [
    'ups', 'offline ups', 'online ups', 'inverter', 'avr', 'relay', 'mosfet', 'transformer',
    'battery', 'ah', 'float voltage', 'charging current', 'cut-off', 'overload', 'backup',
    'pzem', 'zmpt101b', 'esp32', 'pico', 'optocoupler', 'oscilloscope', 'multimeter',
    'ইউপিএস', 'ব্যাটারি', 'ভোল্টেজ', 'রিলে', 'ইনভার্টার', 'সার্কিট', 'ট্রান্সফরমার', 'চার্জিং', 'ব্যাকআপ',
  ],
  erp_rma_workflow: [
    'rma', 'serial', 'barcode', 'stock transfer', 'challan', 'complain', 'warranty', 'non-warranty',
    'gbpl', 'global brand', 'receive', 'delivery', 'tat', 'turnaround', 'pending', 'repaired', 'dead',
    'সিরিয়াল', 'বারকোড', 'ওয়ারেন্টি', 'কমপ্লেইন', 'স্টক', 'চালান', 'ডেলিভারি', 'রিসিভ', 'রিপোর্ট',
  ],
  ui_action_verbs: [
    'click', 'press', 'type', 'write', 'enter', 'submit', 'login', 'open', 'close', 'select',
    'dropdown', 'checkbox', 'scroll', 'copy', 'paste', 'upload', 'download', 'save', 'search',
    'ক্লিক', 'টাইপ', 'লিখো', 'লগইন', 'সাবমিট', 'ওপেন', 'সেভ', 'কপি', 'পেস্ট', 'সিলেক্ট', 'খুলো', 'বন্ধ',
  ],
};

// ---------------------------------------------------------------------------
// 4. DEEP SEMANTIC INTENT CLASSIFIER (Conversational & Weighted)
// ---------------------------------------------------------------------------
const INTENT_DEFINITIONS = {
  START_LEARNING: {
    threshold: 0.65,
    directPatterns: [
      /(?:jarvis|জার্ভিস|জারভিস)[\s,.:;-]*(?:একটু\s*)?(?:খেয়াল করো|খেয়াল করো|দেখো|নোট করো|শেখো|শিখে রাখো|শিখে নাও|লক্ষ্য করো|মনোযোগ দাও|ফলো করো)/i,
      /(?:খেয়াল করো|খেয়াল করো|দেখো তো|নোট করে রাখো|শিখে নাও|লক্ষ্য করো)[\s,.:;-]*(?:jarvis|জার্ভিস|জারভিস)/i,
      /(?:jarvis|জার্ভিস|জারভিস).*?(?:watch\s+how|watch\s+me|observe\s+this|learn\s+this|record\s+workflow|pay\s+attention|take\s+note)/i,
      /^(?:লার্নিং মোড অন|লার্নিং স্টার্ট|স্টার্ট লার্নিং|শেখা শুরু করো|start\s+learning|learning\s+mode\s+on|enable\s+learning|observe\s+mode)$/i,
      /(?:আমি\s+যেভাবে\s+করছি|আমি\s+কিভাবে\s+করি|এই\s+কাজটা\s+কিভাবে\s+করি).*(?:দেখো|খেয়াল করো|খেয়াল করো|শিখে রাখো)/i,
      /(?:এই\s+প্রসেসটা|এই\s+নিয়মটা|এই\s+কাজটা).*(?:পরে\s+তোমার\s+করতে\s+হবে|শিখে\s+নাও|মনে\s+রাখো)/i,
      /\b(?:kheyal\s+koro|dekho\s+ami\s+ki\s+kori|shikhe\s+rakho|learning\s+on\s+koro)\b/i,
    ],
    tokenWeights: {
      'জার্ভিস': 0.25, 'জারভিস': 0.25, 'jarvis': 0.25,
      'খেয়াল': 0.45, 'খেয়াল': 0.45, 'kheyal': 0.45,
      'শেখো': 0.45, 'শিখে': 0.45, 'shikhe': 0.45,
      'দেখো': 0.30, 'লক্ষ্য': 0.40, 'নোট': 0.35,
      'watch': 0.40, 'observe': 0.50, 'learn': 0.40,
      'করছি': 0.20, 'করি': 0.15, 'প্রসেসটা': 0.25,
    },
  },

  STOP_LEARNING: {
    threshold: 0.65,
    directPatterns: [
      /(?:jarvis|জার্ভিস|জারভিস)[\s,.:;-]*(?:শেখা শেষ|বোঝা গেছে|সেভ করো|সেভ করে নাও|কমপ্লিট|ডান|থামো|রেকর্ডিং বন্ধ)/i,
      /(?:শেখা শেষ|এটুকুই কাজ|কাজ শেষ|বোঝা গেছে কি|এবার সেভ করে নাও|আর দেখতে হবে না|ওকে ডান)/i,
      /(?:jarvis|জার্ভিস|জারভিস).*?(?:stop\s+learning|finish\s+learning|got\s+it|save\s+workflow|that's\s+how\s+it's\s+done|done\s+observing)/i,
      /^(?:লার্নিং অফ|স্টপ লার্নিং|লার্নিং বন্ধ|stop\s+learning|learning\s+mode\s+off|end\s+learning)$/i,
      /\b(?:shekha\s+shesh|etukui\s+kaj|save\s+kore\s+nao|learning\s+off\s+koro|bojha\s+gese)\b/i,
    ],
    tokenWeights: {
      'জার্ভিস': 0.20, 'জারভিস': 0.20, 'jarvis': 0.20,
      'শেখা': 0.35, 'শেষ': 0.40, 'shesh': 0.40,
      'এটুকুই': 0.45, 'বোঝা': 0.35, 'গেছে': 0.25,
      'সেভ': 0.30, 'থামো': 0.35, 'ডান': 0.30,
      'stop': 0.40, 'done': 0.35, 'finish': 0.40,
    },
  },

  EXECUTE_SURROGATE: {
    threshold: 0.65,
    directPatterns: [
      /(?:jarvis|জার্ভিস|জারভিস)?[\s,.:;-]*(?:আগের মতো|শেখানো কাজটা|ওই কাজটা|যেভাবে দেখিয়েছিলাম|যেভাবে শিখিয়েছি).*(?:করে দাও|করো|সাবমিট করো|চালাও|কমপ্লিট করো)/i,
      /(?:আজকের\s+রিপোর্টটা|ইআরপি\s+এন্টিটা|লগইন\s+করে\s+কাজটা).*(?:আগের মতো|নিজে\s+করে\s+দাও|সাবমিট\s+করে\s+দাও)/i,
      /\b(?:run\s+learned\s+workflow|execute\s+surrogate|do\s+it\s+like\s+before|repeat\s+my\s+workflow|run\s+sop)\b/i,
      /\b(?:ager\s+moto\s+kore\s+dao|shekhano\s+kajta\s+koro|sop\s+run\s+koro)\b/i,
    ],
    tokenWeights: {
      'আগের': 0.35, 'মতো': 0.30, 'শেখানো': 0.45,
      'দেখিয়েছিলাম': 0.45, 'শিখিয়েছি': 0.45,
      'করে': 0.20, 'দাও': 0.20, 'চালাও': 0.30,
      'repeat': 0.40, 'surrogate': 0.45, 'workflow': 0.35,
    },
  },
};

// False-Positive Story/Quotation Blocker
const THIRD_PARTY_QUOTE_MARKERS = [
  /(?:ওই লোককে বললাম|তাকে বললাম|কলিগকে বললাম|বন্ধুকে বললাম|ভাইকে বললাম|স্যার বলল|বস বলল)/i,
  /(?:he said|she said|i told him|told my friend|in the movie)/i,
];

// Casual Chitchat & Ambient Noise Filter
const AMBIENT_CHITCHAT_PATTERNS = [
  /\b(চা খাবো|চা দে|কফি|খেলা দেখছিস|আজকের খেলা|ক্রিকেট|ফুটবল|বৃষ্টি হচ্ছে|গরম লাগছে|ঘুম আসছে|ক্ষুধা লাগছে|দুপুরের খাবার|রাতের খাবার|কি খবর দোস্ত|হাহাহা|আরে ধুর|বাদ দে)\b/i,
  /\b(let's have tea|coffee break|watch the match|nice weather|so hungry|going to sleep|what's up bro|haha|lol|lmao)\b/i,
];

function classifySemanticIntent(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { intent: 'NONE', confidence: 0, reason: 'empty_input' };
  }
  const text = rawText.trim();

  // Check if user is telling a story about someone else without addressing Jarvis
  for (const quoteRe of THIRD_PARTY_QUOTE_MARKERS) {
    if (quoteRe.test(text) && !/^(?:jarvis|জার্ভিস|জারভিস)/i.test(text)) {
      return { intent: 'NONE', confidence: 0, reason: 'third_party_story_filtered' };
    }
  }

  let bestIntent = 'NONE';
  let bestScore = 0;

  for (const [intentName, def] of Object.entries(INTENT_DEFINITIONS)) {
    let score = 0;

    // 1. Direct Regex Match
    for (const re of def.directPatterns) {
      if (re.test(text)) {
        score = Math.max(score, 0.92);
        break;
      }
    }

    // 2. Weighted Token Scoring for Natural Variations
    if (score < def.threshold) {
      const lower = text.toLowerCase();
      let tokenSum = 0;
      for (const [token, weight] of Object.entries(def.tokenWeights)) {
        if (lower.includes(token)) {
          tokenSum += weight;
        }
      }
      score = Math.min(0.95, tokenSum);
    }

    if (score >= def.threshold && score > bestScore) {
      bestScore = score;
      bestIntent = intentName;
    }
  }

  return {
    intent: bestIntent,
    confidence: Number(bestScore.toFixed(2)),
    isCasualChitchat: isAmbientChitchat(text),
  };
}

function isAmbientChitchat(text) {
  if (!text || typeof text !== 'string') return true;
  const clean = text.trim();
  if (clean.length < 2) return true;

  // If it contains technical or workflow keywords, it is NEVER casual chitchat
  const lower = clean.toLowerCase();
  for (const group of Object.values(DOMAIN_LEXICON)) {
    for (const kw of group) {
      if (lower.includes(kw)) return false;
    }
  }

  for (const re of AMBIENT_CHITCHAT_PATTERNS) {
    if (re.test(clean)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 5. WINDOWS CREDENTIAL MANAGER & DPAPI SECURE VAULT
// ---------------------------------------------------------------------------
class WindowsCredentialVault {
  constructor() {
    this.ensureMetaFile();
  }

  ensureMetaFile() {
    try {
      if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });
      if (!fs.existsSync(VAULT_META_FILE)) {
        fs.writeFileSync(VAULT_META_FILE, JSON.stringify({ targets: {} }, null, 2), 'utf8');
      }
    } catch (_) {}
  }

  /**
   * Stores a secret in Windows Credential Manager (cmdkey) AND DPAPI encrypted local backup
   * Never stores plaintext on disk.
   */
  storeSecret(targetKey, username, plainSecret) {
    if (!targetKey || !plainSecret) return { ok: false, error: 'missing_key_or_secret' };
    const safeTarget = `JARVIS_SURROGATE_${targetKey.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
    const safeUser = username || 'jarvis_operator';

    try {
      // 1. Register in Windows Native Credential Manager via cmdkey.exe
      execFileSync('cmdkey.exe', [`/generic:${safeTarget}`, `/user:${safeUser}`, `/pass:${plainSecret}`], {
        windowsHide: true,
        stdio: 'ignore',
      });

      // 2. Also create a Windows DPAPI encrypted blob tied to current Windows User login
      const psDpapi = `
        $sec = ConvertTo-SecureString -String ${JSON.stringify(plainSecret)} -AsPlainText -Force
        $enc = ConvertFrom-SecureString -SecureString $sec
        Write-Output $enc
      `;
      const encryptedBlob = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psDpapi],
        { windowsHide: true, encoding: 'utf8' }
      ).trim();

      const meta = JSON.parse(fs.readFileSync(VAULT_META_FILE, 'utf8'));
      meta.targets[safeTarget] = {
        targetKey,
        username: safeUser,
        dpapiBlob: encryptedBlob,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(VAULT_META_FILE, JSON.stringify(meta, null, 2), 'utf8');

      return { ok: true, vaultTarget: safeTarget };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Retrieves a decrypted secret at runtime using Windows DPAPI (CurrentUser scope)
   */
  retrieveSecret(targetKey) {
    if (!targetKey) return null;
    const safeTarget = targetKey.startsWith('JARVIS_SURROGATE_')
      ? targetKey
      : `JARVIS_SURROGATE_${targetKey.replace(/[^A-Za-z0-9_.-]/g, '_')}`;

    try {
      if (!fs.existsSync(VAULT_META_FILE)) return null;
      const meta = JSON.parse(fs.readFileSync(VAULT_META_FILE, 'utf8'));
      const entry = meta.targets[safeTarget];
      if (!entry || !entry.dpapiBlob) return null;

      const psDecrypt = `
        $sec = ConvertTo-SecureString -String ${JSON.stringify(entry.dpapiBlob)}
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        Write-Output $plain
      `;
      const decrypted = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psDecrypt],
        { windowsHide: true, encoding: 'utf8', timeout: 3000 }
      ).trim();

      return decrypted || null;
    } catch (_) {
      return null;
    }
  }

  listRegisteredTargets() {
    try {
      const meta = JSON.parse(fs.readFileSync(VAULT_META_FILE, 'utf8'));
      return Object.keys(meta.targets || {});
    } catch (_) {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// 6. RULE 2: FAIL-CLOSED STORAGE & AUDIT GUARD
// ---------------------------------------------------------------------------
function verifyFailClosedStorage(ctx) {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    const testFile = path.join(WORK_DIR, `.fail_closed_probe_${process.pid}`);
    fs.writeFileSync(testFile, 'OK', 'utf8');
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    ctx?.audit?.('error', 'rule2_fail_closed_storage_halt', { error: err.message });
    return false;
  }
}

const credentialVault = new WindowsCredentialVault();

module.exports = {
  ROOT,
  ENGINE_DIR,
  CONFIG_DIR,
  TOOLS_DIR,
  WORK_DIR,
  FORBIDDEN_CONFIG_PATHS,
  DOMAIN_LEXICON,
  isPathForbidden,
  sanitizeAndMaskText,
  sanitizeObjectDeep,
  classifySemanticIntent,
  isAmbientChitchat,
  verifyFailClosedStorage,
  credentialVault,
};