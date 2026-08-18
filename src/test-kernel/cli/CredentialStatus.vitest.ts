import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn(),
  lookupApiKey: vi.fn(),
}));

vi.mock('@model/providerCapabilities', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@model/providerCapabilities')>();
  return {
    ...actual,
    isCodexSubscriptionActive: mocks.isCodexSubscriptionActive,
  };
});

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: {} }),
}));

vi.mock('@model/apiProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@model/apiProviders')>();
  return { ...actual, lookupApiKey: mocks.lookupApiKey };
});

const { hasCliRunCredential } = await import('@cli/runtime/credentialStatus');

describe('CLI credential status', () => {
  beforeEach(() => {
    mocks.isCodexSubscriptionActive.mockReset().mockResolvedValue(false);
    mocks.lookupApiKey.mockReset();
  });

  it('counts an active ChatGPT subscription without checking provider keys', async () => {
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);
    mocks.lookupApiKey.mockRejectedValue(
      new Error('provider keys must not be checked'),
    );

    await expect(hasCliRunCredential()).resolves.toBe(true);
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
  });

  it('is true when a provider key resolves', async () => {
    mocks.lookupApiKey.mockResolvedValueOnce('sk-test');
    await expect(hasCliRunCredential()).resolves.toBe(true);
  });

  it('ignores blank provider keys', async () => {
    mocks.lookupApiKey.mockResolvedValue('   ');
    await expect(hasCliRunCredential()).resolves.toBe(false);
  });
});
