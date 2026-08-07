import { describe, expect, it } from 'vitest';

import { CliUsageError } from '@cli/runtime/cliContext';
import { assertExplicitModelKnown } from '@cli/runtime/runModel';

describe('assertExplicitModelKnown', () => {
  it.each([undefined, '', '   '])(
    'returns undefined when no model flag was passed (%j)',
    (input) => {
      expect(assertExplicitModelKnown(input)).toBeUndefined();
    },
  );

  it.each([
    ['sonnet46T', 'sonnet46T'],
    ['  deepseekT  ', 'deepseekT'],
  ])('returns the trimmed value for a known model id (%s)', (input, id) => {
    expect(assertExplicitModelKnown(input)).toBe(id);
  });

  it.each([
    ['glm5.2', 'glm52'],
    ['GLM-5.2', 'glm52'],
    ['glm-5.2', 'glm52'],
  ])('normalizes user-facing model name %s to registry id %s', (input, id) => {
    expect(assertExplicitModelKnown(input)).toBe(id);
  });

  it('rejects ambiguous provider model names', () => {
    expect(() => assertExplicitModelKnown('claude-opus-4-7')).toThrow(
      CliUsageError,
    );
  });

  it('throws a CliUsageError for an unknown model id', () => {
    const attempt = () => assertExplicitModelKnown('nonexistent-model-xyz');

    expect(attempt).toThrow(CliUsageError);
    expect(attempt).toThrow(/Model not found: nonexistent-model-xyz/);
    expect(attempt).toThrow(/texra models list/);
  });
});
