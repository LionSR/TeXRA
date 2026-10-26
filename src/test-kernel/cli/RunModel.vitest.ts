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
    ['anthropic/claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5'],
    ['  deepseek/deepseek-flash@high  ', 'deepseek/deepseek-flash@high'],
    ['openai/gpt-5.6-sol@xhigh+pro', 'openai/gpt-5.6-sol@xhigh+pro'],
  ])('returns the trimmed value for a known model string (%s)', (input, id) => {
    expect(assertExplicitModelKnown(input)).toBe(id);
  });

  it.each([
    ['glm5.2', 'glm/glm-5.2'],
    ['GLM-5.2', 'glm/glm-5.2'],
    ['glm-5.2', 'glm/glm-5.2'],
    ['claude-opus-5-5', 'anthropic/claude-opus-5-5'],
  ])(
    'normalizes user-facing model name %s to model reference %s',
    (input, id) => {
      expect(assertExplicitModelKnown(input)).toBe(id);
    },
  );

  it('rejects a label two models share', () => {
    expect(() => assertExplicitModelKnown('DeepSeek V3.2')).toThrow(
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
