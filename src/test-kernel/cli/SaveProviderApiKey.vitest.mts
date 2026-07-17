import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  invalidateApiKeyCache: vi.fn(),
  setCliApiMode: vi.fn(),
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: { set: mocks.set } }),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, invalidateApiKeyCache: mocks.invalidateApiKeyCache };
});

vi.mock('@cli/runtime/apiAccessMode', () => ({
  setCliApiMode: mocks.setCliApiMode,
}));

const { saveProviderApiKey } = await import('@cli/runtime/providerApiKey');

describe('saveProviderApiKey', () => {
  beforeEach(() => {
    mocks.set.mockReset().mockResolvedValue(undefined);
    mocks.invalidateApiKeyCache.mockReset();
    mocks.setCliApiMode.mockReset().mockResolvedValue(undefined);
  });

  it('stores the trimmed key, drops the key cache, and switches to personal mode', async () => {
    await saveProviderApiKey('anthropic', '  sk-ant-secret  ');
    expect(mocks.set).toHaveBeenCalledWith('apiKey.anthropic', 'sk-ant-secret');
    expect(mocks.invalidateApiKeyCache).toHaveBeenCalledOnce();
    // Model-options invalidation is setCliApiMode's responsibility, not ours.
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
  });

  it('rejects an empty key without writing a secret or changing mode', async () => {
    await expect(saveProviderApiKey('anthropic', '   ')).rejects.toThrow(
      'empty',
    );
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
  });

  it('returns no credential-derived text', async () => {
    await expect(
      saveProviderApiKey('openai', 'sk-super-secret-value'),
    ).resolves.toBeUndefined();
  });

  it('writes the secret before invalidating the key cache', async () => {
    // The only correctness-critical ordering: the secret must be written before
    // the key cache is dropped, or a concurrent read could repopulate a stale
    // "no key" entry for the 5s TTL. The position of setCliApiMode relative to
    // these is NOT load-bearing, so it is intentionally not asserted.
    const order: string[] = [];
    mocks.set.mockImplementation(async () => {
      order.push('set');
    });
    mocks.invalidateApiKeyCache.mockImplementation(() => {
      order.push('invalidateApiKeyCache');
    });

    await saveProviderApiKey('anthropic', 'sk-ant-secret');

    expect(order.indexOf('set')).toBeLessThan(
      order.indexOf('invalidateApiKeyCache'),
    );
  });
});
