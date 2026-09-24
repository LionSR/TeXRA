import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import {
  readCliModelAccessStatus,
  updateCliModelAccess,
} from '@cli/runtime/modelAccessSelection';
import {
  buildCliModelAccessItems,
  formatCliModelAccessRoute,
  formatCliModelAccessRouteInline,
  resolveCliModelAccessRoute,
  shortCliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';
import { AppState, type StateWriteFailed } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';

const mocks = vi.hoisted(() => ({
  getCodexStatus: vi.fn(),
  getXaiStatus: vi.fn(),
  isPreferCodexSubscription: vi.fn(),
  setPreferCodexSubscription: vi.fn(),
  isPreferXaiSubscription: vi.fn(),
  setPreferXaiSubscription: vi.fn(),
  shouldUseSubscriptionDeviceCode: vi.fn(),
  signInCliSubscription: vi.fn(),
  updateGlobalState: vi.fn(),
  hasUsableApiKey: vi.fn(),
  lookupApiKeyOrigin: vi.fn(),
  getPreferKimiCode: vi.fn(),
  getGLMCodingPlan: vi.fn(),
  setGLMCodingPlan: vi.fn(),
  writeSettingTo: vi.fn(),
}));

/** The global-state writes this suite asserts on. */
const updateGlobalState = vi.fn();

/** A global state store whose writes the suite observes. */
class ObservedStateStore extends FakeStateStore {
  override update(
    key: string,
    value: unknown,
  ): Effect.Effect<void, StateWriteFailed> {
    mocks.updateGlobalState(key, value);
    return super.update(key, value);
  }
}

const secrets = new FakeSecrets();
const stores = makeFakeSettingsStores().stores;
const appState = new ObservedStateStore();

/**
 * The process services these programs took from the process runtime before
 * the suite ran them natively: the same ports `installFakeHost` merges in.
 */
const withServices = Effect.provide(
  Layer.mergeAll(
    testHttpClientLayer,
    Secrets.layer(secrets),
    AppState.layer(appState),
  ),
);

vi.mock('@auth/codex', () => ({
  getCodexStatus: mocks.getCodexStatus,
}));

vi.mock('@auth/xai', () => ({
  getXaiStatus: mocks.getXaiStatus,
  xaiAccountLabel: (account: { email?: string } | null | undefined) =>
    account?.email ?? 'your Grok account',
}));

vi.mock('@model/codex/codexSubscription', () => ({
  isPreferCodexSubscription: mocks.isPreferCodexSubscription,
  setPreferCodexSubscription: mocks.setPreferCodexSubscription,
}));

vi.mock('@model/xai/xaiSubscription', () => ({
  isPreferXaiSubscription: mocks.isPreferXaiSubscription,
  setPreferXaiSubscription: mocks.setPreferXaiSubscription,
}));

vi.mock('@model/apiProviders', () => {
  const providers = [
    'openai',
    'anthropic',
    'openRouter',
    'google',
    'xai',
    'deepseek',
    'moonshot',
    'kimiCode',
    'dashscope',
    'minimax',
    'glm',
    'meta',
  ];
  return {
    API_PROVIDERS: providers,
    hasUsableApiKey: mocks.hasUsableApiKey,
    lookupApiKeyOrigin: mocks.lookupApiKeyOrigin,
    configuredApiKeyProviders: () =>
      Effect.map(
        Effect.forEach(
          providers,
          (provider: string) =>
            mocks.lookupApiKeyOrigin({}, provider) as Effect.Effect<string>,
          { concurrency: 'unbounded' },
        ),
        (origins: readonly string[]) =>
          providers.filter((_, index) => origins[index] !== 'none'),
      ),
  };
});

vi.mock('@utils/config/providerConfig', () => ({
  getPreferKimiCode: mocks.getPreferKimiCode,
  getGLMCodingPlan: mocks.getGLMCodingPlan,
  setGLMCodingPlan: mocks.setGLMCodingPlan,
}));

vi.mock('@utils/config/platformSettings', () => ({
  writeSettingTo: mocks.writeSettingTo,
}));

vi.mock('@cli/runtime/subscriptionLogin', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/subscriptionLogin')>();
  return {
    ...actual,
    shouldUseSubscriptionDeviceCode: mocks.shouldUseSubscriptionDeviceCode,
    signInCliSubscription: mocks.signInCliSubscription,
  };
});

const context = createTestCliContext();

type AccessRoute = Parameters<typeof formatCliModelAccessRoute>[0];

function subscriptionPreference(
  provider: 'chatgpt' | 'grok' | 'kimi-code' | 'glm-code',
  state: 'on' | 'off',
) {
  return { kind: 'subscription-preference', provider, state } as const;
}

function expectedAccessStatus(
  overrides: Record<string, unknown>,
  plans: {
    kimiPreferred?: boolean;
    kimiKeySet?: boolean;
    glmPreferred?: boolean;
    glmKeySet?: boolean;
  } = {},
) {
  return {
    preferences: {
      chatGpt: 'off',
      grok: 'off',
    },
    chatGptSignedIn: false,
    chatGptAccountLabel: undefined,
    grokSignedIn: false,
    grokAccountLabel: undefined,
    ...overrides,
    codingPlans: {
      glmCodingPlan: {
        preferred: plans.glmPreferred ?? false,
        keySet: plans.glmKeySet ?? false,
      },
      kimiCode: {
        preferred: plans.kimiPreferred ?? false,
        keySet: plans.kimiKeySet ?? false,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCodexStatus.mockReturnValue(Effect.succeed({ signedIn: false }));
  mocks.getXaiStatus.mockReturnValue(Effect.succeed({ signedIn: false }));
  mocks.isPreferCodexSubscription.mockReturnValue(false);
  mocks.isPreferXaiSubscription.mockReturnValue(false);
  mocks.setPreferCodexSubscription.mockReturnValue(Effect.void);
  mocks.setPreferXaiSubscription.mockReturnValue(Effect.void);
  mocks.shouldUseSubscriptionDeviceCode.mockReturnValue(false);
  mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(false));
  mocks.lookupApiKeyOrigin.mockReturnValue(Effect.succeed('none'));
  mocks.getPreferKimiCode.mockReturnValue(Effect.succeed(false));
  mocks.writeSettingTo.mockReturnValue(Effect.void);
  mocks.getGLMCodingPlan.mockReturnValue(Effect.succeed(false));
  mocks.setGLMCodingPlan.mockReturnValue(Effect.void);
});

describe('CLI model access routes', () => {
  it('uses observed access before the prospective route', () => {
    expect(
      resolveCliModelAccessRoute({
        usageRoute: 'api-key',
        prospectiveRoute: 'chatgpt-subscription',
      }),
    ).toBe('api-key');
    // A completed request's route cannot change: observed `api-key` usage
    // still resolves to `api-key` while the Kimi Code route is active.
    expect(
      resolveCliModelAccessRoute({
        usageRoute: 'api-key',
        prospectiveRoute: 'kimi-code-subscription',
      }),
    ).toBe('api-key');
    // With nothing observed yet, the prospective route is what shows.
    expect(
      resolveCliModelAccessRoute({
        prospectiveRoute: 'kimi-code-subscription',
      }),
    ).toBe('kimi-code-subscription');
  });

  it.effect('reports the ChatGPT preference independently of sign-in', () =>
    Effect.gen(function* () {
      mocks.getCodexStatus.mockReturnValue(
        Effect.succeed({
          signedIn: true,
          email: 'user@example.com',
        }),
      );
      mocks.isPreferCodexSubscription.mockReturnValue(true);

      expect(yield* readCliModelAccessStatus(stores, secrets)).toEqual(
        expectedAccessStatus({
          preferences: {
            chatGpt: 'on',
            grok: 'off',
          },
          chatGptSignedIn: true,
          chatGptAccountLabel: 'user@example.com',
        }),
      );

      mocks.getCodexStatus.mockReturnValue(Effect.succeed({ signedIn: false }));
      expect(yield* readCliModelAccessStatus(stores, secrets)).toEqual(
        expectedAccessStatus({
          preferences: {
            chatGpt: 'on',
            grok: 'off',
          },
        }),
      );
    }),
  );

  it.effect('reports the Kimi preference independently of key', () =>
    Effect.gen(function* () {
      mocks.hasUsableApiKey.mockImplementation((_secrets, provider) =>
        Effect.succeed(provider === 'kimiCode'),
      );
      mocks.getPreferKimiCode.mockReturnValue(Effect.succeed(true));

      expect(yield* readCliModelAccessStatus(stores, secrets)).toEqual(
        expectedAccessStatus(
          {
            preferences: {
              chatGpt: 'off',
              grok: 'off',
            },
          },
          { kimiPreferred: true, kimiKeySet: true },
        ),
      );

      mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(false));
      expect(yield* readCliModelAccessStatus(stores, secrets)).toMatchObject({
        codingPlans: { kimiCode: { preferred: true, keySet: false } },
      });
    }),
  );

  it.effect(
    'enables Kimi Code routing on a personal fallback when a key exists',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(true));

        const result = yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('kimi-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
        expect(mocks.writeSettingTo).toHaveBeenCalledWith(
          stores,
          GlobalStateKey.KIMI_CODE_PREFER,
          true,
        );
        expect(result).toEqual({
          message:
            'Prefer Kimi Code subscription enabled for Kimi models · other models still use your own API keys.',
        });
      }).pipe(withServices),
  );

  it.effect(
    'guides to key entry when Kimi Code is selected without a key',
    () =>
      Effect.gen(function* () {
        const result = yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('kimi-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(mocks.writeSettingTo).not.toHaveBeenCalled();
        expect(result.message).toContain('No Kimi Code API key configured');
        expect(result.message).toContain('https://www.kimi.com/code/console');
      }).pipe(withServices),
  );

  it.effect(
    'enables GLM Coding Plan routing on a personal fallback when a key exists',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(true));

        const result = yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('glm-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(mocks.setGLMCodingPlan).toHaveBeenCalledWith(stores, true);
        expect(mocks.writeSettingTo).not.toHaveBeenCalled();
        expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
        expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();
        expect(mocks.updateGlobalState).not.toHaveBeenCalled();
        expect(result).toEqual({
          message:
            'Prefer GLM Coding Plan enabled for GLM models · other models still use your own API keys.',
        });
      }).pipe(withServices),
  );

  it.effect(
    'guides to key entry when GLM Coding Plan is selected without a key',
    () =>
      Effect.gen(function* () {
        const result = yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('glm-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(mocks.setGLMCodingPlan).not.toHaveBeenCalled();
        expect(result.message).toContain('No GLM API key configured');
        expect(result.message).toContain('https://open.bigmodel.cn');
      }).pipe(withServices),
  );

  it.effect('turns off GLM Coding Plan without requiring a key', () =>
    Effect.gen(function* () {
      const result = yield* updateCliModelAccess(
        stores,
        context,
        subscriptionPreference('glm-code', 'off'),
        { writeProgress: vi.fn() },
      );

      expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
      expect(mocks.setGLMCodingPlan).toHaveBeenCalledWith(stores, false);
      expect(mocks.writeSettingTo).not.toHaveBeenCalled();
      expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Prefer GLM Coding Plan disabled for GLM models.',
      });
    }).pipe(withServices),
  );

  it.effect('signs in when needed and enables ChatGPT without an API key', () =>
    Effect.gen(function* () {
      mocks.signInCliSubscription.mockReturnValue(
        Effect.succeed({
          signedIn: true,
          email: 'user@example.com',
          label: 'user@example.com',
        }),
      );
      mocks.setPreferCodexSubscription.mockReturnValue(Effect.void);
      const writeProgress = vi.fn();

      const result = yield* updateCliModelAccess(
        stores,
        context,
        subscriptionPreference('chatgpt', 'on'),
        { writeProgress },
      );

      expect(mocks.signInCliSubscription).toHaveBeenCalledWith(
        'chatgpt',
        { device: false, noBrowser: false },
        { writeProgress },
      );
      expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(
        stores,
        true,
      );
      expect(mocks.updateGlobalState).toHaveBeenCalledWith(
        'texra.useOpenRouter',
        false,
      );
      expect(result.message).toBe(
        'Prefer ChatGPT subscription enabled for Codex models (user@example.com).',
      );
    }).pipe(withServices),
  );

  it.effect('turns off ChatGPT without changing the Kimi preference', () =>
    Effect.gen(function* () {
      mocks.getCodexStatus.mockReturnValue(
        Effect.succeed({
          signedIn: true,
          email: 'user@example.com',
        }),
      );
      mocks.isPreferCodexSubscription.mockReturnValue(true);
      mocks.setPreferCodexSubscription.mockReturnValue(Effect.void);

      const result = yield* updateCliModelAccess(
        stores,
        context,
        subscriptionPreference('chatgpt', 'off'),
        { writeProgress: vi.fn() },
      );

      expect(mocks.signInCliSubscription).not.toHaveBeenCalled();
      expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(
        stores,
        false,
      );
      expect(mocks.writeSettingTo).not.toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Prefer ChatGPT subscription disabled for Codex models.',
      });
    }).pipe(withServices),
  );

  it.effect(
    'represents preferences independently and toggles each without side effects',
    () =>
      Effect.gen(function* () {
        mocks.getCodexStatus.mockReturnValue(
          Effect.succeed({
            signedIn: true,
            email: 'user@example.com',
          }),
        );
        mocks.isPreferCodexSubscription.mockReturnValue(true);
        mocks.getPreferKimiCode.mockReturnValue(Effect.succeed(true));
        mocks.hasUsableApiKey.mockReturnValue(Effect.succeed(true));

        const status = yield* readCliModelAccessStatus(stores, secrets);
        expect(status.preferences).toEqual({
          chatGpt: 'on',
          grok: 'off',
        });
        const descriptions = Object.fromEntries(
          buildCliModelAccessItems({ kind: 'loaded', access: status })
            .filter((item) => item.value.kind === 'subscription-preference')
            .map((item) => {
              if (item.value.kind !== 'subscription-preference') {
                throw new Error('expected subscription preference');
              }
              return [item.value.provider, item.description];
            }),
        );
        expect(descriptions).toEqual({
          chatgpt: 'On · user@example.com',
          grok: 'Off · sign in required to enable',
          'kimi-code': 'On · key configured',
          'glm-code': 'Off · key configured',
        });

        yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('kimi-code', 'off'),
          { writeProgress: vi.fn() },
        );
        expect(mocks.writeSettingTo).toHaveBeenCalledWith(
          stores,
          GlobalStateKey.KIMI_CODE_PREFER,
          false,
        );
        expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
        expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();

        vi.clearAllMocks();
        mocks.getCodexStatus.mockReturnValue(
          Effect.succeed({
            signedIn: true,
            email: 'user@example.com',
          }),
        );
        mocks.isPreferCodexSubscription.mockReturnValue(true);
        mocks.setPreferCodexSubscription.mockReturnValue(Effect.void);
        yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('chatgpt', 'off'),
          { writeProgress: vi.fn() },
        );
        expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(
          stores,
          false,
        );
        expect(mocks.writeSettingTo).not.toHaveBeenCalled();
        expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();
      }).pipe(withServices),
  );

  it.effect('turns off a stale signed-out preference without signing in', () =>
    Effect.gen(function* () {
      mocks.isPreferCodexSubscription.mockReturnValue(true);
      mocks.setPreferCodexSubscription.mockReturnValue(Effect.void);

      const status = yield* readCliModelAccessStatus(stores, secrets);
      const selection = buildCliModelAccessItems({
        kind: 'loaded',
        access: status,
      }).find(
        (item) =>
          item.value.kind === 'subscription-preference' &&
          item.value.provider === 'chatgpt',
      );
      expect(selection?.description).toBe('On · sign in required');
      if (!selection) throw new Error('Expected ChatGPT preference item');
      yield* updateCliModelAccess(stores, context, selection.value, {
        writeProgress: vi.fn(),
      });

      expect(mocks.signInCliSubscription).not.toHaveBeenCalled();
      expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(
        stores,
        false,
      );
    }).pipe(withServices),
  );

  it.effect('turns off a stale Kimi preference without requiring a key', () =>
    Effect.gen(function* () {
      mocks.getPreferKimiCode.mockReturnValue(Effect.succeed(true));
      const status = yield* readCliModelAccessStatus(stores, secrets);
      const selection = buildCliModelAccessItems({
        kind: 'loaded',
        access: status,
      }).find(
        (item) =>
          item.value.kind === 'subscription-preference' &&
          item.value.provider === 'kimi-code',
      );
      expect(selection?.description).toBe('On · key required');
      if (!selection) throw new Error('Expected Kimi preference item');

      vi.clearAllMocks();
      yield* updateCliModelAccess(stores, context, selection.value);

      expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
      expect(mocks.writeSettingTo).toHaveBeenCalledWith(
        stores,
        GlobalStateKey.KIMI_CODE_PREFER,
        false,
      );
      expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    }).pipe(withServices),
  );
});
