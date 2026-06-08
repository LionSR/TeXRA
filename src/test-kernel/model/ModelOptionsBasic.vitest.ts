// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - model
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';

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

  it('only contains model ids known by llm-zoo', () => {
    expect(DEFAULT_MODELS.filter((model) => !MODEL_CONFIGS[model])).toEqual([]);
  });
});
