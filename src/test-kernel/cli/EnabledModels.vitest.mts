import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { GlobalStateKey } from '@shared/state/stateKeys';

const state = new Map<string, unknown>();

vi.mock('@platform/platform', () => ({
  platform: () => ({
    globalState: {
      get: <T,>(key: string, fallback?: T): T | undefined => {
        if (state.has(key)) return state.get(key) as T;
        return fallback;
      },
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
  }),
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: vi.fn(),
}));

const { getCliEnabledModels, setCliModelEnabled, listCliEnabledModelCatalog } =
  await import('@cli/runtime/enabledModels');

describe('CLI enabled models catalog', () => {
  beforeEach(() => {
    state.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to DEFAULT_MODELS when nothing is stored', () => {
    expect(getCliEnabledModels()).toEqual(DEFAULT_MODELS);
  });

  it('enables a model that is not yet in the list', async () => {
    state.set(GlobalStateKey.ENABLED_MODELS, ['deepseekproT']);
    const result = await setCliModelEnabled('grok45', true);
    expect(result.model).toBe('grok45');
    expect(result.enabled).toBe(true);
    expect(result.list).toEqual(['deepseekproT', 'grok45']);
    expect(getCliEnabledModels()).toContain('grok45');
  });

  it('refuses to disable the last remaining model', async () => {
    state.set(GlobalStateKey.ENABLED_MODELS, ['deepseekproT']);
    await expect(setCliModelEnabled('deepseekproT', false)).rejects.toThrow(
      /at least one model/i,
    );
    expect(getCliEnabledModels()).toEqual(['deepseekproT']);
  });

  it('lists catalog rows with enabled flags', async () => {
    state.set(GlobalStateKey.ENABLED_MODELS, ['deepseekproT', 'grok45']);
    const catalog = listCliEnabledModelCatalog();
    const grok = catalog.find((row) => row.id === 'grok45');
    const deepseek = catalog.find((row) => row.id === 'deepseekproT');
    expect(grok?.enabled).toBe(true);
    expect(deepseek?.enabled).toBe(true);
    expect(catalog.some((row) => row.id === 'deepseekproT')).toBe(true);
  });
});
