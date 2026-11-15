'use strict';

/**
 * PATH: 02_MODULES/communication_block/api.js
 * DESC: Auto-Provisioned Universal Gateway for communication_block.
 */

const fs = require('fs');
const path = require('path');

if (!process.env.JARVIS_ROOT) {
  process.env.JARVIS_ROOT = path.resolve(__dirname, '..', '..');
}

function getContract() {
  const contractPath = path.join(__dirname, 'module.json');
  try {
    return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (_) {
    return { module_name: 'communication_block', default_risk_level: 'WRITE_SAFE', registered_tools: [] };
  }
}

async function executeTool(toolName, args = {}, context = {}) {
  const cleanName = String(toolName || '').replace(/\.js$/i, '').trim();
  const toolPath = path.join(__dirname, 'tools', cleanName + '.js');

  if (!fs.existsSync(toolPath)) {
    throw new Error(`Tool executable '${cleanName}.js' missing in communication_block/tools/`);
  }

  const resolved = require.resolve(toolPath);
  if (context && context.hotReload) {
    try { delete require.cache[resolved]; } catch (_) {}
  }

  const mod = require(resolved);
  if (!mod || typeof mod.execute !== 'function') {
    throw new Error(`Tool '${cleanName}' is missing a valid execute(args, ctx) function.`);
  }

  return await mod.execute(args || {}, context);
}

module.exports = {
  executeTool,
  getContract,
};
