import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  invalidateApiKeyCache: vi.fn(),
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: { set: mocks.set } }),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, invalidateApiKeyCache: mocks.invalidateApiKeyCache };
});

const { saveProviderApiKey } = await import('@cli/runtime/providerApiKey');

describe('saveProviderApiKey', () => {
  beforeEach(() => {
    mocks.set.mockReset().mockResolvedValue(undefined);
    mocks.invalidateApiKeyCache.mockReset();
  });

  it('stores the trimmed key and drops the key cache', async () => {
    await saveProviderApiKey('anthropic', '  sk-ant-secret  ');
    expect(mocks.set).toHaveBeenCalledWith('apiKey.anthropic', 'sk-ant-secret');
    expect(mocks.invalidateApiKeyCache).toHaveBeenCalledOnce();
  });

  it('rejects an empty key without writing a secret or changing mode', async () => {
    await expect(saveProviderApiKey('anthropic', '   ')).rejects.toThrow(
      'empty',
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each([
    'sk-xxx',
    'sk-xxx-123',
    'xxxabc-secret',
    '<your-key>',
    'your-api-key',
    'your_api_key',
    'YOUR_API_KEY_HERE',
    'api-key-here',
    'placeholder',
    'example',
  ])(
    'rejects the placeholder %s without changing credentials',
    async (placeholder) => {
      await expect(
        saveProviderApiKey('anthropic', placeholder),
      ).rejects.toThrow('placeholder');
      expect(mocks.set).not.toHaveBeenCalled();
    },
  );

  it('returns no credential-derived text', async () => {
    await expect(
      saveProviderApiKey('openai', 'sk-super-secret-value'),
    ).resolves.toBeUndefined();
  });

  it('writes the secret before invalidating the key cache', async () => {
    // The only correctness-critical ordering: the secret must be written before
    // the key cache is dropped, or a concurrent read could repopulate a stale
    // "no key" entry for the 5s TTL.
    const order: string[] = [];
    mocks.set.mockImplementation(async () => {
      order.push('set');
    });
    mocks.invalidateApiKeyCache.mockImplementation(() => {
      order.push('invalidateApiKeyCache');
    });

    await saveProviderApiKey('anthropic', 'sk-ant-secret');

    expect(order).toEqual(['set', 'invalidateApiKeyCache']);
  });
});
