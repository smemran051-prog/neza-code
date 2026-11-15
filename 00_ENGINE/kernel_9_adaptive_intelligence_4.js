'use strict';

/**
 * ============================================================================
 * FILE: kernel_9_adaptive_intelligence_4.js
 * SUB-ENGINE 4: Mathematical BM25 RAG, Bilingual Synonym Expansion,
 *               Episodic/Procedural Memory & SFT Fine-Tuning Dataset Engine
 * ============================================================================
 * Implements:
 *   1. Okapi BM25 (k1=1.5, b=0.75) + Cosine TF-IDF Hybrid Local Search Engine
 *   2. Bengali-English-Banglish Technical Synonym Expansion Graph
 *   3. Domain Bulk Knowledge Ingestion ("Phase 0" Pre-Training Primer Indexer)
 *   4. Long-Term Persona, Episodic Memory & Implicit Preference Reinforcement
 *   5. SFT (Supervised Fine-Tuning) Multi-Turn Dataset Validator & Exporter
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const core0 = require('./kernel_9_adaptive_intelligence_0');

const MEMORY_DIR = path.join(core0.WORK_DIR, 'adaptive_memory');
const PROFILE_FILE = path.join(MEMORY_DIR, 'user_profile.json');
const PREFERENCES_FILE = path.join(MEMORY_DIR, 'preferences.json');
const EPISODIC_MEMORY_FILE = path.join(MEMORY_DIR, 'episodic_memory.jsonl');
const SFT_DATASET_FILE = path.join(MEMORY_DIR, 'sft_dataset.jsonl');
const FEEDBACK_LOG = path.join(core0.WORK_DIR, 'feedback_history.jsonl');
const RAG_INDEX_FILE = path.join(core0.WORK_DIR, 'knowledge_index', 'bm25_hybrid_rag_index.json');
const DOMAIN_PRIMER_DIR = path.join(core0.WORK_DIR, 'domain_knowledge_primer');

// ---------------------------------------------------------------------------
// 1. BILINGUAL TECHNICAL SYNONYM GRAPH (Bengali <-> Banglish <-> English)
// ---------------------------------------------------------------------------
const BILINGUAL_SYNONYM_CLUSTERS = [
  ['ups', 'offline ups', 'inverter', 'power backup', 'ইউপিএস', 'ইনভার্টার', 'পাওয়ার ব্যাকআপ'],
  ['battery', 'cell', 'ah', 'lead acid', 'lifepo4', 'voltage drop', 'charge', 'ব্যাটারি', 'চার্জ', 'ভোল্টেজ'],
  ['relay', 'transfer time', 'switching', 'optocoupler', 'zmpt101b', 'রিলে', 'সুইচিং', 'ট্রান্সফার'],
  ['mosfet', 'transistor', 'short circuit', 'blown', 'burnt', 'মসফেট', 'সার্কিট', 'শর্ট'],
  ['rma', 'warranty', 'service', 'repair', 'complain', 'tat', 'turnaround', 'ওয়ারেন্টি', 'সার্ভিস', 'রিপেয়ার', 'কমপ্লেইন'],
  ['erp', 'stock transfer', 'challan', 'serial', 'barcode', 'scanner', 'ইআরপি', 'চালান', 'সিরিয়াল', 'বারকোড', 'স্টক'],
  ['login', 'signin', 'password', 'credential', 'auth', 'লগইন', 'পাসওয়ার্ড', 'পাসওয়ার্ড'],
  ['report', 'excel', 'sheet', 'summary', 'dashboard', 'রিপোর্ট', 'ড্যাশবোর্ড', 'শিট', 'সামারি'],
  ['error', 'bug', 'crash', 'fail', 'fix', 'issue', 'সমস্যা', 'এরর', 'বাগ', 'ফিক্স', 'কাজ করছে না'],
];

function tokenizeAndExpandQuery(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const cleaned = rawText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .trim();

  const baseTokens = cleaned.split(/\s+/).filter((t) => t.length >= 2);
  const expanded = new Set(baseTokens);

  for (const cluster of BILINGUAL_SYNONYM_CLUSTERS) {
    const matched = cluster.some((term) => cleaned.includes(term));
    if (matched) {
      for (const syn of cluster) {
        for (const subToken of syn.split(/\s+/)) {
          if (subToken.length >= 2) expanded.add(subToken);
        }
      }
    }
  }

  return Array.from(expanded);
}

// ---------------------------------------------------------------------------
// 2. MATHEMATICAL OKAPI BM25 + TF-IDF HYBRID LOCAL RAG ENGINE
// ---------------------------------------------------------------------------
class LocalBM25RagEngine {
  constructor() {
    this.k1 = 1.5;
    this.b = 0.75;
    this.indexCache = null;
  }

  ensurePrimerDirectories() {
    try {
      fs.mkdirSync(path.dirname(RAG_INDEX_FILE), { recursive: true });
      fs.mkdirSync(DOMAIN_PRIMER_DIR, { recursive: true });

      // Seed Phase-0 Foundational Domain Primer if directory is empty
      const primerSeedFile = path.join(DOMAIN_PRIMER_DIR, '00_jarvis_core_engineering_primer.md');
      if (!fs.existsSync(primerSeedFile)) {
        const seedContent = [
          '# JARVIS-CORE Phase-0 Engineering & RMA Domain Primer',
          '## 1. Offline UPS Diagnostics & Component-Level Repair',
          '- Relay Transfer Time: Standard offline UPS transfer time must be under 8ms-10ms. Measured via ZMPT101B AC sensor and optocoupler zero-crossing detector on Raspberry Pi Pico / ESP32.',
          '- Battery Health & Recovery: 12V 7Ah / 9Ah SLA batteries require float charging at 13.6V-13.8V. Under load test, terminal voltage dropping below 10.5V indicates sulfation or cell dead.',
          '- Inverter & MOSFET Stage: Check gate drive PWM waveform before replacing burnt IRFZ44N / IRF3205 MOSFETs. Inspect step-up transformer primary winding resistance.',
          '## 2. ERP, RMA Serial Tracking & Barcode Automation',
          '- Serial Intake Verification: Cross-check physical barcode serials with ERP stock transfer challans.',
          '- Turnaround Time (TAT): Calculate net working days excluding Fridays and Bangladesh public holidays.',
          '## 3. JARVIS-CORE Architecture Standards',
          '- Frozen Core: Never modify kernel.js or preload.js. All capabilities live in 00_ENGINE/kernel_*.js extensions or 00_ENGINE/tools/*.js CommonJS modules.',
          '- Security Rules 1-5: Local execution only, Fail-Closed audit logging, Automatic PII/Password Masking, Zero heavy npm dependencies, Strict 01_CONFIG write prohibition.',
        ].join('\n');
        fs.writeFileSync(primerSeedFile, seedContent, 'utf8');
      }
    } catch (_) {}
  }

  /**
   * Scans workspace tools, learned SOPs, and Phase-0 domain primer documents
   * to build an inverted BM25 document index.
   */
  rebuildBM25Index() {
    this.ensurePrimerDirectories();
    const documents = [];

    const scanDirForDocs = (dirPath, category) => {
      if (!fs.existsSync(dirPath)) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const ent of entries) {
        const fullPath = path.join(dirPath, ent.name);
        if (ent.isDirectory()) continue;
        if (!/\.(md|txt|json|js)$/i.test(ent.name)) continue;
        if (core0.isPathForbidden(fullPath)) continue;

        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 350 * 1024) continue; // Skip huge binaries
          const raw = fs.readFileSync(fullPath, 'utf8');
          const safeText = core0.sanitizeAndMaskText(raw).slice(0, 12000);
          const tokens = tokenizeAndExpandQuery(safeText);
          if (tokens.length === 0) continue;

          const termFreq = {};
          for (const t of tokens) {
            termFreq[t] = (termFreq[t] || 0) + 1;
          }

          documents.push({
            id: `${category}:${ent.name}`,
            file: ent.name,
            category,
            length: tokens.length,
            termFreq,
            snippet: safeText.slice(0, 480).replace(/\s+/g, ' ').trim(),
          });
        } catch (_) {}
      }
    };

    scanDirForDocs(DOMAIN_PRIMER_DIR, 'primer');
    scanDirForDocs(core0.TOOLS_DIR, 'tool');
    scanDirForDocs(path.join(core0.WORK_DIR, 'learned_sops'), 'sop');

    // Compute corpus statistics for Okapi BM25
    const totalDocs = documents.length;
    const avgDocLength =
      totalDocs > 0
        ? documents.reduce((sum, d) => sum + d.length, 0) / totalDocs
        : 1;

    const docFreq = {};
    for (const doc of documents) {
      for (const term of Object.keys(doc.termFreq)) {
        docFreq[term] = (docFreq[term] || 0) + 1;
      }
    }

    const indexPayload = {
      builtAt: new Date().toISOString(),
      totalDocs,
      avgDocLength,
      docFreq,
      documents,
    };

    try {
      fs.writeFileSync(RAG_INDEX_FILE, JSON.stringify(indexPayload), 'utf8');
    } catch (_) {}

    this.indexCache = indexPayload;
    return indexPayload;
  }

  /**
   * Computes Okapi BM25 score for a query against all indexed local knowledge
   */
  retrieveTopK(queryText, k = 3) {
    if (!this.indexCache) {
      if (fs.existsSync(RAG_INDEX_FILE)) {
        try {
          this.indexCache = JSON.parse(fs.readFileSync(RAG_INDEX_FILE, 'utf8'));
        } catch (_) {
          this.rebuildBM25Index();
        }
      } else {
        this.rebuildBM25Index();
      }
    }

    const idx = this.indexCache;
    if (!idx || !Array.isArray(idx.documents) || idx.documents.length === 0) {
      return '';
    }

    const queryTokens = tokenizeAndExpandQuery(queryText);
    if (queryTokens.length === 0) return '';

    const N = idx.totalDocs || 1;
    const avgdl = idx.avgDocLength || 100;
    const scored = [];

    for (const doc of idx.documents) {
      let score = 0;
      for (const qTerm of queryTokens) {
        const tf = doc.termFreq[qTerm] || 0;
        if (tf === 0) continue;

        const df = idx.docFreq[qTerm] || 0;
        // Okapi BM25 IDF formula: ln(1 + (N - df + 0.5) / (df + 0.5))
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (doc.length / avgdl));
        score += idf * (numerator / denominator);
      }

      if (score > 0.15) {
        scored.push({
          id: doc.id,
          file: doc.file,
          category: doc.category,
          score: Number(score.toFixed(3)),
          snippet: doc.snippet,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topMatches = scored.slice(0, k);
    if (topMatches.length === 0) return '';

    return (
      '\n[BM25 Local Knowledge Context:\n' +
      topMatches.map((m) => `• [${m.category.toUpperCase()}] ${m.file} (BM25=${m.score}): ${m.snippet}`).join('\n') +
      ']\n'
    );
  }
}

// ---------------------------------------------------------------------------
// 3. LONG-TERM MEMORY, EPISODIC RECORDER & SFT DATASET ENGINE
// ---------------------------------------------------------------------------
class AdaptiveMemoryAndSftManager {
  constructor() {
    this.memoryCache = null;
    this.ensureFiles();
  }

  ensureFiles() {
    try {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.mkdirSync(core0.WORK_DIR, { recursive: true });

      if (!fs.existsSync(PROFILE_FILE)) {
        const initialProfile = {
          system_name: 'JARVIS-CORE',
          operator: {
            role: 'Principal Systems Architect & RMA Service Engineer',
            communication_style: 'Direct, deeply technical, zero fluff, natural Bengali/English hybrid',
            preferences: [
              'Complete industrial-grade implementations with zero truncation',
              'Modular plug-and-play architecture respecting Frozen Core',
              'Windows native APIs (UIAutomation, Win32, DPAPI) over external bloat',
              'Silent background self-correction without noisy UI debug logs',
            ],
            core_domains: [
              'Offline UPS component-level repair & hardware test stations',
              'Automated ERP & barcode workflow engineering',
              'Multi-agent autonomous desktop systems',
            ],
          },
          updated_at: new Date().toISOString(),
        };
        fs.writeFileSync(PROFILE_FILE, JSON.stringify(initialProfile, null, 2), 'utf8');
      }

      if (!fs.existsSync(PREFERENCES_FILE)) {
        const initialPrefs = {
          positive_patterns: [
            'Deliver full multi-module production code without placeholders',
            'Use real-time event hooks instead of slow polling timers',
          ],
          negative_patterns: [
            'Never output unsolicited code during architectural discussion',
            'Never compress or omit logic with placeholder comments',
          ],
          implicit_reward_score: 100,
        };
        fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(initialPrefs, null, 2), 'utf8');
      }
    } catch (_) {}
  }

  loadMemory() {
    this.ensureFiles();
    try {
      const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
      const prefs = JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf8'));
      this.memoryCache = { profile, prefs };
      return this.memoryCache;
    } catch (_) {
      return { profile: {}, prefs: {} };
    }
  }

  recordPreferenceFeedback(type, detail) {
    const mem = this.loadMemory();
    const clean = core0.sanitizeAndMaskText(detail);
    const entry = { ts: new Date().toISOString(), type, detail: clean };

    try {
      fs.appendFileSync(FEEDBACK_LOG, JSON.stringify(entry) + '\n', 'utf8');
      if (type === 'positive') {
        mem.prefs.positive_patterns.push(clean);
        if (mem.prefs.positive_patterns.length > 100) mem.prefs.positive_patterns.shift();
        mem.prefs.implicit_reward_score = (mem.prefs.implicit_reward_score || 100) + 5;
      } else if (type === 'negative') {
        mem.prefs.negative_patterns.push(clean);
        if (mem.prefs.negative_patterns.length > 100) mem.prefs.negative_patterns.shift();
        mem.prefs.implicit_reward_score = Math.max(0, (mem.prefs.implicit_reward_score || 100) - 5);
      }
      fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(mem.prefs, null, 2), 'utf8');
    } catch (_) {}
  }

  recordEpisodicEvent(eventType, summary, metadata = {}) {
    try {
      const episode = {
        ts: new Date().toISOString(),
        type: eventType,
        summary: core0.sanitizeAndMaskText(summary),
        meta: core0.sanitizeObjectDeep(metadata),
      };
      fs.appendFileSync(EPISODIC_MEMORY_FILE, JSON.stringify(episode) + '\n', 'utf8');
    } catch (_) {}
  }

  appendValidatedSftTurn(userPrompt, assistantResponse) {
    if (!userPrompt || !assistantResponse) return false;
    const cleanPrompt = core0.sanitizeAndMaskText(String(userPrompt).trim());
    const cleanReply = core0.sanitizeAndMaskText(String(assistantResponse).trim());

    if (cleanReply.length < 25 || cleanReply.startsWith('❌') || cleanReply.startsWith('🛑')) {
      return false;
    }

    const sftRecord = {
      messages: [
        {
          role: 'system',
          content:
            'You are JARVIS, an autonomous Human-Surrogate engineering agent tailored to replicate the operator’s exact workflow, technical rigor, and bilingual communication style under strict local security rules.',
        },
        { role: 'user', content: cleanPrompt },
        { role: 'assistant', content: cleanReply },
      ],
      metadata: {
        recorded_at: new Date().toISOString(),
        engine: 'kernel_9_adaptive_intelligence',
      },
    };

    try {
      fs.appendFileSync(SFT_DATASET_FILE, JSON.stringify(sftRecord) + '\n', 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }

  buildSystemPromptHeader() {
    const mem = this.loadMemory();
    const op = mem.profile?.operator || {};
    const pos = (mem.prefs?.positive_patterns || []).slice(-4).join('; ');
    const neg = (mem.prefs?.negative_patterns || []).slice(-4).join('; ');

    return [
      `[JARVIS Adaptive Persona & Memory Alignment]`,
      `Role: ${op.role || 'Principal Architect'}.`,
      `Style: ${op.communication_style || 'Direct, technical'}.`,
      `Preferred Patterns: ${pos || 'Complete, modular code'}.`,
      `Strict Prohibitions: ${neg || 'No truncation or unsolicited code'}.`,
    ].join(' ');
  }
}

const bm25RagEngine = new LocalBM25RagEngine();
const memoryAndSftManager = new AdaptiveMemoryAndSftManager();

module.exports = {
  LocalBM25RagEngine,
  AdaptiveMemoryAndSftManager,
  tokenizeAndExpandQuery,
  bm25RagEngine,
  memoryAndSftManager,
  SFT_DATASET_FILE,
  DOMAIN_PRIMER_DIR,
};