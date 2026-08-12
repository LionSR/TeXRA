import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn(),
  getCliAuthProfile: vi.fn(),
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

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProfile: mocks.getCliAuthProfile,
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
    mocks.getCliAuthProfile.mockReset();
    mocks.lookupApiKey.mockReset();
  });

  it('counts an active ChatGPT subscription in every API mode', async () => {
    mocks.isCodexSubscriptionActive.mockResolvedValue(true);
    mocks.getCliAuthProfile.mockRejectedValue(
      new Error('relay sign-in must not be checked'),
    );
    mocks.lookupApiKey.mockRejectedValue(
      new Error('provider keys must not be checked'),
    );

    for (const apiMode of [undefined, 'included', 'personal'] as const) {
      await expect(hasCliCredentialForApiMode(apiMode)).resolves.toBe(true);
    }
    expect(mocks.getCliAuthProfile).not.toHaveBeenCalled();
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
  });

  it('is true for a verified relay sign-in, without checking provider keys', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      credentialSource: 'relayToken',
    });
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(true);
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
  });

  it('is true when a provider key resolves even though signed out', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({ authenticated: false });
    mocks.lookupApiKey.mockResolvedValueOnce('sk-test');
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(true);
  });

  it('does not count provider keys as included-relay credentials', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({ authenticated: false });
    mocks.lookupApiKey.mockRejectedValue(
      new Error('provider keys must not be checked'),
    );
    await expect(hasCliCredentialForApiMode('included')).resolves.toBe(false);
    expect(mocks.lookupApiKey).not.toHaveBeenCalled();
  });

  it('does not count relay sign-in as a personal API-key credential', async () => {
    mocks.getCliAuthProfile.mockRejectedValue(
      new Error('relay sign-in must not be checked'),
    );
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(false);
    expect(mocks.getCliAuthProfile).not.toHaveBeenCalled();
    expect(mocks.lookupApiKey).toHaveBeenCalled();
  });

  it('counts provider keys as personal API-key credentials', async () => {
    mocks.lookupApiKey.mockResolvedValueOnce('sk-test');
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(true);
  });

  it('ignores blank provider keys for personal API-key credentials', async () => {
    mocks.lookupApiKey.mockResolvedValue('   ');
    await expect(hasCliCredentialForApiMode('personal')).resolves.toBe(false);
  });

  it('rejects a server-rejected relay token when no provider key resolves', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: false,
      credentialSource: 'relayToken',
      note: 'The server rejected this relay token.',
    });
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(false);
  });

  it('treats an auth-check failure as not signed in', async () => {
    mocks.getCliAuthProfile.mockRejectedValue(new Error('offline'));
    await expect(hasCliCredentialForApiMode(undefined)).resolves.toBe(false);
  });
});
