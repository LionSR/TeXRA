import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { testRuntime } from '@test/support/testProcessRuntime';
import { FakeSecrets } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

const mocks = vi.hoisted(() => ({
  getCliAuthProfile: vi.fn(),
  readCliModelAccessStatus: vi.fn(),
  lookupApiKeyOrigin: vi.fn(),
  getSubscriptionUsage: vi.fn(),
}));

vi.mock(
  '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService',
  () => ({
    SubscriptionUsageService: class {
      getUsage = mocks.getSubscriptionUsage;
    },
  }),
);

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProfile: mocks.getCliAuthProfile,
}));

vi.mock('@cli/runtime/modelAccessSelection', () => ({
  readCliModelAccessStatus: mocks.readCliModelAccessStatus,
  mergeCliTexraAccountStatus: (
    access: Record<string, unknown>,
    profile: { authenticated: boolean; accountLabel?: string },
  ) => ({
    ...access,
    texraSignedIn: profile.authenticated,
    texraAccountLabel: profile.accountLabel,
  }),
}));

vi.mock('@model/apiProviders', () => ({
  API_PROVIDERS: ['deepseek', 'glm', 'kimiCode'],
  lookupApiKeyOrigin: mocks.lookupApiKeyOrigin,
  configuredApiKeyProviders: () =>
    Effect.map(
      Effect.forEach(
        ['deepseek', 'glm', 'kimiCode'],
        (provider: string) =>
          mocks.lookupApiKeyOrigin({}, provider) as Effect.Effect<string>,
        { concurrency: 'unbounded' },
      ),
      (origins: readonly string[]) =>
        ['deepseek', 'glm', 'kimiCode'].filter(
          (_, index) => origins[index] !== 'none',
        ),
    ),
}));

const { loadCliDetailedAccountStatusLines, loadCliModelAccessOverview } =
  await import('@cli/runtime/apiStatus');

const secrets = new FakeSecrets();
const stores = makeFakeSettingsStores().stores;

function lineFor(lines: readonly string[], route: string): string {
  const matches = lines.filter((line) => line.startsWith(`${route}:`));
  expect(matches).toHaveLength(1);
  return matches[0] ?? '';
}

function setPersonalKeys(...providers: string[]): void {
  mocks.lookupApiKeyOrigin.mockImplementation(
    (_secrets: unknown, provider: string) =>
      Effect.succeed(providers.includes(provider) ? 'env' : 'none'),
  );
}

function codingPlans(
  kimiPreferred = false,
  kimiKeySet = false,
  glmPreferred = false,
  glmKeySet = false,
) {
  return {
    kimiCode: { preferred: kimiPreferred, keySet: kimiKeySet },
    glmCodingPlan: { preferred: glmPreferred, keySet: glmKeySet },
  };
}

function accountStatusLines(): Promise<string[]> {
  // The status program reads subscription usage, whose credential reads take
  // the process HTTP client from context — so it settles on the kernel's
  // runtime, not a bare one.
  return testRuntime().runPromise(
    loadCliDetailedAccountStatusLines(stores, secrets),
  );
}

function renderPreferenceRoute(
  route: 'chatGpt' | 'kimiCode' | 'glmCode',
  preference: 'on' | 'off',
  enabled: boolean,
): Promise<string[]> {
  mocks.readCliModelAccessStatus.mockReturnValue(
    Effect.succeed({
      preferences: {
        chatGpt: route === 'chatGpt' ? preference : 'off',
        grok: 'off',
      },
      codingPlans: codingPlans(
        route === 'kimiCode' && preference === 'on',
        route === 'kimiCode' && enabled,
        route === 'glmCode' && preference === 'on',
        route === 'glmCode' && enabled,
      ),
      chatGptSignedIn: route === 'chatGpt' && enabled,
      grokSignedIn: false,
      chatGptAccountLabel:
        route === 'chatGpt' && enabled ? 'chatgpt@example.com' : undefined,
    }),
  );
  return accountStatusLines();
}

describe('CLI model-access status lines', () => {
  beforeEach(() => {
    mocks.getCliAuthProfile.mockReset().mockReturnValue(
      Effect.succeed({
        authenticated: false,
      }),
    );
    mocks.readCliModelAccessStatus.mockReset().mockReturnValue(
      Effect.succeed({
        preferences: {
          chatGpt: 'off',
          grok: 'off',
        },
        codingPlans: codingPlans(),
        chatGptSignedIn: false,
        grokSignedIn: false,
      }),
    );
    mocks.lookupApiKeyOrigin
      .mockReset()
      .mockReturnValue(Effect.succeed('none'));
    mocks.getSubscriptionUsage
      .mockReset()
      .mockImplementation((provider: string) =>
        Effect.succeed({
          state: 'unavailable',
          provider,
          providerName: provider,
          planName: provider,
          fetchedAt: 0,
          windows: [],
          reason: 'missing_credentials',
        }),
      );
  });

  it('renders preferred Kimi and ChatGPT routes with their owned credentials', async () => {
    mocks.readCliModelAccessStatus.mockReturnValue(
      Effect.succeed({
        preferences: {
          chatGpt: 'on',
          grok: 'off',
        },
        codingPlans: codingPlans(true, true),
        chatGptSignedIn: true,
        grokSignedIn: false,
        chatGptAccountLabel: 'chatgpt@example.com',
      }),
    );
    mocks.getCliAuthProfile.mockReturnValue(
      Effect.succeed({
        authenticated: true,
        accountLabel: 'texra@example.com',
      }),
    );
    setPersonalKeys('deepseek', 'glm', 'kimiCode');

    const lines = await accountStatusLines();
    const joined = lines.join('\n');

    expect(lineFor(lines, 'ChatGPT')).toBe(
      'ChatGPT: preferred · signed in as chatgpt@example.com',
    );
    expect(lineFor(lines, 'Kimi Code')).toBe(
      'Kimi Code: preferred · key configured',
    );
    expect(lineFor(lines, 'Otherwise')).toBe('Otherwise: Your own API keys');
    expect(lineFor(lines, 'Other API keys')).toBe(
      'Other API keys: DeepSeek, GLM',
    );
    expect(joined.match(/Kimi Code/g)).toHaveLength(1);
    expect(joined.match(/chatgpt@example\.com/g)).toHaveLength(1);
  });

  it.effect(
    'appends normalized usage to configured routes and force-refreshes on open',
    () =>
      Effect.gen(function* () {
        mocks.readCliModelAccessStatus.mockReturnValue(
          Effect.succeed({
            preferences: {
              chatGpt: 'off',
              grok: 'off',
            },
            codingPlans: codingPlans(true, true, true, true),
            chatGptSignedIn: false,
            grokSignedIn: false,
          }),
        );
        mocks.getSubscriptionUsage.mockImplementation((provider: string) =>
          Effect.succeed(
            provider === 'glmCodingPlan'
              ? {
                  state: 'unavailable',
                  provider,
                  providerName: 'GLM',
                  planName: 'GLM Coding Plan',
                  fetchedAt: 1_800_000_000_000,
                  windows: [],
                  reason: 'request_failed',
                }
              : {
                  state: 'available',
                  provider,
                  providerName: 'Kimi Code',
                  planName: 'Kimi Code',
                  fetchedAt: 1_800_000_000_000,
                  windows: [
                    {
                      name: 'five_hour',
                      percentUsed: 0,
                      percentRemaining: 100,
                      resetAt: 1_800_007_200_000,
                    },
                    {
                      name: 'seven_day',
                      percentUsed: 100,
                      percentRemaining: 0,
                      resetAt: 1_800_162_000_000,
                    },
                  ],
                },
          ),
        );

        // The usage credential reads carry the process HTTP client in their
        // type; the mocked reader never touches it, so the test layer stands
        // in for the kernel runtime's client.
        const lines = yield* loadCliDetailedAccountStatusLines(
          stores,
          secrets,
          { now: 1_800_000_000_000 },
        ).pipe(Effect.provide(testHttpClientLayer));

        expect(lineFor(lines, 'Kimi Code')).toBe(
          'Kimi Code: preferred · key configured · 5-hour: 0% · resets in 2h · 7-day: 100% · resets in 1d 21h',
        );
        expect(lineFor(lines, 'GLM Coding Plan')).toBe(
          'GLM Coding Plan: preferred · key configured · usage unavailable',
        );
        expect(mocks.getSubscriptionUsage.mock.calls).toStrictEqual([
          ['kimiCode', { forceRefresh: true }],
          ['glmCodingPlan', { forceRefresh: true }],
        ]);
      }),
  );

  it.each([
    {
      name: 'off and signed out',
      preference: 'off',
      enabled: false,
      expected: ['Otherwise: Your own API keys'],
    },
    {
      name: 'off and signed in',
      preference: 'off',
      enabled: true,
      expected: [
        'ChatGPT: not preferred · signed in as chatgpt@example.com',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on and signed out',
      preference: 'on',
      enabled: false,
      expected: [
        'ChatGPT: preferred · sign in required',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on and signed in',
      preference: 'on',
      enabled: true,
      expected: [
        'ChatGPT: preferred · signed in as chatgpt@example.com',
        'Otherwise: Your own API keys',
      ],
    },
  ] as const)(
    'renders the ChatGPT route when available: $name',
    async ({ expected, enabled, preference }) => {
      await expect(
        renderPreferenceRoute('chatGpt', preference, enabled),
      ).resolves.toEqual(expected);
    },
  );

  it('keeps a shared GLM key in the personal-key inventory', async () => {
    mocks.readCliModelAccessStatus.mockReturnValue(
      Effect.succeed({
        preferences: {
          chatGpt: 'off',
          grok: 'off',
        },
        codingPlans: codingPlans(false, false, false, true),
        chatGptSignedIn: false,
        grokSignedIn: false,
      }),
    );
    setPersonalKeys('glm');

    const lines = await accountStatusLines();

    expect(lineFor(lines, 'Other API keys')).toBe('Other API keys: GLM');
  });

  it('keeps signed-out personal-only status truthful', async () => {
    setPersonalKeys('deepseek');

    const lines = await accountStatusLines();

    expect(lines).toEqual([
      'Otherwise: Your own API keys',
      'Other API keys: DeepSeek',
    ]);
    expect(lines.join('\n')).not.toContain('TeXRA');
  });

  it.effect(
    'reports the legacy model-access overview without reading key storage',
    () =>
      Effect.gen(function* () {
        mocks.readCliModelAccessStatus.mockReturnValue(
          Effect.succeed({
            preferences: {
              chatGpt: 'on',
              grok: 'off',
            },
            codingPlans: codingPlans(),
            chatGptSignedIn: true,
            grokSignedIn: false,
            chatGptAccountLabel: 'chatgpt@example.com',
          }),
        );
        mocks.getCliAuthProfile.mockReturnValue(
          Effect.succeed({
            authenticated: true,
            accountLabel: 'texra@example.com',
          }),
        );
        mocks.lookupApiKeyOrigin.mockReturnValue(
          Effect.fail(new Error('keychain offline')),
        );

        expect(yield* loadCliModelAccessOverview(stores, secrets)).toEqual({
          access: {
            preferences: {
              chatGpt: 'on',
              grok: 'off',
            },
            codingPlans: codingPlans(),
            chatGptSignedIn: true,
            grokSignedIn: false,
            chatGptAccountLabel: 'chatgpt@example.com',
            texraSignedIn: true,
            texraAccountLabel: 'texra@example.com',
          },
          lines: [
            'ChatGPT preference: On · chatgpt@example.com',
            'Grok preference: Off · sign in required to enable',
            'Kimi Code preference: Off · key required to enable',
            'GLM Coding Plan preference: Off · key required to enable',
            'Otherwise: Your own API keys',
            'TeXRA account: signed in as texra@example.com',
          ],
        });
        expect(mocks.lookupApiKeyOrigin).not.toHaveBeenCalled();
      }),
  );
});
