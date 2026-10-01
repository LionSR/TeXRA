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
    ['anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6'],
    ['  deepseek/deepseek-flash@high  ', 'deepseek/deepseek-flash@high'],
    ['openai/gpt-5.6-sol@xhigh+pro', 'openai/gpt-5.6-sol@xhigh+pro'],
  ])('returns the trimmed value for a known model string (%s)', (input, id) => {
    expect(assertExplicitModelKnown(input)).toBe(id);
  });

  it.each([
    ['sonnet46T', 'anthropic/claude-sonnet-4-6@high'],
    ['deepseekT', 'deepseek/deepseek-v4-flash@high'],
  ])('reads llm-zoo 1.x key %s as the model string %s', (input, id) => {
    expect(assertExplicitModelKnown(input)).toBe(id);
  });

  it.each([
    ['glm5.2', 'glm/glm-5.2'],
    ['GLM-5.2', 'glm/glm-5.2'],
    ['glm-5.2', 'glm/glm-5.2'],
    // One entry per API id: the Opus 4.7 thinking variant is no longer a
    // second registry key sharing this spelling.
    ['claude-opus-4-7', 'anthropic/claude-opus-4-7'],
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
