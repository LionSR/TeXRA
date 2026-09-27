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
  DEFAULT_HELPER_MODEL,
  isExpensiveModel,
} from '@shared/constants/providers';

describe('default helper model', () => {
  it('resolves to a valid, non-deprecated DeepSeek model in llm-zoo', () => {
    const config = MODEL_CONFIGS[DEFAULT_HELPER_MODEL];

    expect(config).toBeDefined();
    expect(config.provider).toBe('deepseek');
    expect(config.deprecated ?? false).toBe(false);
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

describe('premium pricing hint', () => {
  // Name matching (`gpt<digits>pro`) flagged the $4/$20 gpt56pro and missed
  // the $150/$600 o1pro; the hint follows the price.
  it('flags models by output price, not by a Pro-shaped name', () => {
    expect(isExpensiveModel(MODEL_CONFIGS.o1pro.outputPrice)).toBe(true);
    expect(isExpensiveModel(MODEL_CONFIGS.gpt56pro.outputPrice)).toBe(false);
  });
});
