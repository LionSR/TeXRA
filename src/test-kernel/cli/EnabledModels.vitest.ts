import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import {
  listCliEnabledModelCatalog,
  setCliModelEnabled,
} from '@cli/runtime/enabledModels';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

let state: FakeStateStore;

describe('CLI enabled models catalog', () => {
  beforeEach(() => {
    state = new FakeStateStore();
  });

  it.effect('resolves a CLI spelling and reports the resulting list', () =>
    Effect.gen(function* () {
      yield* state.update(GlobalStateKey.MODEL_SELECTION, {
        enabledExtras: [],
        disabledDefaults: ['grok45'],
      });
      const result = yield* setCliModelEnabled(state, 'grok-4.5', true);
      expect(result.model).toBe('grok45');
      expect(result.enabled).toBe(true);
      expect(result.list).toEqual(DEFAULT_MODELS);
    }),
  );

  it.effect('rejects an id no CLI model answers to', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        setCliModelEnabled(state, 'nonexistent-xyz', true),
      );
      expect(error.message).toMatch(/Unknown model/);
    }),
  );

  it.effect('lists catalog rows with enabled flags', () =>
    Effect.gen(function* () {
      yield* state.update(GlobalStateKey.MODEL_SELECTION, {
        enabledExtras: [],
        disabledDefaults: ['grok45'],
      });
      const catalog = yield* listCliEnabledModelCatalog(state);
      expect(catalog.find((row) => row.id === 'grok45')?.enabled).toBe(false);
      expect(catalog.find((row) => row.id === 'deepseekproT')?.enabled).toBe(
        true,
      );
    }),
  );
});
