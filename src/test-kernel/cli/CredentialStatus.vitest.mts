import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  apiKeyExists: vi.fn(),
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => ({ isAuthenticated: mocks.isAuthenticated }),
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: {} }),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, apiKeyExists: mocks.apiKeyExists };
});

const { hasCliCredentialForApiMode } =
  await import('@cli/runtime/credentialStatus');

describe('CLI credential status', () => {
  beforeEach(() => {
    mocks.isAuthenticated.mockReset();
    mocks.apiKeyExists.mockReset();
  });

  it('is true when signed in, without checking any provider key', async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(true);
    expect(mocks.apiKeyExists).not.toHaveBeenCalled();
  });

  it('is true when a provider key resolves even though signed out', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.apiKeyExists.mockResolvedValue(false);
    mocks.apiKeyExists.mockResolvedValueOnce(true);
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(true);
  });

  it('does not count provider keys as included-relay credentials', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.apiKeyExists.mockRejectedValue(
      new Error('provider keys must not be checked'),
    );
    await expect(hasCliCredentialForApiMode('included')).resolves.toBe(false);
    expect(mocks.apiKeyExists).not.toHaveBeenCalled();
  });

  it('does not count relay sign-in as a personal API-key credential', async () => {
    mocks.isAuthenticated.mockRejectedValue(
      new Error('relay sign-in must not be checked'),
    );
    mocks.apiKeyExists.mockResolvedValue(false);
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(false);
    expect(mocks.isAuthenticated).not.toHaveBeenCalled();
    expect(mocks.apiKeyExists).toHaveBeenCalled();
  });

  it('counts provider keys as personal API-key credentials', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.apiKeyExists.mockResolvedValue(false);
    mocks.apiKeyExists.mockResolvedValueOnce(true);
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(true);
  });

  it('is false when signed out and no provider key resolves', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.apiKeyExists.mockResolvedValue(false);
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(false);
  });

  it('treats an auth-check failure as not signed in', async () => {
    mocks.isAuthenticated.mockRejectedValue(new Error('offline'));
    mocks.apiKeyExists.mockResolvedValue(false);
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(false);
  });
});
