// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { MAX_TIER } from '@auth/config';
import { RELAY_CI_TOKEN_PREFIX, RELAY_TOKEN_ENV_VAR } from '@auth/relayToken';
import * as serverKeysModule from '@auth/serverKeys';
import { DefaultDesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import { apiKeySecretName } from '@model/apiProviders';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { assertSupported } from '@shared/utils/dispatcher';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  FakeConfigProvider,
  FakeSecrets,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

import { commandOf } from './desktopSettingsTestSupport';

const codexMocks = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({
    signedIn: false,
    preferSubscription: false,
  })),
  login: vi.fn(async () => ({ email: 'user@example.com' })),
  setPreferSubscription: vi.fn(async (enabled: boolean) => ({
    effective: enabled,
  })),
  signOut: vi.fn(async () => undefined),
}));

const modelMocks = vi.hoisted(() => ({
  compute: vi.fn(async (models: readonly string[] = []) =>
    models.map((model) => ({ value: model, label: model })),
  ),
  invalidate: vi.fn(),
}));

vi.mock('@auth/codex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auth/codex')>()),
  codexCoordinator: () => ({ signOut: codexMocks.signOut }),
  loginWithLoopback: codexMocks.login,
}));

vi.mock('@controllers/modelAccess/chatGptAuthStatus', () => ({
  getChatGptAuthStatus: codexMocks.getStatus,
}));

vi.mock('@model/codex/codexPreference', () => ({
  isPreferCodexSubscription: () => false,
  setPreferCodexSubscription: codexMocks.setPreferSubscription,
  CODEX_PREFER_SUBSCRIPTION_KEY: 'texra.chatgptCodex.preferSubscription',
}));

vi.mock('@model/computeModelOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@model/computeModelOptions')>()),
  computeModelOptionsData: modelMocks.compute,
  invalidateModelOptionsCache: modelMocks.invalidate,
}));

type ControllerOptions = ConstructorParameters<
  typeof DefaultDesktopCredentialSettingsController
>[0];
type Fixture = Awaited<ReturnType<typeof createFixture>>;

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
  const signIn = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => undefined);
  const setUseIncludedModelAccess = vi.fn(async (enabled: boolean) => {
    events.push(`access:${enabled}`);
  });
  const refreshSpendingStatus = vi.fn(async () => null);
  const onCredentialChanged = vi.fn(async () => {
    events.push('credential');
  });
  const subscriptionUsage = {
    getUsage: vi.fn(async (provider: string) => ({
      state: 'unavailable' as const,
      provider: provider as 'chatgpt',
      providerName: provider,
      planName: provider,
      fetchedAt: 0,
      windows: [] as [],
      reason: 'missing_credentials' as const,
    })),
    invalidate: vi.fn(),
  };

  await installPlatform(
    { workspacePath: '/workspace' },
    { globalState, workspaceState, secrets },
  );
  vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
    canUseServerSideKeys: async () => false,
    refreshSpendingStatus: async () => null,
    getUseIncludedModelAccess: () => false,
    wasQuotaAutoSwitched: () => false,
    isRelayQuotaExceeded: () => false,
    isProviderOnServer: () => false,
    canUseModelSync: () => false,
  } as unknown as ReturnType<typeof serverKeysModule.getServerSideKeyService>);

  const controller = new DefaultDesktopCredentialSettingsController({
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
      input: async () => promptInput,
      confirm: async (message) => {
        confirms.push(message);
        return confirmResult;
      },
    },
    externalOpener: {
      openExternal: async () => undefined,
      presentSubscriptionSignInUrl: () => undefined,
    },
    notifications: {
      showInfoMessage: async (message) => {
        infos.push(message);
      },
      showWarningMessage: async (message) => {
        warnings.push(message);
      },
      showErrorMessage: async (message) => {
        errors.push(message);
      },
    },
    auth: {
      signIn,
      signOut,
    },
    setUseIncludedModelAccess,
    refreshSpendingStatus,
    subscriptionUsage,
    modelSelectionExtras: {
      useIncludedAccess: () => false,
      getUserTier: () => undefined,
    },
    onCredentialChanged,
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
    setUseIncludedModelAccess,
    refreshSpendingStatus,
    subscriptionUsage,
  };
}

describe('DefaultDesktopCredentialSettingsController', () => {
  beforeEach(() => {
    codexMocks.getStatus.mockResolvedValue({
      signedIn: false,
      preferSubscription: false,
    });
    codexMocks.login.mockResolvedValue({ email: 'user@example.com' });
    codexMocks.setPreferSubscription.mockImplementation(async (enabled) => ({
      effective: enabled,
    }));
    codexMocks.signOut.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('preserves a provider key when removal is cancelled', async () => {
    const secretName = apiKeySecretName('openai');
    const secrets = new FakeSecrets({ [secretName]: 'sk-test' });
    const deleteSpy = vi.spyOn(secrets, 'delete');
    const fixture = await createFixture({ secrets, confirmResult: false });

    await assertSupported(fixture.controller.profileHandlers.removeProviderKey)(
      {
        command: SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY,
        provider: 'openai',
      },
    );

    expect(fixture.confirms).toEqual([
      'Remove the OpenAI API key? This cannot be undone.',
    ]);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await secrets.get(secretName)).toBe('sk-test');
    expect(fixture.onCredentialChanged).not.toHaveBeenCalled();
  });

  it('stores submitted keys before refreshing profile and model data', async () => {
    const fixture = await createFixture();

    await assertSupported(fixture.controller.profileHandlers.setProviderKey)({
      command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
      provider: 'google',
      apiKey: '  sk-test  ',
    });

    expect(await fixture.secrets.get('apiKey.google')).toBe('sk-test');
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
      `render:${MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS}`,
      'credential',
    ]);
  });

  it('uses the shared key prompt and removes a confirmed key', async () => {
    const secretName = apiKeySecretName('openai');
    const secrets = new FakeSecrets({ [secretName]: 'old-key' });
    const deleteSpy = vi.spyOn(secrets, 'delete');
    const fixture = await createFixture({
      secrets,
      promptInput: '  replacement  ',
    });

    await assertSupported(fixture.controller.profileHandlers.setProviderKey)({
      command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
      provider: 'openai',
      apiKey: undefined,
    });
    expect(await secrets.get(secretName)).toBe('replacement');

    await assertSupported(fixture.controller.profileHandlers.removeProviderKey)(
      {
        command: SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY,
        provider: 'openai',
      },
    );
    expect(deleteSpy).toHaveBeenCalledExactlyOnceWith(secretName);
    expect(await secrets.get(secretName)).toBeUndefined();
    expect(fixture.confirms).toEqual([
      'Remove the OpenAI API key? This cannot be undone.',
    ]);
  });

  it.each([
    ['kimiCode', 'kimiCode'],
    ['glm', 'glmCodingPlan'],
  ] as const)(
    'invalidates and refreshes %s subscription usage after a key change',
    async (provider, usageProvider) => {
      const fixture = await createFixture();

      await assertSupported(fixture.controller.profileHandlers.setProviderKey)({
        command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
        provider,
        apiKey: 'new-secret',
      });

      expect(fixture.subscriptionUsage.invalidate).toHaveBeenCalledWith(
        usageProvider,
      );
      expect(fixture.subscriptionUsage.getUsage).toHaveBeenCalledTimes(3);
      expect(fixture.posted).toContainEqual(
        expect.objectContaining({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
        }),
      );
      expect(JSON.stringify(fixture.posted)).not.toContain('new-secret');
    },
  );

  it('persists included access and clears OpenRouter before refreshing', async () => {
    const globalState = new FakeStateStore({
      [GlobalStateKey.USE_OPENROUTER]: true,
    });
    const fixture = await createFixture({ globalState });

    await assertSupported(fixture.controller.profileHandlers.setApiAccessMode)({
      command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      mode: 'included',
    });

    expect(fixture.setUseIncludedModelAccess).toHaveBeenCalledWith(true);
    expect(globalState.get(GlobalStateKey.USE_OPENROUTER)).toBe(false);
    expect(fixture.events).toEqual([
      'access:true',
      `render:${SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE}`,
      `render:${SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION}`,
      'credential',
    ]);

    await assertSupported(fixture.controller.profileHandlers.setApiAccessMode)({
      command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      mode: 'personal',
    });
    expect(fixture.setUseIncludedModelAccess).toHaveBeenLastCalledWith(false);
    expect(fixture.onCredentialChanged).toHaveBeenCalledTimes(2);
  });

  it('rejects exhausted included access and accepts it after refreshed headroom', async () => {
    const globalState = new FakeStateStore({
      [GlobalStateKey.USE_OPENROUTER]: true,
    });
    let remaining = 0;
    const fixture = await createFixture({
      globalState,
      refreshSpendingStatus: async () => ({
        currentSpend: 100 - remaining,
        limit: 100,
        remaining,
        percentUsed: 100 - remaining,
      }),
    });
    const setMode = assertSupported(
      fixture.controller.profileHandlers.setApiAccessMode,
    );

    await setMode({
      command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      mode: 'included',
    });
    expect(fixture.setUseIncludedModelAccess).not.toHaveBeenCalled();
    expect(globalState.get(GlobalStateKey.USE_OPENROUTER)).toBe(true);
    expect(fixture.onCredentialChanged).not.toHaveBeenCalled();
    expect(fixture.infos).toContain(
      'Included access is unavailable because this month’s quota is exhausted.',
    );

    remaining = 25;
    await setMode({
      command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      mode: 'included',
    });
    expect(fixture.setUseIncludedModelAccess).toHaveBeenCalledOnce();
    expect(globalState.get(GlobalStateKey.USE_OPENROUTER)).toBe(false);
    expect(fixture.onCredentialChanged).toHaveBeenCalledOnce();
  });

  // Provider toggles are written by the shared catalog path
  // (`UPDATE_STATE_SETTING`); this pins the desktop refresh that path triggers.
  it('refreshes model availability after a provider toggle', async () => {
    const fixture = await createFixture();

    await fixture.controller.refreshAfterProviderSettingChange(
      GlobalStateKey.USE_OPENROUTER,
    );

    expect(fixture.events).toEqual([
      `render:${SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE}`,
      `render:${SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION}`,
      `render:${MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS}`,
      'credential',
    ]);
  });

  it('replaces GLM usage after the region changes', async () => {
    const fixture = await createFixture();

    await fixture.controller.refreshAfterProviderSettingChange(
      GlobalStateKey.GLM_USE_CHINA,
    );

    expect(fixture.subscriptionUsage.invalidate).not.toHaveBeenCalled();
    expect(fixture.subscriptionUsage.getUsage).toHaveBeenCalledTimes(3);
    expect(fixture.posted).toContainEqual(
      expect.objectContaining({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      }),
    );
  });

  it('delegates Researcher Access sign-in and sign-out without stale posts', async () => {
    const fixture = await createFixture();

    await assertSupported(fixture.controller.profileHandlers.signIn)({
      command: SETTINGS_VIEW_COMMANDS.SIGN_IN,
    });
    await assertSupported(fixture.controller.profileHandlers.signOut)({
      command: SETTINGS_VIEW_COMMANDS.SIGN_OUT,
    });

    expect(fixture.signIn).toHaveBeenCalledOnce();
    expect(fixture.signOut).toHaveBeenCalledOnce();
    expect(fixture.posted).toEqual([]);
  });

  it('refreshes auth-dependent data in renderer order', async () => {
    const fixture = await createFixture();

    await fixture.controller.refreshAuthDependentData();

    expect(fixture.events).toEqual([
      `render:${SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION}`,
      `render:${MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS}`,
      `render:${SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE}`,
    ]);
    expect(fixture.onCredentialChanged).not.toHaveBeenCalled();
  });

  it('posts profile and ChatGPT status as one startup responsibility', async () => {
    const fixture = await createFixture();

    await fixture.controller.postStartupData();

    expect(fixture.posted.map(commandOf)).toEqual(
      expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
        SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
      ]),
    );
  });

  it('warns when a more specific setting overrides the requested subscription toggle', async () => {
    const fixture = await createFixture();
    codexMocks.setPreferSubscription.mockResolvedValueOnce({
      effective: false,
    });

    await assertSupported(
      fixture.controller.chatGptHandlers.setChatGptPreferSubscription,
    )({
      command: SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
      enabled: true,
    });
    expect(fixture.warnings).toEqual([
      'A more specific setting still keeps ChatGPT subscription disabled.',
    ]);
    expect(fixture.infos).toEqual([]);
  });

  it('refreshes ChatGPT preferences and reports authentication outcomes', async () => {
    const fixture = await createFixture();

    await assertSupported(
      fixture.controller.chatGptHandlers.setChatGptPreferSubscription,
    )({
      command: SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
      enabled: true,
    });
    expect(codexMocks.setPreferSubscription).toHaveBeenCalledWith(true);
    expect(fixture.onCredentialChanged).toHaveBeenCalledOnce();
    expect(fixture.events.at(-1)).toBe('credential');
    expect(fixture.events.slice(0, -1)).toEqual(
      expect.arrayContaining([
        `render:${SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS}`,
        `render:${SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION}`,
        `render:${MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS}`,
      ]),
    );

    await fixture.controller.signInChatGpt();
    expect(codexMocks.login).toHaveBeenCalledOnce();
    expect(codexMocks.setPreferSubscription).toHaveBeenLastCalledWith(true);
    expect(fixture.infos).toContain(
      'Signed in with ChatGPT as user@example.com.',
    );

    await assertSupported(fixture.controller.chatGptHandlers.signOutChatGpt)({
      command: SETTINGS_VIEW_COMMANDS.SIGN_OUT_CHATGPT,
    });
    expect(codexMocks.signOut).toHaveBeenCalledOnce();
    expect(fixture.infos).toContain('Signed out of ChatGPT.');

    codexMocks.login.mockRejectedValueOnce(new Error('authorization denied'));
    await fixture.controller.signInChatGpt();

    expect(fixture.errors).toEqual([
      'ChatGPT sign-in failed: authorization denied',
    ]);
    expect(fixture.onCredentialChanged).toHaveBeenCalledTimes(4);
  });

  it('routes Codex through the subscription for a Settings-panel sign-in', async () => {
    const fixture = await createFixture();

    await assertSupported(fixture.controller.chatGptHandlers.signInChatGpt)({
      command: SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT,
    });

    expect(codexMocks.login).toHaveBeenCalledOnce();
    expect(codexMocks.setPreferSubscription).toHaveBeenCalledWith(true);
  });

  it.each([
    {
      name: 'reports after sign-out that a configured relay token still authenticates',
      relayToken: `${RELAY_CI_TOKEN_PREFIX}ci-token`,
      expectedInfos: [expect.stringContaining(RELAY_TOKEN_ENV_VAR)],
    },
    {
      name: 'stays silent after sign-out when no relay token is configured',
      relayToken: '',
      expectedInfos: [],
    },
  ])('$name', async ({ relayToken, expectedInfos }) => {
    vi.stubEnv(RELAY_TOKEN_ENV_VAR, relayToken);
    const fixture = await createFixture();

    await assertSupported(fixture.controller.profileHandlers.signOut)({
      command: SETTINGS_VIEW_COMMANDS.SIGN_OUT,
    });

    expect(fixture.signOut).toHaveBeenCalledOnce();
    expect(fixture.infos).toEqual(expectedInfos);
  });

  it('applies the Included-Access reasoning cap to the model list', async () => {
    const fixture = await createFixture({
      modelSelectionExtras: {
        useIncludedAccess: () => true,
        getUserTier: () => MAX_TIER,
      },
    });

    const { models } =
      await fixture.controller.modelSelectionController.buildSelectionData();

    expect(models.find((model) => model.name === 'gpt55')).toMatchObject({
      supportsReasoningLevel: true,
      includedAccessReasoningCap: 'high',
    });
  });
});
