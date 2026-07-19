// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - tests
import * as serverKeysModule from '@auth/serverKeys';
import { refreshDesktopModelListStateIfNeeded } from '@desktop/main/desktopModelListRefresh';
import { DefaultDesktopCredentialSettingsController } from '@desktop/main/desktopCredentialSettingsController';
import { apiKeySecretName } from '@model/apiProviders';
import { DEFAULT_MODELS, MODEL_LIST_VERSION } from '@model/modelOptionsBasic';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  FakeConfigProvider,
  FakeSecrets,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

// Local imports - authentication and models

// Local imports - shared

const codexMocks = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({
    signedIn: false,
    preferSubscription: false,
    subscriptionToolUseOnly: false,
  })),
  login: vi.fn(async () => ({ email: 'user@example.com' })),
  setPreferSubscription: vi.fn(async (enabled: boolean) => ({
    effective: enabled,
  })),
  setSubscriptionToolUseOnly: vi.fn(async (enabled: boolean) => ({
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
  getChatGptAuthStatus: codexMocks.getStatus,
  loginWithLoopback: codexMocks.login,
  setCodexSubscriptionToolUseOnly: codexMocks.setSubscriptionToolUseOnly,
  setPreferCodexSubscription: codexMocks.setPreferSubscription,
}));

vi.mock('@model/computeModelOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@model/computeModelOptions')>()),
  computeModelOptionsData: modelMocks.compute,
  invalidateModelOptionsCache: modelMocks.invalidate,
}));

type ControllerOptions = ConstructorParameters<
  typeof DefaultDesktopCredentialSettingsController
>[0];

async function createFixture(
  overrides: Partial<ControllerOptions> = {},
): Promise<{
  controller: DefaultDesktopCredentialSettingsController;
  globalState: FakeStateStore;
  secrets: FakeSecrets;
  posted: unknown[];
  events: string[];
  confirms: string[];
  infos: string[];
  errors: string[];
  signIn: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  onCredentialChanged: ReturnType<typeof vi.fn>;
  setUseIncludedModelAccess: ReturnType<typeof vi.fn>;
}> {
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
  const errors: string[] = [];
  const signIn = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => undefined);
  const setUseIncludedModelAccess = vi.fn(async (enabled: boolean) => {
    events.push(`access:${enabled}`);
  });
  const onCredentialChanged = vi.fn(async () => {
    events.push('credential');
  });

  await installPlatform(
    { workspacePath: '/workspace' },
    { globalState, workspaceState, secrets },
  );
  vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
    canUseServerSideKeys: async () => false,
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
      input: async () => undefined,
      confirm: async (message) => {
        confirms.push(message);
        return true;
      },
    },
    externalOpener: {
      openExternal: async () => undefined,
      presentChatGptSignInUrl: () => undefined,
    },
    notifications: {
      showInfoMessage: async (message) => {
        infos.push(message);
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
    modelListRefresh: Promise.resolve(),
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
    errors,
    signIn,
    signOut,
    onCredentialChanged,
    setUseIncludedModelAccess,
  };
}

function commandOf(message: unknown): string | undefined {
  return (message as { command?: string }).command;
}

function requireAction<T>(
  candidate: T,
): Extract<T, (...args: never[]) => unknown> {
  if (typeof candidate !== 'function') {
    throw new Error('Expected a supported desktop credential action.');
  }
  return candidate as Extract<T, (...args: never[]) => unknown>;
}

describe('DefaultDesktopCredentialSettingsController', () => {
  beforeEach(() => {
    codexMocks.getStatus.mockResolvedValue({
      signedIn: false,
      preferSubscription: false,
      subscriptionToolUseOnly: false,
    });
    codexMocks.login.mockResolvedValue({ email: 'user@example.com' });
    codexMocks.setPreferSubscription.mockImplementation(async (enabled) => ({
      effective: enabled,
    }));
    codexMocks.setSubscriptionToolUseOnly.mockImplementation(
      async (enabled) => ({ effective: enabled }),
    );
    codexMocks.signOut.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('preserves a provider key when removal is cancelled', async () => {
    const secretName = apiKeySecretName('openai');
    const secrets = new FakeSecrets({ [secretName]: 'sk-test' });
    const deleteSpy = vi.spyOn(secrets, 'delete');
    const confirms: string[] = [];
    const fixture = await createFixture({
      secrets,
      prompt: {
        input: async () => undefined,
        confirm: async (message) => {
          confirms.push(message);
          return false;
        },
      },
    });

    await requireAction(fixture.controller.profileActions.removeProviderKey)(
      'openai',
    );

    expect(confirms).toEqual([
      'Remove the OpenAI API key? This cannot be undone.',
    ]);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await secrets.get(secretName)).toBe('sk-test');
    expect(fixture.onCredentialChanged).not.toHaveBeenCalled();
  });

  it('stores submitted keys before refreshing profile and model data', async () => {
    const fixture = await createFixture();

    await requireAction(fixture.controller.profileActions.setProviderKey)(
      'google',
      '  sk-test  ',
    );

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
    const confirms: string[] = [];
    const fixture = await createFixture({
      secrets,
      prompt: {
        input: async () => '  replacement  ',
        confirm: async (message) => {
          confirms.push(message);
          return true;
        },
      },
    });

    await requireAction(fixture.controller.profileActions.setProviderKey)(
      'openai',
      undefined,
    );
    expect(await secrets.get(secretName)).toBe('replacement');

    await requireAction(fixture.controller.profileActions.removeProviderKey)(
      'openai',
    );
    expect(deleteSpy).toHaveBeenCalledExactlyOnceWith(secretName);
    expect(await secrets.get(secretName)).toBeUndefined();
    expect(confirms).toEqual([
      'Remove the OpenAI API key? This cannot be undone.',
    ]);
  });

  it('persists included access and clears OpenRouter before refreshing', async () => {
    const globalState = new FakeStateStore({
      [GlobalStateKey.USE_OPENROUTER]: true,
    });
    const fixture = await createFixture({ globalState });

    await requireAction(fixture.controller.profileActions.setApiAccessMode)(
      'included',
    );

    expect(fixture.setUseIncludedModelAccess).toHaveBeenCalledWith(true);
    expect(globalState.get(GlobalStateKey.USE_OPENROUTER)).toBe(false);
    expect(fixture.events).toEqual([
      'access:true',
      `render:${SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE}`,
      `render:${SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION}`,
      'credential',
    ]);

    await requireAction(fixture.controller.profileActions.setApiAccessMode)(
      'personal',
    );
    expect(fixture.setUseIncludedModelAccess).toHaveBeenLastCalledWith(false);
    expect(fixture.onCredentialChanged).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'provider streaming',
      run: (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        requireAction(fixture.controller.profileActions.setProviderStreaming)(
          'openai',
          false,
        ),
    },
    {
      name: 'provider endpoint',
      run: (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        requireAction(fixture.controller.profileActions.setProviderEndpoint)(
          'openai',
          'https://example.com/v1',
        ),
    },
    {
      name: 'global streaming',
      run: (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        requireAction(fixture.controller.profileActions.setGlobalStreaming)(
          false,
        ),
    },
  ])('persists $name before refreshing profile data', async ({ run }) => {
    const fixture = await createFixture();
    let finishUpdate: (() => void) | undefined;
    vi.spyOn(fixture.globalState, 'update').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishUpdate = resolve;
        }),
    );

    const action = run(fixture);
    await vi.waitFor(() => expect(finishUpdate).toBeTypeOf('function'));
    expect(fixture.posted).toEqual([]);

    finishUpdate?.();
    await action;
    expect(fixture.posted.map(commandOf)).toEqual([
      SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
    ]);
  });

  it('delegates Researcher Access sign-in and sign-out without stale posts', async () => {
    const fixture = await createFixture();

    await requireAction(fixture.controller.profileActions.signIn)();
    await requireAction(fixture.controller.profileActions.signOut)();

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

  it('refreshes ChatGPT preferences and reports authentication outcomes', async () => {
    const fixture = await createFixture();

    await requireAction(
      fixture.controller.chatGptActions.setPreferSubscription,
    )(true);
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

    await fixture.controller.signInChatGpt({ enableSubscription: true });
    expect(codexMocks.login).toHaveBeenCalledOnce();
    expect(codexMocks.setPreferSubscription).toHaveBeenLastCalledWith(true);
    expect(fixture.infos).toContain(
      'Signed in with ChatGPT as user@example.com.',
    );

    await requireAction(
      fixture.controller.chatGptActions.setSubscriptionToolUseOnly,
    )(false);
    expect(codexMocks.setSubscriptionToolUseOnly).toHaveBeenCalledWith(false);

    await requireAction(fixture.controller.chatGptActions.signOut)();
    expect(codexMocks.signOut).toHaveBeenCalledOnce();
    expect(fixture.infos).toContain('Signed out of ChatGPT.');

    codexMocks.login.mockRejectedValueOnce(new Error('authorization denied'));
    await fixture.controller.signInChatGpt({ enableSubscription: true });

    expect(fixture.errors).toEqual([
      'ChatGPT sign-in failed: authorization denied',
    ]);
    expect(fixture.onCredentialChanged).toHaveBeenCalledTimes(5);
  });

  it('awaits the production model-list migration before model data', async () => {
    const globalState = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: 12,
      [GlobalStateKey.ENABLED_MODELS]: ['custom-model'],
    });
    const fixture = await createFixture({
      globalState,
      modelListRefresh: refreshDesktopModelListStateIfNeeded({ globalState }),
    });

    await fixture.controller.prepareModelSelectionData();

    expect(globalState.get(GlobalStateKey.MODEL_LIST_VERSION)).toBe(
      MODEL_LIST_VERSION,
    );
    const activeDefaults = DEFAULT_MODELS.filter(
      (model) => !(MODEL_CONFIGS[model]?.deprecated ?? false),
    );
    expect(globalState.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'custom-model',
      ...activeDefaults,
    ]);
  });

  it('removes retired models from a recent persisted model list', async () => {
    const globalState = new FakeStateStore({
      [GlobalStateKey.MODEL_LIST_VERSION]: 20,
      [GlobalStateKey.ENABLED_MODELS]: ['custom-model', 'haiku3'],
    });
    const fixture = await createFixture({
      globalState,
      modelListRefresh: refreshDesktopModelListStateIfNeeded({ globalState }),
    });

    await fixture.controller.prepareModelSelectionData();

    const activeDefaults = DEFAULT_MODELS.filter(
      (model) =>
        !(MODEL_CONFIGS[model]?.deprecated ?? false) &&
        !(MODEL_CONFIGS[model]?.retired ?? false),
    );
    expect(globalState.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'custom-model',
      ...activeDefaults,
    ]);
  });
});
