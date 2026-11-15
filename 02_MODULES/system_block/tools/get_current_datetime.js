'use strict';

module.exports = {
  name: 'get_current_datetime',
  description: 'Get local system date, time, day name, and ISO string.',
  tags: ['time', 'date', 'today', 'clock', 'now'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const now = new Date();
    return {
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString(),
      day: now.toLocaleDateString(undefined, { weekday: 'long' }),
      iso: now.toISOString(),
      timestamp_ms: now.getTime(),
    };
  },
};