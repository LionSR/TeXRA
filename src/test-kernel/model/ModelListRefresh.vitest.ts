import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';
import {
  computeModelListVersion,
  DEFAULT_MODELS,
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
    expect(result.reordered).toBe(false);
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
    expect(result.reordered).toBe(false);
    expect(enabledModels(state)).not.toContain('grok4');
  });

  it('adds Gemini 3.7 Flash while preserving Gemini 3.6 Flash from the previous model list', async () => {
    const previousVersion = 494_338_219;
    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: previousVersion,
      [GlobalStateKey.ENABLED_MODELS]: ['gemini36f'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.previousVersion).toBe(previousVersion);
    expect(result.added).toContain('gemini37f');
    expect(result.removed).not.toContain('gemini36f');
    expect(enabledModels(state)).toContain('gemini37f');
    expect(enabledModels(state)).toContain('gemini36f');
    expect(state.get(GlobalStateKey.MODEL_LIST_VERSION)).toBe(
      MODEL_LIST_VERSION,
    );
  });

  it('clears a deprecated Copilot route preference while preserving the enabled model', async () => {
    expect(MODEL_CONFIGS.gemini36f?.deprecated).toBe(true);
    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION,
      [GlobalStateKey.ENABLED_MODELS]: ['gemini36f'],
      [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini36f', 'gemini31p'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.skipped).toBe(false);
    expect(result.routePreferencesCleared).toEqual(['gemini36f']);
    expect(state.get<string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS)).toEqual([
      'gemini31p',
    ]);
    expect(enabledModels(state)).toContain('gemini36f');
  });

  it('clears a retired Copilot route preference', async () => {
    expect(MODEL_CONFIGS.kimi2?.retired).toBe(true);
    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION,
      [GlobalStateKey.ENABLED_MODELS]: ['sonnet5T'],
      [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['kimi2', 'gemini31p'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.skipped).toBe(false);
    expect(result.routePreferencesCleared).toEqual(['kimi2']);
    expect(state.get<string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS)).toEqual([
      'gemini31p',
    ]);
    expect(enabledModels(state)).toEqual(['sonnet5T']);
  });

  it('is idempotent once the stale Copilot route preference is cleared', async () => {
    expect(MODEL_CONFIGS.gemini36f?.deprecated).toBe(true);
    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION,
      [GlobalStateKey.ENABLED_MODELS]: ['gemini36f'],
      [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini36f', 'gemini31p'],
    });

    const first = await refreshModelListStateIfNeeded(state);
    const second = await refreshModelListStateIfNeeded(state);

    expect(first.skipped).toBe(false);
    expect(first.routePreferencesCleared).toEqual(['gemini36f']);
    expect(second.skipped).toBe(true);
    expect(second.routePreferencesCleared).toEqual([]);
    expect(state.get<string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS)).toEqual([
      'gemini31p',
    ]);
    expect(enabledModels(state)).toContain('gemini36f');
  });

  it('still reconciles enabled models and version when the route write fails', async () => {
    expect(MODEL_CONFIGS.grok4?.retired).toBe(true);
    expect(MODEL_CONFIGS.kimi2?.retired).toBe(true);
    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION - 1,
      [GlobalStateKey.ENABLED_MODELS]: ['grok4'],
      [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['kimi2'],
    });
    const failingState = {
      get: <T>(key: string): T | undefined => state.get<T>(key),
      update: async (key: string, value: unknown): Promise<void> => {
        if (key === GlobalStateKey.COPILOT_ROUTE_MODELS) {
          throw new Error('route write failed');
        }
        await state.update(key, value);
      },
    };

    await expect(refreshModelListStateIfNeeded(failingState)).rejects.toThrow(
      'route write failed',
    );

    expect(state.get<string[]>(GlobalStateKey.ENABLED_MODELS)).toEqual([
      ...DEFAULT_MODELS,
    ]);
    expect(state.get(GlobalStateKey.MODEL_LIST_VERSION)).toBe(
      MODEL_LIST_VERSION,
    );
    expect(state.get<string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS)).toEqual([
      'kimi2',
    ]);
  });

  it('keeps active Copilot route preferences untouched', async () => {
    const state = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION,
      [GlobalStateKey.ENABLED_MODELS]: ['sonnet5T'],
      [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.skipped).toBe(true);
    expect(result.routePreferencesCleared).toEqual([]);
    expect(state.get<string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS)).toEqual([
      'gemini31p',
    ]);
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
