import { MODEL_CONFIGS } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

import { resolveReasoningLevel } from '@model/reasoningLevel';

describe('resolveReasoningLevel', () => {
  it.each([
    {
      name: 'fixed reasoning without per-request effort control',
      config: MODEL_CONFIGS.glm45,
      override: 'low',
      expected: { kind: 'fixed', level: 'high' },
    },
    {
      name: 'configurable max reasoning with declared supported efforts',
      config: MODEL_CONFIGS.glm53,
      override: 'low',
      expected: {
        kind: 'configurable',
        defaultLevel: 'max',
        overrideLevel: 'low',
      },
    },
    {
      name: 'Kimi K3 fixed max reasoning without declared supported efforts',
      config: MODEL_CONFIGS.kimi3,
      override: 'low',
      expected: { kind: 'fixed', level: 'max' },
    },
    {
      name: 'configurable reasoning',
      config: MODEL_CONFIGS.gpt56,
      override: 'none',
      expected: {
        kind: 'configurable',
        defaultLevel: 'medium',
        overrideLevel: 'none',
      },
    },
    {
      name: 'non-reasoning model',
      config: MODEL_CONFIGS.haiku45,
      override: 'high',
      expected: undefined,
    },
    {
      name: 'reasoning model with only a none declaration',
      config: MODEL_CONFIGS.opus41T,
      override: 'high',
      expected: undefined,
    },
  ])('resolves $name', ({ config, override, expected }) => {
    expect(resolveReasoningLevel(config, override)).toEqual(expected);
  });

  it('uses the declared default and ignores stale overrides', () => {
    expect(resolveReasoningLevel(MODEL_CONFIGS.gpt56)).toEqual({
      kind: 'configurable',
      defaultLevel: 'medium',
    });
    expect(resolveReasoningLevel(MODEL_CONFIGS.gpt56, 'stale')).toEqual({
      kind: 'configurable',
      defaultLevel: 'medium',
    });
  });
});
