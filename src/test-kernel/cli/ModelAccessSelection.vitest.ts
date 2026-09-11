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
  parseCliModelAccessSelection,
  resolveCliModelAccessRoute,
  shortCliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';
import { AppState } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
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
  writePlatformSetting: vi.fn(),
}));

/** The global-state writes this suite asserts on. */
const updateGlobalState = vi.fn();

/** A global state store whose writes the suite observes. */
class ObservedStateStore extends FakeStateStore {
  override async update(key: string, value: unknown): Promise<void> {
    mocks.updateGlobalState(key, value);
    await super.update(key, value);
  }
}

const secrets = new FakeSecrets();
const appState = new ObservedStateStore();

/**
 * The process services these programs took from the process runtime before
 * the suite ran them natively: the same ports `installFakeHost` merges in.
 */
const withServices = Effect.provide(
  Layer.mergeAll(
    testHttpClientLayer,
    Secrets.layer(() => secrets),
    AppState.layer(() => appState),
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

vi.mock('@model/codex/codexPreference', () => ({
  isPreferCodexSubscription: mocks.isPreferCodexSubscription,
  setPreferCodexSubscription: mocks.setPreferCodexSubscription,
}));

vi.mock('@model/xai/xaiPreference', () => ({
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
    configuredApiKeyProviders: async () => {
      const origins = await Promise.all(
        providers.map((provider) => mocks.lookupApiKeyOrigin({}, provider)),
      );
      return providers.filter((_, index) => origins[index] !== 'none');
    },
  };
});

vi.mock('@utils/config/providerConfig', () => ({
  getPreferKimiCode: mocks.getPreferKimiCode,
  getGLMCodingPlan: mocks.getGLMCodingPlan,
  setGLMCodingPlan: mocks.setGLMCodingPlan,
}));

vi.mock('@utils/config/platformSettings', () => ({
  writePlatformSetting: mocks.writePlatformSetting,
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
  mocks.getCodexStatus.mockResolvedValue({ signedIn: false });
  mocks.getXaiStatus.mockResolvedValue({ signedIn: false });
  mocks.isPreferCodexSubscription.mockReturnValue(false);
  mocks.isPreferXaiSubscription.mockReturnValue(false);
  mocks.setPreferCodexSubscription.mockResolvedValue({
    effective: false,
    target: 'global',
  });
  mocks.setPreferXaiSubscription.mockResolvedValue({
    effective: false,
    target: 'global',
  });
  mocks.shouldUseSubscriptionDeviceCode.mockReturnValue(false);
  mocks.hasUsableApiKey.mockResolvedValue(false);
  mocks.lookupApiKeyOrigin.mockResolvedValue('none');
  mocks.getPreferKimiCode.mockReturnValue(false);
  mocks.writePlatformSetting.mockResolvedValue(undefined);
  mocks.getGLMCodingPlan.mockReturnValue(false);
  mocks.setGLMCodingPlan.mockResolvedValue(undefined);
});

describe('CLI model access routes', () => {
  it.each([
    ['chatgpt', subscriptionPreference('chatgpt', 'on')],
    ['subscription', subscriptionPreference('chatgpt', 'on')],
    ['grok', subscriptionPreference('grok', 'on')],
    ['xai', subscriptionPreference('grok', 'on')],
    ['kimi', subscriptionPreference('kimi-code', 'on')],
    ['kimicode', subscriptionPreference('kimi-code', 'on')],
    ['kimi-code', subscriptionPreference('kimi-code', 'on')],
    ['glm', subscriptionPreference('glm-code', 'on')],
    ['glmcode', subscriptionPreference('glm-code', 'on')],
    ['glm-code', subscriptionPreference('glm-code', 'on')],
    ['glm-coding', subscriptionPreference('glm-code', 'on')],
    ['glm-coding-plan', subscriptionPreference('glm-code', 'on')],
    ['direct', undefined],
  ])('parses the route or compatibility spelling %s', (input, expected) => {
    expect(parseCliModelAccessSelection(input)).toEqual(expected);
  });

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

  it('reports the ChatGPT preference independently of sign-in', async () => {
    mocks.getCodexStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
    });
    mocks.isPreferCodexSubscription.mockReturnValue(true);

    await expect(readCliModelAccessStatus(secrets)).resolves.toEqual(
      expectedAccessStatus({
        preferences: {
          chatGpt: 'on',
          grok: 'off',
        },
        chatGptSignedIn: true,
        chatGptAccountLabel: 'user@example.com',
      }),
    );

    mocks.getCodexStatus.mockResolvedValue({ signedIn: false });
    await expect(readCliModelAccessStatus(secrets)).resolves.toEqual(
      expectedAccessStatus({
        preferences: {
          chatGpt: 'on',
          grok: 'off',
        },
      }),
    );
  });

  it('reports the Kimi preference independently of key', async () => {
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider) => provider === 'kimiCode',
    );
    mocks.getPreferKimiCode.mockReturnValue(true);

    await expect(readCliModelAccessStatus(secrets)).resolves.toEqual(
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

    mocks.hasUsableApiKey.mockResolvedValue(false);
    await expect(readCliModelAccessStatus(secrets)).resolves.toMatchObject({
      codingPlans: { kimiCode: { preferred: true, keySet: false } },
    });
  });

  it.effect(
    'enables Kimi Code routing on a personal fallback when a key exists',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockResolvedValue(true);

        const result = yield* updateCliModelAccess(
          context,
          subscriptionPreference('kimi-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
        expect(mocks.writePlatformSetting).toHaveBeenCalledWith(
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
          context,
          subscriptionPreference('kimi-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(mocks.writePlatformSetting).not.toHaveBeenCalled();
        expect(result.message).toContain('No Kimi Code API key configured');
        expect(result.message).toContain('https://www.kimi.com/code/console');
      }).pipe(withServices),
  );

  it.effect(
    'enables GLM Coding Plan routing on a personal fallback when a key exists',
    () =>
      Effect.gen(function* () {
        mocks.hasUsableApiKey.mockResolvedValue(true);

        const result = yield* updateCliModelAccess(
          context,
          subscriptionPreference('glm-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(mocks.setGLMCodingPlan).toHaveBeenCalledWith(true);
        expect(mocks.writePlatformSetting).not.toHaveBeenCalled();
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
        context,
        subscriptionPreference('glm-code', 'off'),
        { writeProgress: vi.fn() },
      );

      expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
      expect(mocks.setGLMCodingPlan).toHaveBeenCalledWith(false);
      expect(mocks.writePlatformSetting).not.toHaveBeenCalled();
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
      mocks.setPreferCodexSubscription.mockResolvedValue({
        effective: true,
        target: 'global',
      });
      const writeProgress = vi.fn();

      const result = yield* updateCliModelAccess(
        context,
        subscriptionPreference('chatgpt', 'on'),
        { writeProgress },
      );

      expect(mocks.signInCliSubscription).toHaveBeenCalledWith(
        'chatgpt',
        { device: false, noBrowser: false },
        { writeProgress },
      );
      expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(true);
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
      mocks.getCodexStatus.mockResolvedValue({
        signedIn: true,
        email: 'user@example.com',
      });
      mocks.isPreferCodexSubscription.mockReturnValue(true);
      mocks.setPreferCodexSubscription.mockResolvedValue({
        effective: false,
        target: 'global',
      });

      const result = yield* updateCliModelAccess(
        context,
        subscriptionPreference('chatgpt', 'off'),
        { writeProgress: vi.fn() },
      );

      expect(mocks.signInCliSubscription).not.toHaveBeenCalled();
      expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
      expect(mocks.writePlatformSetting).not.toHaveBeenCalled();
      expect(result).toEqual({
        message: 'Prefer ChatGPT subscription disabled for Codex models.',
      });
    }).pipe(withServices),
  );

  it.effect(
    'represents preferences independently and toggles each without side effects',
    () =>
      Effect.gen(function* () {
        mocks.getCodexStatus.mockResolvedValue({
          signedIn: true,
          email: 'user@example.com',
        });
        mocks.isPreferCodexSubscription.mockReturnValue(true);
        mocks.getPreferKimiCode.mockReturnValue(true);
        mocks.hasUsableApiKey.mockResolvedValue(true);

        const status = yield* Effect.promise(() =>
          readCliModelAccessStatus(secrets),
        );
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
          context,
          subscriptionPreference('kimi-code', 'off'),
          { writeProgress: vi.fn() },
        );
        expect(mocks.writePlatformSetting).toHaveBeenCalledWith(
          GlobalStateKey.KIMI_CODE_PREFER,
          false,
        );
        expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
        expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();

        vi.clearAllMocks();
        mocks.getCodexStatus.mockResolvedValue({
          signedIn: true,
          email: 'user@example.com',
        });
        mocks.isPreferCodexSubscription.mockReturnValue(true);
        mocks.setPreferCodexSubscription.mockResolvedValue({
          effective: false,
          target: 'global',
        });
        yield* updateCliModelAccess(
          context,
          subscriptionPreference('chatgpt', 'off'),
          { writeProgress: vi.fn() },
        );
        expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
        expect(mocks.writePlatformSetting).not.toHaveBeenCalled();
        expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();
      }).pipe(withServices),
  );

  it.effect('turns off a stale signed-out preference without signing in', () =>
    Effect.gen(function* () {
      mocks.isPreferCodexSubscription.mockReturnValue(true);
      mocks.setPreferCodexSubscription.mockResolvedValue({
        effective: false,
        target: 'global',
      });

      const status = yield* Effect.promise(() =>
        readCliModelAccessStatus(secrets),
      );
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
      yield* updateCliModelAccess(context, selection.value, {
        writeProgress: vi.fn(),
      });

      expect(mocks.signInCliSubscription).not.toHaveBeenCalled();
      expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
    }).pipe(withServices),
  );

  it.effect('turns off a stale Kimi preference without requiring a key', () =>
    Effect.gen(function* () {
      mocks.getPreferKimiCode.mockReturnValue(true);
      const status = yield* Effect.promise(() =>
        readCliModelAccessStatus(secrets),
      );
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
      yield* updateCliModelAccess(context, selection.value);

      expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
      expect(mocks.writePlatformSetting).toHaveBeenCalledWith(
        GlobalStateKey.KIMI_CODE_PREFER,
        false,
      );
      expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    }).pipe(withServices),
  );
});
