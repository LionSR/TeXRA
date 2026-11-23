import { describe, expect, it } from 'vitest';

import { toolCallOutput } from '@shared/toolUse';

describe('toolCallOutput (packages/harness/src/shared/toolUse.ts)', () => {
  // Regression: a previous inline refactor of `formatOutputText` dropped
  // the explicit `null` short-circuit that `stringifyWithLanguage` had,
  // so `output: null` fell through to `yaml.stringify(null)` and surfaced
  // the literal text "null" in the rendered output section.
  it('renders null output as empty text, not the string "null"', () => {
    const topLevel = toolCallOutput({
      toolName: 'Bash',
      input: { command: 'true' },
      output: null,
      status: 'completed',
    });
    expect(topLevel.text).toBe('');
  });
});
