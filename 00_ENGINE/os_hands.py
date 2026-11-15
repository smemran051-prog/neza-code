"""
os_hands.py — JARVIS-CORE Phase 1 OS Hands (Tier-1 Safety Gateway)

Design:
  - Windows-only, ctypes-only, no third-party deps.
  - Reads JSON-line commands on stdin, writes JSON-line responses on stdout.
  - Every 0.2s a safety thread checks STOP.flag (Tier 1 soft stop).
  - Tier-3 user-input detection has been intentionally removed in this build.
  - Fail-closed: if stdout write fails, hard exit(1). If 3 consecutive
    command failures, self-terminate via the same stop path.
  - Presence: get_idle returns idle_ms from GetLastInputInfo + GetTickCount.
    Limitation: GetLastInputInfo also records this process's own SendInput
    events, so idle_ms resets whenever this process injects input.
"""

import ctypes
from ctypes import wintypes
import json
import os
import sys
import time
import threading

# ----------------------------------------------------------------------------
# Win32 bindings
# ----------------------------------------------------------------------------
user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

SM_CXSCREEN = 0
SM_CYSCREEN = 1

user32.GetSystemMetrics.restype = ctypes.c_int
user32.GetSystemMetrics.argtypes = [ctypes.c_int]

kernel32.GetTickCount.restype = wintypes.DWORD
kernel32.GetTickCount.argtypes = []


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("dwTime", wintypes.DWORD),
    ]


user32.GetLastInputInfo.restype = wintypes.BOOL
user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG)),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG)),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("union", _INPUT_UNION)]


user32.SendInput.restype = wintypes.UINT
user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]

# Input event flags ----------------------------------------------------------
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
STOP_FLAG_PATH = os.environ.get('JARVIS_STOP_FLAG', r'C:\Jarvis_Core\STOP.flag')
CHECK_INTERVAL = 0.2            # safety poll interval (Blueprint: 0.2s)
MAX_CONSECUTIVE_FAILURES = 3

# ----------------------------------------------------------------------------
# Presence helpers (idle time)
# ----------------------------------------------------------------------------
def _tick32():
    return int(kernel32.GetTickCount()) & 0xFFFFFFFF


def _last_input_tick():
    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not user32.GetLastInputInfo(ctypes.byref(lii)):
        raise OSError(f"GetLastInputInfo failed: {ctypes.get_last_error()}")
    return int(lii.dwTime) & 0xFFFFFFFF


def _idle_ms():
    return (_tick32() - _last_input_tick()) & 0xFFFFFFFF


# ----------------------------------------------------------------------------
# Low-level input helpers
# ----------------------------------------------------------------------------
def _send_input(inp):
    n = user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
    if n != 1:
        raise OSError(f"SendInput failed: {ctypes.get_last_error()}")


def _send_mouse_abs(x, y):
    sw = user32.GetSystemMetrics(SM_CXSCREEN)
    sh = user32.GetSystemMetrics(SM_CYSCREEN)
    nx = int(x * 65535 / max(sw - 1, 1))
    ny = int(y * 65535 / max(sh - 1, 1))
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.union.mi.dx = nx
    inp.union.mi.dy = ny
    inp.union.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
    _send_input(inp)


def _send_mouse_rel(dx, dy):
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.union.mi.dx = int(dx)
    inp.union.mi.dy = int(dy)
    inp.union.mi.dwFlags = MOUSEEVENTF_MOVE
    _send_input(inp)


def _send_click(button='left'):
    flags = {
        'left':   (MOUSEEVENTF_LEFTDOWN,   MOUSEEVENTF_LEFTUP),
        'right':  (MOUSEEVENTF_RIGHTDOWN,  MOUSEEVENTF_RIGHTUP),
        'middle': (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }.get(button)
    if not flags:
        raise ValueError(f"unknown_button:{button}")
    down, up = flags
    for f in (down, up):
        inp = INPUT()
        inp.type = INPUT_MOUSE
        inp.union.mi.dwFlags = f
        _send_input(inp)
        time.sleep(0.01)


def _send_text(text):
    for ch in str(text):
        code = ord(ch)
        if code > 0xFFFF:
            raise ValueError("astral_unicode_unsupported_phase1")
        for flags in (KEYEVENTF_UNICODE,
                      KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
            inp = INPUT()
            inp.type = INPUT_KEYBOARD
            inp.union.ki.wScan = code
            inp.union.ki.dwFlags = flags
            _send_input(inp)
        time.sleep(0.004)


# ----------------------------------------------------------------------------
# Output (fail-closed)
# ----------------------------------------------------------------------------
def _emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
        sys.stdout.flush()
    except Exception as e:
        try:
            sys.stderr.write(f"EMIT_FAIL:{e}\n")
            sys.stderr.flush()
        except Exception:
            pass
        os._exit(1)


# ----------------------------------------------------------------------------
# OsHands
# ----------------------------------------------------------------------------
class OsHands:
    def __init__(self):
        self._stop_event = threading.Event()
        self._stop_lock = threading.Lock()
        self._stop_reason = None
        self._consecutive_failures = 0

    # ---- safety (Tier-1 only) -----------------------------------------------
    def _trigger_stop(self, reason):
        with self._stop_lock:
            if self._stop_event.is_set():
                return
            self._stop_reason = reason
            self._stop_event.set()
        _emit({"event": "stopped", "reason": reason})

    def _check_safety(self):
        if os.path.exists(STOP_FLAG_PATH):
            self._trigger_stop('stop_flag')

    def _safety_loop(self):
        while not self._stop_event.is_set():
            try:
                self._check_safety()
            except Exception as e:
                # Fail-closed: any safety-check exception stops the agent.
                self._trigger_stop(f'safety_exception:{e}')
                return
            self._stop_event.wait(CHECK_INTERVAL)

    # ---- command dispatch ---------------------------------------------------
    def _act(self, fn, *args):
        if self._stop_event.is_set():
            raise RuntimeError(f"stopped:{self._stop_reason}")
        fn(*args)

    def execute(self, cmd, req):
        if cmd == 'ping':
            return {"pong": True, "idle_ms": _idle_ms()}
        if cmd == 'get_idle':
            return {"idle_ms": _idle_ms()}
        if cmd == 'mouse_move':
            x = int(req.get('x', 0)); y = int(req.get('y', 0))
            self._act(_send_mouse_abs, x, y)
            return {"x": x, "y": y}
        if cmd == 'mouse_move_rel':
            dx = int(req.get('dx', 0)); dy = int(req.get('dy', 0))
            self._act(_send_mouse_rel, dx, dy)
            return {"dx": dx, "dy": dy}
        if cmd == 'click':
            button = req.get('button', 'left')
            self._act(_send_click, button)
            return {"button": button}
        if cmd == 'type':
            text = str(req.get('text', ''))
            self._act(_send_text, text)
            return {"length": len(text)}
        if cmd == 'shutdown':
            self._stop_event.set()
            return {"shutdown": True}
        raise ValueError(f"unknown_cmd:{cmd}")

    # ---- main loop ----------------------------------------------------------
    def run(self):
        threading.Thread(target=self._safety_loop, daemon=True).start()
        _emit({"event": "ready"})
        try:
            for raw in sys.stdin:
                if self._stop_event.is_set():
                    break
                line = raw.strip()
                if not line:
                    continue
                req_id = None
                try:
                    req = json.loads(line)
                    req_id = req.get('id')
                    result = self.execute(req.get('cmd'), req)
                    self._consecutive_failures = 0
                    _emit({"id": req_id, "status": "ok", **result})
                except Exception as e:
                    self._consecutive_failures += 1
                    _emit({"id": req_id, "status": "error", "error": str(e)})
                    if self._consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                        self._trigger_stop('consecutive_failures')
                        break
        finally:
            if not self._stop_event.is_set():
                self._stop_reason = 'stdin_closed'
                self._stop_event.set()
                try:
                    _emit({"event": "stopped", "reason": "stdin_closed"})
                except Exception:
                    pass


def main():
    try:
        oh = OsHands()
        oh.run()
    except Exception as e:
        try:
            sys.stderr.write(f"FATAL:{e}\n")
            sys.stderr.flush()
        except Exception:
            pass
        sys.exit(1)


if __name__ == '__main__':
    main()