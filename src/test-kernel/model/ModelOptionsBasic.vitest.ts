// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - model
import {
  DEFAULT_MODELS,
  isDeprecatedModel,
  isRetiredModel,
  resolveDefaultModels,
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
});

/**
 * #7191: DEFAULT_MODELS was a hand-maintained literal array and
 * MODEL_LIST_VERSION a hand-bumped integer -- a model retiring underneath the
 * literal list left it dangling with no automatic removal, and a maintainer
 * had to remember to bump the version whenever the resolved defaults changed.
 * `resolveDefaultModels` and `computeModelListVersion` make both derive from
 * the live registry instead. These tests exercise the mechanism directly
 * against real registry data (grok4, retired live in the registry today, same
 * as SetupModelDefaults.vitest.ts's #7081 regression) rather than only
 * asserting today's already-passing DEFAULT_MODELS snapshot.
 */
describe('resolveDefaultModels', () => {
  it('drops a preferred pick the live registry marks retired', () => {
    expect(MODEL_CONFIGS.grok4?.retired).toBe(true);
    const resolved = resolveDefaultModels(['opus5T', 'grok4']);
    expect(resolved).toEqual(['opus5T']);
  });

  it('drops a preferred pick the live registry marks deprecated', () => {
    expect(MODEL_CONFIGS.gpt54?.deprecated).toBe(true);
    const resolved = resolveDefaultModels(['opus5T', 'gpt54']);
    expect(resolved).toEqual(['opus5T']);
  });

  it('keeps every preferred pick when none are retired or deprecated', () => {
    const preferred = ['opus5T', 'gemini31p'];
    expect(resolveDefaultModels(preferred)).toEqual(preferred);
  });
});
