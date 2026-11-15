'use strict';

const { execSync } = require('child_process');

module.exports = {
  name: 'disk_space_status',
  description: 'Get free and total storage space of Windows drives.',
  tags: ['disk', 'storage', 'drive', 'free space', 'c drive'],
  risk: 'READ',
  parameters: { type: 'object', properties: {} },
  async execute() {
    try {
      const raw = execSync('wmic logicaldisk get Caption,FreeSpace,Size', { timeout: 3000 }).toString();
      const lines = raw.trim().split(/\r?\n/).slice(1);
      const drives = lines.map((l) => {
        const parts = l.trim().split(/\s+/);
        const freeGb = parts[1] ? (Number(parts[1]) / (1024 ** 3)).toFixed(1) : 0;
        const totalGb = parts[2] ? (Number(parts[2]) / (1024 ** 3)).toFixed(1) : 0;
        return { drive: parts[0], free_gb: Number(freeGb), total_gb: Number(totalGb) };
      });
      return { drives };
    } catch (_) {
      return { error: 'disk_info_failed' };
    }
  },
};