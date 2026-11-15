'use strict';

module.exports = {
  name: 'calculate_expression',
  description: 'Safely evaluate pure mathematical expressions.',
  tags: ['math', 'calc', 'calculate', 'formula', 'evaluate'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression (e.g. (45 * 2) + 120 / 4).' },
    },
    required: ['expression'],
  },
  async execute(args) {
    const expr = String(args.expression || '').trim();
    if (!/^[0-9+\-*/().\s^%]+$/.test(expr)) return { error: 'invalid_characters_in_math_expression' };
    try {
      const result = Function(`'use strict'; return (${expr})`)();
      return { expression: expr, result: Number(result) };
    } catch (_) {
      return { error: 'math_evaluation_error' };
    }
  },
};