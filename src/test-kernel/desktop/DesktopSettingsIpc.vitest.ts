import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { MODEL_LIST_VERSION } from '@model/modelOptionsBasic';
import type { StateStore } from '@platform/interfaces';
import { platform } from '@platform/platform';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  BASH_APPROVAL_CONFIG_KEY,
  AGENT_SKILLS_CONFIG_KEY,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  FakeScopedConfigProvider,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { GoalStore } from '@tools/goal';
import {
  isWorktreeSupportEnabled,
  setWorktreeSupportEnabled,
} from '@utils/config/worktreeConfig';
import { getGitAuthorEnv, setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

import {
  commandOf,
  createStubDesktopAgentSettingsController,
  createStubDesktopCredentialSettingsController,
  createStubDesktopSettingsUiHost,
  createStubDesktopToolingSettingsController,
} from './desktopSettingsTestSupport';
import { loadSourceModule } from './loadSourceModule.ts';

const computeModelOptionsData = vi.hoisted(() =>
  vi.fn(async (models: readonly string[] = []) =>
    models.map((model) => ({ value: model, label: model })),
  ),
);

vi.mock('@model/computeModelOptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@model/computeModelOptions')>()),
  computeModelOptionsData,
  invalidateModelOptionsCache: vi.fn(),
}));

type DesktopSettingsIpcModule =
  typeof import('@desktop/main/desktopSettingsIpc');

type DesktopSettingsIpcOptions = Parameters<
  DesktopSettingsIpcModule['createDesktopSettingsIpc']
>[0];
type RendererMessage = Parameters<
  DesktopSettingsIpcOptions['postToRenderer']
>[0];

type SettingsFixtureOverrides = Omit<
  Partial<DesktopSettingsIpcOptions>,
  'state' | 'ui'
> & {
  globalState?: StateStore;
  workspaceState?: StateStore;
  ui?: Partial<DesktopSettingsIpcOptions['ui']>;
};

type CapturedSettingsFixtureOverrides = Omit<
  SettingsFixtureOverrides,
  'postToRenderer'
>;

let createDesktopSettingsIpc!: DesktopSettingsIpcModule['createDesktopSettingsIpc'];

const liveSettingsIpcs: ReturnType<
  DesktopSettingsIpcModule['createDesktopSettingsIpc']
>[] = [];

function createSettingsFixture(overrides: SettingsFixtureOverrides = {}) {
  const {
    globalState = new FakeStateStore(),
    workspaceState = new FakeStateStore(),
    config = new FakeScopedConfigProvider(),
    ui,
    ...settingsOverrides
  } = overrides;
  const postToRenderer = overrides.postToRenderer ?? (() => undefined);
  const settings = createDesktopSettingsIpc({
    ...settingsOverrides,
    agentSettingsController:
      overrides.agentSettingsController ??
      createStubDesktopAgentSettingsController(),
    credentialSettingsController:
      overrides.credentialSettingsController ??
      createStubDesktopCredentialSettingsController({
        globalState,
        workspaceState,
      }),
    toolingSettingsController:
      overrides.toolingSettingsController ??
      createStubDesktopToolingSettingsController({
        postLatexConfigValues: () =>
          postToRenderer({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
            values: {},
          }),
      }),
    state: { globalState, workspaceState },
    config,
    ui: createStubDesktopSettingsUiHost(ui),
    session: overrides.session ?? defaultSession(),
    postToRenderer,
  });
  // The IPC subscribes to the process-global session and app-signal buses, so
  // a fixture left undisposed would keep reacting to later tests' emits.
  liveSettingsIpcs.push(settings);
  return { globalState, settings, workspaceState };
}

function createCapturedSettingsFixture(
  overrides: CapturedSettingsFixtureOverrides = {},
) {
  const posted: RendererMessage[] = [];
  const fixture = createSettingsFixture({
    ...overrides,
    postToRenderer: (message) => posted.push(message),
  });
  return { ...fixture, posted };
}

function findPosted(
  posted: readonly RendererMessage[],
  command: string,
): RendererMessage | undefined {
  return posted.find((message) => commandOf(message) === command);
}

function createFailureReportingFixture(workspaceState: FakeStateStore) {
  const onError = vi.fn();
  const showErrorMessage = vi.fn(async () => undefined);
  const postLatexConfigValues = vi.fn();
  const { settings } = createCapturedSettingsFixture({
    workspaceState,
    toolingSettingsController: createStubDesktopToolingSettingsController({
      postLatexConfigValues,
    }),
    ui: { onError, showErrorMessage },
  });
  return { settings, onError, showErrorMessage, postLatexConfigValues };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => setImmediate(() => resolve())),
  );
}

describe('desktop settings IPC', () => {
  beforeAll(async () => {
    ({ createDesktopSettingsIpc } = await loadSourceModule(
      '@desktop/main/desktopSettingsIpc',
    ));
  });

  afterEach(() => {
    for (const settings of liveSettingsIpcs.splice(0)) settings.dispose();
    vi.clearAllMocks();
    setGitAuthorEnv({});
    setWorktreeSupportEnabled(false);
  });

  it('applies Git author settings on creation and posts only for settings readiness', async () => {
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.GIT_AUTHOR_NAME]: 'TeXRA Bot',
      [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: 'bot@example.com',
    });

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
    });

    expect(posted).toEqual([]);
    expect(getGitAuthorEnv()).toEqual({
      GIT_AUTHOR_NAME: 'TeXRA Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'TeXRA Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      }),
    ).toBe(false);
    expect(posted).toEqual([]);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    await flushAsyncWork();
    // First post is the derived capability broadcast (commands this host's
    // registry declares `unsupported(...)`); asserted structurally rather
    // than as an exact list so it doesn't need updating every time a
    // command's per-host support decision changes.
    expect(posted[0]).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS,
      commands: expect.arrayContaining([
        SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
      ]),
    });
    expect(
      findPosted(posted, SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS),
    ).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      values: {
        [WorkspaceStateKey.GIT_MARK_COMMITS]: DEFAULT_GIT_MARK_COMMITS,
        [WorkspaceStateKey.GIT_AUTHOR_NAME]: 'TeXRA Bot',
        [WorkspaceStateKey.GIT_AUTHOR_EMAIL]: 'bot@example.com',
        [WorkspaceStateKey.GIT_WORKTREE_SUPPORT]: false,
      },
    });
  }, 15_000);

  it('loads usage only for the subscription command and rejects malformed refresh payloads', async () => {
    const postSubscriptionUsage = vi.fn(async () => undefined);
    const onError = vi.fn();
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(
        {
          globalState: new FakeStateStore(),
          workspaceState: new FakeStateStore(),
        },
        { postSubscriptionUsage },
      );
    const { settings } = createSettingsFixture({
      credentialSettingsController,
      ui: { onError },
    });

    settings.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'settings',
    });
    await flushAsyncWork();
    expect(postSubscriptionUsage).not.toHaveBeenCalled();

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
        forceRefresh: true,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(postSubscriptionUsage).toHaveBeenCalledExactlyOnceWith(true);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
        forceRefresh: 'yes',
      } as never),
    ).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes a close-during-usage-fetch failure without an unhandled rejection', async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    const postSubscriptionUsage = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const onError = vi.fn();
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(
        {
          globalState: new FakeStateStore(),
          workspaceState: new FakeStateStore(),
        },
        { postSubscriptionUsage },
      );
    const { settings } = createSettingsFixture({
      credentialSettingsController,
      ui: { onError },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_SUBSCRIPTION_USAGE,
      }),
    ).toBe(true);
    rejectFetch?.(new Error('renderer closed'));
    await flushAsyncWork();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'renderer closed' }),
    );
  });

  it('delegates agent-selection commands to the required controller', async () => {
    const baseController = createStubDesktopAgentSettingsController();
    const setAgentEnabled = vi.fn(async () => undefined);
    const agentSettingsController = {
      ...baseController,
      handlers: { ...baseController.handlers, setAgentEnabled },
    };
    const { settings } = createSettingsFixture({ agentSettingsController });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
        category: 'workflow',
        agentSource: 'custom',
        agentName: 'proofreader',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(setAgentEnabled).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
      category: 'workflow',
      agentSource: 'custom',
      agentName: 'proofreader',
      enabled: false,
    });
  });

  it('round-trips Git author writes through workspace state and refreshes the renderer', async () => {
    const workspaceState = new FakeStateStore();

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.GIT_AUTHOR_NAME,
        value: 'Desktop TeXRA',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(workspaceState.get(WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(
      'Desktop TeXRA',
    );
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      values: { [WorkspaceStateKey.GIT_AUTHOR_NAME]: 'Desktop TeXRA' },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.GIT_MARK_COMMITS,
        value: false,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(workspaceState.get(WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(false);
    expect(getGitAuthorEnv()).toEqual({});

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
        value: true,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(workspaceState.get(WorkspaceStateKey.GIT_WORKTREE_SUPPORT)).toBe(
      true,
    );
    expect(isWorktreeSupportEnabled()).toBe(true);
  });

  it('round-trips tool path protection through workspace state', async () => {
    const workspaceState = new FakeStateStore();
    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
        value: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(
      workspaceState.get(WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED),
    ).toBe(false);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      values: {
        [WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED]: false,
      },
    });
  });

  it('round-trips multi-agent coordination and refreshes its snapshot', async () => {
    const globalState = new FakeStateStore();
    const { settings, posted } = createCapturedSettingsFixture({
      globalState,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
        value: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(globalState.get(GlobalStateKey.DETACH_SUBAGENTS_ON_STOP)).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED,
      values: { [GlobalStateKey.DETACH_SUBAGENTS_ON_STOP]: true },
    });
  });

  it('serves the goal list instead of the desktop "not available" stub (issue #7751 FS6)', async () => {
    const { settings, posted } = createCapturedSettingsFixture();

    // The desktop serves this command, so it must stay out of the derived
    // capability broadcast (SET_UNSUPPORTED_COMMANDS).
    settings.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'settings',
    });
    await flushAsyncWork();
    const capabilities = posted[0] as { commands?: string[] };
    expect(capabilities.commands).not.toContain(
      SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
    );
    posted.length = 0;

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
      }),
    ).toBe(true);

    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
      items: [],
    });
  });

  describe('goal-list failures', () => {
    setupPlatform();

    const streamId = 'stream:desktop-settings-goal-list' as StreamTabId;
    const goalKey = `goals:byStream:${streamId}`;
    const malformed = { goalId: 'not-valid' };

    async function seedMalformedGoal(): Promise<void> {
      await platform().workspaceState.update('goals:index', [streamId]);
      await platform().workspaceState.update(goalKey, malformed);
    }

    it('reports a malformed goal without throwing or posting a fallback list', async () => {
      await seedMalformedGoal();
      const showErrorMessage = vi.fn(async () => undefined);
      const onError = vi.fn();
      const { settings, posted } = createCapturedSettingsFixture({
        ui: { showErrorMessage, onError },
      });

      expect(
        settings.handleMessage({
          command: SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
        }),
      ).toBe(true);
      await flushAsyncWork();

      expect(onError).toHaveBeenCalledOnce();
      expect(showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to load goals: Failed to parse persisted goal for stream "${streamId}"`,
        ),
      );
      expect(posted).not.toContainEqual(
        expect.objectContaining({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
        }),
      );
      expect(platform().workspaceState.get(goalKey)).toEqual(malformed);
    });

    it('continues initial settings delivery after a malformed goal', async () => {
      await seedMalformedGoal();
      const showErrorMessage = vi.fn(async () => undefined);
      const { settings } = createSettingsFixture({
        ui: { showErrorMessage },
      });

      expect(
        settings.handleMessage({
          command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
          view: 'settings',
        }),
      ).toBe(false);
      await flushAsyncWork();

      expect(showErrorMessage).toHaveBeenCalledOnce();
    });
  });

  describe('goal-state pushes', () => {
    setupPlatform();

    it('reposts the goal list when a run mutates a goal', async () => {
      const streamId = 'stream:desktop-settings-goal-push' as StreamTabId;
      const { posted } = createCapturedSettingsFixture();

      await GoalStore.start(streamId, 'Finish the proof');
      await flushAsyncWork();

      expect(posted.at(-1)).toMatchObject({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
        items: [expect.objectContaining({ objective: 'Finish the proof' })],
      });
    });
  });

  it('routes revealGoalStream to the window-owned progress bridge (issue #7751 FS6)', async () => {
    const revealed: string[] = [];

    const { settings } = createSettingsFixture({
      ui: {
        revealStream: async (streamId) => {
          revealed.push(streamId);
          return 'revealed';
        },
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.REVEAL_GOAL_STREAM,
        streamId: 'goal-owning-stream',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(revealed).toEqual(['goal-owning-stream']);
  });

  it('shows unsupported-command reasons without reporting an error', async () => {
    const showInfoMessage = vi.fn(async () => undefined);
    const onError = vi.fn();
    const { settings } = createSettingsFixture({
      ui: { showInfoMessage, onError },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(showInfoMessage).toHaveBeenCalledWith(
      'Desktop cannot host VS Code extensions.',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a failure to show an unsupported-command reason', async () => {
    const failure = new Error('notification failed');
    const showInfoMessage = vi.fn(() => Promise.reject(failure));
    const onError = vi.fn();
    const { settings } = createSettingsFixture({
      ui: { showInfoMessage, onError },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('delegates Tools and LaTeX commands to the required controller', async () => {
    const baseController = createStubDesktopToolingSettingsController();
    const toggleTool = vi.fn(async () => undefined);
    const runInstallCommand = vi.fn(async () => undefined);
    const postLatexConfigValues = vi.fn();
    const toolingSettingsController =
      createStubDesktopToolingSettingsController({
        toolHandlers: { ...baseController.toolHandlers, toggleTool },
        latexHandlers: {
          ...baseController.latexHandlers,
          runInstallCommand,
        },
        postLatexConfigValues,
      });
    const { settings, workspaceState } = createSettingsFixture({
      toolingSettingsController,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
        toolId: 'zotero',
        enabled: false,
      }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
        installCommand: 'brew install --cask mactex-no-gui',
      }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.LATEX_FORMATTER,
        value: 'none',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(toggleTool).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL,
      toolId: 'zotero',
      enabled: false,
    });
    expect(runInstallCommand).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
      installCommand: 'brew install --cask mactex-no-gui',
    });
    expect(workspaceState.get(WorkspaceStateKey.LATEX_FORMATTER)).toBe('none');
    expect(postLatexConfigValues).toHaveBeenCalledOnce();

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.LATEX_FORMATTER,
        value: null,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(
      workspaceState.get(WorkspaceStateKey.LATEX_FORMATTER),
    ).toBeUndefined();
    expect(postLatexConfigValues).toHaveBeenCalledTimes(2);
  });

  it('delegates profile and ChatGPT commands to the credential controller', async () => {
    const state = {
      globalState: new FakeStateStore(),
      workspaceState: new FakeStateStore(),
    };
    const setProviderKey = vi.fn(async () => undefined);
    const signIn = vi.fn(async () => undefined);
    const signOut = vi.fn(async () => undefined);
    const setPreferSubscription = vi.fn(async () => undefined);
    const stub = createStubDesktopCredentialSettingsController(state);
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(state, {
        profileHandlers: {
          ...stub.profileHandlers,
          signIn,
          signOut,
          setProviderKey,
        },
        chatGptHandlers: {
          ...stub.chatGptHandlers,
          setChatGptPreferSubscription: setPreferSubscription,
        },
      });
    const { settings } = createSettingsFixture({
      ...state,
      credentialSettingsController,
    });

    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_IN }),
    ).toBe(true);
    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_OUT }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
        provider: 'google',
        apiKey: 'sk-test',
      }),
    ).toBe(true);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
        enabled: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(signIn).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
    expect(setProviderKey).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
      provider: 'google',
      apiKey: 'sk-test',
    });
    expect(setPreferSubscription).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
      enabled: true,
    });
  });

  it('persists model settings through global state', async () => {
    const workspaceState = new FakeStateStore();
    const globalState = new FakeStateStore({
      [GlobalStateKey.ENABLED_MODELS]: ['gpt55', 'sonnet46T'],
      [GlobalStateKey.MODEL_LIST_VERSION]: MODEL_LIST_VERSION,
      [GlobalStateKey.HELPER_MODEL]: 'gpt55',
    });

    const errors: unknown[] = [];
    const postMainModelOptionsData = vi.fn(async () => undefined);
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(
        { globalState, workspaceState },
        { postMainModelOptionsData },
      );

    const { settings, posted } = createCapturedSettingsFixture({
      workspaceState,
      globalState,
      credentialSettingsController,
      ui: { onError: (error) => errors.push(error) },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
        modelName: 'gpt55',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(globalState.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'sonnet46T',
    ]);
    expect(globalState.get(GlobalStateKey.HELPER_MODEL)).toBe(
      DEFAULT_HELPER_MODEL,
    );
    expect(errors).toEqual([]);
    expect(
      posted.findLast(
        (message) =>
          commandOf(message) === SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: DEFAULT_HELPER_MODEL,
    });
    expect(postMainModelOptionsData).toHaveBeenCalledOnce();

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
        value: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(globalState.get(GlobalStateKey.PREFER_SHORT_MODEL_NAMES)).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      preferShortModelNames: true,
    });
  });

  it('delegates domain startup and posts approval settings on readiness', async () => {
    const workspaceState = new FakeStateStore({
      [WorkspaceStateKey.CODEX_SANDBOX_MODE]: 'danger-full-access',
    });
    const config = new FakeScopedConfigProvider();
    config.seedWorkspace('texra.toolUse.requireBashApproval', false);
    const agentSettingsController = createStubDesktopAgentSettingsController();
    const postAgentStartupData = vi.fn(async () => undefined);
    agentSettingsController.postStartupData = postAgentStartupData;
    const postToolingStartupData = vi.fn(async () => undefined);
    const postLatexConfigValues = vi.fn();
    const toolingSettingsController =
      createStubDesktopToolingSettingsController({
        postLatexConfigValues,
        postStartupData: postToolingStartupData,
      });
    const { settings, posted } = createCapturedSettingsFixture({
      agentSettingsController,
      toolingSettingsController,
      workspaceState,
      config,
      ui: { onError: () => undefined },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    await flushAsyncWork();

    expect(postLatexConfigValues).toHaveBeenCalledOnce();
    expect(postToolingStartupData).toHaveBeenCalledOnce();
    expect(postAgentStartupData).toHaveBeenCalledOnce();

    expect(
      findPosted(posted, SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      values: {
        [BASH_APPROVAL_CONFIG_KEY]: false,
        [WorkspaceStateKey.CODEX_SANDBOX_MODE]: 'danger-full-access',
      },
    });
    // Without these the Git tab renders a permanently "Not set" token status
    // and an empty subscription list until the user mutates either one.
    expect(
      findPosted(posted, SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS),
    ).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
      status: 'none',
    });
    expect(
      findPosted(posted, SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS),
    ).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: [],
    });
  });

  it('writes the bash-approval toggle to the workspace config scope, not global', async () => {
    const config = new FakeScopedConfigProvider();

    const { settings, posted } = createCapturedSettingsFixture({
      config,
      ui: { onError: () => undefined },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: BASH_APPROVAL_CONFIG_KEY,
        value: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(config.get('texra.toolUse.requireBashApproval')).toBe(false);
    // Security-adjacent scope pin: a per-workspace approval bypass must never
    // be written to the global config target (see issue #7085).
    expect(config.lastTargetFor('texra.toolUse.requireBashApproval')).toBe(
      'workspace',
    );
    expect(
      findPosted(posted, SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      values: { [BASH_APPROVAL_CONFIG_KEY]: false },
    });
  });

  it('reports failed setting writes and restores the authoritative snapshot', async () => {
    const workspaceState = new FakeStateStore();
    const failure = new Error('workspace write failed');
    vi.spyOn(workspaceState, 'update').mockRejectedValueOnce(failure);
    const { settings, onError, showErrorMessage, postLatexConfigValues } =
      createFailureReportingFixture(workspaceState);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.LATEX_FORMATTER,
        value: 'none',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(showErrorMessage).toHaveBeenCalledWith(
      `Failed to update "${WorkspaceStateKey.LATEX_FORMATTER}": workspace write failed`,
    );
    expect(postLatexConfigValues).toHaveBeenCalledOnce();
  });

  it('reports rejected setting values and restores the authoritative snapshot', async () => {
    const workspaceState = new FakeStateStore();
    const update = vi.spyOn(workspaceState, 'update');
    const { settings, onError, showErrorMessage, postLatexConfigValues } =
      createFailureReportingFixture(workspaceState);

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS,
        value: 1000.5,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(update).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        `Invalid value for "${WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS}":`,
      ),
    );
    expect(postLatexConfigValues).toHaveBeenCalledOnce();
  });

  it('writes the agent-skills toggle and returns the shared setting message', async () => {
    const config = new FakeScopedConfigProvider();

    const { settings, posted } = createCapturedSettingsFixture({
      config,
      ui: { onError: () => undefined },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
        key: AGENT_SKILLS_CONFIG_KEY,
        value: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(config.get(AGENT_SKILLS_CONFIG_KEY)).toBe(false);
    expect(config.lastTargetFor(AGENT_SKILLS_CONFIG_KEY)).toBe('workspace');
    expect(
      findPosted(posted, SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS),
    ).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS,
      values: { [AGENT_SKILLS_CONFIG_KEY]: false },
    });
  });

  it('refreshes credentials before conditionally refreshing the agent catalog', async () => {
    const state = {
      globalState: new FakeStateStore(),
      workspaceState: new FakeStateStore(),
    };
    const events: string[] = [];
    const refreshAuthDependentData = vi.fn(async () => {
      events.push('credentials');
    });
    const credentialSettingsController =
      createStubDesktopCredentialSettingsController(state, {
        refreshAuthDependentData,
      });
    const agentSettingsController = createStubDesktopAgentSettingsController();
    agentSettingsController.refreshCatalogData = vi.fn(async () => {
      events.push('agents');
    });
    const { settings } = createSettingsFixture({
      ...state,
      agentSettingsController,
      credentialSettingsController,
    });

    await settings.refreshAuthDependentData();

    expect(events).toEqual(['credentials', 'agents']);

    events.length = 0;
    await settings.refreshAuthDependentData({
      deferAgentCatalogRefresh: true,
    });

    expect(events).toEqual(['credentials']);
    expect(refreshAuthDependentData).toHaveBeenCalledTimes(2);
    expect(refreshAuthDependentData).toHaveBeenLastCalledWith();
    expect(agentSettingsController.refreshCatalogData).toHaveBeenCalledOnce();
  });

  it('handles desktop memory toggle messages', async () => {
    const globalState = new FakeStateStore();

    const { settings, posted } = createCapturedSettingsFixture({
      globalState,
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED,
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(globalState.get(GlobalStateKey.MEMORY_ENABLED)).toBe(false);
    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled: false,
    });
  });

  it('requires UI confirmation before deleting memory', async () => {
    const confirmAction = vi.fn(async () => false);
    const { settings, posted } = createCapturedSettingsFixture({
      ui: { confirmAction },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_MEMORY,
        storagePath: 'memory/example.md',
        displayPath: 'example.md',
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(confirmAction).toHaveBeenCalledWith(
      'Delete "example.md"?',
      'Delete',
    );
    expect(posted).toEqual([]);
  });

  it('ignores unsupported or malformed settings messages', async () => {
    const { settings, posted } = createCapturedSettingsFixture();

    expect(settings.handleMessage({ command: 'unknown' })).toBe(false);
    // Missing the required `key` — the inbound schema rejects it, so the
    // dispatcher never claims the message.
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_STATE_SETTING,
      }),
    ).toBe(false);
    expect(posted).toEqual([]);
  });
});
