import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeSecrets } from '@test/support/FakePlatform';

const mocks = vi.hoisted(() => ({
  invalidateApiKeyCache: vi.fn(),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, invalidateApiKeyCache: mocks.invalidateApiKeyCache };
});

const { saveProviderApiKey } = await import('@cli/runtime/providerApiKey');
const { saveGitHubToken } = await import('@cli/runtime/githubToken');

const secrets = new FakeSecrets();
const set = vi.spyOn(secrets, 'set');

describe('saveProviderApiKey', () => {
  beforeEach(() => {
    set.mockReset().mockResolvedValue(undefined);
    mocks.invalidateApiKeyCache.mockReset();
  });

  it('stores the trimmed key and drops the key cache', async () => {
    await saveProviderApiKey(secrets, 'anthropic', '  sk-ant-secret  ');
    expect(set).toHaveBeenCalledWith('apiKey.anthropic', 'sk-ant-secret');
    expect(mocks.invalidateApiKeyCache).toHaveBeenCalledOnce();
  });

  it('rejects an empty key without writing a secret or changing mode', async () => {
    await expect(
      saveProviderApiKey(secrets, 'anthropic', '   '),
    ).rejects.toThrow('empty');
    expect(set).not.toHaveBeenCalled();
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
        saveProviderApiKey(secrets, 'anthropic', placeholder),
      ).rejects.toThrow('placeholder');
      expect(set).not.toHaveBeenCalled();
    },
  );

  it('writes the secret before invalidating the key cache', async () => {
    // The only correctness-critical ordering: the secret must be written before
    // the key cache is dropped, or a concurrent read could repopulate a stale
    // "no key" entry for the 5s TTL.
    const order: string[] = [];
    set.mockImplementation(async () => {
      order.push('set');
    });
    mocks.invalidateApiKeyCache.mockImplementation(() => {
      order.push('invalidateApiKeyCache');
    });

    await saveProviderApiKey(secrets, 'anthropic', 'sk-ant-secret');

    expect(order).toEqual(['set', 'invalidateApiKeyCache']);
  });
});

describe('saveGitHubToken', () => {
  beforeEach(() => {
    set.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    'xxx-not-a-real-token',
    'ghp_xxx-not-a-real-token',
    'github_pat_***-not-a-real-token',
    '[REDACTED_GITHUB_TOKEN]',
  ])('rejects the GitHub placeholder %s', async (placeholder) => {
    await expect(saveGitHubToken(secrets, placeholder)).rejects.toThrow(
      'placeholder',
    );
    expect(set).not.toHaveBeenCalled();
  });
});
