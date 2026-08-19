import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GlobalStateKey } from '@shared/state/stateKeys';

const state = new Map<string, unknown>();

vi.mock('@platform/platform', () => ({
  platform: () => ({
    globalState: {
      get: <T>(key: string, fallback?: T): T | undefined => {
        if (state.has(key)) return state.get(key) as T;
        return fallback;
      },
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
  }),
}));

const { setCliModelEnabled, listCliEnabledModelCatalog } =
  await import('@cli/runtime/enabledModels');

describe('CLI enabled models catalog', () => {
  beforeEach(() => {
    state.clear();
  });

  it('resolves a CLI spelling and reports the resulting list', async () => {
    state.set(GlobalStateKey.ENABLED_MODELS, ['deepseekproT']);
    const result = await setCliModelEnabled('grok-4.5', true);
    expect(result.model).toBe('grok45');
    expect(result.enabled).toBe(true);
    expect(result.list).toEqual(['deepseekproT', 'grok45']);
  });

  it('rejects an id no CLI model answers to', async () => {
    await expect(setCliModelEnabled('nonexistent-xyz', true)).rejects.toThrow(
      /Unknown model/,
    );
  });

  it('lists catalog rows with enabled flags', () => {
    state.set(GlobalStateKey.ENABLED_MODELS, ['deepseekproT', 'grok45']);
    const catalog = listCliEnabledModelCatalog();
    expect(catalog.find((row) => row.id === 'grok45')?.enabled).toBe(true);
    expect(catalog.find((row) => row.id === 'deepseekproT')?.enabled).toBe(
      true,
    );
  });
});
