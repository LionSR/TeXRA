import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  migrateCopilotModelRouteSelections,
  refreshModelListStateIfNeeded,
} from '@model/modelListRefresh';

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
  it('strips a retired model even when previousVersion is already a hash-derived value past the legacy migration threshold', async () => {
    expect(MODEL_CONFIGS.grok4?.retired).toBe(true);

    const state = new FakeStateStore({
      // Simulates a user who already reconciled once under the hash-based
      // scheme (any value > 21, e.g. MODEL_LIST_HASH_BASE + some hash).
      [GlobalStateKey.MODEL_LIST_VERSION]: 5000,
      [GlobalStateKey.ENABLED_MODELS]: ['opus48T', 'grok4'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.skipped).toBe(false);
    expect(result.removed).toContain('grok4');
    expect(enabledModels(state)).not.toContain('grok4');
  });
});

/**
 * #9635: persisted `copilot:<baseModel>` selections (written while Copilot
 * models were synthetic picker identities) migrate once to the canonical base
 * model id, preserving the Copilot route preference. Temporary coverage:
 * delete together with the migration (retirement target 2026-11-03).
 */
describe('migrateCopilotModelRouteSelections', () => {
  it('rewrites copilot selections to base ids and records the route preference', async () => {
    const state = new FakeStateStore({
      [GlobalStateKey.ENABLED_MODELS]: ['gpt55', 'copilot:sonnet46'],
      [GlobalStateKey.HELPER_MODEL]: 'copilot:gpt56',
      [GlobalStateKey.REASONING_LEVELS]: {
        'copilot:sonnet46': 'high',
        gpt55: 'low',
      },
    });

    await migrateCopilotModelRouteSelections(state);

    expect(enabledModels(state)).toEqual(['gpt55', 'sonnet46']);
    expect(state.get<string>(GlobalStateKey.HELPER_MODEL)).toBe('gpt56');
    expect(
      state.get<Record<string, string>>(GlobalStateKey.REASONING_LEVELS, {}),
    ).toEqual({ sonnet46: 'high', gpt55: 'low' });
    expect(
      state.get<string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS, []),
    ).toEqual(expect.arrayContaining(['sonnet46', 'gpt56']));
    expect(state.get<number>(GlobalStateKey.COPILOT_ROUTE_MIGRATION)).toBe(1);
  });

  it('dedupes a base model already enabled alongside its copilot entry', async () => {
    const state = new FakeStateStore({
      [GlobalStateKey.ENABLED_MODELS]: ['sonnet46', 'copilot:sonnet46'],
    });

    await migrateCopilotModelRouteSelections(state);

    expect(enabledModels(state)).toEqual(['sonnet46']);
    expect(
      state.get<string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS, []),
    ).toEqual(['sonnet46']);
  });

  it('runs only once and leaves canonical state untouched', async () => {
    const state = new FakeStateStore({
      [GlobalStateKey.ENABLED_MODELS]: ['gpt55'],
      [GlobalStateKey.COPILOT_ROUTE_MIGRATION]: 1,
    });

    await migrateCopilotModelRouteSelections(state);

    expect(enabledModels(state)).toEqual(['gpt55']);
    expect(
      state.get<string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS),
    ).toBeUndefined();
  });

  it('keeps a pre-existing canonical reasoning override over the copilot one', async () => {
    const state = new FakeStateStore({
      [GlobalStateKey.REASONING_LEVELS]: {
        'copilot:sonnet46': 'high',
        sonnet46: 'low',
      },
    });

    await migrateCopilotModelRouteSelections(state);

    expect(
      state.get<Record<string, string>>(GlobalStateKey.REASONING_LEVELS, {}),
    ).toEqual({ sonnet46: 'low' });
  });
});
