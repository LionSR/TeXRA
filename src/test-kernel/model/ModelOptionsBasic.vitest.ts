// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - model
import { DEFAULT_MODELS, isRetiredModel } from '@model/modelOptionsBasic';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

describe('default helper model', () => {
  it('resolves to a valid, non-deprecated DeepSeek model in llm-zoo', () => {
    const config = MODEL_CONFIGS[DEFAULT_HELPER_MODEL];

    expect(config).toBeDefined();
    expect(config.provider).toBe('deepseek');
    expect(config.deprecated ?? false).toBe(false);
  });
});

describe('default model list', () => {
  it('includes Gemini 3.5 Flash as a free-tier relay model', () => {
    const config = MODEL_CONFIGS.gemini35f;

    expect(DEFAULT_MODELS).toContain('gemini35f');
    expect(config).toMatchObject({
      fullName: 'gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      provider: 'google',
      openRouterOnly: false,
    });
    expect(config.deprecated ?? false).toBe(false);
    expect(config.inputPrice).toBeLessThanOrEqual(3);
  });

  it('includes Fable 5 as a default model', () => {
    const config = MODEL_CONFIGS.fable5;

    expect(DEFAULT_MODELS).toContain('fable5');
    expect(config).toMatchObject({
      fullName: 'claude-fable-5',
      label: 'Claude Fable 5',
      provider: 'anthropic',
      openRouterOnly: false,
    });
    expect(config.deprecated ?? false).toBe(false);
    expect(config.inputPrice).toBe(10);
    expect(config.outputPrice).toBe(50);
    expect(config.contextWindow).toBe(1_000_000);
    expect(config.maxOutputTokens).toBe(128_000);
  });

  it('only contains model ids known by llm-zoo', () => {
    expect(DEFAULT_MODELS.filter((model) => !MODEL_CONFIGS[model])).toEqual([]);
  });

  it('does not include retired models', () => {
    expect(DEFAULT_MODELS.filter(isRetiredModel)).toEqual([]);
  });
});
