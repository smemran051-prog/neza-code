/**
 * PATH: 02_MODULES/system_block/api.js
 * DESC: Unified Gateway for all OS and Hardware level tools.
 */

const path = require('path');
const fs = require('fs');

// Load the block's contract
const moduleContract = require('./module.json');

/**
 * Executes a tool dynamically within the system_block safely.
 * 
 * @param {string} toolName - Exact name of the tool (e.g., 'write_file')
 * @param {object} params - Arguments required by the specific tool
 * @param {object} context - Execution context (session ID, AI state, etc.)
 * @returns {Promise<object>} Standardized result object { status, module, tool, data/error }
 */
async function executeTool(toolName, params, context = {}) {
    try {
        // 1. Security & Registry Check
        if (!moduleContract.registered_tools.includes(toolName)) {
            throw new Error(`Access Denied: Tool '${toolName}' is not registered in system_block/module.json`);
        }

        // 2. Safe Path Resolution
        const toolPath = path.join(__dirname, 'tools', `${toolName}.js`);
        if (!fs.existsSync(toolPath)) {
            throw new Error(`System Error: Tool executable '${toolName}.js' missing in system_block/tools/ directory`);
        }

        // 3. Dynamic Module Load
        const toolModule = require(toolPath);

        // 4. (Future Expansion) Risk Validation & Human Bridge Injection point
        // const riskLevel = toolModule.RISK_LEVEL || moduleContract.default_risk_level;
        // if (riskLevel === 'RISKY') { await triggerHumanBridge(toolName, params); }

        // 5. Execution Contract Check
        if (typeof toolModule.execute !== 'function') {
            throw new Error(`Architecture Error: Tool '${toolName}' missing standardized 'execute(params, context)' function`);
        }

        // 6. Execute Tool
        const result = await toolModule.execute(params, context);

        // 7. Standardized Success Return
        return {
            status: "success",
            module: moduleContract.module_name,
            tool: toolName,
            data: result
        };

    } catch (error) {
        // Centralized Error Logging for System Block
        console.error(`[SYSTEM_BLOCK_ERROR] Tool: ${toolName} | Msg: ${error.message}`);
        
        // Standardized Error Return (Prevents Orchestrator Crash)
        return {
            status: "error",
            module: moduleContract.module_name,
            tool: toolName,
            error: error.message
        };
    }
}

module.exports = {
    executeTool,
    contract: moduleContract
};