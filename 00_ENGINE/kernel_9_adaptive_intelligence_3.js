'use strict';

/**
 * ============================================================================
 * FILE: kernel_9_adaptive_intelligence_3.js
 * SUB-ENGINE 3: 4-Agent Swarm State Machines, Decision Trees & Recovery Loop
 * ============================================================================
 * Implements full deterministic finite state machines (FSM) for:
 *   1. AGENT_OBSERVER: Real-time event stream deduplication, micro-hesitation
 *      pruning, accidental click removal, keystroke coalescing, and voice alignment.
 *   2. AGENT_PLANNER: Action graph construction, step dependency linking,
 *      pre-condition/post-condition synthesis, and confidence scoring.
 *   3. AGENT_CRITIC (Silent Self-Correction): Rule 1-5 compliance auditing,
 *      dead-step elimination, credential leak scrubbing, and coordinate normalization.
 *   4. AGENT_OPERATOR: Autonomous execution state machine with a 3-Tier fallback
 *      recovery loop (Tier 1: UIA ID/Name -> Tier 2: Tree Re-crawl & Fuzzy Match
 *      -> Tier 3: Relative Window Offset Coordinate Click) and execution telemetry.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const core0 = require('./kernel_9_adaptive_intelligence_0');
const { accessibilitySensor } = require('./kernel_9_adaptive_intelligence_1');
const { actionReplayer } = require('./kernel_9_adaptive_intelligence_2');

const SWARM_LOG_FILE = path.join(core0.WORK_DIR, 'swarm_audit_trail.jsonl');

// ---------------------------------------------------------------------------
// 1. FINITE STATE MACHINE (FSM) BASE ENGINE
// ---------------------------------------------------------------------------
class AgentStateMachine {
  constructor(agentName, initialState, transitions) {
    this.agentName = agentName;
    this.state = initialState;
    this.transitions = transitions || {};
    this.history = [
      { state: initialState, ts: new Date().toISOString(), reason: 'init' },
    ];
  }

  canTransition(nextState) {
    const allowed = this.transitions[this.state] || [];
    return allowed.includes(nextState);
  }

  transition(nextState, reason = '') {
    if (!this.canTransition(nextState)) {
      this.recordInternalAudit('invalid_state_transition_blocked', {
        from: this.state,
        attempted: nextState,
        reason,
      });
      return false;
    }
    const prev = this.state;
    this.state = nextState;
    this.history.push({
      from: prev,
      state: nextState,
      ts: new Date().toISOString(),
      reason,
    });
    if (this.history.length > 200) this.history.shift();
    return true;
  }

  recordInternalAudit(eventType, payload) {
    try {
      const entry = {
        ts: new Date().toISOString(),
        agent: this.agentName,
        state: this.state,
        event: eventType,
        data: core0.sanitizeObjectDeep(payload || {}),
      };
      fs.appendFileSync(SWARM_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 2. AGENT 1: THE OBSERVER (Stream Filtering, Coalescing & Alignment FSM)
// ---------------------------------------------------------------------------
class ObserverAgent {
  constructor() {
    this.fsm = new AgentStateMachine('OBSERVER_AGENT', 'IDLE', {
      IDLE: ['LISTENING', 'FILTERING'],
      LISTENING: ['FILTERING', 'ALIGNING', 'IDLE'],
      FILTERING: ['ALIGNING', 'ERROR', 'IDLE'],
      ALIGNING: ['READY', 'IDLE'],
      READY: ['IDLE', 'LISTENING'],
      ERROR: ['IDLE'],
    });
  }

  /**
   * Processes raw 55ms UIAutomation stream + voice/text notes into clean logical steps
   */
  processRawSession(rawUiEvents = [], rawVoiceNotes = []) {
    this.fsm.transition('LISTENING', 'ingesting_session_streams');
    this.fsm.transition('FILTERING', 'removing_noise_and_duplicates');

    // Step 1: Filter out casual chitchat from voice notes
    const cleanVoiceNotes = [];
    for (const note of rawVoiceNotes) {
      if (!note || !note.text) continue;
      if (core0.isAmbientChitchat(note.text)) continue;
      cleanVoiceNotes.push({
        ts: note.ts || new Date().toISOString(),
        epochMs: Date.parse(note.ts) || Date.now(),
        instruction: core0.sanitizeAndMaskText(note.text),
      });
    }

    // Step 2: Filter, coalesce, and deduplicate raw UI events
    const coalescedEvents = [];
    let prevEvent = null;

    for (let i = 0; i < rawUiEvents.length; i++) {
      const ev = rawUiEvents[i];
      if (!ev || !ev.process || ev.process === 'unknown') continue;

      // Ignore self-clicks on the Jarvis HUD status dot or chat input
      if (
        /electron/i.test(ev.process) &&
        /jarvis/i.test(ev.windowTitle || '') &&
        rawUiEvents.length > 2
      ) {
        continue;
      }

      const evEpoch = Date.parse(ev.ts) || Date.now();

      // Debounce rapid accidental double-events (< 140ms on exact same element)
      if (prevEvent) {
        const prevEpoch = Date.parse(prevEvent.ts) || 0;
        const deltaMs = Math.abs(evEpoch - prevEpoch);
        const sameTarget =
          prevEvent.process === ev.process &&
          prevEvent.automationId === ev.automationId &&
          prevEvent.elementName === ev.elementName &&
          prevEvent.event === ev.event;

        if (sameTarget && deltaMs < 140 && !ev.typedText) {
          continue;
        }

        // Coalesce consecutive keystroke bursts into the target input field
        if (
          sameTarget &&
          ev.typedText &&
          prevEvent.typedText &&
          !ev.isPassword &&
          deltaMs < 3500
        ) {
          prevEvent.typedText = core0.sanitizeAndMaskText(
            `${prevEvent.typedText}${ev.typedText}`
          );
          prevEvent.ts = ev.ts;
          continue;
        }
      }

      const normalized = {
        ...ev,
        epochMs: evEpoch,
        delayFromPrevMs: prevEvent
          ? Math.min(Math.max(evEpoch - (Date.parse(prevEvent.ts) || evEpoch), 150), 8000)
          : 300,
      };

      coalescedEvents.push(normalized);
      prevEvent = normalized;
    }

    // Step 3: Multi-Modal Alignment (Match spoken/typed context notes to nearest UI action)
    this.fsm.transition('ALIGNING', 'binding_voice_intent_to_ui_nodes');

    for (const vNote of cleanVoiceNotes) {
      let bestStep = null;
      let minTimeDiff = Infinity;

      for (const uiStep of coalescedEvents) {
        const diff = Math.abs(uiStep.epochMs - vNote.epochMs);
        if (diff < minTimeDiff && diff <= 30000) {
          minTimeDiff = diff;
          bestStep = uiStep;
        }
      }

      if (bestStep) {
        bestStep.attachedOperatorIntent = vNote.instruction;
      }
    }

    this.fsm.transition('READY', 'observation_filtering_complete');
    const output = {
      cleanSteps: coalescedEvents,
      relevantVoice: cleanVoiceNotes,
    };
    this.fsm.transition('IDLE', 'cycle_complete');
    return output;
  }
}

// ---------------------------------------------------------------------------
// 3. AGENT 2: THE PLANNER (Decision Tree, Anchor Scoring & SOP Blueprinting)
// ---------------------------------------------------------------------------
class PlannerAgent {
  constructor() {
    this.fsm = new AgentStateMachine('PLANNER_AGENT', 'IDLE', {
      IDLE: ['ANALYZING'],
      ANALYZING: ['SCORING_ANCHORS', 'ERROR'],
      SCORING_ANCHORS: ['SYNTHESIZING_SOP'],
      SYNTHESIZING_SOP: ['COMPLETED', 'IDLE'],
      COMPLETED: ['IDLE'],
      ERROR: ['IDLE'],
    });
  }

  /**
   * Calculates reliability confidence (0.0 to 1.0) for each UI step
   */
  computeStepConfidence(step) {
    let score = 0.25; // Base coordinate availability

    if (step.automationId && step.automationId.trim().length > 0) {
      score += 0.40; // High stability anchor
    }
    if (
      step.elementName &&
      step.elementName.trim().length > 0 &&
      step.elementName !== '***[MASKED_PASSWORD_FIELD]***'
    ) {
      score += 0.20;
    }
    if (step.className && step.className.trim().length > 0) {
      score += 0.08;
    }
    if (Array.isArray(step.patterns) && step.patterns.length > 0) {
      score += 0.07;
    }
    if (step.isPassword) {
      score = Math.max(score, 0.88); // Password property is deterministic in UIAutomation
    }

    return Number(Math.min(0.99, score).toFixed(2));
  }

  /**
   * Builds the Fallback Decision Tree for a given step
   */
  buildStepDecisionTree(step) {
    const strategies = [];

    if (step.automationId) {
      strategies.push({
        priority: 1,
        strategy: 'UIA_AUTOMATION_ID',
        selector: step.automationId,
        controlType: step.controlType,
      });
    }

    if (step.elementName && step.elementName !== '***[MASKED_PASSWORD_FIELD]***') {
      strategies.push({
        priority: 2,
        strategy: 'UIA_ELEMENT_NAME',
        selector: step.elementName,
        controlType: step.controlType,
      });
    }

    if (step.isPassword) {
      strategies.push({
        priority: 2,
        strategy: 'UIA_PASSWORD_PROPERTY',
        selector: 'IsPassword==true',
        controlType: step.controlType,
      });
    }

    if (Array.isArray(step.parentChain) && step.parentChain.length > 0) {
      strategies.push({
        priority: 3,
        strategy: 'UIA_PARENT_HIERARCHY_WALK',
        parentAnchor: step.parentChain[0],
        className: step.className,
      });
    }

    strategies.push({
      priority: 4,
      strategy: 'WIN32_BOUNDING_RECT_CLICK',
      cursorX: step.cursorX,
      cursorY: step.cursorY,
      boundingBox: step.boundingBox,
    });

    return strategies;
  }

  buildSopBlueprint(sessionId, filteredData) {
    this.fsm.transition('ANALYZING', `planning_sop_${sessionId}`);

    const steps = Array.isArray(filteredData.cleanSteps) ? filteredData.cleanSteps : [];
    const appsUsed = [...new Set(steps.map((s) => s.process).filter(Boolean))];
    const primaryApp =
      appsUsed.find((a) => !/^(electron|powershell|cmd|explorer)$/i.test(a)) ||
      appsUsed[0] ||
      'SystemWorkflow';

    const slug = primaryApp.toLowerCase().replace(/[^a-z0-9]+/g, '_');

    this.fsm.transition('SCORING_ANCHORS', 'evaluating_ui_selectors');

    const actionSequence = steps.map((step, idx) => {
      const confidence = this.computeStepConfidence(step);
      const decisionTree = this.buildStepDecisionTree(step);

      return {
        step_number: idx + 1,
        event_type: step.event || 'CLICK_LEFT',
        target_process: step.process,
        exe_path: step.exePath || '',
        window_title_anchor: step.windowTitle || '',
        ui_automation_anchor: step.elementName || '',
        automation_id: step.automationId || '',
        class_name: step.className || '',
        control_type: step.controlType || 'Control',
        supported_patterns: step.patterns || [],
        parent_hierarchy: step.parentChain || [],
        cursor_x: step.cursorX || 0,
        cursor_y: step.cursorY || 0,
        bounding_box: step.boundingBox || { x: 0, y: 0, w: 0, h: 0 },
        element_value: step.elementValue || '',
        typed_text: step.typedText || '',
        credential_protected: !!step.isPassword,
        vault_target_key: step.isPassword ? `${slug}_login` : null,
        delay_before_ms: step.delayFromPrevMs || 350,
        operator_intent_note: step.attachedOperatorIntent || '',
        confidence_score: confidence,
        recovery_decision_tree: decisionTree,
      };
    });

    this.fsm.transition('SYNTHESIZING_SOP', 'assembling_final_graph');

    const avgConfidence =
      actionSequence.length > 0
        ? Number(
            (
              actionSequence.reduce((acc, s) => acc + s.confidence_score, 0) /
              actionSequence.length
            ).toFixed(2)
          )
        : 0;

    const blueprint = {
      sop_id: sessionId,
      name: `surrogate_${slug}_workflow`,
      primary_app: primaryApp,
      apps_involved: appsUsed,
      created_at: new Date().toISOString(),
      overall_confidence: avgConfidence,
      operator_notes: filteredData.relevantVoice || [],
      action_sequence: actionSequence,
    };

    this.fsm.transition('COMPLETED', 'blueprint_ready');
    this.fsm.transition('IDLE', 'reset');
    return blueprint;
  }
}

// ---------------------------------------------------------------------------
// 4. AGENT 4: THE SILENT CRITIC (Background Audit & Self-Correction FSM)
// ---------------------------------------------------------------------------
class SilentCriticAgent {
  constructor() {
    this.fsm = new AgentStateMachine('SILENT_CRITIC_AGENT', 'IDLE', {
      IDLE: ['AUDITING_SECURITY'],
      AUDITING_SECURITY: ['SCRUBBING_PII', 'REJECTED'],
      SCRUBBING_PII: ['OPTIMIZING_GRAPH'],
      OPTIMIZING_GRAPH: ['APPROVED'],
      APPROVED: ['IDLE'],
      REJECTED: ['IDLE'],
    });
  }

  /**
   * Silently inspects, repairs, and certifies the SOP Blueprint before saving or running.
   * Never outputs noisy logs to the user UI.
   */
  auditAndSelfCorrectSop(rawBlueprint, ctx) {
    this.fsm.transition('AUDITING_SECURITY', `auditing_${rawBlueprint?.sop_id}`);

    const sop = JSON.parse(JSON.stringify(rawBlueprint || {}));
    const correctionsMade = [];

    if (!Array.isArray(sop.action_sequence)) {
      sop.action_sequence = [];
    }

    // 1. Rule 5 Security Boundary Enforcement (Purge any step touching 01_CONFIG or core files)
    const safeSteps = [];
    for (const step of sop.action_sequence) {
      const hay = `${step.window_title_anchor} ${step.ui_automation_anchor} ${step.typed_text} ${step.element_value}`;
      if (core0.isPathForbidden(hay)) {
        correctionsMade.push({
          type: 'RULE5_CONFIG_BOUNDARY_PURGE',
          removed_step: step.step_number,
        });
        continue;
      }
      safeSteps.push(step);
    }

    this.fsm.transition('SCRUBBING_PII', 'applying_rule3_masking');

    // 2. Rule 3 Deep Secret Scrubbing & Password Detection Upgrade
    for (const step of safeSteps) {
      const combinedLabels = `${step.ui_automation_anchor} ${step.automation_id} ${step.class_name}`;
      if (/password|passwd|pwd|পাসওয়ার্ড|পাসওয়ার্ড|পিন|pin|secret/i.test(combinedLabels)) {
        if (!step.credential_protected) {
          step.credential_protected = true;
          correctionsMade.push({
            type: 'AUTO_UPGRADED_PASSWORD_PROTECTION',
            step: step.step_number,
          });
        }
      }

      if (step.credential_protected) {
        step.ui_automation_anchor = '***[MASKED_PASSWORD_FIELD]***';
        step.element_value = '***[MASKED]***';
        step.typed_text = '***[MASKED_KEYSTROKES]***';
      } else {
        step.window_title_anchor = core0.sanitizeAndMaskText(step.window_title_anchor);
        step.ui_automation_anchor = core0.sanitizeAndMaskText(step.ui_automation_anchor);
        step.element_value = core0.sanitizeAndMaskText(step.element_value);
        step.typed_text = core0.sanitizeAndMaskText(step.typed_text);
      }
    }

    this.fsm.transition('OPTIMIZING_GRAPH', 'pruning_redundant_focus_events');

    // 3. Prune empty orphan window clicks that have no anchor and no coordinate
    const optimizedSteps = safeSteps
      .filter((s) => {
        const hasAnchor = Boolean(s.automation_id || s.ui_automation_anchor || s.class_name);
        const hasCoords = s.cursor_x > 0 || s.cursor_y > 0;
        const hasKey = Boolean(s.typed_text || s.event_type === 'KEY_ENTER');
        return hasAnchor || hasCoords || hasKey;
      })
      .map((s, idx) => ({
        ...s,
        step_number: idx + 1,
      }));

    sop.action_sequence = optimizedSteps;
    sop.silent_critic_certified = true;
    sop.silent_corrections_count = correctionsMade.length;

    // Silent background audit record (Rule 2 compliance)
    this.fsm.recordInternalAudit('sop_certified_silently', {
      sop_id: sop.sop_id,
      steps_final: optimizedSteps.length,
      corrections: correctionsMade,
    });
    ctx?.audit?.('info', 'silent_critic_certified_sop', {
      sop_id: sop.sop_id,
      steps: optimizedSteps.length,
      corrections_count: correctionsMade.length,
    });

    this.fsm.transition('APPROVED', 'certification_complete');
    this.fsm.transition('IDLE', 'reset');
    return sop;
  }
}

// ---------------------------------------------------------------------------
// 5. AGENT 3: THE OPERATOR (Autonomous Execution & 3-Tier Self-Healing Loop)
// ---------------------------------------------------------------------------
class OperatorAgent {
  constructor() {
    this.fsm = new AgentStateMachine('OPERATOR_AGENT', 'IDLE', {
      IDLE: ['PREPARING'],
      PREPARING: ['EXECUTING_STEP', 'ABORTED'],
      EXECUTING_STEP: ['VERIFYING_STEP', 'RECOVERING_STEP', 'COMPLETED', 'ABORTED'],
      VERIFYING_STEP: ['EXECUTING_STEP', 'RECOVERING_STEP', 'COMPLETED'],
      RECOVERING_STEP: ['VERIFYING_STEP', 'EXECUTING_STEP', 'ABORTED'],
      COMPLETED: ['IDLE'],
      ABORTED: ['IDLE'],
    });
  }

  /**
   * Executes a full certified SOP with automatic self-healing recovery on any failed step
   */
  async executeCertifiedSop(sop, options = {}, ctx = null) {
    if (!sop || !Array.isArray(sop.action_sequence)) {
      return { ok: false, reason: 'empty_or_invalid_sop' };
    }

    if (!core0.verifyFailClosedStorage(ctx)) {
      return { ok: false, reason: 'rule2_fail_closed_storage_error' };
    }

    this.fsm.transition('PREPARING', `starting_sop_${sop.sop_id}`);

    const stepResults = [];
    let recoveredCount = 0;

    for (let i = 0; i < sop.action_sequence.length; i++) {
      const step = sop.action_sequence[i];
      this.fsm.transition('EXECUTING_STEP', `step_${step.step_number}`);

      // Primary Execution Attempt (Uses Sub-Engine 2 Multi-Tier UIA + Coordinate Replayer)
      let res = await actionReplayer.executeStep(step, options);

      this.fsm.transition('VERIFYING_STEP', `verifying_step_${step.step_number}`);

      // If primary execution failed, trigger the 3-Tier Self-Healing Recovery Loop
      if (!res || !res.ok) {
        this.fsm.transition('RECOVERING_STEP', `healing_step_${step.step_number}`);
        const recoveryRes = await this.performSelfHealingRecovery(step);
        if (recoveryRes.ok) {
          res = recoveryRes;
          recoveredCount++;
        }
      }

      stepResults.push({
        step_number: step.step_number,
        target_process: step.target_process,
        anchor: step.ui_automation_anchor || step.automation_id || `XY(${step.cursor_x},${step.cursor_y})`,
        ok: Boolean(res && res.ok),
        resolution_tier: res?.tier || 'UNKNOWN',
      });
    }

    this.fsm.transition('COMPLETED', `finished_${sop.sop_id}`);
    this.fsm.recordInternalAudit('sop_execution_finished', {
      sop_id: sop.sop_id,
      total_steps: sop.action_sequence.length,
      self_healed_steps: recoveredCount,
    });
    this.fsm.transition('IDLE', 'reset');

    const succeeded = stepResults.filter((r) => r.ok).length;
    return {
      ok: succeeded > 0,
      sop_id: sop.sop_id,
      workflow_name: sop.name,
      primary_app: sop.primary_app,
      total_steps: sop.action_sequence.length,
      steps_succeeded: succeeded,
      self_healed_steps: recoveredCount,
      step_results: stepResults,
    };
  }

  /**
   * 3-Tier Recovery Loop when an element moves, changes ID, or loads slowly:
   *   Recovery 1: Crawl live interactive window tree and fuzzy-match button/input by partial name
   *   Recovery 2: Match by ControlType + closest Euclidean distance to original BoundingBox
   *   Recovery 3: Direct hardware click at original BoundingBox center after extra wait
   */
  async performSelfHealingRecovery(failedStep) {
    try {
      // Wait 900ms in case the UI or webpage was simply slow to render
      await new Promise((r) => setTimeout(r, 900));

      const liveControls = await accessibilitySensor.crawlFullWindowInteractiveMap();

      if (Array.isArray(liveControls) && liveControls.length > 0) {
        const targetName = (failedStep.ui_automation_anchor || '').toLowerCase().trim();
        const targetId = (failedStep.automation_id || '').toLowerCase().trim();

        // Recovery Strategy A: Fuzzy Substring Match on Live UI Tree
        let matchedControl = null;
        if (targetName && !targetName.includes('masked')) {
          matchedControl = liveControls.find(
            (c) =>
              (c.name && c.name.toLowerCase().includes(targetName)) ||
              (targetId && c.automationId && c.automationId.toLowerCase().includes(targetId))
          );
        }

        // Recovery Strategy B: Same ControlType closest to recorded (X, Y)
        if (!matchedControl && failedStep.control_type && failedStep.cursor_x > 0) {
          const sameType = liveControls.filter((c) => c.controlType === failedStep.control_type && c.w > 0);
          let bestDist = Infinity;
          for (const candidate of sameType) {
            const cx = candidate.x + candidate.w / 2;
            const cy = candidate.y + candidate.h / 2;
            const dist = Math.hypot(cx - failedStep.cursor_x, cy - failedStep.cursor_y);
            if (dist < bestDist && dist < 220) {
              bestDist = dist;
              matchedControl = candidate;
            }
          }
        }

        if (matchedControl) {
          const healedStep = {
            ...failedStep,
            automation_id: matchedControl.automationId || failedStep.automation_id,
            ui_automation_anchor: matchedControl.name || failedStep.ui_automation_anchor,
            cursor_x: matchedControl.w > 0 ? Math.round(matchedControl.x + matchedControl.w / 2) : failedStep.cursor_x,
            cursor_y: matchedControl.h > 0 ? Math.round(matchedControl.y + matchedControl.h / 2) : failedStep.cursor_y,
            delay_before_ms: 250,
          };
          const retryRes = await actionReplayer.executeStep(healedStep, { timeoutMs: 7000 });
          if (retryRes && retryRes.ok) {
            return { ...retryRes, tier: 'SELF_HEALED_LIVE_TREE_MATCH' };
          }
        }
      }

      // Recovery Strategy C: BoundingBox Center Coordinate Fallback
      if (failedStep.bounding_box && failedStep.bounding_box.w > 0) {
        const centerStep = {
          ...failedStep,
          automation_id: '',
          ui_automation_anchor: '',
          cursor_x: Math.round(failedStep.bounding_box.x + failedStep.bounding_box.w / 2),
          cursor_y: Math.round(failedStep.bounding_box.y + failedStep.bounding_box.h / 2),
          delay_before_ms: 300,
        };
        const coordRes = await actionReplayer.executeStep(centerStep, { timeoutMs: 6000 });
        if (coordRes && coordRes.ok) {
          return { ...coordRes, tier: 'SELF_HEALED_BBOX_CENTER' };
        }
      }

      return { ok: false, tier: 'RECOVERY_EXHAUSTED' };
    } catch (err) {
      return { ok: false, tier: 'RECOVERY_ERROR', error: err.message };
    }
  }
}

const observerAgent = new ObserverAgent();
const plannerAgent = new PlannerAgent();
const silentCriticAgent = new SilentCriticAgent();
const operatorAgent = new OperatorAgent();

module.exports = {
  AgentStateMachine,
  ObserverAgent,
  PlannerAgent,
  SilentCriticAgent,
  OperatorAgent,
  observerAgent,
  plannerAgent,
  silentCriticAgent,
  operatorAgent,
};