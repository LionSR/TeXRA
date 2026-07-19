import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';

import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';

function fakeStateStore(initial: Record<string, unknown> = {}): StateStore {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
  };
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

    const state = fakeStateStore({
      // Simulates a user who already reconciled once under the hash-based
      // scheme (any value > 21, e.g. MODEL_LIST_HASH_BASE + some hash).
      [GlobalStateKey.MODEL_LIST_VERSION]: 5000,
      [GlobalStateKey.ENABLED_MODELS]: ['opus48T', 'grok4'],
    });

    const result = await refreshModelListStateIfNeeded(state);

    expect(result.skipped).toBe(false);
    expect(result.removed).toContain('grok4');
    expect(
      state.get<string[]>(GlobalStateKey.ENABLED_MODELS, []),
    ).not.toContain('grok4');
  });
});
