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

const { hasAnyCliCredential } = await import('@cli/runtime/credentialStatus');

describe('hasAnyCliCredential', () => {
  beforeEach(() => {
    mocks.isAuthenticated.mockReset();
    mocks.apiKeyExists.mockReset();
  });

  it('is true when signed in, without checking any provider key', async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    await expect(hasAnyCliCredential()).resolves.toBe(true);
    expect(mocks.apiKeyExists).not.toHaveBeenCalled();
  });

  it('is true when a provider key resolves even though signed out', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.apiKeyExists.mockResolvedValue(false);
    mocks.apiKeyExists.mockResolvedValueOnce(true);
    await expect(hasAnyCliCredential()).resolves.toBe(true);
  });

  it('is false when signed out and no provider key resolves', async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.apiKeyExists.mockResolvedValue(false);
    await expect(hasAnyCliCredential()).resolves.toBe(false);
  });

  it('treats an auth-check failure as not signed in', async () => {
    mocks.isAuthenticated.mockRejectedValue(new Error('offline'));
    mocks.apiKeyExists.mockResolvedValue(false);
    await expect(hasAnyCliCredential()).resolves.toBe(false);
  });
});
