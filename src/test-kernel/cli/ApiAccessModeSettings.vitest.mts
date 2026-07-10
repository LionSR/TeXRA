import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setCliApiMode } from '@cli/runtime/apiAccessMode';
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

function expectOpenRouterClearedBeforeIncludedAccess(): void {
  const [clearOrder] = mocks.updateGlobalState.mock.invocationCallOrder;
  const [enableOrder] =
    mocks.setUseIncludedModelAccess.mock.invocationCallOrder;
  if (clearOrder == null || enableOrder == null) {
    throw new Error('missing API-mode side-effect call order');
  }
  expect(clearOrder).toBeLessThan(enableOrder);
}

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
    expectOpenRouterClearedBeforeIncludedAccess();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledTimes(1);
  });

  it('leaves OpenRouter routing unchanged when switching to personal keys', async () => {
    await setCliApiMode('personal');

    expect(mocks.setUseIncludedModelAccess).toHaveBeenCalledWith(false);
    expect(mocks.updateGlobalState).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledTimes(1);
  });
});
