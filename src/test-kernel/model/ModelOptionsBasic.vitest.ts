// Third-party imports
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - model
import {
  computeModelListVersion,
  DEFAULT_MODELS,
  isDeprecatedModel,
  isRetiredModel,
  MODEL_LIST_VERSION,
  PREFERRED_DEFAULT_MODELS,
  resolveDefaultModels,
} from '@model/modelOptionsBasic';
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

  it('does not include deprecated models', () => {
    expect(DEFAULT_MODELS.filter(isDeprecatedModel)).toEqual([]);
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

describe('computeModelListVersion', () => {
  it('changes when the resolved default set changes', () => {
    const before = computeModelListVersion(['opus5T', 'gemini31p']);
    const afterAdd = computeModelListVersion(['opus5T', 'gemini31p', 'gpt55']);
    const afterRemove = computeModelListVersion(['opus5T']);

    expect(afterAdd).not.toBe(before);
    expect(afterRemove).not.toBe(before);
  });

  it('is order-independent (only set membership drives reconciliation)', () => {
    expect(computeModelListVersion(['opus5T', 'gemini31p'])).toBe(
      computeModelListVersion(['gemini31p', 'opus5T']),
    );
  });

  it('is a pure function of the preferred (unfiltered) list, wired to MODEL_LIST_VERSION', () => {
    expect(MODEL_LIST_VERSION).toBe(
      computeModelListVersion(PREFERRED_DEFAULT_MODELS),
    );
  });

  it('never lands in the pre-#7191 hand-bumped range (1-21), so every existing install reconciles exactly once on upgrade', () => {
    expect(MODEL_LIST_VERSION).toBeGreaterThan(21);
  });

  /**
   * #7216 review: hashing the *resolved* (post-filter) set made the trigger
   * blind to a status transition between two states that both filter out of
   * that set -- most importantly deprecated -> retired. A preferred pick that
   * is merely deprecated is still nominally servable; once the registry marks
   * it retired, `reconcileEnabledModels`'s unconditional retired-model sweep
   * needs to strip it from existing users, which only happens if the version
   * hash actually changes. `gpt54` (deprecated) and `grok4` (retired) both
   * resolve to the same empty set, so a hash of `resolveDefaultModels(...)`
   * output would have collapsed them to the same version.
   */
  it('distinguishes a deprecated preferred pick from a retired one, even though both resolve to an empty set', () => {
    expect(resolveDefaultModels(['gpt54'])).toEqual([]);
    expect(resolveDefaultModels(['grok4'])).toEqual([]);
    expect(computeModelListVersion(['gpt54'])).not.toBe(
      computeModelListVersion(['grok4']),
    );
  });
});
