'use strict';

const { execFile } = require('child_process');
const path = require('path');

const TARGET_PATH = 'G:\\Sand box\\Jarvis_Core\\00_ENGINE\\bin\\photorec_win.exe';
const RUNNER_MODE = 'exe';

module.exports = {
  name: 'tool_jarvis_core',
  description: 'Auto-generated execution bridge for Jarvis_Core (exe).',
  tags: ['jarvis_core', 'jarvis_core', 'exe', 'auto_tool'],
  risk: 'RISKY',
  parameters: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'CLI arguments to pass to the tool.' },
    },
  },
  async execute(params) {
    const cliArgs = Array.isArray(params?.args) ? params.args.map(String) : [];
    let cmd = TARGET_PATH;
    let finalArgs = cliArgs;
    if (RUNNER_MODE === 'python') { cmd = process.env.JARVIS_PYTHON || 'python'; finalArgs = [TARGET_PATH, ...cliArgs]; }
    else if (RUNNER_MODE === 'node') { cmd = process.execPath; finalArgs = [TARGET_PATH, ...cliArgs]; }
    else if (RUNNER_MODE === 'powershell') { cmd = 'powershell'; finalArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TARGET_PATH, ...cliArgs]; }

    return new Promise((resolve) => {
      execFile(cmd, finalArgs, { cwd: path.dirname(TARGET_PATH), timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(err.message), stdout: String(stdout || ''), stderr: String(stderr || '') });
        resolve({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
      });
    });
  },
};
