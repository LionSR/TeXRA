// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import type { SubscriptionDeviceCodePrompt } from '@controllers/modelAccess/subscriptionProviders';
import { DefaultDesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import { ExternalOpenFailed } from '@hosts/uiHosts';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { apiKeySecretName } from '@model/apiProviders';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { withProcessServices } from '@platform/processRuntime';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ModelOptionData } from '@shared/schemas';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  FakeConfigProvider,
  FakeSecrets,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

import { commandOf } from './desktopSettingsTestSupport';

const codexMocks = vi.hoisted(() => ({
  getStatus: vi.fn((providerId: 'chatgpt' | 'grok' = 'chatgpt') =>
    Effect.succeed({
      provider: providerId,
      signedIn: false,
      preferSubscription: false,
    }),
  ),
  login: vi.fn(
    (_options: {
      openBrowser(url: string): Effect.Effect<void, unknown>;
    }): Effect.Effect<{ email: string }, unknown> =>
      Effect.succeed({ email: 'user@example.com' }),
  ),
  loginWithDeviceCode: vi.fn(
    (_options: {
      onPrompt(prompt: SubscriptionDeviceCodePrompt): void;
    }): Effect.Effect<{ email: string }, unknown> =>
      Effect.succeed({ email: 'user@example.com' }),
  ),
  setPreferSubscription: vi.fn(
    (_stores: unknown, _enabled: boolean) => Effect.void,
  ),
  signOut: vi.fn(() => Effect.void),
}));

const modelMocks = vi.hoisted(() => ({
  readInputs: vi.fn(
    (_stores: ModelOptionStores, models: readonly string[] = []) =>
      Effect.succeed(models.map((model) => ({ value: model, label: model }))),
  ),
}));

vi.mock('@auth/codex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auth/codex')>()),
  codexCoordinator: () => ({ signOut: codexMocks.signOut }),
  loginWithDeviceCode: codexMocks.loginWithDeviceCode,
  loginWithLoopback: codexMocks.login,
}));

vi.mock('@controllers/modelAccess/subscriptionAuthStatus', () => ({
  subscriptionAuthStatus: codexMocks.getStatus,
}));

vi.mock('@model/codex/codexSubscription', () => ({
  isPreferCodexSubscription: () => false,
  setPreferCodexSubscription: codexMocks.setPreferSubscription,
  CODEX_PREFER_SUBSCRIPTION_KEY: 'texra.chatgptCodex.preferSubscription',
}));

vi.mock('@model/computeModelOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@model/computeModelOptions')>()),
  readModelAvailabilityInputs: modelMocks.readInputs,
  // The mocked read resolves the rows this fixture wants; the pure finisher
  // hands them back.
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
}));

type ControllerOptions = ConstructorParameters<
  typeof DefaultDesktopCredentialSettingsController
>[0];

/** Prompt answers the fixture's recording `prompt` port replies with. */
type FixtureOverrides = Partial<ControllerOptions> & {
  promptInput?: string;
  confirmResult?: boolean;
};

async function createFixture({
  promptInput,
  confirmResult = true,
  ...overrides
}: FixtureOverrides = {}) {
  const globalState =
    (overrides.globalState as FakeStateStore | undefined) ??
    new FakeStateStore();
  const workspaceState =
    (overrides.workspaceState as FakeStateStore | undefined) ??
    new FakeStateStore();
  const secrets =
    (overrides.secrets as FakeSecrets | undefined) ?? new FakeSecrets();
  const posted: unknown[] = [];
  const events: string[] = [];
  const confirms: string[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const signIn = vi.fn(() => Effect.void);
  const signOut = vi.fn(() => Effect.void);
  const onCredentialChanged = vi.fn(() =>
    Effect.sync(() => {
      events.push('credential');
    }),
  );
  const onModelOptionsChanged = vi.fn(() =>
    Effect.sync(() => {
      events.push('modelOptions');
    }),
  );
  const unavailable = (provider: string) => ({
    state: 'unavailable' as const,
    provider: provider as 'chatgpt',
    providerName: provider,
    planName: provider,
    fetchedAt: 0,
    windows: [] as [],
    reason: 'missing_credentials' as const,
  });
  const subscriptionUsage = {
    getAllUsage: vi.fn(() =>
      Effect.succeed({
        chatgpt: unavailable('chatgpt'),
        kimiCode: unavailable('kimiCode'),
        glmCodingPlan: unavailable('glmCodingPlan'),
      }),
    ),
    invalidate: vi.fn(),
  };

  await installPlatform(
    { workspacePath: '/workspace' },
    { globalState, workspaceState, secrets },
  );

  const controller = new DefaultDesktopCredentialSettingsController({
    runtime: testRuntime(),
    stores: { config: new FakeConfigProvider(), workspaceState, globalState },
    workspaceState,
    globalState,
    config: new FakeConfigProvider(),
    secrets,
    renderer: {
      postToRenderer(message) {
        posted.push(message);
        events.push(`render:${commandOf(message)}`);
      },
    },
    prompt: {
      input: () => Effect.succeed(promptInput),
      confirm: (message) =>
        Effect.sync(() => {
          confirms.push(message);
          return confirmResult;
        }),
      info: (message) =>
        Effect.sync(() => {
          infos.push(message);
          return undefined;
        }),
    },
    externalOpener: {
      openExternal: () => Effect.void,
      openSubscriptionSignInUrl: () => Effect.void,
      presentSubscriptionSignInUrl: () => Effect.void,
      presentSubscriptionDeviceCode: () => Effect.void,
    },
    notifications: {
      showInfoMessage: (message) =>
        Effect.sync(() => {
          infos.push(message);
        }),
      showWarningMessage: (message) =>
        Effect.sync(() => {
          warnings.push(message);
        }),
      showErrorMessage: (message) =>
        Effect.sync(() => {
          errors.push(message);
        }),
    },
    auth: {
      signIn,
      signOut,
    },
    subscriptionUsage,
    onCredentialChanged,
    onModelOptionsChanged,
    onError: () => undefined,
    ...overrides,
  });

  return {
    controller,
    globalState,
    secrets,
    posted,
    events,
    confirms,
    infos,
    warnings,
    errors,
    signIn,
    signOut,
    onCredentialChanged,
    onModelOptionsChanged,
    subscriptionUsage,
  };
}

describe('DefaultDesktopCredentialSettingsController', () => {
  beforeEach(() => {
    codexMocks.getStatus.mockImplementation((providerId = 'chatgpt') =>
      Effect.succeed({
        provider: providerId,
        signedIn: false,
        preferSubscription: false,
      }),
    );
    codexMocks.login.mockReturnValue(
      Effect.succeed({ email: 'user@example.com' }),
    );
    codexMocks.loginWithDeviceCode.mockReturnValue(
      Effect.succeed({ email: 'user@example.com' }),
    );
    codexMocks.setPreferSubscription.mockImplementation(() => Effect.void);
    codexMocks.signOut.mockReturnValue(Effect.void);
  });

  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.effect('preserves a provider key when removal is cancelled', () =>
    Effect.gen(function* () {
      const secretName = apiKeySecretName('openai');
      const secrets = new FakeSecrets({ [secretName]: 'sk-test' });
      const deleteSpy = vi.spyOn(secrets, 'delete');
      const fixture = yield* Effect.promise(() =>
        createFixture({ secrets, confirmResult: false }),
      );

      yield* Effect.gen(function* () {
        yield* withProcessServices(
          testRuntime(),
          fixture.controller.profileKeyController.removeProviderKey('openai'),
        );
      });

      expect(fixture.confirms).toEqual([
        'Remove the OpenAI API key? This cannot be undone.',
      ]);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(yield* secrets.get(secretName)).toBe('sk-test');
      expect(fixture.onCredentialChanged).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'stores prompted keys before refreshing profile and model data',
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          createFixture({
            promptInput: '  sk-google-secret  ',
          }),
        );

        yield* Effect.gen(function* () {
          yield* withProcessServices(
            testRuntime(),
            fixture.controller.profileKeyController.setProviderKey('google'),
          );
        });

        expect(yield* fixture.secrets.get('apiKey.google')).toBe(
          'sk-google-secret',
        );
        expect(fixture.infos).toEqual(['Google API key has been set']);
        expect(
          fixture.posted.findLast(
            (message) =>
              commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
          ),
        ).toMatchObject({
          providerKeyStatuses: expect.arrayContaining([
            expect.objectContaining({ provider: 'google', status: 'set' }),
          ]),
        });
        expect(fixture.events).toEqual([
          `render:${SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE}`,
          `render:${SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION}`,
          'modelOptions',
          'credential',
        ]);
      }),
  );

  it.effect.each([
    { provider: 'kimiCode', usageProvider: 'kimiCode' },
    { provider: 'glm', usageProvider: 'glmCodingPlan' },
  ] as const)(
    'invalidates and refreshes $provider subscription usage after a key change',
    ({ provider, usageProvider }) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          createFixture({ promptInput: 'new-secret' }),
        );

        yield* withProcessServices(
          testRuntime(),
          fixture.controller.profileKeyController.setProviderKey(provider),
        );

        expect(fixture.subscriptionUsage.invalidate).toHaveBeenCalledWith(
          usageProvider,
        );
        expect(fixture.subscriptionUsage.getAllUsage).toHaveBeenCalledOnce();
        expect(fixture.posted).toContainEqual(
          expect.objectContaining({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
          }),
        );
        expect(JSON.stringify(fixture.posted)).not.toContain('new-secret');
      }),
  );

  // Provider toggles are written by the shared catalog path
  // (`UPDATE_STATE_SETTING`); this pins the desktop refresh that path triggers.

  it.effect(
    'falls back without reporting the browser-open failure twice and logs its cause',
    () =>
      Effect.gen(function* () {
        const browserError = new Error('no browser handler');
        const openExternal = vi.fn(() => Effect.void);
        const openSubscriptionSignInUrl = vi.fn((url: string) =>
          Effect.fail(
            new ExternalOpenFailed({
              kind: 'url',
              target: url,
              message: `The desktop could not open ${url} in the default browser.`,
              cause: browserError,
            }),
          ),
        );
        const presentSubscriptionSignInUrl = vi.fn(() => Effect.void);
        const presentSubscriptionDeviceCode = vi.fn(() => Effect.void);
        const logs = captureLogEntries();
        const fixture = yield* Effect.promise(() =>
          createFixture({
            externalOpener: {
              openExternal,
              openSubscriptionSignInUrl,
              presentSubscriptionSignInUrl,
              presentSubscriptionDeviceCode,
            },
          }),
        );
        codexMocks.login.mockImplementationOnce(({ openBrowser }) =>
          openBrowser('https://auth.openai.com/authorize').pipe(
            Effect.as({ email: 'loopback@example.com' }),
          ),
        );
        codexMocks.loginWithDeviceCode.mockImplementationOnce(({ onPrompt }) =>
          Effect.sync(() => {
            onPrompt({
              userCode: 'ABCD-EFGH',
              verificationUrl: 'https://auth.openai.com/device',
            });
            return { email: 'device@example.com' };
          }),
        );

        yield* withProcessServices(
          testRuntime(),
          fixture.controller.signInChatGpt(),
        );

        expect(openSubscriptionSignInUrl).toHaveBeenCalledExactlyOnceWith(
          'https://auth.openai.com/authorize',
        );
        expect(openExternal).not.toHaveBeenCalled();
        expect(presentSubscriptionSignInUrl).not.toHaveBeenCalled();
        expect(presentSubscriptionDeviceCode).toHaveBeenCalledExactlyOnceWith(
          {
            userCode: 'ABCD-EFGH',
            verificationUrl: 'https://auth.openai.com/device',
          },
          'ChatGPT',
        );
        expect(fixture.errors).toEqual([]);
        expect(fixture.infos).toContain(
          'Signed in with ChatGPT as device@example.com.',
        );
        const warnings = logs.at('WARN', 'subscriptionProviders');
        expect(warnings.map((entry) => entry.message)).toEqual([
          'ChatGPT browser sign-in is unavailable, falling back to a one-time device code: Could not open a browser for ChatGPT sign-in. Cause: no browser handler',
        ]);
        // The sink renders the raw payload, cause chain included.
        expect(String(warnings[0]?.annotations['data'])).toContain(
          browserError.message,
        );
      }).pipe(Effect.provide(effectDiagnosticsLayer('Trace'))),
  );
});
