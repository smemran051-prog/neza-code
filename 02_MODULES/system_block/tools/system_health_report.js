'use strict';

/**
 * Tool: system_health_report
 * Purpose: Inspect OS memory, CPU cores, uptime, and system load.
 */

const os = require('os');

module.exports = {
  name: 'system_health_report',
  description: 'A1. Check Windows PC hardware health, free RAM, total memory, CPU model, and system uptime.',
  tags: ['system', 'health', 'ram', 'memory', 'cpu', 'uptime', 'pc', 'status', 'hardware', 'check'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      detailed: {
        type: 'boolean',
        description: 'Set true to include CPU core details and network hostname.',
      },
    },
  },
  async execute(args, ctx) {
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
    const usedMemMb = totalMemMb - freeMemMb;
    const uptimeHours = (os.uptime() / 3600).toFixed(2);
    const cpus = os.cpus() || [];

    const report = {
      status: 'healthy',
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      memory: {
        used_mb: usedMemMb,
        free_mb: freeMemMb,
        total_mb: totalMemMb,
        usage_percent: Math.round((usedMemMb / totalMemMb) * 100),
      },
      os_uptime_hours: Number(uptimeHours),
      jarvis_mode: ctx?.settings?.mode || 'SEMI_AUTO',
    };

    if (args && args.detailed) {
      report.hostname = os.hostname();
      report.cpu_model = cpus[0] ? cpus[0].model.trim() : 'Unknown CPU';
      report.cpu_cores = cpus.length;
    }

    return report;
  },
};