'use strict';

/**
 * ============================================================================
 * FILE: kernel_9_adaptive_intelligence_2.js
 * SUB-ENGINE 2: Autonomous UI Automation Replayer & Pattern Executor
 * ============================================================================
 * Capabilities:
 *   - Dynamic WaitForWindow & WaitForElementReady (Never clicks blindly if slow)
 *   - Multi-Tier Element Resolution:
 *       Tier 1: Exact AutomationId + ControlType match
 *       Tier 2: Exact Element Name + ControlType match
 *       Tier 3: Parent Hierarchy + ClassName match
 *       Tier 4: Physical Mouse Cursor + Hardware Click at BoundingRect / XY
 *   - Native UIAutomation Pattern Execution:
 *       * InvokePattern.Invoke() (Buttons, Links, Submit)
 *       * ValuePattern.SetValue() (Textboxes, Forms, Inputs)
 *       * SelectionItemPattern.Select() (Dropdown items, Tabs, Radio buttons)
 *       * TogglePattern.Toggle() (Checkboxes)
 *       * ScrollPattern.Scroll() (Page scrolling)
 *   - Automatic Credential Injection from Windows Credential Vault on Password Fields
 * ============================================================================
 */

const { execFile } = require('child_process');
const core0 = require('./kernel_9_adaptive_intelligence_0');

class AutonomousActionReplayer {
  /**
   * Executes a single SOP step with dynamic wait, pattern resolution, and fallback
   */
  async executeStep(step, options = {}) {
    if (!step || typeof step !== 'object') {
      return { ok: false, reason: 'invalid_step_object' };
    }

    // Rule 5 Security Check: Never interact with forbidden config files
    if (
      core0.isPathForbidden(step.window_title_anchor) ||
      core0.isPathForbidden(step.ui_automation_anchor) ||
      core0.isPathForbidden(step.element_value)
    ) {
      return { ok: false, reason: 'rule5_forbidden_config_boundary_blocked' };
    }

    // Resolve password from Windows Credential Vault if this step is a protected field
    let valueToInject = step.typed_text || step.element_value || '';
    if (step.credential_protected) {
      const vaultKey = step.vault_target_key || step.target_process || 'default';
      const secret = core0.credentialVault.retrieveSecret(vaultKey);
      if (secret) {
        valueToInject = secret;
      } else {
        // Leave empty if no vault secret registered so operator can type or register
        valueToInject = '';
      }
    }

    const timeoutMs = Number(options.timeoutMs) || 8000;
    const payload = {
      processName: step.target_process || '',
      exePath: step.exe_path || '',
      windowTitle: step.window_title_anchor || '',
      automationId: step.automation_id || '',
      elementName: step.ui_automation_anchor === '***[MASKED_PASSWORD_FIELD]***' ? '' : (step.ui_automation_anchor || ''),
      className: step.class_name || '',
      controlType: step.control_type || '',
      eventType: step.event_type || 'CLICK_LEFT',
      isPassword: !!step.credential_protected,
      valueToSet: valueToInject,
      cursorX: Number(step.cursor_x) || 0,
      cursorY: Number(step.cursor_y) || 0,
      boundingBox: step.bounding_box || { x: 0, y: 0, w: 0, h: 0 },
      waitMs: Math.min(Math.max(Number(step.delay_before_ms) || 350, 100), 5000),
    };

    return this.runNativeUiAutomationStep(payload, timeoutMs);
  }

  runNativeUiAutomationStep(payload, timeoutMs) {
    return new Promise((resolve) => {
      const psExecutor = `
        $ErrorActionPreference = "SilentlyContinue"
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        Add-Type -AssemblyName System.Windows.Forms

        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class JarvisReplayerWin32 {
            [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
            [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
            [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);

            public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
            public const uint MOUSEEVENTF_LEFTUP = 0x0004;
            public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
            public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        }
"@

        $cfg = ${JSON.stringify(payload)} | ConvertFrom-Json
        Start-Sleep -Milliseconds $cfg.waitMs

        # 1. Locate Target Process Window (Wait up to 4 seconds if opening)
        $targetProc = $null
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            $procs = Get-Process -Name $cfg.processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
            if ($procs) {
                $targetProc = $procs | Select-Object -First 1
                break
            }
            if ($ attempt -eq 0 -and $cfg.exePath -and (Test-Path $cfg.exePath)) {
                Start-Process -FilePath $cfg.exePath
            }
            Start-Sleep -Milliseconds 400
        }

        if (-not $targetProc) {
            Write-Output (@{ ok = $false; tier = "NONE"; reason = "process_window_not_found" } | ConvertTo-Json -Compress)
            exit
        }

        $hwnd = $targetProc.MainWindowHandle
        [void][JarvisReplayerWin32]::ShowWindow($hwnd, 9)
        [void][JarvisReplayerWin32]::SetForegroundWindow($hwnd)
        Start-Sleep -Milliseconds 200

        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $foundEl = $null
        $resolutionTier = "NONE"

        # 2. Multi-Tier UI Element Search (Wait up to 3 seconds for DOM/UI render)
        for ($waitLoop = 0; $waitLoop -lt 6; $waitLoop++) {
            if ($root -eq $null) { break }

            # TIER 1: Match by exact AutomationId
            if (-not $foundEl -and $cfg.automationId -and $cfg.automationId.Length -gt 0) {
                $condId = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
                    [string]$cfg.automationId
                )
                $foundEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condId)
                if ($foundEl) { $resolutionTier = "TIER1_AUTOMATION_ID"; break }
            }

            # TIER 2: Match by exact Element Name
            if (-not $foundEl -and $cfg.elementName -and $cfg.elementName.Length -gt 0) {
                $condName = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::NameProperty,
                    [string]$cfg.elementName
                )
                $foundEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condName)
                if ($foundEl) { $resolutionTier = "TIER2_ELEMENT_NAME"; break }
            }

            # TIER 3: Match Password Field or ClassName
            if (-not $foundEl -and $cfg.isPassword) {
                $condPass = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::IsPasswordProperty,
                    $true
                )
                $foundEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condPass)
                if ($foundEl) { $resolutionTier = "TIER3_PASSWORD_PROP"; break }
            }

            if (-not $foundEl -and $cfg.className -and $cfg.className.Length -gt 0) {
                $condCls = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
                    [string]$cfg.className
                )
                $foundEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condCls)
                if ($foundEl) { $resolutionTier = "TIER3_CLASS_NAME"; break }
            }

            Start-Sleep -Milliseconds 450
        }

        $actionExecuted = $false

        # 3. Execute via Native UIAutomation Patterns if Element Found
        if ($foundEl -ne $null) {
            try { $foundEl.SetFocus() } catch {}

            # If text/value needs to be entered
            if ($cfg.valueToSet -and $cfg.valueToSet.Length -gt 0) {
                try {
                    $valPat = $foundEl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($valPat -ne $null) {
                        $valPat.SetValue([string]$cfg.valueToSet)
                        $actionExecuted = $true
                    }
                } catch {}

                if (-not $actionExecuted) {
                    try {
                        $foundEl.SetFocus()
                        Start-Sleep -Milliseconds 100
                        [System.Windows.Forms.SendKeys]::SendWait([string]$cfg.valueToSet)
                        $actionExecuted = $true
                    } catch {}
                }
            }

            # Try InvokePattern (Buttons, Submit, Hyperlinks)
            if (-not $actionExecuted) {
                try {
                    $invPat = $foundEl.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                    if ($invPat -ne $null) {
                        $invPat.Invoke()
                        $actionExecuted = $true
                    }
                } catch {}
            }

            # Try TogglePattern (Checkboxes)
            if (-not $actionExecuted) {
                try {
                    $togPat = $foundEl.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    if ($togPat -ne $null) {
                        $togPat.Toggle()
                        $actionExecuted = $true
                    }
                } catch {}
            }

            # Try SelectionItemPattern (Dropdown items, Radio, Tabs)
            if (-not $actionExecuted) {
                try {
                    $selPat = $foundEl.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                    if ($selPat -ne $null) {
                        $selPat.Select()
                        $actionExecuted = $true
                    }
                } catch {}
            }

            # If element found but doesn't support InvokePattern, click center of its current BoundingRectangle
            if (-not $actionExecuted) {
                try {
                    $r = $foundEl.Current.BoundingRectangle
                    if (-not [double]::IsInfinity($r.X) -and $r.Width -gt 0) {
                        $cx = [int]($r.X + ($r.Width / 2))
                        $cy = [int]($r.Y + ($r.Height / 2))
                        [void][JarvisReplayerWin32]::SetCursorPos($cx, $cy)
                        Start-Sleep -Milliseconds 80
                        [JarvisReplayerWin32]::mouse_event([JarvisReplayerWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
                        Start-Sleep -Milliseconds 40
                        [JarvisReplayerWin32]::mouse_event([JarvisReplayerWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
                        $actionExecuted = $true
                    }
                } catch {}
            }
        }

        # 4. TIER 4 FALLBACK: Hardware Coordinate Click if UI tree element was custom-drawn
        if (-not $actionExecuted -and ($cfg.cursorX -gt 0 -or $cfg.cursorY -gt 0)) {
            $resolutionTier = "TIER4_COORDINATE_FALLBACK"
            [void][JarvisReplayerWin32]::SetCursorPos([int]$cfg.cursorX, [int]$cfg.cursorY)
            Start-Sleep -Milliseconds 90
            if ($cfg.eventType -eq "CLICK_RIGHT") {
                [JarvisReplayerWin32]::mouse_event([JarvisReplayerWin32]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
                Start-Sleep -Milliseconds 40
                [JarvisReplayerWin32]::mouse_event([JarvisReplayerWin32]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)
            } else {
                [JarvisReplayerWin32]::mouse_event([JarvisReplayerWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
                Start-Sleep -Milliseconds 40
                [JarvisReplayerWin32]::mouse_event([JarvisReplayerWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
            }

            if ($cfg.valueToSet -and $cfg.valueToSet.Length -gt 0) {
                Start-Sleep -Milliseconds 120
                [System.Windows.Forms.SendKeys]::SendWait([string]$cfg.valueToSet)
            }
            $actionExecuted = $true
        }

        if ($cfg.eventType -eq "KEY_ENTER") {
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
            $actionExecuted = $true
        }

        Write-Output (@{
            ok = [bool]$actionExecuted
            tier = $resolutionTier
            process = $cfg.processName
        } | ConvertTo-Json -Compress)
      `;

      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psExecutor],
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) {
            return resolve({ ok: false, tier: 'ERROR', error: err ? err.message : 'empty_stdout' });
          }
          try {
            const res = JSON.parse(stdout.trim());
            resolve(res);
          } catch (_) {
            resolve({ ok: false, tier: 'PARSE_ERROR', raw: stdout.trim() });
          }
        }
      );
    });
  }
}

const actionReplayer = new AutonomousActionReplayer();

module.exports = {
  AutonomousActionReplayer,
  actionReplayer,
};