'use strict';

/**
 * ============================================================================
 * MASTER ORCHESTRATOR: kernel_9_adaptive_intelligence.js (v2.5 Enterprise)
 * Location: C:\Jarvis_Core\00_ENGINE\kernel_9_adaptive_intelligence.js
 * ============================================================================
 * Deeply integrates and orchestrates all 6 Heavyweight Sub-Engines:
 *   - Sub-Engine 0 (kernel_9_adaptive_intelligence_0.js):
 *       Semantic Intent NLU, Bilingual Lexicon, Rule 1-5 Security, Win32 DPAPI Vault
 *   - Sub-Engine 1 (kernel_9_adaptive_intelligence_1.js):
 *       55ms Real-Time C#/Win32 UIAutomation Event Stream & Deep Window Crawler
 *   - Sub-Engine 2 (kernel_9_adaptive_intelligence_2.js):
 *       Multi-Tier UIAutomation Pattern Replayer (Invoke, Value, Toggle, Select, XY)
 *   - Sub-Engine 3 (kernel_9_adaptive_intelligence_3.js):
 *       4-Agent Swarm FSM (Observer, Planner, Silent Critic, Operator) & 3-Tier Recovery
 *   - Sub-Engine 4 (kernel_9_adaptive_intelligence_4.js):
 *       Okapi BM25 Hybrid Vector/Keyword RAG, Episodic Memory & SFT JSONL Generator
 *   - Sub-Engine 5 (kernel_9_adaptive_intelligence_5.js):
 *       Multi-State Animated HUD Dot, Dynamic Parameter Extractor & VM Tool Compiler
 * ============================================================================
 */

const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const core0 = require('./kernel_9_adaptive_intelligence_0');
const { accessibilitySensor } = require('./kernel_9_adaptive_intelligence_1');
const { actionReplayer } = require('./kernel_9_adaptive_intelligence_2');
const {
  observerAgent,
  plannerAgent,
  silentCriticAgent,
  operatorAgent,
} = require('./kernel_9_adaptive_intelligence_3');
const {
  bm25RagEngine,
  memoryAndSftManager,
  SFT_DATASET_FILE,
  DOMAIN_PRIMER_DIR,
} = require('./kernel_9_adaptive_intelligence_4');
const {
  hudCompiler,
  MANIFEST_FILE,
  TELEMETRY_LOG_FILE,
} = require('./kernel_9_adaptive_intelligence_5');

const SOP_DIR = path.join(core0.WORK_DIR, 'learned_sops');

// ---------------------------------------------------------------------------
// 1. MASTER RUNTIME STATE & TELEMETRY COUNTERS
// ---------------------------------------------------------------------------
let CTX = null;
let IS_OBSERVING = false;
let IS_EXECUTING_SURROGATE = false;
let ACTIVE_SESSION = null;
let RAW_EVENT_BUFFER = [];
let VOICE_NOTE_BUFFER = [];
let LAST_TURN_CONTEXT = {
  userPrompt: '',
  aiResponse: '',
  timestamp: 0,
  sftCommitted: false,
};

const RUNTIME_METRICS = {
  bootedAt: new Date().toISOString(),
  sessionsRecorded: 0,
  toolsCompiled: 0,
  workflowsExecuted: 0,
  totalSelfHealedSteps: 0,
  implicitCorrectionsCaptured: 0,
  sftTurnsExported: 0,
};

// Implicit Negative Feedback Detection Patterns (Reflexion Loop)
const IMPLICIT_NEGATIVE_PATTERNS = [
  /(?:ভুল হয়েছে|ভুল করছো|এভাবে না|এটা চাইনি|কোড চাইনি|কোড দিবা না|হয়নি|কাজ করছে না|মিসিং|বাদ পড়েছে)/i,
  /\b(?:bhul\s+hoyeche|ebhabe\s+na|code\s+chaini|kaj\s+korche\s+na|missing\s+hoyeche|not\s+what\s+i\s+asked|wrong\s+output|stop\s+giving\s+code)\b/i,
];

const IMPLICIT_POSITIVE_PATTERNS = [
  /(?:পারফেক্ট|চমৎকার|দারুণ হয়েছে|ঠিক আছে|পছন্দ হয়েছে|সঠিক|এক্সেলেন্ট|শাবাশ)/i,
  /\b(?:pochondo\s+howce|pochondo\s+hoyeche|perfect\s+and\s+professional|exact\s+match|great\s+job|works\s+perfectly)\b/i,
];

// ---------------------------------------------------------------------------
// 2. IMPLICIT REFLEXION & SELF-CORRECTION ANALYZER
// ---------------------------------------------------------------------------
function evaluateImplicitOperatorFeedback(rawUserPrompt) {
  if (!rawUserPrompt || typeof rawUserPrompt !== 'string') return null;
  const clean = rawUserPrompt.trim();

  // Check if user is expressing dissatisfaction with the immediately preceding AI turn
  for (const negRe of IMPLICIT_NEGATIVE_PATTERNS) {
    if (negRe.test(clean)) {
      RUNTIME_METRICS.implicitCorrectionsCaptured++;
      const lesson = `Operator rejected behavior when asked "${(LAST_TURN_CONTEXT.userPrompt || 'previous turn').slice(0, 80)}": ${clean.slice(0, 140)}`;
      memoryAndSftManager.recordPreferenceFeedback('negative', lesson);
      memoryAndSftManager.recordEpisodicEvent('implicit_negative_feedback', lesson, {
        rejected_turn_ts: LAST_TURN_CONTEXT.timestamp,
      });
      return { type: 'negative', lesson };
    }
  }

  // Check if user is explicitly praising or validating the pattern
  for (const posRe of IMPLICIT_POSITIVE_PATTERNS) {
    if (posRe.test(clean) && LAST_TURN_CONTEXT.userPrompt && !LAST_TURN_CONTEXT.sftCommitted) {
      const note = `Validated pattern on "${LAST_TURN_CONTEXT.userPrompt.slice(0, 80)}": ${clean.slice(0, 100)}`;
      memoryAndSftManager.recordPreferenceFeedback('positive', note);
      // Commit previous turn to SFT dataset with high confidence
      if (LAST_TURN_CONTEXT.aiResponse) {
        const exported = memoryAndSftManager.appendValidatedSftTurn(
          LAST_TURN_CONTEXT.userPrompt,
          LAST_TURN_CONTEXT.aiResponse
        );
        if (exported) {
          LAST_TURN_CONTEXT.sftCommitted = true;
          RUNTIME_METRICS.sftTurnsExported++;
        }
      }
      return { type: 'positive', note };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. REAL-TIME APPRENTICE OBSERVATION LIFECYCLE
// ---------------------------------------------------------------------------
function onLiveUiAutomationEvent(ev) {
  if (!IS_OBSERVING || !ev) return;

  // Ignore clicking on Jarvis's own status dot
  if (
    /electron/i.test(ev.process || '') &&
    /jarvis/i.test(ev.windowTitle || '') &&
    RAW_EVENT_BUFFER.length > 0
  ) {
    return;
  }

  RAW_EVENT_BUFFER.push(ev);

  // Immediately push live step count & active process to the Blue HUD Dot
  const stepCount = RAW_EVENT_BUFFER.length;
  const activeApp = ev.process || 'System';
  hudCompiler.pushLiveObservationCounter(stepCount, activeApp, 96);
}

async function startSurrogateApprenticeSession(initialNote = '') {
  // Rule 2: Fail-Closed Storage Verification
  if (!core0.verifyFailClosedStorage(CTX)) {
    hudCompiler.updateHudDotState('error', 'FAIL-CLOSED STORAGE HALT');
    setTimeout(() => hudCompiler.updateHudDotState('idle'), 3000);
    return {
      ok: false,
      msg: '🛑 **[Fail-Closed Security]** লোকাল মেমোরি বা অডিট ডিরেক্টরিতে রাইট করা যাচ্ছে না। নিরাপত্তার কারণে লার্নিং মোড চালু করা সম্ভব হয়নি।',
    };
  }

  if (IS_OBSERVING && ACTIVE_SESSION) {
    return {
      ok: true,
      msg: `🔵 **বস, আমি অলরেডি আপনার কাজ খেয়াল করছি!**\n• **সেশন আইডি:** \`${ACTIVE_SESSION.id}\`\n• **এখন পর্যন্ত রেকর্ডকৃত ক্লিক/ইভেন্ট:** ${RAW_EVENT_BUFFER.length} টি\nকাজ শেষ হলে স্বাভাবিকভাবে বলুন *"জার্ভিস, শেখা শেষ"*।`,
    };
  }

  IS_OBSERVING = true;
  RAW_EVENT_BUFFER = [];
  VOICE_NOTE_BUFFER = [];

  if (initialNote && !core0.isAmbientChitchat(initialNote)) {
    VOICE_NOTE_BUFFER.push({
      ts: new Date().toISOString(),
      text: core0.sanitizeAndMaskText(initialNote),
    });
  }

  // Capture an initial baseline map of the foreground window
  let initialControlsCount = 0;
  try {
    const initialTree = await accessibilitySensor.crawlFullWindowInteractiveMap();
    initialControlsCount = Array.isArray(initialTree) ? initialTree.length : 0;
  } catch (_) {}

  ACTIVE_SESSION = {
    id: `sop_${Date.now()}`,
    startedAt: new Date().toISOString(),
    initialControlsCount,
  };

  accessibilitySensor.removeAllListeners('ui_event');
  accessibilitySensor.on('ui_event', onLiveUiAutomationEvent);

  const daemonStarted = accessibilitySensor.startSensorDaemon();
  if (!daemonStarted) {
    IS_OBSERVING = false;
    ACTIVE_SESSION = null;
    hudCompiler.updateHudDotState('error', 'DAEMON INIT FAILED');
    setTimeout(() => hudCompiler.updateHudDotState('idle'), 2500);
    return {
      ok: false,
      msg: '⚠️ উইন্ডোজ রিয়েল-টাইম অ্যাক্সেসিবিলিটি ডেমন (UIAutomation Sensor) চালু করা যায়নি।',
    };
  }

  hudCompiler.updateHudDotState('observing', 'APPRENTICE OBSERVING', {
    stepsCount: 0,
    activeApp: 'Ready',
    confidence: 98,
  });

  CTX?.audit?.('info', 'surrogate_observation_started', {
    session_id: ACTIVE_SESSION.id,
    initial_controls_detected: initialControlsCount,
  });

  memoryAndSftManager.recordEpisodicEvent(
    'learning_session_started',
    `Started observing operator workflow (${ACTIVE_SESSION.id})`,
    { session_id: ACTIVE_SESSION.id }
  );

  return {
    ok: true,
    msg: [
      `🔵 **লার্নিং মোড চালু হয়েছে (নীল ডট সক্রিয়)।**`,
      `• **সেন্সর:** Real-Time 55ms Win32 + UIAutomation Hook চালু আছে।`,
      `• **সিকিউরিটি:** পাসওয়ার্ড ও গোপন তথ্য অটো-মাস্ক (` + '`***[MASKED]***`' + `) হবে এবং আড্ডা/অপ্রয়োজনীয় কথা ফিল্টার হয়ে যাবে।`,
      `• আপনি আপনার স্বাভাবিক নিয়মে কাজ করুন। শেষ হলে বলবেন **"জার্ভিস, শেখা শেষ"**।`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 4. SWARM COMPILATION & DYNAMIC TOOL GENERATION
// ---------------------------------------------------------------------------
async function stopAndCompileSurrogateSession(closingNote = '') {
  if (!IS_OBSERVING || !ACTIVE_SESSION) {
    return {
      ok: false,
      msg: '⚪ আমি এখন কোনো লার্নিং সেশনে নেই। কাজ শেখাতে চাইলে বলুন **"জার্ভিস, খেয়াল করো"**।',
    };
  }

  if (closingNote && !core0.isAmbientChitchat(closingNote)) {
    VOICE_NOTE_BUFFER.push({
      ts: new Date().toISOString(),
      text: core0.sanitizeAndMaskText(closingNote),
    });
  }

  IS_OBSERVING = false;
  accessibilitySensor.stopSensorDaemon();
  accessibilitySensor.removeAllListeners('ui_event');

  // Switch HUD Dot to Yellow (Swarm Compiling)
  hudCompiler.updateHudDotState('compiling', 'SWARM COMPILING SOP...', {
    stepsCount: RAW_EVENT_BUFFER.length,
  });

  const sessionMeta = { ...ACTIVE_SESSION };
  const rawEventsSnapshot = [...RAW_EVENT_BUFFER];
  const voiceNotesSnapshot = [...VOICE_NOTE_BUFFER];

  ACTIVE_SESSION = null;
  RAW_EVENT_BUFFER = [];
  VOICE_NOTE_BUFFER = [];

  try {
    // 1. AGENT 1 (Observer FSM): Filter noise, coalesce keystrokes, align voice notes
    const filteredData = observerAgent.processRawSession(rawEventsSnapshot, voiceNotesSnapshot);

    // 2. AGENT 2 (Planner FSM): Build SOP Blueprint, score anchors, construct recovery trees
    const draftBlueprint = plannerAgent.buildSopBlueprint(sessionMeta.id, filteredData);

    // 3. AGENT 4 (Silent Critic FSM): Enforce Rules 1-5, scrub secrets, prune empty steps silently
    const certifiedSop = silentCriticAgent.auditAndSelfCorrectSop(draftBlueprint, CTX);

    // Persist Certified SOP JSON
    fs.mkdirSync(SOP_DIR, { recursive: true });
    const sopFilePath = path.join(SOP_DIR, `${certifiedSop.sop_id}.json`);
    fs.writeFileSync(sopFilePath, JSON.stringify(certifiedSop, null, 2), 'utf8');

    // 4. SUB-ENGINE 5 (Tool Synthesizer): Extract dynamic parameters, VM-validate, compile & hot-reload
    const toolFilePath = hudCompiler.compileSopToExecutableTool(certifiedSop);

    // 5. SUB-ENGINE 4 (BM25 RAG): Re-index workspace so the new SOP & tool are immediately searchable
    bm25RagEngine.rebuildBM25Index();

    RUNTIME_METRICS.sessionsRecorded++;
    if (toolFilePath) RUNTIME_METRICS.toolsCompiled++;

    memoryAndSftManager.recordEpisodicEvent(
      'workflow_learned_and_compiled',
      `Learned workflow ${certifiedSop.name} for ${certifiedSop.primary_app} (${certifiedSop.action_sequence.length} steps)`,
      {
        sop_id: certifiedSop.sop_id,
        tool_name: certifiedSop.name,
        confidence: certifiedSop.overall_confidence,
      }
    );

    setTimeout(() => hudCompiler.updateHudDotState('idle'), 900);

    // Register positive reinforcement for successful demonstration
    const dynamicParamsInfo = hudCompiler.toolSynthesizer.extractDynamicParametersFromSop(certifiedSop);
    const dynamicParamNames = Object.values(dynamicParamsInfo.stepParameterBindings || {}).map(
      (b) => b.paramName
    );

    return {
      ok: true,
      msg: [
        `✅ **শেখা এবং ৪-এজেন্ট সোয়ার্ম কম্পাইলেশন সম্পূর্ণ হয়েছে, বস!**`,
        `• **ওয়ার্কফ্লো নাম:** \`${certifiedSop.name}\``,
        `• **টার্গেট অ্যাপ্লিকেশন:** \`${certifiedSop.primary_app}\` (সহযোগী অ্যাপ: ${(certifiedSop.apps_involved || []).join(', ') || 'None'})`,
        `• **সার্টিফাইড ধাপ (UI Steps):** ${certifiedSop.action_sequence.length} টি (কাঁচা ইভেন্ট ছিল ${rawEventsSnapshot.length} টি)`,
        `• **নির্ভরযোগ্যতা (Confidence Score):** ${Math.round((certifiedSop.overall_confidence || 0.85) * 100)}%`,
        `• **ডাইনামিক ইনপুট প্যারামিটার:** ${dynamicParamNames.length > 0 ? dynamicParamNames.map((p) => `\`${p}\``).join(', ') : 'স্বয়ংক্রিয় ডিফল্ট ভ্যালু'}`,
        `• **এক্সিকিউটেবল টুল:** \`00_ENGINE/tools/${path.basename(toolFilePath || `${certifiedSop.name}.js`)}\` (Hot-Reloaded)`,
        ``,
        `পরের বার শুধু বলবেন **"জার্ভিস, আগের মতো কাজটা করে দাও"** অথবা **"${certifiedSop.primary_app} এর কাজটা চালাও"**—আমি নিজেই পালন করব।`,
      ].join('\n'),
    };
  } catch (err) {
    hudCompiler.updateHudDotState('error', 'COMPILATION FAILED');
    setTimeout(() => hudCompiler.updateHudDotState('idle'), 2500);
    CTX?.audit?.('error', 'surrogate_compile_error', { error: err.message });
    return {
      ok: false,
      msg: `⚠️ লার্নিং সেশন কম্পাইল করতে সমস্যা হয়েছে: ${err.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 5. INTELLIGENT MULTI-WORKFLOW DISPATCHER & SURROGATE EXECUTOR
// ---------------------------------------------------------------------------
function selectBestMatchingSop(queryText = '') {
  if (!fs.existsSync(SOP_DIR)) return null;
  const files = fs
    .readdirSync(SOP_DIR)
    .filter((f) => f.startsWith('sop_') && f.endsWith('.json'))
    .sort();

  if (files.length === 0) return null;

  const lowerQuery = String(queryText || '').toLowerCase();
  const allSops = [];

  for (const f of files) {
    try {
      const full = path.join(SOP_DIR, f);
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      allSops.push(parsed);
    } catch (_) {}
  }

  if (allSops.length === 0) return null;

  // Try matching by application name or workflow name mentioned in user's command
  for (let i = allSops.length - 1; i >= 0; i--) {
    const sop = allSops[i];
    const appLower = String(sop.primary_app || '').toLowerCase();
    const nameLower = String(sop.name || '').toLowerCase();
    if (
      (appLower && lowerQuery.includes(appLower)) ||
      (nameLower && lowerQuery.includes(nameLower))
    ) {
      return sop;
    }
  }

  // Default to the most recently learned SOP
  return allSops[allSops.length - 1];
}

async function executeSurrogateWorkflowByQuery(queryText = '', overrideArgs = {}) {
  if (IS_EXECUTING_SURROGATE) {
    return '⏳ বস, আমি অলরেডি একটি সারোগেট ওয়ার্কফ্লো রান করছি। এটি শেষ হওয়া পর্যন্ত একটু অপেক্ষা করুন।';
  }

  const targetSop = selectBestMatchingSop(queryText);
  if (!targetSop) {
    return '⚪ আমার মেমোরিতে এখনো কোনো শেখানো ওয়ার্কফ্লো (SOP) নেই। আগে আমাকে একবার কাজটি করে দেখান এবং বলুন **"জার্ভিস, খেয়াল করো"**।';
  }

  IS_EXECUTING_SURROGATE = true;
  const toolFile = path.join(core0.TOOLS_DIR, `${targetSop.name}.js`);

  try {
    let execResult = null;

    if (fs.existsSync(toolFile)) {
      // Clear cache to ensure latest version runs
      const resolved = require.resolve(toolFile);
      if (require.cache[resolved]) delete require.cache[resolved];
      const toolModule = require(toolFile);
      execResult = await toolModule.execute(overrideArgs, CTX);
    } else {
      // Fallback: Direct OperatorAgent execution if tool file was moved
      hudCompiler.pushLiveExecutionProgress(1, targetSop.action_sequence.length, targetSop.primary_app, false);
      execResult = await operatorAgent.executeCertifiedSop(targetSop, overrideArgs, CTX);
      hudCompiler.updateHudDotState('idle');
    }

    IS_EXECUTING_SURROGATE = false;
    RUNTIME_METRICS.workflowsExecuted++;
    RUNTIME_METRICS.totalSelfHealedSteps += Number(execResult?.self_healed_steps) || 0;

    memoryAndSftManager.recordEpisodicEvent(
      'surrogate_workflow_executed',
      `Executed ${targetSop.name} (${execResult?.steps_succeeded || 0}/${execResult?.total_steps || 0} steps succeeded)`,
      {
        sop_id: targetSop.sop_id,
        self_healed: execResult?.self_healed_steps || 0,
      }
    );

    if (overrideArgs && overrideArgs.dry_run) {
      return [
        `🔍 **Dry-Run ইন্সপেকশন রিপোর্ট (\`${targetSop.name}\`):**`,
        `• **টার্গেট অ্যাপ:** \`${targetSop.primary_app}\``,
        `• **মোট ধাপ:** ${targetSop.action_sequence.length} টি`,
        `• **কনফিডেন্স:** ${Math.round((targetSop.overall_confidence || 0.85) * 100)}%`,
        `• কোনো ক্লিক বা টাইপ না করেই সব ভেরিফাই করা হয়েছে।`,
      ].join('\n');
    }

    return [
      `🤖 **Human-Surrogate Agent — দায়িত্ব পালন সম্পন্ন!**`,
      `• **চালুকৃত ওয়ার্কফ্লো:** \`${targetSop.name}\` (SOP: \`${targetSop.sop_id}\`)`,
      `• **টার্গেট সফটওয়্যার:** \`${targetSop.primary_app}\``,
      `• **ধাপ সফল:** ${execResult?.steps_succeeded || 0} / ${execResult?.total_steps || targetSop.action_sequence.length} টি`,
      `• **স্বয়ংক্রিয় রিকভারি (Self-Healed Steps):** ${execResult?.self_healed_steps || 0} টি`,
      execResult?.duration_ms ? `• **সময় লেগেছে:** ${(execResult.duration_ms / 1000).toFixed(2)} সেকেন্ড` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch (err) {
    IS_EXECUTING_SURROGATE = false;
    hudCompiler.updateHudDotState('idle');
    return `⚠️ সারোগেট ওয়ার্কফ্লো (\`${targetSop.name}\`) চালাতে গিয়ে সমস্যা হয়েছে: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// 6. COMPREHENSIVE MANAGEMENT CLI (/learn & /surrogate)
// ---------------------------------------------------------------------------
async function handleManagementCliCommand(rawPrompt) {
  const sub = rawPrompt.replace(/^\/(?:learn|surrogate)\s*/i, '').trim();

  // 1. /learn prefer <rule>
  if (/^prefer\s+/i.test(sub)) {
    const note = sub.replace(/^prefer\s+/i, '').trim();
    memoryAndSftManager.recordPreferenceFeedback('positive', note);
    return `🧠 **[Learned Positive Preference]** আপনার কাজের স্টাইল মেমোরিতে যুক্ত করা হয়েছে:\n> "${core0.sanitizeAndMaskText(note)}"`;
  }

  // 2. /learn avoid <rule>
  if (/^avoid\s+/i.test(sub)) {
    const note = sub.replace(/^avoid\s+/i, '').trim();
    memoryAndSftManager.recordPreferenceFeedback('negative', note);
    return `⚠️ **[Avoidance Constraint Registered]** এই ভুলটি আমি ভবিষ্যতে আর কখনো করব না:\n> "${core0.sanitizeAndMaskText(note)}"`;
  }

  // 3. /learn vault set <targetKey> <username> <password>
  if (/^vault\s+set\s+/i.test(sub)) {
    const parts = sub.replace(/^vault\s+set\s+/i, '').trim().split(/\s+/);
    if (parts.length < 3) {
      return `❌ সঠিক ফরম্যাট: \`/learn vault set <app_key> <username> <password>\``;
    }
    const [targetKey, username, ...passParts] = parts;
    const plainSecret = passParts.join(' ');
    const res = core0.credentialVault.storeSecret(targetKey, username, plainSecret);
    if (res.ok) {
      return `🔐 **[Windows Credential Vault + DPAPI]** \`${res.vaultTarget}\` সিকিউরলি এনক্রিপ্ট করে উইন্ডোজ ভল্টে সেভ করা হয়েছে। কোনো প্লেইনটেক্সট লগে রাখা হয়নি।`;
    }
    return `⚠️ ভল্টে সেভ করতে সমস্যা হয়েছে: ${res.error}`;
  }

  // 4. /learn vault list
  if (/^vault\s+list/i.test(sub)) {
    const targets = core0.credentialVault.listRegisteredTargets();
    return [
      `🔐 **Windows Credential Vault-এ সংরক্ষিত টার্গেটসমূহ (${targets.length} টি):**`,
      targets.length > 0 ? targets.map((t) => `• \`${t}\``).join('\n') : '• এখনো কোনো ক্রিডেনশিয়াল সেভ করা হয়নি।',
      `\n💡 নতুন পাসওয়ার্ড ভল্টে রাখতে: \`/learn vault set <app_login> <user> <pass>\``,
    ].join('\n');
  }

  // 5. /learn dot <mini|full|hide>
  if (/^dot\s+/i.test(sub)) {
    const mode = sub.replace(/^dot\s+/i, '').trim().toLowerCase();
    if (mode === 'mini' || mode === 'compact') {
      hudCompiler.setMinimalDotMode(true);
      return `🔵 HUD স্ট্যাটাস ইন্ডিকেটর এখন **Compact 10px Dot** মোডে সেট করা হয়েছে।`;
    }
    if (mode === 'full' || mode === 'pill') {
      hudCompiler.setMinimalDotMode(false);
      return `🔵 HUD স্ট্যাটাস ইন্ডিকেটর এখন **Full Telemetry Pill** মোডে সেট করা হয়েছে।`;
    }
    if (mode === 'hide' || mode === 'off') {
      hudCompiler.updateHudDotState('idle');
      return `⚪ HUD স্ট্যাটাস ডট হাইড করা হয়েছে।`;
    }
  }

  // 6. /learn tools (List all learned surrogate workflows)
  if (/^(?:tools|workflows|sops|list)/i.test(sub)) {
    const compiledList = hudCompiler.listCompiledSurrogateTools();
    if (compiledList.length === 0) {
      return `📂 এখনো কোনো সারোগেট টুল কম্পাইল করা হয়নি। **"জার্ভিস, খেয়াল করো"** বলে যেকোনো কাজ করে দেখান।`;
    }
    return [
      `🛠️ **শেখানো এবং কম্পাইলকৃত Human-Surrogate Tools (${compiledList.length} টি):**`,
      ...compiledList.map(
        (t, idx) =>
          `${idx + 1}. **\`${t.tool_name}\`** — App: \`${t.primary_app}\` | Steps: ${t.steps_count} | Confidence: ${Math.round(
            (t.overall_confidence || 0.85) * 100
          )}% | Params: ${(t.dynamic_parameters || []).length}`
      ),
    ].join('\n');
  }

  // 7. /learn dryrun [app_or_tool_name]
  if (/^dryrun/i.test(sub)) {
    const targetHint = sub.replace(/^dryrun\s*/i, '').trim();
    return executeSurrogateWorkflowByQuery(targetHint, { dry_run: true });
  }

  // 8. /learn index primer
  if (/^index/i.test(sub)) {
    const idx = bm25RagEngine.rebuildBM25Index();
    return `📚 **[Okapi BM25 Hybrid RAG]** ইনডেক্স আপডেট সম্পন্ন! মোট ডকুমেন্টস: ${idx.totalDocs || 0} টি (Phase-0 Primer, Tools & Learned SOPs)।`;
  }

  // Default: Comprehensive Status Dashboard
  const mem = memoryAndSftManager.loadMemory();
  const compiledTools = hudCompiler.listCompiledSurrogateTools();
  const vaultTargets = core0.credentialVault.listRegisteredTargets();

  return [
    `🧠 **JARVIS Unified Human-Surrogate & Adaptive Intelligence (v2.5 Enterprise)**`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `• **অপারেটর প্রোফাইল:** ${mem.profile?.operator?.role || 'Principal Architect'}`,
    `• **অবজারভার স্টেট:** ${IS_OBSERVING ? `🔵 ACTIVE (Session: ${ACTIVE_SESSION?.id}, Events: ${RAW_EVENT_BUFFER.length})` : '⚪ Standby (Idle)'}`,
    `• **সারোগেট এক্সিকিউটর:** ${IS_EXECUTING_SURROGATE ? '🟢 RUNNING WORKFLOW' : '⚪ Ready'}`,
    `• **কম্পাইলকৃত সারোগেট টুলস:** ${compiledTools.length} টি (\`/learn tools\` দিয়ে দেখুন)`,
    `• **পজিটিভ প্রেফারেন্স রুলস:** ${(mem.prefs?.positive_patterns || []).length} টি`,
    `• **অ্যাভয়ডেন্স (Avoid) রুলস:** ${(mem.prefs?.negative_patterns || []).length} টি (Implicit captured: ${RUNTIME_METRICS.implicitCorrectionsCaptured})`,
    `• **ইমপ্লিসিট রিওয়ার্ড স্কোর:** ${mem.prefs?.implicit_reward_score ?? 100}`,
    `• **উইন্ডোজ ভল্ট ক্রিডেনশিয়ালস:** ${vaultTargets.length} টি সুরক্ষিত টার্গেট`,
    `• **BM25 RAG ও SFT ফাইল:** \`01_CONFIG/adaptive_memory/sft_dataset.jsonl\``,
    ``,
    `⚡ **কমান্ডসমূহ:**`,
    `  • \`/learn prefer <rule>\` — আপনার পছন্দের নিয়ম বা কোডিং স্টাইল শেখাতে`,
    `  • \`/learn avoid <mistake>\` — কোনো ভুল বা অবাঞ্ছিত কাজ স্থায়ীভাবে নিষিদ্ধ করতে`,
    `  • \`/learn tools\` — আপনার শেখানো সব অটোমেশন টুলের তালিকা দেখতে`,
    `  • \`/learn dryrun <app>\` — ক্লিক না করে শেখানো কাজের ড্রাই-রান প্রিভিউ দেখতে`,
    `  • \`/learn vault set <key> <user> <pass>\` — উইন্ডোজ ভল্টে লগইন পাসওয়ার্ড এনক্রিপ্ট করে রাখতে`,
    `  • \`/learn dot mini\` | \`/learn dot full\` — স্ক্রিনের স্ট্যাটাস ডট ছোট/বড় করতে`,
    `  • \`/learn index\` — Phase-0 ডোমেইন প্রাইমার ও BM25 সার্চ ইনডেক্স রিফ্রেশ করতে`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 7. UNIFIED IPC PROMPT INTERCEPTOR PIPELINE
// ---------------------------------------------------------------------------
function installUnifiedMasterPipeline() {
  const existingListeners = ipcMain.listeners('jarvis:ai-prompt');
  if (existingListeners.length === 0) return;

  const downstream = existingListeners[0];
  ipcMain.removeAllListeners('jarvis:ai-prompt');

  ipcMain.on('jarvis:ai-prompt', async (event, data) => {
    const rawPrompt = typeof data?.prompt === 'string' ? data.prompt.trim() : '';

    // 1. Handle explicit /learn or /surrogate CLI commands
    if (/^\/(?:learn|surrogate)(\b|\s)/i.test(rawPrompt)) {
      const replyText = await handleManagementCliCommand(rawPrompt);
      if (!event.sender.isDestroyed()) {
        event.sender.send('jarvis:ai-response', { text: replyText });
      }
      return;
    }

    // 2. Evaluate Implicit Operator Feedback (Reflexion Loop on previous turn)
    evaluateImplicitOperatorFeedback(rawPrompt);

    // 3. Classify Natural Semantic Intent ("জার্ভিস খেয়াল করো" / "শেখা শেষ" / "আগের মতো করো")
    const intentRes = core0.classifySemanticIntent(rawPrompt);

    if (intentRes.intent === 'START_LEARNING') {
      const res = await startSurrogateApprenticeSession(rawPrompt);
      if (!event.sender.isDestroyed()) {
        event.sender.send('jarvis:ai-response', { text: res.msg });
      }
      return;
    }

    if (intentRes.intent === 'STOP_LEARNING') {
      const res = await stopAndCompileSurrogateSession(rawPrompt);
      if (!event.sender.isDestroyed()) {
        event.sender.send('jarvis:ai-response', { text: res.msg });
      }
      return;
    }

    if (intentRes.intent === 'EXECUTE_SURROGATE' && !IS_OBSERVING) {
      const reply = await executeSurrogateWorkflowByQuery(rawPrompt, {});
      if (!event.sender.isDestroyed()) {
        event.sender.send('jarvis:ai-response', { text: reply });
      }
      return;
    }

    // 4. If currently Observing, silently attach relevant instructions to the active session
    if (IS_OBSERVING && ACTIVE_SESSION && !intentRes.isCasualChitchat) {
      VOICE_NOTE_BUFFER.push({
        ts: new Date().toISOString(),
        text: core0.sanitizeAndMaskText(rawPrompt),
      });
    }

    // 5. Retrieve Okapi BM25 Local Knowledge + Adaptive Persona Header
    const ragContext = bm25RagEngine.retrieveTopK(rawPrompt, 3);
    const adaptiveHeader = memoryAndSftManager.buildSystemPromptHeader();

    const augmentedData = {
      ...data,
      prompt: `${adaptiveHeader}\n${ragContext}\nUser Query: ${rawPrompt}`,
    };

    // 6. Intercept outgoing AI response for SFT Dataset & Reflexion tracking
    const originalSend = event.sender.send.bind(event.sender);
    event.sender.send = (channel, payload) => {
      if (channel === 'jarvis:ai-response' && payload && payload.text && !payload.isVoice) {
        const outText = String(payload.text);
        if (!outText.startsWith('❌') && !outText.startsWith('🛑') && !outText.startsWith('⚠️')) {
          LAST_TURN_CONTEXT = {
            userPrompt: rawPrompt,
            aiResponse: outText,
            timestamp: Date.now(),
            sftCommitted: false,
          };

          // Auto-append clean technical turns to SFT JSONL
          const committed = memoryAndSftManager.appendValidatedSftTurn(rawPrompt, outText);
          if (committed) {
            LAST_TURN_CONTEXT.sftCommitted = true;
            RUNTIME_METRICS.sftTurnsExported++;
          }
        }
      }
      return originalSend(channel, payload);
    };

    downstream(event, augmentedData);
  });
}

// ---------------------------------------------------------------------------
// 8. GRACEFUL SHUTDOWN & ZOMBIE DAEMON PREVENTION
// ---------------------------------------------------------------------------
function registerLifecycleCleanupHooks() {
  const cleanup = () => {
    try {
      if (IS_OBSERVING) {
        IS_OBSERVING = false;
        accessibilitySensor.stopSensorDaemon();
      }
    } catch (_) {}
  };

  if (app && typeof app.on === 'function') {
    app.on('will-quit', cleanup);
    app.on('before-quit', cleanup);
  }
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ---------------------------------------------------------------------------
// 9. EXTENSION ENTRYPOINT (init)
// ---------------------------------------------------------------------------
function init(ctx) {
  CTX = ctx;

  // Verify Rule 2 Fail-Closed storage & initialize sub-engines
  core0.verifyFailClosedStorage(ctx);
  memoryAndSftManager.loadMemory();
  bm25RagEngine.rebuildBM25Index();
  installUnifiedMasterPipeline();
  registerLifecycleCleanupHooks();

  // Register unified cross-kernel service API
  ctx.registerService('adaptive_intelligence', {
    // Memory & Persona APIs
    getProfile: () => memoryAndSftManager.loadMemory().profile,
    getPreferences: () => memoryAndSftManager.loadMemory().prefs,
    recordFeedback: (type, detail) => memoryAndSftManager.recordPreferenceFeedback(type, detail),
    recordEpisode: (type, summary, meta) => memoryAndSftManager.recordEpisodicEvent(type, summary, meta),
    appendSftPair: (q, a) => memoryAndSftManager.appendValidatedSftTurn(q, a),

    // BM25 RAG APIs
    searchKnowledge: (query, k = 3) => bm25RagEngine.retrieveTopK(query, k),
    rebuildRagIndex: () => bm25RagEngine.rebuildBM25Index(),

    // Windows Credential Vault APIs
    storeVaultSecret: (key, user, pass) => core0.credentialVault.storeSecret(key, user, pass),
    retrieveVaultSecret: (key) => core0.credentialVault.retrieveSecret(key),
    listVaultTargets: () => core0.credentialVault.listRegisteredTargets(),

    // Surrogate Apprentice & Swarm APIs
    isObserving: () => IS_OBSERVING,
    startLearning: startSurrogateApprenticeSession,
    stopLearning: stopAndCompileSurrogateSession,
    executeWorkflow: executeSurrogateWorkflowByQuery,
    listLearnedTools: () => hudCompiler.listCompiledSurrogateTools(),
    crawlActiveWindowTree: () => accessibilitySensor.crawlFullWindowInteractiveMap(),
    executeSingleUiStep: (step, opts) => actionReplayer.executeStep(step, opts),

    // HUD Status Dot APIs
    updateHudDot: (state, label, metrics) => hudCompiler.updateHudDotState(state, label, metrics),
    setMinimalDotMode: (minimized) => hudCompiler.setMinimalDotMode(minimized),
    getRuntimeMetrics: () => ({ ...RUNTIME_METRICS }),
  });

  // Expose live state to JARVIS system telemetry
  ctx.addStateContributor('adaptive_engine', () => ({
    version: '2.5.0-enterprise',
    status: 'ACTIVE',
    observing: IS_OBSERVING,
    executing_surrogate: IS_EXECUTING_SURROGATE,
    active_session: ACTIVE_SESSION?.id || null,
    buffered_events: RAW_EVENT_BUFFER.length,
    compiled_tools_count: hudCompiler.listCompiledSurrogateTools().length,
    vault_targets_count: core0.credentialVault.listRegisteredTargets().length,
    metrics: RUNTIME_METRICS,
    files: {
      sft_dataset: SFT_DATASET_FILE,
      domain_primer_dir: DOMAIN_PRIMER_DIR,
      tools_manifest: MANIFEST_FILE,
      telemetry_log: TELEMETRY_LOG_FILE,
    },
  }));

  ctx.audit('info', 'kernel_9_master_orchestrator_initialized', {
    version: '2.5.0-enterprise',
    sub_engines_loaded: [
      'kernel_9_adaptive_intelligence_0.js',
      'kernel_9_adaptive_intelligence_1.js',
      'kernel_9_adaptive_intelligence_2.js',
      'kernel_9_adaptive_intelligence_3.js',
      'kernel_9_adaptive_intelligence_4.js',
      'kernel_9_adaptive_intelligence_5.js',
    ],
    security_rules_enforced: [1, 2, 3, 4, 5],
  });
}

module.exports = {
  name: 'adaptive_intelligence',
  init,
};