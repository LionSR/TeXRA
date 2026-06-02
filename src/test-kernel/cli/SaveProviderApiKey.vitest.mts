import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  invalidateApiKeyCache: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
  setCliApiMode: vi.fn(),
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: { set: mocks.set } }),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, invalidateApiKeyCache: mocks.invalidateApiKeyCache };
});

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
}));

vi.mock('@cli/runtime/apiAccessMode', () => ({
  setCliApiMode: mocks.setCliApiMode,
}));

const { saveProviderApiKey } =
  await import('@cli/onboarding/applyOnboardingResult');

describe('saveProviderApiKey', () => {
  beforeEach(() => {
    mocks.set.mockReset().mockResolvedValue(undefined);
    mocks.invalidateApiKeyCache.mockReset();
    mocks.invalidateModelOptionsCache.mockReset();
    mocks.setCliApiMode.mockReset().mockResolvedValue(undefined);
  });

  it('stores the trimmed key, drops caches, and switches to personal mode', async () => {
    const message = await saveProviderApiKey('anthropic', '  sk-ant-secret  ');
    expect(mocks.set).toHaveBeenCalledWith('apiKey.anthropic', 'sk-ant-secret');
    expect(mocks.invalidateApiKeyCache).toHaveBeenCalledOnce();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(message).toContain('apiKey.anthropic');
  });

  it('rejects an empty key without writing a secret or changing mode', async () => {
    await expect(saveProviderApiKey('anthropic', '   ')).rejects.toThrow(
      'empty',
    );
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
  });

  it('never echoes the raw key in the returned message', async () => {
    const message = await saveProviderApiKey('openai', 'sk-super-secret-value');
    expect(message).not.toContain('sk-super-secret-value');
  });

  it('writes the secret before invalidating caches', async () => {
    // The only correctness-critical ordering: the secret must be written before
    // the key cache is dropped, or a concurrent read could repopulate a stale
    // "no key" entry for the 5s TTL. (Order between the two invalidations and
    // the mode switch is not load-bearing.)
    const order: string[] = [];
    mocks.set.mockImplementation(async () => {
      order.push('set');
    });
    mocks.invalidateApiKeyCache.mockImplementation(() => {
      order.push('invalidateApiKeyCache');
    });
    mocks.setCliApiMode.mockImplementation(async () => {
      order.push('setCliApiMode');
    });

    await saveProviderApiKey('anthropic', 'sk-ant-secret');

    expect(order.indexOf('set')).toBeLessThan(
      order.indexOf('invalidateApiKeyCache'),
    );
    expect(order.indexOf('invalidateApiKeyCache')).toBeLessThan(
      order.indexOf('setCliApiMode'),
    );
  });
});
