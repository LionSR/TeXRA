// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - model
import {
  DEFAULT_MODELS,
  isDeprecatedModel,
  isRetiredModel,
} from '@model/modelOptionsBasic';
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_HELPER_MODEL,
} from '@shared/constants/providers';

describe('default helper model', () => {
  it('resolves to a valid, non-deprecated DeepSeek model in llm-zoo', () => {
    const config = MODEL_CONFIGS[DEFAULT_HELPER_MODEL];

    expect(config).toBeDefined();
    expect(config.provider).toBe('deepseek');
    expect(config.deprecated ?? false).toBe(false);
  });
});

describe('default agent model', () => {
  it('is the first default-list entry and is not a Gemini model', () => {
    const config = MODEL_CONFIGS[DEFAULT_AGENT_MODEL];

    expect(DEFAULT_AGENT_MODEL).toBe(DEFAULT_MODELS[0]);
    expect(DEFAULT_AGENT_MODEL.startsWith('gemini')).toBe(false);
    expect(config).toBeDefined();
    expect(config.deprecated ?? false).toBe(false);
    expect(config.retired ?? false).toBe(false);
  });
});

describe('default model list', () => {
  it('only contains model ids known by llm-zoo', () => {
    expect(DEFAULT_MODELS.filter((model) => !MODEL_CONFIGS[model])).toEqual([]);
  });

  // The list is literal data: an llm-zoo bump that retires or deprecates an
  // entry fails here and the entry is replaced by hand.
  it('only contains live, non-deprecated models', () => {
    expect(
      DEFAULT_MODELS.filter(
        (model) => isRetiredModel(model) || isDeprecatedModel(model),
      ),
    ).toEqual([]);
  });
});
