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
  canUseServerSideKeys: vi.fn<() => Promise<boolean>>(),
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

vi.mock('@model/includedModelAccess', () => ({
  includedModelAccess: () => ({
    canUseServerSideKeys: mocks.canUseServerSideKeys,
  }),
}));

const { hasUsableSetupCredential } =
  await import('@model/setupCredentialAccess');

describe('setup credential access', () => {
  // Outcomes the mocked access paths return; the mocks record their call
  // order in `events` so tests assert the probing sequence.
  const access = {
    subscription: false,
    keys: {} as Record<string, string | undefined>,
    included: false,
  };

  beforeEach(() => {
    events.length = 0;
    access.subscription = false;
    access.keys = {};
    access.included = false;
    mocks.isCodexSubscriptionActive.mockReset().mockImplementation(async () => {
      events.push('subscription');
      return access.subscription;
    });
    mocks.lookupApiKey.mockReset().mockImplementation(async (_, provider) => {
      events.push(`key:${provider}`);
      return access.keys[provider];
    });
    mocks.canUseServerSideKeys.mockReset().mockImplementation(async () => {
      events.push('included');
      return access.included;
    });
  });

  it('stops after an active ChatGPT subscription', async () => {
    access.subscription = true;

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(true);
    expect(events).toEqual(['subscription']);
  });

  it('checks provider keys sequentially before included access', async () => {
    access.keys = { openai: '   ', anthropic: 'sk-ant-test' };

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(true);
    expect(events).toEqual(['subscription', 'key:openai', 'key:anthropic']);
  });

  it('checks included access only after local credentials are exhausted', async () => {
    access.included = true;

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(true);
    expect(events).toEqual([
      'subscription',
      'key:openai',
      'key:anthropic',
      'included',
    ]);
  });

  it('returns false when no access path is usable', async () => {
    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(false);
  });
});
