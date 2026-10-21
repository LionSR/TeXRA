import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { apiKeySecretName } from '@texra-ai/llm';

import {
  readCliModelAccessStatus,
  updateCliModelAccess,
} from '@cli/runtime/modelAccessSelection';
import { buildCliModelAccessItems } from '@cli/runtime/modelAccessRoute';
import { Secrets } from '@platform/secrets';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { withEnv } from '@test/support/testEnv';

import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { CODEX_SESSION_SECRET_KEY } from '../../../packages/llm/src/oauth/codex/codexProvider.js';

const mocks = vi.hoisted(() => ({
  isPreferCodexSubscription: vi.fn(),
  setPreferCodexSubscription: vi.fn(),
  isPreferXaiSubscription: vi.fn(),
  setPreferXaiSubscription: vi.fn(),
  shouldUseSubscriptionDeviceCode: vi.fn(),
  signInCliSubscription: vi.fn(),
}));

/** The key and session store, emptied before each case. Keys resolve from
 *  it and an empty environment, never the developer's shell. */
const secrets = new FakeSecrets();
let fake = makeFakeSettingsStores('cli');
let stores = fake.stores;

/** The stored Kimi Code switch, absent when nothing wrote it. */
const kimiPreference = Effect.suspend(() =>
  fake.globalState.get(GlobalStateKey.KIMI_CODE_PREFER),
);

/** Store the provider's own API key. */
const storeKey = (provider: 'kimiCode' | 'glm') =>
  secrets.set(apiKeySecretName(provider), `${provider}-key`);

/** Store a ChatGPT session signed in as `user@example.com`. */
const storeChatGptSession = secrets.set(
  CODEX_SESSION_SECRET_KEY,
  JSON.stringify({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() + 3_600_000,
    accountId: 'account-id',
    email: 'user@example.com',
  }),
);

/**
 * The process services these programs took from the process runtime before
 * the suite ran them natively: the same ports `installFakeHost` merges in.
 */
const withServices = Effect.provide(
  Layer.mergeAll(
    testHttpClientLayer,
    Secrets.layer(secrets),
    // Sign-in is mocked, so nothing is spawned.
    scriptedSpawnerLayer(() => ({})).layer,
  ),
);

/** `withServices` over an empty environment, for every case. */
const withHost = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(withEnv({}), withServices);

vi.mock('@model/subscriptionAccess', () => ({
  isPreferSubscription: (provider: string, stores: unknown) =>
    provider === 'chatgpt'
      ? mocks.isPreferCodexSubscription(stores)
      : mocks.isPreferXaiSubscription(stores),
  setPreferSubscription: (
    provider: string,
    stores: unknown,
    enabled: boolean,
  ) =>
    provider === 'chatgpt'
      ? mocks.setPreferCodexSubscription(stores, enabled)
      : mocks.setPreferXaiSubscription(stores, enabled),
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

function subscriptionPreference(
  provider: 'chatgpt' | 'grok' | 'kimi-code' | 'glm-code',
  state: 'on' | 'off',
) {
  return { kind: 'subscription-preference', provider, state } as const;
}

function expectedAccessStatus(chatgpt: {
  readonly signedIn: boolean;
  readonly email?: string;
  readonly accountId?: string;
  readonly preferSubscription: boolean;
}) {
  return {
    subscriptions: {
      chatgpt: { provider: 'chatgpt', ...chatgpt },
      grok: { provider: 'grok', signedIn: false, preferSubscription: false },
    },
    codingPlans: {
      glmCodingPlan: { preferred: false, keySet: false },
      kimiCode: { preferred: false, keySet: false },
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of await Effect.runPromise(secrets.listStoredKeys()))
    await Effect.runPromise(secrets.delete(key));
  mocks.isPreferCodexSubscription.mockReturnValue(false);
  mocks.isPreferXaiSubscription.mockReturnValue(false);
  mocks.setPreferCodexSubscription.mockReturnValue(Effect.void);
  mocks.setPreferXaiSubscription.mockReturnValue(Effect.void);
  mocks.shouldUseSubscriptionDeviceCode.mockReturnValue(false);
  fake = makeFakeSettingsStores('cli');
  stores = fake.stores;
});

describe('CLI model access routes', () => {
  it.effect('reports the ChatGPT preference independently of sign-in', () =>
    Effect.gen(function* () {
      yield* storeChatGptSession;
      mocks.isPreferCodexSubscription.mockReturnValue(true);

      expect(yield* readCliModelAccessStatus(stores, secrets)).toEqual(
        expectedAccessStatus({
          signedIn: true,
          email: 'user@example.com',
          accountId: 'account-id',
          preferSubscription: true,
        }),
      );

      yield* secrets.delete(CODEX_SESSION_SECRET_KEY);
      expect(yield* readCliModelAccessStatus(stores, secrets)).toEqual(
        expectedAccessStatus({ signedIn: false, preferSubscription: true }),
      );
    }).pipe(withHost),
  );

  it.effect(
    'enables Kimi Code routing on a personal fallback when a key exists',
    () =>
      Effect.gen(function* () {
        yield* storeKey('kimiCode');

        const result = yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('kimi-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
        expect(yield* kimiPreference).toBe(true);
        expect(result).toEqual({
          message:
            'Kimi Code subscription enabled for Kimi models · other models still use your own API keys.',
        });
      }).pipe(withHost),
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

        expect(yield* kimiPreference).toBeUndefined();
        expect(result.message).toContain('No Kimi Code API key configured');
        expect(result.message).toContain('https://www.kimi.com/code/console');
      }).pipe(withHost),
  );

  it.effect(
    'enables GLM Coding Plan routing on a personal fallback when a key exists',
    () =>
      Effect.gen(function* () {
        yield* storeKey('glm');

        const result = yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('glm-code', 'on'),
          { writeProgress: vi.fn() },
        );

        expect(
          yield* fake.globalState.get(GlobalStateKey.GLM_CODING_PLAN),
        ).toBe(true);
        expect(yield* kimiPreference).toBeUndefined();
        expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
        expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();
        expect(result).toEqual({
          message:
            'GLM Coding Plan enabled for GLM models · other models still use your own API keys.',
        });
      }).pipe(withHost),
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
      expect(result.message).toBe(
        'ChatGPT subscription enabled for Codex models (user@example.com).',
      );
    }).pipe(withHost),
  );

  it.effect(
    'represents preferences independently and toggles each without side effects',
    () =>
      Effect.gen(function* () {
        yield* storeChatGptSession;
        yield* storeKey('kimiCode');
        yield* storeKey('glm');
        mocks.isPreferCodexSubscription.mockReturnValue(true);
        yield* fake.globalState.update(GlobalStateKey.KIMI_CODE_PREFER, true);

        const status = yield* readCliModelAccessStatus(stores, secrets);
        expect(status.subscriptions.chatgpt.preferSubscription).toBe(true);
        expect(status.subscriptions.grok.preferSubscription).toBe(false);
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
          grok: 'Off · select to sign in and turn on',
          'kimi-code': 'On · key configured',
          'glm-code': 'Off · select to turn on',
        });

        yield* updateCliModelAccess(
          stores,
          context,
          subscriptionPreference('kimi-code', 'off'),
          { writeProgress: vi.fn() },
        );
        expect(yield* kimiPreference).toBe(false);
        expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
        expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();

        vi.clearAllMocks();
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
        expect(yield* kimiPreference).toBe(false);
        expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();
      }).pipe(withHost),
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
    }).pipe(withHost),
  );

  it.effect('turns off a stale Kimi preference without requiring a key', () =>
    Effect.gen(function* () {
      yield* fake.globalState.update(GlobalStateKey.KIMI_CODE_PREFER, true);
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
      const reads = vi.spyOn(secrets, 'get');
      yield* Effect.addFinalizer(() => Effect.sync(() => reads.mockRestore()));
      yield* updateCliModelAccess(stores, context, selection.value);

      expect(reads).not.toHaveBeenCalledWith(apiKeySecretName('kimiCode'));
      expect(yield* kimiPreference).toBe(false);
      expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    }).pipe(withHost),
  );
});
