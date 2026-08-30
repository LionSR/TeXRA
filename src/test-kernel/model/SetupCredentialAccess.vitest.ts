// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import type { PlatformSecrets } from '@platform/secrets';

const events: string[] = [];
const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn<(model: string) => Promise<boolean>>(),
  isXaiSubscriptionActive: vi.fn<(model: string) => Promise<boolean>>(),
  logWarning: vi.fn(),
  lookupApiKey:
    vi.fn<
      (
        secrets: PlatformSecrets,
        provider: string,
      ) => Promise<string | undefined>
    >(),
}));

const secrets = {} as PlatformSecrets;

vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return { ...actual, warn: mocks.logWarning };
});

vi.mock('@model/providerCapabilities', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@model/providerCapabilities')>();
  return {
    ...actual,
    isCodexSubscriptionActive: mocks.isCodexSubscriptionActive,
    isXaiSubscriptionActive: mocks.isXaiSubscriptionActive,
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
    chatGptSubscription: false,
    grokSubscription: false,
    keys: {} as Record<string, string | undefined>,
  };

  beforeEach(() => {
    events.length = 0;
    access.chatGptSubscription = false;
    access.grokSubscription = false;
    access.keys = {};
    mocks.logWarning.mockReset();
    mocks.isCodexSubscriptionActive.mockReset().mockImplementation(async () => {
      events.push('subscription:chatgpt');
      return access.chatGptSubscription;
    });
    mocks.isXaiSubscriptionActive.mockReset().mockImplementation(async () => {
      events.push('subscription:grok');
      return access.grokSubscription;
    });
    mocks.lookupApiKey.mockReset().mockImplementation(async (_, provider) => {
      events.push(`key:${provider}`);
      return access.keys[provider];
    });
  });

  it('stops after an active ChatGPT subscription', async () => {
    access.chatGptSubscription = true;

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(true);
    expect(events).toEqual(['subscription:chatgpt']);
  });

  it('counts an active Grok subscription before checking provider keys', async () => {
    access.grokSubscription = true;

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(true);
    expect(events).toEqual(['subscription:chatgpt', 'subscription:grok']);
  });

  it('checks provider keys sequentially after both subscriptions', async () => {
    access.keys = { openai: '   ', anthropic: 'sk-ant-test' };

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(true);
    expect(events).toEqual([
      'subscription:chatgpt',
      'subscription:grok',
      'key:openai',
      'key:anthropic',
    ]);
  });

  it('returns false when no access path is usable', async () => {
    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(false);
  });

  it.each([
    {
      kind: 'ChatGPT subscription',
      fail: () =>
        mocks.isCodexSubscriptionActive.mockRejectedValueOnce(
          new Error('chatgpt offline'),
        ),
      message: 'chatgpt offline',
      expectedEvents: ['subscription:grok', 'key:openai', 'key:anthropic'],
    },
    {
      kind: 'Grok subscription',
      fail: () =>
        mocks.isXaiSubscriptionActive.mockRejectedValueOnce(
          new Error('grok offline'),
        ),
      message: 'grok offline',
      expectedEvents: ['subscription:chatgpt', 'key:openai', 'key:anthropic'],
    },
    {
      kind: 'Provider API key',
      fail: () =>
        mocks.lookupApiKey.mockRejectedValueOnce(new Error('keychain locked')),
      message: 'keychain locked',
      expectedEvents: ['subscription:chatgpt', 'subscription:grok'],
    },
  ])('logs a failed $kind probe and continues safely', async (testCase) => {
    testCase.fail();

    await expect(hasUsableSetupCredential(secrets)).resolves.toBe(false);
    expect(mocks.logWarning).toHaveBeenCalledWith(
      'Setup Credentials',
      `${testCase.kind} check failed; treating it as no credential: ${testCase.message}`,
    );
    expect(events).toEqual(testCase.expectedEvents);
  });
});
