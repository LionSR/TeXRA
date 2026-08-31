// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import type { PlatformSecrets } from '@platform/secrets';

const events: string[] = [];
const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive: vi.fn<(model: string) => Promise<boolean>>(),
  isXaiSubscriptionActive: vi.fn<(model: string) => Promise<boolean>>(),
  reportProbeFailure: vi.fn(),
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
    isXaiSubscriptionActive: mocks.isXaiSubscriptionActive,
  };
});

vi.mock('@model/apiProviders', () => ({
  API_PROVIDERS: ['openai', 'anthropic'],
  lookupApiKey: mocks.lookupApiKey,
}));

const { hasUsableSetupCredential } =
  await import('@model/setupCredentialAccess');

function hasCredential(): ReturnType<typeof hasUsableSetupCredential> {
  return hasUsableSetupCredential(secrets, mocks.reportProbeFailure);
}

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
    mocks.reportProbeFailure.mockReset();
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

    await expect(hasCredential()).resolves.toBe(true);
    expect(events).toEqual(['subscription:chatgpt']);
  });

  it('counts an active Grok subscription before checking provider keys', async () => {
    access.grokSubscription = true;

    await expect(hasCredential()).resolves.toBe(true);
    expect(events).toEqual(['subscription:chatgpt', 'subscription:grok']);
  });

  it('checks provider keys sequentially after both subscriptions', async () => {
    access.keys = { openai: '   ', anthropic: 'sk-ant-test' };

    await expect(hasCredential()).resolves.toBe(true);
    expect(events).toEqual([
      'subscription:chatgpt',
      'subscription:grok',
      'key:openai',
      'key:anthropic',
    ]);
  });

  it('returns false when no access path is usable', async () => {
    await expect(hasCredential()).resolves.toBe(false);
  });

  it.each([
    {
      kind: 'ChatGPT subscription',
      fail: () =>
        mocks.isCodexSubscriptionActive.mockRejectedValueOnce(
          new Error('chatgpt offline'),
        ),
      message: 'chatgpt offline',
      expectedResult: false,
      expectedEvents: ['subscription:grok', 'key:openai', 'key:anthropic'],
    },
    {
      kind: 'Grok subscription',
      fail: () =>
        mocks.isXaiSubscriptionActive.mockRejectedValueOnce(
          new Error('grok offline'),
        ),
      message: 'grok offline',
      expectedResult: false,
      expectedEvents: ['subscription:chatgpt', 'key:openai', 'key:anthropic'],
    },
    {
      kind: 'openai API key',
      fail: () => {
        access.keys.anthropic = 'sk-ant-test';
        mocks.lookupApiKey.mockImplementationOnce(async (_, provider) => {
          events.push(`key:${provider}`);
          throw new Error('keychain locked');
        });
      },
      message: 'keychain locked',
      expectedResult: true,
      expectedEvents: [
        'subscription:chatgpt',
        'subscription:grok',
        'key:openai',
        'key:anthropic',
      ],
    },
  ])('reports a failed $kind probe and continues safely', async (testCase) => {
    testCase.fail();

    await expect(hasCredential()).resolves.toBe(testCase.expectedResult);
    expect(mocks.reportProbeFailure).toHaveBeenCalledWith(
      `${testCase.kind} check failed; treating it as no credential: ${testCase.message}`,
    );
    expect(events).toEqual(testCase.expectedEvents);
  });
});
