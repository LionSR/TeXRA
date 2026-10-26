import { describe, expect, it } from 'vitest';

import { normalizeToolUse } from '@shared/toolUse';

describe('normalizeToolUse (packages/harness/src/shared/toolUse.ts)', () => {
  // Regression: a previous inline refactor of `formatOutputText` dropped
  // the explicit `null` short-circuit that `stringifyWithLanguage` had,
  // so `output: null` fell through to `yaml.stringify(null)` and surfaced
  // the literal text "null" in the rendered output section. Verify both
  // the top-level and nested cases stay empty.
  it('renders null output as empty text, not the string "null"', () => {
    const topLevel = normalizeToolUse({
      toolName: 'Bash',
      input: { command: 'true' },
      output: null,
      status: 'completed',
    });
    expect(topLevel?.outputText).toBe('');

    const nested = normalizeToolUse({
      toolName: 'Bash',
      input: { command: 'true' },
      output: { output: null, summary: 'ran ok' },
      status: 'completed',
    });
    expect(nested?.outputText).toBe('');
    expect(nested?.headerSummary).toBe('ran ok');
  });
});
