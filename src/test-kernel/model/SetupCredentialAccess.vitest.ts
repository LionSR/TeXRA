// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import type { PlatformSecrets } from '@platform/secrets';

const events: string[] = [];
const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn<(model: string) => Promise<boolean>>(),
  lookupApiKey:
    vi.fn<
      (
        secrets: PlatformSecrets,
        provider: string,
      ) => Promise<string | undefined>
    >(),
}));

const secrets = {} as PlatformSecrets;

vi.mock('@model/providerCapabilities', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@model/providerCapabilities')>();
  return {
    ...actual,
    isCodexSubscriptionActive: mocks.isCodexSubscriptionActive,
  };
});

vi.mock('@model/apiProviders', () => ({
  API_PROVIDERS: ['openai', 'anthropic'],
  lookupApiKey: mocks.lookupApiKey,
}));

const { hasUsableSetupCredential } =
  await import('@model/setupCredentialAccess');

describe('setup credential access', () => {
  // Outcomes the mocked access paths return; the mocks record their call
  // order in `events` so tests assert the probing sequence.
  const access = {
    subscription: false,
    keys: {} as Record<string, string | undefined>,
  };

  beforeEach(() => {
    events.length = 0;
    access.subscription = false;
    access.keys = {};
    mocks.isCodexSubscriptionActive.mockReset().mockImplementation(async () => {
      events.push('subscription');
      return access.subscription;
    });
    mocks.lookupApiKey.mockReset().mockImplementation(async (_, provider) => {
      events.push(`key:${provider}`);
      return access.keys[provider];
    });
  });

  it('stops after an active ChatGPT subscription', async () => {
    access.subscription = true;

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(true);
    expect(events).toEqual(['subscription']);
  });

  it('checks provider keys sequentially', async () => {
    access.keys = { openai: '   ', anthropic: 'sk-ant-test' };

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(true);
    expect(events).toEqual(['subscription', 'key:openai', 'key:anthropic']);
  });

  it('returns false when no access path is usable', async () => {
    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(false);
  });
});
