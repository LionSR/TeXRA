import { beforeEach, describe, expect, it } from 'vitest';

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

  it('resolves a CLI spelling and reports the resulting list', async () => {
    await state.update(GlobalStateKey.MODEL_SELECTION, {
      enabledExtras: [],
      disabledDefaults: ['grok45'],
    });
    const result = await setCliModelEnabled(state, 'grok-4.5', true);
    expect(result.model).toBe('grok45');
    expect(result.enabled).toBe(true);
    expect(result.list).toEqual(DEFAULT_MODELS);
  });

  it('rejects an id no CLI model answers to', async () => {
    await expect(
      setCliModelEnabled(state, 'nonexistent-xyz', true),
    ).rejects.toThrow(/Unknown model/);
  });

  it('lists catalog rows with enabled flags', async () => {
    await state.update(GlobalStateKey.MODEL_SELECTION, {
      enabledExtras: [],
      disabledDefaults: ['grok45'],
    });
    const catalog = listCliEnabledModelCatalog(state);
    expect(catalog.find((row) => row.id === 'grok45')?.enabled).toBe(false);
    expect(catalog.find((row) => row.id === 'deepseekproT')?.enabled).toBe(
      true,
    );
  });
});
