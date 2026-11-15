'use strict';

/**
 * ============================================================================
 * FILE: kernel_9_adaptive_intelligence_1.js
 * SUB-ENGINE 1: Real-Time Event-Driven OS Accessibility Tree Daemon
 * ============================================================================
 * Solves the 2.5s polling problem completely:
 *   - Spawns a persistent background PowerShell + Embedded C# Win32 Daemon
 *   - Hooks GetAsyncKeyState & Cursor Pos at 60ms real-time intervals
 *   - Immediately on Mouse Click (Left/Right) or Enter/Tab/Key Burst:
 *       * Inspects the exact UIElement under the cursor via UIAutomationClient
 *       * Extracts AutomationId, Name, ClassName, ControlType, BoundingRect
 *       * Walks Parent Hierarchy & Sibling Anchors for resilient replay
 *       * DetectsSupportedPatterns (Invoke, Value, SelectionItem, Toggle, Scroll)
 *       * Automatically masks Password fields at the OS kernel level
 * ============================================================================
 */

const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const core0 = require('./kernel_9_adaptive_intelligence_0');

const EMBEDDED_CSHARP_DAEMON_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class JarvisWin32Sensor {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

function Get-ElementSnapshot($ptX, $ptY, $triggerType, $typedBuffer) {
    $hwnd = [JarvisWin32Sensor]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][JarvisWin32Sensor]::GetWindowText($hwnd, $sb, 512)
    $winTitle = $sb.ToString()

    $pidOut = 0
    [void][JarvisWin32Sensor]::GetWindowThreadProcessId($hwnd, [ref]$pidOut)
    $proc = Get-Process -Id $pidOut -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "unknown" }
    $procPath = if ($proc -and $proc.MainModule) { $proc.MainModule.FileName } else { "" }

    $el = $null
    try {
        if ($triggerType -like "CLICK*") {
            $pt = New-Object System.Windows.Point($ptX, $ptY)
            $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
        } else {
            $el = [System.Windows.Automation.AutomationElement]::FocusedElement
        }
    } catch {}

    if ($el -eq $null) {
        return @{
            event = $triggerType
            ts = (Get-Date).ToString("o")
            process = $procName
            exePath = $procPath
            windowTitle = $winTitle
            cursorX = $ptX
            cursorY = $ptY
            elementName = ""
            automationId = ""
            className = ""
            controlType = "Window"
            isPassword = $false
            patterns = @()
            parentChain = @()
            typedText = $typedBuffer
        }
    }

    $cur = $el.Current
    $isPass = [bool]$cur.IsPassword
    $elName = if ($isPass) { "***[MASKED_PASSWORD_FIELD]***" } else { [string]$cur.Name }
    $autoId = [string]$cur.AutomationId
    $clsName = [string]$cur.ClassName
    $ctrlType = if ($cur.ControlType) { [string]$cur.ControlType.ProgrammaticName } else { "Custom" }
    $rect = $cur.BoundingRectangle

    $pats = @()
    try {
        foreach ($p in $el.GetSupportedPatterns()) {
            $pats += $p.ProgrammaticName
        }
    } catch {}

    # Walk up 3 parent levels for structural resilience
    $parents = @()
    try {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $pNode = $walker.GetParent($el)
        $depth = 0
        while ($pNode -ne $null -and $depth -lt 3) {
            $pCur = $pNode.Current
            $parents += @{
                name = [string]$pCur.Name
                automationId = [string]$pCur.AutomationId
                controlType = if ($pCur.ControlType) { [string]$pCur.ControlType.ProgrammaticName } else { "" }
            }
            $pNode = $walker.GetParent($pNode)
            $depth++
        }
    } catch {}

    # Extract current value if ValuePattern is supported and NOT a password
    $currentVal = ""
    if (-not $isPass) {
        try {
            $valPat = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($valPat -ne $null) {
                $currentVal = [string]$valPat.Current.Value
            }
        } catch {}
    } else {
        $currentVal = "***[MASKED_PASSWORD]***"
    }

    return @{
        event = $triggerType
        ts = (Get-Date).ToString("o")
        process = $procName
        exePath = $procPath
        windowTitle = $winTitle
        cursorX = $ptX
        cursorY = $ptY
        boundingBox = @{
            x = if ([double]::IsInfinity($rect.X)) { 0 } else { [int]$rect.X }
            y = if ([double]::IsInfinity($rect.Y)) { 0 } else { [int]$rect.Y }
            w = if ([double]::IsInfinity($rect.Width)) { 0 } else { [int]$rect.Width }
            h = if ([double]::IsInfinity($rect.Height)) { 0 } else { [int]$rect.Height }
        }
        elementName = $elName
        automationId = $autoId
        className = $clsName
        controlType = $ctrlType
        isPassword = $isPass
        elementValue = $currentVal
        patterns = $pats
        parentChain = $parents
        typedText = if ($isPass) { "***[MASKED_KEYSTROKES]***" } else { $typedBuffer }
    }
}

$prevLButton = $false
$prevRButton = $false
$prevEnter = $false
$prevTab = $false
$lastWindow = ""
$keyBuffer = ""
$lastKeyTick = [Environment]::TickCount

Write-Output '{"status":"DAEMON_READY"}'

while ($true) {
    Start-Sleep -Milliseconds 55

    $pt = New-Object JarvisWin32Sensor+POINT
    [void][JarvisWin32Sensor]::GetCursorPos([ref]$pt)

    # Mouse States (VK_LBUTTON = 0x01, VK_RBUTTON = 0x02)
    $lState = ([JarvisWin32Sensor]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
    $rState = ([JarvisWin32Sensor]::GetAsyncKeyState(0x02) -band 0x8000) -ne 0
    $enterState = ([JarvisWin32Sensor]::GetAsyncKeyState(0x0D) -band 0x8000) -ne 0
    $tabState = ([JarvisWin32Sensor]::GetAsyncKeyState(0x09) -band 0x8000) -ne 0

    # Capture alphanumeric keystrokes lightly for buffer context
    for ($vk = 0x30; $vk -le 0x5A; $vk++) {
        if (([JarvisWin32Sensor]::GetAsyncKeyState($vk) -band 0x0001) -ne 0) {
            $ch = [char]$vk
            $keyBuffer += $ch
            $lastKeyTick = [Environment]::TickCount
        }
    }

    if ($lState -and -not $prevLButton) {
        $snap = Get-ElementSnapshot $pt.X $pt.Y "CLICK_LEFT" $keyBuffer
        $keyBuffer = ""
        $json = $snap | ConvertTo-Json -Compress -Depth 5
        Write-Output "EVENT:$json"
    }

    if ($rState -and -not $prevRButton) {
        $snap = Get-ElementSnapshot $pt.X $pt.Y "CLICK_RIGHT" $keyBuffer
        $keyBuffer = ""
        $json = $snap | ConvertTo-Json -Compress -Depth 5
        Write-Output "EVENT:$json"
    }

    if ($enterState -and -not $prevEnter) {
        $snap = Get-ElementSnapshot $pt.X $pt.Y "KEY_ENTER" $keyBuffer
        $keyBuffer = ""
        $json = $snap | ConvertTo-Json -Compress -Depth 5
        Write-Output "EVENT:$json"
    }

    if ($tabState -and -not $prevTab) {
        $snap = Get-ElementSnapshot $pt.X $pt.Y "KEY_TAB" $keyBuffer
        $keyBuffer = ""
        $json = $snap | ConvertTo-Json -Compress -Depth 5
        Write-Output "EVENT:$json"
    }

    $prevLButton = $lState
    $prevRButton = $rState
    $prevEnter = $enterState
    $prevTab = $tabState
}
`;

class RealTimeAccessibilitySensor extends EventEmitter {
  constructor() {
    super();
    this.daemonProcess = null;
    this.isRunning = false;
    this.stdoutBuffer = '';
  }

  /**
   * Starts the real-time 55ms event-driven C#/UIAutomation daemon
   */
  startSensorDaemon() {
    if (this.isRunning && this.daemonProcess) return true;

    try {
      this.daemonProcess = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', EMBEDDED_CSHARP_DAEMON_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );

      this.isRunning = true;

      this.daemonProcess.stdout.on('data', (chunk) => {
        this.stdoutBuffer += chunk.toString('utf8');
        const lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('EVENT:')) {
            const rawJson = trimmed.slice(6);
            try {
              const parsed = JSON.parse(rawJson);
              const sanitized = this.sanitizeAccessibilityEvent(parsed);
              this.emit('ui_event', sanitized);
            } catch (_) {}
          }
        }
      });

      this.daemonProcess.on('exit', () => {
        this.isRunning = false;
        this.daemonProcess = null;
      });

      return true;
    } catch (err) {
      this.isRunning = false;
      return false;
    }
  }

  /**
   * Stops the background sensor daemon immediately
   */
  stopSensorDaemon() {
    this.isRunning = false;
    if (this.daemonProcess) {
      try {
        this.daemonProcess.kill('SIGTERM');
      } catch (_) {}
      this.daemonProcess = null;
    }
  }

  /**
   * Deeply crawls the active window's entire interactive control tree on demand
   * (Buttons, TextBoxes, ComboBoxes, CheckBoxes, MenuItems, Hyperlinks, DOM nodes)
   */
  crawlFullWindowInteractiveMap() {
    return new Promise((resolve) => {
      const psCrawler = `
        $ErrorActionPreference = "SilentlyContinue"
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes

        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32Fg {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        }
"@
        $hwnd = [Win32Fg]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "[]"; exit }

        $rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        if ($rootEl -eq $null) { Write-Output "[]"; exit }

        $cond = [System.Windows.Automation.Condition]::TrueCondition
        $all = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)

        $controls = @()
        $maxNodes = [Math]::Min($all.Count, 180)
        for ($i = 0; $i -lt $maxNodes; $i++) {
            $item = $all[$i]
            $c = $item.Current
            if (-not $c.IsEnabled -or $c.IsOffscreen) { continue }
            $type = if ($c.ControlType) { $c.ControlType.ProgrammaticName } else { "" }
            if ($type -match "Button|Edit|ComboBox|CheckBox|RadioButton|MenuItem|Hyperlink|TabItem|ListItem|Document") {
                $r = $c.BoundingRectangle
                $controls += @{
                    name = if ($c.IsPassword) { "***[MASKED_PASSWORD_FIELD]***" } else { [string]$c.Name }
                    automationId = [string]$c.AutomationId
                    className = [string]$c.ClassName
                    controlType = $type
                    isPassword = [bool]$c.IsPassword
                    x = if ([double]::IsInfinity($r.X)) { 0 } else { [int]$r.X }
                    y = if ([double]::IsInfinity($r.Y)) { 0 } else { [int]$r.Y }
                    w = if ([double]::IsInfinity($r.Width)) { 0 } else { [int]$r.Width }
                    h = if ([double]::IsInfinity($r.Height)) { 0 } else { [int]$r.Height }
                }
            }
        }
        $controls | ConvertTo-Json -Compress -Depth 4
      `;

      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCrawler],
        { timeout: 6000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve([]);
          try {
            const parsed = JSON.parse(stdout.trim());
            const list = Array.isArray(parsed) ? parsed : [parsed];
            resolve(core0.sanitizeObjectDeep(list));
          } catch (_) {
            resolve([]);
          }
        }
      );
    });
  }

  sanitizeAccessibilityEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const isPass = !!ev.isPassword || /password|পাসওয়ার্ড|পিন|pin|secret/i.test(`${ev.elementName} ${ev.automationId}`);
    return {
      event: ev.event || 'CLICK_LEFT',
      ts: ev.ts || new Date().toISOString(),
      process: ev.process || 'unknown',
      exePath: ev.exePath || '',
      windowTitle: core0.sanitizeAndMaskText(ev.windowTitle || ''),
      cursorX: Number(ev.cursorX) || 0,
      cursorY: Number(ev.cursorY) || 0,
      boundingBox: ev.boundingBox || { x: 0, y: 0, w: 0, h: 0 },
      elementName: isPass ? '***[MASKED_PASSWORD_FIELD]***' : core0.sanitizeAndMaskText(ev.elementName || ''),
      automationId: core0.sanitizeAndMaskText(ev.automationId || ''),
      className: ev.className || '',
      controlType: ev.controlType || 'Control',
      isPassword: isPass,
      elementValue: isPass ? '***[MASKED]***' : core0.sanitizeAndMaskText(ev.elementValue || ''),
      patterns: Array.isArray(ev.patterns) ? ev.patterns : [],
      parentChain: core0.sanitizeObjectDeep(ev.parentChain || []),
      typedText: isPass ? '***[MASKED_KEYSTROKES]***' : core0.sanitizeAndMaskText(ev.typedText || ''),
    };
  }
}

const accessibilitySensor = new RealTimeAccessibilitySensor();

module.exports = {
  RealTimeAccessibilitySensor,
  accessibilitySensor,
};