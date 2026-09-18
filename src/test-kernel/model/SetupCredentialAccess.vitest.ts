// Third-party imports
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import type { PlatformSecrets } from '@platform/secrets';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

const events: string[] = [];
const mocks = vi.hoisted(() => ({
  isCodexSubscriptionActive:
    vi.fn<
      (stores: SettingsStores, model: string) => Effect.Effect<boolean, Error>
    >(),
  isXaiSubscriptionActive:
    vi.fn<
      (stores: SettingsStores, model: string) => Effect.Effect<boolean, Error>
    >(),
  reportProbeFailure: vi.fn(),
  hasUsableApiKey:
    vi.fn<
      (
        secrets: PlatformSecrets,
        provider: string,
      ) => Effect.Effect<boolean, Error>
    >(),
}));

const secrets = {} as PlatformSecrets;
const stores = makeFakeSettingsStores().stores;

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
  hasUsableApiKey: mocks.hasUsableApiKey,
}));

// The kernel setup file installs a fake host, which loads
// `@tools/setup/platform`; that module statically imports both the module
// under test and `@model/apiProviders`, so both are already cached by the
// time the mocks above register. Reset first so the import below re-executes
// the subject against the mocked providers.
vi.resetModules();
const { hasUsableSetupCredential } =
  await import('@model/setupCredentialAccess');

function hasCredential(): Promise<boolean> {
  return Effect.runPromise(
    hasUsableSetupCredential(stores, secrets, mocks.reportProbeFailure).pipe(
      // The subscription probes yield the `LanguageModel` service by type;
      // both are mocked, so the port is never read.
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    ),
  );
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
    mocks.isCodexSubscriptionActive.mockReset().mockImplementation(() =>
      Effect.sync(() => {
        events.push('subscription:chatgpt');
        return access.chatGptSubscription;
      }),
    );
    mocks.isXaiSubscriptionActive.mockReset().mockImplementation(() =>
      Effect.sync(() => {
        events.push('subscription:grok');
        return access.grokSubscription;
      }),
    );
    mocks.hasUsableApiKey.mockReset().mockImplementation((_, provider) =>
      Effect.sync(() => {
        events.push(`key:${provider}`);
        // Mirrors the real check: a blank stored key is not usable.
        return (access.keys[provider] ?? '').trim().length > 0;
      }),
    );
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
        mocks.isCodexSubscriptionActive.mockReturnValueOnce(
          Effect.fail(new Error('chatgpt offline')),
        ),
      message: 'chatgpt offline',
      expectedResult: false,
      expectedEvents: ['subscription:grok', 'key:openai', 'key:anthropic'],
    },
    {
      kind: 'Grok subscription',
      fail: () =>
        mocks.isXaiSubscriptionActive.mockReturnValueOnce(
          Effect.fail(new Error('grok offline')),
        ),
      message: 'grok offline',
      expectedResult: false,
      expectedEvents: ['subscription:chatgpt', 'key:openai', 'key:anthropic'],
    },
    {
      kind: 'openai API key',
      fail: () => {
        access.keys.anthropic = 'sk-ant-test';
        mocks.hasUsableApiKey.mockImplementationOnce((_, provider) =>
          Effect.suspend(() => {
            events.push(`key:${provider}`);
            return Effect.fail(new Error('keychain locked'));
          }),
        );
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
