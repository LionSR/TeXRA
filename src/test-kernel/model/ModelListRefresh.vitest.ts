import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';
import {
  computeModelListVersion,
  MODEL_LIST_VERSION,
  PREFERRED_DEFAULT_MODELS,
} from '@model/modelOptionsBasic';
import { staticModelConfigEntries } from '@model/runtimeModelRegistry';

import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

function enabledModels(state: FakeStateStore): string[] {
  return state.get<string[]>(GlobalStateKey.ENABLED_MODELS, []);
}

/**
 * #7216 review: the retired-model sweep in `reconcileEnabledModels` used to
 * be gated behind `previousVersion < 21`, a threshold frozen from the
 * hand-bumped MODEL_LIST_VERSION scheme this file used before #7191. Since
 * #7191, MODEL_LIST_VERSION is a registry-derived hash that always lands
 * above 21 (see `MODEL_LIST_HASH_BASE` in modelOptionsBasic.ts) -- so once a
 * user's persisted version is itself hash-derived, that legacy gate could
 * never fire again, silently leaving a newly-retired model stuck in an
 * existing user's enabled-models list forever. The sweep must keep firing on
 * every reconciliation regardless of which versioning scheme produced
 * `previousVersion`.
 */
describe('refreshModelListStateIfNeeded', () => {
  it('reconciles when a non-preferred model retires in a catalogue update', async () => {
    expect(MODEL_CONFIGS.kimi2?.retired).toBe(true);
    const previousCatalogue = staticModelConfigEntries().map(
      ([model, config]) =>
        [
          model,
          model === 'kimi2' ? { ...config, retired: false } : config,
        ] as const,
    );
    const previousVersion = computeModelListVersion(
      PREFERRED_DEFAULT_MODELS,
      previousCatalogue,
    );
    expect(previousVersion).toBe(MODEL_LIST_VERSION);

    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: previousVersion,
      [GlobalStateKey.ENABLED_MODELS]: ['opus5T', 'kimi2'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.skipped).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.removed).toContain('kimi2');
    expect(enabledModels(state)).toEqual(['opus5T']);
  });

  it('strips a retired model when the preferred-model version is unchanged', async () => {
    expect(MODEL_CONFIGS.grok4?.retired).toBe(true);

    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION,
      [GlobalStateKey.ENABLED_MODELS]: ['opus48T', 'grok4'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.skipped).toBe(false);
    expect(result.removed).toContain('grok4');
    expect(enabledModels(state)).not.toContain('grok4');
  });

  it('restabilizes a Gemini-first list so the curated default leads', async () => {
    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION,
      [GlobalStateKey.ENABLED_MODELS]: ['gemini31p', 'sonnet5T', 'custom'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.skipped).toBe(false);
    expect(result.reordered).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(enabledModels(state)).toEqual(['sonnet5T', 'gemini31p', 'custom']);
  });
});
