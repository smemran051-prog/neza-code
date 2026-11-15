'use strict';

/**
 * ============================================================================
 * KERNEL 10 — PART 1 of 7
 * kernel_10_stt_intent_normalizer.js
 * Location: C:\Jarvis_Core\00_ENGINE\kernel_10_stt_intent_normalizer.js
 * Version:  1.0.0-enterprise
 * ============================================================================
 *
 * RESPONSIBILITY
 * --------------
 * Normalize garbled Bengali / Banglish / English speech-to-text (STT)
 * transcripts into a canonical intent + slots, then dispatch the matching
 * registered tool. Provides:
 *   - Script detector (Bengali / Latin / mixed / other)
 *   - Unified phonetic transliteration (Bengali → Latin phonetic skeleton,
 *     Banglish → same skeleton) so both sides compare apples-to-apples
 *   - Levenshtein distance + similarity (memory-optimised, plus full matrix
 *     for inspection)
 *   - Canonical intent phrase dictionary (BN + Banglish + EN)
 *   - Phonetic fuzzy intent matcher (thresholded, ranked)
 *   - Slot extractors per intent (ordinal, URL, layout, target tab, …)
 *   - Dynamic UI Mode Inspector (reads workspace_ui / browser_runtime / AI
 *     services if available, otherwise returns a safe default snapshot)
 *   - LLM-assisted intent normalizer (fallback when phonetic match is below
 *     threshold — used for STT so garbled that phonetic distance is high)
 *   - Tool registry + dispatcher (registerTool / dispatch) that lazy-resolves
 *     kernel_9 adaptive_intelligence, kernel10_shared_context_bus,
 *     kernel10_browser_runtime and kernel10_workspace_ui services
 *   - Self-test harness against the four canonical STT-error examples
 *
 * EXPORTS (used by Part 7 master orchestrator)
 * --------------------------------------------
 *   init(ctx)
 *   setLLMCallback(fn)
 *   route(rawInput, ctx, opts)         → STTIntentResult
 *   registerTool(intentName, handler, meta)
 *   dispatch(intentName, slots, ctx, meta)
 *   inspectUIMode(ctx)                 → WorkspaceLayout-ish snapshot
 *   toPhoneticKey(text)                → string
 *   levenshtein(a, b)                  → integer
 *   levenshteinMatrix(a, b)            → 2D matrix (debug)
 *   similarity(a, b)                   → 0..1
 *   phraseSimilarity(a, b)             → 0..1 (phonetic)
 *   matchIntent(text, opts)            → { matches, best, key }
 *   extractSlots(text, intentName)     → { … }
 *   normalizeWithLLM(rawText, uiContext, llmCallback)
 *   INTENT_DEFINITIONS                 → array
 *   selfTest()                         → { passed, failed, results }
 *
 * FROZEN-CORE COMPLIANCE
 * ----------------------
 * No edits to kernel.js or preload.js. Only ctx.audit() for logs,
 * ctx.registerService() for inter-kernel comms, ctx.addStateContributor()
 * for telemetry. All IPC is handled by Part 7.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// SECTION 0 — CONSTANTS & CONFIG
// ---------------------------------------------------------------------------

const DEFAULT_PHONETIC_THRESHOLD = 0.68;
const DEFAULT_LLM_TIMEOUT_MS = 12000;
const TOP_K_ALTERNATES = 3;

// Log tag shared across all audit lines from this module.
const LOG_TAG = 'k10.stt';

// Runtime state populated during init().
let _ctx = null;
let _llmCallback = null;
let _auditFn = null;

// Cache of precomputed phonetic keys per canonical phrase.
// Map<string(phrase), string(phoneticKey)>
const _phraseKeyCache = new Map();

// Tool registry: intent → { intent, handler, meta }
const _toolRegistry = new Map();

// ---------------------------------------------------------------------------
// SECTION 1 — BENGALI → PHONETIC LATIN CHARACTER TABLES
// ---------------------------------------------------------------------------
// Goal: map every Bengali grapheme to a Latin phoneme so that any Bengali
// STT transcript and any Banglish canonical phrase end up in the SAME
// representation space, enabling Levenshtein comparison across scripts.
// ---------------------------------------------------------------------------

// Consonants (independent and with hasanta-collapsed phonetic skeleton).
const BN_CONSONANTS = Object.freeze({
  'ক': 'k',   'খ': 'kh',  'গ': 'g',   'ঘ': 'gh',  'ঙ': 'ng',
  'চ': 'c',   'ছ': 'ch',  'জ': 'j',   'ঝ': 'jh',  'ঞ': 'n',
  'ট': 't',   'ঠ': 'th',  'ড': 'd',   'ঢ': 'dh',  'ণ': 'n',
  'ত': 't',   'থ': 'th',  'দ': 'd',   'ধ': 'dh',  'ন': 'n',
  'প': 'p',   'ফ': 'ph',  'ব': 'b',   'ভ': 'bh',  'ম': 'm',
  'য': 'j',   'র': 'r',   'ল': 'l',   'ৱ': 'w',
  'শ': 'sh',  'ষ': 'sh',  'স': 's',   'হ': 'h',
  'য়': 'y',   // ya-phala / antastha ya
  'ড়': 'r',   // re-phala (ड़)
  'ঢ়': 'rh',  // (ढ़)
  'ৎ': 't',   // khanda-ta
});

// Independent vowel letters (used at word start or after a vowel/hasanta).
const BN_VOWELS = Object.freeze({
  'অ': 'o',   'আ': 'a',   'ই': 'i',   'ঈ': 'i',
  'উ': 'u',   'ঊ': 'u',   'ঋ': 'ri',
  'এ': 'e',   'ঐ': 'oi',  'ও': 'o',   'ঔ': 'ou',
});

// Dependent vowel signs (kar) attached after a consonant.
const BN_VOWEL_SIGNS = Object.freeze({
  'া': 'a',   'ি': 'i',   'ী': 'i',   'ু': 'u',
  'ূ': 'u',   'ৃ': 'ri',  'ে': 'e',   'ৈ': 'oi',
  'ো': 'o',   'ৌ': 'ou',
});

// Diacritic marks that appear after a consonant/vowel.
const BN_MARKS = Object.freeze({
  'ং': 'ng',  // anusvara
  'ঃ': 'h',   // visarga
  'ঁ': 'n',   // chandrabindu (approximated as nasal n)
});

// Bengali digits → ASCII digits.
const BN_DIGITS = Object.freeze({
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
});

const BN_HASANTA = '্'; // virama — kills inherent vowel
const BN_PUNCT = new Set(['।', '॥', '॰', '৷']);

// ---------------------------------------------------------------------------
// SECTION 2 — SCRIPT DETECTION & TEXT NORMALIZATION
// ---------------------------------------------------------------------------

/**
 * Detect the dominant script of a text snippet.
 * @param {string} text
 * @returns {'bengali'|'latin'|'mixed'|'other'|'empty'}
 */
function detectScript(text) {
  if (!text || typeof text !== 'string') return 'empty';
  let bn = 0;
  let lt = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x0980 && cp <= 0x09ff) bn++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) lt++;
  }
  if (bn === 0 && lt === 0) return 'other';
  if (bn > 0 && lt === 0) return 'bengali';
  if (lt > 0 && bn === 0) return 'latin';
  return 'mixed';
}

/**
 * Normalise Unicode (NFC) and lowercase Latin characters.
 * Does NOT touch Bengali (case-free).
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  let t = text.normalize('NFC');
  // Lowercase Latin only (Bangla is case-free — this is a no-op there).
  t = t.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return t;
}

// ---------------------------------------------------------------------------
// SECTION 3 — BENGALI → PHONETIC LATIN TRANSLITERATION
// ---------------------------------------------------------------------------

/**
 * Translate a Bengali-script string to a Latin phonetic skeleton.
 * Applies schwa deletion at word-final position (modern Bengali convention)
 * so "শেষ" → "shesh" (not "shesho"), "একবার" → "ekbar" (not "ekbaro").
 *
 * @param {string} text — Bengali script input
 * @returns {string} Latin phonetic skeleton (lowercased, spaces preserved)
 */
function bengaliToPhonetic(text) {
  if (!text) return '';
  const chars = Array.from(text);
  const n = chars.length;
  let out = '';
  let i = 0;

  while (i < n) {
    const ch = chars[i];

    if (BN_CONSONANTS[ch] !== undefined) {
      out += BN_CONSONANTS[ch];
      const next = chars[i + 1];

      if (next === BN_HASANTA) {
        // Explicit hasanta — consonant cluster, no inherent vowel.
        i += 2;
        continue;
      }
      if (next !== undefined && BN_VOWEL_SIGNS[next] !== undefined) {
        out += BN_VOWEL_SIGNS[next];
        i += 2;
        continue;
      }
      if (next !== undefined && (BN_MARKS[next] !== undefined || BN_CONSONANTS[next] !== undefined)) {
        // Schwa-deletion before another consonant (e.g. জটা = jta, not jota).
        i += 1;
        continue;
      }
      // Word-final consonant → schwa deletion (ram, not ramo).
      i += 1;
      continue;
    }

    if (BN_VOWELS[ch] !== undefined) {
      out += BN_VOWELS[ch];
      i += 1;
      continue;
    }

    if (BN_VOWEL_SIGNS[ch] !== undefined) {
      // Orphan vowel sign — treat as a vowel.
      out += BN_VOWEL_SIGNS[ch];
      i += 1;
      continue;
    }

    if (BN_MARKS[ch] !== undefined) {
      out += BN_MARKS[ch];
      i += 1;
      continue;
    }

    if (BN_DIGITS[ch] !== undefined) {
      out += BN_DIGITS[ch];
      i += 1;
      continue;
    }

    if (ch === BN_HASANTA) {
      // Orphan hasanta — swallow silently.
      i += 1;
      continue;
    }

    if (BN_PUNCT.has(ch)) {
      out += ' ';
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      out += ' ';
      i += 1;
      continue;
    }

    // Latin inside Bengali — pass through as-is (mixed-script case).
    const cp = ch.codePointAt(0);
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39)) {
      out += ch.toLowerCase();
      i += 1;
      continue;
    }

    // Anything else (punctuation, emoji) — treat as word separator.
    out += ' ';
    i += 1;
  }

  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Canonicalise a Banglish / English romanised token so that phonetic
 * skeletons line up with bengaliToPhonetic() output.
 * @param {string} token
 * @returns {string}
 */
function romanizeBanglish(token) {
  if (!token) return '';
  let s = token.toLowerCase();
  // Bangla digits occasionally leak through in Banglish text.
  s = s.replace(/[০-৯]/g, (d) => BN_DIGITS[d] || d);
  // Common Banglish reduplication (aa → a, ee → i, oo → u, ii → i, uu → u).
  s = s.replace(/aa+/g, 'a');
  s = s.replace(/ee+/g, 'i');
  s = s.replace(/ii+/g, 'i');
  s = s.replace(/oo+/g, 'u');
  s = s.replace(/uu+/g, 'u');
  // Strip non-alphanumeric.
  s = s.replace(/[^a-z0-9]/g, '');
  return s;
}

// ---------------------------------------------------------------------------
// SECTION 4 — UNIFIED PHONETIC KEY + POST-NORMALIZATION
// ---------------------------------------------------------------------------

/**
 * Collapse aspirated digraphs and doubled consonants so that STT-omitted
 * aspiration and duplicated letters still match the canonical phrase.
 * Applied identically to the Bengali-transliterated and Banglish sides.
 * @param {string} s
 * @returns {string}
 */
function collapseAspirates(s) {
  return s
    .replace(/chh?/g, 'c')
    .replace(/sh/g, 's')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/jh/g, 'j')
    .replace(/th/g, 't')
    .replace(/dh/g, 'd')
    .replace(/ph/g, 'f')
    .replace(/bh/g, 'b');
}

/**
 * Final pass applied to a fully-assembled phonetic key.
 * @param {string} s
 * @returns {string}
 */
function finalNormalize(s) {
  let t = s.toLowerCase();
  t = collapseAspirates(t);
  // Collapse doubled consonants (kk → k, tt → t, …).
  t = t.replace(/([bcdfghjklmnpqrstvwxyz])\1+/g, '$1');
  // Normalise whitespace.
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Convert one token (which may itself be mixed script) to a canonical
 * phonetic fragment. Called by toPhoneticKey() per whitespace token.
 * @param {string} token
 * @returns {string}
 */
function tokenToKeyFragment(token) {
  const script = detectScript(token);
  if (script === 'empty') return '';
  if (script === 'bengali') return bengaliToPhonetic(token);
  if (script === 'latin') return romanizeBanglish(token);
  if (script === 'other') return token.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Mixed — walk codepoints, bucket into script runs, transliterate each run.
  let out = '';
  let buf = '';
  let bufScript = null;
  for (const ch of token) {
    const cp = ch.codePointAt(0);
    let curScript;
    if (cp >= 0x0980 && cp <= 0x09ff) curScript = 'bengali';
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39)) curScript = 'latin';
    else curScript = 'other';

    if (curScript !== bufScript && buf) {
      out += bufScript === 'bengali' ? bengaliToPhonetic(buf) : romanizeBanglish(buf);
      buf = '';
    }
    bufScript = curScript;
    buf += ch;
  }
  if (buf) out += bufScript === 'bengali' ? bengaliToPhonetic(buf) : romanizeBanglish(buf);
  return out;
}

/**
 * Public API — produce the unified phonetic key for any input.
 * Bengali / Banglish / English / mixed all reduce to the same space.
 * @param {string} text
 * @returns {string}
 */
function toPhoneticKey(text) {
  if (!text || typeof text !== 'string') return '';
  const norm = normalizeText(text).trim();
  if (!norm) return '';
  const tokens = norm.split(/\s+/);
  const fragments = [];
  for (const tok of tokens) {
    const frag = tokenToKeyFragment(tok);
    if (frag) fragments.push(frag);
  }
  return finalNormalize(fragments.join(' '));
}

/**
 * Cached variant used during phrase matching.
 * @param {string} phrase
 * @returns {string}
 */
function cachedPhraseKey(phrase) {
  if (_phraseKeyCache.has(phrase)) return _phraseKeyCache.get(phrase);
  const key = toPhoneticKey(phrase);
  _phraseKeyCache.set(phrase, key);
  return key;
}

// ---------------------------------------------------------------------------
// SECTION 5 — LEVENSHTEIN DISTANCE & SIMILARITY
// ---------------------------------------------------------------------------

/**
 * Memory-optimised Levenshtein distance (two-row DP).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cb = b.charCodeAt(j - 1);
      const cost = ca === cb ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

/**
 * Full Levenshtein matrix (inspection / debugging / differential debugging).
 * @param {string} a
 * @param {string} b
 * @returns {number[][]}
 */
function levenshteinMatrix(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d;
}

/**
 * Normalised similarity in [0, 1] (1 = identical, 0 = maximally different).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return Math.max(0, 1 - levenshtein(a, b) / maxLen);
}

/**
 * Phonetic phrase similarity — compares the phonetic keys of two phrases.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function phraseSimilarity(a, b) {
  const ka = cachedPhraseKey(a);
  const kb = cachedPhraseKey(b);
  if (!ka || !kb) return 0;
  return similarity(ka, kb);
}

// ---------------------------------------------------------------------------
// SECTION 6 — CANONICAL INTENT DEFINITIONS
// ---------------------------------------------------------------------------
// Every intent has:
//   intent      — canonical ID
//   tool        — name used in tool registry (may match kernel_9 tool names)
//   category    — which subsystem ultimately serves the intent
//   phrases     — canonical BN + Banglish + EN phrasings (phonetic keys cached)
//   examples    — documented STT-mangled test cases (for selfTest / LLM hints)
//   slots       — per-intent extractor definitions
// ---------------------------------------------------------------------------

const INTENT_DEFINITIONS = [
  // ── Adaptive Intelligence (kernel_9) ────────────────────────────────────
  {
    intent: 'START_LEARNING',
    tool: 'start_learning',
    category: 'adaptive_intelligence',
    phrases: [
      'জার্ভিস খেয়াল করো',
      'খেয়াল করো',
      'জার্ভিস নজর রাখো',
      'জার্ভিস লক্ষ্য করো',
      'jarvis kheyal koro',
      'kheyal koro',
      'jarvis watch me',
      'start learning',
      'observe me',
      'watch me',
    ],
    examples: [
      'জার্ভিত খেয়াল কারো',
      'জার্ভিস কেয়ার করো',
      'jarbhit kheyal karo',
    ],
    slots: [],
  },
  {
    intent: 'STOP_LEARNING',
    tool: 'stop_learning',
    category: 'adaptive_intelligence',
    phrases: [
      'জার্ভিস শেখা শেষ',
      'শেখা শেষ',
      'শেখা শেষ হয়েছে',
      'শেখানো শেষ',
      'learning done',
      'stop learning',
      'finish learning',
      'jarvis sekha ses',
      'sekha ses',
      'sekha shesh',
    ],
    examples: [
      'জার্ভিত সেখা শেস',
      'jarbhit sekha ses',
      'sekha shesh',
    ],
    slots: [],
  },
  {
    intent: 'EXECUTE_SURROGATE',
    tool: 'execute_surrogate',
    category: 'adaptive_intelligence',
    phrases: [
      'আগের মতো কাজটা করো',
      'আগের মতো করো',
      'কাজটা চালাও',
      'কাজ চালাও',
      'সেম কাজটা একবার করো',
      'শেষবারের কাজটা করো',
      'same kajta koro',
      'ager moto koro',
      'run that workflow',
      'execute workflow',
      'run workflow',
    ],
    examples: [
      'সেম কাস্টা এক বার পোরো',
      'same kasta ek bar poro',
      'ager moto',
    ],
    slots: [
      { name: 'workflow_hint', pattern: /(?:কাজটা|কাজ|workflow|task)/i, required: false, kind: 'string' },
    ],
  },
  {
    intent: 'GET_CURRENT_MODE',
    tool: 'get_current_mode',
    category: 'kernel10',
    phrases: [
      'এখন তোমার মোডের নাম কি',
      'তোমার মোড কি',
      'কোন মোডে আছো',
      'মোড নাম কি',
      'এখন কোন মোডে',
      'what mode are you in',
      'current mode',
      'ekhon tomar moder nam ki',
      'moder nam ki',
      'mode name',
    ],
    examples: [
      'এখন তুমার মুডে নান দিন',
      'ekhon tumar mude nan din',
      'tumar mode name ki',
    ],
    slots: [],
  },

  // ── Browser tab control (kernel_10 Part 4/6) ────────────────────────────
  {
    intent: 'SWITCH_TAB',
    tool: 'switch_tab',
    category: 'kernel10',
    phrases: [
      'ট্যাব নাম্বার এক এ যাও',
      'ট্যাব এক এ যাও',
      'ট্যাব ১ এ যাও',
      'প্রথম ট্যাবে যাও',
      'switch to tab 1',
      'tab one',
      'tab 1',
      'ট্যাব টু',
      'দ্বিতীয় ট্যাব',
      'second tab',
    ],
    examples: [
      'ট্যাব ওয়ান',
      'tab ek',
      'tab 1',
    ],
    slots: [
      {
        name: 'tab_index',
        pattern: /(?:tab|ট্যাব)\s*(?:number\s*|নাম্বার\s*|নম্বর\s*)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|ek|dui|tin|char|panch|choy|shat|aat|noy|dosh|এক|দুই|তিন|চার|পাঁচ|ছয়|সাত|আট|নয়|দশ|১|২|৩|৪|৫|৬|৭|৮|৯|১০)/i,
        required: true,
        kind: 'ordinal',
      },
    ],
  },
  {
    intent: 'NEW_TAB',
    tool: 'new_tab',
    category: 'kernel10',
    phrases: [
      'নতুন ট্যাব খোলো',
      'নতুন ট্যাব',
      'ট্যাব খোলো',
      'new tab',
      'new tab open',
      'open new tab',
      'natun tab kholo',
      'notun tab',
      'tab kholo',
    ],
    examples: [
      'নতুন টেব খোলো',
      'notun tab kholo',
    ],
    slots: [
      {
        name: 'url',
        pattern: /(https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/i,
        required: false,
        kind: 'url',
      },
    ],
  },
  {
    intent: 'CLOSE_TAB',
    tool: 'close_tab',
    category: 'kernel10',
    phrases: [
      'ট্যাব বন্ধ করো',
      'ট্যাব ক্লোজ করো',
      'এই ট্যাব বন্ধ',
      'close tab',
      'close current tab',
      'tab bondho koro',
      'tab close',
      'tab bandho koro',
    ],
    examples: [
      'টেব বন্ধ করো',
      'tab bondho',
    ],
    slots: [
      {
        name: 'tab_index',
        pattern: /(?:tab|ট্যাব)\s*(?:number\s*|নাম্বার\s*)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|ek|dui|tin|char|panch|choy|shat|aat|noy|dosh|১|২|৩|৪|৫|৬|৭|৮|৯|১০)/i,
        required: false,
        kind: 'ordinal',
      },
    ],
  },
  {
    intent: 'RELAY_TAB_DATA',
    tool: 'relay_tab_data',
    category: 'kernel10',
    phrases: [
      'এই ডেটা ট্যাব টু তে পাঠাও',
      'এই কোড ক্লদে পাঠাও',
      'এইটা ট্যাব থ্রি তে দাও',
      'এটা ওখানে পাঠাও',
      'send this to tab 2',
      'relay to tab',
      'send to chatgpt tab',
      'ei data tab dui te pathao',
      'ei code claude e pathao',
    ],
    examples: [
      'এই ডাটা ট্যাব টু তে পাঠাও',
      'ei data tab dui te pathao',
      'send this tab 2',
    ],
    slots: [
      {
        name: 'target_tab',
        pattern: /(?:tab|ট্যাব)\s*(?:number\s*|নাম্বার\s*)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|ek|dui|tin|char|panch|choy|shat|aat|noy|dosh|১|২|৩|৪|৫|৬|৭|৮|৯|১০)/i,
        required: true,
        kind: 'ordinal',
      },
    ],
  },
  {
    intent: 'OPEN_URL',
    tool: 'open_url',
    category: 'kernel10',
    phrases: [
      'গুগল খোলো',
      'গুগল ওপেন করো',
      'নতুন ট্যাবে গুগল',
      'open google',
      'open url',
      'open website',
      'google kholo',
      'google open koro',
      'github kholo',
      'youtube kholo',
    ],
    examples: [
      'গুগেল খোলো',
      'google kholo',
    ],
    slots: [
      {
        name: 'url',
        pattern: /(https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/i,
        required: false,
        kind: 'url',
      },
      {
        name: 'site_name',
        pattern: /(google|youtube|github|chatgpt|claude|sheets|erp|stackoverflow|stack overflow|gmail)/i,
        required: false,
        kind: 'string',
      },
    ],
  },
  {
    intent: 'SWITCH_LAYOUT',
    tool: 'switch_layout',
    category: 'kernel10',
    phrases: [
      'স্প্লিট মোডে যাও',
      'ব্রাউজার মোডে যাও',
      'চ্যাট মোডে যাও',
      'স্প্লিট ভিউ',
      'split view',
      'browser mode',
      'chat mode',
      'browser browser split',
      'layout change koro',
      'split mode',
    ],
    examples: [
      'স্প্লিট মুডে যাও',
      'browser mode koro',
      'split view koro',
    ],
    slots: [
      {
        name: 'layout',
        pattern: /\b(chat|browser|split|multi|browser_browser|browser-browser)\b/i,
        required: true,
        kind: 'string',
      },
    ],
  },
  {
    intent: 'FIND_IN_PAGE',
    tool: 'find_in_page',
    category: 'kernel10',
    phrases: [
      'পেজে খোঁজো',
      'এই লেখা খোঁজো',
      'find in page',
      'find text',
      'page e khojo',
      'ei lekha khojo',
    ],
    examples: [
      'পেজে খুঁজো',
      'find in page koro',
    ],
    slots: [
      {
        name: 'query',
        pattern: /(?:খোঁজো|খুঁজো|খোঁজ|find|search)\s+(.+)$/i,
        required: false,
        kind: 'string',
      },
    ],
  },
];

// Precompute all phrase keys so matching is O(1) lookups during hot path.
function prewarmPhraseCache() {
  _phraseKeyCache.clear();
  for (const def of INTENT_DEFINITIONS) {
    for (const phrase of def.phrases) {
      cachedPhraseKey(phrase);
    }
  }
}

// ---------------------------------------------------------------------------
// SECTION 7 — INTENT MATCHING (PHONETIC FUZZY)
// ---------------------------------------------------------------------------

/**
 * Match raw text against the intent dictionary using phonetic similarity.
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.68]
 * @param {boolean} [opts.includeAll=false] — return all scored intents, not just matches
 * @param {number} [opts.topK=3]
 * @returns {{matches: Array, best: object|null, key: string}}
 */
function matchIntent(text, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_PHONETIC_THRESHOLD;
  const includeAll = !!opts.includeAll;
  const topK = opts.topK || TOP_K_ALTERNATES;

  const key = toPhoneticKey(text);
  if (!key) return { matches: [], best: null, key };

  const scored = [];
  for (const def of INTENT_DEFINITIONS) {
    let bestPhrase = null;
    let bestScore = 0;
    for (const phrase of def.phrases) {
      const pKey = cachedPhraseKey(phrase);
      const score = similarity(key, pKey);
      if (score > bestScore) {
        bestScore = score;
        bestPhrase = phrase;
      }
    }
    if (bestScore > 0) {
      scored.push({
        intent: def.intent,
        tool: def.tool,
        category: def.category,
        score: bestScore,
        bestPhrase,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const filtered = scored.filter((s) => s.score >= threshold).slice(0, topK);

  return {
    matches: includeAll ? scored : filtered,
    best: filtered[0] || null,
    key,
  };
}

// ---------------------------------------------------------------------------
// SECTION 8 — SLOT EXTRACTION
// ---------------------------------------------------------------------------

/**
 * Convert ordinal strings (Bengali/Banglish/English/numeral) to an integer.
 * @param {string|number} s
 * @returns {number|null}
 */
function ordinalToNumber(s) {
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  const str = String(s || '').toLowerCase().trim();
  if (!str) return null;

  const map = {
    // English word ordinals
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    // Banglish
    ek: 1, dui: 2, tin: 3, char: 4, panch: 5,
    choy: 6, shat: 7, aat: 8, noy: 9, dosh: 10,
    // Bengali
    'এক': 1, 'দুই': 2, 'তিন': 3, 'চার': 4, 'পাঁচ': 5,
    'ছয়': 6, 'সাত': 7, 'আট': 8, 'নয়': 9, 'দশ': 10,
    // Bengali digits
    '১': 1, '২': 2, '৩': 3, '৪': 4, '৫': 5,
    '৬': 6, '৭': 7, '৮': 8, '৯': 9, '১০': 10,
  };
  if (map[str] !== undefined) return map[str];
  const n = parseInt(str, 10);
  if (Number.isFinite(n)) return n;
  return null;
}

/**
 * Extract per-intent slots from raw text.
 * @param {string} text
 * @param {string} intentName
 * @returns {object}
 */
function extractSlots(text, intentName) {
  const def = INTENT_DEFINITIONS.find((d) => d.intent === intentName);
  if (!def || !Array.isArray(def.slots) || def.slots.length === 0) return {};
  const slots = {};
  const raw = String(text || '');
  for (const sdef of def.slots) {
    const m = raw.match(sdef.pattern);
    if (!m) continue;
    let val = m[1];
    if (sdef.kind === 'ordinal') val = ordinalToNumber(val);
    if (sdef.kind === 'url') {
      let u = String(val).trim();
      if (!/^https?:\/\//i.test(u) && !u.startsWith('about:')) u = 'https://' + u;
      val = u;
    }
    if (val !== null && val !== undefined && val !== '') {
      slots[sdef.name] = val;
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// SECTION 9 — DYNAMIC UI MODE INSPECTOR
// ---------------------------------------------------------------------------
// Reads the current workspace layout via registered services. Every field
// degrades gracefully when the producing service has not been loaded yet
// (i.e., during early boot of Part 7).
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx — kernel context
 * @returns {Promise<{
 *   layout: string, activePanel: string, activeTabIndex: number,
 *   activeTabUrl: string|null, browserTabCount: number, isSplit: boolean,
 *   source: string
 * }>}
 */
async function inspectUIMode(ctx) {
  const snapshot = {
    layout: 'chat',
    activePanel: 'left',
    activeTabIndex: 0,
    activeTabUrl: null,
    browserTabCount: 0,
    isSplit: false,
    source: 'default',
  };
  if (!ctx || typeof ctx.getService !== 'function') return snapshot;

  // 1. Workspace UI injector (Part 6) is authoritative when present.
  try {
    const ws = ctx.getService('kernel10_workspace_ui');
    if (ws && typeof ws.getCurrentLayout === 'function') {
      const res = await Promise.resolve(ws.getCurrentLayout());
      if (res && typeof res === 'object') {
        if (typeof res.layout === 'string') snapshot.layout = res.layout;
        if (typeof res.activePanel === 'string') snapshot.activePanel = res.activePanel;
        if (typeof res.isSplit === 'boolean') snapshot.isSplit = res.isSplit;
        snapshot.source = 'workspace_ui';
      }
    }
  } catch (e) {
    safeAudit('warn', 'inspect_workspace_ui_failed', { error: String(e) });
  }

  // 2. Browser runtime (Part 4) supplies active tab details.
  try {
    const br = ctx.getService('kernel10_browser_runtime');
    if (br && typeof br.getActiveTabInfo === 'function') {
      const tab = await Promise.resolve(br.getActiveTabInfo());
      if (tab && typeof tab === 'object') {
        if (typeof tab.index === 'number') snapshot.activeTabIndex = tab.index;
        if (typeof tab.url === 'string') snapshot.activeTabUrl = tab.url;
        if (typeof tab.count === 'number') snapshot.browserTabCount = tab.count;
        if (snapshot.source === 'default') snapshot.source = 'browser_runtime';
      }
    }
  } catch (e) {
    safeAudit('warn', 'inspect_browser_runtime_failed', { error: String(e) });
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// SECTION 10 — LLM-ASSISTED INTENT NORMALIZER
// ---------------------------------------------------------------------------
// Falls back here only when phonetic matching is below threshold. The LLM
// callback is injected by Part 7 (wired to kernel_5_brain_router) to keep
// this module dependency-free and unit-testable.
// ---------------------------------------------------------------------------

/**
 * Build the LLM prompt describing the intent catalogue + UI context.
 * @param {string} rawText
 * @param {object} uiContext
 * @returns {string}
 */
function buildLLMPrompt(rawText, uiContext) {
  const intentLines = INTENT_DEFINITIONS.map((d) => {
    const sample = d.phrases[0];
    return `- ${d.intent} (tool: ${d.tool}) — e.g. "${sample}"`;
  }).join('\n');

  const ctxJson = JSON.stringify(uiContext || {
    layout: 'unknown',
    activePanel: null,
    activeTabUrl: null,
  }, null, 2);

  return [
    'You are the STT intent normalizer for a desktop AI assistant named JARVIS.',
    'The user speaks Bengali / Banglish / English and their speech-to-text is garbled.',
    'Your job: recover the TRUE intent and extract slots.',
    '',
    'Available intents:',
    intentLines,
    '',
    'Current UI context:',
    ctxJson,
    '',
    'Raw input (may contain STT errors):',
    '"""',
    rawText,
    '"""',
    '',
    'Respond with ONLY a valid JSON object (no markdown, no code fences, no prose):',
    '{',
    '  "intent": "<one of the intent IDs above, or null if none match>",',
    '  "slots": { "<slot_name>": "<value>" },',
    '  "confidence": <number between 0 and 1>,',
    '  "reason": "<short explanation>"',
    '}',
  ].join('\n');
}

/**
 * Parse an LLM response into a strict shape. Strips code fences.
 * @param {string} raw
 * @returns {{intent: string|null, slots: object, confidence: number, reason: string}|null}
 */
function parseLLMResponse(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    // Best-effort: extract first { … } block.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;

  let intent = obj.intent != null ? String(obj.intent) : null;
  if (intent) {
    const canonical = INTENT_DEFINITIONS.find(
      (d) => d.intent.toLowerCase() === intent.toLowerCase(),
    );
    intent = canonical ? canonical.intent : null;
  }

  return {
    intent,
    slots: obj.slots && typeof obj.slots === 'object' ? obj.slots : {},
    confidence: Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, Number(obj.confidence)))
      : 0.5,
    reason: obj.reason ? String(obj.reason) : '',
  };
}

/**
 * Normalize via LLM callback. Times out after opts.timeoutMs.
 * @param {string} rawText
 * @param {object} uiContext
 * @param {Function} llmCallback — async (prompt, opts) => string
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
async function normalizeWithLLM(rawText, uiContext, llmCallback, opts = {}) {
  if (typeof llmCallback !== 'function') return null;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_LLM_TIMEOUT_MS;
  const prompt = buildLLMPrompt(rawText, uiContext);

  const llmPromise = Promise.resolve().then(() => llmCallback(prompt, {
    temperature: 0,
    maxTokens: 300,
    purpose: 'stt_intent_normalize',
  }));

  const timeoutPromise = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('llm_timeout')), timeoutMs),
  );

  try {
    const raw = await Promise.race([llmPromise, timeoutPromise]);
    return parseLLMResponse(raw);
  } catch (e) {
    safeAudit('warn', 'llm_normalize_failed', { error: String(e) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// SECTION 11 — TOOL REGISTRY & DISPATCHER
// ---------------------------------------------------------------------------

/**
 * Register a handler for a canonical intent.
 * @param {string} intentName
 * @param {(slots: object, ctx: object, meta: object) => any} handler
 * @param {object} [meta]
 */
function registerTool(intentName, handler, meta = {}) {
  if (!intentName || typeof handler !== 'function') {
    throw new Error('registerTool: intentName and handler are required');
  }
  _toolRegistry.set(intentName, { intent: intentName, handler, meta });
  safeAudit('info', 'tool_registered', { intent: intentName, meta_keys: Object.keys(meta || {}) });
}

/**
 * Dispatch an intent to its registered handler.
 * @param {string} intentName
 * @param {object} slots
 * @param {object} ctx
 * @param {object} [meta]
 * @returns {Promise<{ok: boolean, intent: string, result?: any, error?: string}>}
 */
async function dispatch(intentName, slots, ctx, meta = {}) {
  const entry = _toolRegistry.get(intentName);
  if (!entry) {
    safeAudit('warn', 'dispatch_unknown_intent', { intent: intentName });
    return { ok: false, intent: intentName, error: 'unknown_intent' };
  }
  try {
    const result = await Promise.resolve(entry.handler(slots || {}, ctx, meta || {}));
    return { ok: true, intent: intentName, result };
  } catch (e) {
    safeAudit('error', 'dispatch_handler_error', {
      intent: intentName,
      error: String(e && e.message ? e.message : e),
    });
    return { ok: false, intent: intentName, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// SECTION 12 — MAIN ROUTE() ENTRYPOINT
// ---------------------------------------------------------------------------

/**
 * Route a raw user (or STT) input through the full pipeline.
 *
 * @param {string} rawInput
 * @param {object} ctx
 * @param {object} [opts]
 * @param {string} [opts.mode='task']     — 'chat'|'task'|'tools'|'offline'
 * @param {string} [opts.subMode='assisted']
 * @param {boolean} [opts.forceRoute=false] — override chat/offline bypass
 * @param {number} [opts.threshold=0.68]
 * @param {Function} [opts.llmCallback]   — overrides module-level callback
 * @param {object} [opts.uiContext]       — skip inspectUIMode() call
 * @returns {Promise<{
 *   ok: boolean, rawText: string, intent: string|null, slots: object,
 *   confidence: number, source: string, matchedPhrase?: string,
 *   alternates?: Array, uiContext?: object, reason?: string
 * }>}
 */
async function route(rawInput, ctx, opts = {}) {
  const text = String(rawInput || '').trim();
  if (!text) {
    return { ok: false, rawText: '', intent: null, slots: {}, confidence: 0, source: 'fallback', reason: 'empty_input' };
  }

  // Chat/offline bypass — unless caller explicitly forces routing.
  const mode = String(opts.mode || 'task').toLowerCase();
  const forceRoute = !!opts.forceRoute;
  if (!forceRoute && (mode === 'chat' || mode === 'offline')) {
    return {
      ok: false,
      rawText: text,
      intent: null,
      slots: {},
      confidence: 0,
      source: 'mode_bypass',
      reason: 'chat_or_offline_mode',
    };
  }

  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_PHONETIC_THRESHOLD;
  const uiContext = opts.uiContext || (await inspectUIMode(ctx));

  // ── Stage 1: phonetic fuzzy match ────────────────────────────────────
  const phon = matchIntent(text, { threshold });
  if (phon.best) {
    const slots = extractSlots(text, phon.best.intent);
    safeAudit('info', 'route_phonetic_hit', {
      intent: phon.best.intent,
      score: Math.round(phon.best.score * 1000) / 1000,
      matched_phrase: phon.best.bestPhrase,
    });
    return {
      ok: true,
      rawText: text,
      intent: phon.best.intent,
      slots,
      confidence: phon.best.score,
      source: 'phonetic',
      matchedPhrase: phon.best.bestPhrase,
      alternates: phon.matches.slice(1),
      uiContext,
    };
  }

  // ── Stage 2: LLM-assisted fallback ───────────────────────────────────
  const llmFn = typeof opts.llmCallback === 'function' ? opts.llmCallback : _llmCallback;
  if (typeof llmFn === 'function') {
    const llm = await normalizeWithLLM(text, uiContext, llmFn, { timeoutMs: opts.llmTimeoutMs });
    if (llm && llm.intent) {
      const slots = Object.keys(llm.slots).length > 0
        ? llm.slots
        : extractSlots(text, llm.intent);
      safeAudit('info', 'route_llm_hit', {
        intent: llm.intent,
        confidence: llm.confidence,
        reason: llm.reason,
      });
      return {
        ok: true,
        rawText: text,
        intent: llm.intent,
        slots,
        confidence: llm.confidence,
        source: 'llm',
        uiContext,
      };
    }
  }

  // ── Stage 3: fallback ────────────────────────────────────────────────
  safeAudit('info', 'route_fallback', {
    phonetic_key: phon.key,
    best_score: phon.matches[0] ? phon.matches[0].score : 0,
  });
  return {
    ok: false,
    rawText: text,
    intent: null,
    slots: {},
    confidence: 0,
    source: 'fallback',
    reason: 'no_confident_match',
    alternates: phon.matches,
    uiContext,
  };
}

// ---------------------------------------------------------------------------
// SECTION 13 — DEFAULT TOOL HANDLERS (LAZY RESOLVED SERVICES)
// ---------------------------------------------------------------------------
// Handlers resolve their dependencies at dispatch time, not init time, so
// Part 7 can load this file before Parts 2/4/5/6 without circular errors.
// ---------------------------------------------------------------------------

function registerDefaultTools() {
  // Adaptive Intelligence (kernel_9) bridges.
  registerTool('START_LEARNING', async (slots, ctx, meta) => {
    const ai = ctx.getService('adaptive_intelligence');
    if (!ai || typeof ai.startLearning !== 'function') {
      return { ok: false, error: 'adaptive_intelligence_unavailable' };
    }
    const res = await Promise.resolve(ai.startLearning(meta && meta.rawText ? meta.rawText : ''));
    return res;
  }, { category: 'adaptive_intelligence' });

  registerTool('STOP_LEARNING', async (slots, ctx, meta) => {
    const ai = ctx.getService('adaptive_intelligence');
    if (!ai || typeof ai.stopLearning !== 'function') {
      return { ok: false, error: 'adaptive_intelligence_unavailable' };
    }
    const res = await Promise.resolve(ai.stopLearning(meta && meta.rawText ? meta.rawText : ''));
    return res;
  }, { category: 'adaptive_intelligence' });

  registerTool('EXECUTE_SURROGATE', async (slots, ctx, meta) => {
    const ai = ctx.getService('adaptive_intelligence');
    if (!ai || typeof ai.executeWorkflow !== 'function') {
      return { ok: false, error: 'adaptive_intelligence_unavailable' };
    }
    const raw = meta && meta.rawText ? meta.rawText : '';
    const res = await Promise.resolve(ai.executeWorkflow(raw, slots || {}));
    return res;
  }, { category: 'adaptive_intelligence' });

  // Kernel-10 composed inspection.
  registerTool('GET_CURRENT_MODE', async (slots, ctx) => {
    const ui = await inspectUIMode(ctx);
    const ai = ctx.getService('adaptive_intelligence');
    const aiMetrics = ai && typeof ai.getRuntimeMetrics === 'function'
      ? ai.getRuntimeMetrics()
      : {};
    const bus = ctx.getService('kernel10_shared_context_bus');
    const busStats = bus && typeof bus.getStats === 'function' ? bus.getStats() : {};
    const summaryParts = [
      `Layout: ${ui.layout}`,
      `Active panel: ${ui.activePanel}`,
      `Browser tabs: ${ui.browserTabCount}`,
      `Active tab #${ui.activeTabIndex + 1}`,
      ui.activeTabUrl ? `URL: ${ui.activeTabUrl}` : 'URL: (none)',
      `AI observing: ${aiMetrics.observing ? 'YES' : 'NO'}`,
      `Context bus entries: ${busStats.count || 0}`,
    ];
    return {
      ok: true,
      ui,
      adaptive_intelligence: aiMetrics,
      shared_context_bus: busStats,
      summary: summaryParts.join(' | '),
    };
  }, { category: 'kernel10' });

  // Browser runtime bridges (Part 4).
  registerTool('SWITCH_TAB', async (slots, ctx) => {
    const br = ctx.getService('kernel10_browser_runtime');
    if (!br || typeof br.activateTab !== 'function') {
      return { ok: false, error: 'browser_runtime_unavailable' };
    }
    return Promise.resolve(br.activateTab(slots.tab_index));
  }, { category: 'kernel10' });

  registerTool('NEW_TAB', async (slots, ctx) => {
    const br = ctx.getService('kernel10_browser_runtime');
    if (!br || typeof br.createTab !== 'function') {
      return { ok: false, error: 'browser_runtime_unavailable' };
    }
    return Promise.resolve(br.createTab(slots.url || 'about:blank'));
  }, { category: 'kernel10' });

  registerTool('CLOSE_TAB', async (slots, ctx) => {
    const br = ctx.getService('kernel10_browser_runtime');
    if (!br) return { ok: false, error: 'browser_runtime_unavailable' };
    if (typeof slots.tab_index === 'number' && typeof br.closeTabByIndex === 'function') {
      return Promise.resolve(br.closeTabByIndex(slots.tab_index));
    }
    if (typeof br.closeActiveTab === 'function') {
      return Promise.resolve(br.closeActiveTab());
    }
    return { ok: false, error: 'browser_runtime_missing_close' };
  }, { category: 'kernel10' });

  registerTool('OPEN_URL', async (slots, ctx) => {
    const br = ctx.getService('kernel10_browser_runtime');
    if (!br || typeof br.createTab !== 'function') {
      return { ok: false, error: 'browser_runtime_unavailable' };
    }
    let url = slots.url || '';
    if (!url && slots.site_name) {
      const siteMap = {
        google: 'https://www.google.com',
        youtube: 'https://www.youtube.com',
        github: 'https://github.com',
        chatgpt: 'https://chat.openai.com',
        claude: 'https://claude.ai',
        sheets: 'https://docs.google.com/spreadsheets',
        gmail: 'https://mail.google.com',
        stackoverflow: 'https://stackoverflow.com',
        erp: 'https://erp.local', // placeholder, user-configured
      };
      url = siteMap[String(slots.site_name).toLowerCase()] || '';
    }
    if (!url) url = 'about:blank';
    return Promise.resolve(br.createTab(url));
  }, { category: 'kernel10' });

  registerTool('RELAY_TAB_DATA', async (slots, ctx, meta) => {
    const bus = ctx.getService('kernel10_shared_context_bus');
    if (!bus || typeof bus.relayToTab !== 'function') {
      return { ok: false, error: 'shared_context_bus_unavailable' };
    }
    const payload = {
      targetTabIndex: slots.target_tab,
      rawText: meta && meta.rawText ? meta.rawText : '',
    };
    return Promise.resolve(bus.relayToTab(payload));
  }, { category: 'kernel10' });

  // Workspace layout bridge (Part 6).
  registerTool('SWITCH_LAYOUT', async (slots, ctx) => {
    const ws = ctx.getService('kernel10_workspace_ui');
    if (!ws || typeof ws.setLayout !== 'function') {
      return { ok: false, error: 'workspace_ui_unavailable' };
    }
    return Promise.resolve(ws.setLayout(slots.layout));
  }, { category: 'kernel10' });

  // Find-in-page bridge (Part 5).
  registerTool('FIND_IN_PAGE', async (slots, ctx) => {
    const svc = ctx.getService('kernel10_browser_services');
    if (!svc || typeof svc.findInPage !== 'function') {
      return { ok: false, error: 'browser_services_unavailable' };
    }
    return Promise.resolve(svc.findInPage(slots.query || ''));
  }, { category: 'kernel10' });
}

// ---------------------------------------------------------------------------
// SECTION 14 — AUDIT & LOGGING HELPERS
// ---------------------------------------------------------------------------

function safeAudit(level, event, data) {
  if (typeof _auditFn === 'function') {
    try {
      _auditFn(level, `${LOG_TAG}.${event}`, data);
    } catch (_) { /* swallow — audit must never crash the pipeline */ }
  }
}

// ---------------------------------------------------------------------------
// SECTION 15 — SELF TEST HARNESS
// ---------------------------------------------------------------------------
// Runs the four STT-error examples from the spec through the phonetic
// pipeline and asserts the expected intent is selected. Callable from
// console via ctx.getService('kernel10_stt_normalizer').selfTest().
// ---------------------------------------------------------------------------

function selfTest() {
  const cases = [
    {
      label: 'GET_CURRENT_MODE garbled',
      input: 'এখন তুমার মুডে নান দিন',
      expect: 'GET_CURRENT_MODE',
    },
    {
      label: 'STOP_LEARNING garbled',
      input: 'জার্ভিত সেখা শেস',
      expect: 'STOP_LEARNING',
    },
    {
      label: 'EXECUTE_SURROGATE garbled',
      input: 'সেম কাস্টা এক বার পোরো',
      expect: 'EXECUTE_SURROGATE',
    },
    {
      label: 'START_LEARNING garbled',
      input: 'জার্ভিত খেয়াল কারো',
      expect: 'START_LEARNING',
    },
    {
      label: 'SWITCH_TAB English',
      input: 'switch to tab 2',
      expect: 'SWITCH_TAB',
    },
  ];

  const results = [];
  let passed = 0;
  let failed = 0;

  for (const c of cases) {
    const m = matchIntent(c.input, { threshold: DEFAULT_PHONETIC_THRESHOLD });
    const actual = m.best ? m.best.intent : null;
    const ok = actual === c.expect;
    if (ok) passed++;
    else failed++;
    results.push({
      label: c.label,
      input: c.input,
      expected: c.expect,
      actual,
      score: m.best ? Number(m.best.score.toFixed(3)) : 0,
      key: m.key,
      pass: ok,
    });
  }

  return { passed, failed, results, threshold: DEFAULT_PHONETIC_THRESHOLD };
}

// ---------------------------------------------------------------------------
// SECTION 16 — MODULE INITIALIZATION
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx — kernel context (from kernel.js makeKernelContext)
 */
function init(ctx) {
  _ctx = ctx || null;
  _auditFn = ctx && typeof ctx.audit === 'function'
    ? ctx.audit.bind(ctx)
    : null;

  prewarmPhraseCache();
  registerDefaultTools();

  // Register the service so Part 7 (and any future consumer) can call this
  // pipeline directly.
  if (ctx && typeof ctx.registerService === 'function') {
    ctx.registerService('kernel10_stt_normalizer', {
      // High-level pipeline.
      route: (rawInput, opts) => route(rawInput, ctx, opts),
      dispatch,
      registerTool,
      setLLMCallback: (fn) => { _llmCallback = typeof fn === 'function' ? fn : null; },

      // Utilities (exposed for tests / advanced callers).
      toPhoneticKey,
      levenshtein,
      levenshteinMatrix,
      similarity,
      phraseSimilarity,
      matchIntent,
      extractSlots,
      inspectUIMode: () => inspectUIMode(ctx),
      normalizeWithLLM,
      buildLLMPrompt,
      parseLLMResponse,
      ordinalToNumber,
      selfTest,
      getIntentDefinitions: () => INTENT_DEFINITIONS.map((d) => ({
        intent: d.intent,
        tool: d.tool,
        category: d.category,
        phrase_count: d.phrases.length,
      })),
    });
  }

  // State contributor — surfaces normalization-pipeline health to the
  // existing HUD / dashboard telemetry stream.
  if (ctx && typeof ctx.addStateContributor === 'function') {
    ctx.addStateContributor('kernel10_stt_normalizer', () => ({
      version: '1.0.0',
      intents_registered: INTENT_DEFINITIONS.length,
      tools_registered: _toolRegistry.size,
      phrase_cache_size: _phraseKeyCache.size,
      llm_callback_attached: typeof _llmCallback === 'function',
      threshold: DEFAULT_PHONETIC_THRESHOLD,
    }));
  }

  safeAudit('info', 'stt_normalizer_initialized', {
    intents: INTENT_DEFINITIONS.length,
    tools: _toolRegistry.size,
    phrases_cached: _phraseKeyCache.size,
  });
}

// ---------------------------------------------------------------------------
// SECTION 17 — EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  // Lifecycle.
  name: 'kernel10_stt_intent_normalizer',
  init,
  setLLMCallback: (fn) => { _llmCallback = typeof fn === 'function' ? fn : null; },

  // Pipeline.
  route,
  normalize: route, // alias for convenience
  dispatch,
  registerTool,
  inspectUIMode,

  // Primitives (public — used by Part 7 and tests).
  detectScript,
  normalizeText,
  bengaliToPhonetic,
  romanizeBanglish,
  toPhoneticKey,
  levenshtein,
  levenshteinMatrix,
  similarity,
  phraseSimilarity,
  matchIntent,
  extractSlots,
  ordinalToNumber,
  buildLLMPrompt,
  parseLLMResponse,
  normalizeWithLLM,
  selfTest,

  // Constants.
  INTENT_DEFINITIONS,
  DEFAULT_PHONETIC_THRESHOLD,
};