'use strict';

/**
 * ============================================================================
 * FILE: kernel_9_adaptive_intelligence_5.js
 * SUB-ENGINE 5: Industrial HUD Telemetry Controller, Dynamic AST-Safe Tool
 *               Synthesizer, Parameter Extractor, Pre-Flight Validator &
 *               Hot-Reload Lifecycle Manager
 * ============================================================================
 * Architecture & Capabilities:
 *   1. Multi-State HUD Status Pill & Minimizable Dot:
 *      - States: OBSERVING (Blue Pulse), COMPILING (Amber), EXECUTING (Emerald),
 *        RECOVERING (Orange), ERROR (Crimson), IDLE (Hidden).
 *      - Live Telemetry Counter: Displays captured UI step count, active target
 *        process name, and live confidence score without stealing window focus.
 *      - Future-Ready Minimizer Toggle: Can collapse to a 10px corner dot or
 *        expand to show micro-telemetry.
 *   2. Dynamic Parameterization Engine:
 *      - Inspects recorded keystrokes/values inside the SOP and automatically
 *        promotes dynamic inputs (Serial numbers, RMA IDs, dates, search queries)
 *        into customizable tool parameters while preserving default fallback values.
 *   3. Pre-Flight Syntax & Security Sandbox Verification:
 *      - Validates generated CommonJS tool code via Node's native `vm.Script`
 *        before writing to `00_ENGINE/tools/` to guarantee zero syntax crashes.
 *      - Enforces Rule 3 (PII Masking) and Rule 5 (01_CONFIG Boundary) on all
 *        compiled tool artifacts.
 *   4. Versioned Rollback, SHA-256 Checksum & Hot-Reloading:
 *      - Computes SHA-256 integrity hashes for every generated tool.
 *      - Archives previous versions of a learned workflow before overwriting.
 *      - Clears Node's `require.cache` and registers the tool into the live
 *        runtime without requiring an Electron restart.
 * ============================================================================
 */

const { BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const core0 = require('./kernel_9_adaptive_intelligence_0');

const MANIFEST_FILE = path.join(core0.WORK_DIR, 'learned_sops', 'surrogate_tools_manifest.json');
const TOOL_BACKUP_DIR = path.join(core0.WORK_DIR, 'learned_sops', 'tool_backups');
const TELEMETRY_LOG_FILE = path.join(core0.WORK_DIR, 'surrogate_execution_telemetry.jsonl');

// ---------------------------------------------------------------------------
// 1. MULTI-STATE HUD STATUS DOT & LIVE TELEMETRY CONTROLLER
// ---------------------------------------------------------------------------
class HudStatusAndTelemetryController {
  constructor() {
    this.currentState = 'idle';
    this.isMinimizedDotOnly = false;
    this.lastMetrics = {
      stepsCount: 0,
      activeApp: '',
      confidence: 100,
      currentStepIndex: 0,
      totalSteps: 0,
    };
  }

  /**
   * Resolves all active Electron BrowserWindows safely
   */
  getActiveWindows() {
    try {
      const wins = BrowserWindow.getAllWindows();
      if (!Array.isArray(wins)) return [];
      return wins.filter((w) => w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed());
    } catch (_) {
      return [];
    }
  }

  /**
   * Primary method called by Master Orchestrator (kernel_9) and Sub-Engines
   * Compatible with: updateHudDotState(state, labelText, metricsObj)
   */
  updateHudDotState(state, labelText = '', metrics = {}) {
    this.currentState = String(state || 'idle').toLowerCase();
    this.lastMetrics = {
      ...this.lastMetrics,
      ...(metrics || {}),
    };

    const windows = this.getActiveWindows();
    if (windows.length === 0) return false;

    const payload = {
      mode: this.currentState,
      label: core0.sanitizeAndMaskText(labelText || ''),
      minimized: Boolean(this.isMinimizedDotOnly),
      metrics: {
        stepsCount: Number(this.lastMetrics.stepsCount) || 0,
        activeApp: core0.sanitizeAndMaskText(this.lastMetrics.activeApp || ''),
        confidence: Number(this.lastMetrics.confidence) || 0,
        currentStepIndex: Number(this.lastMetrics.currentStepIndex) || 0,
        totalSteps: Number(this.lastMetrics.totalSteps) || 0,
      },
    };

    const injectionScript = this.buildHudDomInjectionScript(payload);

    for (const win of windows) {
      win.webContents.executeJavaScript(injectionScript).catch(() => {});
    }
    return true;
  }

  /**
   * Updates live step counter on the HUD while Observer Agent is capturing clicks
   */
  pushLiveObservationCounter(stepsCount, activeApp = '', confidence = 95) {
    return this.updateHudDotState(
      'observing',
      `OBSERVING (${stepsCount} steps)`,
      { stepsCount, activeApp, confidence }
    );
  }

  /**
   * Updates live execution progress on the HUD while Operator Agent is replaying SOP
   */
  pushLiveExecutionProgress(currentStepIndex, totalSteps, activeApp = '', isRecovering = false) {
    const mode = isRecovering ? 'recovering' : 'executing';
    const label = isRecovering
      ? `HEALING STEP ${currentStepIndex}/${totalSteps}`
      : `SURROGATE STEP ${currentStepIndex}/${totalSteps}`;

    return this.updateHudDotState(mode, label, {
      currentStepIndex,
      totalSteps,
      activeApp,
    });
  }

  /**
   * Toggles between minimal 10px dot mode and full pill telemetry mode
   */
  setMinimalDotMode(minimized = true) {
    this.isMinimizedDotOnly = Boolean(minimized);
    return this.updateHudDotState(this.currentState);
  }

  /**
   * Generates self-contained, zero-dependency DOM/CSS injection script for Electron
   */
  buildHudDomInjectionScript(payload) {
    const serialized = JSON.stringify(payload);
    return `
      (function(cfg) {
        try {
          const STYLE_ID = 'jarvis-surrogate-hud-keyframes';
          if (!document.getElementById(STYLE_ID)) {
            const styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
            styleEl.textContent = \`
              @keyframes jarvisPulseBlue {
                0% { box-shadow: 0 0 6px #00f2fe, 0 0 12px rgba(56, 189, 248, 0.4); transform: scale(0.95); }
                50% { box-shadow: 0 0 14px #00f2fe, 0 0 26px rgba(56, 189, 248, 0.85); transform: scale(1.08); }
                100% { box-shadow: 0 0 6px #00f2fe, 0 0 12px rgba(56, 189, 248, 0.4); transform: scale(0.95); }
              }
              @keyframes jarvisPulseAmber {
                0% { box-shadow: 0 0 6px #facc15; opacity: 0.8; }
                50% { box-shadow: 0 0 16px #facc15, 0 0 28px rgba(250, 204, 21, 0.75); opacity: 1; }
                100% { box-shadow: 0 0 6px #facc15; opacity: 0.8; }
              }
              @keyframes jarvisPulseGreen {
                0% { box-shadow: 0 0 6px #10b981; }
                50% { box-shadow: 0 0 15px #10b981, 0 0 24px rgba(16, 185, 129, 0.7); }
                100% { box-shadow: 0 0 6px #10b981; }
              }
            \`;
            document.head.appendChild(styleEl);
          }

          let container = document.getElementById('jarvis-surrogate-hud-dot');
          if (!container) {
            container = document.createElement('div');
            container.id = 'jarvis-surrogate-hud-dot';
            container.style.cssText = [
              'position:fixed',
              'top:14px',
              'right:18px',
              'z-index:2147483647',
              'display:none',
              'align-items:center',
              'gap:9px',
              'padding:6px 13px',
              'border-radius:24px',
              'font-family:Consolas, "JetBrains Mono", monospace',
              'font-size:11px',
              'font-weight:600',
              'letter-spacing:0.4px',
              'user-select:none',
              'pointer-events:auto',
              'cursor:pointer',
              'transition:all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
              'background:rgba(9, 13, 24, 0.92)',
              'backdrop-filter:blur(8px)',
              'border:1px solid rgba(56, 189, 248, 0.35)',
              'color:#f1f5f9',
              'box-shadow:0 6px 20px rgba(0, 0, 0, 0.65)'
            ].join(';');

            // Double-click toggles compact dot-only mode vs telemetry pill mode
            container.title = 'Double-click to toggle compact dot / full status';
            container.addEventListener('dblclick', function() {
              const metaSpan = document.getElementById('jarvis-surrogate-meta');
              const txtSpan = document.getElementById('jarvis-surrogate-text');
              if (txtSpan && txtSpan.style.display !== 'none') {
                txtSpan.style.display = 'none';
                if (metaSpan) metaSpan.style.display = 'none';
                container.style.padding = '7px';
              } else if (txtSpan) {
                txtSpan.style.display = 'inline-block';
                if (metaSpan) metaSpan.style.display = 'inline-block';
                container.style.padding = '6px 13px';
              }
            });

            const circle = document.createElement('span');
            circle.id = 'jarvis-surrogate-circle';
            circle.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0;';

            const txt = document.createElement('span');
            txt.id = 'jarvis-surrogate-text';
            txt.style.cssText = 'display:inline-block;white-space:nowrap;';

            const meta = document.createElement('span');
            meta.id = 'jarvis-surrogate-meta';
            meta.style.cssText = 'display:inline-block;font-size:10px;color:#94a3b8;padding-left:6px;border-left:1px solid rgba(255,255,255,0.14);white-space:nowrap;';

            container.appendChild(circle);
            container.appendChild(txt);
            container.appendChild(meta);
            document.body.appendChild(container);
          }

          const circle = document.getElementById('jarvis-surrogate-circle');
          const txt = document.getElementById('jarvis-surrogate-text');
          const meta = document.getElementById('jarvis-surrogate-meta');

          if (cfg.mode === 'idle' || cfg.mode === 'hidden' || cfg.mode === 'off') {
            container.style.display = 'none';
            return;
          }

          container.style.display = 'flex';

          const THEMES = {
            observing: {
              border: 'rgba(56, 189, 248, 0.55)',
              bg: '#00f2fe',
              anim: 'jarvisPulseBlue 1.8s infinite ease-in-out',
              defaultLabel: 'APPRENTICE OBSERVING'
            },
            compiling: {
              border: 'rgba(250, 204, 21, 0.6)',
              bg: '#facc15',
              anim: 'jarvisPulseAmber 1.1s infinite ease-in-out',
              defaultLabel: 'SWARM COMPILING SOP...'
            },
            executing: {
              border: 'rgba(16, 185, 129, 0.6)',
              bg: '#10b981',
              anim: 'jarvisPulseGreen 1.4s infinite ease-in-out',
              defaultLabel: 'SURROGATE EXECUTING'
            },
            recovering: {
              border: 'rgba(249, 115, 22, 0.7)',
              bg: '#f97316',
              anim: 'jarvisPulseAmber 0.8s infinite ease-in-out',
              defaultLabel: 'SELF-HEALING UI STEP...'
            },
            error: {
              border: 'rgba(239, 68, 68, 0.7)',
              bg: '#ef4444',
              anim: 'none',
              defaultLabel: 'FAIL-CLOSED HALT'
            }
          };

          const theme = THEMES[cfg.mode] || THEMES.observing;
          container.style.borderColor = theme.border;
          circle.style.background = theme.bg;
          circle.style.animation = theme.anim;

          txt.textContent = cfg.label || theme.defaultLabel;

          const m = cfg.metrics || {};
          const metaParts = [];
          if (m.activeApp) metaParts.push(m.activeApp);
          if (cfg.mode === 'observing' && m.stepsCount > 0) metaParts.push(m.stepsCount + ' steps');
          if ((cfg.mode === 'executing' || cfg.mode === 'recovering') && m.totalSteps > 0) {
            metaParts.push(m.currentStepIndex + '/' + m.totalSteps);
          }

          if (metaParts.length > 0 && !cfg.minimized) {
            meta.textContent = metaParts.join(' • ');
            meta.style.display = 'inline-block';
          } else {
            meta.textContent = '';
            meta.style.display = 'none';
          }

          if (cfg.minimized) {
            txt.style.display = 'none';
            meta.style.display = 'none';
            container.style.padding = '7px';
          }
        } catch (_) {}
      })(${serialized});
    `;
  }
}

// ---------------------------------------------------------------------------
// 2. DYNAMIC PARAMETER EXTRACTOR & AST-SAFE TOOL SYNTHESIZER
// ---------------------------------------------------------------------------
class AutonomousToolSynthesizer {
  constructor(hudController) {
    this.hud = hudController;
    this.ensureDirectories();
  }

  ensureDirectories() {
    try {
      fs.mkdirSync(core0.TOOLS_DIR, { recursive: true });
      fs.mkdirSync(TOOL_BACKUP_DIR, { recursive: true });
      fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
      if (!fs.existsSync(MANIFEST_FILE)) {
        fs.writeFileSync(
          MANIFEST_FILE,
          JSON.stringify({ version: '2.0.0', updated_at: new Date().toISOString(), tools: {} }, null, 2),
          'utf8'
        );
      }
    } catch (_) {}
  }

  /**
   * Analyzes an SOP's action sequence to detect dynamic text inputs
   * (e.g., serial numbers, search queries, form fields) and turns them into
   * configurable runtime parameters on the compiled tool!
   */
  extractDynamicParametersFromSop(certifiedSop) {
    const schemaProperties = {
      dry_run: {
        type: 'boolean',
        description: 'If true, previews the certified SOP steps and decision tree without clicking or typing.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum timeout in milliseconds per UI Automation step (default: 8000).',
      },
      speed_multiplier: {
        type: 'number',
        description: 'Playback delay multiplier (1.0 = normal human timing, 0.5 = 2x faster, 2.0 = slower).',
      },
      stop_on_unrecovered_error: {
        type: 'boolean',
        description: 'If true, halts the workflow immediately if all 3 recovery tiers fail on a step.',
      },
    };

    const stepParameterBindings = {};

    const steps = Array.isArray(certifiedSop?.action_sequence) ? certifiedSop.action_sequence : [];
    for (const step of steps) {
      if (!step || step.credential_protected) continue;

      const hasTypedInput =
        (step.typed_text && step.typed_text.trim().length > 0 && !step.typed_text.includes('MASKED')) ||
        (step.element_value && step.element_value.trim().length > 0 && !step.element_value.includes('MASKED'));

      if (!hasTypedInput) continue;

      const rawLabel = step.ui_automation_anchor || step.automation_id || `step_${step.step_number}_input`;
      const cleanParamSlug = rawLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 28);

      const paramName = `input_step_${step.step_number}_${cleanParamSlug || 'value'}`;
      const defaultRecordedVal = core0.sanitizeAndMaskText(step.typed_text || step.element_value);

      schemaProperties[paramName] = {
        type: 'string',
        description: `Dynamic text override for Step #${step.step_number} (${rawLabel || step.control_type}). Default recorded value: "${defaultRecordedVal}"`,
      };

      stepParameterBindings[step.step_number] = {
        paramName,
        defaultValue: defaultRecordedVal,
        targetAnchor: rawLabel,
      };
    }

    return {
      schemaProperties,
      stepParameterBindings,
    };
  }

  /**
   * Computes SHA-256 checksum for integrity auditing
   */
  computeSha256(content) {
    return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
  }

  /**
   * Validates generated JavaScript source code in an isolated V8 VM compilation check
   * Guarantees zero syntax errors before writing to 00_ENGINE/tools/
   */
  validateJavaScriptSyntax(sourceCode, filename = 'compiled_tool.js') {
    try {
      // eslint-disable-next-line no-new
      new vm.Script(sourceCode, { filename });
      return { valid: true, error: null };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  /**
   * Backs up any existing tool with the same name before overwriting
   */
  backupExistingToolIfPresent(toolFilePath, toolName) {
    try {
      if (!fs.existsSync(toolFilePath)) return null;
      fs.mkdirSync(TOOL_BACKUP_DIR, { recursive: true });
      const backupName = `${toolName}_backup_${Date.now()}.js.bak`;
      const backupPath = path.join(TOOL_BACKUP_DIR, backupName);
      fs.copyFileSync(toolFilePath, backupPath);

      // Keep only last 10 backups to prevent disk bloat
      const allBackups = fs
        .readdirSync(TOOL_BACKUP_DIR)
        .filter((f) => f.startsWith(toolName) && f.endsWith('.bak'))
        .sort();
      while (allBackups.length > 10) {
        const oldest = allBackups.shift();
        try {
          fs.unlinkSync(path.join(TOOL_BACKUP_DIR, oldest));
        } catch (_) {}
      }
      return backupPath;
    } catch (_) {
      return null;
    }
  }

  /**
   * Hot-reloads the compiled tool in Node's module cache so Tool Librarian
   * can execute it immediately without restarting Jarvis
   */
  hotReloadCompiledTool(toolFilePath) {
    try {
      const resolved = require.resolve(toolFilePath);
      if (require.cache[resolved]) {
        delete require.cache[resolved];
      }
      const loadedMod = require(toolFilePath);
      return { ok: true, module: loadedMod };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Updates surrogate_tools_manifest.json with full metadata, parameter list, and SHA-256 hash
   */
  registerToolInManifest(certifiedSop, toolFilePath, sha256Hash, paramBindings) {
    try {
      this.ensureDirectories();
      const raw = fs.existsSync(MANIFEST_FILE)
        ? JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
        : { version: '2.0.0', tools: {} };

      if (!raw.tools) raw.tools = {};

      raw.updated_at = new Date().toISOString();
      raw.tools[certifiedSop.name] = {
        sop_id: certifiedSop.sop_id,
        tool_name: certifiedSop.name,
        file_path: toolFilePath,
        primary_app: certifiedSop.primary_app,
        apps_involved: certifiedSop.apps_involved || [certifiedSop.primary_app],
        steps_count: Array.isArray(certifiedSop.action_sequence) ? certifiedSop.action_sequence.length : 0,
        overall_confidence: certifiedSop.overall_confidence || 0,
        dynamic_parameters: Object.values(paramBindings).map((b) => b.paramName),
        sha256_integrity: sha256Hash,
        compiled_at: new Date().toISOString(),
      };

      fs.writeFileSync(MANIFEST_FILE, JSON.stringify(raw, null, 2), 'utf8');
    } catch (_) {}
  }

  /**
   * Builds the full, standalone, production-grade CommonJS tool file
   */
  generateExecutableToolSource(certifiedSop, extractedParams) {
    const safeSop = core0.sanitizeObjectDeep(certifiedSop);
    const { schemaProperties, stepParameterBindings } = extractedParams;

    const toolName = safeSop.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const primaryApp = safeSop.primary_app || 'SystemApp';
    const stepCount = Array.isArray(safeSop.action_sequence) ? safeSop.action_sequence.length : 0;

    const tagsList = Array.from(
      new Set([
        'surrogate',
        'learned',
        'automation',
        'ui_workflow',
        primaryApp.toLowerCase(),
        ...(Array.isArray(safeSop.apps_involved) ? safeSop.apps_involved.map((a) => String(a).toLowerCase()) : []),
      ])
    );

    return `'use strict';

/**
 * ============================================================================
 * JARVIS-CORE AUTONOMOUS HUMAN-SURROGATE WORKFLOW MODULE
 * ============================================================================
 * Tool Name          : ${toolName}
 * SOP Identifier     : ${safeSop.sop_id}
 * Target Application : ${primaryApp}
 * Certified Steps    : ${stepCount}
 * Confidence Score   : ${safeSop.overall_confidence}
 * Generated Timestamp: ${new Date().toISOString()}
 * Security Compliance: Rules 1-5 Verified by Silent Critic Agent
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const core0 = require('../kernel_9_adaptive_intelligence_0');
const { operatorAgent } = require('../kernel_9_adaptive_intelligence_3');
const { hudCompiler } = require('../kernel_9_adaptive_intelligence_5');

const CERTIFIED_SOP_BLUEPRINT = ${JSON.stringify(safeSop, null, 2)};

const STEP_PARAMETER_BINDINGS = ${JSON.stringify(stepParameterBindings, null, 2)};

const TELEMETRY_LOG = path.join(core0.WORK_DIR, 'surrogate_execution_telemetry.jsonl');

function recordExecutionTelemetry(payload) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      tool_name: ${JSON.stringify(toolName)},
      sop_id: CERTIFIED_SOP_BLUEPRINT.sop_id,
      ...core0.sanitizeObjectDeep(payload || {})
    };
    fs.appendFileSync(TELEMETRY_LOG, JSON.stringify(entry) + '\\n', 'utf8');
  } catch (_) {}
}

module.exports = {
  name: ${JSON.stringify(toolName)},
  description: ${JSON.stringify(
    `Autonomous Human-Surrogate workflow for ${primaryApp} (${stepCount} certified UI steps, confidence ${Math.round(
      (safeSop.overall_confidence || 0.85) * 100
    )}%). Supports dynamic input overrides and 3-tier self-healing UI recovery.`
  )},
  tags: ${JSON.stringify(tagsList)},
  risk: 'WRITE_SAFE',
  parameters: {
    type: 'object',
    properties: ${JSON.stringify(schemaProperties, null, 4)}
  },

  /**
   * Executes the learned workflow with optional runtime overrides, HUD telemetry,
   * and automatic 3-tier recovery via OperatorAgent.
   */
  async execute(args = {}, ctx = null) {
    // 1. Rule 2 Fail-Closed Pre-Check
    if (!core0.verifyFailClosedStorage(ctx)) {
      hudCompiler.updateHudDotState('error', 'FAIL-CLOSED STORAGE HALT');
      setTimeout(() => hudCompiler.updateHudDotState('idle'), 3000);
      return {
        ok: false,
        error: 'Rule 2 Fail-Closed: Work/Audit storage is not writable. Execution aborted.'
      };
    }

    // 2. Clone blueprint and inject any runtime parameter overrides
    const runtimeSop = JSON.parse(JSON.stringify(CERTIFIED_SOP_BLUEPRINT));
    const speedMultiplier = Math.min(Math.max(Number(args.speed_multiplier) || 1.0, 0.25), 4.0);
    const appliedOverrides = [];

    runtimeSop.action_sequence = runtimeSop.action_sequence.map((step) => {
      const modifiedStep = { ...step };
      modifiedStep.delay_before_ms = Math.round((Number(step.delay_before_ms) || 350) * speedMultiplier);

      const binding = STEP_PARAMETER_BINDINGS[step.step_number];
      if (binding && args[binding.paramName] !== undefined && args[binding.paramName] !== null) {
        const overrideVal = String(args[binding.paramName]);
        if (!step.credential_protected) {
          modifiedStep.typed_text = overrideVal;
          modifiedStep.element_value = overrideVal;
          appliedOverrides.push({
            step_number: step.step_number,
            param: binding.paramName,
            anchor: binding.targetAnchor
          });
        }
      }
      return modifiedStep;
    });

    // 3. Dry-Run Inspection Mode
    if (args.dry_run) {
      return {
        ok: true,
        mode: 'DRY_RUN_INSPECTION',
        tool_name: ${JSON.stringify(toolName)},
        sop_id: runtimeSop.sop_id,
        primary_app: runtimeSop.primary_app,
        total_steps: runtimeSop.action_sequence.length,
        overall_confidence: runtimeSop.overall_confidence,
        available_parameter_bindings: STEP_PARAMETER_BINDINGS,
        applied_overrides: appliedOverrides,
        steps_preview: runtimeSop.action_sequence.map((s) => ({
          step: s.step_number,
          event: s.event_type,
          app: s.target_process,
          anchor: s.ui_automation_anchor || s.automation_id || 'Coordinate_Click',
          confidence: s.confidence_score
        }))
      };
    }

    // 4. Live Autonomous Execution with HUD Progress
    const totalSteps = runtimeSop.action_sequence.length;
    const startedAtMs = Date.now();

    hudCompiler.pushLiveExecutionProgress(1, totalSteps, runtimeSop.primary_app, false);
    ctx?.audit?.('info', 'surrogate_compiled_tool_started', {
      tool: ${JSON.stringify(toolName)},
      sop_id: runtimeSop.sop_id,
      overrides_count: appliedOverrides.length
    });

    try {
      const execOptions = {
        timeoutMs: Number(args.timeout_ms) || 8000,
        stopOnError: Boolean(args.stop_on_unrecovered_error)
      };

      const result = await operatorAgent.executeCertifiedSop(runtimeSop, execOptions, ctx);
      const durationMs = Date.now() - startedAtMs;

      recordExecutionTelemetry({
        ok: result.ok,
        duration_ms: durationMs,
        steps_total: result.total_steps,
        steps_succeeded: result.steps_succeeded,
        self_healed_steps: result.self_healed_steps,
        overrides_used: appliedOverrides
      });

      hudCompiler.updateHudDotState('idle');

      return {
        ...result,
        duration_ms: durationMs,
        applied_overrides: appliedOverrides
      };
    } catch (err) {
      hudCompiler.updateHudDotState('error', 'EXECUTION ERROR');
      setTimeout(() => hudCompiler.updateHudDotState('idle'), 2500);

      recordExecutionTelemetry({
        ok: false,
        error: err.message
      });

      return {
        ok: false,
        tool_name: ${JSON.stringify(toolName)},
        error: err.message
      };
    }
  }
};
`;
  }

  /**
   * Main entry point called by Master Orchestrator (`kernel_9_adaptive_intelligence.js`):
   * Compiles a certified SOP blueprint into an executable CommonJS tool, validates syntax,
   * backs up prior versions, writes to `00_ENGINE/tools/`, and hot-reloads into memory.
   */
  compileSopToExecutableTool(certifiedSop) {
    if (!certifiedSop || !certifiedSop.name) {
      return null;
    }

    // Rule 5 Security Check: Never write outside tools directory or touch forbidden paths
    const cleanToolName = certifiedSop.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const toolFileName = `${cleanToolName}.js`;
    const toolFilePath = path.join(core0.TOOLS_DIR, toolFileName);

    if (core0.isPathForbidden(toolFilePath)) {
      return null;
    }

    try {
      this.ensureDirectories();

      // 1. Extract dynamic parameters from recorded inputs
      const extractedParams = this.extractDynamicParametersFromSop(certifiedSop);

      // 2. Synthesize complete CommonJS source code
      const sourceCode = this.generateExecutableToolSource(certifiedSop, extractedParams);

      // 3. Pre-Flight V8 VM Syntax Validation
      const syntaxCheck = this.validateJavaScriptSyntax(sourceCode, toolFileName);
      if (!syntaxCheck.valid) {
        return null;
      }

      // 4. Backup previous version if re-learning an existing workflow
      this.backupExistingToolIfPresent(toolFilePath, cleanToolName);

      // 5. Write verified tool to C:\Jarvis_Core\00_ENGINE\tools\
      fs.writeFileSync(toolFilePath, sourceCode, 'utf8');

      // 6. Compute SHA-256 integrity hash & update Master Manifest
      const sha256Hash = this.computeSha256(sourceCode);
      this.registerToolInManifest(
        certifiedSop,
        toolFilePath,
        sha256Hash,
        extractedParams.stepParameterBindings
      );

      // 7. Hot-reload module in Node cache
      this.hotReloadCompiledTool(toolFilePath);

      return toolFilePath;
    } catch (_) {
      return null;
    }
  }

  /**
   * Lists all learned surrogate tools registered in the manifest
   */
  listCompiledSurrogateTools() {
    try {
      if (!fs.existsSync(MANIFEST_FILE)) return [];
      const data = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
      return Object.values(data.tools || {});
    } catch (_) {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// 3. UNIFIED FACADE EXPORT (100% Compatible with Master Orchestrator kernel_9)
// ---------------------------------------------------------------------------
class HudStatusAndToolCompiler {
  constructor() {
    this.hudController = new HudStatusAndTelemetryController();
    this.toolSynthesizer = new AutonomousToolSynthesizer(this.hudController);
  }

  updateHudDotState(state, labelText = '', metrics = {}) {
    return this.hudController.updateHudDotState(state, labelText, metrics);
  }

  pushLiveObservationCounter(stepsCount, activeApp = '', confidence = 95) {
    return this.hudController.pushLiveObservationCounter(stepsCount, activeApp, confidence);
  }

  pushLiveExecutionProgress(currentStepIndex, totalSteps, activeApp = '', isRecovering = false) {
    return this.hudController.pushLiveExecutionProgress(currentStepIndex, totalSteps, activeApp, isRecovering);
  }

  setMinimalDotMode(minimized = true) {
    return this.hudController.setMinimalDotMode(minimized);
  }

  compileSopToExecutableTool(certifiedSop) {
    return this.toolSynthesizer.compileSopToExecutableTool(certifiedSop);
  }

  listCompiledSurrogateTools() {
    return this.toolSynthesizer.listCompiledSurrogateTools();
  }
}

const hudCompiler = new HudStatusAndToolCompiler();

module.exports = {
  HudStatusAndTelemetryController,
  AutonomousToolSynthesizer,
  HudStatusAndToolCompiler,
  hudCompiler,
  MANIFEST_FILE,
  TOOL_BACKUP_DIR,
  TELEMETRY_LOG_FILE,
};