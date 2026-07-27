// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - CLI runtime
import {
  CLI_API_MODE_INPUTS,
  parseCliApiMode,
  setCliApiMode,
} from '@cli/runtime/apiAccessMode';

// Local imports - shared state
import { GlobalStateKey } from '@shared/state/stateKeys';

const mocks = vi.hoisted(() => ({
  invalidateModelOptionsCache: vi.fn(),
  setUseIncludedModelAccess: vi.fn(),
  updateGlobalState: vi.fn(),
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => ({
    setUseIncludedModelAccess: mocks.setUseIncludedModelAccess,
  }),
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    globalState: {
      update: mocks.updateGlobalState,
    },
  }),
}));

describe('CLI API access mode aliases', () => {
  it('parses every advertised API mode input', () => {
    expect(CLI_API_MODE_INPUTS.every((input) => parseCliApiMode(input))).toBe(
      true,
    );
  });

  it('maps the relay and byok shorthands to their canonical modes', () => {
    expect(parseCliApiMode('relay')).toBe('included');
    expect(parseCliApiMode('byok')).toBe('personal');
  });

  it('rejects the removed undocumented synonyms', () => {
    for (const removed of ['texra', 'direct', 'api', 'key', 'keys']) {
      expect(parseCliApiMode(removed)).toBeUndefined();
    }
  });
});

describe('CLI API access mode settings', () => {
  beforeEach(() => {
    mocks.invalidateModelOptionsCache.mockClear();
    mocks.setUseIncludedModelAccess.mockReset();
    mocks.updateGlobalState.mockReset();
  });

  it('turns off OpenRouter routing when switching to included access', async () => {
    await setCliApiMode('included');

    expect(mocks.setUseIncludedModelAccess).toHaveBeenCalledWith(true);
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      GlobalStateKey.USE_OPENROUTER,
      false,
    );
    expect(mocks.updateGlobalState).toHaveBeenCalledBefore(
      mocks.setUseIncludedModelAccess,
    );
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledTimes(1);
  });

  it('leaves OpenRouter routing unchanged when switching to personal keys', async () => {
    await setCliApiMode('personal');

    expect(mocks.setUseIncludedModelAccess).toHaveBeenCalledWith(false);
    expect(mocks.updateGlobalState).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledTimes(1);
  });
});
