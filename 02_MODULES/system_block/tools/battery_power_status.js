'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'battery_power_status',
  description: 'Check laptop battery percentage and whether charger is connected.',
  tags: ['battery', 'charge', 'power', 'plugged', 'charger'],
  risk: 'READ',
  parameters: { type: 'object', properties: {} },
  async execute() {
    try {
      const out = execSync('powershell -Command "Get-CimInstance -ClassName Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus"', { timeout: 3000 }).toString();
      const pctMatch = out.match(/\b\d{1,3}\b/);
      return {
        charge_percent: pctMatch ? Number(pctMatch[0]) : 'unknown',
        raw_output: out.trim(),
      };
    } catch (_) {
      return { error: 'battery_info_unavailable' };
    }
  },
};