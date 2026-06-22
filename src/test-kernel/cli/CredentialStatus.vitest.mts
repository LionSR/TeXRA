import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn(),
  isAuthenticated: vi.fn(),
  lookupApiKey: vi.fn(),
}));

vi.mock('@auth/codex', () => ({
  isCodexSubscriptionActive: mocks.isCodexSubscriptionActive,
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => ({ isAuthenticated: mocks.isAuthenticated }),
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: {} }),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, lookupApiKey: mocks.lookupApiKey };
});

const { hasCliCredentialForApiMode } =
  await import('@cli/runtime/credentialStatus');

describe('CLI credential status', () => {
  beforeEach(() => {
    mocks.isCodexSubscriptionActive.mockReset().mockResolvedValue(false);
    mocks.isAuthenticated.mockReset();
    mocks.lookupApiKey.mockReset();
  });

  it('counts an active ChatGPT subscription in every API mode', async () => {
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);
    mocks.isAuthenticated.mockRejectedValue(
      new Error('relay sign-in must not be checked'),
    );
    mocks.lookupApiKey.mockRejectedValue(
      new Error('provider keys must not be checked'),
    );

    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(true);
    await expect(hasCliCredentialForApiMode('included')).resolves.toBe(true);
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(true);
    expect(mocks.isAuthenticated).not.toHaveBeenCalled();
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
  });

  it('is true when signed in, without checking any provider key', async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(true);
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
  });

  it('is true when a provider key resolves even though signed out', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.lookupApiKey.mockResolvedValue(undefined);
    mocks.lookupApiKey.mockResolvedValueOnce('sk-test');
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(true);
  });

  it('does not count provider keys as included-relay credentials', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.lookupApiKey.mockRejectedValue(
      new Error('provider keys must not be checked'),
    );
    await expect(hasCliCredentialForApiMode('included')).resolves.toBe(false);
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
  });

  it('does not count relay sign-in as a personal API-key credential', async () => {
    mocks.isAuthenticated.mockRejectedValue(
      new Error('relay sign-in must not be checked'),
    );
    mocks.lookupApiKey.mockResolvedValue(undefined);
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(false);
    expect(mocks.isAuthenticated).not.toHaveBeenCalled();
    expect(mocks.lookupApiKey).toHaveBeenCalled();
  });

  it('counts provider keys as personal API-key credentials', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.lookupApiKey.mockResolvedValue(undefined);
    mocks.lookupApiKey.mockResolvedValueOnce('sk-test');
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(true);
  });

  it('ignores blank provider keys for personal API-key credentials', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.lookupApiKey.mockResolvedValue('   ');
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(false);
  });

  it('is false when signed out and no provider key resolves', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.lookupApiKey.mockResolvedValue(undefined);
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(false);
  });

  it('treats an auth-check failure as not signed in', async () => {
    mocks.isAuthenticated.mockRejectedValue(new Error('offline'));
    mocks.lookupApiKey.mockResolvedValue(undefined);
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(false);
  });
});
